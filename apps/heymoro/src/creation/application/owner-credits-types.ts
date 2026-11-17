import type { CreditHistoryAfter, CreditHistoryOperation } from '../domain/credit-history.js'
import type { CreditBalance, CreditSource } from '../domain/credits.js'
import type { CreditReader } from './credits.js'
import type { LibraryDocument } from './owner-library-types.js'

export type OwnerCreditAccountDTO = CreditBalance & Readonly<{ configured: boolean }>
export type CreditReservationDTO = Readonly<{
  reservationId: number
  reservedCredits: number
  reviewHint: 'PENDING_REVIEW' | null
  roundNo: number
  sessionId: number
  taskId: number
  taskStatus: 'queued' | 'running' | 'unknown'
}>
export type CreditLedgerDTO = Readonly<{
  availableDelta: number
  createdAt: string
  expiredDelta: number
  id: number
  ledgerDelta: number
  operation: CreditHistoryOperation
  reservationId: null | number
  reservedDelta: number
  sourceType: CreditSource
  statusCredits: null | number
  taskId: null | number
}>
export type CreditAllocationTuple = Readonly<{ grantId: number; reservationId: number }>
export type OwnerCreditReader = Readonly<{
  accounts: (args: { userId: number }) => Promise<readonly LibraryDocument[]>
  allocations: (args: { reservationIds: readonly number[] }) => Promise<readonly LibraryDocument[]>
  allocationTuples: (args: {
    tuples: readonly CreditAllocationTuple[]
  }) => Promise<readonly LibraryDocument[]>
  creditReader: CreditReader
  eventKeys: (args: { keys: readonly string[] }) => Promise<readonly LibraryDocument[]>
  grantKeys: (args: { keys: readonly string[] }) => Promise<readonly LibraryDocument[]>
  grants: (args: { ids: readonly number[] }) => Promise<readonly LibraryDocument[]>
  reservationIds: (args: { ids: readonly number[] }) => Promise<readonly LibraryDocument[]>
  reservationLedger: (args: {
    reservationIds: readonly number[]
    taskIds: readonly number[]
  }) => Promise<readonly LibraryDocument[]>
  reservations: (args: { taskIds: readonly number[] }) => Promise<readonly LibraryDocument[]>
  scanLedger: (args: {
    accountId: null | number
    after: CreditHistoryAfter | null
    limit: number
    userId: number
  }) => Promise<readonly LibraryDocument[]>
  scanReservations: (args: {
    accountId: null | number
    after: CreditHistoryAfter | null
    limit: number
    userId: number
  }) => Promise<readonly LibraryDocument[]>
  sessions: (args: { ids: readonly number[] }) => Promise<readonly LibraryDocument[]>
  tasks: (args: { ids: readonly number[] }) => Promise<readonly LibraryDocument[]>
}>
export type OwnerCreditsOptions = Readonly<{
  clock: () => string
  cursorKey: Uint8Array
  pageSize?: number
  read: <T>(args: { work: (args: { reader: OwnerCreditReader }) => Promise<T> }) => Promise<T>
  readiness: () => boolean
}>

export type OwnerCreditPage<T> = Readonly<{
  hasMore: boolean
  items: readonly T[]
  nextCursor: null | string
}>
