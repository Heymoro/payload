import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import test from 'node:test'
import sharp from 'sharp'

import { validateImage } from '../src/creation/infrastructure/image/sharp-image-validator.ts'

const multipart = () => import('../src/creation/http/multipart.ts')
const encoder = new TextEncoder()
const raw = ({ body, contentType = 'multipart/form-data; boundary=X', signal }) =>
  new Request('http://fixture/v1/media', {
    body,
    duplex: 'half',
    headers: { 'content-type': contentType, 'content-length': '1' },
    method: 'POST',
    signal,
  })
const part = ({ name = 'file', filename = 'image.png', value = 'abc', type = 'image/png' } = {}) =>
  `--X\r\nContent-Disposition: form-data; name="${name}"${filename === null ? '' : `; filename="${filename}"`}\r\nContent-Type: ${type}\r\n\r\n${value}\r\n`
const parse = async (request, options = {}) =>
  (await multipart()).readMultipartFile({ fileMaxBytes: 1000, request, ...options })

test('multipart returns one real platform File as detached bytes', async () => {
  const form = new FormData()
  form.set('file', new File(['abc'], 'image.png', { type: 'image/png' }))
  assert.deepEqual(await parse(new Request('http://fixture', { body: form, method: 'POST' })), {
    declaredMimeType: 'image/png',
    input: new Uint8Array([97, 98, 99]),
    originalName: 'image.png',
  })
})
for (const [contentType, code] of [
  ['application/json', 'HTTP_UNSUPPORTED_MEDIA_TYPE'],
  ['multipart/mixed; boundary=X', 'HTTP_UNSUPPORTED_MEDIA_TYPE'],
  ...[
    'multipart/form-data',
    'multipart/form-data; boundary=',
    'multipart/form-data; boundary=X; boundary=X',
    'multipart/form-data; boundary=X; charset=utf-8',
    'multipart/form-data; boundary="X',
    'multipart/form-data; boundary="X "',
    'multipart/form-data; boundary=' + 'x'.repeat(71),
    'multipart/form-data; boundary="X@"',
  ].map((type) => [type, 'INPUT_INVALID']),
]) {
  test('multipart rejects type: ' + contentType, async () => {
    await assert.rejects(parse(raw({ body: part() + '--X--\r\n', contentType })), { code })
  })
}
for (const [label, body] of [
  ['empty', '--X--\r\n'],
  ['text', part({ filename: null }) + '--X--\r\n'],
  ['wrong field', part({ name: 'owner' }) + '--X--\r\n'],
  ['duplicate', part() + part() + '--X--\r\n'],
  ...['_payload', 'owner', 'purpose', 'storage', 'uploadInstructions'].map((name) => [
    name,
    part() + part({ name, filename: null }) + '--X--\r\n',
  ]),
  ['boundary mismatch', part() + '--Y--\r\n'],
  ['truncated', part()],
  ['cut-off close', part() + '--X-'],
]) {
  test('multipart rejects shape: ' + label, async () => {
    await assert.rejects(parse(raw({ body })), { code: 'INPUT_INVALID' })
  })
}
test('File size and wire cap enforce exact and plus-one bytes independently of Content-Length', async () => {
  for (const length of [10, 11]) {
    const pending = parse(raw({ body: part({ value: 'a'.repeat(length) }) + '--X--\r\n' }), {
      fileMaxBytes: 10,
    })
    if (length === 10) assert.equal((await pending).input.length, 10)
    else await assert.rejects(pending, { code: 'HTTP_BODY_TOO_LARGE' })
  }
  const base = encoder.encode(part({ value: 'a' }) + '--X--\r\n')
  for (const extra of [0, 1]) {
    const bytes = new Uint8Array(10 + 16384 + extra)
    bytes.set(base)
    bytes.fill(32, base.length)
    const pending = parse(raw({ body: bytes }), { fileMaxBytes: 10 })
    if (extra) await assert.rejects(pending, { code: 'HTTP_BODY_TOO_LARGE' })
    else assert.equal((await pending).input.length, 1)
  }
  assert.equal(
    (
      await parse(
        raw({ body: part() + '--X--\r\n', contentType: 'multipart/form-data; boundary="X"' }),
      )
    ).input.length,
    3,
  )
})
test('raw reader validates trusted budgets before body access and preserves JSON defaults', async () => {
  const { readRequestBytes, readJSONBody, CREATION_JSON_MAX_BYTES } =
    await import('../src/creation/http/request.ts')
  assert.equal(typeof readRequestBytes, 'function')
  for (const options of [
    { maxBytes: 0 },
    { maxBytes: 1.5 },
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
  ]) {
    let gets = 0
    const request = {
      get body() {
        gets++
        throw new Error('must not read')
      },
      headers: new Headers(),
    }
    await assert.rejects(readRequestBytes({ request, ...options }), RangeError)
    assert.equal(gets, 0)
  }
  assert.equal(CREATION_JSON_MAX_BYTES, 131072)
  assert.deepEqual(
    await readJSONBody({ request: raw({ body: '{}', contentType: 'application/json' }) }),
    {},
  )
  await assert.rejects(
    readJSONBody({
      request: raw({ body: '"' + 'x'.repeat(16383) + '"', contentType: 'application/json' }),
    }),
    { code: 'HTTP_BODY_TOO_LARGE' },
  )
})
test('deadline and abort do not await hostile cancellation; stream locks release', async () => {
  for (const isAbort of [false, true]) {
    const controller = new AbortController()
    let canceled = false
    const body = new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel() {
        canceled = true
        return new Promise(() => {})
      },
    })
    const pending = parse(raw({ body, signal: controller.signal }), { timeoutMs: 20 })
    if (isAbort) setTimeout(() => controller.abort(), 5)
    await assert.rejects(pending, { code: isAbort ? 'INPUT_INVALID' : 'HTTP_REQUEST_TIMEOUT' })
    assert.equal(canceled, true)
    assert.equal(body.locked, false)
  }
})
test('shared deadline checks platform parse and File arrayBuffer, and post-parse abort', async () => {
  const original = Response.prototype.formData
  for (const stage of ['parse', 'bytes', 'abort']) {
    const controller = new AbortController()
    Response.prototype.formData = async function () {
      const form = await original.call(this)
      if (stage === 'parse') await new Promise((resolve) => setTimeout(resolve, 30))
      if (stage === 'abort') controller.abort()
      if (stage === 'bytes') {
        const file = form.get('file')
        const arrayBuffer = file.arrayBuffer.bind(file)
        file.arrayBuffer = async () => {
          await new Promise((resolve) => setTimeout(resolve, 30))
          return arrayBuffer()
        }
      }
      return form
    }
    try {
      await assert.rejects(
        parse(raw({ body: part() + '--X--\r\n', signal: controller.signal }), { timeoutMs: 20 }),
        { code: stage === 'abort' ? 'INPUT_INVALID' : 'HTTP_REQUEST_TIMEOUT' },
      )
    } finally {
      Response.prototype.formData = original
    }
  }
})
test('full decode failures and unsafe original names are INVALID_MEDIA before storage/write', async () => {
  const { createMediaService, MediaError } = await import('../src/creation/application/media.ts')
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  const jpeg = await sharp(png).jpeg().toBuffer()
  let puts = 0
  let writes = 0
  const service = createMediaService({
    validateImage,
    clock: () => '2026-11-12T00:00:00.000Z',
    destination: { backend: 'fixture', bucket: 'fixture' },
    imageLimits: {
      allowedMimeTypes: ['image/png', 'image/jpeg'],
      maxBytes: 1000,
      maxPixels: 1000,
      timeoutMs: 1000,
    },
    isCommitUnknown: () => false,
    read: ({ work }) => work({ repository: { isAccountActive: async () => true } }),
    storage: {
      putImmutable: async () => {
        puts++
        throw new Error('storage sentinel')
      },
    },
    write: async () => {
      writes++
    },
  })
  for (const args of [
    { input: encoder.encode('<svg/>'), originalName: 'x.svg' },
    { input: png.subarray(0, 40), originalName: 'x.png' },
    { input: png, originalName: 'x.png', declaredMimeType: 'image/jpeg' },
    ...['../x.png', '..\\x.png', 'x\u0000.png', 'x\u007f.png', 'x'.repeat(256)].map(
      (originalName) => ({ input: png, originalName }),
    ),
  ])
    await assert.rejects(
      service.uploadForUser({ userId: 1, ...args }),
      (error) => error instanceof MediaError && error.code === 'INVALID_MEDIA',
    )
  assert.equal(puts, 0)
  assert.equal(writes, 0)
  for (const [input, declaredMimeType] of [
    [png, 'image/png'],
    [jpeg, 'image/jpeg'],
  ])
    await assert.rejects(
      service.uploadForUser({ userId: 1, input, originalName: 'x', declaredMimeType }),
      /storage sentinel/,
    )
  assert.equal(puts, 2)
})
test('media/storage/credits mappings require each real class and its own closed codes', async () => {
  const { businessErrorResponse } = await import('../src/creation/http/business-errors.ts')
  const { MediaError } = await import('../src/creation/application/media.ts')
  const { MediaStorageError } = await import('../src/creation/domain/media.ts')
  const { CreditsError } = await import('../src/creation/domain/credits.ts')
  for (const [error, code, status] of [
    ...['INVALID_MEDIA', 'NOT_FOUND', 'UNAUTHENTICATED', 'DATA_INTEGRITY_CONFLICT'].map(
      (code, index) => [new MediaError(code), code, [400, 404, 401, 503][index]],
    ),
    [new MediaStorageError('NOT_FOUND'), 'NOT_FOUND', 404],
    ...['UNKNOWN', 'FORBIDDEN'].map((code) => [
      new MediaStorageError(code),
      'MEDIA_STORAGE_UNAVAILABLE',
      503,
    ]),
    ...['CONTENT_CONFLICT', 'INVALID_REF', 'UNSAFE_BACKEND', 'UNVERIFIED_BACKEND'].map((code) => [
      new MediaStorageError(code),
      'DATA_INTEGRITY_CONFLICT',
      503,
    ]),
    ...['INPUT_INVALID', 'UNAUTHENTICATED', 'DATA_INTEGRITY_CONFLICT'].map((code, index) => [
      new CreditsError({ code }),
      code,
      [400, 401, 503][index],
    ]),
    [new CreditsError({ code: 'IDEMPOTENCY_CONFLICT' }), 'INTERNAL_ERROR', 500],
    [{ code: 'NOT_FOUND' }, 'INTERNAL_ERROR', 500],
    [
      Object.assign(new MediaError('NOT_FOUND'), { code: 'IDEMPOTENCY_CONFLICT' }),
      'INTERNAL_ERROR',
      500,
    ],
  ]) {
    Object.assign(error, { status: 200, message: 'SECRET', retryable: true, cause: 'SECRET' })
    const response = businessErrorResponse({ error, requestId: 'fixture' })
    const body = await response.json()
    assert.equal(response.status, status)
    assert.equal(body.error.code, code)
    assert.equal(body.error.retryable, false)
    assert.doesNotMatch(JSON.stringify(body), /SECRET/)
    if (code === 'NOT_FOUND') assert.equal(body.error.message, 'Resource not found.')
  }
})
test('reference limits are isolated from output decoder limits and unused zero-image caps', async () => {
  const { referenceImageLimits } = await import('../src/creation/runtime/config.ts')
  assert.equal(typeof referenceImageLimits, 'function')
  const imageLimits = {
    allowedMimeTypes: ['image/png', 'image/jpeg'],
    maxBytes: 1000,
    maxPixels: 10000,
    timeoutMs: 100,
  }
  const hostCaps = { maxImages: 1, maxImageBytes: 500, allowedMimeTypes: ['image/jpeg'] }
  assert.deepEqual(referenceImageLimits({ hostCaps, imageLimits }), {
    ...imageLimits,
    maxBytes: 500,
    allowedMimeTypes: ['image/jpeg'],
  })
  assert.deepEqual(imageLimits.allowedMimeTypes, ['image/png', 'image/jpeg'])
  for (const host of [
    { ...hostCaps, maxImageBytes: 1001 },
    { ...hostCaps, allowedMimeTypes: ['image/webp'] },
  ])
    assert.throws(() => referenceImageLimits({ hostCaps: host, imageLimits }))
  assert.deepEqual(
    referenceImageLimits({
      hostCaps: { ...hostCaps, maxImages: 0, maxImageBytes: 1001 },
      imageLimits: { ...imageLimits, allowedMimeTypes: ['image/png'] },
    }),
    { ...imageLimits, allowedMimeTypes: ['image/png'] },
  )
})

test('bounded raw chunks time out after read even if synchronous producer stalls the timer', async () => {
  const { readRequestBytes } = await import('../src/creation/http/request.ts')
  const body = new ReadableStream({
    pull(controller) {
      const until = performance.now() + 25
      while (performance.now() < until) {
        /* Deliberately block the timer callback. */
      }
      controller.enqueue(new Uint8Array([1]))
      controller.close()
    },
  })
  await assert.rejects(readRequestBytes({ maxBytes: 2, request: raw({ body }), timeoutMs: 5 }), {
    code: 'HTTP_REQUEST_TIMEOUT',
  })
  const chunks = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(9000))
      controller.enqueue(new Uint8Array(9000))
      controller.close()
    },
  })
  await assert.rejects(parse(raw({ body: chunks }), { fileMaxBytes: 10 }), {
    code: 'HTTP_BODY_TOO_LARGE',
  })
})
test('multipart validates trusted budgets before touching body and rejects already-aborted input', async () => {
  const { readMultipartFile } = await multipart()
  for (const options of [
    { fileMaxBytes: 0 },
    { fileMaxBytes: Number.MAX_SAFE_INTEGER },
    { timeoutMs: 0 },
    { timeoutMs: 0.5 },
  ]) {
    let gets = 0
    const request = {
      headers: new Headers(),
      get body() {
        gets++
        throw new Error('unread')
      },
    }
    await assert.rejects(readMultipartFile({ fileMaxBytes: 10, request, ...options }), RangeError)
    assert.equal(gets, 0)
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(parse(raw({ body: part() + '--X--\r\n', signal: controller.signal })), {
    code: 'INPUT_INVALID',
  })
})
test('multipart checks monotonic deadline and abort after synchronous platform work as well', async () => {
  const original = Response.prototype.formData
  for (const stage of ['parse', 'bytes', 'abortBytes']) {
    const controller = new AbortController()
    Response.prototype.formData = async function () {
      const result = await original.call(this)
      const stall = () => {
        const until = performance.now() + 25
        while (performance.now() < until) {
          /* Timer cannot run. */
        }
      }
      if (stage === 'parse') stall()
      else {
        const file = result.get('file')
        const arrayBuffer = file.arrayBuffer.bind(file)
        file.arrayBuffer = () => {
          if (stage === 'abortBytes') controller.abort()
          else stall()
          return arrayBuffer()
        }
      }
      return result
    }
    try {
      await assert.rejects(
        parse(raw({ body: part() + '--X--\r\n', signal: controller.signal }), { timeoutMs: 10 }),
        { code: stage === 'abortBytes' ? 'INPUT_INVALID' : 'HTTP_REQUEST_TIMEOUT' },
      )
    } finally {
      Response.prototype.formData = original
    }
  }
})
test('zero-image host policy initializes without enforcing unused input byte/MIME intersections', async () => {
  const { hostConfig } = await import('./creation/runtime-seed.ts')
  const { parseCoreConfig, referenceImageLimits } =
    await import('../src/creation/runtime/config.ts')
  const config = hostConfig({ dataDir: '/tmp/heymoro-E1C-unused-policy-value' })
  const value = {
    ...config,
    hostCaps: {
      ...config.hostCaps,
      allowedMimeTypes: ['image/jpeg'],
      maxImageBytes: 200000,
      maxImages: 0,
      maxTotalImageBytes: 200000,
    },
  }
  assert.equal(parseCoreConfig({ value }).hostCaps.maxImages, 0)
  assert.throws(() =>
    parseCoreConfig({ value: { ...value, hostCaps: { ...value.hostCaps, maxImages: 1 } } }),
  )
  const imageLimits = { ...config.imageLimits, allowedMimeTypes: ['image/png', 'image/jpeg'] }
  const reference = referenceImageLimits({
    hostCaps: { ...config.hostCaps, allowedMimeTypes: ['image/jpeg'] },
    imageLimits,
  })
  const png = await sharp({ create: { background: 'green', channels: 3, height: 2, width: 3 } })
    .png()
    .toBuffer()
  assert.equal((await validateImage({ input: png, limits: imageLimits })).mimeType, 'image/png')
  await assert.rejects(validateImage({ input: png, limits: reference }), /Unsupported image format/)
})

test('raw reader snapshots reused producer buffers at each completed read', async () => {
  const { readRequestBytes } = await import('../src/creation/http/request.ts')
  const shared = new Uint8Array(2)
  let count = 0
  const body = new ReadableStream(
    {
      pull(controller) {
        count++
        if (count > 2) {
          controller.close()
          return
        }
        shared.set(count === 1 ? [1, 2] : [3, 4])
        controller.enqueue(shared)
      },
    },
    { highWaterMark: 0 },
  )
  const bytes = await readRequestBytes({ maxBytes: 4, request: raw({ body }) })
  assert.deepEqual([...bytes], [1, 2, 3, 4])
})

test('multipart uses one total deadline for slow trickles rather than restarting per chunk', async () => {
  let isCanceled = false
  const body = new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (!isCanceled) controller.enqueue(new Uint8Array([1]))
    },
    cancel() {
      isCanceled = true
    },
  })
  await assert.rejects(parse(raw({ body }), { timeoutMs: 22 }), { code: 'HTTP_REQUEST_TIMEOUT' })
  assert.equal(isCanceled, true)
  assert.equal(body.locked, false)
})

test('business unsupported content type describes both JSON and multipart rather than requiring JSON', async () => {
  const { businessErrorResponse } = await import('../src/creation/http/business-errors.ts')
  const { HttpRequestError } = await import('../src/creation/http/request.ts')
  const response = businessErrorResponse({
    error: new HttpRequestError({ code: 'HTTP_UNSUPPORTED_MEDIA_TYPE' }),
    requestId: 'fixture',
  })
  assert.equal((await response.json()).error.message, 'Unsupported request media type.')
})
