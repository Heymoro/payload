import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import sharp from 'sharp'

import type { ImageInput, ImageLimits, VerifiedImage } from '../../domain/image.js'

import { validateImageLimits } from '../../domain/image.js'
import { assertSingleFramePNG } from './png-single-frame-policy.mjs'

/** Both input and generated output use real full decoding; original visual bytes are retained. */
export async function validateImage({
  declaredMimeType,
  input,
  limits,
}: {
  declaredMimeType?: string
  input: ImageInput
  limits: ImageLimits
}): Promise<VerifiedImage> {
  validateImageLimits({ limits })
  if (
    input instanceof Uint8Array &&
    (input.byteLength === 0 || input.byteLength > limits.maxBytes)
  ) {
    throw new Error('Image byte limit exceeded or empty image.')
  }
  // Copy synchronous buffers before the first await; callers retain no writable alias.
  const pending =
    input instanceof Uint8Array
      ? Promise.resolve(Buffer.from(input))
      : readImageStream({ input, maxBytes: limits.maxBytes, timeoutMs: limits.timeoutMs })
  const bytes = await pending
  if (bytes.length === 0 || bytes.length > limits.maxBytes) {
    throw new Error('Image byte limit exceeded or empty image.')
  }
  const decodeDeadline = performance.now() + limits.timeoutMs
  const assertDeadline = () => {
    if (performance.now() >= decodeDeadline) {
      throw new Error('Image decode deadline exceeded.')
    }
  }
  const decoder = sharp(bytes, {
    animated: true,
    failOn: 'warning',
    limitInputPixels: limits.maxPixels,
    sequentialRead: true,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const metadata = await decoder.metadata()
        assertDeadline()
        const mimeType =
          metadata.format === 'png'
            ? 'image/png'
            : metadata.format === 'jpeg'
              ? 'image/jpeg'
              : metadata.format === 'webp'
                ? 'image/webp'
                : ''
        const declared = declaredMimeType?.trim().toLowerCase().split(';')[0]?.trim()
        if (
          !mimeType ||
          !limits.allowedMimeTypes.includes(mimeType) ||
          (metadata.pages ?? 1) !== 1 ||
          !metadata.width ||
          !metadata.height ||
          metadata.width * metadata.height > limits.maxPixels
        ) {
          throw new Error('Unsupported image format, animation or pixel limit.')
        }
        if (declared && declared !== 'application/octet-stream' && declared !== mimeType) {
          throw new Error('Declared image MIME does not match actual bytes.')
        }
        if (metadata.format === 'png') {
          assertSingleFramePNG({ assertDeadline, bytes })
        }
        assertDeadline()
        // metadata alone accepts truncated files: force all pixels through the decoder.
        const { info } = await decoder.raw().toBuffer({ resolveWithObject: true })
        assertDeadline()
        if (info.width !== metadata.width || info.height !== metadata.height) {
          throw new Error('Decoded image dimensions conflict.')
        }
        const fingerprint = {
          filesize: bytes.length,
          height: info.height,
          mimeType,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          width: info.width,
        }
        assertDeadline()
        return Object.freeze({
          ...fingerprint,
          get bytes() {
            return Buffer.from(bytes)
          },
        })
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          decoder.destroy()
          reject(new Error('Image decode deadline exceeded.'))
        }, limits.timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    decoder.destroy()
  }
}

async function readImageStream({
  input,
  maxBytes,
  timeoutMs,
}: {
  input: AsyncIterable<Uint8Array>
  maxBytes: number
  timeoutMs: number
}) {
  const iterator = input[Symbol.asyncIterator]()
  const chunks: Buffer[] = []
  let size = 0
  let isClosed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        for (;;) {
          if (isClosed) {
            throw new Error('Image stream deadline exceeded.')
          }
          const next = await iterator.next()
          if (isClosed) {
            throw new Error('Image stream deadline exceeded.')
          }
          if (next.done) {
            return Buffer.concat(chunks, size)
          }
          if (!(next.value instanceof Uint8Array)) {
            throw new Error('Invalid image stream chunk.')
          }
          size += next.value.byteLength
          if (size > maxBytes) {
            throw new Error('Image byte limit exceeded.')
          }
          chunks.push(Buffer.from(next.value))
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Image stream deadline exceeded.')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    isClosed = true
    // A hostile producer can stall return() too; do not await its cleanup.
    void iterator.return?.().catch(() => undefined)
  }
}
