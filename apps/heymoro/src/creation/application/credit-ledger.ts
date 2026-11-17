import type { CreditHistoryOperation } from '../domain/credit-history.js'
import type { CreditSource } from '../domain/credits.js'
import type { CreditLedgerDTO, OwnerCreditReader } from './owner-credits-types.js'
import type { LibraryDocument } from './owner-library-types.js'

import { assertCreditHistoryEntry, creditIntegrity } from '../domain/credit-history.js'
import { integer } from '../domain/generation.js'
import { historyExactly, historyTime } from '../domain/task-history.js'
import {
  assertCreditRow,
  creditIds,
  readCreditPageGrants,
  readReservationFacts,
} from './credit-reservations.js'

export async function projectCreditLedger({
  account,
  entries,
  reader,
  userId,
}: {
  account: LibraryDocument | null
  entries: readonly LibraryDocument[]
  reader: OwnerCreditReader
  userId: number
}): Promise<readonly CreditLedgerDTO[]> {
  if (!entries.length) {
    return Object.freeze([])
  }
  if (!account) {
    creditIntegrity()
  }
  const keys = entries.map((row) => {
    assertCreditRow({ row })
    integer({ value: row.id })
    if (row.userId !== userId || row.accountId !== account.id || typeof row.eventKey !== 'string') {
      creditIntegrity()
    }
    return row.eventKey
  })
  const identities = await reader.eventKeys({ keys: [...new Set(keys)] })
  if (identities.length !== entries.length) {
    creditIntegrity()
  }
  for (const entry of entries) {
    const matches = identities.filter((row) => row.eventKey === entry.eventKey)
    if (matches.length !== 1 || matches[0]!.id !== entry.id) {
      creditIntegrity()
    }
  }
  const grants = await readCreditPageGrants({
    account,
    ids: creditIds({ values: entries.map((row) => row.grantId) }),
    reader,
    userId,
  })
  const taskEntries = entries.filter((entry) =>
    ['capture', 'release', 'reserve'].includes(String(entry.operation)),
  )
  const reservationIds = creditIds({ values: taskEntries.map((row) => row.reservationId) })
  const reservations = await reader.reservationIds({ ids: reservationIds })
  if (reservations.length !== reservationIds.length) {
    creditIntegrity()
  }
  for (const id of reservationIds) {
    historyExactly({ id, rows: reservations })
  }
  const facts = await readReservationFacts({ account, reader, reservations, userId })
  const tuples = taskEntries.map((entry) => ({
    grantId: integer({ value: entry.grantId }),
    reservationId: integer({ value: entry.reservationId }),
  }))
  const allocations = await reader.allocationTuples({
    tuples: tuples.filter(
      (tuple, index) =>
        tuples.findIndex(
          (row) => row.reservationId === tuple.reservationId && row.grantId === tuple.grantId,
        ) === index,
    ),
  })
  return Object.freeze(
    entries.map((entry) => {
      const grant = historyExactly({ id: integer({ value: entry.grantId }), rows: grants })
      let taskId: null | number = null
      if (['capture', 'release', 'reserve'].includes(String(entry.operation))) {
        const reservationId = integer({ value: entry.reservationId })
        const fact = facts.find(({ reservation }) => reservation.id === reservationId)
        if (!fact) {
          creditIntegrity()
        }
        taskId = integer({ value: fact.task.id })
        const matches = allocations.filter(
          (row) => row.reservationId === reservationId && row.grantId === grant.id,
        )
        if (matches.length !== 1) {
          creditIntegrity()
        }
        const allocation = matches[0]!
        assertCreditRow({ row: allocation })
        integer({ value: allocation.id })
        const amount = integer({ value: allocation.amountCredits })
        const state = fact.reservation.status
        if (
          amount !== entry.amountCredits ||
          amount > Number(fact.reservation.amountCredits) ||
          (state === 'released'
            ? !['expired', 'released'].includes(String(allocation.status))
            : allocation.status !== (state === 'reconciliation' ? 'reserved' : state)) ||
          (entry.operation === 'capture' && state !== 'captured') ||
          (entry.operation === 'release' && state !== 'released')
        ) {
          creditIntegrity()
        }
        if (
          entry.operation === 'release' &&
          (allocation.status === 'expired'
            ? entry.expiredDelta !== amount || entry.availableDelta !== 0
            : entry.availableDelta !== amount || entry.expiredDelta !== 0)
        ) {
          creditIntegrity()
        }
      } else if (entry.reservationId != null) {
        creditIntegrity()
      }
      const display = assertCreditHistoryEntry({ entry, grant, taskId })
      return Object.freeze({
        ...display,
        id: integer({ value: entry.id }),
        availableDelta: integer({ minimum: Number.MIN_SAFE_INTEGER, value: entry.availableDelta }),
        createdAt: historyTime({ value: entry.createdAt }),
        expiredDelta: integer({ minimum: 0, value: entry.expiredDelta }),
        operation: entry.operation as CreditHistoryOperation,
        reservationId: taskId === null ? null : integer({ value: entry.reservationId }),
        reservedDelta: integer({ minimum: Number.MIN_SAFE_INTEGER, value: entry.reservedDelta }),
        sourceType: grant.sourceType as CreditSource,
        taskId,
      })
    }),
  )
}
