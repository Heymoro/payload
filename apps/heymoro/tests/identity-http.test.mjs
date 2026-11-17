import assert from 'node:assert/strict'
import test from 'node:test'
import { createIdentityCollections } from '../src/creation/runtime/identity-collections.ts'
import { createCreationWriteGate } from '../src/creation/infrastructure/payload/write-gate.ts'

test('formal Native users read denies every principal', async () => {
  const users = createIdentityCollections({
    clock: () => '2026-11-12T12:00:00.000Z',
    gate: createCreationWriteGate(),
  }).find(({ slug }) => slug === 'users')
  for (const user of [
    null,
    { id: 1, collection: 'users', status: 'active' },
    { id: 2, collection: 'admins', role: 'operator', status: 'active' },
  ]) {
    assert.equal(await users.access.read({ req: { user } }), false)
  }
})

const http = () => import('../src/creation/http/request.ts')
const response = () => import('../src/creation/http/response.ts')
const route = () => import('../src/creation/http/rest-route.ts')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
function request({
  bytes = new TextEncoder().encode('{"code":"A"}'),
  type = 'application/json',
  signal,
  length,
} = {}) {
  return new Request('http://local.invalid/api/v1/auth/wechat', {
    method: 'POST',
    headers: { 'content-type': type, ...(length ? { 'content-length': length } : {}) },
    signal,
    duplex: 'half',
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  })
}
for (const type of [
  'application/json',
  'Application/JSON ; CHARSET = UTF-8',
  'application/json; charset="utf-8"',
])
  test('bounded actual stream JSON accepts normalized UTF-8 media type ' + type, async () => {
    const { readJSONBody } = await http()
    assert.deepEqual(await readJSONBody({ request: request({ type }) }), { code: 'A' })
  })
for (const type of [
  'text/plain',
  'application/problem+json',
  'application/json; charset=latin1',
  'application/json; foo=bar',
  'application/json; charset=utf-8; charset=utf-8',
  '',
])
  test('JSON rejects unsupported media type ' + type, async () => {
    const { readJSONBody } = await http()
    await assert.rejects(readJSONBody({ request: request({ type }) }), {
      code: 'HTTP_UNSUPPORTED_MEDIA_TYPE',
    })
  })
test('stream byte limit ignores content-length and measures multibyte UTF-8', async () => {
  const { readJSONBody } = await http()
  await assert.rejects(
    readJSONBody({
      request: request({
        bytes: new TextEncoder().encode('"' + '中'.repeat(6000) + '"'),
        length: '1',
      }),
    }),
    { code: 'HTTP_BODY_TOO_LARGE' },
  )
  const exact = '"' + 'a'.repeat(16382) + '"'
  assert.equal(
    (
      await readJSONBody({
        request: request({ bytes: new TextEncoder().encode(exact), length: '999999' }),
      })
    ).length,
    16382,
  )
})
for (const bytes of [new Uint8Array([0xc3, 0x28]), new TextEncoder().encode('{'), new Uint8Array()])
  test('invalid UTF8/JSON/empty input is controlled', async () => {
    const { readJSONBody } = await http()
    await assert.rejects(readJSONBody({ request: request({ bytes }) }), {
      code: 'INPUT_INVALID',
    })
  })
test('used and locked bodies do not fall back to parsed data', async () => {
  const { readJSONBody } = await http()
  const used = request()
  await used.text()
  used.data = { code: 'spoof' }
  await assert.rejects(readJSONBody({ request: used }), { code: 'INPUT_INVALID' })
  const locked = request()
  const reader = locked.body.getReader()
  await assert.rejects(readJSONBody({ request: locked }), { code: 'INPUT_INVALID' })
  reader.releaseLock()
})
test('terminal stream read must enforce elapsed deadline before accepting done', async (context) => {
  const { readJSONBody } = await http()
  let now = 0
  let pulls = 0
  context.mock.method(performance, 'now', () => now)
  const body = new ReadableStream(
    {
      pull(controller) {
        pulls++
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('{"code":"A"}'))
        } else {
          // Model a terminal pull monopolizing microtasks while the timer is delayed.
          now = 5100
          controller.close()
        }
      },
    },
    { highWaterMark: 0 },
  )
  const req = new Request('http://local.invalid/api/v1/auth/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    duplex: 'half',
  })
  await assert.rejects(readJSONBody({ request: req }), { code: 'HTTP_REQUEST_TIMEOUT' })
  assert.equal(pulls, 2)
  assert.equal(body.locked, false)
})
test('whole-read 5-second deadline returns even if cancellation hangs and releases lock', async () => {
  const { readJSONBody } = await http()
  let cancelled = false
  const body = new ReadableStream({
    cancel() {
      cancelled = true
      return new Promise(() => {})
    },
  })
  const req = new Request('http://local.invalid', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    duplex: 'half',
  })
  const started = Date.now()
  await assert.rejects(readJSONBody({ request: req }), { code: 'HTTP_REQUEST_TIMEOUT' })
  assert.ok(Date.now() - started >= 4800 && Date.now() - started < 6500)
  assert.ok(cancelled)
  assert.equal(body.locked, false)
})
test('abort before and during stream and stream errors are controlled', async () => {
  const { readJSONBody } = await http()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(readJSONBody({ request: request({ signal: controller.signal }) }), {
    code: 'INPUT_INVALID',
  })
  const during = new AbortController()
  const body = new ReadableStream({})
  const req = new Request('http://local.invalid', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: during.signal,
    body,
    duplex: 'half',
  })
  const result = readJSONBody({ request: req })
  during.abort()
  await assert.rejects(result, { code: 'INPUT_INVALID' })
  assert.equal(body.locked, false)
  const broken = new ReadableStream({
    start(c) {
      c.error(new Error('SECRET'))
    },
  })
  await assert.rejects(
    readJSONBody({
      request: new Request('http://local.invalid', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: broken,
        duplex: 'half',
      }),
    }),
    { code: 'INPUT_INVALID' },
  )
})
test('empty body protocol rejects whitespace and queries', async () => {
  const { assertNoQuery, assertEmptyBody } = await http()
  assert.throws(
    () => assertNoQuery({ request: new Request('http://local.invalid/api/v1/me?a=1') }),
    { code: 'INPUT_INVALID' },
  )
  await assert.rejects(
    assertEmptyBody({ request: request({ bytes: new TextEncoder().encode(' ') }) }),
    { code: 'INPUT_INVALID' },
  )
  await assertEmptyBody({ request: new Request('http://local.invalid') })
})
test('HTTP responses ignore caller ids and suppress arbitrary and mutated errors', async () => {
  const { httpResponse, identityErrorResponse } = await response()
  const { createRequestId } = await import('../src/creation/domain/request-id.ts')
  const { IdentityError } = await import('../src/creation/domain/identity.ts')
  const id = createRequestId()
  assert.match(id, uuid)
  const ok = httpResponse({ data: { ok: true }, requestId: id })
  assert.equal(ok.headers.get('x-request-id'), id)
  assert.equal(ok.headers.get('cache-control'), 'private, no-store')
  assert.equal((await ok.json()).requestId, id)
  for (const error of [
    Object.assign(new Error('SECRET'), { code: 'AUTH_INPUT_INVALID', status: 400 }),
    { code: 'HTTP_REQUEST_TIMEOUT', status: 408 },
    new Error('SECRET'),
  ]) {
    const result = identityErrorResponse({ error, requestId: id })
    assert.equal(result.status, 500)
    assert.deepEqual((await result.json()).error, {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error.',
      retryable: false,
    })
  }
  const known = Object.assign(new IdentityError({ code: 'AUTH_INPUT_INVALID' }), {
    message: 'SECRET',
    status: 999,
    retryable: true,
  })
  const bad = identityErrorResponse({ error: known, requestId: id })
  assert.equal(bad.status, 400)
  assert.deepEqual((await bad.json()).error, {
    code: 'AUTH_INPUT_INVALID',
    message: 'Invalid identity command.',
    retryable: false,
  })
  const unknown = Object.assign(new IdentityError({ code: 'AUTH_INPUT_INVALID' }), { code: 'LEAK' })
  assert.equal(identityErrorResponse({ error: unknown, requestId: id }).status, 500)
  const empty = httpResponse({ status: 204, requestId: id })
  assert.equal(await empty.text(), '')
  assert.equal(empty.headers.get('x-request-id'), id)
})
for (const header of ['x-payload-http-method-override', 'x-http-method-override'])
  test(
    'decoded v1 override guard rejects before Native callback or stream consumption ' + header,
    async () => {
      const { wrapProductREST } = await route()
      let called = 0
      let pulled = 0
      const native = async () => {
        called++
        return new Response('native')
      }
      const wrapped = wrapProductREST({ handler: native })
      const req = new Request('http://local.invalid/api/%76%31/auth/wechat', {
        method: 'POST',
        headers: { [header]: '' },
        body: new ReadableStream(
          {
            pull() {
              pulled++
            },
          },
          { highWaterMark: 0 },
        ),
        duplex: 'half',
      })
      const result = await wrapped(req, {
        params: Promise.resolve({ slug: ['v1', 'auth', 'wechat'] }),
      })
      assert.equal(result.status, 400)
      assert.equal(called, 0)
      assert.equal(pulled, 0)
      assert.equal(req.bodyUsed, false)
      assert.match(result.headers.get('x-request-id'), uuid)
      const pass = await wrapped(
        new Request('http://local.invalid/api/admins', { headers: { [header]: 'GET' } }),
        { params: Promise.resolve({ slug: ['admins'] }) },
      )
      assert.equal(await pass.text(), 'native')
      assert.equal(called, 1)
    },
  )

test('trusted invalid requestId is rejected before login exchange and logout persistence', async () => {
  const { createIdentityService } = await import('../src/creation/application/identity.ts')
  let calls = 0
  const identity = createIdentityService({
    clock: () => '2026-11-12T12:00:00.000Z',
    policy: {
      sessionTtlSeconds: 3600,
      trial: null,
      wechat: {
        appId: 'fixture-app',
        appSecret: 'fixture-secret',
        timeoutMs: 100,
        maxResponseBytes: 1024,
      },
    },
    exchange: async () => {
      calls++
      return { openId: 'fixture', unionId: null }
    },
    persistence: {
      read: async () => {
        calls++
      },
      write: async () => {
        calls++
      },
    },
    trial: async () => {},
  })
  for (const invoke of [
    () => identity.login({ input: { code: 'A' }, requestId: 'caller-controlled' }),
    () => identity.logout({ authorization: null, requestId: 'caller-controlled' }),
    () =>
      identity.updateProfile({
        input: { displayName: 'X' },
        authorization: 'Bearer ' + 'A'.repeat(43),
        requestId: 'caller-controlled',
      }),
  ])
    await assert.rejects(invoke(), { code: 'AUTH_INPUT_INVALID' })
  assert.equal(calls, 0)
})

test('retry work reuses a single generated or trusted UUID fixed before the first await', async () => {
  const { createIdentityService } = await import('../src/creation/application/identity.ts')
  const { createRequestId } = await import('../src/creation/domain/request-id.ts')
  const now = '2026-11-12T12:00:00.000Z'
  const audit = {
    createdAt: now,
    updatedAt: now,
    createdBy: 'system:wechat-auth',
    updatedBy: 'system:wechat-auth',
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
  }
  const user = { ...audit, id: 1, displayName: 'Old', avatarUrl: null, status: 'active' }
  const token = Buffer.alloc(32, 1).toString('base64url')
  const { createHash } = await import('node:crypto')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  for (const action of ['login', 'updateProfile', 'logout'])
    for (const trusted of [undefined, createRequestId()]) {
      const trace = []
      const session = {
        ...audit,
        id: 3,
        user: 1,
        tokenHash,
        expiresAt: '2026-11-12T13:00:00.000Z',
        revokedAt: null,
      }
      const read = {
        findUsersById: async () => [user],
        findWechatIdentities: async () => [
          { ...audit, id: 2, appId: 'app', openId: 'open', unionId: null, user: 1 },
        ],
        findSessionsByHash: async () => (action === 'login' ? [] : [session]),
      }
      const repository = {
        ...read,
        appendAudit: async ({ requestId }) => {
          trace.push(requestId)
        },
        insertSession: async ({ expiresAt, tokenHash }) => ({ ...session, expiresAt, tokenHash }),
        updateProfile: async ({ displayName }) => ({ ...user, displayName }),
        revokeSession: async () => {},
      }
      const service = createIdentityService({
        clock: () => now,
        entropy: () => Buffer.alloc(32, 2),
        exchange: async () => ({ openId: 'open', unionId: null }),
        policy: {
          sessionTtlSeconds: 3600,
          trial: null,
          wechat: { appId: 'app', appSecret: 'secret', timeoutMs: 100, maxResponseBytes: 1024 },
        },
        persistence: {
          read: ({ work }) => work({ reader: read }),
          write: async ({ work }) => {
            await work({ repository })
            return work({ repository })
          },
        },
        trial: async () => {},
      })
      await service[action]({
        input: action === 'login' ? { code: 'A' } : { displayName: 'New' },
        authorization: `Bearer ${token}`,
        requestId: trusted,
      })
      assert.equal(trace.length, 2)
      assert.equal(trace[0], trace[1])
      assert.match(trace[0], uuid)
      if (trusted) assert.equal(trace[0], trusted)
    }
})
test('request UUID helper accepts canonical v4 only', async () => {
  const { createRequestId, isRequestId } = await import('../src/creation/domain/request-id.ts')
  assert.ok(isRequestId({ value: createRequestId() }))
  for (const value of [
    null,
    '',
    7,
    {},
    'be5f54a2-e88a-1a15-993e-25bb4e16560a',
    'BE5F54A2-E88A-4A15-993E-25BB4E16560A',
  ])
    assert.equal(isRequestId({ value }), false)
})

test('GET endpoint rejects a nonempty actual stream without reaching runtime or trusting req.data', async () => {
  const { identityEndpoints } = await import('../src/creation/http/identity-endpoints.ts')
  const endpoint = identityEndpoints.find(
    ({ path, method }) => path === '/v1/me' && method === 'get',
  )
  const req = request({ bytes: new TextEncoder().encode('{}') })
  req.data = null
  const response = await endpoint.handler(req)
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'AUTH_INPUT_INVALID')
})

test('separate server module copies preserve the identity error constructor and closed HTTP mapping', async () => {
  const { IdentityError } = await import('../src/creation/domain/identity.ts?http-route-bundle')
  const { identityErrorResponse } = await response()
  const result = identityErrorResponse({
    error: new IdentityError({ code: 'AUTH_UNCONFIGURED' }),
    requestId: 'bundle-check',
  })
  assert.equal(result.status, 503)
  assert.equal((await result.json()).error.code, 'AUTH_UNCONFIGURED')
})
