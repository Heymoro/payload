import type { Payload } from 'payload'

import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import {
  createPayloadMediaService,
  createPayloadVerifiedMediaRegistration,
} from '../../src/creation/infrastructure/payload/media-repository.js'
import { createPayloadOfficialMediaUploadService } from '../../src/creation/infrastructure/payload/official-media-repository.js'
import { createCreationRuntime } from '../../src/creation/infrastructure/payload/session-repository.js'
import {
  createSQLiteUnitOfWork,
  getCreationSQLiteAdapter,
} from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createS3ObjectStorage } from '../../src/creation/infrastructure/s3/object-storage.js'
import { startS3HTTPFixture } from './s3-http-fixture.js'
import { cleanupSQLiteFixture, gate } from './sqlite.config.js'

const imageLimits = {
  allowedMimeTypes: ['image/png'],
  maxBytes: 100_000,
  maxPixels: 100_000,
  timeoutMs: 1000,
}
const now = '2026-11-12T12:00:00.000Z'
const bytes = () =>
  sharp({ create: { background: 'blue', channels: 3, height: 2, width: 3 } })
    .png()
    .toBuffer()
const close: (() => Promise<void>)[] = []

test.suite(
  'Heymoro single verified media chain',
  { config: './sqlite.config.ts', cron: false },
  () => {
    test.afterAll(() => cleanupSQLiteFixture())
    test.afterEach(async () => {
      vi.restoreAllMocks()
      for (const work of close.splice(0).reverse()) {
        await work()
      }
    })
    test('should register official media with the same T2 req and no locked network', async ({
      payload,
    }) => {
      const { adapter, http, official } = await setup({ payload })
      const admin = await payload.create({
        collection: 'admins',
        data: { role: 'operator', status: 'active' } as never,
        overrideAccess: true,
      })
      const originalFind = payload.find.bind(payload)
      const originalCreate = payload.create.bind(payload)
      let adminReq: unknown
      let mediaReq: unknown
      vi.spyOn(payload, 'find').mockImplementation((args) => {
        if (args.collection === 'admins' && args.req?.transactionID) {
          adminReq = args.req
        }
        return originalFind(args)
      })
      vi.spyOn(payload, 'create').mockImplementation((args) => {
        if (args.collection === 'media') {
          mediaReq = args.req
        }
        return originalCreate(args)
      })
      const image = await bytes()
      const dto = await official.upload({
        adminId: Number(admin.id),
        input: image,
        originalName: 'official.png',
      })
      expect(adminReq).toBe(mediaReq)
      expect(mediaReq).toBeTruthy()
      expect(Object.keys(dto).sort()).toEqual(['filesize', 'height', 'id', 'mimeType', 'width'])
      const row = (await adapter.client.execute('SELECT * FROM media')).rows[0]!
      expect(row).toMatchObject({
        created_by: `admin:${admin.id}`,
        owner: null,
        purpose: 'example',
        visibility: 'official_public',
      })
      expect(row.storage_name).toMatch(/^official\/examples\/[a-f0-9-]{36}\/[a-f0-9]{64}$/)
      const object = http.objects.get(row.storage_name as string)!
      expect(object.bytes).toEqual(image)
      expect(
        http.requests.filter(({ key, method }) => key.startsWith('official/') && method === 'PUT'),
      ).toHaveLength(1)
      expect(
        http.requests.filter(({ key, method }) => key.startsWith('official/') && method === 'GET'),
      ).toHaveLength(1)
    })
    test('should recheck disabled admin after PUT, retain object, and never register', async ({
      payload,
    }) => {
      const { adapter, http, official } = await setup({ payload })
      const admin = await payload.create({
        collection: 'admins',
        data: { role: 'admin', status: 'active' } as never,
        overrideAccess: true,
      })
      let disabled = false
      http.observe(async () => {
        expect(Object.keys(adapter.sessions)).toHaveLength(0)
        if (!disabled) {
          disabled = true
          await adapter.client.execute({
            args: [admin.id],
            sql: "UPDATE admins SET status = 'disabled' WHERE id = ?",
          })
        }
      })
      await expect(
        official.upload({
          adminId: Number(admin.id),
          input: await bytes(),
          originalName: 'official.png',
        }),
      ).rejects.toMatchObject({ code: 'ADMIN_FORBIDDEN' })
      expect((await adapter.client.execute('SELECT * FROM media')).rows).toHaveLength(0)
      expect([...http.objects.keys()].filter((key) => key.startsWith('official/'))).toHaveLength(1)
      expect(
        http.requests.filter(
          ({ key, method }) => key.startsWith('official/') && method === 'DELETE',
        ),
      ).toHaveLength(0)
    })
    test('should preserve official bytes on rollback and reconcile one lost commit acknowledgement', async ({
      payload,
    }) => {
      const { adapter, http, official } = await setup({ payload })
      const admin = await payload.create({
        collection: 'admins',
        data: { role: 'admin', status: 'active' } as never,
        overrideAccess: true,
      })
      await adapter.client.execute(
        "CREATE TRIGGER official_fail AFTER INSERT ON media BEGIN SELECT RAISE(ABORT, 'official-registration'); END",
      )
      await expect(
        official.upload({
          adminId: Number(admin.id),
          input: await bytes(),
          originalName: 'official.png',
        }),
      ).rejects.toThrow()
      expect((await adapter.client.execute('SELECT * FROM media')).rows).toHaveLength(0)
      expect([...http.objects.keys()].filter((key) => key.startsWith('official/'))).toHaveLength(1)
      await adapter.client.execute('DROP TRIGGER official_fail')
      const original = adapter.client.transaction.bind(adapter.client)
      let committed = false
      http.observe(() => {
        expect(Object.keys(adapter.sessions)).toHaveLength(0)
        vi.spyOn(adapter.client, 'transaction').mockImplementation(async () => {
          const tx = await original('deferred')
          return new Proxy(tx, {
            get(target, property) {
              if (property === 'commit') {
                return async () => {
                  await target.commit()
                  if (!committed) {
                    committed = true
                    throw new Error('official lost commit acknowledgement')
                  }
                }
              }
              const value: unknown = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        })
      })
      const dto = await official.upload({
        adminId: Number(admin.id),
        input: await bytes(),
        originalName: 'official.png',
      })
      expect(dto.id).toBeGreaterThan(0)
      expect(committed).toBe(true)
      expect((await adapter.client.execute('SELECT * FROM media')).rows).toHaveLength(1)
      expect(
        http.requests.filter(({ key, method }) => key.startsWith('official/') && method === 'PUT'),
      ).toHaveLength(2)
      expect(
        http.requests.filter(
          ({ key, method }) => key.startsWith('official/') && method === 'DELETE',
        ),
      ).toHaveLength(0)
    })
    test('uploads independently, keeps one native schema, and does all network outside snapshots and leases', async ({
      payload,
    }) => {
      const fixture = await setup({ payload })
      const { adapter, http, service, userId } = fixture
      const image = await bytes()
      const one = await service.uploadForUser({
        declaredMimeType: 'application/octet-stream',
        input: image,
        originalName: 'photo.png',
        userId,
      })
      const two = await service.uploadForUser({ input: image, originalName: 'photo.png', userId })
      expect(one.id).not.toBe(two.id)
      expect(JSON.stringify(one)).not.toMatch(
        /backend|bucket|storage|sha256|createdBy|references\//i,
      )
      const rows = (await adapter.client.execute('SELECT * FROM media ORDER BY id')).rows
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        created_by: `user:${userId}`,
        filesize: image.length,
        height: 2,
        is_deleted: 0,
        mime_type: 'image/png',
        original_name: 'photo.png',
        owner: userId,
        purpose: 'reference',
        updated_by: `user:${userId}`,
        visibility: 'private',
        width: 3,
      })
      expect(rows[0]!.storage_name).not.toBe(rows[1]!.storage_name)
      expect(
        http.requests.filter(
          (request) => request.method === 'PUT' && request.key.startsWith('references/'),
        ),
      ).toHaveLength(2)
      const read = await service.readForUser({ mediaId: one.id, userId })
      expect(read.bytes).toEqual(image)
      expect(read.mimeType).toBe('image/png')
      expect(read.filename).toBe(`image-${one.id}.png`)
    })
    test('authorizes before storage access and again after long I/O; anonymous only sees active official examples', async ({
      payload,
    }) => {
      const { adapter, http, register, run, service, storage, userId } = await setup({ payload })
      const uploaded = await service.uploadForUser({
        input: await bytes(),
        originalName: 'x.png',
        userId,
      })
      const other = await account({ payload })
      const before = http.requests.length
      await expect(service.readForUser({ mediaId: uploaded.id, userId: other })).rejects.toThrow(
        /NOT_FOUND/,
      )
      await expect(service.readOfficialExample({ mediaId: uploaded.id })).rejects.toThrow(
        /NOT_FOUND/,
      )
      expect(http.requests).toHaveLength(before)
      await payload.update({
        id: userId,
        collection: 'users',
        data: { status: 'disabled' } as never,
        overrideAccess: true,
      })
      await expect(
        service.uploadForUser({ input: await bytes(), originalName: 'x.png', userId }),
      ).rejects.toThrow(/UNAUTHENTICATED/)
      expect(http.requests).toHaveLength(before)
      await payload.update({
        id: userId,
        collection: 'users',
        data: { status: 'active' } as never,
        overrideAccess: true,
      })
      http.observe(async () => {
        expect(Object.keys(adapter.sessions)).toHaveLength(0)
        await adapter.client.execute({
          args: ['disabled', userId],
          sql: 'UPDATE users SET status = ? WHERE id = ?',
        })
      })
      await expect(service.readForUser({ mediaId: uploaded.id, userId })).rejects.toThrow(
        /UNAUTHENTICATED/,
      )
      http.observe(() => {
        expect(Object.keys(adapter.sessions)).toHaveLength(0)
      })
      const facts = await storage.putImmutable({
        bytes: await bytes(),
        contentType: 'image/png',
        ref: {
          backend: 'fixture',
          bucket: 'owned-bucket',
          key: `references/1/${randomUUID()}/${'b'.repeat(64)}`,
        },
      })
      const official = await run({
        resource: 'task:official',
        work: ({ req }) =>
          register({
            actor: 'system:catalog',
            facts,
            now,
            originalName: 'official.png',
            owner: null,
            purpose: 'example',
            req,
            visibility: 'official_public',
          }),
      })
      expect((await service.readOfficialExample({ mediaId: official.id })).bytes).toEqual(
        await bytes(),
      )
      const runtime = createCreationRuntime({ gate, payload })
      await run({
        resource: 'media:official',
        work: ({ req }) =>
          runtime.update({
            id: official.id,
            collection: 'media',
            data: { lifecycle: 'pendingDelete', updatedAt: now, updatedBy: 'system:test' },
            req,
          }),
      })
      const requestCount = http.requests.length
      await expect(service.readOfficialExample({ mediaId: official.id })).rejects.toThrow(
        /NOT_FOUND/,
      )
      expect(http.requests).toHaveLength(requestCount)
    })
    test('registers authenticated storage evidence in an existing UOW, replays exactly and rejects cross-owner, deleted and duplicate rows', async ({
      payload,
    }) => {
      const { adapter, register, run, storage, userId } = await setup({ payload })
      const ref = {
        backend: 'fixture',
        bucket: 'owned-bucket',
        key: `references/${userId}/${randomUUID()}/${'a'.repeat(64)}`,
      }
      const facts = await storage.putImmutable({
        bytes: await bytes(),
        contentType: 'image/png',
        ref,
      })
      const args = {
        actor: `user:${userId}`,
        facts,
        now,
        originalName: 'original.png',
        owner: userId,
        purpose: 'reference' as const,
        visibility: 'private' as const,
      }
      const insert = () =>
        run({ resource: 'task:fixture', work: ({ req }) => register({ req, ...args }) })
      const first = await insert()
      expect(await insert()).toEqual(first)
      await expect(
        run({
          resource: 'task:fixture',
          work: ({ req }) => register({ req, ...args, owner: userId + 1 }),
        }),
      ).rejects.toThrow(/CONFLICT/)
      await expect(
        run({
          resource: 'task:fixture',
          work: ({ req }) => register({ req, ...args, facts: { ...facts } }),
        }),
      ).rejects.toThrow(/CONTENT_CONFLICT/)
      await adapter.client.execute(
        "UPDATE media SET is_deleted=1, deleted_at='2026-11-12T12:00:00.000Z', deleted_by='system:test'",
      )
      await expect(insert()).rejects.toThrow(/CONFLICT/)
      await adapter.client.execute(
        'UPDATE media SET is_deleted=0, deleted_at=NULL, deleted_by=NULL',
      )
      const columns = (await adapter.client.execute("PRAGMA table_info('media')")).rows
        .map((row) => String(row.name))
        .filter((name) => name !== 'id')
      await adapter.client.execute(
        `INSERT INTO media (${columns.join(',')}) SELECT ${columns.join(',')} FROM media`,
      )
      await expect(insert()).rejects.toThrow(/CONFLICT/)
    })
    test('host T2 registers already-accepted artifact evidence for a subsequently disabled owner, while new upload and byte reads stay gated', async ({
      payload,
    }) => {
      const { adapter, register, run, service, storage, userId } = await setup({ payload })
      const output = await bytes()
      const { createHash } = await import('node:crypto')
      const sha256 = createHash('sha256').update(output).digest('hex')
      const facts = await storage.putImmutable({
        bytes: output,
        contentType: 'image/png',
        ref: {
          backend: 'fixture',
          bucket: 'owned-bucket',
          key: `tasks/8/attempts/2/result-${sha256}`,
        },
      })
      await payload.update({
        id: userId,
        collection: 'users',
        data: { status: 'disabled' } as never,
        overrideAccess: true,
      })
      const registerAccepted = () =>
        run({
          resource: `task:8`,
          work: ({ req }) =>
            register({
              actor: 'system:worker',
              facts,
              now,
              originalName: 'generated.png',
              owner: userId,
              purpose: 'artifact',
              req,
              visibility: 'private',
            }),
        })
      const result = await registerAccepted()
      expect(await registerAccepted()).toEqual(result)
      expect((await adapter.client.execute('SELECT purpose, owner FROM media')).rows).toEqual([
        { owner: userId, purpose: 'artifact' },
      ])
      await expect(
        service.uploadForUser({ input: output, originalName: 'new.png', userId }),
      ).rejects.toThrow(/UNAUTHENTICATED/)
      await expect(service.readForUser({ mediaId: result.id, userId })).rejects.toThrow(
        /UNAUTHENTICATED/,
      )
    })
    test('rejects identity mutation even through gated native updates; lifecycle alone remains mutable', async ({
      payload,
    }) => {
      const { run, service, userId } = await setup({ payload })
      const media = await service.uploadForUser({
        input: await bytes(),
        originalName: 'test.png',
        userId,
      })
      const runtime = createCreationRuntime({ gate, payload })
      for (const data of [
        { owner: userId + 1 },
        { purpose: 'artifact' },
        { visibility: 'official_public' },
        { storageBackend: 'else' },
        { storageBucket: 'else' },
        { storageName: 'else' },
        { filename: 'else' },
        { originalName: 'else' },
        { sha256: 'b'.repeat(64) },
        { mimeType: 'image/jpeg' },
        { filesize: 1 },
        { width: 5 },
        { height: 5 },
      ]) {
        await expect(
          run({
            resource: 'media:test',
            work: ({ req }) =>
              runtime.update({
                id: media.id,
                collection: 'media',
                data: { ...data, updatedAt: now, updatedBy: 'system:test' },
                req,
              }),
          }),
        ).rejects.toThrow(/immutable/)
      }
      await run({
        resource: 'media:test',
        work: ({ req }) =>
          runtime.update({
            id: media.id,
            collection: 'media',
            data: { lifecycle: 'pendingDelete', updatedAt: now, updatedBy: 'system:test' },
            req,
          }),
      })
      await expect(service.readForUser({ mediaId: media.id, userId })).rejects.toThrow(/NOT_FOUND/)
    })
    test('DB registration failure leaves byte evidence intact; commit ACK loss is checked read-only without a second insert', async ({
      payload,
    }) => {
      const { adapter, http, service, userId } = await setup({ payload })
      await adapter.client.execute(
        "CREATE TRIGGER media_fail AFTER INSERT ON media BEGIN SELECT RAISE(ABORT, 'registration-half-write'); END",
      )
      await expect(
        service.uploadForUser({ input: await bytes(), originalName: 'test.png', userId }),
      ).rejects.toThrow()
      expect((await adapter.client.execute('SELECT * FROM media')).rows).toHaveLength(0)
      expect([...http.objects.keys()].filter((key) => key.startsWith('references/'))).toHaveLength(
        1,
      )
      await adapter.client.execute('DROP TRIGGER media_fail')
      const original = adapter.client.transaction.bind(adapter.client)
      let committed = false
      http.observe(() => {
        expect(Object.keys(adapter.sessions)).toHaveLength(0)
        if (committed) {
          return
        }
        vi.spyOn(adapter.client, 'transaction').mockImplementation(async () => {
          const tx = await original('deferred')
          return new Proxy(tx, {
            get(target, property) {
              if (property === 'commit') {
                return async () => {
                  await target.commit()
                  if (!committed) {
                    committed = true
                    throw new Error('lost commit acknowledgement')
                  }
                }
              }
              const value: unknown = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        })
      })
      const registered = await service.uploadForUser({
        input: await bytes(),
        originalName: 'test.png',
        userId,
      })
      expect(registered.id).toBeGreaterThan(0)
      expect((await adapter.client.execute('SELECT * FROM media')).rows).toHaveLength(1)
    })
  },
)

async function setup({ payload }: { payload: Payload }) {
  const http = await startS3HTTPFixture()
  close.push(http.close)
  const storage = createS3ObjectStorage({
    backends: [
      {
        backend: 'fixture',
        buckets: ['owned-bucket'],
        credentials: http.credentials,
        endpoint: http.endpoint,
        forcePathStyle: true,
        region: 'fixture',
      },
    ],
    image: imageLimits,
    limits: {
      connectionTimeoutMs: 100,
      maxBytes: 100_000,
      operationTimeoutMs: 2000,
      requestTimeoutMs: 500,
    },
  })
  close.push(async () => storage.close())
  await storage.verifyBackend({ backend: 'fixture', bucket: 'owned-bucket' })
  const adapter = getCreationSQLiteAdapter({ payload })
  let isCoordinating = false
  const options = {
    coordinate: async <T>({
      work,
    }: {
      resource: string
      work: (args: { assertLease: () => void }) => Promise<T>
    }) => {
      expect(isCoordinating).toBe(false)
      isCoordinating = true
      try {
        return await work({ assertLease: () => {} })
      } finally {
        isCoordinating = false
      }
    },
    gate,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  }
  http.observe(() => {
    expect(Object.keys(adapter.sessions)).toHaveLength(0)
    expect(isCoordinating).toBe(false)
  })
  const run = createSQLiteUnitOfWork(options)
  const register = createPayloadVerifiedMediaRegistration({ gate, payload, storage })
  return {
    adapter,
    http,
    official: createPayloadOfficialMediaUploadService({
      ...options,
      clock: () => now,
      destination: { backend: 'fixture', bucket: 'owned-bucket' },
      imageLimits,
      storage,
    }),
    register,
    run,
    service: createPayloadMediaService({
      ...options,
      clock: () => now,
      destination: { backend: 'fixture', bucket: 'owned-bucket' },
      imageLimits,
      storage,
    }),
    storage,
    userId: await account({ payload }),
  }
}
async function account({ payload }: { payload: Payload }) {
  const user = await payload.create({
    collection: 'users',
    data: { email: `media-${randomUUID()}@local.invalid`, status: 'active' } as never,
    overrideAccess: true,
  })
  return Number(user.id)
}
