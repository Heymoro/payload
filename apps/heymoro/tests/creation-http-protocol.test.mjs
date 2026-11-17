import assert from 'node:assert/strict'
import test from 'node:test'

const query = () => import('../src/creation/http/query.ts')
const errors = () => import('../src/creation/http/business-errors.ts')

test('query decodes once, preserves text and ignores parsed req.query', async () => {
  const { readQuery } = await query()
  assert.deepEqual(
    readQuery({
      request: {
        url: 'http://fixture/api/v1/templates?keyword=++%2520+&categoryId=7',
        query: { categoryId: 99 },
      },
      allowedKeys: ['keyword', 'categoryId'],
      integerKeys: ['categoryId'],
    }),
    { keyword: '  %20 ', categoryId: 7 },
  )
})
for (const search of [
  'keyword=%',
  'keyword=%FF',
  'keyword=%C3%28',
  'keyword=%ED%A0%80',
  'keyword=a&%6Beyword=b',
  'keyword[]=a',
  'keyword%5B0%5D=a',
  'userId=1',
  'categoryId=01',
  'categoryId=%2B1',
  'categoryId=1e0',
  'categoryId=0',
  'categoryId=',
  'categoryId=+1',
  'categoryId=9007199254740992',
])
  test('query rejects invalid wire form ' + search, async () => {
    const { readQuery } = await query()
    assert.throws(
      () =>
        readQuery({
          request: { url: 'http://fixture/api/v1/templates?' + search },
          allowedKeys: ['keyword', 'categoryId'],
          integerKeys: ['categoryId'],
        }),
      { code: 'INPUT_INVALID' },
    )
  })
test('path identifiers accept only canonical positive safe integer strings', async () => {
  const { parsePathId } = await query()
  assert.equal(parsePathId({ value: '42' }), 42)
  for (const value of [
    undefined,
    1,
    [],
    '01',
    '+1',
    '-1',
    '0',
    '1e0',
    ' 1',
    '1 ',
    '',
    '9007199254740992',
  ]) {
    assert.throws(() => parsePathId({ value }), { code: 'INPUT_INVALID' })
  }
})
test('business errors are class-closed and ignore mutable status message and retryable', async () => {
  const { businessErrorResponse } = await errors()
  const { CatalogError } = await import('../src/creation/domain/template-config.ts')
  const { SessionError } = await import('../src/creation/domain/session.ts')
  const { DraftError } = await import('../src/creation/application/draft.ts')
  const { CreationInputError } = await import('../src/creation/domain/input.ts')
  const { GenerationError } = await import('../src/creation/domain/generation.ts')
  const { RedisCoordinationError } =
    await import('../src/creation/infrastructure/redis/coordinator.ts')
  const { HttpRequestError } = await import('../src/creation/http/request.ts')
  const { CreationTransactionError } =
    await import('../src/creation/infrastructure/payload/sqlite-unit-of-work.ts')
  for (const [error, code, status] of [
    [new CatalogError({ code: 'TEMPLATE_UNAVAILABLE' }), 'TEMPLATE_UNAVAILABLE', 409],
    [
      new SessionError({ code: 'SESSION_UNAVAILABLE', status: 409, message: 'SECRET' }),
      'SESSION_UNAVAILABLE',
      409,
    ],
    [
      new SessionError({ code: 'IDEMPOTENCY_CONFLICT', status: 409, message: 'SECRET' }),
      'IDEMPOTENCY_CONFLICT',
      409,
    ],
    [new DraftError({ code: 'NOT_FOUND' }), 'NOT_FOUND', 404],
    [
      new CreationInputError({ code: 'DESCRIPTION_REQUIRED', message: 'SECRET' }),
      'DESCRIPTION_REQUIRED',
      400,
    ],
    [new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' }), 'DATA_INTEGRITY_CONFLICT', 503],
    [new RedisCoordinationError({ code: 'RESOURCE_BUSY' }), 'RESOURCE_BUSY', 409],
    [
      new RedisCoordinationError({ code: 'COORDINATION_UNAVAILABLE' }),
      'COORDINATION_UNAVAILABLE',
      503,
    ],
    [new HttpRequestError({ code: 'INPUT_INVALID' }), 'INPUT_INVALID', 400],
    [
      new CreationTransactionError({
        attempt: { commitStarted: true, rollbackConfirmed: false },
        error: new Error('SECRET'),
      }),
      'OPERATION_OUTCOME_UNKNOWN',
      503,
    ],
    [
      Object.assign(new Error('SECRET'), {
        name: 'CatalogError',
        code: 'INPUT_INVALID',
        status: 400,
      }),
      'INTERNAL_ERROR',
      500,
    ],
    [new Error('SECRET'), 'INTERNAL_ERROR', 500],
    [
      Object.assign(new CatalogError({ code: 'INPUT_INVALID' }), { code: 'NOT_FOUND' }),
      'INTERNAL_ERROR',
      500,
    ],
    [
      Object.assign(new DraftError({ code: 'NOT_FOUND' }), { code: 'INPUT_INVALID' }),
      'INTERNAL_ERROR',
      500,
    ],
    [
      Object.assign(new GenerationError({ code: 'INPUT_INVALID' }), {
        code: 'UNKNOWN_GENERATION_CODE',
      }),
      'INTERNAL_ERROR',
      500,
    ],
  ]) {
    Object.assign(error, { status: 201, message: 'SECRET', retryable: true })
    const response = businessErrorResponse({ error, requestId: 'server-id' })
    assert.equal(response.status, status)
    assert.equal(response.headers.get('x-request-id'), 'server-id')
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const body = await response.json()
    assert.equal(body.requestId, 'server-id')
    assert.equal(body.error.code, code)
    assert.equal(body.error.retryable, false)
    assert.doesNotMatch(JSON.stringify(body), /SECRET|cause|commitStarted|rollbackConfirmed/)
  }
})
test('generic reader invalid maps back to identity protocol', async () => {
  const { HttpRequestError } = await import('../src/creation/http/request.ts')
  const { identityErrorResponse } = await import('../src/creation/http/response.ts')
  const response = identityErrorResponse({
    error: new HttpRequestError({ code: 'INPUT_INVALID' }),
    requestId: 'server-id',
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'AUTH_INPUT_INVALID')
})
test('all v1 override guards reject before callback with generic INPUT_INVALID', async () => {
  const { wrapProductREST } = await import('../src/creation/http/rest-route.ts')
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    for (const header of ['x-http-method-override', 'x-payload-http-method-override']) {
      let calls = 0
      const handler = wrapProductREST({
        handler: async () => {
          calls++
          return new Response()
        },
      })
      const response = await handler(
        new Request('http://fixture/api/%76%31/templates', {
          method,
          headers: { [header]: '' },
        }),
        { params: Promise.resolve({ slug: ['v1', 'templates'] }) },
      )
      assert.equal(response.status, 400)
      assert.equal((await response.json()).error.code, 'INPUT_INVALID')
      assert.equal(calls, 0)
    }
  }
})
test('session projection has exactly six fields and preserves persisted values', async () => {
  const { sessionDTO } = await import('../src/creation/http/session-dto.ts')
  const session = {
    id: 1,
    mode: 'free',
    templateId: 2,
    templateVersionId: 3,
    title: ' original ',
    titleSource: 'user',
    lastActivityAt: 'stored-time',
    userId: 5,
    requestHash: 'SECRET',
    autoNameStatus: 'pending',
    nextRoundNo: 7,
    coverArtifactId: 9,
  }
  assert.deepEqual(sessionDTO({ session }), {
    id: 1,
    mode: 'free',
    templateId: 2,
    title: ' original ',
    titleSource: 'user',
    lastActivityAt: 'stored-time',
  })
})
test('trusted draft byte budget accepts worst-case legal text but default cap and actual oversized bytes reject', async () => {
  const { readJSONBody } = await import('../src/creation/http/request.ts')
  const { validateCreationInput } = await import('../src/creation/domain/input.ts')
  const request = (text) =>
    new Request('http://fixture/api/v1/creation-sessions/1/draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: text,
    })
  for (const text of [
    JSON.stringify({ description: '中'.repeat(10000), userNotes: '', inputMediaIds: [] }),
    '{"description":"' + '\\u4e2d'.repeat(10000) + '","userNotes":"","inputMediaIds":[]}',
  ]) {
    await assert.rejects(readJSONBody({ request: request(text) }), { code: 'HTTP_BODY_TOO_LARGE' })
    const input = await readJSONBody({ request: request(text), maxBytes: 131072 })
    assert.equal(
      validateCreationInput({
        input,
        limits: { maxDescriptionLength: 10000, maxImages: 16, maxNotesLength: 10000, minImages: 0 },
        mode: 'free',
        stage: 'draft',
      }).description.length,
      10000,
    )
  }
  await assert.rejects(readJSONBody({ request: request(' '.repeat(131073)), maxBytes: 131072 }), {
    code: 'HTTP_BODY_TOO_LARGE',
  })
})
test('invalid trusted byte budgets fail before consuming any actual bytes', async () => {
  const { readJSONBody } = await import('../src/creation/http/request.ts')
  for (const maxBytes of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    let pulls = 0
    const request = new Request('http://fixture/api/v1/creation-sessions/1/draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      duplex: 'half',
      body: new ReadableStream(
        {
          pull() {
            pulls++
          },
        },
        { highWaterMark: 0 },
      ),
    })
    await assert.rejects(readJSONBody({ maxBytes, request }), RangeError)
    assert.equal(pulls, 0)
    assert.equal(request.bodyUsed, false)
  }
})
test('terminal line separators never qualify as canonical identifier strings', async () => {
  const { parsePathId, readQuery } = await query()
  for (const value of ['1\n', '1\r', '1\r\n', '1\u2028', '1\u2029']) {
    assert.throws(() => parsePathId({ value }), { code: 'INPUT_INVALID' })
    assert.throws(
      () =>
        readQuery({
          request: {
            url: 'http://fixture/api/v1/templates?categoryId=' + encodeURIComponent(value),
          },
          allowedKeys: ['categoryId'],
          integerKeys: ['categoryId'],
        }),
      { code: 'INPUT_INVALID' },
    )
  }
})
test('direct GET adapters bound actual nonempty streams before runtime and ignore req.data', async () => {
  const { catalogEndpoints } = await import('../src/creation/http/catalog-endpoints.ts')
  const { sessionEndpoints } = await import('../src/creation/http/session-endpoints.ts')
  for (const endpoint of [...catalogEndpoints, ...sessionEndpoints].filter(
    ({ method }) => method === 'get',
  )) {
    // Fetch forbids a network GET body; exercise the adapter directly with an actual stream.
    const request = new Request('http://fixture/api' + endpoint.path, {
      method: 'POST',
      body: '{}',
    })
    request.routeParams = { sessionId: '1', templateId: '1' }
    request.data = null
    const response = await endpoint.handler(request)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INPUT_INVALID')
  }
})
