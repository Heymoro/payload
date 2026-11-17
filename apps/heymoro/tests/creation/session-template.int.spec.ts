import type { Payload, PayloadRequest } from 'payload'

import { expect, vi } from 'vitest'

import type { CreationCoordinator } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createPayloadCatalog } from '../../src/creation/infrastructure/payload/catalog-repository.js'
import {
  createCreationRuntime,
  createPayloadSessionCreator,
} from '../../src/creation/infrastructure/payload/session-repository.js'
import {
  createSQLiteUnitOfWork,
  getCreationSQLiteAdapter,
} from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { cleanupSQLiteFixture, gate } from './sqlite.config.js'
import { corruptCurrentTemplate } from './template-corruption-fixture.js'

const hostCaps = {
  allowedMimeTypes: ['image/jpeg', 'image/png'],
  maxDescriptionLength: 200,
  maxImageBytes: 1000,
  maxImages: 4,
  maxNotesLength: 100,
  maxTotalImageBytes: 3000,
  minImages: 0,
}
const display = {
  name: '  Published portrait  ',
  coverMediaId: 21,
  description: 'Display only, never draft input',
  examples: [{ inputMediaIds: [31, 30], outputMediaId: 32 }],
  photoHint: 'Display only',
}
const audit = {
  createdBy: 'system:session-template-fixture',
  deletedAt: null,
  deletedBy: null,
  isDeleted: false,
  updatedBy: 'system:session-template-fixture',
}
// Deliberately SQLite-only; the Redis suite separately verifies the real coordinator.
const coordinate: CreationCoordinator = async ({ work }) => work({ assertLease: () => {} })

function creator({
  caps = hostCaps,
  compatible = true,
  coordination = coordinate,
  payload,
}: {
  caps?: typeof hostCaps
  compatible?: boolean
  coordination?: CreationCoordinator
  payload: Payload
}) {
  return createPayloadSessionCreator({
    clock: () => new Date().toISOString(),
    coordinate: coordination,
    gate,
    hostCaps: caps,
    isCompatible: () => compatible,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  })
}
function trusted<T>({
  payload,
  work,
}: {
  payload: Payload
  work: (args: { req: PayloadRequest }) => Promise<T>
}) {
  return createSQLiteUnitOfWork({
    coordinate,
    gate,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  })({ resource: 'session-template-fixture', work })
}
async function seed({ mode = 'effect', payload }: { mode?: 'effect' | 'free'; payload: Payload }) {
  const user = await payload.create({
    collection: 'users',
    data: { status: 'active' } as never,
    overrideAccess: true,
  })
  const runtime = createCreationRuntime({ gate, payload })
  return trusted({
    payload,
    work: async ({ req }) => {
      const template = await runtime.create({
        collection: 'creation-templates',
        data: {
          ...audit,
          name: 'Mutable stable name',
          code: mode,
          costCredits: 3,
          displayConfigJson: JSON.stringify(
            mode === 'effect'
              ? display
              : { name: 'Published free', coverMediaId: null, examples: [] },
          ),
          inputSchemaJson: JSON.stringify(
            mode === 'effect'
              ? { ...hostCaps, maxDescriptionLength: 0, minImages: 1 }
              : { ...hostCaps, maxNotesLength: 0 },
          ),
          kind: mode,
          minClientCapability: '1',
          schemaVersion: 1,
          sortOrder: 0,
          status: 'published',
          // Public/session readers do not parse or expose private execution configuration.
          generationConfigJson: '{}',
          shareConfigJson: '{}',
        },
        req,
      })
      return {
        command: {
          clientRequestId: 'public-config',
          templateId: Number(template.id),
        },
        userId: Number(user.id),
      }
    },
  })
}
async function changeTemplate({
  data,
  payload,
  templateId,
}: {
  data: Record<string, unknown>
  payload: Payload
  templateId: number
}) {
  const { status, ...corruption } = data
  if (status !== undefined) {
    await trusted({
      payload,
      work: ({ req }) =>
        createCreationRuntime({ gate, payload }).update({
          id: templateId,
          collection: 'creation-templates',
          data: { status },
          req,
        }),
    })
  }
  if (Object.keys(corruption).length) {
    await corruptCurrentTemplate({ data: corruption, payload, templateId })
  }
}
async function rowCount({
  payload,
  table,
}: {
  payload: Payload
  table: 'creation_drafts' | 'creation_sessions' | 'draft_inputs'
}) {
  return Number(
    (
      await getCreationSQLiteAdapter({ payload }).client.execute(
        `SELECT count(*) AS count FROM ${table}`,
      )
    ).rows[0]!.count,
  )
}
async function expectZeroWrites({
  payload,
  run,
}: {
  payload: Payload
  run: () => Promise<unknown>
}) {
  const create = vi.spyOn(payload, 'create')
  await expect(run()).rejects.toMatchObject({
    name: 'SessionError',
    code: 'TEMPLATE_UNAVAILABLE',
    status: 409,
  })
  expect(create).not.toHaveBeenCalled()
  expect(await rowCount({ payload, table: 'creation_sessions' })).toBe(0)
  expect(await rowCount({ payload, table: 'creation_drafts' })).toBe(0)
}

test.suite(
  'Heymoro T0 published public configuration',
  { config: './sqlite.config.ts', cron: false },
  () => {
    test.afterAll(() => cleanupSQLiteFixture())
    test.afterEach(() => vi.restoreAllMocks())

    for (const mode of ['effect', 'free'] as const) {
      test(`should create an empty ${mode} draft using the same published name as the catalog without execution configuration`, async ({
        payload,
      }) => {
        const fixture = await seed({ mode, payload })
        const catalog = createPayloadCatalog({
          capabilityPolicy: {
            id: 'fixture-v1',
            isCompatible: ({ schemaVersion }) => schemaVersion === 1,
          },
          cursorKey: Buffer.alloc(32, 7),
          hostCaps,
          payload,
        })
        const published =
          mode === 'effect'
            ? await catalog.get({ templateId: fixture.command.templateId })
            : await catalog.getFreePreset()
        // Even an invalid mutable name must have no influence on T0 or public catalog.
        await trusted({
          payload,
          work: ({ req }) =>
            createCreationRuntime({ gate, payload }).update({
              id: fixture.command.templateId,
              collection: 'creation-templates',
              data: { name: '\u2028' },
              req,
            }),
        })
        const result = await creator({ payload })({
          command: fixture.command,
          userId: fixture.userId,
        })
        expect(result.session.title).toBe(published.displayConfig.name)
        expect(result.session.title).toBe(
          mode === 'effect' ? 'Published portrait' : 'Published free',
        )
        const drafts = await trusted({
          payload,
          work: ({ req }) =>
            createCreationRuntime({ gate, payload }).find({
              collection: 'creation-drafts',
              limit: 2,
              req,
            }),
        })
        expect(drafts.docs).toHaveLength(1)
        expect(drafts.docs[0]).toMatchObject({
          description: '',
          sessionId: result.session.id,
          userNotes: '',
        })
        expect(await rowCount({ payload, table: 'draft_inputs' })).toBe(0)
      })
    }

    const invalid = [
      { data: { displayConfigJson: '{' }, label: 'broken display JSON' },
      { data: { displayConfigJson: 'null' }, label: 'absent display object' },
      {
        data: {
          displayConfigJson: JSON.stringify({ coverMediaId: 21, examples: display.examples }),
        },
        label: 'missing display name',
      },
      { data: { inputSchemaJson: '{' }, label: 'broken input JSON' },
      { data: { inputSchemaJson: '{}' }, label: 'missing input fields' },
      { data: { schemaVersion: 2 }, label: 'unsupported schema' },
      ...['', 'x'.repeat(101), 'bad\u0000name', 'bad\nname', 'bad\u2028name', 'bad\u2029name'].map(
        (name, index) => ({
          data: { displayConfigJson: JSON.stringify({ ...display, name }) },
          label: `invalid display name ${index}`,
        }),
      ),
    ]
    for (const { data, label } of invalid) {
      test(`should reject ${label} before session or draft insert`, async ({ payload }) => {
        const fixture = await seed({ payload })
        await changeTemplate({ data, payload, templateId: fixture.command.templateId })
        await expectZeroWrites({ payload, run: () => creator({ payload })(fixture) })
      })
    }

    test('should reject a host capability policy mismatch before insert', async ({ payload }) => {
      const fixture = await seed({ payload })
      await expectZeroWrites({
        payload,
        run: () => creator({ compatible: false, payload })(fixture),
      })
    })

    test('should snapshot caller caps and reject empty MIME intersection despite later caller mutation', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const caps = { ...hostCaps, allowedMimeTypes: ['image/webp'] }
      const create = creator({ caps, payload })
      caps.allowedMimeTypes.push('image/jpeg')
      caps.maxImages = 100
      await expectZeroWrites({ payload, run: () => create(fixture) })
      expect(Object.isFrozen(caps.allowedMimeTypes)).toBe(false)
    })

    test('should reject an impossible image-count intersection before insert', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      await expectZeroWrites({
        payload,
        run: () => creator({ caps: { ...hostCaps, maxImages: 0 }, payload })(fixture),
      })
    })

    test('should replay without rereading damaged offline configuration or changing title and draft', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const first = await creator({ payload })(fixture)
      await changeTemplate({
        data: { displayConfigJson: '{', inputSchemaJson: '{', status: 'offline' },
        payload,
        templateId: fixture.command.templateId,
      })
      await trusted({
        payload,
        work: ({ req }) =>
          createCreationRuntime({ gate, payload }).update({
            id: fixture.command.templateId,
            collection: 'creation-templates',
            data: { status: 'offline' },
            req,
          }),
      })
      const find = vi.spyOn(payload, 'find')
      const create = vi.spyOn(payload, 'create')
      const replay = await creator({
        caps: { ...hostCaps, allowedMimeTypes: ['image/webp'] },
        compatible: false,
        payload,
      })(fixture)
      expect(replay).toEqual({ isNew: false, session: first.session })
      expect(find.mock.calls.map(([args]) => args.collection)).toEqual([
        'users',
        'creation-sessions',
      ])
      expect(create).not.toHaveBeenCalled()
      expect(await rowCount({ payload, table: 'creation_drafts' })).toBe(1)
    })

    for (const missing of ['status', 'isDeleted'] as const) {
      test(`should reject missing target users ${missing} schema before DB or coordination I/O`, ({
        payload,
      }) => {
        const config = payload.collections.users!.config
        const original = config.flattenedFields
        const coordinationCalls = vi.fn()
        const coordination: CreationCoordinator = (args) => {
          coordinationCalls()
          return coordinate(args)
        }
        const transaction = vi.spyOn(getCreationSQLiteAdapter({ payload }).client, 'transaction')
        const find = vi.spyOn(payload, 'find')
        const create = vi.spyOn(payload, 'create')
        try {
          config.flattenedFields = original.filter((field) => field.name !== missing)
          expect(() => creator({ coordination, payload })).toThrow(
            /users status and an isDeleted checkbox.*target schema/,
          )
          expect(coordinationCalls).not.toHaveBeenCalled()
          expect(transaction).not.toHaveBeenCalled()
          expect(find).not.toHaveBeenCalled()
          expect(create).not.toHaveBeenCalled()
        } finally {
          config.flattenedFields = original
        }
      })
    }

    test('should reject a soft-deleted active user before template lookup', async ({ payload }) => {
      const fixture = await seed({ payload })
      await payload.update({
        id: fixture.userId,
        collection: 'users',
        data: { isDeleted: true } as never,
        overrideAccess: true,
      })
      const find = vi.spyOn(payload, 'find')
      const create = vi.spyOn(payload, 'create')
      await expect(creator({ payload })(fixture)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
      expect(find.mock.calls.map(([args]) => args.collection)).toEqual(['users'])
      expect(create).not.toHaveBeenCalled()
    })

    test('should select only T0 current public configuration and stable identity fields on actual Payload reads', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const find = vi.spyOn(payload, 'find')
      await creator({ payload })(fixture)
      const templates = find.mock.calls.filter(([args]) =>
        ['creation-templates'].includes(args.collection),
      )
      expect(templates).toHaveLength(1)
      expect(templates[0]![0].select).toEqual({
        id: true,
        displayConfigJson: true,
        inputSchemaJson: true,
        isDeleted: true,
        kind: true,
        minClientCapability: true,
        schemaVersion: true,
        status: true,
      })
      for (const [args] of templates) {
        expect(args.showHiddenFields).not.toBe(true)
        expect(args.select).not.toHaveProperty('generationConfigJson')
        expect(args.select).not.toHaveProperty('shareConfigJson')
        expect(args.select).not.toHaveProperty('name')
      }
    })
  },
)
