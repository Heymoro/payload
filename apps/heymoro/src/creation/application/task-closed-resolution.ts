import type { LibraryDocument } from './owner-library-types.js'
import type { TaskClosedResolution } from './owner-task-history-types.js'

import { GenerationError, integer } from '../domain/generation.js'
import { assertHistoryDeletion, historyExactly, historyTime } from '../domain/task-history.js'
import { assertRelatedGrant } from './generation-evidence.js'
/** Historical release facts only. Does not reinterpret expiry or reconcile today's wallet. */
export function projectTaskClosedResolution({
  accounts,
  allocations,
  attempt,
  audits,
  grantIdentities,
  grants,
  ledger,
  reservations,
  task,
}: {
  accounts: readonly LibraryDocument[]
  allocations: readonly LibraryDocument[]
  attempt: LibraryDocument
  audits: readonly LibraryDocument[]
  grantIdentities: readonly LibraryDocument[]
  grants: readonly LibraryDocument[]
  ledger: readonly LibraryDocument[]
  reservations: readonly LibraryDocument[]
  task: LibraryDocument
}): TaskClosedResolution {
  if (
    task.status !== 'closed' ||
    task.errorCode !== 'UNKNOWN_CLOSED' ||
    attempt.status !== 'unknown' ||
    attempt.taskId !== task.id
  ) {
    integrity()
  }
  const key = `generation:${integer({ value: task.id })}`
  const candidates = reservations.filter(
    (row) => row.taskId === task.id || row.reservationKey === key,
  )
  if (candidates.length !== 1) {
    integrity()
  }
  const reservation = candidates[0]!
  live({ row: reservation })
  const closedAt = historyTime({ value: task.finishedAt })
  if (
    reservation.taskId !== task.id ||
    reservation.reservationKey !== key ||
    reservation.userId !== task.userId ||
    reservation.amountCredits !== task.costCredits ||
    reservation.status !== 'released' ||
    reservation.settledAt !== closedAt
  ) {
    integrity()
  }
  const matchedAccounts = accounts.filter(
    (row) => row.userId === task.userId || row.id === reservation.accountId,
  )
  if (matchedAccounts.length !== 1) {
    integrity()
  }
  const account = matchedAccounts[0]!
  live({ row: account })
  if (account.id !== reservation.accountId || account.userId !== task.userId) {
    integrity()
  }
  const parts = allocations.filter((row) => row.reservationId === reservation.id)
  const seen = new Set<number>()
  const expected = new Map<string, LibraryDocument>()
  let amount = 0
  let available = 0
  let expired = 0
  for (const allocation of parts) {
    live({ row: allocation })
    const grantId = integer({ value: allocation.grantId })
    const allocated = integer({ value: allocation.amountCredits })
    if (seen.has(grantId) || !['expired', 'released'].includes(String(allocation.status))) {
      integrity()
    }
    seen.add(grantId)
    amount = add({ left: amount, right: allocated })
    const grant = historyExactly({ id: grantId, rows: grants })
    live({ row: grant })
    assertRelatedGrant({ doc: grant })
    if (grant.accountId !== account.id || grant.userId !== task.userId) {
      integrity()
    }
    const identities = grantIdentities.filter((row) => row.grantKey === grant.grantKey)
    if (identities.length !== 1 || identities[0]!.id !== grant.id) {
      integrity()
    }
    const base = {
      accountId: account.id,
      amountCredits: allocated,
      consumedDelta: 0,
      grantId,
      reservationId: reservation.id,
      revokedDelta: 0,
      userId: task.userId,
    }
    expected.set(`reserve:${key}:${grantId}`, {
      ...base,
      availableDelta: -allocated,
      expiredDelta: 0,
      operation: 'reserve',
      reasonCode: 'GENERATION_RESERVED',
      reservedDelta: allocated,
    })
    expected.set(`release:${key}:${grantId}`, {
      ...base,
      availableDelta: allocation.status === 'released' ? allocated : 0,
      expiredDelta: allocation.status === 'expired' ? allocated : 0,
      operation: 'release',
      reasonCode: 'GENERATION_RELEASED',
      reservedDelta: -allocated,
    })
  }
  const prefixes = ['reserve', 'release', 'capture'].map((operation) => `${operation}:${key}:`)
  const events = ledger.filter(
    (row) =>
      row.reservationId === reservation.id ||
      (typeof row.eventKey === 'string' &&
        prefixes.some((prefix) => String(row.eventKey).startsWith(prefix))),
  )
  if (events.length !== expected.size) {
    integrity()
  }
  for (const event of events) {
    live({ row: event })
    const template = expected.get(String(event.eventKey))
    if (!template || Object.entries(template).some(([field, value]) => event[field] !== value)) {
      integrity()
    }
    expected.delete(String(event.eventKey))
    if (event.operation === 'release') {
      available = add({
        left: available,
        right: integer({ minimum: 0, value: event.availableDelta }),
      })
      expired = add({ left: expired, right: integer({ minimum: 0, value: event.expiredDelta }) })
    }
  }
  if (
    expected.size ||
    amount !== task.costCredits ||
    add({ left: available, right: expired }) !== amount
  ) {
    integrity()
  }
  const logs = audits.filter(
    (row) => row.action === 'GENERATION_UNKNOWN_CLOSED' && row.resourceId === String(task.id),
  )
  if (logs.length !== 1) {
    integrity()
  }
  const audit = logs[0]!
  live({ row: audit })
  if (
    audit.resourceType !== 'generation-task' ||
    audit.result !== 'success' ||
    typeof audit.correlationId !== 'string' ||
    !audit.correlationId.trim() ||
    typeof audit.requestId !== 'string' ||
    !audit.requestId.trim()
  ) {
    integrity()
  }
  for (const [field, status] of [
    ['beforeState', 'unknown'],
    ['afterState', 'closed'],
  ] as const) {
    const value = audit[field]
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value as LibraryDocument).attemptId !== attempt.id ||
      (value as LibraryDocument).status !== status
    ) {
      integrity()
    }
  }
  return Object.freeze({
    closedAt,
    reason: 'UNKNOWN_CLOSED',
    releasedAvailableCredits: available,
    releasedExpiredCredits: expired,
  })
}
function live({ row }: { row: LibraryDocument }) {
  integer({ value: row.id })
  assertHistoryDeletion({ row })
  if (row.isDeleted !== false) {
    integrity()
  }
}
function add({ left, right }: { left: number; right: number }) {
  const result = left + right
  if (!Number.isSafeInteger(result)) {
    integrity()
  }
  return result
}
function integrity(): never {
  throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
}
