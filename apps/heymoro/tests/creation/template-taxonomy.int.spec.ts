import type { Payload } from 'payload'

import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createPayloadCurrentTemplates } from '../../src/creation/infrastructure/payload/current-template-repository.js'
import { createPayloadSessionCreator } from '../../src/creation/infrastructure/payload/session-repository.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createPayloadTemplateTaxonomy } from '../../src/creation/infrastructure/payload/template-taxonomy-repository.js'
import { createRedisCreationCoordinator } from '../../src/creation/infrastructure/redis/coordinator.js'
import { audit, caps, execution, NOW, update, write } from './generation-fixture.js'
import { close } from './generation-worker-fixture.js'
import { startRedisFixture } from './redis-fixture.js'
import { cleanupSQLiteFixture, directory, gate } from './sqlite.config.js'

async function fixture({ payload }: { payload: Payload }) {
  const redis = await startRedisFixture()
  close.push(redis.stop)
  const coordinator = createRedisCreationCoordinator({
    client: redis.client,
    config: {
      acquireTimeoutMs: 5000,
      commandTimeoutMs: 500,
      leaseMs: 3000,
      maxHoldMs: 15000,
      namespace: 'taxonomy',
      renewEveryMs: 500,
      retryDelayMs: 5,
    },
  })
  const admin = await payload.create({
    collection: 'admins',
    data: { role: 'operator', status: 'active' } as never,
    overrideAccess: true,
  })
  const options = {
    clock: () => NOW,
    coordinate: coordinator.coordinate,
    gate,
    payload,
    retry: { backoffMs: 1, maxAttempts: 3 },
  }
  return {
    adapter: getCreationSQLiteAdapter({ payload }),
    adminId: Number(admin.id),
    options,
    redis,
    service: createPayloadTemplateTaxonomy(options),
  }
}
const input = (changes = {}) => ({
  name: ' Portrait😀 ',
  code: 'portrait',
  kind: 'category',
  ...changes,
})

test.suite(
  'Heymoro template taxonomy trusted CRUD',
  { config: './sqlite.config.ts', cron: false },
  () => {
    test.afterEach(async () => {
      vi.restoreAllMocks()
      for (const work of close.splice(0).reverse()) {
        await work()
      }
    })
    test.afterAll(() => cleanupSQLiteFixture())

    test('should create update hide and read actual taxonomy with ordinary indexes and atomic audits', async ({
      payload,
    }) => {
      process.stdout.write(`T38 B1 taxonomy SQLite fixture: ${directory}\n`)
      const f = await fixture({ payload })
      const created = await f.service.createTerm({
        adminId: f.adminId,
        input: input({ sortOrder: -5 }),
      })
      expect(created).toMatchObject({ ...input({ sortOrder: -5 }), status: 'active' })
      const inserted = await f.adapter.client.execute('SELECT * FROM taxonomy_terms ORDER BY id')
      expect(inserted.rows).toHaveLength(1)
      expect(inserted.rows[0]).toMatchObject({
        created_by: `admin:${f.adminId}`,
        deleted_at: null,
        deleted_by: null,
        is_deleted: 0,
        updated_by: `admin:${f.adminId}`,
      })
      const beforeAudit = await f.adapter.client.execute('SELECT * FROM audit_logs ORDER BY id')
      expect(beforeAudit.rows).toHaveLength(1)
      expect(beforeAudit.rows[0]).toMatchObject({
        action: 'taxonomy.create',
        actor_id: String(f.adminId),
        actor_type: 'admin',
        resource_id: String(created.id),
        resource_type: 'taxonomy-term',
        result: 'success',
      })
      expect(JSON.parse(beforeAudit.rows[0]!.after_state as string)).toEqual(created)
      expect(beforeAudit.rows[0]!.request_id).toBe(beforeAudit.rows[0]!.correlation_id)
      await f.service.updateTerm({
        adminId: f.adminId,
        input: { id: created.id, name: created.name, sortOrder: -5, status: 'active' },
      })
      expect(
        (await f.adapter.client.execute('SELECT * FROM taxonomy_terms ORDER BY id')).rows,
      ).toEqual(inserted.rows)
      expect((await f.adapter.client.execute('SELECT * FROM audit_logs ORDER BY id')).rows).toEqual(
        beforeAudit.rows,
      )
      const changed = await f.service.updateTerm({
        adminId: f.adminId,
        input: { id: created.id, name: 'Renamed😀', sortOrder: 10, status: 'hidden' },
      })
      expect(changed).toEqual({ ...created, name: 'Renamed😀', sortOrder: 10, status: 'hidden' })
      expect(
        (
          await f.service.listTerms({
            adminId: f.adminId,
            input: { keyword: 'renamed', kind: 'category', status: 'hidden' },
          })
        ).items,
      ).toEqual([changed])
      expect(
        (await f.service.listTerms({ adminId: f.adminId, input: { status: 'active' } })).items,
      ).toEqual([])
      expect(
        (await f.adapter.client.execute('SELECT * FROM taxonomy_terms')).rows[0],
      ).toMatchObject({
        code: created.code,
        created_at: inserted.rows[0]!.created_at,
        created_by: inserted.rows[0]!.created_by,
        deleted_at: null,
        deleted_by: null,
        is_deleted: 0,
        kind: created.kind,
      })
      const audits = await f.adapter.client.execute('SELECT * FROM audit_logs ORDER BY id')
      expect(audits.rows).toHaveLength(2)
      expect(JSON.parse(audits.rows[1]!.before_state as string)).toEqual(created)
      expect(JSON.parse(audits.rows[1]!.after_state as string)).toEqual(changed)
      expect(JSON.stringify(audits.rows)).not.toMatch(/PRIVATE|prompt|credential|bucket/i)
      const indexes = await f.adapter.client.execute("PRAGMA index_list('taxonomy_terms')")
      expect(indexes.rows.length).toBeGreaterThan(0)
      expect(indexes.rows.every((row) => Number(row.unique) === 0)).toBe(true)
      expect(Object.keys(f.adapter.sessions)).toEqual([])
      expect(await f.redis.client.keys('*')).toEqual([])
    })

    test('should use real bounded filters and twenty plus one ascending ID pagination excluding tombstones', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const created = []
      for (let n = 0; n < 23; n++) {
        created.push(
          await f.service.createTerm({
            adminId: f.adminId,
            input: input({ name: `Match ${n}`, code: `page-${n}` }),
          }),
        )
      }
      await f.service.createTerm({
        adminId: f.adminId,
        input: input({ name: 'Different', code: 'other', kind: 'label' }),
      })
      await update({
        id: created[22]!.id,
        collection: 'taxonomy-terms',
        data: { deletedAt: NOW, deletedBy: 'system:fixture', isDeleted: true },
        payload,
      })
      const find = vi.spyOn(payload, 'find')
      const first = await f.service.listTerms({
        adminId: f.adminId,
        input: { keyword: 'Match', kind: 'category', status: 'active' },
      })
      expect(first.items.map((row) => row.id)).toEqual(created.slice(0, 20).map((row) => row.id))
      expect(first.nextAfterId).toBe(created[19]!.id)
      const second = await f.service.listTerms({
        adminId: f.adminId,
        input: { afterId: first.nextAfterId, keyword: 'Match', kind: 'category', status: 'active' },
      })
      expect(second.items).toEqual(created.slice(20, 22))
      expect(second.nextAfterId).toBeNull()
      // Native contains uses SQLite LIKE: % and _ retain their existing wildcard semantics.
      // This is an ASCII-case observation, not a Unicode case-folding guarantee.
      for (const keyword of ['%', '_', 'mAtCh']) {
        const wildcard = await f.service.listTerms({
          adminId: f.adminId,
          input: { keyword, kind: 'category', status: 'active' },
        })
        expect(wildcard.items.map((row) => row.id)).toEqual(
          created.slice(0, 20).map((row) => row.id),
        )
        expect(wildcard.nextAfterId).toBe(created[19]!.id)
        const tail = await f.service.listTerms({
          adminId: f.adminId,
          input: { afterId: wildcard.nextAfterId, keyword, kind: 'category', status: 'active' },
        })
        expect(tail.items).toEqual(created.slice(20, 22))
        expect(tail.nextAfterId).toBeNull()
      }
      expect(
        find.mock.calls
          .filter(([args]) => String(args.collection) === 'taxonomy-terms')
          .every(([args]) => args.limit === 21 && args.sort === 'id' && !!args.select),
      ).toBe(true)
      expect(Object.keys(f.adapter.sessions)).toEqual([])
    })

    test('should recheck Native role status and identity before taxonomy queries in every read and write', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const created = await f.service.createTerm({ adminId: f.adminId, input: input() })
      await payload.update({
        id: f.adminId,
        collection: 'admins',
        data: { role: 'admin' } as never,
        overrideAccess: true,
      })
      expect((await f.service.listTerms({ adminId: f.adminId, input: {} })).items).toHaveLength(1)
      for (const [role, status] of [
        ['admin', 'disabled'],
        ['viewer', 'active'],
        ['unknown', 'active'],
      ]) {
        await f.adapter.client.execute({
          args: [role!, status!, f.adminId],
          sql: 'UPDATE admins SET role = ?, status = ? WHERE id = ?',
        })
        const find = vi.spyOn(payload, 'find')
        for (const work of [
          () => f.service.listTerms({ adminId: f.adminId, input: {} }),
          () => f.service.createTerm({ adminId: f.adminId, input: input({ code: 'forbidden' }) }),
          () =>
            f.service.updateTerm({
              adminId: f.adminId,
              input: { id: created.id, status: 'hidden' },
            }),
        ]) {
          await expect(work()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
        }
        expect(find.mock.calls.every(([args]) => args.collection === 'admins')).toBe(true)
        find.mockRestore()
      }
      await expect(f.service.listTerms({ adminId: 999999, input: {} })).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      })
      expect((await f.adapter.client.execute('SELECT * FROM audit_logs')).rows).toHaveLength(1)
      expect(Object.keys(f.adapter.sessions)).toEqual([])
      expect(await f.redis.client.keys('*')).toEqual([])
    })

    test('should coordinate logical keys through Redis and detect tombstones and duplicate candidates without unique constraints', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const results = await Promise.allSettled([
        f.service.createTerm({ adminId: f.adminId, input: input() }),
        f.service.createTerm({ adminId: f.adminId, input: input() }),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'PUBLICATION_CONFLICT', status: 409 },
      })
      const category = (await f.service.listTerms({ adminId: f.adminId, input: {} })).items[0]!
      await f.service.createTerm({ adminId: f.adminId, input: input({ kind: 'label' }) })
      await update({
        id: category.id,
        collection: 'taxonomy-terms',
        data: { deletedAt: NOW, deletedBy: 'system:fixture', isDeleted: true },
        payload,
      })
      await expect(
        f.service.createTerm({ adminId: f.adminId, input: input() }),
      ).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' })
      await expect(
        f.service.updateTerm({ adminId: f.adminId, input: { id: category.id, name: 'Changed' } }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await write({
        payload,
        work: ({ req, runtime }) =>
          runtime.create({
            collection: 'taxonomy-terms',
            data: { ...audit, ...input(), sortOrder: 0, status: 'active' },
            req,
          }),
      })
      const live = (await f.service.listTerms({ adminId: f.adminId, input: { kind: 'category' } }))
        .items[0]!
      await expect(
        f.service.createTerm({ adminId: f.adminId, input: input() }),
      ).rejects.toMatchObject({ code: 'DATA_INTEGRITY_CONFLICT', status: 503 })
      await expect(
        f.service.updateTerm({ adminId: f.adminId, input: { id: live.id, name: 'Changed' } }),
      ).rejects.toMatchObject({ code: 'DATA_INTEGRITY_CONFLICT', status: 503 })
      expect((await f.adapter.client.execute('SELECT * FROM audit_logs')).rows).toHaveLength(2)
      expect(await f.redis.client.keys('*')).toEqual([])
    })

    test('should atomically roll back create and update when audit insertion fails', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const created = await f.service.createTerm({ adminId: f.adminId, input: input() })
      const tables = ['taxonomy_terms', 'audit_logs']
      const before = await Promise.all(
        tables.map(
          async (table) =>
            (await f.adapter.client.execute(`SELECT * FROM ${table} ORDER BY id`)).rows,
        ),
      )
      await f.adapter.client.execute(
        "CREATE TRIGGER fixture_taxonomy_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'taxonomy audit failure'); END",
      )
      try {
        await expect(
          f.service.createTerm({ adminId: f.adminId, input: input({ code: 'rollback' }) }),
        ).rejects.toBeDefined()
        await expect(
          f.service.updateTerm({
            adminId: f.adminId,
            input: { id: created.id, name: 'Uncommitted', status: 'hidden' },
          }),
        ).rejects.toBeDefined()
      } finally {
        await f.adapter.client.execute('DROP TRIGGER fixture_taxonomy_failure')
      }
      expect(
        await Promise.all(
          tables.map(
            async (table) =>
              (await f.adapter.client.execute(`SELECT * FROM ${table} ORDER BY id`)).rows,
          ),
        ),
      ).toEqual(before)
      expect(Object.keys(f.adapter.sessions)).toEqual([])
      expect(await f.redis.client.keys('*')).toEqual([])
    })

    test('should preserve current template and session inputs after taxonomy rename or hide while rejecting stale new saves', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const taxonomy = f.service
      const category = await taxonomy.createTerm({ adminId: f.adminId, input: input() })
      const label = await taxonomy.createTerm({
        adminId: f.adminId,
        input: input({ name: 'Original label', code: 'label', kind: 'label' }),
      })
      const media = await write({
        payload,
        work: ({ req, runtime }) =>
          runtime.create({
            collection: 'media',
            data: {
              ...audit,
              alt: 'Official fixture',
              filename: 'official.png',
              filesize: 100,
              height: 2,
              lifecycle: 'active',
              mimeType: 'image/png',
              originalName: 'official.png',
              owner: null,
              purpose: 'example',
              sha256: 'a'.repeat(64),
              storageBackend: 'fixture-metadata',
              storageBucket: 'fixture-input',
              storageName: 'official.png',
              visibility: 'official_public',
              width: 2,
            },
            req,
          }),
      })
      const templates = createPayloadCurrentTemplates({
        ...f.options,
        acceptedCapabilities: ['v1'],
        execution,
        hostCaps: caps,
        maxExampleMedia: 12,
      })
      const display = {
        name: 'Portrait',
        categoryId: category.id,
        categoryName: category.name,
        coverMediaId: media.id,
        examples: [{ inputMediaIds: [media.id], outputMediaId: media.id }],
        tagIds: [label.id],
        tags: [{ id: label.id, name: label.name }],
      }
      const configuration = {
        costCredits: 0,
        displayConfigJson: JSON.stringify(display),
        generationConfigJson: JSON.stringify({
          executorId: 'fixture-v1',
          parameters: { size: '1024x1024' },
          systemPrompt: 'Taxonomy fixture',
        }),
        inputSchemaJson: JSON.stringify({ ...caps, maxDescriptionLength: 0, minImages: 1 }),
        minClientCapability: 'v1',
        schemaVersion: 1,
        shareConfigJson: '{}',
      }
      const created = await templates.create({
        adminId: f.adminId,
        code: 'portrait',
        configuration,
        kind: 'effect',
      })
      await templates.setStatus({ adminId: f.adminId, status: 'published', templateId: created.id })
      const user = await payload.create({
        collection: 'users',
        data: { status: 'active' } as never,
        overrideAccess: true,
      })
      await createPayloadSessionCreator({ ...f.options, hostCaps: caps, isCompatible: () => true })(
        {
          command: { clientRequestId: 'taxonomy-fixed', templateId: created.id },
          userId: Number(user.id),
        },
      )
      const fixedTables = [
        'creation_templates',
        'creation_sessions',
        'creation_drafts',
        'generation_tasks',
      ]
      const snapshot = async () =>
        Promise.all(
          fixedTables.map(
            async (table) =>
              (await f.adapter.client.execute(`SELECT * FROM ${table} ORDER BY id`)).rows,
          ),
        )
      const before = await snapshot()
      await taxonomy.updateTerm({
        adminId: f.adminId,
        input: { id: category.id, name: 'Changed category' },
      })
      await taxonomy.updateTerm({ adminId: f.adminId, input: { id: label.id, status: 'hidden' } })
      expect(await snapshot()).toEqual(before)
      expect(
        (await templates.get({ adminId: f.adminId, templateId: created.id })).displayConfigJson,
      ).toBe(configuration.displayConfigJson)
      for (const body of [
        configuration,
        {
          ...configuration,
          displayConfigJson: JSON.stringify({ ...display, categoryName: 'Changed category' }),
        },
      ]) {
        await expect(
          templates.save({ adminId: f.adminId, configuration: body, templateId: created.id }),
        ).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' })
        expect(await snapshot()).toEqual(before)
      }
    })
  },
)
