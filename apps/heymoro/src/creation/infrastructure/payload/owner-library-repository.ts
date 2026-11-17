import type { Payload, Where } from 'payload'

import type { LibraryOptions, LibraryReader } from '../../application/owner-library-types.js'
import type { SnapshotFind } from './read-snapshot.js'

import { createOwnerLibrary } from '../../application/owner-library.js'
import { GenerationError } from '../../domain/generation.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'

export function createPayloadOwnerLibrary({
  payload,
  ...options
}: { payload: Payload } & Omit<LibraryOptions, 'read'>) {
  assertLibrarySchema({ payload })
  const snapshot = createSQLiteReadSnapshot({ payload })
  return createOwnerLibrary({
    ...options,
    read: ({ work }) =>
      snapshot({ work: ({ find }) => work({ reader: createLibraryReader({ find }) }) }),
  })
}
const selections = {
  artifacts: [
    'userId',
    'sessionId',
    'taskId',
    'mediaId',
    'outputIndex',
    'createdAt',
    'isDeleted',
    'deletedAt',
    'deletedBy',
  ],
  'creation-sessions': ['userId', 'templateId', 'templateId', 'mode', 'isDeleted'],
  'generation-attempts': [
    'taskId',
    'attemptNo',
    'provider',
    'model',
    'status',
    'errorCode',
    'resultStorageBackend',
    'resultStorageBucket',
    'resultStorageKey',
    'resultSha256',
    'isDeleted',
  ],
  'generation-tasks': [
    'userId',
    'sessionId',
    'templateId',
    'sourceTaskId',
    'status',
    'executionSnapshotJson',
    'costCredits',
    'description',
    'userNotes',
    'requestHash',
    'isDeleted',
  ],
  media: [
    'owner',
    'isDeleted',
    'lifecycle',
    'purpose',
    'visibility',
    'mimeType',
    'filesize',
    'width',
    'height',
    'sha256',
    'storageBackend',
    'storageBucket',
    'storageName',
  ],
  'saved-artifacts': ['userId', 'artifactId', 'savedAt', 'isDeleted'],
  users: ['status', 'isDeleted'],
} as const
/** Synchronous target-schema gate: no database/Redis fallback to a legacy schema. */
export function assertLibrarySchema({ payload }: { payload: Payload }) {
  for (const [slug, names] of Object.entries(selections)) {
    const required =
      slug === 'saved-artifacts'
        ? [...names, 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'deletedAt', 'deletedBy']
        : names
    const fields = (
      payload.collections as Record<string, Payload['collections'][keyof Payload['collections']]>
    )[slug]?.config.flattenedFields
    if (
      !fields ||
      required.some((name) => !fields.some((field) => field.name === name)) ||
      !fields.some((field) => field.name === 'isDeleted' && field.type === 'checkbox')
    ) {
      throw new Error(`Library requires the complete target schema for ${slug}.`)
    }
  }
}
/** Concrete scan/batch ports only; application code never receives Payload Where, req or SQL. */
export function createLibraryReader({ find }: { find: SnapshotFind }): LibraryReader {
  const query = async ({
    collection,
    limit,
    sort,
    where,
  }: {
    collection: keyof typeof selections
    limit: number
    sort?: string[]
    where: Where
  }) => {
    const result = await find({
      collection,
      limit,
      select: Object.fromEntries(['id', ...selections[collection]].map((field) => [field, true])),
      showHiddenFields: true,
      sort,
      where,
    })
    if (
      !Array.isArray(result.docs) ||
      !Number.isSafeInteger(result.totalDocs) ||
      result.totalDocs < result.docs.length ||
      (limit === 0 ? result.docs.length !== result.totalDocs : result.docs.length > limit)
    ) {
      throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
    }
    return result.docs
  }
  const byIds = ({
    collection,
    ids,
  }: {
    collection: keyof typeof selections
    ids: readonly number[]
  }) =>
    ids.length
      ? query({ collection, limit: ids.length * 2, where: { id: { in: [...ids] } } })
      : Promise.resolve([])
  return Object.freeze({
    actor: ({ userId }) => byIds({ collection: 'users', ids: [userId] }),
    artifacts: ({ ids }) => byIds({ collection: 'artifacts', ids }),
    artifactTuples: ({ tuples }) =>
      tuples.length
        ? query({
            collection: 'artifacts',
            limit: tuples.length * 2,
            where: {
              or: tuples.map((tuple): Where => ({
                and: [
                  { taskId: { equals: tuple.taskId } },
                  { outputIndex: { equals: tuple.outputIndex } },
                ],
              })),
            },
          })
        : Promise.resolve([]),
    attempts: ({ taskIds }) =>
      taskIds.length
        ? query({
            collection: 'generation-attempts',
            limit: 0,
            sort: ['taskId', 'attemptNo', 'id'],
            where: { taskId: { in: [...taskIds] } },
          })
        : Promise.resolve([]),
    favorites: ({ tuples }) =>
      tuples.length
        ? query({
            collection: 'saved-artifacts',
            limit: tuples.length * 2,
            where: {
              or: tuples.map((tuple): Where => ({
                and: [
                  { userId: { equals: tuple.userId } },
                  { artifactId: { equals: tuple.artifactId } },
                ],
              })),
            },
          })
        : Promise.resolve([]),
    media: ({ ids }) => byIds({ collection: 'media', ids }),
    mediaLocators: ({ locators }) =>
      locators.length
        ? query({
            collection: 'media',
            limit: locators.length * 2,
            where: {
              or: locators.map((locator): Where => ({
                and: [
                  { storageBackend: { equals: locator.backend } },
                  { storageBucket: { equals: locator.bucket } },
                  { storageName: { equals: locator.key } },
                ],
              })),
            },
          })
        : Promise.resolve([]),
    scan: ({ after, limit, saved, userId }) => {
      const timeField = saved ? 'savedAt' : 'createdAt'
      const and: Where[] = [{ userId: { equals: userId } }, { isDeleted: { equals: false } }]
      if (after) {
        and.push({
          or: [
            { [timeField]: { less_than: after.time } },
            { and: [{ [timeField]: { equals: after.time } }, { id: { less_than: after.id } }] },
          ],
        })
      }
      return query({
        collection: saved ? 'saved-artifacts' : 'artifacts',
        limit,
        sort: [`-${timeField}`, '-id'],
        where: { and },
      })
    },
    sessions: ({ ids }) => byIds({ collection: 'creation-sessions', ids }),
    tasks: ({ ids }) => byIds({ collection: 'generation-tasks', ids }),
  })
}
