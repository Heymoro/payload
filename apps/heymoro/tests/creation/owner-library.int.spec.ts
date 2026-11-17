import { createClient } from '@libsql/client'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createPayloadArtifactFavorite } from '../../src/creation/infrastructure/payload/artifact-favorite-repository.js'
import {
  createLibraryReader,
  createPayloadOwnerLibrary,
} from '../../src/creation/infrastructure/payload/owner-library-repository.js'
import { cleanupLibrary, cursorKey, libraryFixture } from './library-fixture.js'
import { cleanupSQLiteFixture, gate, sqliteURL } from './sqlite.config.js'

const dtoFields = [
  'id',
  'taskId',
  'sessionId',
  'mediaId',
  'outputIndex',
  'createdAt',
  'mimeType',
  'width',
  'height',
  'isFavorite',
  'savedAt',
].sort()
test.suite('Heymoro owner Artifact library', { config: './sqlite.config.ts', cron: false }, () => {
  test.afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupLibrary()
  })
  test.afterAll(() => cleanupSQLiteFixture())
  test('should batch twenty real worker deliveries into immutable DTOs without writes Redis S3 or financial reads', async ({
    payload,
  }) => {
    const f = await libraryFixture({ count: 21, payload })
    const find = vi.spyOn(payload, 'find')
    const writes = [
      vi.spyOn(payload, 'create'),
      vi.spyOn(payload, 'update'),
      vi.spyOn(payload, 'delete'),
    ]
    const redis = vi.spyOn(f.redis.client, 'sendCommand')
    const storageRequests = f.http.requests.length
    const storage = vi.fn()
    f.http.observe(storage)
    const result = await f.library.list({ query: {}, userId: f.userId })
    expect(result.items).toHaveLength(20)
    expect(result.hasMore).toBe(true)
    for (const item of result.items) {
      expect(Object.keys(item).sort()).toEqual(dtoFields)
      expect(item.isFavorite).toBe(false)
      expect(item.savedAt).toBeNull()
      expect(Object.isFrozen(item)).toBe(true)
    }
    expect(Object.isFrozen(result.items)).toBe(true)
    const publicJSON = JSON.stringify(result.items)
    for (const secret of [
      'PRIVATE SYSTEM INSTRUCTION',
      'fixture-image-v1',
      'fixture-output',
      'storageBackend',
      'executionSnapshotJson',
      'createdBy',
    ]) {
      expect(publicJSON).not.toContain(secret)
    }
    for (const [args] of find.mock.calls) {
      expect(() =>
        gate.assert({ req: args.req as Parameters<typeof gate.assert>[0]['req'] }),
      ).toThrow('capability')
    }
    expect(find.mock.calls.length).toBeLessThanOrEqual(12)
    expect(
      find.mock.calls.every(([args]) => !/credit|ledger|grant/.test(String(args.collection))),
    ).toBe(true)
    for (const spy of writes) {
      expect(spy).not.toHaveBeenCalled()
    }
    expect(redis).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
    expect(f.http.requests).toHaveLength(storageRequests)
    const next = await f.library.list({ query: { cursor: result.nextCursor }, userId: f.userId })
    expect(next.items).toHaveLength(1)
    expect(new Set([...result.items, ...next.items].map((item) => item.id)).size).toBe(21)
    expect(result.items.map((item) => item.id)).toEqual(
      f.artifacts
        .map((row) => Number(row.id))
        .reverse()
        .slice(0, 20),
    )
  })
  test('should preserve old images after template withdrawal and parent soft deletion', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    await f.adapter.client.execute("UPDATE creation_templates SET status='offline'")
    await f.adapter.client.execute("UPDATE creation_templates SET status='offline'")
    await f.adapter.client.execute('UPDATE creation_sessions SET is_deleted=1')
    await f.adapter.client.execute('UPDATE generation_tasks SET is_deleted=1')
    expect(
      (await f.library.get({ artifactId: Number(f.artifacts[0]!.id), userId: f.userId })).id,
    ).toBe(f.artifacts[0]!.id)
  })
  test('should authorize the current actor and hide foreign missing and own deleted details', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    const artifactId = Number(f.artifacts[0]!.id)
    await expect(f.library.get({ artifactId, userId: f.userId + 999 })).rejects.toMatchObject({
      status: 401,
    })
    await expect(
      f.library.get({ artifactId: artifactId + 999, userId: f.userId }),
    ).rejects.toMatchObject({ status: 404 })
    await f.adapter.client.execute(
      'UPDATE artifacts SET is_deleted=1,deleted_at=created_at,deleted_by=created_by',
    )
    await expect(f.library.get({ artifactId, userId: f.userId })).rejects.toMatchObject({
      status: 404,
    })
    expect((await f.library.list({ query: {}, userId: f.userId })).items).toEqual([])
    await f.adapter.client.execute("UPDATE users SET status='disabled'")
    await expect(f.library.list({ query: {}, userId: f.userId })).rejects.toMatchObject({
      status: 401,
    })
  })
  test('should bind cursors to normalized view user and page configuration without skipping mid batch', async ({
    payload,
  }) => {
    const f = await libraryFixture({ count: 5, payload })
    const library = createPayloadOwnerLibrary({ batchSize: 5, cursorKey, pageSize: 2, payload })
    const a = await library.list({ query: {}, userId: f.userId })
    const b = await library.list({
      query: { cursor: a.nextCursor, saved: 'false' },
      userId: f.userId,
    })
    const c = await library.list({ query: { cursor: b.nextCursor }, userId: f.userId })
    expect([...a.items, ...b.items, ...c.items].map((item) => item.id)).toEqual(
      f.artifacts.map((row) => Number(row.id)).reverse(),
    )
    for (const query of [{ cursor: a.nextCursor, saved: 'true' }, { cursor: a.nextCursor + 'a' }]) {
      await expect(library.list({ query, userId: f.userId })).rejects.toMatchObject({ status: 400 })
    }
    await expect(
      createPayloadOwnerLibrary({ cursorKey, pageSize: 3, payload }).list({
        query: { cursor: a.nextCursor },
        userId: f.userId,
      }),
    ).rejects.toMatchObject({ status: 400 })
  })
  test('should scan bounded tombstone empty pages and resume only after consumed relations', async ({
    payload,
  }) => {
    const f = await libraryFixture({ count: 4, payload })
    for (const row of f.artifacts) {
      await f.favorite.set({ artifactId: Number(row.id), isFavorite: true, userId: f.userId })
    }
    await f.adapter.client.execute(
      `UPDATE artifacts SET is_deleted=1,deleted_at=created_at,deleted_by=created_by WHERE id IN (${f.artifacts
        .slice(1)
        .map((row) => Number(row.id))
        .join(',')})`,
    )
    const library = createPayloadOwnerLibrary({
      batchSize: 2,
      cursorKey,
      pageSize: 2,
      payload,
      scanBudget: 2,
    })
    const a = await library.list({ query: { saved: 'true' }, userId: f.userId })
    expect(a.items).toEqual([])
    expect(a.hasMore).toBe(true)
    const b = await library.list({
      query: { cursor: a.nextCursor, saved: 'true' },
      userId: f.userId,
    })
    expect(b.items.map((item) => item.id)).toEqual([f.artifacts[0]!.id])
    expect(b.hasMore).toBe(true)
    expect(
      (await library.list({ query: { cursor: b.nextCursor, saved: 'true' }, userId: f.userId }))
        .items,
    ).toEqual([])
  })
  for (const corruption of [
    "UPDATE generation_tasks SET request_hash='broken'",
    'UPDATE creation_sessions SET user_id=user_id+100',
    'UPDATE generation_attempts SET attempt_no=2',
    'UPDATE generation_attempts SET is_deleted=1',
    "UPDATE media SET lifecycle='deleted' WHERE purpose='artifact'",
    "DELETE FROM media WHERE purpose='artifact'",
    'UPDATE artifacts SET output_index=2',
    "UPDATE artifacts SET created_at='+010000-01-01T00:00:00.000Z'",
  ]) {
    test(`should report corrupt delivered metadata as 503: ${corruption}`, async ({ payload }) => {
      const f = await libraryFixture({ payload })
      await f.adapter.client.execute(corruption)
      await expect(f.library.list({ query: {}, userId: f.userId })).rejects.toMatchObject({
        status: 503,
      })
    })
  }
  test('should observe one SQLite snapshot when a second connection changes favorites midway', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    const artifactId = Number(f.artifacts[0]!.id)
    await f.favorite.set({ artifactId, isFavorite: true, userId: f.userId })
    const other = createClient({ url: sqliteURL })
    const original = payload.find.bind(payload)
    let changed = false
    vi.spyOn(payload, 'find').mockImplementation(async (args) => {
      const result = await original(args)
      if (!changed && String(args.collection) === 'artifacts') {
        changed = true
        await other.execute('UPDATE saved_artifacts SET is_deleted=1')
      }
      return result
    })
    try {
      expect((await f.library.list({ query: {}, userId: f.userId })).items[0]!.isFavorite).toBe(
        true,
      )
      expect((await f.library.list({ query: {}, userId: f.userId })).items[0]!.isFavorite).toBe(
        false,
      )
    } finally {
      other.close()
    }
  })
  test('should reject hidden accessor input before IO and snapshot caller-owned queries before await', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    let calls = 0
    const query = Object.defineProperty({}, 'saved', {
      enumerable: true,
      get() {
        calls++
        return 'true'
      },
    })
    const spy = vi.spyOn(payload, 'find')
    await expect(f.library.list({ query, userId: f.userId })).rejects.toMatchObject({ status: 400 })
    expect(calls).toBe(0)
    expect(spy).not.toHaveBeenCalled()
    const mutable = { saved: 'false' }
    const pending = f.library.list({ query: mutable, userId: f.userId })
    mutable.saved = 'true'
    expect((await pending).items).toHaveLength(1)
    expect(Object.isFrozen(mutable)).toBe(false)
  })
  test('should fail factories synchronously with zero IO for incomplete target schemas', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    const find = vi.spyOn(payload, 'find')
    const transaction = vi.spyOn(f.adapter.client, 'transaction')
    const redis = vi.spyOn(f.redis.client, 'sendCommand')
    for (const [slug, fieldName] of [
      ['users', 'isDeleted'],
      ['artifacts', 'mediaId'],
      ['saved-artifacts', 'createdBy'],
      ['media', 'sha256'],
    ] as const) {
      const config = (payload.collections as Record<string, typeof payload.collections.users>)[
        slug
      ]!.config
      const original = config.flattenedFields
      config.flattenedFields = original.filter((field) => field.name !== fieldName)
      try {
        expect(() => createPayloadOwnerLibrary({ cursorKey, payload })).toThrow()
        expect(() => createPayloadArtifactFavorite(f.options)).toThrow()
      } finally {
        config.flattenedFields = original
      }
    }
    expect(find).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
    expect(redis).not.toHaveBeenCalled()
  })
  test('should detect global Artifact tuple collisions even when the conflicting row is foreign and deleted', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    await f.adapter.client.execute(
      'INSERT INTO artifacts (user_id,session_id,task_id,media_id,output_index,created_at,updated_at,created_by,updated_by,is_deleted,deleted_at,deleted_by) SELECT user_id+100,session_id,task_id,media_id,output_index,created_at,updated_at,created_by,updated_by,1,created_at,created_by FROM artifacts',
    )
    await expect(f.library.list({ query: {}, userId: f.userId })).rejects.toMatchObject({
      status: 503,
    })
  })
  test('should detect global media locator collisions including foreign deleted registrations', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    await f.adapter.client.execute(
      "INSERT INTO media (alt,original_name,owner,storage_backend,storage_bucket,storage_name,sha256,lifecycle,purpose,visibility,created_at,updated_at,created_by,updated_by,is_deleted,deleted_at,deleted_by) SELECT alt,original_name,owner+100,storage_backend,storage_bucket,storage_name,sha256,lifecycle,purpose,visibility,created_at,updated_at,created_by,updated_by,1,created_at,created_by FROM media WHERE purpose='artifact'",
    )
    await expect(f.library.list({ query: {}, userId: f.userId })).rejects.toMatchObject({
      status: 503,
    })
  })
  test('should reject a physically missing favorite target instead of returning an empty saved page', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    await f.favorite.set({
      artifactId: Number(f.artifacts[0]!.id),
      isFavorite: true,
      userId: f.userId,
    })
    await f.adapter.client.execute('DELETE FROM artifacts')
    await expect(
      f.library.list({ query: { saved: 'true' }, userId: f.userId }),
    ).rejects.toMatchObject({ status: 503 })
  })
  test('should accept a complete NOT_SENT retry prefix and reject any hidden duplicate or mismatching attempt', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    await f.adapter.client.execute('UPDATE generation_attempts SET attempt_no=2')
    await f.adapter.client.execute(
      "INSERT INTO generation_attempts (task_id,attempt_no,provider,model,status,error_code,created_at,updated_at,created_by,updated_by,is_deleted) SELECT task_id,1,provider,model,'failed','NOT_SENT',created_at,updated_at,created_by,updated_by,0 FROM generation_attempts",
    )
    expect((await f.library.list({ query: {}, userId: f.userId })).items).toHaveLength(1)
    await f.adapter.client.execute(
      "UPDATE generation_attempts SET error_code='PROVIDER_FAILED' WHERE attempt_no=1",
    )
    await expect(f.library.list({ query: {}, userId: f.userId })).rejects.toMatchObject({
      status: 503,
    })
    await f.adapter.client.execute(
      "UPDATE generation_attempts SET error_code='NOT_SENT', model='wrong-model' WHERE attempt_no=1",
    )
    await expect(f.library.list({ query: {}, userId: f.userId })).rejects.toMatchObject({
      status: 503,
    })
  })
  test('should omit a foreign detail with 404 and reject cross-user signed cursors before IO', async ({
    payload,
  }) => {
    const f = await libraryFixture({ count: 2, payload })
    const other = await payload.create({
      collection: 'users',
      data: { isDeleted: false, status: 'active' } as never,
      overrideAccess: true,
    })
    await expect(
      f.library.get({ artifactId: Number(f.artifacts[0]!.id), userId: other.id }),
    ).rejects.toMatchObject({ status: 404 })
    const library = createPayloadOwnerLibrary({ cursorKey, pageSize: 1, payload })
    const page = await library.list({ query: {}, userId: f.userId })
    const spy = vi.spyOn(payload, 'find')
    await expect(
      library.list({ query: { cursor: page.nextCursor }, userId: other.id }),
    ).rejects.toMatchObject({ status: 400 })
    expect(spy).not.toHaveBeenCalled()
  })
  test('should reject malformed Artifact tombstones rather than silently skipping saved relations', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    await f.favorite.set({
      artifactId: Number(f.artifacts[0]!.id),
      isFavorite: true,
      userId: f.userId,
    })
    await f.adapter.client.execute(
      'UPDATE artifacts SET is_deleted=1,deleted_at=NULL,deleted_by=NULL',
    )
    await expect(
      f.library.list({ query: { saved: 'true' }, userId: f.userId }),
    ).rejects.toMatchObject({ status: 503 })
  })
  test('should check global Artifact tuples for saved tombstones before skip, without requiring old media', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    await f.favorite.set({
      artifactId: Number(f.artifacts[0]!.id),
      isFavorite: true,
      userId: f.userId,
    })
    await f.adapter.client.execute(
      'UPDATE artifacts SET is_deleted=1,deleted_at=created_at,deleted_by=created_by',
    )
    await f.adapter.client.execute("UPDATE media SET lifecycle='deleted' WHERE purpose='artifact'")
    expect((await f.library.list({ query: { saved: 'true' }, userId: f.userId })).items).toEqual([])
    await f.adapter.client.execute(
      'INSERT INTO artifacts (user_id,session_id,task_id,media_id,output_index,created_at,updated_at,created_by,updated_by,is_deleted,deleted_at,deleted_by) SELECT user_id+100,session_id,task_id,media_id,output_index,created_at,updated_at,created_by,updated_by,1,created_at,created_by FROM artifacts',
    )
    await expect(
      f.library.list({ query: { saved: 'true' }, userId: f.userId }),
    ).rejects.toMatchObject({ status: 503 })
  })
  test('should preserve the original database transport error through the real SQLite read snapshot', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    const sentinel = new Error('Fixture database transport failure')
    vi.spyOn(payload, 'find').mockRejectedValue(sentinel)
    await expect(f.library.list({ query: {}, userId: f.userId })).rejects.toBe(sentinel)
    await expect(
      f.library.get({ artifactId: Number(f.artifacts[0]!.id), userId: f.userId }),
    ).rejects.toBe(sentinel)
    expect(Object.keys(f.adapter.sessions)).toEqual([])
  })
  test('should reject incomplete unbounded attempts and inconsistent counts while accepting normal bounded totals', async () => {
    const succeededPrefix = [{ id: 1, attemptNo: 1, status: 'succeeded', taskId: 1 }]
    const incomplete = createLibraryReader({
      find: async () => ({ docs: succeededPrefix, totalDocs: 2 }),
    })
    await expect(incomplete.attempts({ taskIds: [1] })).rejects.toMatchObject({
      code: 'DATA_INTEGRITY_CONFLICT',
      status: 503,
    })
    const bounded = createLibraryReader({
      find: async () => ({ docs: succeededPrefix, totalDocs: 100 }),
    })
    expect(await bounded.scan({ after: null, limit: 1, saved: false, userId: 1 })).toEqual(
      succeededPrefix,
    )
    for (const result of [
      { docs: succeededPrefix, totalDocs: 0 },
      { docs: succeededPrefix, totalDocs: NaN },
      { docs: succeededPrefix, totalDocs: -1 },
      { docs: [...succeededPrefix, ...succeededPrefix], totalDocs: 2 },
    ]) {
      const reader = createLibraryReader({ find: async () => result })
      await expect(
        reader.scan({ after: null, limit: 1, saved: false, userId: 1 }),
      ).rejects.toMatchObject({ code: 'DATA_INTEGRITY_CONFLICT', status: 503 })
    }
  })
  test('should reject a succeeded attempt prefix when the real snapshot reports more attempt rows', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    const original = payload.find.bind(payload)
    vi.spyOn(payload, 'find').mockImplementation(async (args) => {
      const result = await original(args)
      return String(args.collection) === 'generation-attempts'
        ? { ...result, totalDocs: result.totalDocs + 1 }
        : result
    })
    await expect(f.library.list({ query: {}, userId: f.userId })).rejects.toMatchObject({
      code: 'DATA_INTEGRITY_CONFLICT',
      status: 503,
    })
  })
})
