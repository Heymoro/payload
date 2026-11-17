import { createHash, randomUUID } from 'node:crypto'

import type { AdminRecord } from '../domain/admin.js'
import type { ImageFingerprint, ImageInput, ImageLimits, ImageValidator } from '../domain/image.js'
import type { ObjectStorage, StorageRef, StoredImage } from '../domain/media.js'

import { AdminCommandError } from '../domain/admin.js'
import { validateImageLimits } from '../domain/image.js'
import { sameImage } from '../domain/media.js'

export type MediaIdentity = Readonly<{
  owner: null | number
  purpose: 'artifact' | 'avatar' | 'example' | 'reference'
  visibility: 'official_public' | 'private'
}>
export type MediaRecord = ImageFingerprint &
  MediaIdentity &
  Readonly<{
    id: number
    isDeleted: boolean
    lifecycle: string
    originalName: string
    ref: StorageRef
  }>
export type MediaReader = Readonly<{
  findByRef: (args: { ref: StorageRef }) => Promise<readonly MediaRecord[]>
  isAccountActive: (args: { userId: number }) => Promise<boolean>
  readMedia: (args: { mediaId: number }) => Promise<MediaRecord | null>
}>
export type MediaRepository = MediaReader &
  Readonly<{
    insert: (args: {
      actor: string
      facts: StoredImage
      identity: MediaIdentity
      now: string
      originalName: string
    }) => Promise<MediaRecord>
  }>
export type MediaRegistration = {
  actor: string
  facts: StoredImage
  now: string
  originalName: string
  owner: MediaIdentity['owner']
  purpose: MediaIdentity['purpose']
  visibility: MediaIdentity['visibility']
}
export type MediaServiceDependencies = {
  clock: () => string
  destination: Readonly<{ backend: string; bucket: string }>
  imageLimits: ImageLimits
  isCommitUnknown: (args: { error: unknown }) => boolean
  read: <T>(args: { work: (args: { repository: MediaReader }) => Promise<T> }) => Promise<T>
  storage: ObjectStorage
  validateImage: ImageValidator
  write: <T>(args: {
    resource: string
    work: (args: { repository: MediaRepository }) => Promise<T>
  }) => Promise<T>
}
export class MediaError extends Error {
  constructor(
    readonly code: 'DATA_INTEGRITY_CONFLICT' | 'INVALID_MEDIA' | 'NOT_FOUND' | 'UNAUTHENTICATED',
  ) {
    super(`Media ${code}.`)
    this.name = 'MediaError'
  }
}

export function createMediaService({
  clock,
  destination,
  imageLimits,
  isCommitUnknown,
  read,
  storage,
  validateImage,
  write,
}: MediaServiceDependencies) {
  if (typeof validateImage !== 'function') {
    throw new Error('Explicit image validator required.')
  }
  destination = Object.freeze({ ...destination })
  imageLimits = Object.freeze({
    ...imageLimits,
    allowedMimeTypes: Object.freeze([...imageLimits.allowedMimeTypes]),
  })
  validateImageLimits({ limits: imageLimits })
  if (!destination.backend || !destination.bucket) {
    throw new Error('Explicit host media destination required.')
  }
  async function authorized({
    mediaId,
    officialOnly = false,
    userId,
  }: {
    mediaId: number
    officialOnly?: boolean
    userId?: number
  }) {
    if (!Number.isSafeInteger(mediaId) || mediaId < 1) {
      throw new MediaError('NOT_FOUND')
    }
    return read({
      work: async ({ repository }) => {
        if (userId !== undefined) {
          await active({ repository, userId })
        }
        const media = await repository.readMedia({ mediaId })
        if (!media || media.isDeleted || media.lifecycle !== 'active') {
          throw new MediaError('NOT_FOUND')
        }
        const isOfficial =
          media.owner === null &&
          media.visibility === 'official_public' &&
          media.purpose === 'example'
        if (
          !isOfficial &&
          (officialOnly ||
            userId === undefined ||
            media.owner !== userId ||
            media.visibility !== 'private')
        ) {
          throw new MediaError('NOT_FOUND')
        }
        return media
      },
    })
  }
  async function readBytes(args: { mediaId: number; officialOnly?: boolean; userId?: number }) {
    const before = await authorized(args)
    const image = await storage.getVerified({ expected: before, ref: before.ref })
    // A disabled user or newly tombstoned row during slow I/O must not receive private bytes.
    const after = await authorized(args)
    if (!matches({ facts: before, identity: before, row: after }) || before.id !== after.id) {
      throw new MediaError('DATA_INTEGRITY_CONFLICT')
    }
    return Object.freeze({
      bytes: image.bytes,
      filename: `image-${after.id}.${image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png'}`,
      mimeType: image.mimeType,
    })
  }
  return Object.freeze({
    readForUser: ({ mediaId, userId }: { mediaId: number; userId: number }) =>
      readBytes({ mediaId, userId }),
    readOfficialExample: ({ mediaId }: { mediaId: number }) =>
      readBytes({ mediaId, officialOnly: true }),
    uploadForUser: async ({
      declaredMimeType,
      input,
      originalName,
      userId,
    }: {
      declaredMimeType?: string
      input: ImageInput
      originalName: string
      userId: number
    }) => {
      // Capture caller-owned bytes before awaiting even the account snapshot.
      input =
        input instanceof Uint8Array && input.byteLength <= imageLimits.maxBytes
          ? Buffer.from(input)
          : input
      await read({ work: ({ repository }) => active({ repository, userId }) })
      const name = normalizeOriginalName({ value: originalName })
      const image = await validateImage({ declaredMimeType, input, limits: imageLimits }).catch(
        () => {
          throw new MediaError('INVALID_MEDIA')
        },
      )
      const ref = Object.freeze({
        ...destination,
        key: `references/${userId}/${randomUUID()}/${image.sha256}`,
      })
      const facts = await storage.putImmutable({
        bytes: image.bytes,
        contentType: image.mimeType,
        ref,
      })
      const args: MediaRegistration = {
        actor: `user:${userId}`,
        facts,
        now: clock(),
        originalName: name,
        owner: userId,
        purpose: 'reference',
        visibility: 'private',
      }
      try {
        const row = await write({
          resource: mediaResource({ ref }),
          work: async ({ repository }) => {
            await active({ repository, userId })
            return registerVerifiedMedia({ ...args, repository, storage })
          },
        })
        return safeMedia({ row })
      } catch (error) {
        if (!isCommitUnknown({ error })) {
          throw error
        }
        // No write retry, key replacement, or deletion after an uncertain commit.
        return read({
          work: async ({ repository }) => {
            await active({ repository, userId })
            const rows = await repository.findByRef({ ref })
            if (rows.length !== 1 || !matches({ facts, identity: args, row: rows[0]! })) {
              throw error
            }
            return safeMedia({ row: rows[0]! })
          },
        })
      }
    },
  })
}

/** Host-only T2 registration: caller already owns its locks and transaction; no nested lock or I/O. */
export async function registerVerifiedMedia({
  actor,
  facts,
  now,
  originalName,
  owner,
  purpose,
  repository,
  storage,
  visibility,
}: { repository: MediaRepository; storage: ObjectStorage } & MediaRegistration) {
  storage.assertVerified({ facts })
  if (
    facts.ref.key.startsWith('__heymoro_probe__/') ||
    !['artifact', 'avatar', 'example', 'reference'].includes(purpose) ||
    !['official_public', 'private'].includes(visibility) ||
    (owner === null
      ? purpose !== 'example' || visibility !== 'official_public'
      : !Number.isSafeInteger(owner) || owner < 1 || visibility !== 'private') ||
    !/^(?:(?:user|admin):[1-9]\d*|system:[A-Za-z0-9][\w.-]*)$/.test(actor) ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  ) {
    throw new MediaError('INVALID_MEDIA')
  }
  const identity = Object.freeze({ owner, purpose, visibility })
  const name = normalizeOriginalName({ value: originalName })
  const rows = await repository.findByRef({ ref: facts.ref })
  if (rows.length) {
    if (rows.length !== 1 || !matches({ facts, identity, row: rows[0]! })) {
      throw new MediaError('DATA_INTEGRITY_CONFLICT')
    }
    return rows[0]!
  }
  const row = await repository.insert({ actor, facts, identity, now, originalName: name })
  if (!matches({ facts, identity, row })) {
    throw new MediaError('DATA_INTEGRITY_CONFLICT')
  }
  return row
}
function matches({
  facts,
  identity,
  row,
}: {
  facts: { ref: StorageRef } & ImageFingerprint
  identity: MediaIdentity
  row: MediaRecord
}) {
  return (
    !row.isDeleted &&
    row.lifecycle === 'active' &&
    row.owner === identity.owner &&
    row.purpose === identity.purpose &&
    row.visibility === identity.visibility &&
    row.ref.backend === facts.ref.backend &&
    row.ref.bucket === facts.ref.bucket &&
    row.ref.key === facts.ref.key &&
    sameImage({ left: row, right: facts })
  )
}
function safeMedia({ row }: { row: MediaRecord }) {
  return Object.freeze({
    id: row.id,
    filesize: row.filesize,
    height: row.height,
    mimeType: row.mimeType,
    width: row.width,
  })
}
async function active({ repository, userId }: { repository: MediaReader; userId: number }) {
  if (
    !Number.isSafeInteger(userId) ||
    userId < 1 ||
    !(await repository.isAccountActive({ userId }))
  ) {
    throw new MediaError('UNAUTHENTICATED')
  }
}
function mediaResource({ ref }: { ref: StorageRef }) {
  return `media:${createHash('sha256')
    .update(JSON.stringify([ref.backend, ref.bucket, ref.key]))
    .digest('hex')}`
}
function normalizeOriginalName({ value }: { value: string }) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 255 ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        character === '/' ||
        character === '\\',
    )
  ) {
    throw new MediaError('INVALID_MEDIA')
  }
  return value.trim()
}

export type OfficialMediaReader = Readonly<{
  findByRef: MediaReader['findByRef']
  readAdmin: (args: { adminId: number }) => Promise<AdminRecord | null>
}>
export type OfficialMediaWriter = Readonly<{
  readAdmin: OfficialMediaReader['readAdmin']
  register: (args: MediaRegistration) => Promise<MediaRecord>
}>
export type OfficialMediaUploadDependencies = {
  read: <T>(args: { work: (args: { repository: OfficialMediaReader }) => Promise<T> }) => Promise<T>
  write: <T>(args: {
    resource: string
    work: (args: { repository: OfficialMediaWriter }) => Promise<T>
  }) => Promise<T>
} & Pick<
  MediaServiceDependencies,
  'clock' | 'destination' | 'imageLimits' | 'isCommitUnknown' | 'storage' | 'validateImage'
>

export function createOfficialMediaUploadService({
  clock,
  destination,
  imageLimits,
  isCommitUnknown,
  read,
  storage,
  validateImage,
  write,
}: OfficialMediaUploadDependencies) {
  if (typeof validateImage !== 'function' || !destination.backend || !destination.bucket) {
    throw new Error('Explicit official image validator and destination required.')
  }
  destination = Object.freeze({ ...destination })
  imageLimits = Object.freeze({
    ...imageLimits,
    allowedMimeTypes: Object.freeze([...imageLimits.allowedMimeTypes]),
  })
  validateImageLimits({ limits: imageLimits })
  const authorize = async ({
    adminId,
    repository,
  }: {
    adminId: number
    repository: Pick<OfficialMediaReader, 'readAdmin'>
  }) => {
    if (!Number.isSafeInteger(adminId) || adminId < 1) {
      throw new AdminCommandError({ code: 'ADMIN_FORBIDDEN' })
    }
    const admin = await repository.readAdmin({ adminId })
    if (
      !admin ||
      admin.id !== adminId ||
      admin.status !== 'active' ||
      !['admin', 'operator'].includes(admin.role)
    ) {
      throw new AdminCommandError({ code: 'ADMIN_FORBIDDEN' })
    }
  }
  return Object.freeze({
    upload: async ({
      adminId,
      declaredMimeType,
      input,
      originalName,
    }: {
      adminId: number
      declaredMimeType?: string
      input: ImageInput
      originalName: string
    }) => {
      input =
        input instanceof Uint8Array && input.byteLength <= imageLimits.maxBytes
          ? Buffer.from(input)
          : input
      await read({ work: ({ repository }) => authorize({ adminId, repository }) })
      const name = normalizeOriginalName({ value: originalName })
      const image = await validateImage({ declaredMimeType, input, limits: imageLimits }).catch(
        () => {
          throw new MediaError('INVALID_MEDIA')
        },
      )
      const ref = Object.freeze({
        ...destination,
        key: `official/examples/${randomUUID()}/${image.sha256}`,
      })
      const facts = await storage.putImmutable({
        bytes: image.bytes,
        contentType: image.mimeType,
        ref,
      })
      const args: MediaRegistration = {
        actor: `admin:${adminId}`,
        facts,
        now: clock(),
        originalName: name,
        owner: null,
        purpose: 'example',
        visibility: 'official_public',
      }
      try {
        const row = await write({
          resource: mediaResource({ ref }),
          work: async ({ repository }) => {
            await authorize({ adminId, repository })
            return repository.register(args)
          },
        })
        return safeMedia({ row })
      } catch (error) {
        if (!isCommitUnknown({ error })) {
          throw error
        }
        // One read-only reconciliation after releasing T2. A failed read cannot prove rollback.
        try {
          return await read({
            work: async ({ repository }) => {
              await authorize({ adminId, repository })
              const rows = await repository.findByRef({ ref })
              if (rows.length !== 1 || !matches({ facts, identity: args, row: rows[0]! })) {
                throw error
              }
              return safeMedia({ row: rows[0]! })
            },
          })
        } catch {
          throw error
        }
      }
    },
  })
}
