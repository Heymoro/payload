import type { CreditReservationDTO, OwnerCreditReader } from './owner-credits-types.js'
import type { LibraryDocument } from './owner-library-types.js'

import { assertCreditHistoryEntry, creditIntegrity } from '../domain/credit-history.js'
import { addCredits } from '../domain/credits.js'
import { GenerationError, integer } from '../domain/generation.js'
import { assertHistoryDeletion, historyExactly, historyTime } from '../domain/task-history.js'
import { assertRelatedGrant, validateTaskSnapshot } from './generation-evidence.js'

export async function projectCreditReservations({
  account,
  now,
  reader,
  reservations,
  userId,
}: {
  account: LibraryDocument | null
  now: string
  reader: OwnerCreditReader
  reservations: readonly LibraryDocument[]
  userId: number
}): Promise<readonly CreditReservationDTO[]> {
  const facts = await readReservationFacts({ account, reader, reservations, userId })
  const reservationIds = creditIds({ values: reservations.map((row) => row.id) })
  const allocations = await reader.allocations({ reservationIds })
  const grants = await readCreditPageGrants({
    account,
    ids: creditIds({ values: allocations.map((row) => row.grantId) }),
    reader,
    userId,
  })
  const ledger = await reader.reservationLedger({
    reservationIds,
    taskIds: facts.map(({ task }) => integer({ value: task.id })),
  })
  const selectedGrantAmounts = new Map<number, number>()
  const seenAllocations = new Set<number>()
  const expectedEvents = new Set<string>()
  let selectedAmount = 0
  const items = facts.map(({ reservation, task }) => {
    if (
      !['reconciliation', 'reserved'].includes(String(reservation.status)) ||
      !['queued', 'running', 'unknown'].includes(String(task.status))
    ) {
      creditIntegrity()
    }
    const amount = integer({ minimum: 0, value: reservation.amountCredits })
    selectedAmount = addCredits({ left: selectedAmount, right: amount })
    let sum = 0
    const seenGrants = new Set<number>()
    for (const allocation of allocations.filter((row) => row.reservationId === reservation.id)) {
      assertCreditRow({ row: allocation })
      const allocationId = integer({ value: allocation.id })
      const grantId = integer({ value: allocation.grantId })
      const allocated = integer({ value: allocation.amountCredits })
      if (
        seenAllocations.has(allocationId) ||
        seenGrants.has(grantId) ||
        allocation.status !== 'reserved'
      ) {
        creditIntegrity()
      }
      seenAllocations.add(allocationId)
      seenGrants.add(grantId)
      sum = addCredits({ left: sum, right: allocated })
      selectedGrantAmounts.set(
        grantId,
        addCredits({ left: selectedGrantAmounts.get(grantId) ?? 0, right: allocated }),
      )
      const grant = historyExactly({ id: grantId, rows: grants })
      const eventKey = `reserve:generation:${integer({ value: task.id })}:${grantId}`
      const matches = ledger.filter((row) => row.eventKey === eventKey)
      if (matches.length !== 1) {
        creditIntegrity()
      }
      const entry = matches[0]!
      assertCreditRow({ row: entry })
      if (
        entry.userId !== userId ||
        entry.accountId !== account?.id ||
        entry.grantId !== grantId ||
        entry.reservationId !== reservation.id ||
        entry.amountCredits !== allocated ||
        entry.operation !== 'reserve'
      ) {
        creditIntegrity()
      }
      assertCreditHistoryEntry({ entry, grant, taskId: integer({ value: task.id }) })
      expectedEvents.add(eventKey)
    }
    if (sum !== amount) {
      creditIntegrity()
    }
    const reviewAfter =
      reservation.reviewAfter == null ? null : historyTime({ value: reservation.reviewAfter })
    return Object.freeze({
      reservationId: integer({ value: reservation.id }),
      reservedCredits: amount,
      reviewHint:
        task.status === 'unknown' ||
        reservation.status === 'reconciliation' ||
        (reviewAfter !== null && reviewAfter <= now)
          ? ('PENDING_REVIEW' as const)
          : null,
      roundNo: integer({ value: task.roundNo }),
      sessionId: integer({ value: task.sessionId }),
      taskId: integer({ value: task.id }),
      taskStatus: task.status as CreditReservationDTO['taskStatus'],
    })
  })
  if (
    seenAllocations.size !== allocations.length ||
    ledger.length !== expectedEvents.size ||
    ledger.some((row) => !expectedEvents.delete(String(row.eventKey))) ||
    expectedEvents.size ||
    selectedAmount > Number(account?.reservedCredits ?? 0)
  ) {
    creditIntegrity()
  }
  for (const [id, amount] of selectedGrantAmounts) {
    if (amount > Number(historyExactly({ id, rows: grants }).reservedCredits)) {
      creditIntegrity()
    }
  }
  return Object.freeze(items)
}

/** Reads only actor and unique raw wallet metadata; lists never calculate the whole wallet. */
export async function readCreditPageAccount({
  reader,
  userId,
}: {
  reader: OwnerCreditReader
  userId: number
}) {
  if (!(await reader.creditReader.isAccountActive({ userId }))) {
    throw new GenerationError({ code: 'UNAUTHENTICATED' })
  }
  const rows = await reader.accounts({ userId })
  if (rows.length > 1) {
    creditIntegrity()
  }
  const account = rows[0] ?? null
  if (account) {
    assertCreditRow({ row: account })
    integer({ value: account.id })
    integer({ minimum: 0, value: account.availableCredits })
    integer({ minimum: 0, value: account.reservedCredits })
    if (account.userId !== userId) {
      creditIntegrity()
    }
  }
  return account
}

/** Global reservation identities, immutable task snapshot and historical parents, not B2's full graph. */
export async function readReservationFacts({
  account,
  reader,
  reservations,
  userId,
}: {
  account: LibraryDocument | null
  reader: OwnerCreditReader
  reservations: readonly LibraryDocument[]
  userId: number
}) {
  if (!reservations.length) {
    return []
  }
  if (!account) {
    creditIntegrity()
  }
  const ids = creditIds({ values: reservations.map((row) => row.id) })
  const taskIds = creditIds({ values: reservations.map((row) => row.taskId) })
  if (ids.length !== reservations.length || taskIds.length !== reservations.length) {
    creditIntegrity()
  }
  const identities = await reader.reservations({ taskIds })
  const tasks = await reader.tasks({ ids: taskIds })
  const sessions = await reader.sessions({
    ids: creditIds({ values: tasks.map((row) => row.sessionId) }),
  })
  return reservations.map((reservation) => {
    assertCreditRow({ row: reservation })
    const taskId = integer({ value: reservation.taskId })
    const key = `generation:${taskId}`
    const matches = identities.filter((row) => row.taskId === taskId || row.reservationKey === key)
    if (
      matches.length !== 1 ||
      matches[0]!.id !== reservation.id ||
      reservation.reservationKey !== key ||
      reservation.userId !== userId ||
      reservation.accountId !== account.id
    ) {
      creditIntegrity()
    }
    const task = historyExactly({ id: taskId, rows: tasks })
    assertHistoryDeletion({ row: task })
    const snapshot = validateTaskSnapshot({ task })
    const session = historyExactly({ id: integer({ value: task.sessionId }), rows: sessions })
    assertHistoryDeletion({ row: session })
    if (
      task.userId !== userId ||
      session.userId !== userId ||
      task.templateId !== session.templateId ||
      snapshot.templateId !== session.templateId ||
      snapshot.mode !== session.mode ||
      integer({ value: task.roundNo }) >= integer({ value: session.nextRoundNo }) ||
      integer({ minimum: 0, value: reservation.amountCredits }) !== task.costCredits
    ) {
      creditIntegrity()
    }
    const expected =
      task.status === 'succeeded'
        ? 'captured'
        : ['cancelled', 'closed', 'failed'].includes(String(task.status))
          ? 'released'
          : ['queued', 'running', 'unknown'].includes(String(task.status))
            ? 'reserved'
            : null
    if (
      !expected ||
      (reservation.status !== expected &&
        !(task.status === 'unknown' && reservation.status === 'reconciliation'))
    ) {
      creditIntegrity()
    }
    if (expected === 'reserved') {
      if (reservation.settledAt != null) {
        creditIntegrity()
      }
    } else {
      historyTime({ value: reservation.settledAt })
    }
    if (reservation.reviewAfter != null) {
      historyTime({ value: reservation.reviewAfter })
    }
    return { reservation, task }
  })
}

export async function readCreditPageGrants({
  account,
  ids,
  reader,
  userId,
}: {
  account: LibraryDocument | null
  ids: readonly number[]
  reader: OwnerCreditReader
  userId: number
}) {
  const grants = await reader.grants({ ids })
  if (grants.length !== ids.length) {
    creditIntegrity()
  }
  const keys: string[] = []
  for (const id of ids) {
    const grant = historyExactly({ id, rows: grants })
    assertCreditRow({ row: grant })
    assertRelatedGrant({ doc: grant })
    if (
      !account ||
      grant.userId !== userId ||
      grant.accountId !== account.id ||
      typeof grant.grantKey !== 'string'
    ) {
      creditIntegrity()
    }
    keys.push(grant.grantKey)
  }
  const identities = await reader.grantKeys({ keys: [...new Set(keys)] })
  for (const grant of grants) {
    const matches = identities.filter((row) => row.grantKey === grant.grantKey)
    if (matches.length !== 1 || matches[0]!.id !== grant.id) {
      creditIntegrity()
    }
  }
  if (identities.length !== grants.length) {
    creditIntegrity()
  }
  return grants
}
export function assertCreditRow({ row }: { row: LibraryDocument }) {
  assertHistoryDeletion({ row })
  if (row.isDeleted !== false) {
    creditIntegrity()
  }
}
export function creditIds({ values }: { values: readonly unknown[] }) {
  return [...new Set(values.map((value) => integer({ value })))]
}
