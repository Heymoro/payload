import type { Payload } from 'payload'

import { setTimeout as delay } from 'node:timers/promises'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { compileCurrentTemplate } from '../../src/creation/domain/current-template.js'
import { createPayloadCurrentTemplates } from '../../src/creation/infrastructure/payload/current-template-repository.js'
import {
  createSQLiteUnitOfWork,
  getCreationSQLiteAdapter,
} from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createRedisCreationCoordinator } from '../../src/creation/infrastructure/redis/coordinator.js'
import { cleanupCurrentTemplates, gate, redis } from './current-template.config.js'

const now = '2026-11-16T17:00:00.000Z'
const hostCaps = {
  allowedMimeTypes: ['image/png'],
  maxDescriptionLength: 100,
  maxImageBytes: 1000,
  maxImages: 6,
  maxNotesLength: 100,
  maxTotalImageBytes: 5000,
  minImages: 0,
}
const execution = {
  registry: {
    image: {
      allowedParameters: ['size'],
      model: 'gpt-image-1.5',
      parameterRules: {
        size: { type: 'string' as const, isRequired: true, values: ['1024x1024'] },
      },
      provider: 'openai',
      storageBackends: ['fixture'],
    },
  },
  storageOutput: {
    backend: 'fixture',
    bucket: 'results',
    keyRule: 'task-attempt-result-v1' as const,
  },
}
const body = {
  costCredits: 1,
  displayConfigJson: JSON.stringify({ name: 'Free' }),
  generationConfigJson: JSON.stringify({
    executorId: 'image',
    parameters: { size: '1024x1024' },
    systemPrompt: 'Draw the requested image.',
  }),
  inputSchemaJson: JSON.stringify({ ...hostCaps, maxNotesLength: 0 }),
  minClientCapability: 'v1',
  schemaVersion: 1,
  shareConfigJson: '{}',
}

async function fixture({ payload }: { payload: Payload }) {
  const admin = await payload.create({
    collection: 'admins',
    data: { role: 'admin', status: 'active' },
    overrideAccess: true,
  })
  if (typeof admin.id !== 'number' || !Number.isSafeInteger(admin.id)) {
    throw new Error('Fixture requires native integer administrator IDs.')
  }
  const namespace = `current-templates-${admin.id}`
  const coordinator = createRedisCreationCoordinator({
    client: redis.client,
    config: {
      acquireTimeoutMs: 5000,
      commandTimeoutMs: 500,
      leaseMs: 3000,
      maxHoldMs: 15000,
      namespace,
      renewEveryMs: 500,
      retryDelayMs: 5,
    },
  })
  const options = {
    acceptedCapabilities: ['v1'],
    clock: () => now,
    coordinate: coordinator.coordinate,
    execution,
    gate,
    hostCaps,
    maxExampleMedia: 50,
    payload,
    retry: { backoffMs: 1, maxAttempts: 3 },
  }
  return {
    adminId: admin.id,
    client: getCreationSQLiteAdapter({ payload }).client,
    namespace,
    options,
    service: createPayloadCurrentTemplates(options),
  }
}

async function seedOfficialMedia({
  options,
  payload,
}: {
  options: Awaited<ReturnType<typeof fixture>>['options']
  payload: Payload
}) {
  const write = createSQLiteUnitOfWork(options)
  return write({
    resource: 'current-template-test-media',
    work: ({ req }) =>
      gate.run({
        req,
        work: () =>
          payload.create({
            collection: 'media',
            data: {
              alt: 'Official fixture',
              createdAt: now,
              createdBy: 'system:current-template-test',
              filesize: 100,
              height: 2,
              isDeleted: false,
              lifecycle: 'active',
              mimeType: 'image/png',
              originalName: 'fixture.png',
              owner: null,
              purpose: 'example',
              sha256: 'a'.repeat(64),
              storageBackend: 'fixture',
              storageBucket: 'examples',
              storageName: 'example.png',
              updatedAt: now,
              updatedBy: 'system:current-template-test',
              visibility: 'official_public',
              width: 2,
            } as never,
            overrideAccess: true,
            req,
          }),
      }),
  })
}

test.suite(
  'Single current template CRUD',
  { config: './current-template.config.ts', cron: false },
  () => {
    test.afterAll(cleanupCurrentTemplates)
    test.afterEach(() => vi.restoreAllMocks())

    test('registers one mutable configuration with ordinary indexes and standard audit fields only', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      expect(payload.collections['template-versions']).toBeUndefined()
      const columns = (await f.client.execute('PRAGMA table_info(creation_templates)')).rows.map(
        (row) => row.name,
      )
      for (const name of [
        'created_at',
        'created_by',
        'updated_at',
        'updated_by',
        'is_deleted',
        'deleted_at',
        'deleted_by',
      ]) {
        expect(columns).toContain(name)
      }
      for (const name of ['version', 'revision', 'version_no', 'published_version_id']) {
        expect(columns).not.toContain(name)
      }
      expect(
        (await f.client.execute('PRAGMA foreign_key_list(creation_templates)')).rows,
      ).toHaveLength(0)
      expect(
        (await f.client.execute('PRAGMA index_list(creation_templates)')).rows.every(
          (row) => row.unique === 0,
        ),
      ).toBe(true)
    })

    test('creates, saves, publishes and edits the same row with immediate live configuration and audit', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const created = await f.service.create({
        adminId: f.adminId,
        code: 'free',
        configuration: body,
        kind: 'free',
      })
      expect(created.status).toBe('offline')
      await f.service.setStatus({ adminId: f.adminId, status: 'published', templateId: created.id })
      const edited = {
        ...body,
        costCredits: 3,
        generationConfigJson: JSON.stringify({
          executorId: 'image',
          parameters: { size: '1024x1024' },
          systemPrompt: 'New prompt.',
        }),
      }
      const saved = await f.service.save({
        adminId: f.adminId,
        configuration: edited,
        templateId: created.id,
      })
      expect(saved).toMatchObject({ id: created.id, costCredits: 3, status: 'published' })
      expect(await f.service.get({ adminId: f.adminId, templateId: created.id })).toEqual(saved)
      expect((await f.client.execute('SELECT * FROM creation_templates')).rows).toHaveLength(1)
      expect((await f.client.execute('SELECT * FROM audit_logs')).rows).toHaveLength(3)
      const old = compileCurrentTemplate({
        acceptedCapabilities: ['v1'],
        execution,
        hostCaps,
        template: created,
      })
      const current = compileCurrentTemplate({
        acceptedCapabilities: ['v1'],
        execution,
        hostCaps,
        template: saved,
      })
      expect(old.executionPlan.systemPrompt).toBe('Draw the requested image.')
      expect(current.executionPlan.systemPrompt).toBe('New prompt.')
      expect(current.configurationHash).not.toBe(old.configurationHash)
      await f.service.setStatus({ adminId: f.adminId, status: 'offline', templateId: saved.id })
      expect(
        (await f.service.list({ adminId: f.adminId, input: { status: 'published' } })).items,
      ).toEqual([])
    })

    test('rolls back invalid configuration and missing example references without partial records or audits', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const created = await f.service.create({
        adminId: f.adminId,
        code: 'free',
        configuration: body,
        kind: 'free',
      })
      await f.service.setStatus({ adminId: f.adminId, status: 'published', templateId: created.id })
      const before = (await f.client.execute('SELECT * FROM audit_logs')).rows
      await expect(
        f.service.save({
          adminId: f.adminId,
          configuration: { ...body, generationConfigJson: '{}' },
          templateId: created.id,
        }),
      ).rejects.toBeDefined()
      await expect(
        f.service.save({
          adminId: f.adminId,
          configuration: {
            ...body,
            displayConfigJson: JSON.stringify({ name: 'Free', coverMediaId: 999 }),
          },
          templateId: created.id,
        }),
      ).rejects.toBeDefined()
      expect(
        (await f.service.get({ adminId: f.adminId, templateId: created.id })).generationConfigJson,
      ).toBe(body.generationConfigJson)
      expect((await f.client.execute('SELECT * FROM audit_logs')).rows).toEqual(before)
      expect((await f.client.execute('SELECT * FROM creation_templates')).rows).toHaveLength(1)
    })

    test('checks duplicate codes in the coordinated service, without a SQL unique constraint', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          f.service.create({ adminId: f.adminId, code: 'free', configuration: body, kind: 'free' }),
        ),
      )
      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
      expect((await f.client.execute('SELECT * FROM creation_templates')).rows).toHaveLength(1)
      expect((await f.client.execute('SELECT * FROM audit_logs')).rows).toHaveLength(1)
    })

    test('rechecks administrator state on every operation and denies raw collection writes', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const created = await f.service.create({
        adminId: f.adminId,
        code: 'free',
        configuration: body,
        kind: 'free',
      })
      await payload.update({
        id: f.adminId,
        collection: 'admins',
        data: { status: 'disabled' },
        overrideAccess: true,
      })
      for (const operation of [
        () => f.service.get({ adminId: f.adminId, templateId: created.id }),
        () => f.service.save({ adminId: f.adminId, configuration: body, templateId: created.id }),
        () =>
          f.service.setStatus({ adminId: f.adminId, status: 'published', templateId: created.id }),
        () => f.service.list({ adminId: f.adminId }),
        () => f.service.getOptions({ adminId: f.adminId }),
        () =>
          f.service.create({ adminId: f.adminId, code: 'free', configuration: body, kind: 'free' }),
      ]) {
        await expect(operation()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
      }
      await expect(
        payload.update({
          id: created.id,
          collection: 'creation-templates' as never,
          data: { costCredits: 99 } as never,
          overrideAccess: true,
        }),
      ).rejects.toBeDefined()
      expect(
        (await f.client.execute('SELECT cost_credits FROM creation_templates')).rows[0]!
          .cost_credits,
      ).toBe(1)
    })

    test('persists an effect using registered official media and validates taxonomy references', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const media = await seedOfficialMedia({ options: f.options, payload })
      const configuration = {
        ...body,
        displayConfigJson: JSON.stringify({
          name: 'Card',
          coverMediaId: media.id,
          examples: [{ inputMediaIds: [media.id], outputMediaId: media.id }],
        }),
        inputSchemaJson: JSON.stringify({ ...hostCaps, maxDescriptionLength: 0, minImages: 1 }),
      }
      const created = await f.service.create({
        adminId: f.adminId,
        code: 'card',
        configuration,
        kind: 'effect',
      })
      expect(created.kind).toBe('effect')
      await f.service.setStatus({ adminId: f.adminId, status: 'published', templateId: created.id })
      await expect(
        f.service.save({
          adminId: f.adminId,
          configuration: {
            ...configuration,
            displayConfigJson: JSON.stringify({
              ...JSON.parse(configuration.displayConfigJson),
              categoryId: 999,
              categoryName: 'Missing',
            }),
          },
          templateId: created.id,
        }),
      ).rejects.toBeDefined()
      expect((await f.client.execute('SELECT * FROM creation_templates')).rows).toHaveLength(1)
    })
    test('paginates current rows and keeps private configuration out of list summaries', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const media = await seedOfficialMedia({ options: f.options, payload })
      for (let index = 0; index < 22; index++) {
        const suffix = String(index).padStart(2, '0')
        await f.service.create({
          adminId: f.adminId,
          code: `card-${suffix}`,
          configuration: {
            ...body,
            displayConfigJson: JSON.stringify({
              name: `Card ${suffix}`,
              coverMediaId: media.id,
              examples: [{ outputMediaId: media.id }],
            }),
            inputSchemaJson: JSON.stringify({ ...hostCaps, maxDescriptionLength: 0, minImages: 1 }),
          },
          kind: 'effect',
        })
      }
      const first = await f.service.list({ adminId: f.adminId })
      expect(first.items).toHaveLength(20)
      expect(first.hasMore).toBe(true)
      const second = await f.service.list({
        adminId: f.adminId,
        input: { afterId: first.nextAfterId! },
      })
      expect(second.items).toHaveLength(2)
      expect(second.hasMore).toBe(false)
      expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(22)
      expect(
        (await f.service.list({ adminId: f.adminId, input: { keyword: 'Card 2' } })).items,
      ).toHaveLength(2)
      expect(JSON.stringify(first)).not.toMatch(
        /systemPrompt|generationConfigJson|configurationHash|versionNo/,
      )
    })

    test('an audit failure rolls back the same-row save and does not change published state', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const created = await f.service.create({
        adminId: f.adminId,
        code: 'free',
        configuration: body,
        kind: 'free',
      })
      const original = await f.service.setStatus({
        adminId: f.adminId,
        status: 'published',
        templateId: created.id,
      })
      const snapshot = async () =>
        Promise.all(
          ['creation_templates', 'audit_logs'].map(
            async (table) => (await f.client.execute(`SELECT * FROM ${table} ORDER BY id`)).rows,
          ),
        )
      const before = await snapshot()
      for (const target of ['UPDATE ON creation_templates', 'INSERT ON audit_logs']) {
        await f.client.execute(
          `CREATE TRIGGER current_template_failure BEFORE ${target} BEGIN SELECT RAISE(ABORT, 'current template fixture failure'); END`,
        )
        try {
          await expect(
            f.service.save({
              adminId: f.adminId,
              configuration: { ...body, costCredits: 9 },
              templateId: original.id,
            }),
          ).rejects.toBeDefined()
        } finally {
          await f.client.execute('DROP TRIGGER current_template_failure')
        }
        expect(await snapshot()).toEqual(before)
        expect(await f.service.get({ adminId: f.adminId, templateId: original.id })).toEqual(
          original,
        )
      }
    })

    test('authorizes active operators and rejects viewer unknown or missing administrators before template queries', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      await payload.update({
        id: f.adminId,
        collection: 'admins',
        data: { role: 'operator' },
        overrideAccess: true,
      })
      const created = await f.service.create({
        adminId: f.adminId,
        code: 'free',
        configuration: body,
        kind: 'free',
      })
      expect((await f.service.getOptions({ adminId: f.adminId })).hostCaps).toBeDefined()
      const before = (await f.client.execute('SELECT * FROM audit_logs')).rows
      for (const role of ['viewer', 'unknown', 'missing']) {
        let adminId = f.adminId
        if (role === 'missing') {
          adminId = 99999
        } else {
          await payload.update({
            id: f.adminId,
            collection: 'admins',
            data: { role },
            overrideAccess: true,
          })
        }
        const find = vi.spyOn(payload, 'find')
        try {
          for (const operation of [
            () => f.service.get({ adminId, templateId: created.id }),
            () => f.service.list({ adminId }),
            () => f.service.getOptions({ adminId }),
            () => f.service.save({ adminId, configuration: body, templateId: created.id }),
            () => f.service.setStatus({ adminId, status: 'published', templateId: created.id }),
            () => f.service.create({ adminId, code: 'free', configuration: body, kind: 'free' }),
          ]) {
            await expect(operation()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
          }
          expect(find.mock.calls.every(([args]) => args.collection === 'admins')).toBe(true)
        } finally {
          find.mockRestore()
        }
        expect((await f.client.execute('SELECT * FROM audit_logs')).rows).toEqual(before)
      }
    })

    test('rejects invalid official cover facts and session-share references without changing the template or audit', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const media = await seedOfficialMedia({ options: f.options, payload })
      const effect = {
        ...body,
        displayConfigJson: JSON.stringify({
          name: 'Card',
          coverMediaId: media.id,
          examples: [{ inputMediaIds: [media.id], outputMediaId: media.id }],
        }),
        inputSchemaJson: JSON.stringify({ ...hostCaps, maxDescriptionLength: 0, minImages: 1 }),
      }
      const created = await f.service.create({
        adminId: f.adminId,
        code: 'card',
        configuration: effect,
        kind: 'effect',
      })
      const before = await Promise.all(
        ['creation_templates', 'audit_logs'].map(
          async (table) => (await f.client.execute(`SELECT * FROM ${table}`)).rows,
        ),
      )
      for (const [assignment, values] of [
        ['owner = ?', [999]],
        ['visibility = ?', ['private']],
        ['purpose = ?', ['reference']],
        ['is_deleted = 1, deleted_at = ?, deleted_by = ?', [now, 'system:current-template-test']],
        ['lifecycle = ?', ['pendingDelete']],
      ] as const) {
        const invalidMedia = await seedOfficialMedia({ options: f.options, payload })
        await f.client.execute({
          args: [...values, Number(invalidMedia.id)],
          sql: `UPDATE media SET ${assignment} WHERE id = ?`,
        })
        await expect(
          f.service.save({
            adminId: f.adminId,
            configuration: {
              ...effect,
              displayConfigJson: JSON.stringify({
                name: 'Card',
                coverMediaId: invalidMedia.id,
                showcaseShareKeys: [],
              }),
            },
            templateId: created.id,
          }),
        ).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' })
      }
      for (const key of ['a'.repeat(32), 'b'.repeat(32)]) {
        await expect(
          f.service.save({
            adminId: f.adminId,
            configuration: {
              ...effect,
              displayConfigJson: JSON.stringify({ name: 'Card', showcaseShareKeys: [key] }),
            },
            templateId: created.id,
          }),
        ).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' })
      }
      expect(
        await Promise.all(
          ['creation_templates', 'audit_logs'].map(
            async (table) => (await f.client.execute(`SELECT * FROM ${table}`)).rows,
          ),
        ),
      ).toEqual(before)
    })

    test('rejects unregistered executors invalid parameters and malformed share configuration atomically', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const created = await f.service.create({
        adminId: f.adminId,
        code: 'free',
        configuration: body,
        kind: 'free',
      })
      const original = JSON.parse(body.generationConfigJson)
      const before = await Promise.all(
        ['creation_templates', 'audit_logs'].map(
          async (table) => (await f.client.execute(`SELECT * FROM ${table}`)).rows,
        ),
      )
      for (const changed of [
        { generationConfigJson: JSON.stringify({ ...original, executorId: 'missing' }) },
        { generationConfigJson: JSON.stringify({ ...original, parameters: { size: 'invalid' } }) },
        {
          generationConfigJson: JSON.stringify({
            ...original,
            parameters: { size: '1024x1024', unknown: true },
          }),
        },
        { shareConfigJson: '{broken' },
        { shareConfigJson: '{"unknown":true}' },
      ]) {
        await expect(
          f.service.save({
            adminId: f.adminId,
            configuration: { ...body, ...changed },
            templateId: created.id,
          }),
        ).rejects.toBeDefined()
      }
      expect(
        await Promise.all(
          ['creation_templates', 'audit_logs'].map(
            async (table) => (await f.client.execute(`SELECT * FROM ${table}`)).rows,
          ),
        ),
      ).toEqual(before)
    })

    test('keeps a deleted logical code occupied and rejects duplicate stored candidates rather than choosing one', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      await f.service.create({
        adminId: f.adminId,
        code: 'free',
        configuration: body,
        kind: 'free',
      })
      await f.client.execute({
        args: [now, 'system:current-template-test'],
        sql: 'UPDATE creation_templates SET is_deleted=1, deleted_at=?, deleted_by=?',
      })
      const before = (await f.client.execute('SELECT * FROM audit_logs')).rows
      await expect(
        f.service.create({ adminId: f.adminId, code: 'free', configuration: body, kind: 'free' }),
      ).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT', status: 409 })
      const columns = (await f.client.execute('PRAGMA table_info(creation_templates)')).rows
        .map((row) => String(row.name))
        .filter((name) => name !== 'id')
      const quoted = columns.map((name) => `"${name}"`).join(',')
      await f.client.execute(
        `INSERT INTO creation_templates (${quoted}) SELECT ${quoted} FROM creation_templates`,
      )
      await expect(
        f.service.create({ adminId: f.adminId, code: 'free', configuration: body, kind: 'free' }),
      ).rejects.toMatchObject({ code: 'DATA_INTEGRITY_CONFLICT', status: 503 })
      expect((await f.client.execute('SELECT * FROM creation_templates')).rows).toHaveLength(2)
      expect((await f.client.execute('SELECT * FROM audit_logs')).rows).toEqual(before)
    })

    test('preserves all four JSON strings exactly and keeps private configuration out of options and list summaries', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const raw = {
        ...body,
        displayConfigJson: ' { "name" : "Free" }\n',
        generationConfigJson: JSON.stringify(JSON.parse(body.generationConfigJson), null, 2) + '\n',
        inputSchemaJson: JSON.stringify(JSON.parse(body.inputSchemaJson), null, 2) + '\n',
        shareConfigJson: '{\n }\n',
      }
      const created = await f.service.create({
        adminId: f.adminId,
        code: 'free',
        configuration: raw,
        kind: 'free',
      })
      await f.service.save({
        adminId: f.adminId,
        configuration: { ...raw, costCredits: 2 },
        templateId: created.id,
      })
      const saved = await f.service.get({ adminId: f.adminId, templateId: created.id })
      for (const key of [
        'displayConfigJson',
        'inputSchemaJson',
        'generationConfigJson',
        'shareConfigJson',
      ] as const) {
        expect(saved[key]).toBe(raw[key])
      }
      expect(JSON.stringify(await f.service.getOptions({ adminId: f.adminId }))).not.toMatch(
        /Draw the requested image|apiKey|credentials|storageOutput|bucket/,
      )
      const list = await f.service.list({ adminId: f.adminId })
      expect(Object.keys(list.items[0]!).sort()).toEqual(
        ['id', 'code', 'kind', 'name', 'status', 'costCredits'].sort(),
      )
    })

    test('rolls back a same-row save after losing the real Redis holder without deleting its replacement', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const created = await f.service.create({
        adminId: f.adminId,
        code: 'free',
        configuration: body,
        kind: 'free',
      })
      const before = await Promise.all(
        ['creation_templates', 'audit_logs'].map(
          async (table) => (await f.client.execute(`SELECT * FROM ${table}`)).rows,
        ),
      )
      const update = payload.update.bind(payload)
      let replaced: string | undefined
      vi.spyOn(payload, 'update').mockImplementation(async (args) => {
        const result = await update(args)
        if (!replaced && String(args.collection) === 'creation-templates') {
          const keys = await redis.client.keys(`${f.namespace}:*`)
          expect(keys).toHaveLength(1)
          replaced = keys[0]!
          await redis.client.set(replaced, 'replacement-fixture-holder', 'PX', 3000)
          await delay(650)
        }
        return result
      })
      try {
        await expect(
          f.service.save({
            adminId: f.adminId,
            configuration: { ...body, costCredits: 9 },
            templateId: created.id,
          }),
        ).rejects.toBeDefined()
        expect(replaced).toBeDefined()
        expect(
          await Promise.all(
            ['creation_templates', 'audit_logs'].map(
              async (table) => (await f.client.execute(`SELECT * FROM ${table}`)).rows,
            ),
          ),
        ).toEqual(before)
        expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
        expect(await redis.client.get(replaced!)).toBe('replacement-fixture-holder')
      } finally {
        if (replaced && (await redis.client.get(replaced)) === 'replacement-fixture-holder') {
          await redis.client.del(replaced)
        }
      }
    })

    test('rejects row-version fields and accessor inputs before any repository operation', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const find = vi.spyOn(payload, 'find')
      let reads = 0
      const accessor = { ...body }
      Object.defineProperty(accessor, 'costCredits', {
        enumerable: true,
        get: () => {
          reads++
          return 1
        },
      })
      for (const configuration of [{ ...body, versionNo: 1 }, accessor]) {
        await expect(
          f.service.create({ adminId: f.adminId, code: 'free', configuration, kind: 'free' }),
        ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
      }
      expect(reads).toBe(0)
      expect(find).not.toHaveBeenCalled()
      expect((await f.client.execute('SELECT * FROM creation_templates')).rows).toHaveLength(0)
    })
  },
)
