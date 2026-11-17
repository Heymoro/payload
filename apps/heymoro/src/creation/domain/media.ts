import type { StorageOutput } from './generation.js'
import type { ImageFingerprint, VerifiedImage } from './image.js'

export type StorageRef = Readonly<{ backend: string; bucket: string; key: string }>
declare const verifiedStoredImage: unique symbol
/** Opaque, process-local evidence minted by the storage adapter, not frontend metadata. */
export type StoredImage = ImageFingerprint &
  Readonly<{ ref: StorageRef; [verifiedStoredImage]: true }>
export class MediaStorageError extends Error {
  constructor(
    readonly code:
      | 'CONTENT_CONFLICT'
      | 'FORBIDDEN'
      | 'INVALID_REF'
      | 'NOT_FOUND'
      | 'UNKNOWN'
      | 'UNSAFE_BACKEND'
      | 'UNVERIFIED_BACKEND',
  ) {
    super(`Media storage ${code}.`)
    this.name = 'MediaStorageError'
  }
}
export type ObjectStorage = Readonly<{
  assertVerified: (args: { facts: StoredImage }) => void
  findAttemptCandidates: (args: {
    attemptId: number
    maxBytes: number
    maxCandidates: number
    maxPages: number
    storageOutput: StorageOutput
    taskId: number
  }) => Promise<{
    candidates: readonly StoredImage[]
    status: 'complete' | 'conflict' | 'incomplete'
  }>
  getVerified: (args: { expected?: ImageFingerprint; ref: StorageRef }) => Promise<VerifiedImage>
  putImmutable: (args: {
    bytes: Uint8Array
    contentType: string
    ref: StorageRef
  }) => Promise<StoredImage>
}>
export function sameImage({ left, right }: { left: ImageFingerprint; right: ImageFingerprint }) {
  return (
    left.sha256 === right.sha256 &&
    left.filesize === right.filesize &&
    left.mimeType === right.mimeType &&
    left.width === right.width &&
    left.height === right.height
  )
}
