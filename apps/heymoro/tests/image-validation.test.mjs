import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { deflateSync, inflateSync } from 'node:zlib'
import sharp from 'sharp'

const adapter = () => import('../src/creation/infrastructure/image/sharp-image-validator.ts')
const limits = {
  allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
  maxBytes: 100_000,
  maxPixels: 100_000,
  timeoutMs: 1000,
}
const png = () =>
  sharp({ create: { background: '#cc4444', channels: 3, height: 2, width: 3 } })
    .png()
    .toBuffer()

for (const target of ['domain/image', 'application/media', 'application/generation-worker']) {
  void test(`should load actual ${target} in a fresh process with a self-proven native dependency guard`, () => {
    const url = new URL(`../src/creation/${target}.ts`, import.meta.url).href
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
        import assert from 'node:assert/strict'
        import { createRequire, registerHooks } from 'node:module'
        const target = ${JSON.stringify(url)}
        const domain = ${JSON.stringify(target === 'domain/image')}
        let guarded = 0
        const hook = registerHooks({ resolve(specifier, context, next) {
          if (specifier === 'sharp' || specifier.includes('/infrastructure/') ||
              (domain && context.parentURL === target)) {
            guarded++
            throw new Error('IMAGE_DEPENDENCY_GUARD')
          }
          return next(specifier, context)
        } })
        try {
          await assert.rejects(async () => import('sharp'), /IMAGE_DEPENDENCY_GUARD/)
          assert.equal(guarded, 1)
          await assert.rejects(async () => import(new URL('../infrastructure/image/sharp-image-validator.ts', target).href), /IMAGE_DEPENDENCY_GUARD/)
          assert.equal(guarded, 2)
          if (domain) assert.throws(() => createRequire(target)('node:crypto'), /IMAGE_DEPENDENCY_GUARD/)
          const proven = domain ? 3 : 2
          assert.equal(guarded, proven)
          console.log('IMAGE_GUARD_PROVEN')
          const actual = await import(target)
          assert.equal(guarded, proven, 'actual module reached forbidden runtime dependency')
          if (domain) assert.deepEqual(Object.keys(actual), ['validateImageLimits'])
          else assert.equal(typeof actual[${JSON.stringify(target === 'application/media' ? 'createMediaService' : 'createGenerationWorker')}], 'function')
          console.log('IMAGE_BOUNDARY_OK')
        } finally { hook.deregister() }
      `,
      ],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15_000 },
    )
    assert.match(child.stdout, /IMAGE_GUARD_PROVEN/, child.stderr)
    assert.equal(child.status, 0, child.stderr || child.stdout)
    assert.equal(child.signal, null)
    assert.match(child.stdout, /IMAGE_BOUNDARY_OK/)
  })
}

void test('should expose the concrete image validator from its infrastructure adapter', async () => {
  assert.equal(typeof (await adapter()).validateImage, 'function')
})

for (const [filename, name] of [
  ['media', 'createMediaService'],
  ['generation-worker', 'createGenerationWorker'],
]) {
  void test(`should reject absent and nonfunction ${filename} validators before configuration access`, async () => {
    const factory = (await import(`../src/creation/application/${filename}.ts`))[name]
    for (const validateImage of [undefined, null, {}, 1, 'validator']) {
      const options = new Proxy(
        { validateImage },
        {
          get(target, property) {
            // Argument capture can read other keys, but configuration must not be used yet.
            if (property === 'validateImage') {
              return target.validateImage
            }
            return undefined
          },
        },
      )
      assert.throws(() => factory(options), /Explicit image validator required\./)
    }
    assert.throws(() => factory({}), /Explicit image validator required\./)
  })
}

for (const [format, mimeType] of [
  ['png', 'image/png'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
]) {
  void test(`should fully decode real ${format} bytes and retain their exact fingerprint`, async () => {
    const input = await sharp(await png())
      [format]()
      .toBuffer()
    const { validateImage } = await adapter()
    const verified = await validateImage({
      declaredMimeType: ` ${mimeType.toUpperCase()} ; fixture=value `,
      input,
      limits,
    })
    assert.equal(verified.mimeType, mimeType)
    assert.equal(verified.width, 3)
    assert.equal(verified.height, 2)
    assert.equal(verified.filesize, input.length)
    assert.equal(verified.sha256, createHash('sha256').update(input).digest('hex'))
    assert.deepEqual(verified.bytes, input)
    assert(Object.isFrozen(verified))
    assert.deepEqual(
      (await validateImage({ declaredMimeType: 'application/octet-stream', input, limits })).bytes,
      input,
    )
    if (format === 'webp') {
      await assert.rejects(
        validateImage({ input, limits: { ...limits, allowedMimeTypes: ['image/png'] } }),
        /Unsupported image format/,
      )
    }
  })
}

void test('should reject a real truncated PNG that metadata alone accepts', async () => {
  const input = (await png()).subarray(0, 63)
  const metadata = await sharp(input, { failOn: 'warning' }).metadata()
  assert.equal(metadata.width, 3)
  assert.equal(metadata.height, 2)
  await assert.rejects(sharp(input, { failOn: 'warning' }).raw().toBuffer())
  const { validateImage } = await adapter()
  await assert.rejects(validateImage({ input, limits }))
})

void test('should reject wrong declared MIME and real animated WebP', async () => {
  const { validateImage } = await adapter()
  await assert.rejects(
    validateImage({ declaredMimeType: 'image/jpeg', input: await png(), limits }),
    /Declared image MIME does not match actual bytes\./,
  )
  const frames = Buffer.alloc(3 * 4 * 3, 10)
  frames.fill(220, 3 * 2 * 3)
  const animated = await sharp(frames, {
    raw: { channels: 3, height: 4, pageHeight: 2, width: 3 },
  })
    .webp({ loop: 0 })
    .toBuffer()
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2)
  await assert.rejects(validateImage({ input: animated, limits }), /Unsupported image format/)
})

void test('should enforce real pixel byte and empty input bounds', async () => {
  const { validateImage } = await adapter()
  const input = await png()
  assert.equal((await validateImage({ input, limits: { ...limits, maxPixels: 6 } })).width, 3)
  await assert.rejects(validateImage({ input, limits: { ...limits, maxPixels: 5 } }))
  assert.equal(
    (await validateImage({ input, limits: { ...limits, maxBytes: input.length } })).filesize,
    input.length,
  )
  await assert.rejects(
    validateImage({ input, limits: { ...limits, maxBytes: input.length - 1 } }),
    /Image byte limit exceeded or empty image\./,
  )
  await assert.rejects(
    validateImage({ input: new Uint8Array(), limits }),
    /Image byte limit exceeded or empty image\./,
  )
})

void test('should detach synchronous input before awaiting and return fresh immutable getter aliases', async () => {
  const { validateImage } = await adapter()
  const original = await png()
  const input = new Uint8Array(original)
  const pending = validateImage({ input, limits })
  input.fill(0)
  const verified = await pending
  assert.deepEqual(verified.bytes, original)
  const first = verified.bytes
  first.fill(0)
  assert.notEqual(first, verified.bytes)
  assert.deepEqual(verified.bytes, original)
  const descriptor = Object.getOwnPropertyDescriptor(verified, 'bytes')
  assert('get' in descriptor)
  assert.equal(Object.hasOwn(descriptor, 'value'), false)
  assert.equal(Reflect.get(descriptor, 'set'), undefined)
  assert.equal(descriptor.configurable, false)
  assert.throws(() => {
    verified.bytes = Buffer.alloc(1)
  }, TypeError)
})

void test('should copy real streamed chunks and close the iterator on success overflow and invalid chunks', async () => {
  const { validateImage } = await adapter()
  const original = await png()
  for (const kind of ['success', 'overflow', 'invalid', 'empty']) {
    let nexts = 0
    let returns = 0
    const first = Buffer.from(original.subarray(0, 60))
    const second = Buffer.from(original.subarray(60))
    const input = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            await Promise.resolve()
            nexts++
            if (kind === 'empty') {
              return { done: true }
            }
            if (nexts === 1) {
              return { done: false, value: kind === 'invalid' ? 'bad chunk' : first }
            }
            if (nexts === 2) {
              first.fill(0)
              return { done: false, value: second }
            }
            second.fill(0)
            return { done: true }
          },
          return() {
            returns++
            return Promise.resolve({ done: true })
          },
        }
      },
    }
    const pending = validateImage({
      input,
      limits: { ...limits, maxBytes: kind === 'overflow' ? 70 : limits.maxBytes },
    })
    if (kind === 'success') {
      assert.deepEqual((await pending).bytes, original)
    } else {
      await assert.rejects(
        pending,
        kind === 'overflow'
          ? /Image byte limit exceeded\./
          : kind === 'invalid'
            ? /Invalid image stream chunk\./
            : /empty image/,
      )
    }
    assert.equal(returns, 1)
  }
})

void test('should time out a stalled real iterator without awaiting hostile return cleanup', async () => {
  const { validateImage } = await adapter()
  let returns = 0
  let resume
  const input = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise((resolve) => {
            resume = resolve
          }),
        return: () => {
          returns++
          return new Promise(() => {})
        },
      }
    },
  }
  await assert.rejects(
    validateImage({ input, limits: { ...limits, timeoutMs: 20 } }),
    /Image stream deadline exceeded\./,
  )
  assert.equal(returns, 1)
  resume({ done: false, value: await png() })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(returns, 1)
})

void test('should preserve separate stream and decoder budgets and clear both actual timers', async () => {
  const { validateImage } = await adapter()
  const inputBytes = await png()
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const scheduled = []
  const cleared = []
  // Observe timer lifecycle only; actual sharp decoding and host timers remain in use.
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = originalSet(callback, delay, ...args)
    if (delay === 451) {
      scheduled.push(timer)
    }
    return timer
  }
  globalThis.clearTimeout = (timer) => {
    if (scheduled.includes(timer)) {
      cleared.push(timer)
    }
    return originalClear(timer)
  }
  try {
    const input = (async function* () {
      await Promise.resolve()
      yield inputBytes
    })()
    assert.deepEqual(
      (await validateImage({ input, limits: { ...limits, timeoutMs: 451 } })).bytes,
      inputBytes,
    )
    assert.equal(scheduled.length, 2)
    assert.deepEqual(cleared, scheduled)
  } finally {
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
    for (const timer of scheduled) {
      originalClear(timer)
    }
  }
})

void test('should destroy the decoder and clear its timer under controlled metadata failure and deadline probes', async () => {
  const { validateImage } = await adapter()
  const input = await png()
  const originalMetadata = sharp.prototype.metadata
  const originalDestroy = sharp.prototype.destroy
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  // Only this probe controls metadata settlement and timer delivery. It does not prove a real codec deadline.
  for (const mode of ['success', 'failure', 'deadline']) {
    const failure = new Error('controlled metadata failure')
    let destroyed = 0
    let timer
    let deliver
    const cleared = []
    sharp.prototype.metadata = function (...args) {
      if (mode === 'success') {
        return originalMetadata.apply(this, args)
      }
      return mode === 'failure' ? Promise.reject(failure) : new Promise(() => {})
    }
    sharp.prototype.destroy = function (...args) {
      destroyed++
      return originalDestroy.apply(this, args)
    }
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay !== 452) {
        return originalSet(callback, delay, ...args)
      }
      deliver = callback
      timer = originalSet(() => {}, 60_000)
      return timer
    }
    globalThis.clearTimeout = (value) => {
      cleared.push(value)
      return originalClear(value)
    }
    try {
      const pending = validateImage({ input, limits: { ...limits, timeoutMs: 452 } })
      await Promise.resolve()
      assert.equal(typeof deliver, 'function')
      if (mode === 'deadline') {
        deliver()
      }
      if (mode === 'success') {
        assert.deepEqual((await pending).bytes, input)
      } else {
        await assert.rejects(
          pending,
          mode === 'failure' ? (error) => error === failure : /Image decode deadline exceeded\./,
        )
      }
      assert.equal(destroyed, mode === 'deadline' ? 2 : 1)
      assert(cleared.includes(timer))
    } finally {
      sharp.prototype.metadata = originalMetadata
      sharp.prototype.destroy = originalDestroy
      globalThis.setTimeout = originalSet
      globalThis.clearTimeout = originalClear
      originalClear(timer)
    }
  }
})

void test('should invoke an injected real media verifier after account read and before storage outside writes', async () => {
  const { createMediaService } = await import('../src/creation/application/media.ts')
  const { validateImage } = await adapter()
  const original = await png()
  const input = Buffer.from(original)
  const calls = []
  const sentinel = new Error('verified storage boundary')
  const service = createMediaService({
    clock: () => '2026-11-14T00:00:00.000Z',
    destination: { backend: 'fixture', bucket: 'fixture' },
    imageLimits: limits,
    isCommitUnknown: () => false,
    read: async ({ work }) => {
      calls.push('read')
      input.fill(0)
      return work({ repository: { isAccountActive: () => Promise.resolve(true) } })
    },
    storage: {
      putImmutable: ({ bytes }) => {
        calls.push('storage')
        assert.deepEqual(bytes, original)
        return Promise.reject(sentinel)
      },
    },
    validateImage: async (args) => {
      calls.push('validate')
      assert.deepEqual(args.input, original)
      return validateImage(args)
    },
    write: () => {
      assert.fail('verification and storage must precede write')
    },
  })
  await assert.rejects(
    service.uploadForUser({ input, originalName: 'image.png', userId: 1 }),
    (error) => error === sentinel,
  )
  assert.deepEqual(calls, ['read', 'validate', 'storage'])
})

const twoFrameAPNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAABAAAAAQAAAAAAAAAAAAAEABQAAuMm7CAAAAHxJREFUeJzVzkERADAIwLCu/j0zETy4RkHe0CZxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEud1YOsDUoUBf30Ui34AAAAaZmNUTAAAAAEAAABAAAAAQAAAAAAAAAAAAAEABQAAI7pR3AAAAIBmZEFUAAAAAnic1c5BEQAwCMCwrv49MxE8uEZBHgxlEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxXge2PlCHAX9FpNMhAAAAAElFTkSuQmCC',
  'base64',
)

function pngChunk({ type, data = Buffer.alloc(0) }) {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length)
  bytes.write(type, 4, 4, 'ascii')
  data.copy(bytes, 8)
  let crc = 0xffffffff
  for (let index = 4; index < data.length + 8; index++) {
    crc ^= bytes[index]
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8)
  return bytes
}
function staticPNG() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(4)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk({ type: 'IHDR', data: header }),
    pngChunk({
      type: 'IDAT',
      data: deflateSync(Buffer.concat([Buffer.from([0]), Buffer.from('acTLfcTLfdAT')]), {
        level: 0,
      }),
    }),
    pngChunk({ type: 'IEND' }),
  ])
}

function pngChunks(bytes) {
  const chunks = []
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const original = bytes.subarray(offset, offset + 12 + length)
    assert.deepEqual(original, pngChunk({ type, data }), `independent CRC for ${type}`)
    chunks.push({ type, data, bytes: original })
    offset += length + 12
  }
  return chunks
}
void test('should independently establish the valid two-frame 417-byte APNG hidden by Sharp metadata', async () => {
  assert.equal(twoFrameAPNG.length, 417)
  assert.equal(
    createHash('sha256').update(twoFrameAPNG).digest('hex'),
    'c09fe07b42fa5a21f2328b5f71429c7f0118a2c88ad42e850d476a0e42103e8c',
  )
  const metadata = await sharp(twoFrameAPNG, { animated: true }).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.pages, undefined)
  const chunks = pngChunks(twoFrameAPNG)
  assert.equal(chunks.find(({ type }) => type === 'acTL').data.readUInt32BE(0), 2)
  assert.deepEqual(
    chunks
      .filter(({ type }) => ['fcTL', 'fdAT'].includes(type))
      .map(({ data }) => data.readUInt32BE(0)),
    [0, 1, 2],
  )
  const first = inflateSync(
    Buffer.concat(chunks.filter(({ type }) => type === 'IDAT').map(({ data }) => data)),
  )
  const second = inflateSync(
    Buffer.concat(chunks.filter(({ type }) => type === 'fdAT').map(({ data }) => data.subarray(4))),
  )
  assert.equal(first.length, 12352)
  assert.equal(second.length, 12352)
  assert.notDeepEqual(first, second)
  assert.equal((await sharp(twoFrameAPNG).raw().toBuffer()).length, 64 * 64 * 3)
})
for (const declaredMimeType of [undefined, 'image/png', 'application/octet-stream']) {
  for (const isStream of [false, true]) {
    void test(`should reject valid two-frame APNG ${isStream ? 'stream' : 'Buffer'} with MIME ${declaredMimeType}`, async () => {
      const { validateImage } = await adapter()
      const before = Buffer.from(twoFrameAPNG)
      let returns = 0
      const input = isStream
        ? {
            [Symbol.asyncIterator]() {
              let offset = 0
              return {
                next() {
                  if (offset === twoFrameAPNG.length) return Promise.resolve({ done: true })
                  const value = twoFrameAPNG.subarray(
                    offset,
                    Math.min(offset + 47, twoFrameAPNG.length),
                  )
                  offset += value.length
                  return Promise.resolve({ done: false, value })
                },
                return() {
                  returns++
                  return Promise.resolve({ done: true })
                },
              }
            },
          }
        : twoFrameAPNG
      try {
        await assert.rejects(
          validateImage({ input, declaredMimeType, limits }),
          /Animated PNG is unsupported\./,
        )
      } finally {
        assert.deepEqual(twoFrameAPNG, before)
        assert.equal(returns, isStream ? 1 : 0)
      }
    })
  }
}

const policy = () => import('../src/creation/infrastructure/image/png-single-frame-policy.mjs')
const pngEnvelope = (...chunks) =>
  Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks])

void test('should accept static IDAT animation-name bytes with the pure policy and real Buffer and stream decoding', async () => {
  const bytes = staticPNG()
  const original = Buffer.from(bytes)
  assert.equal(bytes.length, 81)
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'b00d2160f3fc9959fbcca390362057901d15a120eff8beb3bd90742c9ab4f8d9',
  )
  assert(bytes.includes(Buffer.from('acTLfcTLfdAT')))
  assert.equal((await sharp(bytes).raw().toBuffer()).length, 12)
  const { assertSingleFramePNG } = await policy()
  assert.equal(assertSingleFramePNG({ bytes, assertDeadline: () => {} }), undefined)
  const { validateImage } = await adapter()
  for (const isStream of [false, true]) {
    const input = isStream
      ? (async function* () {
          await Promise.resolve()
          yield bytes.subarray(0, 40)
          yield bytes.subarray(40)
        })()
      : bytes
    const verified = await validateImage({ input, limits })
    assert.deepEqual(verified.bytes, original)
    assert.equal(verified.sha256, createHash('sha256').update(original).digest('hex'))
    verified.bytes.fill(0)
    assert.deepEqual(verified.bytes, original)
  }
  assert.deepEqual(bytes, original)
})

void test('should enforce PNG envelope bounds order CRC critical chunks and exact termination', async () => {
  const { assertSingleFramePNG } = await policy()
  const [header, data, end] = pngChunks(staticPNG()).map(({ bytes }) => bytes)
  const ancillary = pngChunk({ type: 'vpAg', data: Buffer.from('control') })
  const corrupt = Buffer.from(ancillary)
  corrupt[corrupt.length - 1] ^= 1
  const longLength = Buffer.alloc(12)
  longLength.writeUInt32BE(0x80000000)
  const pastBounds = Buffer.alloc(12)
  pastBounds.writeUInt32BE(100)
  const palette = pngChunk({ type: 'PLTE', data: Buffer.from([1, 2, 3]) })
  const invalid = [
    ['wrong signature', Buffer.alloc(8), /Invalid PNG signature/],
    ['short signature', Buffer.alloc(7), /Invalid PNG signature/],
    ['short chunk header', pngEnvelope(Buffer.alloc(11)), /Truncated PNG chunk/],
    ['uint32 length', pngEnvelope(longLength), /PNG chunk exceeds input bounds/],
    ['length past input', pngEnvelope(pastBounds), /PNG chunk exceeds input bounds/],
    ['type character', pngEnvelope(pngChunk({ type: 'a1Cd' })), /Invalid PNG chunk type/],
    ['reserved type bit', pngEnvelope(pngChunk({ type: 'abca' })), /Invalid PNG chunk type/],
    ['ancillary CRC', pngEnvelope(header, corrupt, data, end), /Invalid PNG chunk CRC/],
    ['nonfirst header', pngEnvelope(ancillary, header, data, end), /PNG header must be first/],
    ['duplicate header', pngEnvelope(header, header, data, end), /Invalid PNG header/],
    [
      'short header',
      pngEnvelope(pngChunk({ type: 'IHDR', data: Buffer.alloc(12) }), data, end),
      /Invalid PNG header/,
    ],
    ['duplicate palette', pngEnvelope(header, palette, palette, data, end), /Invalid PNG palette/],
    ['late palette', pngEnvelope(header, data, palette, end), /Invalid PNG palette/],
    [
      'empty palette',
      pngEnvelope(header, pngChunk({ type: 'PLTE' }), data, end),
      /Invalid PNG palette/,
    ],
    [
      'large palette',
      pngEnvelope(header, pngChunk({ type: 'PLTE', data: Buffer.alloc(771) }), data, end),
      /Invalid PNG palette/,
    ],
    [
      'unaligned palette',
      pngEnvelope(header, pngChunk({ type: 'PLTE', data: Buffer.alloc(4) }), data, end),
      /Invalid PNG palette/,
    ],
    [
      'separated IDAT',
      pngEnvelope(header, data, ancillary, data, end),
      /PNG image data chunks must be consecutive/,
    ],
    ['end without data', pngEnvelope(header, end), /Invalid PNG end or trailing bytes/],
    [
      'nonempty end',
      pngEnvelope(header, data, pngChunk({ type: 'IEND', data: Buffer.from([0]) })),
      /Invalid PNG end or trailing bytes/,
    ],
    ['missing end', pngEnvelope(header, data), /Missing PNG end chunk/],
    ['duplicate end', pngEnvelope(header, data, end, end), /Invalid PNG end or trailing bytes/],
    [
      'trailing bytes',
      pngEnvelope(header, data, end, Buffer.from('trailing')),
      /Invalid PNG end or trailing bytes/,
    ],
    [
      'critical chunk',
      pngEnvelope(header, pngChunk({ type: 'ABCD' }), data, end),
      /Unknown critical PNG chunk/,
    ],
  ]
  for (const [name, bytes, message] of invalid) {
    assert.throws(() => assertSingleFramePNG({ bytes, assertDeadline: () => {} }), message, name)
  }
  for (const type of ['acTL', 'fcTL', 'fdAT']) {
    for (const chunks of [
      [pngChunk({ type }), header, data, end],
      [header, pngChunk({ type }), data, end],
      [header, data, pngChunk({ type }), end],
    ]) {
      assert.throws(
        () => assertSingleFramePNG({ bytes: pngEnvelope(...chunks), assertDeadline: () => {} }),
        /Animated PNG is unsupported/,
      )
    }
  }
  const accepted = pngEnvelope(header, ancillary, data, end)
  assert.equal(assertSingleFramePNG({ bytes: accepted, assertDeadline: () => {} }), undefined)
  assert.equal((await sharp(accepted).raw().toBuffer()).length, 12)
  assert.equal(
    assertSingleFramePNG({
      bytes: pngEnvelope(header, palette, data, end),
      assertDeadline: () => {},
    }),
    undefined,
  )
})

void test('should allow thousands of consecutive empty IDAT chunks under the ordinary shared byte limit', async () => {
  const { assertSingleFramePNG } = await policy()
  const [header, data, end] = pngChunks(staticPNG()).map(({ bytes }) => bytes)
  const bytes = pngEnvelope(
    header,
    ...Array.from({ length: 5000 }, () => pngChunk({ type: 'IDAT' })),
    data,
    end,
  )
  assert.equal(bytes.length, 60081)
  assert.equal((await sharp(bytes).raw().toBuffer()).length, 12)
  let checkpoints = 0
  assertSingleFramePNG({
    bytes,
    assertDeadline: () => {
      checkpoints++
    },
  })
  assert(checkpoints >= 5003)
  const { validateImage } = await adapter()
  assert.deepEqual((await validateImage({ input: bytes, limits })).bytes, bytes)
})

void test('should bound helper bytes before CRC work and preserve callback sentinels at every work boundary', async () => {
  const { assertSingleFramePNG } = await policy()
  let calls = 0
  const count = () => {
    calls++
  }
  for (const bytes of [new Uint8Array(8), null, Buffer.alloc(32 * 1024 * 1024 + 1)]) {
    calls = 0
    assert.throws(
      () => assertSingleFramePNG({ bytes, assertDeadline: count }),
      /PNG input exceeds supported bounds/,
    )
    assert.equal(calls, 1)
  }
  const [header, data, end] = pngChunks(staticPNG()).map(({ bytes }) => bytes)
  const large = pngEnvelope(
    header,
    pngChunk({ type: 'vpAg', data: Buffer.alloc(40000) }),
    data,
    end,
  )
  for (const stopAt of [1, 2, 6]) {
    const sentinel = new Error(`checkpoint ${stopAt}`)
    calls = 0
    assert.throws(
      () =>
        assertSingleFramePNG({
          bytes: large,
          assertDeadline: () => {
            if (++calls === stopAt) throw sentinel
          },
        }),
      (error) => error === sentinel,
    )
    assert.equal(calls, stopAt)
  }
  // Entry=1, IHDR boundary/CRC=2/3, large ancillary boundary/CRC=4/5;
  // callback 6 is inside that one chunk after 16,384 CRC input bytes.
  calls = 0
  const tiny = pngEnvelope(
    header,
    ...Array.from({ length: 200 }, () => pngChunk({ type: 'IDAT' })),
    data,
    end,
  )
  const tinySentinel = new Error('tiny chunk boundary')
  assert.throws(
    () =>
      assertSingleFramePNG({
        bytes: tiny,
        assertDeadline: () => {
          if (++calls === 100) throw tinySentinel
        },
      }),
    (error) => error === tinySentinel,
  )
  assert.equal(calls, 100)
  calls = 0
  assertSingleFramePNG({ bytes: staticPNG(), assertDeadline: count })
  const finalCheckpoint = calls
  calls = 0
  const finalSentinel = new Error('successful return checkpoint')
  assert.throws(
    () =>
      assertSingleFramePNG({
        bytes: staticPNG(),
        assertDeadline: () => {
          if (++calls === finalCheckpoint) throw finalSentinel
        },
      }),
    (error) => error === finalSentinel,
  )
  assert.equal(calls, finalCheckpoint)
  const { validateImage } = await adapter()
  await assert.rejects(
    validateImage({ input: staticPNG(), limits: { ...limits, maxBytes: 80 } }),
    /Image byte limit exceeded or empty image/,
  )
})

void test('should map actual APNG media upload rejection to INVALID_MEDIA before storage or writes', async () => {
  const { createMediaService, MediaError } = await import('../src/creation/application/media.ts')
  const { validateImage } = await adapter()
  let reads = 0
  const service = createMediaService({
    clock: () => '2026-11-15T00:00:00.000Z',
    destination: { backend: 'fixture', bucket: 'fixture' },
    imageLimits: limits,
    isCommitUnknown: () => false,
    read: ({ work }) => {
      reads++
      return work({ repository: { isAccountActive: () => Promise.resolve(true) } })
    },
    storage: {
      putImmutable: () => {
        assert.fail('APNG must never reach object storage')
      },
    },
    validateImage,
    write: () => {
      assert.fail('APNG must never reach database writes')
    },
  })
  await assert.rejects(
    service.uploadForUser({ input: twoFrameAPNG, originalName: 'animated.png', userId: 1 }),
    (error) => error instanceof MediaError && error.code === 'INVALID_MEDIA',
  )
  assert.equal(reads, 1)
})

void test('should keep PNG envelope work inside the one decoder-phase monotonic deadline', async () => {
  const { validateImage } = await adapter()
  const input = staticPNG()
  const originalDescriptor = Object.getOwnPropertyDescriptor(performance, 'now')
  const originalMetadata = sharp.prototype.metadata
  const originalRaw = sharp.prototype.raw
  // This controls the monotonic clock only; metadata remains a real Sharp call.
  // It verifies phase-budget accounting, not a native codec wall-clock timeout.
  for (const expiresAt of ['metadata', 'policy', 'acceptance']) {
    let now = 1000
    let rawCalls = 0
    let isDecoded = false
    let afterDecodeChecks = 0
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => {
        if (isDecoded && ++afterDecodeChecks === 2) return 2000
        return now++
      },
    })
    sharp.prototype.metadata = async function (...args) {
      const actual = await originalMetadata.apply(this, args)
      if (expiresAt !== 'acceptance') now = expiresAt === 'metadata' ? 2000 : 1997
      return actual
    }
    sharp.prototype.raw = function (...args) {
      rawCalls++
      const decoder = originalRaw.apply(this, args)
      const originalToBuffer = decoder.toBuffer
      decoder.toBuffer = function (...bufferArgs) {
        return originalToBuffer.apply(this, bufferArgs).then((actual) => {
          isDecoded = true
          return actual
        })
      }
      return decoder
    }
    try {
      await assert.rejects(validateImage({ input, limits }), /Image decode deadline exceeded\./)
      assert.equal(rawCalls, expiresAt === 'acceptance' ? 1 : 0)
      if (expiresAt === 'acceptance') assert.equal(afterDecodeChecks, 2)
    } finally {
      sharp.prototype.metadata = originalMetadata
      sharp.prototype.raw = originalRaw
      if (originalDescriptor) Object.defineProperty(performance, 'now', originalDescriptor)
      else delete performance.now
    }
  }
})
