import type { Payload, PayloadRequest } from 'payload'

import { REST_GET, REST_POST } from '@payloadcms/next/routes'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createMediaEndpoints } from '../../src/creation/http/media-endpoints.js'
import { requireNativeAdmin } from '../../src/creation/http/native-admin-auth.js'
import { wrapProductREST } from '../../src/creation/http/rest-route.js'
import { createPayloadVerifiedMediaRegistration } from '../../src/creation/infrastructure/payload/media-repository.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createS3ObjectStorage } from '../../src/creation/infrastructure/s3/object-storage.js'
import { buildCorePayloadConfig } from '../../src/creation/runtime/payload-config.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'
import { cleanupRuntime, config, gate, http, redis, state } from './runtime.config.js'
import { controlledWrite, now, seedIdentity } from './runtime-seed.js'

type MediaDTO = { filesize: number; height: number; id: number; mimeType: string; width: number }
type Envelope<T> = {
  data: T
  error: { code: string; message: string; retryable: boolean }
  requestId: string
}

// Native route functions and real loopback S3, not an actual Next server or upstream AI.
test.suite('Heymoro Native media HTTP', { config: './runtime.config.ts', cron: false }, () => {
  test.afterAll(cleanupRuntime)
  test.beforeEach(reset)
  test.afterEach(() => {
    vi.restoreAllMocks()
    reset()
  })

  test('should upload original official image using actual Native login Cookie and publicly read only safe bytes', async ({
    payload,
    restClient,
  }) => {
    const admin = await officialAdmin({ payload })
    const response = await restClient.POST('/admins/login', {
      auth: false,
      body: JSON.stringify({ email: admin.email, password: 'fixture-official-password-137' }),
      headers: { origin: new URL(config.publicApiUrl).origin },
    })
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    expect(cookie).toMatch(/^payload-token=/)
    const headers = { cookie, origin: new URL(config.publicApiUrl).origin }
    expect(await requireNativeAdmin({ headers: new Headers(headers), payload })).toMatchObject({
      id: admin.id,
      role: 'admin',
    })
    const adapter = getCreationSQLiteAdapter({ payload })
    const before = http.requests.length
    http.observe(async () => {
      expect(Object.keys(adapter.sessions)).toHaveLength(0)
      expect(await redis.client.keys(`${config.redis.namespace}:*`)).toEqual([])
    })
    const bytes = await png()
    const upload = await restClient.POST('/v1/admin/media/examples', {
      auth: false,
      body: form({ bytes }),
      headers,
    })
    expect(upload.status).toBe(201)
    const result = await envelope<MediaDTO>({ response: upload })
    expect(Object.keys(result.data).sort()).toEqual([
      'filesize',
      'height',
      'id',
      'mimeType',
      'width',
    ])
    const row = (await adapter.client.execute('SELECT * FROM media')).rows[0]!
    expect(row).toMatchObject({
      created_by: `admin:${admin.id}`,
      owner: null,
      purpose: 'example',
      visibility: 'official_public',
    })
    expect(row.storage_name).toMatch(/^official\/examples\/[a-f0-9-]{36}\/[a-f0-9]{64}$/)
    expect(
      http.requests
        .slice(before)
        .filter(({ key, method }) => key.startsWith('official/') && method === 'PUT'),
    ).toHaveLength(1)
    expect(
      http.requests
        .slice(before)
        .filter(({ key, method }) => key.startsWith('official/') && method === 'GET'),
    ).toHaveLength(1)
    expect(http.objects.get(row.storage_name as string)!.bytes).toEqual(bytes)
    await binary({
      bytes,
      response: await restClient.GET(`/v1/media/examples/${result.data.id}/content`, {
        auth: false,
      }),
    })
    expect(JSON.stringify(result)).not.toMatch(
      /bucket|backend|sha256|storage|official\/|payload-token/,
    )
  })
  test('should retain Native CSRF cookie rules and reject Authorization, unknown role, inactive account and access denial before bytes', async ({
    payload,
    restClient,
  }) => {
    const admin = await officialAdmin({ payload })
    const login = await restClient.POST('/admins/login', {
      auth: false,
      body: JSON.stringify({ email: admin.email, password: 'fixture-official-password-137' }),
    })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const origin = new URL(config.publicApiUrl).origin
    const baseline = http.requests.length
    for (const headers of [
      {},
      { cookie },
      { cookie, origin: 'null' },
      { cookie, host: new URL(origin).host, origin: 'https://evil.invalid' },
      { cookie, origin: origin + '.evil.invalid' },
      { cookie, 'sec-fetch-site': 'cross-site' },
    ] as Record<string, string>[]) {
      const response = await restClient.POST('/v1/admin/media/examples', {
        auth: false,
        body: form({ bytes: await png() }),
        headers,
      })
      await failure({ code: 'ADMIN_UNAUTHORIZED', response, status: 401 })
    }
    for (const value of ['Bearer opaque', 'JWT irrelevant']) {
      await failure({
        code: 'ADMIN_FORBIDDEN',
        response: await restClient.POST('/v1/admin/media/examples', {
          auth: false,
          body: form({ bytes: await png() }),
          headers: { authorization: value, cookie, origin },
        }),
        status: 403,
      })
    }
    expect(http.requests).toHaveLength(baseline)
    for (const site of ['same-origin', 'same-site', 'none']) {
      expect(
        await requireNativeAdmin({
          headers: new Headers({ cookie, 'sec-fetch-site': site }),
          payload,
        }),
      ).toMatchObject({ id: admin.id })
    }
    await getCreationSQLiteAdapter({ payload }).client.execute({
      args: [admin.id],
      sql: "UPDATE admins SET role = 'operator' WHERE id = ?",
    })
    expect(
      await requireNativeAdmin({ headers: new Headers({ cookie, origin }), payload }),
    ).toMatchObject({ role: 'operator' })
    await getCreationSQLiteAdapter({ payload }).client.execute({
      args: [admin.id],
      sql: "UPDATE admins SET role = 'unknown' WHERE id = ?",
    })
    await expect(
      requireNativeAdmin({ headers: new Headers({ cookie, origin }), payload }),
    ).rejects.toMatchObject({ code: 'ADMIN_FORBIDDEN' })
    await getCreationSQLiteAdapter({ payload }).client.execute({
      args: [admin.id],
      sql: "UPDATE admins SET role = 'operator', status = 'disabled' WHERE id = ?",
    })
    await expect(
      requireNativeAdmin({ headers: new Headers({ cookie, origin }), payload }),
    ).rejects.toMatchObject({ code: 'ADMIN_FORBIDDEN' })
    expect(http.requests).toHaveLength(baseline)
  })
  test('should reject malformed authenticated official uploads without accepting client identity or JSON', async ({
    payload,
    restClient,
  }) => {
    const admin = await officialAdmin({ payload })
    const login = await restClient.POST('/admins/login', {
      auth: false,
      body: JSON.stringify({ email: admin.email, password: 'fixture-official-password-137' }),
    })
    const headers = {
      cookie: login.headers.get('set-cookie')!.split(';')[0]!,
      origin: new URL(config.publicApiUrl).origin,
    }
    const baseline = http.requests.length
    const image = await png()
    for (const field of ['adminId', 'actor', 'ref', 'owner', '_payload']) {
      const body = form({ bytes: image })
      body.append(field, 'forged')
      await failure({
        code: 'INPUT_INVALID',
        response: await restClient.POST('/v1/admin/media/examples', { auth: false, body, headers }),
        status: 400,
      })
    }
    const duplicate = form({ bytes: image })
    duplicate.append(
      'file',
      new File([image as Uint8Array<ArrayBuffer>], 'second.png', { type: 'image/png' }),
    )
    await failure({
      code: 'INPUT_INVALID',
      response: await restClient.POST('/v1/admin/media/examples', {
        auth: false,
        body: duplicate,
        headers,
      }),
      status: 400,
    })
    await failure({
      code: 'HTTP_UNSUPPORTED_MEDIA_TYPE',
      response: await restClient.POST('/v1/admin/media/examples', {
        auth: false,
        body: JSON.stringify({ adminId: admin.id }),
        headers,
      }),
      status: 415,
    })
    await failure({
      code: 'INPUT_INVALID',
      response: await restClient.POST('/v1/admin/media/examples?adminId=1', {
        auth: false,
        body: form({ bytes: image }),
        headers,
      }),
      status: 400,
    })
    await failure({
      code: 'HTTP_BODY_TOO_LARGE',
      response: await restClient.POST('/v1/admin/media/examples', {
        auth: false,
        body: form({ bytes: new Uint8Array(100001) }),
        headers,
      }),
      status: 413,
    })
    for (const body of [
      form({ bytes: new Uint8Array([1]) }),
      form({ bytes: image, mimeType: 'image/jpeg' }),
    ]) {
      await failure({
        code: 'INVALID_MEDIA',
        response: await restClient.POST('/v1/admin/media/examples', { auth: false, body, headers }),
        status: 400,
      })
    }
    expect(http.requests).toHaveLength(baseline)
  })
  test('should configure trusted browser Origin separately from publicApiUrl pathname', async ({
    payload,
  }) => {
    const built = await buildCorePayloadConfig({
      config: { ...config, publicApiUrl: config.publicApiUrl + '/trusted/path' },
    })
    expect(built.csrf).toContain(new URL(config.publicApiUrl).origin)
    expect(built.csrf).toContain(config.publicApiUrl + '/trusted/path')
    const admin = await officialAdmin({ payload })
    const login = await payload.login({
      collection: 'admins',
      data: { email: admin.email, password: 'fixture-official-password-137' },
    })
    const previous = payload.config.csrf
    payload.config.csrf = built.csrf
    try {
      expect(
        await requireNativeAdmin({
          headers: new Headers({
            cookie: `payload-token=${login.token}`,
            origin: new URL(config.publicApiUrl).origin,
          }),
          payload,
        }),
      ).toMatchObject({ id: admin.id })
      await expect(
        requireNativeAdmin({
          headers: new Headers({
            cookie: `payload-token=${login.token}`,
            origin: 'https://untrusted.invalid',
          }),
          payload,
        }),
      ).rejects.toMatchObject({ code: 'ADMIN_UNAUTHORIZED' })
    } finally {
      payload.config.csrf = previous
    }
  })

  test('should let active Native operator upload above reference budget, independently of reference caps', async ({
    payload,
    restClient,
  }) => {
    const admin = await officialAdmin({ payload })
    await getCreationSQLiteAdapter({ payload }).client.execute({
      args: [admin.id],
      sql: "UPDATE admins SET role = 'operator' WHERE id = ?",
    })
    const login = await restClient.POST('/admins/login', {
      auth: false,
      body: JSON.stringify({ email: admin.email, password: 'fixture-official-password-137' }),
    })
    const headers = {
      cookie: login.headers.get('set-cookie')!.split(';')[0]!,
      origin: new URL(config.publicApiUrl).origin,
    }
    const raw = Buffer.alloc(96 * 96 * 3)
    let seed = 137
    for (let i = 0; i < raw.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      raw[i] = seed >>> 24
    }
    const bytes = await sharp(raw, { raw: { channels: 3, height: 96, width: 96 } })
      .png()
      .toBuffer()
    expect(bytes.length).toBeGreaterThan(config.hostCaps.maxImageBytes)
    expect(bytes.length).toBeLessThan(config.imageLimits.maxBytes)
    const upload = await restClient.POST('/v1/admin/media/examples', {
      auth: false,
      body: form({ bytes }),
      headers,
    })
    expect(upload.status).toBe(201)
    expect((await envelope<MediaDTO>({ response: upload })).data).toMatchObject({
      filesize: bytes.length,
      height: 96,
      width: 96,
    })
    const caps = await buildCorePayloadConfig({
      config: { ...config, hostCaps: { ...config.hostCaps, maxImages: 0 } },
    })
    expect(caps.endpoints.filter(({ path }) => path === '/v1/admin/media/examples')).toHaveLength(1)
    const access = payload.collections.admins.config.access.admin
    payload.collections.admins.config.access.admin = () => false
    try {
      await expect(
        requireNativeAdmin({ headers: new Headers(headers), payload }),
      ).rejects.toMatchObject({ code: 'ADMIN_FORBIDDEN' })
    } finally {
      payload.collections.admins.config.access.admin = access
    }
  })
  for (const change of ['disabled', 'unknown-role']) {
    test(`should recheck official admin ${change} after real S3 outside Redis and SQLite locks`, async ({
      payload,
      restClient,
    }) => {
      const admin = await officialAdmin({ payload })
      const login = await restClient.POST('/admins/login', {
        auth: false,
        body: JSON.stringify({ email: admin.email, password: 'fixture-official-password-137' }),
      })
      const headers = {
        cookie: login.headers.get('set-cookie')!.split(';')[0]!,
        origin: new URL(config.publicApiUrl).origin,
      }
      const adapter = getCreationSQLiteAdapter({ payload })
      let changed = false
      const before = http.requests.length
      http.observe(async () => {
        expect(Object.keys(adapter.sessions)).toHaveLength(0)
        expect(await redis.client.keys(`${config.redis.namespace}:*`)).toEqual([])
        if (!changed) {
          changed = true
          await adapter.client.execute({
            args: [admin.id],
            sql:
              change === 'disabled'
                ? "UPDATE admins SET status = 'disabled' WHERE id = ?"
                : "UPDATE admins SET role = 'unknown' WHERE id = ?",
          })
        }
      })
      const response = await restClient.POST('/v1/admin/media/examples', {
        auth: false,
        body: form({ bytes: await png() }),
        headers,
      })
      await failure({
        code: change === 'disabled' ? 'ADMIN_FORBIDDEN' : 'ADMIN_DATA_INTEGRITY',
        response,
        status: change === 'disabled' ? 403 : 503,
      })
      expect((await adapter.client.execute('SELECT * FROM media')).rows).toHaveLength(0)
      const requests = http.requests.slice(before).filter(({ key }) => key.startsWith('official/'))
      expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(1)
      expect(requests.filter(({ method }) => method === 'DELETE')).toHaveLength(0)
      expect(http.objects.has(requests[0]!.key)).toBe(true)
    })
  }

  test('should authenticate a true FormData upload, decode persist and return only five fields and original image bytes', async ({
    payload,
    restClient,
  }) => {
    const login = await getCoreRuntime({ payload }).identity.login({
      input: { code: 'media-owner' },
    })
    const headers = { authorization: `Bearer ${login.token}` }
    const bytes = await png()
    const response = await restClient.POST('/v1/media', {
      auth: false,
      body: form({ bytes }),
      headers,
    })
    expect(response.status).toBe(201)
    const upload = (await envelope<MediaDTO>({ response })).data
    expect(Object.keys(upload).sort()).toEqual(['filesize', 'height', 'id', 'mimeType', 'width'])
    expect(upload).toEqual({
      id: expect.any(Number),
      filesize: bytes.length,
      height: 2,
      mimeType: 'image/png',
      width: 3,
    })
    const row = (await getCreationSQLiteAdapter({ payload }).client.execute('SELECT * FROM media'))
      .rows[0]!
    expect(row).toMatchObject({
      lifecycle: 'active',
      owner: login.user.id,
      purpose: 'reference',
      visibility: 'private',
    })
    expect(row.storage_name as string).toMatch(new RegExp(`^references/${login.user.id}/`))
    expect(row.storage_name as string).not.toContain('image.png')
    expect(http.requests.some(({ method }) => method === 'PUT')).toBe(true)
    expect(http.requests.some(({ method }) => method === 'GET')).toBe(true)
    const read = await restClient.GET(`/v1/media/${upload.id}/content`, { auth: false, headers })
    await binary({ bytes, response: read })
    expect(
      (await restClient.GET(`/v1/media/examples/${upload.id}/content`, { auth: false })).status,
    ).toBe(404)
    const other = await seedIdentity({ gate, payload })
    const forbidden = await restClient.GET(`/v1/media/${upload.id}/content`, {
      auth: false,
      headers: { authorization: `Bearer ${other.token}` },
    })
    await failure({ code: 'NOT_FOUND', response: forbidden, status: 404 })
    expect((await restClient.GET(`/v1/media/${upload.id}/content`, { auth: false })).status).toBe(
      401,
    )
    await expect(
      payload.create({ collection: 'media', data: {} as never, overrideAccess: true }),
    ).rejects.toThrow(/capability/)
    await expect(
      payload.update({
        id: upload.id,
        collection: 'media',
        data: { lifecycle: 'deleted' } as never,
        overrideAccess: true,
      }),
    ).rejects.toThrow(/capability/)
  })

  test('should stream an explicitly registered official example publicly and never expose its locator', async ({
    payload,
    restClient,
  }) => {
    const bytes = await png()
    const storage = createS3ObjectStorage({
      backends: config.s3.backends,
      image: config.imageLimits,
      limits: config.s3.limits,
    })
    try {
      await storage.verifyBackend(config.s3.input)
      const facts = await storage.putImmutable({
        bytes,
        contentType: 'image/png',
        ref: {
          ...config.s3.input,
          key: `references/1/${randomUUID()}/${createHash('sha256').update(bytes).digest('hex')}`,
        },
      })
      const register = createPayloadVerifiedMediaRegistration({ gate, payload, storage })
      const media = await controlledWrite({
        gate,
        payload,
        work: ({ req }) =>
          register({
            actor: 'system:runtime-fixture',
            facts,
            now,
            originalName: 'example.png',
            owner: null,
            purpose: 'example',
            req,
            visibility: 'official_public',
          }),
      })
      const response = await restClient.GET(`/v1/media/examples/${media.id}/content`, {
        auth: false,
      })
      await binary({ bytes, response })
      expect(JSON.stringify([...response.headers])).not.toMatch(
        /fixture-input|official\/|backend|bucket/,
      )
      await getCreationSQLiteAdapter({ payload }).client.execute({
        args: [media.id],
        sql: "UPDATE media SET visibility = 'private' WHERE id = ?",
      })
      await failure({
        code: 'NOT_FOUND',
        response: await restClient.GET(`/v1/media/examples/${media.id}/content`, { auth: false }),
        status: 404,
      })
    } finally {
      storage.close()
    }
  })

  test('should reject malformed multipart, unsafe original names and actual over-budget files before S3 or business writes', async ({
    payload,
    restClient,
  }) => {
    const user = await seedIdentity({ gate, payload })
    const authorization = `Bearer ${user.token}`
    const bytes = await png()
    const creates = vi.spyOn(payload, 'create')
    const updates = vi.spyOn(payload, 'update')
    const before = http.requests.length
    for (const body of [
      form({ name: 'owner', bytes }),
      form({ bytes, filename: '../../name.png' }),
      form({ bytes, filename: 'x'.repeat(256) }),
      form({ bytes: new TextEncoder().encode('<svg/>') }),
      form({ bytes: bytes.subarray(0, 40) }),
      form({ bytes, mimeType: 'image/jpeg' }),
      form({ bytes: new Uint8Array(config.hostCaps.maxImageBytes + 1) }),
    ]) {
      const response = await restClient.POST('/v1/media', {
        auth: false,
        body,
        headers: { authorization },
      })
      expect([400, 413]).toContain(response.status)
      await envelope({ response })
    }
    const duplicate = form({ bytes })
    duplicate.append('file', new File([bytes], 'other.png', { type: 'image/png' }))
    const fields = form({ bytes })
    fields.append('_payload', '{"owner":999}')
    for (const body of [duplicate, fields]) {
      await failure({
        code: 'INPUT_INVALID',
        response: await restClient.POST('/v1/media', {
          auth: false,
          body,
          headers: { authorization },
        }),
        status: 400,
      })
    }
    for (const [contentType, body, status] of [
      ['application/json', '{}', 415],
      ['multipart/form-data', '--X--', 400],
      ['multipart/form-data; boundary=X; boundary=X', '--X--', 400],
      ['multipart/form-data; boundary=X; owner=1', '--X--', 400],
      [
        'multipart/form-data; boundary=X',
        '--X\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n\r\nx',
        400,
      ],
    ] as const) {
      const response = await native({
        authorization,
        body,
        contentType,
        method: 'post',
        path: '/v1/media',
        payload,
      })
      expect(response.status).toBe(status)
    }
    expect(creates).not.toHaveBeenCalled()
    expect(updates).not.toHaveBeenCalled()
    expect(http.requests).toHaveLength(before)
  })

  test('should reject raw query aliases, noncanonical IDs and GET bodies without trusting request data', async ({
    payload,
    restClient,
  }) => {
    const user = await seedIdentity({ gate, payload })
    const authorization = `Bearer ${user.token}`
    const response = await restClient.POST('/v1/media', {
      auth: false,
      body: form({ bytes: await png() }),
      headers: { authorization },
    })
    const media = (await envelope<MediaDTO>({ response })).data
    const before = http.requests.length
    for (const path of [
      `/v1/media/${media.id}/content?`,
      `/v1/media/${media.id}/content?owner=1`,
      '/v1/media/01/content',
      '/v1/media/9007199254740992/content',
      `/v1/media/examples/${media.id}/content?x=1`,
    ]) {
      await failure({
        code: 'INPUT_INVALID',
        response: await native({ authorization, method: 'get', path, payload }),
        status: 400,
      })
    }
    await failure({
      code: 'INPUT_INVALID',
      response: await native({
        authorization,
        body: form({ bytes: await png() }),
        method: 'post',
        path: '/v1/media?%6fwner=1',
        payload,
      }),
      status: 400,
    })
    const endpoint = payload.config.endpoints.find(
      ({ method, path }) => method === 'get' && path === '/v1/media/:mediaId/content',
    )!
    const request = new Request('http://fixture/v1/media/1/content', {
      body: 'x',
      headers: { authorization },
      method: 'POST',
    })
    const direct = Object.assign(request, {
      data: { owner: 999 },
      payload,
      routeParams: { mediaId: String(media.id) },
      user: { id: 999 },
    }) as unknown as PayloadRequest
    await failure({ code: 'INPUT_INVALID', response: await endpoint.handler(direct), status: 400 })
    expect(http.requests).toHaveLength(before)
  })

  for (const change of ['disable', 'tombstone', 'private', 'logout', 'expiry'] as const) {
    test(`should recheck ${change} during real S3 GET outside snapshots and leases`, async ({
      payload,
      restClient,
    }) => {
      const user = await seedIdentity({ gate, payload })
      const authorization = `Bearer ${user.token}`
      const upload = await restClient.POST('/v1/media', {
        auth: false,
        body: form({ bytes: await png() }),
        headers: { authorization },
      })
      const media = (await envelope<MediaDTO>({ response: upload })).data
      const client = getCreationSQLiteAdapter({ payload }).client
      const fundingBefore = await client.execute('SELECT * FROM credit_ledger')
      const tasksBefore = await client.execute('SELECT * FROM generation_tasks')
      let checked = false
      http.observe(async () => {
        if (checked) {
          return
        }
        checked = true
        expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
        expect(await redis.client.keys(`${config.redis.namespace}:*`)).toEqual([])
        if (change === 'disable') {
          await client.execute({
            args: [user.userId],
            sql: "UPDATE users SET status = 'disabled' WHERE id = ?",
          })
        }
        if (change === 'tombstone') {
          await client.execute({
            args: [media.id],
            sql: 'UPDATE media SET is_deleted = 1 WHERE id = ?',
          })
        }
        if (change === 'private') {
          await client.execute({
            args: [media.id],
            sql: "UPDATE media SET visibility = 'official_public' WHERE id = ?",
          })
        }
        if (change === 'logout') {
          await getCoreRuntime({ payload }).identity.logout({ authorization })
        }
        if (change === 'expiry') {
          state.now = '2026-11-13T12:00:00.000Z'
        }
      })
      const response = await restClient.GET(`/v1/media/${media.id}/content`, {
        auth: false,
        headers: { authorization },
      })
      await failure({
        code: ['disable', 'expiry', 'logout'].includes(change) ? 'UNAUTHENTICATED' : 'NOT_FOUND',
        response,
        status: ['disable', 'expiry', 'logout'].includes(change) ? 401 : 404,
      })
      expect(checked).toBe(true)
      expect((await client.execute('SELECT * FROM credit_ledger')).rows).toEqual(fundingBefore.rows)
      expect((await client.execute('SELECT * FROM generation_tasks')).rows).toEqual(
        tasksBefore.rows,
      )
    })
  }

  test('should map forbidden/missing/conflicting S3 reads to neutral JSON without writes or charging', async ({
    payload,
    restClient,
  }) => {
    const user = await seedIdentity({ gate, payload })
    const headers = { authorization: `Bearer ${user.token}` }
    const response = await restClient.POST('/v1/media', {
      auth: false,
      body: form({ bytes: await png() }),
      headers,
    })
    const media = (await envelope<MediaDTO>({ response })).data
    const creates = vi.spyOn(payload, 'create')
    const updates = vi.spyOn(payload, 'update')
    http.setFault('forbidden')
    await failure({
      code: 'MEDIA_STORAGE_UNAVAILABLE',
      response: await restClient.GET(`/v1/media/${media.id}/content`, { auth: false, headers }),
      status: 503,
    })
    http.setFault('none')
    const key = (
      await getCreationSQLiteAdapter({ payload }).client.execute({
        args: [media.id],
        sql: 'SELECT storage_name FROM media WHERE id = ?',
      })
    ).rows[0]!.storage_name as string
    const object = http.objects.get(key)!
    http.objects.delete(key)
    await failure({
      code: 'NOT_FOUND',
      response: await restClient.GET(`/v1/media/${media.id}/content`, { auth: false, headers }),
      status: 404,
    })
    http.objects.set(key, {
      ...object,
      type: 'image/png',
      bytes: await sharp({ create: { background: 'red', channels: 3, height: 2, width: 3 } })
        .png()
        .toBuffer(),
    })
    await failure({
      code: 'DATA_INTEGRITY_CONFLICT',
      response: await restClient.GET(`/v1/media/${media.id}/content`, { auth: false, headers }),
      status: 503,
    })
    expect(creates).not.toHaveBeenCalled()
    expect(updates).not.toHaveBeenCalled()
  })

  test('should authenticate disabled upload capability before zero body consumption', async ({
    payload,
  }) => {
    const user = await seedIdentity({ gate, payload })
    const endpoint = createMediaEndpoints({ canUploadReferences: false, fileMaxBytes: 1000 })[0]!
    for (const isAuthenticated of [false, true]) {
      let reads = 0
      const req = {
        get body() {
          reads++
          throw new Error('zero consumption')
        },
        headers: new Headers(isAuthenticated ? { authorization: `Bearer ${user.token}` } : {}),
        payload,
        url: 'http://fixture/v1/media',
      } as unknown as PayloadRequest
      const response = await endpoint.handler(req)
      await failure({
        code: isAuthenticated ? 'INPUT_INVALID' : 'UNAUTHENTICATED',
        response,
        status: isAuthenticated ? 400 : 401,
      })
      expect(reads).toBe(0)
    }
  })
})
function reset() {
  state.now = now
  state.kind = 'output'
  state.redisDown = false
  state.beforeWechat = null
  state.wechatResult = { openId: 'media-http-owner', unionId: null }
  http.setFault('none')
  http.setConflict(412)
  http.observe(() => {})
}
function png() {
  return sharp({ create: { background: 'green', channels: 3, height: 2, width: 3 } })
    .png()
    .toBuffer()
}
function form({
  name = 'file',
  bytes,
  filename = 'image.png',
  mimeType = 'image/png',
}: {
  bytes: Uint8Array
  filename?: string
  mimeType?: string
  name?: string
}) {
  const result = new FormData()
  result.append(name, new File([bytes as Uint8Array<ArrayBuffer>], filename, { type: mimeType }))
  return result
}
async function envelope<T = unknown>({ response }: { response: Response }): Promise<Envelope<T>> {
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/)
  const body = (await response.json()) as Envelope<T>
  expect(body.requestId).toBe(response.headers.get('x-request-id'))
  return body
}
async function failure({
  code,
  response,
  status,
}: {
  code: string
  response: Response
  status: number
}) {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toContain('application/json')
  expect(response.headers.has('content-disposition')).toBe(false)
  expect(response.headers.has('content-length')).toBe(false)
  expect((await envelope({ response })).error).toMatchObject({ code, retryable: false })
}
async function binary({ bytes, response }: { bytes: Uint8Array; response: Response }) {
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/png')
  expect(response.headers.get('content-length')).toBe(String(bytes.byteLength))
  expect(response.headers.get('content-disposition')).toBe('inline; filename="image.png"')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes))
}
function native({
  authorization,
  body,
  contentType,
  method,
  path,
  payload,
}: {
  authorization?: string
  body?: BodyInit
  contentType?: string
  method: 'get' | 'post'
  path: string
  payload: Payload
}) {
  const headers = new Headers(authorization ? { authorization } : {})
  if (contentType) {
    headers.set('content-type', contentType)
  }
  return wrapProductREST({
    handler: method === 'get' ? REST_GET(payload.config) : REST_POST(payload.config),
  })(
    new Request(`${payload.config.serverURL}/api${path}`, {
      body,
      headers,
      method: method.toUpperCase(),
    }),
    {
      params: Promise.resolve({
        slug: path.slice(1).split('?')[0]!.split('/').map(decodeURIComponent),
      }),
    },
  )
}

async function officialAdmin({ payload }: { payload: Payload }) {
  return controlledWrite({
    gate,
    payload,
    work: ({ req }) =>
      gate.run({
        req,
        work: () =>
          payload.create({
            collection: 'admins',
            data: {
              email: `official-${randomUUID()}@local.invalid`,
              password: 'fixture-official-password-137',
              role: 'admin',
              status: 'active',
            },
            overrideAccess: true,
            req,
          }),
      }),
  })
}
