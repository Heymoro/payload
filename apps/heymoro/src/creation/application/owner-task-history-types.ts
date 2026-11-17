import type { TaskDTO } from '../domain/generation.js'
import type { TaskHistoryAfter } from '../domain/task-history.js'
import type { LibraryDocument, LibraryReader } from './owner-library-types.js'
export type TaskClosedResolution = Readonly<{
  closedAt: string
  reason: 'UNKNOWN_CLOSED'
  releasedAvailableCredits: number
  releasedExpiredCredits: number
}>
export type TaskHistoryDTO = Readonly<{
  artifactIds: readonly number[]
  createdAt: string
  finishedAt: null | string
  inputAvailability: readonly Readonly<{
    mediaId: number
    position: number
    status: 'active' | 'unavailable'
  }>[]
  resolution: null | TaskClosedResolution
  startedAt: null | string
}> &
  TaskDTO
export type TaskRoundTuple = Readonly<{ roundNo: number; sessionId: number }>
export type TaskRequestTuple = Readonly<{ clientRequestId: string; userId: number }>
export type TaskHistoryReader = Readonly<{
  accounts: (args: {
    ids: readonly number[]
    userId: number
  }) => Promise<readonly LibraryDocument[]>
  allocations: (args: { reservationIds: readonly number[] }) => Promise<readonly LibraryDocument[]>
  artifacts: (args: { taskIds: readonly number[] }) => Promise<readonly LibraryDocument[]>
  attempts: (args: { taskIds: readonly number[] }) => Promise<readonly LibraryDocument[]>
  closureAudits: (args: { taskIds: readonly number[] }) => Promise<readonly LibraryDocument[]>
  grantKeys: (args: { keys: readonly string[] }) => Promise<readonly LibraryDocument[]>
  grants: (args: { ids: readonly number[] }) => Promise<readonly LibraryDocument[]>
  inputs: (args: { taskIds: readonly number[] }) => Promise<readonly LibraryDocument[]>
  ledger: (args: {
    reservationIds: readonly number[]
    taskIds: readonly number[]
  }) => Promise<readonly LibraryDocument[]>
  library: LibraryReader
  references: (args: { ids: readonly number[] }) => Promise<readonly LibraryDocument[]>
  requests: (args: { tuples: readonly TaskRequestTuple[] }) => Promise<readonly LibraryDocument[]>
  reservations: (args: { taskIds: readonly number[] }) => Promise<readonly LibraryDocument[]>
  rounds: (args: { tuples: readonly TaskRoundTuple[] }) => Promise<readonly LibraryDocument[]>
  scan: (args: {
    after: null | TaskHistoryAfter
    limit: number
    sessionId: number
  }) => Promise<readonly LibraryDocument[]>
  sessions: (args: { ids: readonly number[] }) => Promise<readonly LibraryDocument[]>
  tasks: (args: { ids: readonly number[] }) => Promise<readonly LibraryDocument[]>
}>
export type TaskHistoryOptions = Readonly<{
  batchSize?: number
  cursorKey: Uint8Array
  pageSize?: number
  read: <T>(args: { work: (args: { reader: TaskHistoryReader }) => Promise<T> }) => Promise<T>
  scanBudget?: number
}>
