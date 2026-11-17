import type { Client } from '@libsql/client'
import type { Payload, PayloadRequest, Where } from 'payload'

import { drizzle } from 'drizzle-orm/libsql'
import { randomUUID } from 'node:crypto'
import { createPayloadRequest } from 'payload'

import { getCreationSQLiteAdapter } from './sqlite-unit-of-work.js'

export type SnapshotFindArguments = {
  collection: string
  limit: number
  select: Record<string, boolean>
  showHiddenFields?: true
  sort?: string | string[]
  where?: Where
}
export type SnapshotFind = (
  args: SnapshotFindArguments,
) => Promise<{ docs: Record<string, unknown>[]; totalDocs: number }>

/** Owns a read snapshot; exposes only find, never a request, write gate, or arbitrary transaction callback. */
export function createSQLiteReadSnapshot({ payload }: { payload: Payload }) {
  const adapter = getCreationSQLiteAdapter({ payload })
  const local = payload as unknown as {
    find: (
      args: {
        depth: 0
        overrideAccess: true
        pagination: false
        req: PayloadRequest
      } & SnapshotFindArguments,
    ) => Promise<unknown>
  }
  return async function readSnapshot<T>({
    work,
  }: {
    work: (args: { find: SnapshotFind }) => Promise<T>
  }): Promise<T> {
    await adapter.initializing
    const req = await createPayloadRequest({ payload })
    const transaction = await adapter.client.transaction('deferred')
    // Transaction supplies the execute/batch methods used by Drizzle queries; it is not exposed to callers.
    let database: ReturnType<typeof drizzle>
    try {
      database = drizzle(transaction as unknown as Client, { schema: adapter.schema })
    } catch (error) {
      transaction.close()
      throw error
    }
    const transactionID = randomUUID()
    let isAborted = false
    let isSealed = false
    let pending: Promise<unknown> | undefined
    const abort = () => {
      isAborted = true
    }
    const assert = () => {
      if (
        isAborted ||
        transaction.closed ||
        req.transactionID !== transactionID ||
        adapter.sessions[transactionID]?.db !== database
      ) {
        abort()
        throw new Error('Creation read snapshot is permanently aborted or detached.')
      }
    }
    req.transactionID = transactionID
    adapter.sessions[transactionID] = {
      db: database,
      reject: () => {
        abort()
        return Promise.resolve()
      },
      resolve: () => {
        abort()
        return Promise.reject(new Error('Manual read snapshot commit is forbidden.'))
      },
    }
    const find: SnapshotFind = async (args) => {
      if (isSealed) {
        throw new Error('Creation read snapshot is sealed.')
      }
      assert()
      if (pending) {
        abort()
        throw new Error('Concurrent snapshot operations are forbidden.')
      }
      const operation = Promise.resolve().then(async () => {
        assert()
        const result = await local.find({
          ...args,
          depth: 0,
          overrideAccess: true,
          pagination: false,
          req,
        })
        assert()
        if (
          !result ||
          typeof result !== 'object' ||
          !('docs' in result) ||
          !Array.isArray(result.docs) ||
          !('totalDocs' in result) ||
          typeof result.totalDocs !== 'number' ||
          !Number.isSafeInteger(result.totalDocs) ||
          result.totalDocs < 0
        ) {
          throw new Error('Invalid snapshot result.')
        }
        return { docs: result.docs as Record<string, unknown>[], totalDocs: result.totalDocs }
      })
      pending = operation
      try {
        return await operation
      } catch (error) {
        abort()
        throw error
      } finally {
        pending = undefined
      }
    }
    try {
      const result = await work({ find })
      isSealed = true
      assert()
      if (pending) {
        abort()
        throw new Error('Read snapshot has unawaited operations.')
      }
      await transaction.commit()
      return result
    } catch (error) {
      isSealed = true
      abort()
      await pending?.catch(() => undefined)
      try {
        await transaction.rollback()
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Read snapshot rollback failed.')
      }
      throw error
    } finally {
      isSealed = true
      abort()
      try {
        transaction.close()
      } finally {
        delete adapter.sessions[transactionID]
        delete req.transactionID
      }
    }
  }
}
