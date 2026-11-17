import type { Payload } from 'payload'

import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createPayloadMediaService } from '../../src/creation/infrastructure/payload/media-repository.js'
import { createPayloadSessionShares } from '../../src/creation/infrastructure/payload/session-share-repository.js'
import { imageLimits } from './generation-worker-fixture.js'
import { cleanupLibrary, libraryFixture } from './library-fixture.js'
import { cleanupSQLiteFixture } from './sqlite.config.js'

async function fixture({ count = 2, payload }: { count?: number; payload: Payload }) {
  const f = await libraryFixture({ count, payload })
  const admin = await payload.create({
    collection: 'admins',
    data: { role: 'admin', status: 'active' } as never,
    overrideAccess: true,
  })
  const media = createPayloadMediaService({
    ...f.options,
    destination: { backend: 'fixture-metadata', bucket: 'fixture-input' },
    imageLimits,
    storage: f.storage,
  })
  const service = createPayloadSessionShares({ ...f.options, readImage: media.readForUser })
  const artifacts = f.artifacts.filter((a) => Number(a.session_id) === f.sessionId)
  const publish = () =>
    service.publish({
      adminId: Number(admin.id),
      input: {
        artifactIds: artifacts.map((a) => Number(a.id)),
        confirmed: true,
        sessionId: f.sessionId,
        title: '作品会话',
      },
    })
  return { ...f, adminId: Number(admin.id), artifacts, media, publish, service }
}
const graphTables = [
  'creation_sessions',
  'creation_drafts',
  'draft_inputs',
  'generation_tasks',
  'generation_attempts',
  'generation_inputs',
  'artifacts',
  'media',
  'credit_accounts',
  'credit_grants',
  'credit_allocations',
  'credit_reservations',
  'credit_ledger',
]
test.suite(
  'Administrator-published existing session shares',
  { config: './sqlite.config.ts', cron: false },
  () => {
    test.afterEach(async () => {
      vi.restoreAllMocks()
      await cleanupLibrary()
    })
    test.afterAll(cleanupSQLiteFixture)
    test('shares the actual generated results and S3 bytes without changing original execution or settlement', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const graph = async () =>
        Promise.all(
          graphTables.map(
            async (table) =>
              (await f.adapter.client.execute(`SELECT * FROM ${table} ORDER BY id`)).rows,
          ),
        )
      const before = await graph()
      const calls = f.state.calls
      const shared = await f.publish()
      const publicView = await f.service.get({ key: shared.key })
      expect(publicView.images.map((i) => i.id)).toEqual(f.artifacts.map((a) => Number(a.id)))
      expect(JSON.stringify(publicView)).not.toMatch(
        /userId|mediaId|PRIVATE|notes|description|storage|requestHash|execution|draft/,
      )
      const bytes = await f.service.image({
        artifactId: Number(f.artifacts[0]!.id),
        key: shared.key,
      })
      expect(bytes.bytes.length).toBeGreaterThan(0)
      expect(await graph()).toEqual(before)
      expect(f.state.calls).toBe(calls)
      await f.assertOutside()
    })
    test('enforces admin role and rechecks demotion on every read and write', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      await f.publish()
      await payload.update({
        id: f.adminId,
        collection: 'admins',
        data: { role: 'operator' } as never,
        overrideAccess: true,
      })
      for (const operation of [
        f.publish,
        () => f.service.list({ adminId: f.adminId }),
        () => f.service.inspect({ adminId: f.adminId, sessionId: f.sessionId }),
        () => f.service.revoke({ adminId: f.adminId, sessionId: f.sessionId }),
      ]) {
        await expect(operation()).rejects.toMatchObject({ code: 'ADMIN_FORBIDDEN' })
      }
      expect((await f.adapter.client.execute('SELECT * FROM session_shares')).rows).toHaveLength(1)
    })
    test('concurrent identical publication has one ordinary-index row and one audit, with standard fields', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const shares = await Promise.all([f.publish(), f.publish()])
      expect(shares[0]).toEqual(shares[1])
      const client = f.adapter.client
      expect((await client.execute('SELECT * FROM session_shares')).rows).toHaveLength(1)
      expect(
        (await client.execute("SELECT * FROM audit_logs WHERE action='session.share.publish'"))
          .rows,
      ).toHaveLength(1)
      expect((await client.execute('PRAGMA foreign_key_list(session_shares)')).rows).toHaveLength(0)
      expect(
        (await client.execute('PRAGMA index_list(session_shares)')).rows.every(
          (r) => r.unique === 0,
        ),
      ).toBe(true)
      const columns = (await client.execute('PRAGMA table_info(session_shares)')).rows.map(
        (r) => r.name,
      )
      expect(columns).toEqual(
        expect.arrayContaining([
          'created_at',
          'created_by',
          'updated_at',
          'updated_by',
          'is_deleted',
          'deleted_at',
          'deleted_by',
        ]),
      )
      expect(columns).not.toEqual(expect.arrayContaining(['version', 'revision']))
    })
    test('audit SQL failure rolls back the share and leaves the entire original graph intact', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const client = f.adapter.client
      await client.execute(
        "CREATE TRIGGER share_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='session.share.publish' BEGIN SELECT RAISE(ABORT,'share audit fixture'); END",
      )
      try {
        await expect(f.publish()).rejects.toBeDefined()
      } finally {
        await client.execute('DROP TRIGGER share_audit_failure')
      }
      expect((await client.execute('SELECT * FROM session_shares')).rows).toHaveLength(0)
      expect(
        (await f.service.inspect({ adminId: f.adminId, sessionId: f.sessionId })).images,
      ).toHaveLength(2)
    })
    test('blocks unselected private input and artifact access, and revocation has no public-media bypass', async ({
      payload,
    }) => {
      const f = await fixture({ payload })
      const share = await f.service.publish({
        adminId: f.adminId,
        input: {
          artifactIds: [Number(f.artifacts[0]!.id)],
          confirmed: true,
          sessionId: f.sessionId,
          title: '一张成品',
        },
      })
      await expect(
        f.service.image({ artifactId: Number(f.artifacts[1]!.id), key: share.key }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(
        f.media.readOfficialExample({ mediaId: Number(f.artifacts[0]!.media_id) }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await f.service.revoke({ adminId: f.adminId, sessionId: f.sessionId })
      await expect(f.service.get({ key: share.key })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(
        f.service.image({ artifactId: Number(f.artifacts[0]!.id), key: share.key }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const next = await f.publish()
      expect(next.key).not.toBe(share.key)
      await expect(f.service.get({ key: share.key })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
    test('rejects a cross-session artifact rather than publishing another private conversation', async ({
      payload,
    }) => {
      const f = await fixture({ count: 1, payload })
      const other = await fixture({ count: 1, payload })
      await expect(
        f.service.publish({
          adminId: f.adminId,
          input: {
            artifactIds: [Number(other.artifacts[0]!.id)],
            confirmed: true,
            sessionId: f.sessionId,
            title: '错误关联',
          },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect((await f.adapter.client.execute('SELECT * FROM session_shares')).rows).toHaveLength(0)
    })
    test('denies sharing artifacts of a soft-deleted successful task', async ({ payload }) => {
      const f = await fixture({ count: 1, payload })
      const published = await f.publish()
      await f.adapter.client.execute({
        args: [f.state.now, 'test', Number(f.artifacts[0]!.task_id)],
        sql: 'UPDATE generation_tasks SET is_deleted=1,deleted_at=?,deleted_by=? WHERE id=?',
      })
      await expect(f.publish()).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(f.service.get({ key: published.key })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      await expect(
        f.service.image({ artifactId: Number(f.artifacts[0]!.id), key: published.key }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    test('rechecks source deletion and admin demotion after storage IO', async ({ payload }) => {
      const f = await fixture({ count: 1, payload })
      const shared = await f.publish()
      const artifactId = Number(f.artifacts[0]!.id)
      let mode: 'delete' | 'demote' = 'delete'
      const service = createPayloadSessionShares({
        ...f.options,
        readImage: async (args) => {
          const image = await f.media.readForUser(args)
          if (mode === 'delete') {
            await f.adapter.client.execute({
              args: [Number(f.artifacts[0]!.task_id)],
              sql: 'UPDATE generation_tasks SET is_deleted=1 WHERE id=?',
            })
          } else {
            await payload.update({
              id: f.adminId,
              collection: 'admins',
              data: { role: 'operator' } as never,
              overrideAccess: true,
            })
          }
          return image
        },
      })
      await expect(service.image({ artifactId, key: shared.key })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      await f.adapter.client.execute({
        args: [Number(f.artifacts[0]!.task_id)],
        sql: 'UPDATE generation_tasks SET is_deleted=0 WHERE id=?',
      })
      mode = 'demote'
      await expect(
        service.previewImage({ adminId: f.adminId, artifactId, sessionId: f.sessionId }),
      ).rejects.toMatchObject({ code: 'ADMIN_FORBIDDEN' })
    })
    test('inspection keeps older published choices after the conversation gains more results', async ({
      payload,
    }) => {
      const f = await fixture({ count: 1, payload })
      const first = await f.publish()
      const firstId = Number(f.artifacts[0]!.id)
      for (let index = 0; index < 21; index++) {
        const input = { ...f.input, inputMediaIds: f.mediaIds }
        const args = { input, sessionId: f.sessionId, userId: f.userId }
        const quote = await f.admission.quoteGenerate(args)
        const task = await f.admission.submitGenerate({
          ...args,
          clientRequestId: `share-later-${index}`,
          quoteToken: quote.quoteToken,
        })
        await f.running.run({ taskId: task.task.id })
      }
      const inspected = await f.service.inspect({ adminId: f.adminId, sessionId: f.sessionId })
      expect(inspected.images.some((image) => image.id === firstId)).toBe(true)
      expect(inspected.share?.artifactIds).toEqual([firstId])
      expect(inspected.hasUnavailablePublishedImages).toBe(false)
      await f.service.publish({
        adminId: f.adminId,
        input: {
          artifactIds: inspected.share!.artifactIds,
          confirmed: true,
          sessionId: f.sessionId,
          title: '只改标题',
        },
      })
      expect((await f.service.get({ key: first.key })).images.map((i) => i.id)).toEqual([firstId])
    })
  },
)
