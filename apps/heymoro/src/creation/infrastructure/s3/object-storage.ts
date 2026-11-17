import type { S3ClientConfig } from '@aws-sdk/client-s3'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { createHash, randomUUID } from 'node:crypto'

import type { ImageFingerprint, ImageLimits, VerifiedImage } from '../../domain/image.js'
import type { ObjectStorage, StorageRef, StoredImage } from '../../domain/media.js'

import { generationResultKey } from '../../domain/generation.js'
import { validateImageLimits } from '../../domain/image.js'
import { MediaStorageError, sameImage } from '../../domain/media.js'
import { validateImage } from '../image/sharp-image-validator.js'

export type S3Backend = Readonly<{
  backend: string
  buckets: readonly string[]
  credentials: Readonly<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>
  endpoint: string
  forcePathStyle: boolean
  region: string
}>
export type S3Limits = Readonly<{
  connectionTimeoutMs: number
  maxBytes: number
  operationTimeoutMs: number
  requestTimeoutMs: number
}>

/** No Payload request/UOW, environment credentials, defaults, plugin hooks, or implicit retries. */
export function createS3ObjectStorage({
  backends,
  image,
  limits,
}: {
  backends: readonly S3Backend[]
  image: ImageLimits
  limits: S3Limits
}) {
  limits = Object.freeze({ ...limits })
  image = Object.freeze({ ...image, allowedMimeTypes: Object.freeze([...image.allowedMimeTypes]) })
  validateImageLimits({ limits: image })
  for (const value of [
    limits.connectionTimeoutMs,
    limits.maxBytes,
    limits.operationTimeoutMs,
    limits.requestTimeoutMs,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 60_000_000) {
      throw new Error('Explicit bounded S3 limits required.')
    }
  }
  if (
    limits.operationTimeoutMs > 60_000 ||
    limits.maxBytes > 32 * 1024 * 1024 ||
    image.maxBytes > limits.maxBytes
  ) {
    throw new Error('Unsupported S3 limits.')
  }
  const registry = new Map<
    string,
    { buckets: ReadonlySet<string>; client: S3Client; verified: Set<string> }
  >()
  const issued = new WeakSet<object>()
  for (const config of backends) {
    const endpoint = new URL(config.endpoint)
    if (
      !/^[a-z0-9][\w.-]{0,63}$/i.test(config.backend) ||
      registry.has(config.backend) ||
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !config.region ||
      !config.credentials.accessKeyId ||
      !config.credentials.secretAccessKey ||
      !config.buckets.length ||
      config.buckets.some((bucket) => !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) ||
      typeof config.forcePathStyle !== 'boolean'
    ) {
      throw new Error('Explicit complete S3 backend configuration required.')
    }
    const options: S3ClientConfig = {
      credentials: { ...config.credentials },
      endpoint: endpoint.href,
      followRegionRedirects: false,
      forcePathStyle: config.forcePathStyle,
      maxAttempts: 1,
      region: config.region,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      requestHandler: new NodeHttpHandler({
        connectionTimeout: limits.connectionTimeoutMs,
        requestTimeout: limits.requestTimeoutMs,
        throwOnRequestTimeout: true,
      }),
      responseChecksumValidation: 'WHEN_REQUIRED',
    }
    registry.set(config.backend, {
      buckets: new Set(config.buckets),
      client: new S3Client(options),
      verified: new Set(),
    })
  }
  function resolve({ allowProbe = false, ref }: { allowProbe?: boolean; ref: StorageRef }) {
    const backend = registry.get(ref.backend)
    if (
      !backend ||
      !backend.buckets.has(ref.bucket) ||
      typeof ref.key !== 'string' ||
      ref.key.length > 1024 ||
      Array.from(ref.key).some(
        (character) => character.charCodeAt(0) <= 32 || character === '\\',
      ) ||
      ref.key.includes('..') ||
      (!allowProbe &&
        !/^(?:references\/[1-9]\d*\/[a-f0-9-]{36}\/[a-f0-9]{64}|official\/examples\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/[a-f0-9]{64}|tasks\/[1-9]\d*\/attempts\/[1-9]\d*\/result-[a-f0-9]{64})$/.test(
          ref.key,
        ))
    ) {
      throw new MediaStorageError('INVALID_REF')
    }
    return backend
  }
  function evidence({ facts, ref }: { facts: ImageFingerprint; ref: StorageRef }): StoredImage {
    const value = Object.freeze({
      filesize: facts.filesize,
      height: facts.height,
      mimeType: facts.mimeType,
      ref: Object.freeze({ ...ref }),
      sha256: facts.sha256,
      width: facts.width,
    }) as StoredImage
    issued.add(value)
    return value
  }
  async function read({
    maxBytes = limits.maxBytes,
    ref,
    signal,
  }: {
    maxBytes?: number
    ref: StorageRef
    signal: AbortSignal
  }) {
    const { client } = resolve({ ref })
    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: ref.bucket, Key: ref.key }),
        { abortSignal: signal },
      )
      if (!response.Body || !(Symbol.asyncIterator in response.Body)) {
        throw new MediaStorageError('UNKNOWN')
      }
      const body = response.Body
      const chunks: Buffer[] = []
      let size = 0
      const cancel = () => {
        if ('destroy' in body && typeof body.destroy === 'function') {
          body.destroy()
        }
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          if (signal.aborted || !(chunk instanceof Uint8Array)) {
            throw new MediaStorageError('UNKNOWN')
          }
          size += chunk.byteLength
          if (size > maxBytes) {
            throw new MediaStorageError('CONTENT_CONFLICT')
          }
          chunks.push(Buffer.from(chunk))
        }
        if (signal.aborted) {
          throw new MediaStorageError('UNKNOWN')
        }
        return await validateImage({
          declaredMimeType: response.ContentType,
          input: Buffer.concat(chunks, size),
          limits: { ...image, maxBytes: Math.min(image.maxBytes, maxBytes) },
        })
      } finally {
        signal.removeEventListener('abort', cancel)
        cancel()
      }
    } catch (error) {
      if (error instanceof MediaStorageError) {
        throw error
      }
      const status = httpStatus({ error })
      if (status === 404) {
        throw new MediaStorageError('NOT_FOUND')
      }
      if (status === 403) {
        throw new MediaStorageError('FORBIDDEN')
      }
      throw new MediaStorageError('UNKNOWN')
    }
  }
  async function bounded<T>({
    work,
  }: {
    work: (args: { signal: AbortSignal }) => Promise<T>
  }): Promise<T> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work({ signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new MediaStorageError('UNKNOWN'))
          }, limits.operationTimeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
  const port: ObjectStorage = Object.freeze({
    assertVerified: ({ facts }) => {
      if (!issued.has(facts)) {
        throw new MediaStorageError('CONTENT_CONFLICT')
      }
    },
    findAttemptCandidates: async ({
      attemptId,
      maxBytes,
      maxCandidates,
      maxPages,
      storageOutput,
      taskId,
    }) => {
      const destination = Object.freeze({ ...storageOutput })
      const sample = generationResultKey({
        attemptId,
        keyRule: destination.keyRule,
        sha256: '0'.repeat(64),
        taskId,
      })
      const prefix = sample.slice(0, sample.lastIndexOf('/') + 1)
      for (const value of [maxPages, maxCandidates, maxBytes]) {
        if (!Number.isSafeInteger(value) || value < 1) {
          return Promise.reject(new Error('Candidate budgets required.'))
        }
      }
      if (maxPages > 100 || maxCandidates > 1000 || maxBytes > limits.maxBytes) {
        return Promise.reject(new Error('Candidate budget exceeded.'))
      }
      const base = { backend: destination.backend, bucket: destination.bucket }
      const backend = resolve({ ref: { ...base, key: sample } })
      return bounded({
        work: async ({ signal }) => {
          const candidates: StoredImage[] = []
          const tokens = new Set<string>()
          const keys = new Set<string>()
          let token: string | undefined
          for (let page = 0; page < maxPages; page++) {
            try {
              const response = await backend.client.send(
                new ListObjectsV2Command({
                  Bucket: base.bucket,
                  ContinuationToken: token,
                  MaxKeys: Math.min(1000, maxCandidates + 1),
                  Prefix: prefix,
                }),
                { abortSignal: signal },
              )
              for (const entry of response.Contents ?? []) {
                if (
                  !entry.Key ||
                  !entry.Key.startsWith(prefix) ||
                  keys.has(entry.Key) ||
                  keys.size >= maxCandidates
                ) {
                  return { candidates, status: 'incomplete' }
                }
                keys.add(entry.Key)
                const digest = entry.Key.slice(prefix.length).match(/^result-([a-f0-9]{64})$/)?.[1]
                if (
                  !digest ||
                  generationResultKey({
                    attemptId,
                    keyRule: destination.keyRule,
                    sha256: digest,
                    taskId,
                  }) !== entry.Key
                ) {
                  return { candidates, status: 'incomplete' }
                }
                const ref = { ...base, key: entry.Key }
                const actual = await read({ maxBytes, ref, signal })
                if (actual.sha256 !== digest) {
                  return { candidates, status: 'incomplete' }
                }
                candidates.push(evidence({ facts: actual, ref }))
              }
              if (!response.IsTruncated) {
                return {
                  candidates,
                  status:
                    new Set(candidates.map((item) => item.sha256)).size > 1
                      ? 'conflict'
                      : 'complete',
                }
              }
              const next = response.NextContinuationToken
              if (!next || tokens.has(next) || next === token) {
                return { candidates, status: 'incomplete' }
              }
              tokens.add(next)
              token = next
            } catch {
              return { candidates, status: 'incomplete' }
            }
          }
          return { candidates, status: 'incomplete' }
        },
      })
    },
    getVerified: ({ expected, ref }) => {
      ref = Object.freeze({ ...ref })
      expected = expected && Object.freeze({ ...expected })
      return bounded({
        work: async ({ signal }) => {
          const actual = await read({ ref, signal })
          if (expected && !sameImage({ left: actual, right: expected })) {
            throw new MediaStorageError('CONTENT_CONFLICT')
          }
          return actual
        },
      })
    },
    putImmutable: async ({ bytes, contentType, ref }) => {
      ref = Object.freeze({ ...ref })
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > limits.maxBytes
      ) {
        throw new MediaStorageError('CONTENT_CONFLICT')
      }
      const ownedBytes = Buffer.from(bytes)
      const backend = resolve({ ref })
      if (!backend.verified.has(ref.bucket)) {
        return Promise.reject(new MediaStorageError('UNVERIFIED_BACKEND'))
      }
      return bounded({
        work: async ({ signal }) => {
          await validateImage({ declaredMimeType: contentType, input: ownedBytes, limits: image })
          if (signal.aborted) {
            throw new MediaStorageError('UNKNOWN')
          }
          let writeError: unknown
          // Conditional write is the exclusion point, not a HEAD-before-PUT race.
          try {
            await backend.client.send(
              new PutObjectCommand({
                Body: ownedBytes,
                Bucket: ref.bucket,
                ContentType: contentType,
                IfNoneMatch: '*',
                Key: ref.key,
              }),
              { abortSignal: signal },
            )
          } catch (error) {
            writeError = error
          }
          let actual: VerifiedImage
          try {
            actual = await read({ ref, signal })
          } catch (error) {
            if (httpStatus({ error: writeError }) === 403) {
              throw new MediaStorageError('FORBIDDEN')
            }
            // A failed/uncertain PUT followed by absence does not prove non-creation.
            if (
              writeError !== undefined &&
              error instanceof MediaStorageError &&
              error.code === 'NOT_FOUND'
            ) {
              throw new MediaStorageError('UNKNOWN')
            }
            throw error
          }
          if (
            actual.filesize !== ownedBytes.length ||
            actual.sha256 !== createHash('sha256').update(ownedBytes).digest('hex') ||
            actual.mimeType !== contentType
          ) {
            throw new MediaStorageError('CONTENT_CONFLICT')
          }
          return evidence({ facts: actual, ref })
        },
      })
    },
  })
  return Object.freeze({
    ...port,
    close: () => {
      for (const { client } of registry.values()) {
        client.destroy()
      }
      registry.clear()
    },
    verifyBackend: ({ backend: name, bucket }: { backend: string; bucket: string }) =>
      bounded({
        work: async ({ signal }) => {
          const key = `__heymoro_probe__/${randomUUID()}`
          const ref = { backend: name, bucket, key }
          const backend = resolve({ allowProbe: true, ref })
          backend.verified.delete(bucket)
          const first = Buffer.from(randomUUID())
          const second = Buffer.from(randomUUID())
          try {
            await backend.client.send(
              new PutObjectCommand({ Body: first, Bucket: bucket, IfNoneMatch: '*', Key: key }),
              { abortSignal: signal },
            )
            let rejection: unknown
            try {
              await backend.client.send(
                new PutObjectCommand({ Body: second, Bucket: bucket, IfNoneMatch: '*', Key: key }),
                { abortSignal: signal },
              )
            } catch (error) {
              rejection = error
            }
            if (![409, 412].includes(httpStatus({ error: rejection }) ?? 0)) {
              throw new MediaStorageError('UNSAFE_BACKEND')
            }
            const result = await backend.client.send(
              new GetObjectCommand({ Bucket: bucket, Key: key }),
              { abortSignal: signal },
            )
            // Probe is tiny, with the same total operation deadline; count its body too.
            const chunks: Buffer[] = []
            let size = 0
            if (!result.Body || !(Symbol.asyncIterator in result.Body)) {
              throw new MediaStorageError('UNSAFE_BACKEND')
            }
            const body = result.Body
            const cancel = () => {
              if ('destroy' in body && typeof body.destroy === 'function') {
                body.destroy()
              }
            }
            signal.addEventListener('abort', cancel, { once: true })
            try {
              for await (const chunk of body as AsyncIterable<Uint8Array>) {
                size += chunk.byteLength
                if (size > first.length || signal.aborted) {
                  throw new MediaStorageError('UNSAFE_BACKEND')
                }
                chunks.push(Buffer.from(chunk))
              }
              if (signal.aborted || !Buffer.concat(chunks).equals(first)) {
                throw new MediaStorageError('UNSAFE_BACKEND')
              }
            } finally {
              signal.removeEventListener('abort', cancel)
              cancel()
            }
            backend.verified.add(bucket)
          } finally {
            // Only our unpredictable owned probe may be deleted; never expose deletion of media objects.
            if (!signal.aborted) {
              await backend.client
                .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
                  abortSignal: signal,
                })
                .catch(() => undefined)
            }
          }
        },
      }),
  })
}
function httpStatus({ error }: { error: unknown }): number | undefined {
  if (
    error &&
    typeof error === 'object' &&
    '$metadata' in error &&
    error.$metadata &&
    typeof error.$metadata === 'object' &&
    'httpStatusCode' in error.$metadata &&
    typeof error.$metadata.httpStatusCode === 'number'
  ) {
    return error.$metadata.httpStatusCode
  }
  return undefined
}
