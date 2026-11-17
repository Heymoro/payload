import type { OfficialMediaUploadDependencies } from '../../application/media.js'
import type { SnapshotFind } from './read-snapshot.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'

import { createOfficialMediaUploadService } from '../../application/media.js'
import { AdminCommandError, adminRecord } from '../../domain/admin.js'
import { validateImage } from '../image/sharp-image-validator.js'
import {
  createPayloadMediaReader,
  createPayloadVerifiedMediaRegistration,
} from './media-repository.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'
import { createCreationRuntime } from './session-repository.js'
import { createSQLiteUnitOfWork, CreationTransactionError } from './sqlite-unit-of-work.js'

export function createPayloadOfficialMediaUploadService({
  clock,
  destination,
  imageLimits,
  storage,
  ...options
}: Pick<OfficialMediaUploadDependencies, 'clock' | 'destination' | 'imageLimits' | 'storage'> &
  SQLiteUnitOfWorkOptions) {
  const runtime = createCreationRuntime(options)
  const read = createSQLiteReadSnapshot({ payload: options.payload })
  const write = createSQLiteUnitOfWork(options)
  const register = createPayloadVerifiedMediaRegistration({ ...options, storage })
  return createOfficialMediaUploadService({
    clock,
    destination,
    imageLimits,
    isCommitUnknown: ({ error }) =>
      error instanceof CreationTransactionError &&
      (error.commitStarted || !error.rollbackConfirmed),
    read: ({ work }) =>
      read({
        work: ({ find }) =>
          work({
            repository: {
              findByRef: createPayloadMediaReader({ find }).findByRef,
              readAdmin: (args) => readAdmin({ ...args, find }),
            },
          }),
      }),
    storage,
    validateImage,
    write: ({ resource, work }) =>
      write({
        resource,
        work: ({ req }) => {
          const find: SnapshotFind = (args) => runtime.find({ ...args, collection: 'admins', req })
          return work({
            repository: {
              readAdmin: (args) => readAdmin({ ...args, find }),
              register: (args) => register({ ...args, req }),
            },
          })
        },
      }),
  })
}

async function readAdmin({ adminId, find }: { adminId: number; find: SnapshotFind }) {
  const result = await find({
    collection: 'admins',
    limit: 2,
    select: { role: true, status: true },
    where: { id: { equals: adminId } },
  })
  if (
    !Array.isArray(result.docs) ||
    !Number.isSafeInteger(result.totalDocs) ||
    result.totalDocs !== result.docs.length ||
    result.totalDocs > 1 ||
    result.totalDocs < 0
  ) {
    throw new AdminCommandError({ code: 'ADMIN_DATA_INTEGRITY' })
  }
  if (!result.docs[0]) {
    return null
  }
  const admin = adminRecord({ value: result.docs[0] })
  if (admin.id !== adminId) {
    throw new AdminCommandError({ code: 'ADMIN_DATA_INTEGRITY' })
  }
  return admin
}
