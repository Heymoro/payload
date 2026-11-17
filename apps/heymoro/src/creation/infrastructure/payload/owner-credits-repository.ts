import type { Payload, Where } from 'payload'

import type {
  OwnerCreditReader,
  OwnerCreditsOptions,
} from '../../application/owner-credits-types.js'
import type { LibraryDocument } from '../../application/owner-library-types.js'
import type { SnapshotFind } from './read-snapshot.js'

import { createOwnerCredits } from '../../application/owner-credits.js'
import { creditIntegrity } from '../../domain/credit-history.js'
import { createCreditReader } from './credits-repository.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'

const deletion = ['isDeleted', 'deletedAt', 'deletedBy'] as const
const selections = {
  'creation-sessions': ['userId', 'templateId', 'mode', 'nextRoundNo', ...deletion],
  'credit-accounts': ['userId', 'availableCredits', 'reservedCredits', ...deletion],
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
    'createdAt',
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
    'reviewAfter',
    ...deletion,
  ],
  'generation-tasks': [
    'userId',
    'sessionId',
    'templateId',
    'sourceTaskId',
    'roundNo',
    'status',
    'costCredits',
    'description',
    'userNotes',
    'executionSnapshotJson',
    'requestHash',
    ...deletion,
  ],
  users: ['status', 'isDeleted'],
} as const

export function createPayloadOwnerCredits({
  payload,
  ...options
}: { payload: Payload } & Omit<OwnerCreditsOptions, 'read'>) {
  for (const [slug, names] of Object.entries(selections)) {
    const fields = (
      payload.collections as Record<string, Payload['collections'][keyof Payload['collections']]>
    )[slug]?.config.flattenedFields
    if (
      !fields ||
      names.some((name) => !fields.some((field) => field.name === name)) ||
      !fields.some((field) => field.name === 'isDeleted' && field.type === 'checkbox')
    ) {
      throw new Error(`Owner credits require the complete target schema for ${slug}.`)
    }
  }
  const snapshot = createSQLiteReadSnapshot({ payload })
  return createOwnerCredits({
    ...options,
    read: ({ work }) =>
      snapshot({ work: ({ find }) => work({ reader: createOwnerCreditReader({ find }) }) }),
  })
}

export function createOwnerCreditReader({ find }: { find: SnapshotFind }): OwnerCreditReader {
  // Limited pages and 2n identity probes are deliberately not required to equal totalDocs.
  const checkedFind: SnapshotFind = async (args) => {
    const result = await find(args)
    const { docs, totalDocs } = result
    if (
      !Array.isArray(docs) ||
      !Number.isSafeInteger(totalDocs) ||
      totalDocs < 0 ||
      docs.length !== (args.limit === 0 ? totalDocs : Math.min(args.limit, totalDocs))
    ) {
      creditIntegrity()
    }
    return result
  }
  const query = async ({
    collection,
    limit = 0,
    sort,
    where,
  }: {
    collection: keyof typeof selections
    limit?: number
    sort?: string[]
    where: Where
  }) =>
    (
      await checkedFind({
        collection,
        limit,
        select: Object.fromEntries(['id', ...selections[collection]].map((field) => [field, true])),
        showHiddenFields: true,
        sort,
        where,
      })
    ).docs
  const batched = async <T>({
    values,
    work,
  }: {
    values: readonly T[]
    work: (batch: readonly T[]) => Promise<readonly LibraryDocument[]>
  }) => {
    const rows: LibraryDocument[] = []
    for (let offset = 0; offset < values.length; offset += 128) {
      rows.push(...(await work(values.slice(offset, offset + 128))))
    }
    return rows
  }
  const ids = ({
    collection,
    values,
  }: {
    collection: keyof typeof selections
    values: readonly number[]
  }) =>
    batched({
      values: [...new Set(values)],
      work: (batch) =>
        query({ collection, limit: batch.length * 2, where: { id: { in: [...batch] } } }),
    })
  const keys = ({
    collection,
    field,
    values,
  }: {
    collection: keyof typeof selections
    field: string
    values: readonly string[]
  }) =>
    batched({
      values: [...new Set(values)],
      work: (batch) =>
        query({ collection, limit: batch.length * 2, where: { [field]: { in: [...batch] } } }),
    })
  const financial = ({ accountId, userId }: { accountId: null | number; userId: number }): Where =>
    accountId === null
      ? { userId: { equals: userId } }
      : { or: [{ userId: { equals: userId } }, { accountId: { equals: accountId } }] }
  return Object.freeze({
    accounts: ({ userId }) =>
      query({ collection: 'credit-accounts', limit: 2, where: { userId: { equals: userId } } }),
    allocations: ({ reservationIds }) =>
      batched({
        values: [...new Set(reservationIds)],
        work: (batch) =>
          query({ collection: 'credit-allocations', where: { reservationId: { in: [...batch] } } }),
      }),
    allocationTuples: ({ tuples }) =>
      batched({
        values: tuples,
        work: (batch) =>
          query({
            collection: 'credit-allocations',
            limit: batch.length * 2,
            where: {
              or: batch.map((tuple): Where => ({
                and: [
                  { reservationId: { equals: tuple.reservationId } },
                  { grantId: { equals: tuple.grantId } },
                ],
              })),
            },
          }),
      }),
    creditReader: createCreditReader({ find: checkedFind }),
    eventKeys: ({ keys: values }) =>
      keys({ collection: 'credit-ledger', field: 'eventKey', values }),
    grantKeys: ({ keys: values }) =>
      keys({ collection: 'credit-grants', field: 'grantKey', values }),
    grants: ({ ids: values }) => ids({ collection: 'credit-grants', values }),
    reservationIds: ({ ids: values }) => ids({ collection: 'credit-reservations', values }),
    reservationLedger: ({ reservationIds, taskIds }) =>
      batched({
        values: taskIds.map((taskId, index) => ({ reservationId: reservationIds[index]!, taskId })),
        work: (batch) =>
          query({
            collection: 'credit-ledger',
            where: {
              or: [
                { reservationId: { in: batch.map((row) => row.reservationId) } },
                ...batch.flatMap(({ taskId }) =>
                  ['reserve', 'capture', 'release'].map((operation): Where => {
                    const prefix = `${operation}:generation:${taskId}:`
                    return {
                      and: [
                        { eventKey: { greater_than_equal: prefix } },
                        { eventKey: { less_than: `${prefix.slice(0, -1)};` } },
                      ],
                    }
                  }),
                ),
              ],
            },
          }),
      }),
    reservations: ({ taskIds }) =>
      batched({
        values: [...new Set(taskIds)],
        work: (batch) =>
          query({
            collection: 'credit-reservations',
            limit: batch.length * 2,
            where: {
              or: [
                { taskId: { in: [...batch] } },
                { reservationKey: { in: batch.map((taskId) => `generation:${taskId}`) } },
              ],
            },
          }),
      }),
    scanLedger: ({ accountId, after, limit, userId }) =>
      query({
        collection: 'credit-ledger',
        limit,
        sort: ['-createdAt', '-id'],
        where: {
          and: [
            financial({ accountId, userId }),
            ...(after
              ? [
                  {
                    or: [
                      { createdAt: { less_than: after.time } },
                      {
                        and: [
                          { createdAt: { equals: after.time } },
                          { id: { less_than: after.id } },
                        ],
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
      }),
    scanReservations: ({ accountId, after, limit, userId }) =>
      query({
        collection: 'credit-reservations',
        limit,
        sort: ['-id'],
        where: {
          and: [
            financial({ accountId, userId }),
            { status: { in: ['reserved', 'reconciliation'] } },
            ...(after ? [{ id: { less_than: after.id } }] : []),
          ],
        },
      }),
    sessions: ({ ids: values }) => ids({ collection: 'creation-sessions', values }),
    tasks: ({ ids: values }) => ids({ collection: 'generation-tasks', values }),
  })
}
