import type { Client, Transaction } from '@libsql/client'
import type { Payload, PayloadRequest } from 'payload'

import { drizzle } from 'drizzle-orm/libsql'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { createPayloadRequest } from 'payload'

import type { CreationTransactionBinding, CreationWriteGate } from './write-gate.js'

export type CreationCoordinator = <T>(args: {
  resource: string
  work: (args: { assertLease: () => void }) => Promise<T>
}) => Promise<T>
export type SQLiteRetryPolicy = Readonly<{ backoffMs: number; maxAttempts: number }>
export type SQLiteUnitOfWorkOptions = Readonly<{
  coordinate: CreationCoordinator
  gate: CreationWriteGate
  payload: Payload
  retry: SQLiteRetryPolicy
}>

export type CreationSQLiteAdapter = {
  client: Client
  initializing: Promise<void>
  schema: Record<string, unknown>
  sessions: Record<
    string,
    {
      db: { run: (query: string) => Promise<unknown> }
      reject: () => Promise<void>
      resolve: () => Promise<void>
    }
  >
}

type Attempt = {
  assertBeforeCommit?: () => void
  closeError?: unknown
  commitError?: unknown
  commitStarted: boolean
  hasBegun: boolean
  ownedTransaction?: Transaction
  rollbackConfirmed: boolean
  rollbackError?: unknown
  workError?: unknown
}

export class CreationTransactionError extends Error {
  readonly commitStarted: boolean
  readonly rollbackConfirmed: boolean

  constructor({ attempt, error }: { attempt: Attempt; error: unknown }) {
    super(
      attempt.commitStarted
        ? 'Creation transaction commit outcome is unknown; do not automatically retry.'
        : 'Creation transaction rollback was not confirmed; do not automatically retry.',
      {
        cause: new AggregateError(
          [
            attempt.workError,
            attempt.commitError,
            attempt.rollbackError,
            attempt.closeError,
            error,
          ].filter((value) => value !== undefined),
          'Transaction failure evidence',
        ),
      },
    )
    this.name = 'CreationTransactionError'
    this.commitStarted = attempt.commitStarted
    this.rollbackConfirmed = attempt.rollbackConfirmed
  }
}

/** DB-only callback: coordination and any network work must stay outside this transaction. */
export function createSQLiteUnitOfWork({
  coordinate,
  gate,
  payload,
  retry,
}: SQLiteUnitOfWorkOptions) {
  const { backoffMs, maxAttempts } = retry
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10 ||
    !Number.isSafeInteger(backoffMs) ||
    backoffMs < 0 ||
    backoffMs > 1000
  ) {
    throw new RangeError('SQLite retries require 1–10 attempts and 0–1000 ms bounded backoff.')
  }
  const adapter = getCreationSQLiteAdapter({ payload })

  return async function runSQLiteUnitOfWork<T>({
    resource,
    work,
  }: {
    resource: string
    work: (args: { req: PayloadRequest }) => Promise<T>
  }): Promise<T> {
    return coordinate({
      resource,
      work: async ({ assertLease }) => {
        await adapter.initializing
        for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
          assertLease()
          const attempt: Attempt = {
            commitStarted: false,
            hasBegun: false,
            rollbackConfirmed: false,
          }
          // A fresh handle avoids mutating the framework's shared client or Drizzle session.
          const database = drizzle(deferredClient({ attempt, client: adapter.client }), {
            schema: adapter.schema,
          })
          const req = await createPayloadRequest({ payload })
          const transactionID = randomUUID()
          let binding: CreationTransactionBinding | undefined
          let outcome:
            | { error: unknown; isSuccess: false }
            | { isSuccess: true; value: T }
            | undefined
          try {
            const value = await database.transaction(
              async (transaction) => {
                req.transactionID = transactionID
                binding = gate.bind({
                  assertLease,
                  req,
                  sessions: adapter.sessions,
                  transaction,
                  transactionID,
                })
                const activeBinding = binding
                attempt.assertBeforeCommit = activeBinding.assertCommit
                adapter.sessions[transactionID] = {
                  db: transaction,
                  // eslint-disable-next-line @typescript-eslint/require-await -- Promise adapter preserves asynchronous error delivery.
                  reject: async () => {
                    activeBinding.abort()
                  },
                  // eslint-disable-next-line @typescript-eslint/require-await -- Promise adapter preserves asynchronous error delivery.
                  resolve: async () => {
                    activeBinding.abort()
                    throw new Error('Manual creation transaction commit is forbidden.')
                  },
                }
                try {
                  activeBinding.assert()
                  const result = await work({ req })
                  activeBinding.seal()
                  return result
                } catch (error) {
                  attempt.workError = error
                  activeBinding.abort()
                  await activeBinding.settle()
                  throw error
                }
              },
              { behavior: 'deferred' },
            )
            outcome = { isSuccess: true, value }
          } catch (error) {
            outcome = { error, isSuccess: false }
          } finally {
            binding?.close()
            try {
              // Local libsql close rolls back a still-open owned tx, including a failed rollback path.
              attempt.ownedTransaction?.close()
            } catch (error) {
              attempt.closeError = error
            } finally {
              delete adapter.sessions[transactionID]
              delete req.transactionID
            }
          }
          if (!outcome) {
            throw new Error('SQLite transaction returned no outcome.')
          }
          if (attempt.closeError !== undefined) {
            throw new CreationTransactionError({
              attempt,
              error: outcome.isSuccess ? attempt.closeError : outcome.error,
            })
          }
          if (outcome.isSuccess) {
            return outcome.value
          }
          const { error } = outcome
          if (attempt.commitStarted || (attempt.hasBegun && !attempt.rollbackConfirmed)) {
            throw new CreationTransactionError({ attempt, error })
          }
          if (attemptNo === maxAttempts || !isSQLiteBusy({ error })) {
            throw error
          }
          // Cleanup never proves a failed commit did not occur. Retry only after Drizzle's confirmed rollback (or failed local begin).
          await setTimeout(backoffMs)
        }
        throw new Error('SQLite attempt budget exhausted.')
      },
    })
  }
}

export function getCreationSQLiteAdapter({ payload }: { payload: Payload }): CreationSQLiteAdapter {
  const candidate: unknown = payload.db
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('name' in candidate) ||
    candidate.name !== 'sqlite' ||
    !('client' in candidate) ||
    typeof candidate.client !== 'object' ||
    candidate.client === null ||
    !('transaction' in candidate.client) ||
    typeof candidate.client.transaction !== 'function' ||
    !('schema' in candidate) ||
    typeof candidate.schema !== 'object' ||
    candidate.schema === null ||
    !('sessions' in candidate) ||
    typeof candidate.sessions !== 'object' ||
    candidate.sessions === null ||
    !('initializing' in candidate) ||
    !('autoIncrement' in candidate) ||
    candidate.autoIncrement !== true ||
    !('idType' in candidate) ||
    candidate.idType !== 'number' ||
    !('clientConfig' in candidate) ||
    typeof candidate.clientConfig !== 'object' ||
    candidate.clientConfig === null ||
    !('url' in candidate.clientConfig) ||
    typeof candidate.clientConfig.url !== 'string' ||
    !candidate.clientConfig.url.startsWith('file:')
  ) {
    throw new Error('Creation requires a local SQLite adapter with numeric AUTOINCREMENT IDs.')
  }
  // DatabaseAdapter has cross-adapter declaration merging; the checked local SQLite runtime is the boundary.
  return candidate as unknown as CreationSQLiteAdapter
}

/** Drizzle libsql currently ignores behavior; bind its private-field client methods and force the real mode. */
function deferredClient({ attempt, client }: { attempt: Attempt; client: Client }): Client {
  return new Proxy(client, {
    get: (target, property) => {
      if (property === 'transaction') {
        return async () => {
          const transaction = await target.transaction('deferred')
          attempt.hasBegun = true
          attempt.ownedTransaction = transaction
          return observedTransaction({ attempt, transaction })
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function observedTransaction({
  attempt,
  transaction,
}: {
  attempt: Attempt
  transaction: Transaction
}): Transaction {
  return new Proxy(transaction, {
    get: (target, property) => {
      if (property === 'commit') {
        return async () => {
          attempt.assertBeforeCommit?.()
          attempt.commitStarted = true
          try {
            await target.commit()
          } catch (error) {
            attempt.commitError = error
            throw error
          }
        }
      }
      if (property === 'rollback') {
        return async () => {
          try {
            await target.rollback()
            attempt.rollbackConfirmed = true
          } catch (error) {
            attempt.rollbackError = error
            throw error
          }
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function isSQLiteBusy({ error }: { error: unknown }): boolean {
  const seen = new Set<unknown>()
  let current = error
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current)
    if (
      'code' in current &&
      (current.code === 'SQLITE_BUSY' || current.code === 'SQLITE_BUSY_SNAPSHOT')
    ) {
      return true
    }
    current = 'cause' in current ? current.cause : undefined
  }
  return false
}
