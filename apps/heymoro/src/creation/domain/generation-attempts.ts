import type { ExecutionSnapshot } from './generation.js'

import { GenerationError, generationTime, integer, text } from './generation.js'
export function assertGenerationAttempts({
  attempts,
  snapshot,
  taskId,
}: {
  attempts: readonly Readonly<Record<string, unknown>>[]
  snapshot: ExecutionSnapshot
  taskId: number
}) {
  for (const [index, attempt] of attempts.entries()) {
    integer({ value: attempt.id })
    if (
      deleted({ doc: attempt }) ||
      attempt.taskId !== taskId ||
      attempt.attemptNo !== index + 1 ||
      attempt.provider !== snapshot.executionPlan.provider ||
      attempt.model !== snapshot.executionPlan.model ||
      !['failed', 'output_ready', 'prepared', 'sending', 'succeeded', 'unknown'].includes(
        String(attempt.status),
      )
    ) {
      conflict()
    }
    if (
      index < attempts.length - 1 &&
      (attempt.status !== 'failed' || attempt.errorCode !== 'NOT_SENT')
    ) {
      conflict()
    }
    if (attempt.leaseUntil != null) {
      generationTime({ now: text({ value: attempt.leaseUntil }) })
    }
    const output = [
      'resultStorageBackend',
      'resultStorageBucket',
      'resultStorageKey',
      'resultSha256',
    ].filter((key) => attempt[key] != null)
    if (
      (output.length !== 0 && output.length !== 4) ||
      (['output_ready', 'succeeded'].includes(String(attempt.status)) && output.length !== 4)
    ) {
      conflict()
    }
  }
}
function deleted({ doc }: { doc: Readonly<Record<string, unknown>> }) {
  if (typeof doc.isDeleted !== 'boolean') {
    conflict()
  }
  return doc.isDeleted
}
function conflict(): never {
  throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
}
