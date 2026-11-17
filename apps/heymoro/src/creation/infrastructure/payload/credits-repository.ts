import type { Payload, PayloadRequest } from 'payload'

import type {
  CreditDependencies,
  CreditLedger,
  CreditReader,
  CreditRepository,
} from '../../application/credits.js'
import type { CreditAccount, CreditGrant, CreditSource } from '../../domain/credits.js'
import type { SnapshotFind } from './read-snapshot.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'
import type { CreationWriteGate } from './write-gate.js'

import { createCreditsService } from '../../application/credits.js'
import { CreditsError, isUTCMilliseconds } from '../../domain/credits.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'
import { createCreationRuntime } from './session-repository.js'
import { createSQLiteUnitOfWork } from './sqlite-unit-of-work.js'

export function createPayloadCreditsService({
  actor,
  clock,
  ...options
}: Pick<CreditDependencies, 'actor' | 'clock'> & SQLiteUnitOfWorkOptions) {
  const userFields = options.payload.collections.users?.config.flattenedFields
  if (
    !userFields?.some((field) => field.name === 'status') ||
    !userFields.some((field) => field.name === 'isDeleted' && field.type === 'checkbox')
  ) {
    throw new Error(
      'Creation credits require users status and an isDeleted checkbox in the target schema.',
    )
  }
  createCreationRuntime({ gate: options.gate, payload: options.payload })
  const write = createSQLiteUnitOfWork(options)
  const read = createSQLiteReadSnapshot({ payload: options.payload })
  return createCreditsService({
    actor,
    clock,
    read: ({ work }) =>
      read({ work: ({ find }) => work({ repository: createCreditReader({ find }) }) }),
    write: ({ resource, work }) =>
      write({
        resource,
        work: ({ req }) =>
          work({
            repository: createPayloadCreditRepository({
              gate: options.gate,
              payload: options.payload,
              req,
            }),
          }),
      }),
  })
}

/** Host-only transaction port. The request remains in this adapter; T1 can share its existing gate and wallet lease. */
export function createPayloadCreditRepository({
  gate,
  payload,
  req,
}: {
  gate: CreationWriteGate
  payload: Payload
  req: PayloadRequest
}): CreditRepository {
  gate.assert({ req })
  const runtime = createCreationRuntime({ gate, payload })
  const find: SnapshotFind = (args) =>
    runtime.find({
      ...args,
      collection: args.collection as Parameters<typeof runtime.find>[0]['collection'],
      req,
    })
  return Object.freeze({
    ...createCreditReader({ find }),
    appendLedger: async ({ actor, entry, now }) => {
      await runtime.create({
        collection: 'credit-ledger',
        data: { ...audit({ actor, now }), ...entry },
        req,
      })
    },
    findLedgerByEvent: async ({ eventKey }) => {
      const { docs } = await find({
        collection: 'credit-ledger',
        limit: 2,
        select: selection({ fields: ledgerFields }),
        where: { eventKey: { equals: eventKey } },
      })
      return docs.map((doc) => ledgerRecord({ doc }))
    },
    insertAccount: async ({ actor, now, userId }) =>
      accountRecord({
        doc: await runtime.create({
          collection: 'credit-accounts',
          data: { ...audit({ actor, now }), availableCredits: 0, reservedCredits: 0, userId },
          req,
        }),
      }),
    insertGrant: async ({ accountId, actor, command, now, userId }) =>
      grantRecord({
        doc: await runtime.create({
          collection: 'credit-grants',
          data: {
            ...audit({ actor, now }),
            ...command,
            accountId,
            availableCredits: command.issuedCredits,
            consumedCredits: 0,
            expiredCredits: 0,
            reservedCredits: 0,
            revokedCredits: 0,
            userId,
          },
          req,
        }),
      }),
    updateGrantBalances: async ({ actor, grant, now }) => {
      await runtime.update({
        id: grant.id,
        collection: 'credit-grants',
        data: {
          availableCredits: grant.availableCredits,
          consumedCredits: grant.consumedCredits,
          expiredCredits: grant.expiredCredits,
          reservedCredits: grant.reservedCredits,
          revokedCredits: grant.revokedCredits,
          updatedAt: now,
          updatedBy: actor,
        },
        req,
      })
    },
    updateProjection: async ({ accountId, actor, balance, now }) => {
      await runtime.update({
        id: accountId,
        collection: 'credit-accounts',
        data: {
          availableCredits: balance.available,
          reservedCredits: balance.reserved,
          updatedAt: now,
          updatedBy: actor,
        },
        req,
      })
    },
  })
}

export function createCreditReader({ find }: { find: SnapshotFind }): CreditReader {
  return Object.freeze({
    findAccounts: async ({ userId }) => {
      const { docs } = await find({
        collection: 'credit-accounts',
        limit: 2,
        select: selection({ fields: ['userId', 'isDeleted'] }),
        where: { userId: { equals: userId } },
      })
      return docs.map((doc) => accountRecord({ doc }))
    },
    findGrantIdentities: async ({ grantKeys }) => {
      if (grantKeys.length === 0 || grantKeys.length > 128) {
        throw integrity()
      }
      // Twice the number of keys suffices: any truncated result necessarily already contains a duplicate.
      const { docs } = await find({
        collection: 'credit-grants',
        limit: grantKeys.length * 2,
        select: selection({ fields: ['grantKey', 'isDeleted'] }),
        where: { grantKey: { in: [...grantKeys] } },
      })
      return docs.map((doc) => ({
        id: integer({ value: doc.id }),
        grantKey: text({ value: doc.grantKey }),
        isDeleted: boolean({ value: doc.isDeleted }),
      }))
    },
    findGrants: async ({ accountId, userId }) => {
      const grants: CreditGrant[] = []
      let lastId: number | undefined
      for (;;) {
        const { docs } = await find({
          collection: 'credit-grants',
          limit: 128,
          select: selection({ fields: grantFields }),
          sort: 'id',
          where: {
            and: [
              accountId === null
                ? { userId: { equals: userId } }
                : { or: [{ userId: { equals: userId } }, { accountId: { equals: accountId } }] },
              ...(lastId === undefined ? [] : [{ id: { greater_than: lastId } }]),
            ],
          },
        })
        for (const doc of docs) {
          const grant = grantRecord({ doc })
          if (lastId !== undefined && grant.id <= lastId) {
            throw integrity()
          }
          grants.push(grant)
          lastId = grant.id
        }
        if (docs.length < 128) {
          return Object.freeze(grants)
        }
      }
    },
    findGrantsByKey: async ({ grantKey }) => {
      const { docs } = await find({
        collection: 'credit-grants',
        limit: 2,
        select: selection({ fields: grantFields }),
        where: { grantKey: { equals: grantKey } },
      })
      return docs.map((doc) => grantRecord({ doc }))
    },
    isAccountActive: async ({ userId }) => {
      const { docs } = await find({
        collection: 'users',
        limit: 2,
        select: selection({ fields: ['status', 'isDeleted'] }),
        where: { id: { equals: userId } },
      })
      if (docs.length > 1) {
        throw integrity()
      }
      return docs.length === 1 && docs[0]!.status === 'active' && docs[0]!.isDeleted === false
    },
  })
}

const grantFields = [
  'accountId',
  'userId',
  'isDeleted',
  'grantKey',
  'sourceType',
  'sourceId',
  'issuedCredits',
  'availableCredits',
  'reservedCredits',
  'consumedCredits',
  'expiredCredits',
  'revokedCredits',
  'validFrom',
  'expiresAt',
]
const ledgerFields = [
  'accountId',
  'userId',
  'grantId',
  'reservationId',
  'isDeleted',
  'eventKey',
  'operation',
  'amountCredits',
  'availableDelta',
  'reservedDelta',
  'consumedDelta',
  'expiredDelta',
  'revokedDelta',
  'reasonCode',
]
function accountRecord({ doc }: { doc: Record<string, unknown> }): CreditAccount {
  return Object.freeze({
    id: integer({ value: doc.id }),
    isDeleted: boolean({ value: doc.isDeleted }),
    userId: integer({ value: doc.userId }),
  })
}
function grantRecord({ doc }: { doc: Record<string, unknown> }): CreditGrant {
  const sourceType = text({ value: doc.sourceType })
  const sources: readonly string[] = ['trial', 'subscription', 'topup', 'compensation']
  if (!sources.includes(sourceType)) {
    throw integrity()
  }
  const sourceId = doc.sourceId == null ? null : text({ value: doc.sourceId })
  if (sourceId !== null && sourceId.length > 128) {
    throw integrity()
  }
  return Object.freeze({
    ...accountRecord({ doc }),
    accountId: integer({ value: doc.accountId }),
    availableCredits: integer({ minimum: 0, value: doc.availableCredits }),
    consumedCredits: integer({ minimum: 0, value: doc.consumedCredits }),
    expiredCredits: integer({ minimum: 0, value: doc.expiredCredits }),
    expiresAt: doc.expiresAt == null ? null : date({ value: doc.expiresAt }),
    grantKey: text({ value: doc.grantKey }),
    issuedCredits: integer({ value: doc.issuedCredits }),
    reservedCredits: integer({ minimum: 0, value: doc.reservedCredits }),
    revokedCredits: integer({ minimum: 0, value: doc.revokedCredits }),
    sourceId,
    sourceType: sourceType as CreditSource,
    validFrom: date({ value: doc.validFrom }),
  })
}
function ledgerRecord({ doc }: { doc: Record<string, unknown> }): CreditLedger {
  return Object.freeze({
    ...accountRecord({ doc }),
    accountId: integer({ value: doc.accountId }),
    amountCredits: integer({ value: doc.amountCredits }),
    availableDelta: integer({ minimum: Number.MIN_SAFE_INTEGER, value: doc.availableDelta }),
    consumedDelta: integer({ minimum: Number.MIN_SAFE_INTEGER, value: doc.consumedDelta }),
    eventKey: text({ value: doc.eventKey }),
    expiredDelta: integer({ minimum: Number.MIN_SAFE_INTEGER, value: doc.expiredDelta }),
    grantId: integer({ value: doc.grantId }),
    operation: text({ value: doc.operation }),
    reasonCode: text({ value: doc.reasonCode }),
    reservationId: doc.reservationId == null ? null : integer({ value: doc.reservationId }),
    reservedDelta: integer({ minimum: Number.MIN_SAFE_INTEGER, value: doc.reservedDelta }),
    revokedDelta: integer({ minimum: Number.MIN_SAFE_INTEGER, value: doc.revokedDelta }),
  })
}
function audit({ actor, now }: { actor: string; now: string }) {
  return {
    createdAt: now,
    createdBy: actor,
    deletedAt: null,
    deletedBy: null,
    isDeleted: false,
    updatedAt: now,
    updatedBy: actor,
  }
}
function selection({ fields }: { fields: string[] }) {
  return Object.fromEntries(['id', ...fields].map((field) => [field, true]))
}
function integer({ minimum = 1, value }: { minimum?: number; value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw integrity()
  }
  return value
}
function text({ value }: { value: unknown }): string {
  if (typeof value !== 'string') {
    throw integrity()
  }
  return value
}
function boolean({ value }: { value: unknown }): boolean {
  if (typeof value !== 'boolean') {
    throw integrity()
  }
  return value
}
function date({ value }: { value: unknown }): string {
  if (typeof value !== 'string' || !isUTCMilliseconds({ value })) {
    throw integrity()
  }
  return value
}
function integrity() {
  return new CreditsError({ code: 'DATA_INTEGRITY_CONFLICT' })
}
