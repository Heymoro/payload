import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
const load = () => import('./creation/template-admin-s3-observer.js')
/** @param {Uint8Array} bytes */
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const harness = async ({
  status = 403,
  maxBytes = 65536,
  maxEvents = 3,
  deadlineMs = 1000,
  noResponse = false,
  expectContinue = false,
  noResponseWaitMs = -1,
} = {}) => {
  const { createS3Observer } = await load()
  /** @type {import('node:http').RequestOptions | undefined} */
  let options
  const input = Buffer.from('original\0request')
  const output = Buffer.from('upstream raw XML is not evidence')
  const req = Object.assign(new PassThrough(), {
    method: 'PUT',
    url: '/owned-bucket/official/examples/unit?X-Amz-Credential=SECRET',
    headers: {
      expect: '',
      host: '127.0.0.1:19191',
      authorization: 'SECRET',
      'if-none-match': '*',
      'content-type': 'image/png',
    },
    rawHeaders: [
      'Host',
      '127.0.0.1:19191',
      'Authorization',
      'SECRET',
      'If-None-Match',
      '*',
      'Content-Type',
      'image/png',
    ],
  })
  if (expectContinue) {
    req.headers.expect = '100-continue'
    req.rawHeaders.push('Expect', '100-continue')
  }
  /** @type {Buffer[]} */
  const chunks = []
  const res = Object.assign(
    new Writable({
      highWaterMark: 1,
      write(chunk, encoding, done) {
        chunks.push(Buffer.from(chunk))
        setImmediate(done)
      },
    }),
    {
      status: 0,
      headers: /** @type {string[]} */ ([]),
      continued: false,
      /** @param {number} code @param {string[]} headers */
      writeHead(code, headers) {
        res.status = code
        res.headers = headers
      },
      writeContinue() {
        res.continued = true
      },
    },
  )
  const response = Object.assign(new PassThrough(), {
    statusCode: status,
    rawHeaders: ['Content-Type', 'application/xml', 'x-amz-request-id', 'upstream'],
  })
  /** @type {Buffer[]} */
  const sent = []
  const upstream = Object.assign(
    new Writable({
      highWaterMark: 1,
      write(chunk, encoding, done) {
        sent.push(Buffer.from(chunk))
        setImmediate(done)
      },
    }),
    { flushHeaders() {} },
  )
  /** @type {import('./creation/template-admin-s3-observer.js').RequestFactory} */
  const factory = (value, callback) => {
    options = value
    if (expectContinue) setImmediate(() => upstream.emit('continue'))
    if (!noResponse)
      upstream.on('finish', () => {
        callback(
          /** @type {import('node:http').IncomingMessage} */ (/** @type {unknown} */ (response)),
        )
        response.end(output)
      })
    return /** @type {import('node:http').ClientRequest} */ (/** @type {unknown} */ (upstream))
  }
  const observer = createS3Observer({
    endpoint: 'http://127.0.0.1:19192',
    bucket: 'owned-bucket',
    budget: { maxBytes, maxEvents, deadlineMs, maxInflight: 2 },
    phase: () => 'upload',
    requestFactory: factory,
  })
  observer.handle({
    request: /** @type {import('node:http').IncomingMessage} */ (/** @type {unknown} */ (req)),
    response: /** @type {import('node:http').ServerResponse} */ (/** @type {unknown} */ (res)),
  })
  req.end(input)
  await delay(noResponse ? (noResponseWaitMs < 0 ? deadlineMs + 20 : noResponseWaitMs) : 20)
  assert(options)
  return { observer, options, input, output, sent, chunks, req, res, upstream, response }
}
test('should expose the transparent stream seam without listening', async () => {
  const api = await load()
  assert.equal(typeof api.createS3Observer, 'function')
})
test('should preserve signed Host/path/query/raw headers and both bodies, including real 403', async () => {
  const value = await harness()
  assert.equal(value.options.hostname, '127.0.0.1')
  assert.equal(value.options.port, '19192')
  assert.equal(value.options.path, value.req.url)
  assert.deepEqual(value.options.headers, value.req.rawHeaders)
  assert.deepEqual(Buffer.concat(value.sent), value.input)
  assert.deepEqual(Buffer.concat(value.chunks), value.output)
  assert.equal(value.res.status, 403)
  assert.deepEqual(value.res.headers, value.response.rawHeaders)
  const [event] = value.observer.events
  assert.equal(event.requestSHA256, sha(value.input))
  assert.equal(event.responseSHA256, sha(value.output))
  assert.equal(event.completed, true)
  assert.equal(event.ifNoneMatch, '*')
  assert.equal(event.path, '/owned-bucket/official/examples/unit')
  assert(!JSON.stringify(event).includes('SECRET'))
  assert(!JSON.stringify(event).includes('raw XML'))
  assert.equal(event.upstreamStatus, 403)
  await value.observer.close()
})
test('should preserve an upstream 200 instead of synthesizing storage responses', async () => {
  const value = await harness({ status: 200 })
  assert.equal(value.res.status, 200)
  assert.equal(value.observer.events[0].upstreamStatus, 200)
  await value.observer.close()
})
test('should fail budgets and deadline rather than truncate successful evidence', async () => {
  for (const options of [{ maxBytes: 1 }, { noResponse: true, deadlineMs: 5 }]) {
    const value = await harness(options)
    assert.equal(value.observer.failed, true)
    assert.equal(value.observer.events[0].completed, false)
    assert.equal(value.res.destroyed, true)
    await value.observer.close()
  }
})
test('should reject arbitrary destinations before any request factory use', async () => {
  const { createS3Observer } = await load()
  for (const endpoint of [
    'https://127.0.0.1:90',
    'http://example.com:90',
    'http://user:password@127.0.0.1:90',
    'http://127.0.0.1:90/path',
  ]) {
    assert.throws(() =>
      createS3Observer({
        endpoint,
        bucket: 'owned-bucket',
        budget: { maxBytes: 100, maxEvents: 1, deadlineMs: 100, maxInflight: 1 },
        phase: () => 'probe',
      }),
    )
  }
})
test('should relay only the upstream 100 Continue signal', async () => {
  const value = await harness({ expectContinue: true })
  assert.equal(value.res.continued, true)
  assert.deepEqual(value.options.headers, value.req.rawHeaders)
  await value.observer.close()
})
test('should independently bound close and downstream abort without successful receipts', async () => {
  const closed = await harness({ noResponse: true, noResponseWaitMs: 0 })
  await closed.observer.close()
  assert.equal(closed.res.destroyed, true)
  assert.equal(closed.upstream.destroyed, true)
  assert.equal(closed.observer.events[0].completed, false)
  assert.equal(closed.observer.failed, true)
  const aborted = await harness({ noResponse: true, noResponseWaitMs: 0 })
  aborted.req.emit('aborted')
  assert.equal(aborted.res.destroyed, true)
  assert.equal(aborted.observer.failed, true)
  assert.equal(aborted.observer.events[0].completed, false)
  await aborted.observer.close()
})
test('should fail event overflow and foreign namespace instead of discarding evidence and passing', async () => {
  const value = await harness({ maxEvents: 1 })
  const request = Object.assign(new PassThrough(), {
    method: 'GET',
    url: '/foreign/object',
    headers: {},
    rawHeaders: [],
  })
  const response = new PassThrough()
  value.observer.handle({
    request: /** @type {import('node:http').IncomingMessage} */ (/** @type {unknown} */ (request)),
    response: /** @type {import('node:http').ServerResponse} */ (/** @type {unknown} */ (response)),
  })
  assert.equal(value.observer.failed, true)
  assert.equal(response.destroyed, true)
  assert.equal(value.observer.events.length, 1)
  await value.observer.close()
})
