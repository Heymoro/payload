import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { afterEach, describe, expect, test } from 'vitest'

import { validateImage } from '../../src/creation/infrastructure/image/sharp-image-validator.js'
import { createS3ObjectStorage } from '../../src/creation/infrastructure/s3/object-storage.js'
import { startS3HTTPFixture } from './s3-http-fixture.js'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close()
  }
})
const caps = {
  allowedMimeTypes: ['image/png', 'image/jpeg'],
  maxBytes: 100_000,
  maxPixels: 100_000,
  timeoutMs: 1000,
}
const png = () =>
  sharp({ create: { background: '#cc4444', channels: 3, height: 2, width: 3 } })
    .png()
    .toBuffer()
async function fixture() {
  const http = await startS3HTTPFixture()
  closers.push(http.close)
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
    image: caps,
    limits: {
      connectionTimeoutMs: 100,
      maxBytes: 100_000,
      operationTimeoutMs: 1500,
      requestTimeoutMs: 300,
    },
  })
  closers.push(async () => storage.close())
  return {
    http,
    ref: {
      backend: 'fixture',
      bucket: 'owned-bucket',
      key: `references/1/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/${'a'.repeat(64)}`,
    },
    storage,
  }
}
describe('bounded actual image decoding', () => {
  test('infers actual facts and preserves original visual bytes, copying mutable input', async () => {
    const input = await png()
    const original = Buffer.from(input)
    const pending = validateImage({
      declaredMimeType: 'application/octet-stream',
      input,
      limits: caps,
    })
    input.fill(0)
    const facts = await pending
    expect(facts).toMatchObject({
      filesize: original.length,
      height: 2,
      mimeType: 'image/png',
      sha256: createHash('sha256').update(original).digest('hex'),
      width: 3,
    })
    expect(facts.bytes).toEqual(original)
  })
  test('rejects empty, excess bytes, wrong MIME, truncated decode, pixel bombs, animation and unsupported formats', async () => {
    const bytes = await png()
    for (const args of [
      { input: Buffer.alloc(0) },
      { input: bytes, limits: { ...caps, maxBytes: 2 } },
      { declaredMimeType: 'image/jpeg', input: bytes },
      { input: bytes.subarray(0, bytes.length - 15) },
      { input: bytes, limits: { ...caps, maxPixels: 2 } },
      {
        input: await sharp({ create: { background: 'blue', channels: 3, height: 4, width: 2 } })
          .gif()
          .toBuffer(),
      },
      { input: Buffer.from('<svg width="1" height="1"></svg>') },
    ]) {
      await expect(validateImage({ limits: caps, ...args })).rejects.toThrow()
    }
  })
  test('accepts real JPEG and explicitly enabled still WebP but rejects actual multi-frame WebP', async () => {
    const source = await png()
    const jpeg = await sharp(source).jpeg().toBuffer()
    expect(
      await validateImage({ declaredMimeType: 'image/jpeg', input: jpeg, limits: caps }),
    ).toMatchObject({ bytes: jpeg, mimeType: 'image/jpeg' })
    const webp = await sharp(source).webp().toBuffer()
    const webpLimits = { ...caps, allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] }
    expect(await validateImage({ input: webp, limits: webpLimits })).toMatchObject({
      height: 2,
      mimeType: 'image/webp',
      width: 3,
    })
    const animated = await sharp(Buffer.concat([Buffer.alloc(12, 40), Buffer.alloc(12, 220)]), {
      raw: { channels: 3, height: 4, pageHeight: 2, width: 2 },
    })
      .webp()
      .toBuffer()
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2)
    await expect(validateImage({ input: animated, limits: webpLimits })).rejects.toThrow(
      /animation/,
    )
  })
  test('bounds streams and stalled producers, closes oversized producer', async () => {
    let closed = false
    async function* input() {
      try {
        yield Buffer.alloc(70_000)
        yield Buffer.alloc(70_000)
      } finally {
        closed = true
      }
    }
    await expect(validateImage({ input: input(), limits: caps })).rejects.toThrow()
    expect(closed).toBe(true)
    async function* stalled() {
      await new Promise(() => {})
      yield Buffer.alloc(1)
    }
    await expect(
      validateImage({ input: stalled(), limits: { ...caps, timeoutMs: 30 } }),
    ).rejects.toThrow(/deadline/)
  })
})
describe('actual AWS SDK over owned HTTP fault fixture', () => {
  test('rejects every omitted or undefined required S3 budget before any HTTP operation', async () => {
    const http = await startS3HTTPFixture()
    closers.push(http.close)
    const valid = {
      connectionTimeoutMs: 100,
      maxBytes: 100_000,
      operationTimeoutMs: 1500,
      requestTimeoutMs: 300,
    }
    for (const field of Object.keys(valid) as (keyof typeof valid)[]) {
      for (const mode of ['omit', 'undefined'] as const) {
        const limits: Partial<typeof valid> = { ...valid }
        if (mode === 'omit') {
          delete limits[field]
        } else {
          limits[field] = undefined
        }
        expect(() => {
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
            image: caps,
            limits: limits as typeof valid,
          })
          storage.close()
        }, `${field} ${mode}`).toThrow(/Explicit bounded S3 limits/)
      }
    }
    expect(http.requests).toHaveLength(0)
  })

  test('requires capability verification; conditional puts and byte-proven replay never overwrite conflicts', async () => {
    const { http, ref, storage } = await fixture()
    const bytes = await png()
    await expect(
      storage.putImmutable({ bytes, contentType: 'image/png', ref }),
    ).rejects.toMatchObject({ code: 'UNVERIFIED_BACKEND' })
    await storage.verifyBackend({ backend: ref.backend, bucket: ref.bucket })
    const first = await storage.putImmutable({ bytes, contentType: 'image/png', ref })
    expect(first.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(await storage.putImmutable({ bytes, contentType: 'image/png', ref })).toEqual(first)
    http.setConflict(409)
    expect(await storage.putImmutable({ bytes, contentType: 'image/png', ref })).toEqual(first)
    await expect(
      storage.putImmutable({
        bytes: await sharp({ create: { background: 'green', channels: 3, height: 2, width: 3 } })
          .png()
          .toBuffer(),
        contentType: 'image/png',
        ref,
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_CONFLICT' })
    expect(http.objects.get(ref.key)!.bytes).toEqual(bytes)
    expect(
      http.requests
        .filter((request) => request.method === 'PUT')
        .every((request) => request.conditional === '*'),
    ).toBe(true)
    expect(http.requests.some((request) => request.method === 'HEAD')).toBe(false)
  })
  test('rejects invalid or oversized new images before a network write and freezes mutable bytes across awaits', async () => {
    const { http, ref, storage } = await fixture()
    await storage.verifyBackend({ backend: ref.backend, bucket: ref.bucket })
    const requestCount = http.requests.length
    await expect(
      storage.putImmutable({ bytes: Buffer.alloc(100_001), contentType: 'image/png', ref }),
    ).rejects.toThrow()
    await expect(
      storage.putImmutable({ bytes: Buffer.from('not an image'), contentType: 'image/png', ref }),
    ).rejects.toThrow()
    expect(http.requests).toHaveLength(requestCount)
    const mutable = await png()
    const original = Buffer.from(mutable)
    const pending = storage.putImmutable({ bytes: mutable, contentType: 'image/png', ref })
    mutable.fill(0)
    await pending
    expect(http.objects.get(ref.key)!.bytes).toEqual(original)
  })
  test('rejects a backend that ignores conditional headers, before any media write', async () => {
    const { http, ref, storage } = await fixture()
    http.setFault('ignored-condition')
    await expect(
      storage.verifyBackend({ backend: ref.backend, bucket: ref.bucket }),
    ).rejects.toMatchObject({ code: 'UNSAFE_BACKEND' })
    await expect(
      storage.putImmutable({ bytes: await png(), contentType: 'image/png', ref }),
    ).rejects.toMatchObject({ code: 'UNVERIFIED_BACKEND' })
    expect(http.objects.has(ref.key)).toBe(false)
  })
  test('resolves lost PUT acknowledgement by exact byte read, not forged metadata', async () => {
    const { http, ref, storage } = await fixture()
    await storage.verifyBackend({ backend: ref.backend, bucket: ref.bucket })
    const bytes = await png()
    http.setFault('ack-lost')
    const facts = await storage.putImmutable({ bytes, contentType: 'image/png', ref })
    expect(facts.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(await storage.getVerified({ expected: facts, ref })).toMatchObject({ bytes })
  })
  test('distinguishes missing, forbidden and unknown; cancels oversized or interrupted GET', async () => {
    const { http, ref, storage } = await fixture()
    await expect(storage.getVerified({ ref })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    http.setFault('forbidden')
    await expect(storage.getVerified({ ref })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    http.setFault('none')
    http.objects.set(ref.key, { type: 'image/png', bytes: await png() })
    for (const [fault, code] of [
      ['oversize', 'CONTENT_CONFLICT'],
      ['truncated', 'UNKNOWN'],
      ['hang', 'UNKNOWN'],
    ] as const) {
      http.setFault(fault)
      await expect(storage.getVerified({ ref })).rejects.toMatchObject({ code })
    }
  })
  test('lists only precise committed task/attempt destination and rejects incomplete pagination', async () => {
    const { http, storage } = await fixture()
    const bytes = await png()
    const sha = createHash('sha256').update(bytes).digest('hex')
    http.objects.set(`tasks/4/attempts/7/result-${sha}`, { type: 'image/png', bytes })
    const args = {
      attemptId: 7,
      maxBytes: 100_000,
      maxCandidates: 3,
      maxPages: 3,
      storageOutput: {
        backend: 'fixture',
        bucket: 'owned-bucket',
        keyRule: 'task-attempt-result-v1' as const,
      },
      taskId: 4,
    }
    expect(await storage.findAttemptCandidates(args)).toMatchObject({
      candidates: [{ sha256: sha }],
      status: 'complete',
    })
    const secondBytes = await sharp({
      create: { background: 'green', channels: 3, height: 2, width: 3 },
    })
      .png()
      .toBuffer()
    const secondSHA = createHash('sha256').update(secondBytes).digest('hex')
    http.objects.set(`tasks/4/attempts/7/result-${secondSHA}`, {
      type: 'image/png',
      bytes: secondBytes,
    })
    expect(await storage.findAttemptCandidates(args)).toMatchObject({
      candidates: [{ sha256: sha }, { sha256: secondSHA }],
      status: 'conflict',
    })
    expect(await storage.findAttemptCandidates({ ...args, maxCandidates: 1 })).toMatchObject({
      status: 'incomplete',
    })
    expect(await storage.findAttemptCandidates({ ...args, maxBytes: 2 })).toMatchObject({
      status: 'incomplete',
    })
    http.setFault('repeat-page')
    expect(await storage.findAttemptCandidates(args)).toMatchObject({ status: 'incomplete' })
    await expect(storage.findAttemptCandidates({ ...args, taskId: 0 })).rejects.toThrow()
  })
})

describe('real cached local MinIO (distinct from HTTP fault fixture)', () => {
  test('two actual clients race with one conditional winner; immutable replay preserves bytes and anonymous bucket stays private', async () => {
    const { startMinIOFixture } = await import('./minio-fixture.js')
    const { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } =
      await import('@aws-sdk/client-s3')
    const { NodeHttpHandler } = await import('@smithy/node-http-handler')
    const fixture = await startMinIOFixture()
    closers.push(fixture.close)
    const config = {
      credentials: fixture.credentials,
      endpoint: fixture.endpoint,
      forcePathStyle: true,
      maxAttempts: 1,
      region: 'fixture',
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 500,
        requestTimeout: 1000,
        throwOnRequestTimeout: true,
      }),
    }
    const first = new S3Client(config)
    const second = new S3Client({
      ...config,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 500,
        requestTimeout: 1000,
        throwOnRequestTimeout: true,
      }),
    })
    closers.push(async () => {
      first.destroy()
      second.destroy()
    })
    await first.send(new CreateBucketCommand({ Bucket: fixture.bucket }), {
      abortSignal: AbortSignal.timeout(3000),
    })
    const a = await png()
    const b = await sharp({ create: { background: 'green', channels: 3, height: 2, width: 3 } })
      .png()
      .toBuffer()
    fixture.reserveBytes({ bytes: a.length + b.length })
    const key = `references/1/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/${'b'.repeat(64)}`
    const outcome = await Promise.allSettled([
      first.send(
        new PutObjectCommand({
          Body: a,
          Bucket: fixture.bucket,
          ContentType: 'image/png',
          IfNoneMatch: '*',
          Key: key,
        }),
        { abortSignal: AbortSignal.timeout(3000) },
      ),
      second.send(
        new PutObjectCommand({
          Body: b,
          Bucket: fixture.bucket,
          ContentType: 'image/png',
          IfNoneMatch: '*',
          Key: key,
        }),
        { abortSignal: AbortSignal.timeout(3000) },
      ),
    ])
    expect(outcome.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const failed = outcome.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect([409, 412]).toContain(failed.reason.$metadata.httpStatusCode)
    const winner = outcome[0]!.status === 'fulfilled' ? a : b
    const loser = outcome[0]!.status === 'fulfilled' ? b : a
    const storage = createS3ObjectStorage({
      backends: [
        {
          backend: 'real-minio-fixture',
          buckets: [fixture.bucket],
          credentials: fixture.credentials,
          endpoint: fixture.endpoint,
          forcePathStyle: true,
          region: 'fixture',
        },
      ],
      image: caps,
      limits: {
        connectionTimeoutMs: 500,
        maxBytes: 100_000,
        operationTimeoutMs: 5000,
        requestTimeoutMs: 1500,
      },
    })
    closers.push(async () => storage.close())
    await storage.verifyBackend({ backend: 'real-minio-fixture', bucket: fixture.bucket })
    const ref = { backend: 'real-minio-fixture', bucket: fixture.bucket, key }
    const facts = await storage.putImmutable({ bytes: winner, contentType: 'image/png', ref })
    await expect(
      storage.putImmutable({ bytes: loser, contentType: 'image/png', ref }),
    ).rejects.toMatchObject({ code: 'CONTENT_CONFLICT' })
    expect((await storage.getVerified({ expected: facts, ref })).bytes).toEqual(winner)
    const actual = await first.send(new GetObjectCommand({ Bucket: fixture.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(3000),
    })
    expect(Buffer.from(await actual.Body!.transformToByteArray())).toEqual(winner)
    const anonymous = await fetch(`${fixture.endpoint}/${fixture.bucket}/${key}`, {
      signal: AbortSignal.timeout(1500),
    })
    expect(anonymous.status).toBe(403)
  })
})
