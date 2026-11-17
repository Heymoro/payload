import { setTimeout as delay } from 'node:timers/promises'
import { createPayloadRequest } from 'payload'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createPayloadArtifactFavorite } from '../../src/creation/infrastructure/payload/artifact-favorite-repository.js'
import { cleanupLibrary, favorites, libraryFixture } from './library-fixture.js'
import { cleanupSQLiteFixture } from './sqlite.config.js'

test.suite(
  'Heymoro idempotent Artifact favorites',
  { config: './sqlite.config.ts', cron: false },
  () => {
    test.afterEach(async () => {
      vi.restoreAllMocks()
      await cleanupLibrary()
    })
    test.afterAll(() => cleanupSQLiteFixture())
    test('should insert replay cancel replay and restore one identity without touching delivery or financial rows', async ({
      payload,
    }) => {
      const f = await libraryFixture({ payload })
      const args = { artifactId: Number(f.artifacts[0]!.id), userId: f.userId }
      const tables = [
        'generation_tasks',
        'generation_attempts',
        'generation_inputs',
        'artifacts',
        'media',
        'creation_sessions',
        'creation_drafts',
        'credit_accounts',
        'credit_reservations',
        'credit_allocations',
        'credit_grants',
        'credit_ledger',
      ]
      const graph = async () =>
        Promise.all(
          tables.map(
            async (table) =>
              (await f.adapter.client.execute(`SELECT * FROM ${table} ORDER BY id`)).rows,
          ),
        )
      const before = await graph()
      expect(await f.favorite.set({ ...args, isFavorite: false })).toEqual({
        isFavorite: false,
        savedAt: null,
      })
      expect(await favorites(f)).toHaveLength(0)
      expect((await f.favorite.set({ ...args, isFavorite: true })).isFavorite).toBe(true)
      const first = (await favorites(f))[0]!
      expect(first).toMatchObject({
        artifact_id: args.artifactId,
        created_at: f.state.now,
        created_by: `user:${args.userId}`,
        deleted_at: null,
        deleted_by: null,
        is_deleted: 0,
        saved_at: f.state.now,
        updated_at: f.state.now,
        updated_by: `user:${args.userId}`,
        user_id: args.userId,
      })
      f.state.now = '2026-11-13T12:00:00.000Z'
      await f.favorite.set({ ...args, isFavorite: true })
      expect((await favorites(f))[0]).toEqual(first)
      const cancelStartedAt = Date.now()
      await f.favorite.set({ ...args, isFavorite: false })
      const cancelFinishedAt = Date.now()
      const deleted = (await favorites(f))[0]!
      if (typeof deleted.updated_at !== 'string') {
        throw new TypeError('Expected a Native updated_at string.')
      }
      expect(new Date(deleted.updated_at).toISOString()).toBe(deleted.updated_at)
      expect(Date.parse(deleted.updated_at)).toBeGreaterThanOrEqual(cancelStartedAt)
      expect(Date.parse(deleted.updated_at)).toBeLessThanOrEqual(cancelFinishedAt)
      expect(deleted).toEqual({
        ...first,
        deleted_at: f.state.now,
        deleted_by: `user:${args.userId}`,
        is_deleted: 1,
        updated_at: deleted.updated_at,
        updated_by: `user:${args.userId}`,
      })
      await f.favorite.set({ ...args, isFavorite: false })
      expect((await favorites(f))[0]).toEqual(deleted)
      f.state.now = '2026-11-14T12:00:00.000Z'
      const restoreStartedAt = Date.now()
      await f.favorite.set({ ...args, isFavorite: true })
      const restoreFinishedAt = Date.now()
      const restored = (await favorites(f))[0]!
      if (typeof restored.updated_at !== 'string') {
        throw new TypeError('Expected a Native updated_at string.')
      }
      expect(new Date(restored.updated_at).toISOString()).toBe(restored.updated_at)
      expect(Date.parse(restored.updated_at)).toBeGreaterThanOrEqual(restoreStartedAt)
      expect(Date.parse(restored.updated_at)).toBeLessThanOrEqual(restoreFinishedAt)
      expect(restored).toEqual({
        ...first,
        saved_at: f.state.now,
        updated_at: restored.updated_at,
        updated_by: `user:${args.userId}`,
      })
      expect(restored.id).toBe(first.id)
      expect(restored.created_at).toBe(first.created_at)
      expect(restored.created_by).toBe(first.created_by)
      expect(restored.is_deleted).toBe(0)
      expect(restored.deleted_at).toBeNull()
      expect(restored.deleted_by).toBeNull()
      expect(restored.saved_at).not.toBe(first.saved_at)
      expect(await graph()).toEqual(before)
    })
    test('should serialize concurrent duplicate PUTs with real Redis and keep one tuple', async ({
      payload,
    }) => {
      const f = await libraryFixture({ payload })
      const args = { artifactId: Number(f.artifacts[0]!.id), isFavorite: true, userId: f.userId }
      await Promise.all(Array.from({ length: 8 }, () => f.favorite.set(args)))
      expect(await favorites(f)).toHaveLength(1)
      expect(await f.redis.client.keys('*')).toEqual([])
    })
    test('should permit cleanup of a deleted Artifact or invalid media but reject PUT', async ({
      payload,
    }) => {
      const f = await libraryFixture({ payload })
      const args = { artifactId: Number(f.artifacts[0]!.id), userId: f.userId }
      await f.favorite.set({ ...args, isFavorite: true })
      await f.adapter.client.execute(
        "UPDATE media SET lifecycle='deleted' WHERE purpose='artifact'",
      )
      await expect(f.favorite.set({ ...args, isFavorite: true })).rejects.toMatchObject({
        status: 503,
      })
      await f.favorite.set({ ...args, isFavorite: false })
      await f.adapter.client.execute(
        'UPDATE artifacts SET is_deleted=1,deleted_at=created_at,deleted_by=created_by',
      )
      await expect(f.favorite.set({ ...args, isFavorite: true })).rejects.toMatchObject({
        status: 404,
      })
      expect(await f.favorite.set({ ...args, isFavorite: false })).toEqual({
        isFavorite: false,
        savedAt: null,
      })
    })
    test('should reject duplicate favorite identities including deleted rows rather than choose one', async ({
      payload,
    }) => {
      const f = await libraryFixture({ payload })
      const args = { artifactId: Number(f.artifacts[0]!.id), isFavorite: true, userId: f.userId }
      await f.favorite.set(args)
      await f.adapter.client.execute(
        'INSERT INTO saved_artifacts (user_id,artifact_id,saved_at,created_at,updated_at,created_by,updated_by,is_deleted,deleted_at,deleted_by) SELECT user_id,artifact_id,saved_at,created_at,updated_at,created_by,updated_by,1,created_at,created_by FROM saved_artifacts',
      )
      await expect(f.favorite.set(args)).rejects.toMatchObject({ status: 503 })
      await expect(f.library.list({ query: {}, userId: f.userId })).rejects.toMatchObject({
        status: 503,
      })
    })
    for (const operation of ['insert', 'cancel', 'restore'] as const) {
      test(`should fully rollback ${operation} SQL failure`, async ({ payload }) => {
        const f = await libraryFixture({ payload })
        const args = { artifactId: Number(f.artifacts[0]!.id), userId: f.userId }
        if (operation !== 'insert') {
          await f.favorite.set({ ...args, isFavorite: true })
        }
        if (operation === 'restore') {
          await f.favorite.set({ ...args, isFavorite: false })
        }
        const before = await favorites(f)
        await f.adapter.client.execute(
          `CREATE TRIGGER favorite_failure BEFORE ${operation === 'insert' ? 'INSERT' : 'UPDATE'} ON saved_artifacts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
        )
        try {
          await expect(
            f.favorite.set({ ...args, isFavorite: operation !== 'cancel' }),
          ).rejects.toBeDefined()
          expect(await favorites(f)).toEqual(before)
        } finally {
          await f.adapter.client.execute('DROP TRIGGER favorite_failure')
        }
      })
    }
    test('should use ordinary tuple indexes and private numeric references without foreign keys', async ({
      payload,
    }) => {
      const f = await libraryFixture({ payload })
      const indexes = (await f.adapter.client.execute("PRAGMA index_list('saved_artifacts')")).rows
      expect(indexes.length).toBe(2)
      expect(indexes.every((row) => row.unique === 0)).toBe(true)
      expect(
        (await f.adapter.client.execute("PRAGMA foreign_key_list('saved_artifacts')")).rows,
      ).toEqual([])
      const collection = (payload.collections as Record<string, typeof payload.collections.users>)[
        'saved-artifacts'
      ]!.config
      expect(collection.fields.some((field) => field.type === 'relationship')).toBe(false)
      expect(
        await collection.access.read({
          slug: 'saved-artifacts',
          req: await createPayloadRequest({ payload }),
        }),
      ).toBe(false)
      await expect(
        payload.create({ collection: 'saved-artifacts' as never, data: {} as never }),
      ).rejects.toThrow('capability')
    })
    test('should sample the clock only after coordination and only for an actual write', async ({
      payload,
    }) => {
      const f = await libraryFixture({ payload })
      const args = { artifactId: Number(f.artifacts[0]!.id), userId: f.userId }
      let held = false
      const clock = vi.fn(() => {
        expect(held).toBe(true)
        return f.state.now
      })
      const coordinate: typeof f.options.coordinate = ({ resource, work }) =>
        f.options.coordinate({
          resource,
          work: async (lease) => {
            held = true
            try {
              return await work(lease)
            } finally {
              held = false
            }
          },
        })
      const favorite = createPayloadArtifactFavorite({ ...f.options, clock, coordinate })
      await favorite.set({ ...args, isFavorite: false })
      expect(clock).not.toHaveBeenCalled()
      await favorite.set({ ...args, isFavorite: true })
      expect(clock).toHaveBeenCalledTimes(1)
      await favorite.set({ ...args, isFavorite: true })
      expect(clock).toHaveBeenCalledTimes(1)
      await favorite.set({ ...args, isFavorite: false })
      expect(clock).toHaveBeenCalledTimes(2)
    })
    for (const operation of ['insert', 'cancel', 'restore'] as const) {
      test(`should rollback ${operation} after real Redis ownership loss before commit`, async ({
        payload,
      }) => {
        const f = await libraryFixture({ payload })
        const args = { artifactId: Number(f.artifacts[0]!.id), userId: f.userId }
        if (operation !== 'insert') {
          await f.favorite.set({ ...args, isFavorite: true })
        }
        if (operation === 'restore') {
          await f.favorite.set({ ...args, isFavorite: false })
        }
        const before = await favorites(f)
        const local = payload as unknown as {
          create: (input: { collection: string }) => Promise<unknown>
          update: (input: { collection: string }) => Promise<unknown>
        }
        const original = local[operation === 'insert' ? 'create' : 'update'].bind(local)
        const method = operation === 'insert' ? 'create' : 'update'
        const spy = vi.spyOn(local, method).mockImplementation(async (input) => {
          const result = await original(input)
          if ((input as { collection: string }).collection === 'saved-artifacts') {
            const keys = await f.redis.client.keys('*')
            expect(keys).toHaveLength(1)
            await f.redis.client.del(...keys)
            await delay(650)
          }
          return result
        })
        await expect(
          f.favorite.set({ ...args, isFavorite: operation !== 'cancel' }),
        ).rejects.toMatchObject({ status: 503 })
        spy.mockRestore()
        expect(await favorites(f)).toEqual(before)
        expect(await f.redis.client.keys('*')).toEqual([])
      })
    }
    test('should not automatically rewrite after a committed transaction loses its acknowledgement', async ({
      payload,
    }) => {
      const f = await libraryFixture({ payload })
      const args = { artifactId: Number(f.artifacts[0]!.id), isFavorite: true, userId: f.userId }
      const original = f.adapter.client.transaction.bind(f.adapter.client)
      let commits = 0
      const spy = vi
        .spyOn(f.adapter.client, 'transaction')
        .mockImplementation(async (...args: Parameters<typeof original>) => {
          const transaction = await original(...args)
          return new Proxy(transaction, {
            get(target, property) {
              if (property === 'commit') {
                return async () => {
                  commits++
                  await target.commit()
                  throw new Error('Fixture lost commit ACK')
                }
              }
              const value: unknown = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        })
      const favorite = createPayloadArtifactFavorite({
        ...f.options,
        retry: { backoffMs: 0, maxAttempts: 3 },
      })
      await expect(favorite.set(args)).rejects.toMatchObject({ commitStarted: true })
      spy.mockRestore()
      expect(commits).toBe(1)
      const first = await favorites(f)
      expect(first).toHaveLength(1)
      f.state.now = '2026-11-13T12:00:00.000Z'
      await f.favorite.set(args)
      expect(await favorites(f)).toEqual(first)
    })
    test('should order favorites by relation savedAt then id and restore to the front without copying images', async ({
      payload,
    }) => {
      const f = await libraryFixture({ count: 3, payload })
      for (const row of f.artifacts) {
        await f.favorite.set({ artifactId: Number(row.id), isFavorite: true, userId: f.userId })
      }
      const args = { artifactId: Number(f.artifacts[0]!.id), userId: f.userId }
      expect(
        (await f.library.list({ query: { saved: 'true' }, userId: f.userId })).items.map(
          (row) => row.id,
        ),
      ).toEqual(f.artifacts.map((row) => Number(row.id)).reverse())
      await f.favorite.set({ ...args, isFavorite: false })
      f.state.now = '2026-11-13T12:00:00.000Z'
      await f.favorite.set({ ...args, isFavorite: true })
      const items = (await f.library.list({ query: { saved: 'true' }, userId: f.userId })).items
      expect(items[0]!.id).toBe(args.artifactId)
      expect((await f.adapter.client.execute('SELECT id FROM artifacts')).rows).toHaveLength(3)
    })
    test('should reject malformed Artifact identity or deletion state even during DELETE cleanup', async ({
      payload,
    }) => {
      const f = await libraryFixture({ payload })
      const args = { artifactId: Number(f.artifacts[0]!.id), userId: f.userId }
      await f.favorite.set({ ...args, isFavorite: true })
      await f.adapter.client.execute(
        'UPDATE artifacts SET is_deleted=1,deleted_at=NULL,deleted_by=NULL',
      )
      await expect(f.favorite.set({ ...args, isFavorite: false })).rejects.toMatchObject({
        status: 503,
      })
      await f.adapter.client.execute(
        'UPDATE artifacts SET deleted_at=created_at,deleted_by=created_by,output_index=2',
      )
      await expect(f.favorite.set({ ...args, isFavorite: false })).rejects.toMatchObject({
        status: 503,
      })
    })

    test('should hide foreign and missing favorite targets and require the current active actor', async ({
      payload,
    }) => {
      const f = await libraryFixture({ payload })
      const artifactId = Number(f.artifacts[0]!.id)
      const other = await payload.create({
        collection: 'users',
        data: { status: 'active' } as never,
        overrideAccess: true,
      })
      for (const isFavorite of [true, false]) {
        await expect(
          f.favorite.set({ artifactId, isFavorite, userId: other.id }),
        ).rejects.toMatchObject({ status: 404 })
        await expect(
          f.favorite.set({ artifactId: artifactId + 999, isFavorite, userId: f.userId }),
        ).rejects.toMatchObject({ status: 404 })
      }
      await f.adapter.client.execute("UPDATE users SET status='disabled'")
      await expect(
        f.favorite.set({ artifactId, isFavorite: false, userId: f.userId }),
      ).rejects.toMatchObject({ status: 401 })
      expect(await favorites(f)).toEqual([])
    })
  },
)
