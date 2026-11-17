import type { SessionsAfter } from '../domain/session-history.js'
import type { DraftReader, DraftResult } from './draft.js'
import type { ArtifactDTO, LibraryDocument, LibraryReader } from './owner-library-types.js'

export type SessionSummaryDTO = Readonly<{
  cover: ArtifactDTO | null
  id: number
  lastActivityAt: string
  mode: 'effect' | 'free'
  runningTask: null | Readonly<{
    id: number
    roundNo: number
    status: 'queued' | 'running' | 'unknown'
  }>
  templateId: number
  title: string
  titleSource: 'ai' | 'template' | 'user'
}>
export type SessionDetailDTO = Readonly<{
  creationClientRequestId: string
  draft: DraftResult
}> &
  SessionSummaryDTO
export type SessionsReader = Readonly<{
  draft: DraftReader
  inflight: (args: { sessionIds: readonly number[] }) => Promise<readonly LibraryDocument[]>
  library: LibraryReader
  profiles: (args: { ids: readonly number[] }) => Promise<readonly LibraryDocument[]>
  requestProfiles: (args: {
    clientRequestId: string
    userId: number
  }) => Promise<readonly LibraryDocument[]>
  scan: (args: {
    after: null | SessionsAfter
    limit: number
    userId: number
  }) => Promise<readonly LibraryDocument[]>
}>
export type SessionsOptions = Readonly<{
  cursorKey: Uint8Array
  pageSize?: number
  read: <T>(args: { work: (args: { reader: SessionsReader }) => Promise<T> }) => Promise<T>
}>
