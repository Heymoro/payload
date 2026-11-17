import type { Payload, Where } from 'payload'

import type {
  TaskHistoryOptions,
  TaskHistoryReader,
} from '../../application/owner-task-history-types.js'
import type { SnapshotFind } from './read-snapshot.js'

import { createOwnerTaskHistory } from '../../application/owner-task-history.js'
import { GenerationError } from '../../domain/generation.js'
import { assertLibrarySchema, createLibraryReader } from './owner-library-repository.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'

const deletion = ['isDeleted', 'deletedAt', 'deletedBy'] as const
const selections = {
  artifacts: ['userId', 'taskId', 'sessionId', 'mediaId', 'outputIndex', 'createdAt', ...deletion],
  auditLogs: [
    'action',
    'resourceId',
    'resourceType',
    'result',
    'correlationId',
    'requestId',
    'beforeState',
    'afterState',
    ...deletion,
  ],
  'creation-sessions': ['userId', 'templateId', 'mode', 'nextRoundNo', ...deletion],
  'credit-accounts': ['userId', ...deletion],
  'credit-allocations': ['reservationId', 'grantId', 'status', 'amountCredits', ...deletion],
  'credit-grants': [
    'userId',
    'accountId',
    'grantKey',
    'sourceType',
    'sourceId',
    'validFrom',
    'expiresAt',
    'issuedCredits',
    'availableCredits',
    'reservedCredits',
    'consumedCredits',
    'expiredCredits',
    'revokedCredits',
    ...deletion,
  ],
  'credit-ledger': [
    'userId',
    'accountId',
    'grantId',
    'reservationId',
    'eventKey',
    'operation',
    'reasonCode',
    'amountCredits',
    'availableDelta',
    'reservedDelta',
    'consumedDelta',
    'expiredDelta',
    'revokedDelta',
    ...deletion,
  ],
  'credit-reservations': [
    'userId',
    'accountId',
    'taskId',
    'reservationKey',
    'status',
    'amountCredits',
    'settledAt',
    ...deletion,
  ],
  'generation-attempts': [
    'taskId',
    'attemptNo',
    'provider',
    'model',
    'status',
    'errorCode',
    'leaseUntil',
    'resultStorageBackend',
    'resultStorageBucket',
    'resultStorageKey',
    'resultSha256',
    ...deletion,
  ],
  'generation-inputs': ['userId', 'taskId', 'mediaId', 'position', 'contentSha256', ...deletion],
  'generation-tasks': [
    'userId',
    'sessionId',
    'templateId',
    'sourceTaskId',
    'roundNo',
    'clientRequestId',
    'status',
    'costCredits',
    'errorCode',
    'description',
    'userNotes',
    'executionSnapshotJson',
    'requestHash',
    'createdAt',
    'startedAt',
    'finishedAt',
    ...deletion,
  ],
  media: [
    'owner',
    'lifecycle',
    'purpose',
    'visibility',
    'mimeType',
    'filesize',
    'sha256',
    'storageBackend',
    'storageBucket',
    'storageName',
    ...deletion,
  ],
} as const
export function createPayloadOwnerTaskHistory({
  payload,
  ...options
}: { payload: Payload } & Omit<TaskHistoryOptions, 'read'>) {
  assertLibrarySchema({ payload })
  for (const [slug, names] of Object.entries(selections)) {
    const fields = (
      payload.collections as Record<string, Payload['collections'][keyof Payload['collections']]>
    )[slug]?.config.flattenedFields
    if (
      !fields ||
      names.some((name) => !fields.some((field) => field.name === name)) ||
      !fields.some((field) => field.name === 'isDeleted' && field.type === 'checkbox')
    ) {
      throw new Error(`Task history requires the complete target schema for ${slug}.`)
    }
  }
  const snapshot = createSQLiteReadSnapshot({ payload })
  return createOwnerTaskHistory({
    ...options,
    read: ({ work }) =>
      snapshot({ work: ({ find }) => work({ reader: createTaskHistoryReader({ find }) }) }),
  })
}
export function createTaskHistoryReader({ find }: { find: SnapshotFind }): TaskHistoryReader {
  const completeFind: SnapshotFind = async (args) => {
    const result = await find(args)
    assertResult({ ...result, isComplete: true, limit: args.limit })
    return result
  }
  const query = async ({
    collection,
    isComplete = true,
    limit = 0,
    sort,
    where,
  }: {
    collection: keyof typeof selections
    isComplete?: boolean
    limit?: number
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
    assertResult({ ...result, isComplete, limit })
    return result.docs
  }
  const ids = ({
    collection,
    values,
  }: {
    collection: keyof typeof selections
    values: readonly number[]
  }) =>
    values.length
      ? query({ collection, limit: values.length * 2, where: { id: { in: [...values] } } })
      : Promise.resolve([])
  const associated = ({
    collection,
    field,
    sort,
    values,
  }: {
    collection: keyof typeof selections
    field: string
    sort?: string[]
    values: readonly number[]
  }) =>
    values.length
      ? query({ collection, sort, where: { [field]: { in: [...values] } } })
      : Promise.resolve([])
  return Object.freeze({
    accounts: ({ ids: values, userId }) =>
      query({
        collection: 'credit-accounts',
        limit: values.length * 2 + 2,
        where: { or: [{ userId: { equals: userId } }, { id: { in: [...values] } }] },
      }),
    allocations: ({ reservationIds }) =>
      associated({
        collection: 'credit-allocations',
        field: 'reservationId',
        values: reservationIds,
      }),
    artifacts: ({ taskIds }) =>
      associated({ collection: 'artifacts', field: 'taskId', values: taskIds }),
    attempts: ({ taskIds }) =>
      associated({
        collection: 'generation-attempts',
        field: 'taskId',
        sort: ['taskId', 'attemptNo', 'id'],
        values: taskIds,
      }),
    closureAudits: ({ taskIds }) =>
      taskIds.length
        ? query({
            collection: 'auditLogs',
            limit: taskIds.length * 2,
            where: {
              and: [
                { action: { equals: 'GENERATION_UNKNOWN_CLOSED' } },
                { resourceId: { in: taskIds.map(String) } },
              ],
            },
          })
        : Promise.resolve([]),
    grantKeys: ({ keys }) =>
      keys.length
        ? query({
            collection: 'credit-grants',
            limit: keys.length * 2,
            where: { grantKey: { in: [...keys] } },
          })
        : Promise.resolve([]),
    grants: ({ ids: values }) => ids({ collection: 'credit-grants', values }),
    inputs: ({ taskIds }) =>
      associated({
        collection: 'generation-inputs',
        field: 'taskId',
        sort: ['taskId', 'position', 'id'],
        values: taskIds,
      }),
    ledger: ({ reservationIds, taskIds }) => {
      const prefixes = taskIds.flatMap((taskId) =>
        ['reserve', 'release', 'capture'].map((operation) => `${operation}:generation:${taskId}:`),
      )
      return taskIds.length
        ? query({
            collection: 'credit-ledger',
            where: {
              or: [
                { reservationId: { in: [...reservationIds] } },
                ...prefixes.map((prefix): Where => ({
                  and: [
                    { eventKey: { greater_than_equal: prefix } },
                    { eventKey: { less_than: `${prefix.slice(0, -1)};` } },
                  ],
                })),
              ],
            },
          })
        : Promise.resolve([])
    },
    library: createLibraryReader({ find: completeFind }),
    references: ({ ids: values }) => ids({ collection: 'media', values }),
    requests: ({ tuples }) =>
      tuples.length
        ? query({
            collection: 'generation-tasks',
            limit: tuples.length * 2,
            where: {
              or: tuples.map((tuple): Where => ({
                and: [
                  { userId: { equals: tuple.userId } },
                  { clientRequestId: { equals: tuple.clientRequestId } },
                ],
              })),
            },
          })
        : Promise.resolve([]),
    reservations: ({ taskIds }) =>
      taskIds.length
        ? query({
            collection: 'credit-reservations',
            limit: taskIds.length * 2,
            where: {
              or: [
                { taskId: { in: [...taskIds] } },
                { reservationKey: { in: taskIds.map((taskId) => `generation:${taskId}`) } },
              ],
            },
          })
        : Promise.resolve([]),
    rounds: ({ tuples }) =>
      tuples.length
        ? query({
            collection: 'generation-tasks',
            limit: tuples.length * 2,
            where: {
              or: tuples.map((tuple): Where => ({
                and: [
                  { sessionId: { equals: tuple.sessionId } },
                  { roundNo: { equals: tuple.roundNo } },
                ],
              })),
            },
          })
        : Promise.resolve([]),
    scan: ({ after, limit, sessionId }) =>
      query({
        collection: 'generation-tasks',
        isComplete: false,
        limit,
        sort: ['-roundNo', '-id'],
        where: {
          and: [
            { sessionId: { equals: sessionId } },
            ...(after ? [{ roundNo: { less_than: after.roundNo } }] : []),
          ],
        },
      }),
    sessions: ({ ids: values }) => ids({ collection: 'creation-sessions', values }),
    tasks: ({ ids: values }) => ids({ collection: 'generation-tasks', values }),
  })
}
function assertResult({
  docs,
  isComplete,
  limit,
  totalDocs,
}: {
  docs: unknown
  isComplete: boolean
  limit: number
  totalDocs: number
}) {
  // A bounded 2n identity query is complete or fails; overflow proves ambiguity, never silently truncates.
  if (
    !Array.isArray(docs) ||
    !Number.isSafeInteger(totalDocs) ||
    totalDocs < docs.length ||
    (limit > 0 && docs.length > limit) ||
    (isComplete ? docs.length !== totalDocs : docs.length !== Math.min(totalDocs, limit))
  ) {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
}
