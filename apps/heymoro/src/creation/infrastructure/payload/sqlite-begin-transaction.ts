import type { BeginTransaction } from 'payload'

import { setTimeout } from 'node:timers/promises'

/** Bounded acquisition only: no caller work, commit, rollback or shared-client mutation. */
export function createSQLiteBeginTransaction({
  beginTransaction,
  wait = ({ delayMs }) => setTimeout(delayMs),
}: {
  beginTransaction: BeginTransaction
  wait?: (args: { delayMs: number }) => Promise<unknown>
}): BeginTransaction {
  return async function (this: unknown, ...parameters: Parameters<BeginTransaction>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await beginTransaction.apply(this, parameters)
      } catch (error) {
        if (attempt === 5 || !isBusyAcquisition({ error })) {
          throw error
        }
        await wait({ delayMs: 25 * 2 ** attempt })
      }
    }
  }
}

function isBusyAcquisition({ error }: { error: unknown }): boolean {
  const seen = new Set<object>()
  let current = error
  let busy = false
  try {
    for (let depth = 0; depth < 8; depth++) {
      if (current === undefined || current === null) {
        return busy
      }
      if (typeof current !== 'object' || seen.has(current)) {
        return false
      }
      seen.add(current)
      const entry = current as {
        cause?: unknown
        code?: unknown
        message?: unknown
        name?: unknown
      }
      const code = entry.code
      const cause = entry.cause
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT') {
        busy = true
      } else if (code !== undefined) {
        return false
      } else {
        const message = entry.message
        const name = entry.name
        // Inspected Payload Drizzle begin wrapper drops the original code/cause.
        // Accept only its exact anchored acquisition prefix and complete BUSY token.
        if (
          name === 'Error' &&
          typeof message === 'string' &&
          /^Error: cannot begin transaction: SQLITE_BUSY(?:_SNAPSHOT)?:(?:\s|$)/.test(message)
        ) {
          busy = true
        }
      }
      current = cause
    }
  } catch {
    // Unknown properties, cause cycles and exhausted inspection bounds fail closed.
  }
  return false
}
