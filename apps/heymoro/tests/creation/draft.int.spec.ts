import type { Payload, PayloadRequest } from 'payload'

import { createClient } from '@libsql/client'
import { createPayloadRequest } from 'payload'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createPayloadDraftService } from '../../src/creation/infrastructure/payload/draft-repository.js'
import { createSQLiteReadSnapshot } from '../../src/creation/infrastructure/payload/read-snapshot.js'
import { createCreationRuntime } from '../../src/creation/infrastructure/payload/session-repository.js'
import {
  createSQLiteUnitOfWork,
  getCreationSQLiteAdapter,
} from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createRedisCreationCoordinator } from '../../src/creation/infrastructure/redis/coordinator.js'
import { startRedisFixture } from './redis-fixture.js'
import { cleanupSQLiteFixture, gate, sqliteURL } from './sqlite.config.js'
import { corruptCurrentTemplate } from './template-corruption-fixture.js'

test.suite(
  'Heymoro owned media and whole draft',
  { config: './sqlite.config.ts', cron: false },
  () => {
    test.afterAll(() => cleanupSQLiteFixture())

    test.afterEach(() => vi.restoreAllMocks())

    test('fails fast for a target users schema missing soft deletion without database access', ({
      payload,
    }) => {
      const users = payload.collections.users!
      const legacyTarget = Object.create(payload) as Payload
      Object.defineProperty(legacyTarget, 'collections', {
        value: {
          ...payload.collections,
          users: {
            ...users,
            config: {
              ...users.config,
              flattenedFields: users.config.flattenedFields.filter(
                (field) => field.name !== 'isDeleted',
              ),
            },
          },
        },
      })
      const client = getCreationSQLiteAdapter({ payload }).client
      const find = vi.spyOn(payload, 'find')
      const execute = vi.spyOn(client, 'execute')
      const transaction = vi.spyOn(client, 'transaction')
      expect(() => draftService({ payload: legacyTarget })).toThrow(
        /users.*isDeleted checkbox.*schema/,
      )
      expect(find).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
      expect(transaction).not.toHaveBeenCalled()
    })

    test('saves ordered whole input and reuses positions across reorder, clear and restore', async ({
      payload,
    }) => {
      const fixture = await seedDraft({ payload })
      const service = draftService({ payload })
      const input = {
        description: '',
        inputMediaIds: fixture.mediaIds,
        userNotes: '  literal\nnotes  ',
      }
      const saved = await service.save({
        input,
        sessionId: fixture.sessionId,
        userId: fixture.userId,
      })
      expect(saved).toEqual({ input, updatedAt: expect.any(String) })
      expect(await service.get(fixture)).toEqual(saved)
      expect(JSON.stringify(saved)).not.toMatch(/storage|system:|createdBy|generationConfig|prompt/)
      const client = getCreationSQLiteAdapter({ payload }).client
      const slots = (await client.execute('SELECT * FROM draft_inputs ORDER BY position')).rows
      expect(slots).toHaveLength(2)
      await service.save({
        ...fixture,
        input: { ...input, inputMediaIds: [...fixture.mediaIds].reverse() },
      })
      expect((await client.execute('SELECT id FROM draft_inputs ORDER BY position')).rows).toEqual(
        slots.map(({ id }) => ({ id })),
      )
      expect((await service.get(fixture)).input.inputMediaIds).toEqual(
        [...fixture.mediaIds].reverse(),
      )
      await service.save({ ...fixture, input: {} })
      expect(
        (await client.execute('SELECT is_deleted FROM draft_inputs')).rows.every(
          (row) => row.is_deleted === 1,
        ),
      ).toBe(true)
      await service.save({ ...fixture, input })
      expect((await client.execute('SELECT id FROM draft_inputs ORDER BY position')).rows).toEqual(
        slots.map(({ id }) => ({ id })),
      )
      expect(
        (await client.execute('SELECT deleted_at, deleted_by FROM draft_inputs')).rows,
      ).toEqual([
        { deleted_at: null, deleted_by: null },
        { deleted_at: null, deleted_by: null },
      ])
    })

    test('allows incomplete free input, enforces mode fields, and never rewrites whitespace', async ({
      payload,
    }) => {
      const fixture = await seedDraft({ mode: 'free', payload })
      const service = draftService({ payload })
      expect((await service.get(fixture)).input).toEqual({
        description: '',
        inputMediaIds: [],
        userNotes: '',
      })
      await service.save({ ...fixture, input: {} })
      await service.save({ ...fixture, input: { description: '  literal\ntext  ' } })
      expect((await service.get(fixture)).input.description).toBe('  literal\ntext  ')
      for (const input of [
        { userNotes: 'not free' },
        { description: null },
        { unexpected: 1 },
        { inputMediaIds: ['1'] },
        { inputMediaIds: [1, 1] },
        { description: 'a'.repeat(201) },
      ]) {
        await expect(service.save({ ...fixture, input })).rejects.toMatchObject({
          code: 'INPUT_INVALID',
        })
      }
      const effect = await seedDraft({ payload })
      await expect(
        service.save({ ...effect, input: { description: 'not effect' } }),
      ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
    })

    for (const [label, mutation] of Object.entries({
      artifact: { purpose: 'artifact' },
      avatar: { purpose: 'avatar' },
      example: { purpose: 'example' },
      'fractional bytes': { filesize: 1.5 },
      'other owner': { owner: 99999 },
      oversized: { filesize: 1001 },
      'pending delete': { lifecycle: 'pendingDelete' },
      'physically deleted': { lifecycle: 'physicalDeleted' },
      public: { visibility: 'official_public' },
      'soft deleted': {
        deletedAt: '2026-11-12T00:00:00.000Z',
        deletedBy: 'system:test',
        isDeleted: true,
      },
      'unsafe bytes': { filesize: 1e20 },
      'upload incomplete': { lifecycle: 'uploading' },
      'wrong MIME': { mimeType: 'application/pdf' },
      'zero bytes': { filesize: 0 },
    })) {
      test(`rejects ${label} media without partial input writes`, async ({ payload }) => {
        // Invalid reference eligibility is seeded at creation; content identity is immutable thereafter.
        const fixture = await seedDraft({ mediaOverrides: mutation, payload })
        await expect(
          draftService({ payload }).save({
            ...fixture,
            input: { inputMediaIds: fixture.mediaIds, userNotes: 'must rollback' },
          }),
        ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
        expect((await draftService({ payload }).get(fixture)).input).toEqual({
          description: '',
          inputMediaIds: [],
          userNotes: '',
        })
      })
    }

    test('checks total bytes, host intersections, missing media and maximum image count', async ({
      payload,
    }) => {
      const fixture = await seedDraft({ mediaOverrides: { filesize: 900 }, payload })
      await expect(
        draftService({ payload }).save({ ...fixture, input: { inputMediaIds: fixture.mediaIds } }),
      ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
      for (const [hostCaps, input] of [
        [{ ...caps, maxImages: 1 }, { inputMediaIds: fixture.mediaIds }],
        [{ ...caps, allowedMimeTypes: ['image/jpeg'] }, { inputMediaIds: [fixture.mediaIds[0]] }],
        [caps, { inputMediaIds: [999999] }],
        [{ ...caps, maxNotesLength: 1 }, { userNotes: 'long' }],
      ] as const) {
        await expect(
          draftService({
            hostCaps: { ...hostCaps, allowedMimeTypes: [...hostCaps.allowedMimeTypes] },
            payload,
          }).save({ ...fixture, input }),
        ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
      }
    })

    test('rechecks account and owner on both paths, hiding foreign deleted or missing sessions', async ({
      payload,
    }) => {
      const fixture = await seedDraft({ payload })
      const other = await payload.create({
        collection: 'users',
        data: { status: 'active' } as never,
        overrideAccess: true,
      })
      const service = draftService({ payload })
      for (const method of [
        service.get,
        (args: { sessionId: number; userId: number }) => service.save({ ...args, input: {} }),
      ]) {
        await expect(method({ ...fixture, userId: 0 })).rejects.toMatchObject({
          code: 'UNAUTHENTICATED',
          status: 401,
        })
        await expect(method({ ...fixture, userId: Number(other.id) })).rejects.toMatchObject({
          code: 'NOT_FOUND',
          status: 404,
        })
        await expect(method({ ...fixture, sessionId: 999999 })).rejects.toMatchObject({
          code: 'NOT_FOUND',
          status: 404,
        })
      }
      await updateFixture({
        id: fixture.sessionId,
        collection: 'creation-sessions',
        data: { deletedAt: '2026-11-12T00:00:00.000Z', deletedBy: 'system:test', isDeleted: true },
        payload,
      })
      await expect(service.get(fixture)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(service.save({ ...fixture, input: {} })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      await payload.update({
        id: fixture.userId,
        collection: 'users',
        data: { status: 'disabled' } as never,
        overrideAccess: true,
      })
      await expect(service.get(fixture)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
        status: 401,
      })
      await expect(service.save({ ...fixture, input: {} })).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
        status: 401,
      })
      await payload.update({
        id: fixture.userId,
        collection: 'users',
        data: { isDeleted: true, status: 'active' } as never,
        overrideAccess: true,
      })
      await expect(service.get(fixture)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
        status: 401,
      })
      await expect(service.save({ ...fixture, input: {} })).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
        status: 401,
      })
    })

    test('saves owned input under host limits despite offline or damaged current template configuration', async ({
      payload,
    }) => {
      const fixture = await seedDraft({ payload })
      await updateFixture({
        id: fixture.templateId,
        collection: 'creation-templates',
        data: { status: 'offline' },
        payload,
      })
      const service = draftService({ payload })
      const input = { description: '', inputMediaIds: fixture.mediaIds, userNotes: 'kept' }
      await service.save({ ...fixture, input })
      await corruptCurrentTemplate({
        data: { inputSchemaJson: '{broken' },
        payload,
        templateId: fixture.templateId,
      })
      expect((await service.save({ ...fixture, input })).input).toEqual(input)
      await corruptCurrentTemplate({
        data: { deletedAt: '2026-11-12T00:00:00.000Z', deletedBy: 'system:test', isDeleted: true },
        payload,
        templateId: fixture.templateId,
      })
      expect((await service.save({ ...fixture, input })).input).toEqual(input)
      expect((await service.get(fixture)).input).toEqual(input)
    })

    test('restores existing input despite later media invalidation and tighter host caps, with no write lease or capability', async ({
      payload,
    }) => {
      const fixture = await seedDraft({ payload })
      const saved = await draftService({ payload }).save({
        ...fixture,
        input: { inputMediaIds: fixture.mediaIds, userNotes: 'preserve long text' },
      })
      await updateFixture({
        id: fixture.mediaIds[0]!,
        collection: 'media',
        data: { lifecycle: 'pendingDelete' },
        payload,
      })
      const coordinate = vi.fn(async () => {
        throw new Error('Read must not ask Redis.')
      })
      const bind = vi.fn(gate.bind)
      const readGate = { ...gate, bind }
      const originalFind = payload.find.bind(payload)
      const findSpy = vi.spyOn(payload, 'find').mockImplementation(async (args) => {
        expect(args.req?.transactionID).toBeDefined()
        expect(() => gate.assert({ req: args.req! as PayloadRequest })).toThrow(/capability/)
        expect(args.select).toBeDefined()
        expect(args.select).not.toHaveProperty('generationConfigJson')
        return originalFind(args)
      })
      expect(
        await draftService({
          coordinate,
          gate: readGate,
          hostCaps: { ...caps, maxImages: 0, maxNotesLength: 0 },
          payload,
        }).get(fixture),
      ).toEqual(saved)
      expect(coordinate).not.toHaveBeenCalled()
      expect(bind).not.toHaveBeenCalled()
      expect(findSpy).toHaveBeenCalledTimes(4)
      expect(getCreationSQLiteAdapter({ payload }).sessions).toEqual({})
    })

    for (const corruption of [
      'duplicate draft',
      'duplicate position',
      'duplicate active media',
      'foreign slot',
      'foreign draft',
      'invalid template identity',
      'invalid session mode',
    ]) {
      test(`reports ${corruption} as 503 without changing input`, async ({ payload }) => {
        const fixture = await seedDraft({ payload })
        await draftService({ payload }).save({
          ...fixture,
          input: { inputMediaIds: fixture.mediaIds },
        })
        const client = getCreationSQLiteAdapter({ payload }).client
        if (corruption === 'duplicate draft') {
          await write({
            payload,
            work: ({ req, runtime }) =>
              runtime.create({
                collection: 'creation-drafts',
                data: {
                  ...audit,
                  description: '',
                  sessionId: fixture.sessionId,
                  userId: fixture.userId,
                  userNotes: '',
                },
                req,
              }),
          })
        } else if (corruption === 'duplicate position') {
          await write({
            payload,
            work: ({ req, runtime }) =>
              runtime.create({
                collection: 'draft-inputs',
                data: {
                  ...audit,
                  deletedAt: '2026-11-12T00:00:00.000Z',
                  deletedBy: 'system:test',
                  draftId: fixture.draftId,
                  isDeleted: true,
                  mediaId: fixture.mediaIds[0],
                  position: 1,
                  userId: fixture.userId,
                },
                req,
              }),
          })
        } else if (corruption === 'duplicate active media') {
          await client.execute(
            'UPDATE draft_inputs SET media_id = (SELECT media_id FROM draft_inputs WHERE position = 1) WHERE position = 2',
          )
        } else if (corruption === 'foreign slot') {
          await client.execute('UPDATE draft_inputs SET user_id = 99999 WHERE position = 1')
        } else if (corruption === 'foreign draft') {
          await client.execute('UPDATE creation_drafts SET user_id = 99999')
        } else if (corruption === 'invalid template identity') {
          await client.execute('UPDATE creation_sessions SET template_id = 0')
        } else {
          await client.execute("UPDATE creation_sessions SET mode = 'invalid'")
        }
        const service = draftService({ payload })
        await expect(service.save({ ...fixture, input: {} })).rejects.toMatchObject({
          code: 'DATA_INTEGRITY_CONFLICT',
          status: 503,
        })
        await expect(service.get(fixture)).rejects.toMatchObject({
          code: 'DATA_INTEGRITY_CONFLICT',
          status: 503,
        })
      })
    }

    test('rolls back text, slot and session on a real partial SQL update failure', async ({
      payload,
    }) => {
      const fixture = await seedDraft({ payload })
      const service = draftService({ payload })
      const saved = await service.save({
        ...fixture,
        input: { inputMediaIds: fixture.mediaIds, userNotes: 'before' },
      })
      const client = getCreationSQLiteAdapter({ payload }).client
      const before = (await client.execute('SELECT * FROM creation_sessions')).rows
      await client.execute(
        "CREATE TRIGGER fixture_fail_slot BEFORE UPDATE ON draft_inputs WHEN NEW.position = 2 BEGIN SELECT RAISE(ABORT, 'fixture second slot'); END",
      )
      try {
        await expect(
          service.save({
            ...fixture,
            input: { inputMediaIds: [...fixture.mediaIds].reverse(), userNotes: 'after' },
          }),
        ).rejects.toThrow()
        expect(await service.get(fixture)).toEqual(saved)
        expect((await client.execute('SELECT * FROM creation_sessions')).rows).toEqual(before)
        expect(getCreationSQLiteAdapter({ payload }).sessions).toEqual({})
      } finally {
        await client.execute('DROP TRIGGER fixture_fail_slot')
      }
    })

    test('rolls back a real draft save after its Redis holder is replaced mid-write', async ({
      payload,
    }) => {
      const fixture = await seedDraft({ payload })
      const redis = await startRedisFixture()
      try {
        const coordinator = createRedisCreationCoordinator({
          client: redis.client,
          config: {
            acquireTimeoutMs: 200,
            commandTimeoutMs: 200,
            leaseMs: 800,
            maxHoldMs: 5000,
            namespace: 'draft-lease',
            renewEveryMs: 100,
            retryDelayMs: 10,
          },
        })
        const coordinate = coordinator.coordinate
        const originalUpdate = payload.update.bind(payload)
        const update = vi.spyOn(payload, 'update').mockImplementation(async (args) => {
          const result = await originalUpdate(args)
          if (String(args.collection) === 'creation-drafts') {
            const [key] = await redis.client.keys('draft-lease:*')
            expect(key).toBeDefined()
            await redis.client.set(key!, 'replacement-owner', 'PX', 3000)
            await new Promise((resolve) => setTimeout(resolve, 150))
          }
          return result
        })
        await expect(
          draftService({ coordinate, payload }).save({
            ...fixture,
            input: { inputMediaIds: fixture.mediaIds, userNotes: 'must rollback' },
          }),
        ).rejects.toMatchObject({ code: 'COORDINATION_UNAVAILABLE' })
        update.mockRestore()
        expect((await draftService({ payload }).get(fixture)).input).toEqual({
          description: '',
          inputMediaIds: [],
          userNotes: '',
        })
      } finally {
        await redis.stop()
      }
    })

    test('reads one consistent deferred snapshot while another owned connection changes draft and slots', async ({
      payload,
    }) => {
      const fixture = await seedDraft({ payload })
      const saved = await draftService({ payload }).save({
        ...fixture,
        input: { inputMediaIds: fixture.mediaIds, userNotes: 'before' },
      })
      const other = createClient({ url: sqliteURL })
      try {
        const originalFind = payload.find.bind(payload)
        let hasChanged = false
        const spy = vi.spyOn(payload, 'find').mockImplementation(async (args) => {
          const result = await originalFind(args)
          if (!hasChanged) {
            hasChanged = true
            await other.batch(
              [
                "UPDATE creation_drafts SET user_notes = 'after'",
                'UPDATE draft_inputs SET is_deleted = 1',
              ],
              'write',
            )
          }
          return result
        })
        expect(await draftService({ payload }).get(fixture)).toEqual(saved)
        spy.mockRestore()
        expect((await draftService({ payload }).get(fixture)).input).toEqual({
          description: '',
          inputMediaIds: [],
          userNotes: 'after',
        })
      } finally {
        other.close()
      }
    })

    test('permanently aborts read after framework rollback and never falls back outside the owned transaction', async ({
      payload,
    }) => {
      await seedDraft({ payload })
      const originalFind = payload.find.bind(payload)
      let capturedReq: PayloadRequest | undefined
      const spy = vi.spyOn(payload, 'find').mockImplementation(async (args) => {
        capturedReq = args.req as PayloadRequest
        const result = await originalFind(args)
        await payload.db.rollbackTransaction(capturedReq.transactionID!)
        return result
      })
      const findArgs = { collection: 'users', limit: 2, select: { id: true } }
      await expect(
        createSQLiteReadSnapshot({ payload })({
          work: async ({ find }) => {
            await expect(find(findArgs)).rejects.toThrow(/aborted/)
            await expect(find(findArgs)).rejects.toThrow(/aborted/)
            return null
          },
        }),
      ).rejects.toThrow(/aborted/)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(capturedReq?.transactionID).toBeUndefined()
      expect(getCreationSQLiteAdapter({ payload }).sessions).toEqual({})
    })

    test('extends the one native media collection with ordinary indexes, numeric owner and private native access', async ({
      payload,
    }) => {
      const matches = payload.config.collections.filter(({ slug }) => slug === 'media')
      expect(matches).toHaveLength(1)
      const collection = matches[0]!
      const filename = collection.flattenedFields.find(({ name }) => name === 'filename')!
      expect(filename).toMatchObject({ index: true, unique: false })
      const req = await createPayloadRequest({ payload })
      for (const operation of ['read', 'create', 'update', 'delete'] as const) {
        expect(await collection.access[operation]({ slug: 'media', req })).toBe(false)
      }
      await expect(
        payload.create({ collection: 'media', data: {} as never, overrideAccess: true }),
      ).rejects.toThrow(/capability/)
      const client = getCreationSQLiteAdapter({ payload }).client
      for (const table of ['media', 'draft_inputs']) {
        expect((await client.execute(`PRAGMA table_info('${table}')`)).rows.length).toBeGreaterThan(
          0,
        )
        expect((await client.execute(`PRAGMA foreign_key_list('${table}')`)).rows).toHaveLength(0)
        expect(
          (await client.execute(`PRAGMA index_list('${table}')`)).rows.every(
            (row) => Number(row.unique) === 0,
          ),
        ).toBe(true)
      }
      const columns = (await client.execute("PRAGMA table_info('media')")).rows.map(
        ({ name }) => name,
      )
      expect(columns).toEqual(
        expect.arrayContaining([
          'owner',
          'original_name',
          'storage_name',
          'mime_type',
          'filesize',
          'filename',
          'width',
          'height',
          'storage_backend',
          'storage_bucket',
          'sha256',
          'visibility',
          'purpose',
          'created_by',
          'updated_by',
          'is_deleted',
        ]),
      )
      expect(columns).not.toEqual(expect.arrayContaining(['user_id', 'byte_size', 'storage_key']))
    })
  },
)

const caps = {
  allowedMimeTypes: ['image/png', 'image/jpeg'],
  maxDescriptionLength: 200,
  maxImageBytes: 1000,
  maxImages: 4,
  maxNotesLength: 100,
  maxTotalImageBytes: 1500,
  minImages: 0,
}
const audit = {
  createdBy: 'system:draft-fixture',
  deletedAt: null,
  deletedBy: null,
  isDeleted: false,
  updatedBy: 'system:draft-fixture',
}
function draftService({
  payload,
  ...options
}: { payload: Payload } & Partial<Parameters<typeof createPayloadDraftService>[0]>) {
  return createPayloadDraftService({
    clock: () => new Date().toISOString(),
    coordinate: async ({ work }) => work({ assertLease: () => {} }),
    gate,
    hostCaps: caps,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
    ...options,
  })
}
function write<T>({
  payload,
  work,
}: {
  payload: Payload
  work: (args: {
    req: PayloadRequest
    runtime: ReturnType<typeof createCreationRuntime>
  }) => Promise<T>
}) {
  const runtime = createCreationRuntime({ gate, payload })
  return createSQLiteUnitOfWork({
    coordinate: async ({ work }) => work({ assertLease: () => {} }),
    gate,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  })({ resource: 'draft-fixture', work: ({ req }) => work({ req, runtime }) })
}
async function seedDraft({
  mediaOverrides = {},
  mode = 'effect',
  payload,
}: {
  mediaOverrides?: Record<string, unknown>
  mode?: 'effect' | 'free'
  payload: Payload
}) {
  const user = await payload.create({
    collection: 'users',
    data: { status: 'active' } as never,
    overrideAccess: true,
  })
  const userId = Number(user.id)
  return write({
    payload,
    work: async ({ req, runtime }) => {
      const template = await runtime.create({
        collection: 'creation-templates',
        data: {
          ...audit,
          name: 'Fixture',
          code: 'fixture',
          costCredits: 2,
          displayConfigJson: JSON.stringify({
            name: 'Fixture',
            coverMediaId: 1,
            examples: [{ inputMediaIds: [], outputMediaId: 1 }],
          }),
          generationConfigJson: '{"prompt":"secret"}',
          inputSchemaJson: JSON.stringify({
            ...caps,
            ...(mode === 'effect'
              ? { maxDescriptionLength: 0, minImages: 1 }
              : { maxNotesLength: 0 }),
          }),
          kind: mode,
          minClientCapability: 'v1',
          schemaVersion: 1,
          shareConfigJson: '{}',
          status: 'published',
        },
        req,
      })
      const session = await runtime.create({
        collection: 'creation-sessions',
        data: {
          ...audit,
          clientRequestId: 'fixture',
          lastActivityAt: new Date().toISOString(),
          mode,
          requestHash: 'f'.repeat(64),
          templateId: template.id,
          title: 'Fixture',
          titleSource: 'template',
          userId,
        },
        req,
      })
      const draft = await runtime.create({
        collection: 'creation-drafts',
        data: { ...audit, description: '', sessionId: session.id, userId, userNotes: '' },
        req,
      })
      const mediaIds: number[] = []
      for (let index = 0; index < 2; index++) {
        const media = await runtime.create({
          collection: 'media',
          data: {
            ...audit,
            alt: 'Fixture',
            filename: `fixture-${index}.png`,
            filesize: 500,
            mimeType: 'image/png',
            originalName: `photo-${index}.png`,
            owner: userId,
            purpose: 'reference',
            sha256: 'a'.repeat(64),
            storageBackend: 'fixture-metadata',
            storageBucket: 'owned-fixture',
            storageName: `fixture-${index}.png`,
            visibility: 'private',
            ...mediaOverrides,
          },
          req,
        })
        mediaIds.push(Number(media.id))
      }
      return {
        draftId: Number(draft.id),
        mediaIds,
        sessionId: Number(session.id),
        templateId: Number(template.id),
        userId,
      }
    },
  })
}

function updateFixture({
  id,
  collection,
  data,
  payload,
}: {
  collection: Parameters<ReturnType<typeof createCreationRuntime>['update']>[0]['collection']
  data: Record<string, unknown>
  id: number
  payload: Payload
}) {
  return write({
    payload,
    work: ({ req, runtime }) =>
      runtime.update({ id, collection, data: { updatedBy: 'system:draft-fixture', ...data }, req }),
  })
}
