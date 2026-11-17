import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'

import {
  createOfficialMediaUploadService,
  registerVerifiedMedia,
} from '../src/creation/application/media.ts'
import { AdminCommandError } from '../src/creation/domain/admin.ts'
import { requireNativeAdmin } from '../src/creation/http/native-admin-auth.ts'
import { validateImage } from '../src/creation/infrastructure/image/sharp-image-validator.ts'
import { createS3ObjectStorage } from '../src/creation/infrastructure/s3/object-storage.ts'

const limits = {
  allowedMimeTypes: ['image/png'],
  maxBytes: 100000,
  maxPixels: 100000,
  timeoutMs: 1000,
}
const now = '2026-11-12T12:00:00.000Z'
const png = () =>
  sharp({ create: { background: 'blue', channels: 3, height: 2, width: 3 } })
    .png()
    .toBuffer()
const principal = { collection: 'admins', id: 1, role: 'admin', status: 'active' }

function fixture({ mode, initial = principal, current = principal } = {}) {
  const events = []
  const rows = []
  const issued = new WeakSet()
  const unknown = new Error('commit unknown private locator')
  let isLocked = false
  const reader = {
    findByRef: () => {
      events.push('readback')
      if (mode === 'read-fail') throw new Error('private read error')
      return Promise.resolve(
        mode === 'zero'
          ? []
          : mode === 'two'
            ? [rows[0], rows[0]]
            : mode === 'conflict'
              ? [{ ...rows[0], owner: 1 }]
              : rows,
      )
    },
    readAdmin: () => Promise.resolve(initial),
  }
  const storage = {
    assertVerified: ({ facts }) => {
      assert(issued.has(facts))
    },
    putImmutable: ({ bytes, contentType, ref }) => {
      assert.equal(isLocked, false)
      events.push('put')
      assert.match(ref.key, /^official\/examples\/[a-f0-9-]{36}\/[a-f0-9]{64}$/)
      const facts = Object.freeze({
        filesize: bytes.length,
        height: 2,
        mimeType: contentType,
        ref,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        width: 3,
      })
      issued.add(facts)
      return Promise.resolve(facts)
    },
  }
  const service = createOfficialMediaUploadService({
    clock: () => now,
    destination: { backend: 'test', bucket: 'private' },
    imageLimits: limits,
    isCommitUnknown: ({ error }) => error === unknown,
    read: ({ work }) => {
      assert.equal(isLocked, false)
      events.push('snapshot')
      return work({ repository: reader })
    },
    storage,
    validateImage: (args) => {
      assert.equal(isLocked, false)
      events.push('decode')
      return validateImage(args)
    },
    write: async ({ resource, work }) => {
      assert.match(resource, /^media:[a-f0-9]{64}$/)
      isLocked = true
      try {
        const row = await work({
          repository: {
            readAdmin: () => {
              events.push('recheck')
              return Promise.resolve(current)
            },
            register: (args) =>
              registerVerifiedMedia({
                ...args,
                storage,
                repository: {
                  findByRef: () => Promise.resolve([]),
                  insert: ({ actor, facts, identity, originalName }) => {
                    events.push('insert')
                    assert.equal(actor, 'admin:1')
                    assert.deepEqual(identity, {
                      owner: null,
                      purpose: 'example',
                      visibility: 'official_public',
                    })
                    const row = {
                      ...facts,
                      ...identity,
                      id: 17,
                      isDeleted: false,
                      lifecycle: 'active',
                      originalName,
                    }
                    rows.push(row)
                    return Promise.resolve(row)
                  },
                },
              }),
          },
        })
        if (mode) throw unknown
        return row
      } finally {
        isLocked = false
      }
    },
  })
  return { events, rows, service, unknown }
}

test('official uploads decode outside locks, use server identity and return only safe DTO', async () => {
  const f = fixture()
  const input = await png()
  const pending = f.service.upload({ adminId: 1, input, originalName: 'image.png' })
  input.fill(0)
  const result = await pending
  assert.deepEqual(result, {
    id: 17,
    filesize: f.rows[0].filesize,
    height: 2,
    mimeType: 'image/png',
    width: 3,
  })
  assert.deepEqual(f.events, ['snapshot', 'decode', 'put', 'recheck', 'insert'])
})
for (const initial of [
  null,
  { ...principal, role: 'unknown' },
  { ...principal, status: 'disabled' },
  { ...principal, id: 2 },
]) {
  test('official authentication precedes decode and PUT: ' + JSON.stringify(initial), async () => {
    const f = fixture({ initial })
    await assert.rejects(
      f.service.upload({ adminId: 1, input: new Uint8Array([0]), originalName: 'x.png' }),
      { code: 'ADMIN_FORBIDDEN' },
    )
    assert.deepEqual(f.events, ['snapshot'])
  })
}
for (const current of [
  null,
  { ...principal, role: 'unknown' },
  { ...principal, status: 'disabled' },
]) {
  test('T2 rechecks role without repeating network: ' + JSON.stringify(current), async () => {
    const f = fixture({ current })
    await assert.rejects(
      f.service.upload({ adminId: 1, input: await png(), originalName: 'x.png' }),
      { code: 'ADMIN_FORBIDDEN' },
    )
    assert.deepEqual(f.events, ['snapshot', 'decode', 'put', 'recheck'])
    assert.equal(f.rows.length, 0)
  })
}
for (const mode of ['confirmed', 'zero', 'two', 'conflict', 'read-fail']) {
  test('uncertain commit reads once without retries/deletion: ' + mode, async () => {
    const f = fixture({ mode })
    const pending = f.service.upload({ adminId: 1, input: await png(), originalName: 'x.png' })
    if (mode === 'confirmed') assert.equal((await pending).id, 17)
    else await assert.rejects(pending, (error) => error === f.unknown)
    assert.equal(f.events.filter((e) => e === 'readback').length, 1)
    assert.equal(f.events.filter((e) => e === 'put').length, 1)
    assert.equal(f.events.filter((e) => e === 'insert').length, 1)
  })
}
for (const [label, options] of [
  ['bad bytes', { input: new Uint8Array([1]) }],
  ['filename', { originalName: '../x.png' }],
  ['MIME', { declaredMimeType: 'image/jpeg' }],
]) {
  test('official rejects ' + label + ' before PUT', async () => {
    const f = fixture()
    await assert.rejects(
      f.service.upload({ adminId: 1, input: await png(), originalName: 'x.png', ...options }),
      { code: 'INVALID_MEDIA' },
    )
    assert.equal(f.events.includes('put'), false)
  })
}

test('Native auth copies only cookie CSRF headers and disables autologin', async () => {
  const headers = new Headers({
    cookie: 'native=fixture',
    origin: 'https://fixture.invalid',
    'sec-fetch-site': 'same-origin',
    host: 'evil.invalid',
    disableautologin: 'false',
  })
  const payload = {
    auth: ({ headers: received }) => {
      assert.deepEqual(
        [...received],
        [
          ['cookie', 'native=fixture'],
          ['disableautologin', 'true'],
          ['origin', 'https://fixture.invalid'],
          ['sec-fetch-site', 'same-origin'],
        ],
      )
      return Promise.resolve({ permissions: { canAccessAdmin: true }, user: principal })
    },
  }
  assert.equal(
    (await requireNativeAdmin({ headers: { get: headers.get.bind(headers) }, payload })).id,
    1,
  )
  assert.equal(headers.get('disableautologin'), 'false')
})
for (const user of [
  null,
  { ...principal, collection: 'users' },
  { ...principal, id: '1' },
  { ...principal, id: 0 },
  { ...principal, role: 'unknown' },
  { ...principal, status: 'disabled' },
]) {
  test('Native auth rejects principal ' + JSON.stringify(user), async () => {
    await assert.rejects(
      requireNativeAdmin({
        headers: new Headers(),
        payload: { auth: () => Promise.resolve({ permissions: { canAccessAdmin: true }, user }) },
      }),
      { code: user ? 'ADMIN_FORBIDDEN' : 'ADMIN_UNAUTHORIZED' },
    )
  })
}
for (const permissions of [undefined, {}, { canAccessAdmin: false }, { canAccessAdmin: 1 }]) {
  test('Native requires strict access permission ' + JSON.stringify(permissions), async () => {
    await assert.rejects(
      requireNativeAdmin({
        headers: new Headers(),
        payload: { auth: () => Promise.resolve({ permissions, user: principal }) },
      }),
      { code: 'ADMIN_FORBIDDEN' },
    )
  })
}
for (const authorization of ['Bearer opaque', 'JWT fixture', '']) {
  test('Native auth rejects any Authorization without calling auth: ' + authorization, async () => {
    await assert.rejects(
      requireNativeAdmin({
        headers: new Headers({ authorization }),
        payload: {
          auth: () => {
            throw new Error('must not call')
          },
        },
      }),
      { code: 'ADMIN_FORBIDDEN' },
    )
  })
}
test('Native auth preserves infrastructure errors rather than turning them into 403', async () => {
  const error = new Error('private database failure')
  await assert.rejects(
    requireNativeAdmin({ headers: new Headers(), payload: { auth: () => Promise.reject(error) } }),
    (value) => value === error,
  )
  assert.equal(new AdminCommandError({ code: 'ADMIN_FORBIDDEN' }).status, 403)
})

test('S3 resolves only strict official UUID/hash and preserves references/tasks namespaces', async () => {
  const storage = createS3ObjectStorage({
    backends: [
      {
        backend: 'test',
        buckets: ['private'],
        credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
        endpoint: 'http://127.0.0.1:1',
        forcePathStyle: true,
        region: 'local',
      },
    ],
    image: limits,
    limits: {
      connectionTimeoutMs: 50,
      maxBytes: 100000,
      requestTimeoutMs: 100,
      operationTimeoutMs: 1000,
    },
  })
  const bytes = await png()
  const uuid = 'b83dde98-8ea1-4f4f-bb4e-7e489db21da1'
  const hash = createHash('sha256').update(bytes).digest('hex')
  try {
    for (const key of [
      `official/examples/${uuid}/${hash}`,
      `references/1/${uuid}/${hash}`,
      `tasks/1/attempts/1/result-${hash}`,
    ]) {
      await assert.rejects(
        storage.putImmutable({
          bytes,
          contentType: 'image/png',
          ref: { backend: 'test', bucket: 'private', key },
        }),
        { code: 'UNVERIFIED_BACKEND' },
      )
    }
    for (const key of [
      `official/example/${uuid}/${hash}`,
      `official/examples/${hash}`,
      `official/examples/${uuid}/x`,
      `official/examples/${'a'.repeat(36)}/${hash}`,
      `official/examples/../${hash}`,
      `other/${uuid}/${hash}`,
    ]) {
      await assert.rejects(
        storage.putImmutable({
          bytes,
          contentType: 'image/png',
          ref: { backend: 'test', bucket: 'private', key },
        }),
        { code: 'INVALID_REF' },
      )
    }
    await assert.rejects(
      storage.putImmutable({
        bytes,
        contentType: 'image/png',
        ref: { backend: 'test', bucket: 'foreign', key: `official/examples/${uuid}/${hash}` },
      }),
      { code: 'INVALID_REF' },
    )
  } finally {
    storage.close()
  }
})

test('official endpoint authenticates before accessing the binary body and maps only closed admin errors', async () => {
  const { createOfficialMediaEndpoints } =
    await import('../src/creation/http/official-media-endpoints.ts')
  const endpoint = createOfficialMediaEndpoints({ fileMaxBytes: 100000 })[0]
  assert.equal(endpoint.path, '/v1/admin/media/examples')
  assert.equal(endpoint.method, 'post')
  for (const [code, status] of [
    ['ADMIN_UNAUTHORIZED', 401],
    ['ADMIN_FORBIDDEN', 403],
    ['ADMIN_DATA_INTEGRITY', 503],
    ['ADMIN_FAILED', 503],
    ['ADMIN_OUTCOME_UNKNOWN', 503],
    ['ADMIN_INVALID_INPUT', 500],
  ]) {
    const error = new AdminCommandError({ code })
    error.status = 299
    error.message = 'secret-bucket/secret-key cookie=secret'
    const req = {
      headers: new Headers(),
      payload: { auth: () => Promise.reject(error) },
      get body() {
        throw new Error('must not read')
      },
    }
    const response = await endpoint.handler(req)
    assert.equal(response.status, status)
    const value = await response.json()
    assert.equal(value.error.code, status === 500 ? 'INTERNAL_ERROR' : code)
    assert.equal(value.error.retryable, false)
    assert.doesNotMatch(JSON.stringify(value), /secret/)
  }
  const response = await endpoint.handler({
    headers: new Headers(),
    payload: { auth: () => Promise.reject({ code: 'ADMIN_FORBIDDEN', status: 403 }) },
  })
  assert.equal(response.status, 500)
})

test('official endpoint uses its own image budget, rejects invalid budgets and reads no JSON or client identity', async () => {
  const { createOfficialMediaEndpoints } =
    await import('../src/creation/http/official-media-endpoints.ts')
  for (const fileMaxBytes of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => createOfficialMediaEndpoints({ fileMaxBytes }), RangeError)
  const endpoint = createOfficialMediaEndpoints({ fileMaxBytes: 10 })[0]
  const auth = () => Promise.resolve({ permissions: { canAccessAdmin: true }, user: principal })
  const request = ({ body, headers = {}, path = '', method = 'POST' }) =>
    Object.assign(
      new Request('http://fixture/v1/admin/media/examples' + path, {
        body,
        duplex: 'half',
        headers,
        method,
      }),
      { payload: { auth } },
    )
  const form = ({ size = 3, extra, duplicate = false } = {}) => {
    const value = new FormData()
    value.set('file', new File([new Uint8Array(size)], 'x.png', { type: 'image/png' }))
    if (extra) value.set(extra, 'forged')
    if (duplicate) value.append('file', new File(['b'], 'second.png'))
    return value
  }
  for (const extra of ['adminId', 'actor', 'owner', 'ref', 'facts', '_payload', 'visibility']) {
    const response = await endpoint.handler(request({ body: form({ extra }) }))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INPUT_INVALID')
  }
  for (const [req, status, code] of [
    [request({ body: form({ duplicate: true }) }), 400, 'INPUT_INVALID'],
    [request({ body: form({ size: 11 }) }), 413, 'HTTP_BODY_TOO_LARGE'],
    [
      request({
        body: JSON.stringify({ adminId: 1 }),
        headers: { 'content-type': 'application/json' },
      }),
      415,
      'HTTP_UNSUPPORTED_MEDIA_TYPE',
    ],
    [request({ body: form(), path: '?adminId=1' }), 400, 'INPUT_INVALID'],
    [
      request({ body: form(), headers: { 'x-http-method-override': 'PATCH' } }),
      400,
      'INPUT_INVALID',
    ],
    [request({ body: form(), headers: { 'x-method-override': 'PATCH' } }), 400, 'INPUT_INVALID'],
    [
      request({
        body: '--X--\r\n',
        headers: { 'content-type': 'multipart/form-data; boundary=X; boundary=X' },
      }),
      400,
      'INPUT_INVALID',
    ],
    [
      request({
        body: new Uint8Array(16395),
        headers: { 'content-type': 'multipart/form-data; boundary=X', 'content-length': '1' },
      }),
      413,
      'HTTP_BODY_TOO_LARGE',
    ],
  ]) {
    const response = await endpoint.handler(req)
    assert.equal(response.status, status)
    assert.equal((await response.json()).error.code, code)
  }
  const used = request({ body: form() })
  await used.arrayBuffer()
  assert.equal((await endpoint.handler(used)).status, 400)
  const locked = request({
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      },
    }),
    headers: { 'content-type': 'multipart/form-data; boundary=X' },
  })
  const reader = locked.body.getReader()
  assert.equal((await endpoint.handler(locked)).status, 400)
  await reader.cancel()
  const controller = new AbortController()
  controller.abort()
  const aborted = Object.assign(
    new Request('http://fixture/v1/admin/media/examples', {
      body: form(),
      method: 'POST',
      signal: controller.signal,
    }),
    { payload: { auth } },
  )
  assert.equal((await endpoint.handler(aborted)).status, 400)
})
