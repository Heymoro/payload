import type { Payload, PayloadRequest, Where } from 'payload'

import type {
  MediaReader,
  MediaRecord,
  MediaRegistration,
  MediaRepository,
  MediaServiceDependencies,
} from '../../application/media.js'
import type { ObjectStorage, StorageRef } from '../../domain/media.js'
import type { SnapshotFind } from './read-snapshot.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'
import type { CreationWriteGate } from './write-gate.js'

import { createMediaService, MediaError, registerVerifiedMedia } from '../../application/media.js'
import { validateImage } from '../image/sharp-image-validator.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'
import { createCreationRuntime } from './session-repository.js'
import { createSQLiteUnitOfWork, CreationTransactionError } from './sqlite-unit-of-work.js'

export function createPayloadMediaService({
  clock,
  destination,
  imageLimits,
  storage,
  ...options
}: Pick<MediaServiceDependencies, 'clock' | 'destination' | 'imageLimits' | 'storage'> &
  SQLiteUnitOfWorkOptions) {
  assertSchema({ payload: options.payload })
  const runtime = createCreationRuntime(options)
  const read = createSQLiteReadSnapshot({ payload: options.payload })
  const write = createSQLiteUnitOfWork(options)
  return createMediaService({
    clock,
    destination,
    imageLimits,
    isCommitUnknown: ({ error }) =>
      error instanceof CreationTransactionError && error.commitStarted,
    read: ({ work }) =>
      read({ work: ({ find }) => work({ repository: createPayloadMediaReader({ find }) }) }),
    storage,
    validateImage,
    write: ({ resource, work }) =>
      write({ resource, work: ({ req }) => work({ repository: repository({ req, runtime }) }) }),
  })
}

/** Transaction-bound internal host port: same req as T2, no new UOW/lease and no account-live dependency. */
export function createPayloadVerifiedMediaRegistration({
  gate,
  payload,
  storage,
}: {
  gate: CreationWriteGate
  payload: Payload
  storage: ObjectStorage
}) {
  assertSchema({ payload })
  const runtime = createCreationRuntime({ gate, payload })
  return ({ req, ...args }: { req: PayloadRequest } & MediaRegistration) =>
    registerVerifiedMedia({ ...args, repository: repository({ req, runtime }), storage })
}
function repository({
  req,
  runtime,
}: {
  req: PayloadRequest
  runtime: ReturnType<typeof createCreationRuntime>
}): MediaRepository {
  const find: SnapshotFind = (args) =>
    runtime.find({ ...args, collection: args.collection as 'media' | 'users', req })
  return Object.freeze({
    ...createPayloadMediaReader({ find }),
    insert: async ({ actor, facts, identity, now, originalName }) => {
      const doc = await runtime.create({
        collection: 'media',
        data: {
          alt: originalName,
          createdAt: now,
          createdBy: actor,
          deletedAt: null,
          deletedBy: null,
          filename: facts.ref.key,
          filesize: facts.filesize,
          height: facts.height,
          isDeleted: false,
          lifecycle: 'active',
          mimeType: facts.mimeType,
          originalName,
          owner: identity.owner,
          purpose: identity.purpose,
          sha256: facts.sha256,
          storageBackend: facts.ref.backend,
          storageBucket: facts.ref.bucket,
          storageName: facts.ref.key,
          updatedAt: now,
          updatedBy: actor,
          visibility: identity.visibility,
          width: facts.width,
        },
        req,
      })
      const row = await createPayloadMediaReader({ find }).readMedia({ mediaId: Number(doc.id) })
      if (!row) {
        throw new MediaError('DATA_INTEGRITY_CONFLICT')
      }
      return row
    },
  })
}
const mediaFields = Object.fromEntries(
  [
    'owner',
    'purpose',
    'visibility',
    'storageBackend',
    'storageBucket',
    'storageName',
    'sha256',
    'mimeType',
    'filesize',
    'width',
    'height',
    'originalName',
    'lifecycle',
    'isDeleted',
  ].map((name) => [name, true]),
)
export function createPayloadMediaReader({ find }: { find: SnapshotFind }): MediaReader {
  return Object.freeze({
    findByRef: async ({ ref }) => {
      const result = await find({
        collection: 'media',
        limit: 2,
        select: mediaFields,
        showHiddenFields: true,
        where: location({ ref }),
      })
      if (result.totalDocs > 1 || result.docs.length > 1) {
        throw new MediaError('DATA_INTEGRITY_CONFLICT')
      }
      return result.docs.map((doc) => mediaRecord({ doc }))
    },
    isAccountActive: async ({ userId }) => {
      const result = await find({
        collection: 'users',
        limit: 2,
        select: { isDeleted: true, status: true },
        where: { id: { equals: userId } },
      })
      return (
        result.docs.length === 1 &&
        result.totalDocs === 1 &&
        result.docs[0]!.status === 'active' &&
        result.docs[0]!.isDeleted === false
      )
    },
    readMedia: async ({ mediaId }) => {
      const result = await find({
        collection: 'media',
        limit: 2,
        select: mediaFields,
        showHiddenFields: true,
        where: { id: { equals: mediaId } },
      })
      if (result.docs.length > 1 || result.totalDocs > 1) {
        throw new MediaError('DATA_INTEGRITY_CONFLICT')
      }
      return result.docs[0] ? mediaRecord({ doc: result.docs[0] }) : null
    },
  })
}
function location({ ref }: { ref: StorageRef }): Where {
  return {
    and: [
      { storageBackend: { equals: ref.backend } },
      { storageBucket: { equals: ref.bucket } },
      { storageName: { equals: ref.key } },
    ],
  }
}
function mediaRecord({ doc }: { doc: Record<string, unknown> }): MediaRecord {
  function text({ name }: { name: string }) {
    const value = doc[name]
    if (typeof value !== 'string' || !value) {
      throw new MediaError('DATA_INTEGRITY_CONFLICT')
    }
    return value
  }
  function integer({ name }: { name: string }) {
    const value = doc[name]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new MediaError('DATA_INTEGRITY_CONFLICT')
    }
    return value
  }
  const sha256 = text({ name: 'sha256' })
  const mimeType = text({ name: 'mimeType' })
  const purpose = text({ name: 'purpose' })
  const visibility = text({ name: 'visibility' })
  if (
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType) ||
    !['artifact', 'avatar', 'example', 'reference'].includes(purpose) ||
    !['official_public', 'private'].includes(visibility) ||
    typeof doc.isDeleted !== 'boolean'
  ) {
    throw new MediaError('DATA_INTEGRITY_CONFLICT')
  }
  return Object.freeze({
    id: integer({ name: 'id' }),
    filesize: integer({ name: 'filesize' }),
    height: integer({ name: 'height' }),
    isDeleted: doc.isDeleted,
    lifecycle: text({ name: 'lifecycle' }),
    mimeType,
    originalName: text({ name: 'originalName' }),
    owner: doc.owner == null ? null : integer({ name: 'owner' }),
    purpose: purpose as MediaRecord['purpose'],
    ref: Object.freeze({
      backend: text({ name: 'storageBackend' }),
      bucket: text({ name: 'storageBucket' }),
      key: text({ name: 'storageName' }),
    }),
    sha256,
    visibility: visibility as MediaRecord['visibility'],
    width: integer({ name: 'width' }),
  })
}
function assertSchema({ payload }: { payload: Payload }) {
  const fields = payload.collections.users?.config.flattenedFields
  if (
    !fields?.some((field) => field.name === 'status') ||
    !fields.some((field) => field.name === 'isDeleted' && field.type === 'checkbox') ||
    !payload.collections.media
  ) {
    throw new Error(
      'Creation media requires users status/isDeleted checkbox and extended native media schema.',
    )
  }
}
