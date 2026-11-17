export type ImageLimits = Readonly<{
  allowedMimeTypes: readonly string[]
  maxBytes: number
  maxPixels: number
  timeoutMs: number
}>
export type ImageInput = AsyncIterable<Uint8Array> | Uint8Array
export type ImageFingerprint = Readonly<{
  filesize: number
  height: number
  mimeType: string
  sha256: string
  width: number
}>
export type VerifiedImage = ImageFingerprint & Readonly<{ bytes: Buffer }>

export type ImageValidator = (args: {
  declaredMimeType?: string
  input: ImageInput
  limits: ImageLimits
}) => Promise<VerifiedImage>

export function validateImageLimits({ limits }: { limits: ImageLimits }) {
  for (const value of [limits.maxBytes, limits.maxPixels, limits.timeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error('Image limits must be explicit positive integers.')
    }
  }
  if (
    limits.maxBytes > 32 * 1024 * 1024 ||
    limits.maxPixels > 64_000_000 ||
    limits.timeoutMs > 60_000 ||
    !limits.allowedMimeTypes.length ||
    limits.allowedMimeTypes.some(
      (mime) => !['image/jpeg', 'image/png', 'image/webp'].includes(mime),
    )
  ) {
    throw new Error('Image limits exceed supported bounds.')
  }
}
