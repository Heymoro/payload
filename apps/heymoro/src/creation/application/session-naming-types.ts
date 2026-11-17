import type { RenameReader } from './generation-reader-types.js'
import type { SessionRecord } from './session.js'

export type NamingStatus = SessionRecord['autoNameStatus']
export type NamingSession = Readonly<{
  id: number
  namedAt: null | string
  startedAt: null | string
  status: NamingStatus
  title: string
  titleSource: SessionRecord['titleSource']
  userId: number
}>
export type TitleRepository<Reader = RenameReader> = Reader &
  Readonly<{
    updateSession: (args: {
      data: Readonly<{
        autoNamedAt?: string
        autoNameStartedAt?: string
        autoNameStatus?: NamingStatus
        title?: string
        titleSource?: SessionRecord['titleSource']
        updatedAt: string
        updatedBy: string
      }>
      session: NamingSession
    }) => Promise<void>
  }>
export type TitlePersistence<Reader = RenameReader> = Readonly<{
  isCommitUnknown: (args: { error: unknown }) => boolean
  read: <T>(args: { work: (args: { reader: Reader }) => Promise<T> }) => Promise<T>
  write: <T>(args: {
    session: Pick<NamingSession, 'id' | 'userId'>
    work: (args: { repository: TitleRepository<Reader> }) => Promise<T>
  }) => Promise<T>
}>
export type NamingEngineResult = Readonly<
  { requestId: null | string } & (
    | { kind: 'name'; name: string }
    | { kind: 'not_sent' | 'rejected' | 'unknown' }
  )
>
export type NamingEngine = (args: {
  image: Readonly<{ bytes: Uint8Array; mimeType: string }>
  input: Readonly<{ description: string; intent: string; userNotes: string }>
  signal: AbortSignal
}) => Promise<NamingEngineResult>
