import { setTimeout as pause } from 'node:timers/promises'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

// Retry only acquisition of a new SQLite transaction, never the work itself.
export async function withWriteTransaction<T>({
  req,
  work,
}: {
  req: PayloadRequest
  work: () => Promise<T>
}): Promise<T> {
  let owned = false
  for (let attempt = 0; ; attempt++) {
    const existing = req.transactionID
    try {
      owned = await initTransaction(req)
      break
    } catch (error) {
      if (existing) {
        throw error
      }
      delete req.transactionID // discard only our failed beginTransaction promise
      if (!(error instanceof Error) || !error.message.includes('SQLITE_BUSY') || attempt >= 5) {
        throw error
      }
      await pause(25 * 2 ** attempt)
    }
  }
  try {
    const result = await work()
    if (owned) {
      await commitTransaction(req)
    }
    return result
  } catch (error) {
    if (owned) {
      await killTransaction(req)
    }
    throw error
  }
}
