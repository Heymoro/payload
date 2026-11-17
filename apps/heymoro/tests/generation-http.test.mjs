import assert from 'node:assert/strict'
import test from 'node:test'

import { CreditsError } from '../src/creation/domain/credits.ts'
import { GenerationError } from '../src/creation/domain/generation.ts'
import { businessErrorResponse } from '../src/creation/http/business-errors.ts'

const requestId = 'server-request-id'
const statuses = {
  CREDITS_INSUFFICIENT: 402,
  DATA_INTEGRITY_CONFLICT: 503,
  GENERATION_IN_PROGRESS: 409,
  GENERATION_NOT_CONFIGURED: 503,
  IDEMPOTENCY_CONFLICT: 409,
  INPUT_INVALID: 400,
  NOT_FOUND: 404,
  QUOTE_CHANGED: 409,
  QUOTE_EXPIRED: 409,
  TEMPLATE_UNAVAILABLE: 409,
  UNAUTHENTICATED: 401,
}

test('generation errors use a closed class/code mapping, never instance details', async () => {
  for (const [code, status] of Object.entries(statuses)) {
    const error = new GenerationError({ code })
    Object.assign(error, { cause: 'private cause', message: 'private message', status: 299 })
    const response = businessErrorResponse({ error, requestId })
    assert.equal(response.status, status, code)
    const body = await response.json()
    assert.equal(body.error.code, code)
    assert.equal(body.error.retryable, false)
    assert.doesNotMatch(JSON.stringify(body), /private|299/)
  }
  for (const error of [
    { code: 'QUOTE_EXPIRED', status: 409 },
    Object.assign(new GenerationError({ code: 'INPUT_INVALID' }), { code: 'UNKNOWN' }),
    new CreditsError({ code: 'CREDITS_INSUFFICIENT' }),
  ]) {
    assert.equal(businessErrorResponse({ error, requestId }).status, 500)
  }
})

test('quote command distinguishes generate and regeneration with strict, unchanged input', async () => {
  const { parseGenerationQuote } = await import('../src/creation/http/generation-command.ts')
  const input = { inputMediaIds: [3, 1], description: '  text\n', userNotes: '' }
  assert.deepEqual(parseGenerationQuote({ value: { sessionId: 1, input } }), {
    operation: 'generate',
    sessionId: 1,
    input,
  })
  assert.deepEqual(parseGenerationQuote({ value: { sourceArtifactId: 2 } }), {
    operation: 'regenerate',
    sourceArtifactId: 2,
  })
  assert.deepEqual(parseGenerationQuote({ value: { sessionId: 1, input: {} } }).input, {
    inputMediaIds: [],
    description: '',
    userNotes: '',
  })
  for (const value of [
    null,
    [],
    {},
    { sessionId: 1 },
    { sessionId: 1, input: null },
    { sessionId: '1', input },
    { sessionId: 0, input },
    { sessionId: 1.5, input },
    { sessionId: Number.MAX_SAFE_INTEGER + 1, input },
    { sessionId: 1, input, operation: 'generate' },
    { sourceArtifactId: 2, sessionId: 1 },
    { sourceArtifactId: 2, input },
    { sourceArtifactId: 2, purpose: 'regenerate' },
    { sessionId: 1, input: { notes: 'x' } },
    { sessionId: 1, input: { inputMediaIds: [1, 1] } },
  ])
    assert.throws(() => parseGenerationQuote({ value }), { code: 'INPUT_INVALID' })
  const getter = Object.defineProperty({}, 'sessionId', {
    get() {
      throw new Error('called')
    },
    enumerable: true,
  })
  for (const value of [
    getter,
    Object.create({ sessionId: 1 }),
    { [Symbol('hidden')]: 1 },
    Object.defineProperty({}, 'sessionId', { value: 1 }),
  ]) {
    assert.throws(() => parseGenerationQuote({ value }), { code: 'INPUT_INVALID' })
  }
})

test('submission commands preserve identity and leave opaque quote verification to admission', async () => {
  const { parseGenerationSubmission } = await import('../src/creation/http/generation-command.ts')
  const identity = { clientRequestId: '  SERIAL  ', quoteToken: '' }
  assert.deepEqual(
    parseGenerationSubmission({
      operation: 'generate',
      value: { ...identity, sessionId: 2, input: { description: ' x ' } },
    }),
    {
      clientRequestId: '  SERIAL  ',
      quoteToken: '',
      sessionId: 2,
      input: { description: ' x ', inputMediaIds: [], userNotes: '' },
    },
  )
  assert.deepEqual(parseGenerationSubmission({ operation: 'regenerate', value: identity }), {
    clientRequestId: '  SERIAL  ',
    quoteToken: '',
  })
  for (const operation of ['generate', 'regenerate']) {
    const base = operation === 'generate' ? { sessionId: 1, input: {} } : {}
    for (const extra of [
      {},
      { clientRequestId: 'x' },
      { quoteToken: 'x' },
      { clientRequestId: ' ', quoteToken: 'x' },
      { clientRequestId: 1, quoteToken: 'x' },
      { clientRequestId: 'a'.repeat(129), quoteToken: 'x' },
      { clientRequestId: ' ' + 'a'.repeat(127) + ' ', quoteToken: 'x' },
      { clientRequestId: 'x', quoteToken: null },
      { clientRequestId: 'x', quoteToken: 7 },
      { ...identity, userId: 1 },
      { ...identity, operation },
      { ...identity, sourceArtifactId: 1 },
    ])
      assert.throws(() => parseGenerationSubmission({ operation, value: { ...base, ...extra } }), {
        code: 'INPUT_INVALID',
      })
  }
  for (const input of [undefined, null]) {
    assert.throws(
      () =>
        parseGenerationSubmission({
          operation: 'generate',
          value: { ...identity, sessionId: 1, input },
        }),
      { code: 'INPUT_INVALID' },
    )
  }
  for (const extra of [{ sessionId: 1 }, { input: {} }]) {
    assert.throws(
      () =>
        parseGenerationSubmission({ operation: 'regenerate', value: { ...identity, ...extra } }),
      { code: 'INPUT_INVALID' },
    )
  }
})

test('generation HTTP registers exactly the five product routes', async () => {
  const { generationEndpoints } = await import('../src/creation/http/generation-endpoints.ts')
  assert.deepEqual(
    generationEndpoints.map(({ method, path }) => [method, path]),
    [
      ['post', '/v1/generation-quotes'],
      ['post', '/v1/generations'],
      ['post', '/v1/artifacts/:artifactId/regenerations'],
      ['get', '/v1/generations/:taskId'],
      ['get', '/v1/creation-sessions/:sessionId/generations'],
    ],
  )
})

test('separate server bundles keep generation errors in the closed HTTP mapping', async () => {
  const copied = await import('../src/creation/domain/generation.ts?generation-route-bundle')
  const response = businessErrorResponse({
    error: new copied.GenerationError({ code: 'GENERATION_NOT_CONFIGURED' }),
    requestId,
  })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, 'GENERATION_NOT_CONFIGURED')
})
