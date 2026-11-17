import type { LibraryAfter } from '../domain/library.js'

export type LibraryDocument = Readonly<Record<string, unknown>>
export type ArtifactDTO = Readonly<{
  createdAt: string
  height: number
  id: number
  isFavorite: boolean
  mediaId: number
  mimeType: string
  outputIndex: number
  savedAt: null | string
  sessionId: number
  taskId: number
  width: number
}>
export type FavoriteTuple = Readonly<{ artifactId: number; userId: number }>
export type ArtifactTuple = Readonly<{ outputIndex: number; taskId: number }>
export type MediaLocator = Readonly<{ backend: string; bucket: string; key: string }>
export type LibraryReader = Readonly<{
  actor: (args: { userId: number }) => Promise<readonly LibraryDocument[]>
  artifacts: (args: { ids: readonly number[] }) => Promise<readonly LibraryDocument[]>
  artifactTuples: (args: {
    tuples: readonly ArtifactTuple[]
  }) => Promise<readonly LibraryDocument[]>
  attempts: (args: { taskIds: readonly number[] }) => Promise<readonly LibraryDocument[]>
  favorites: (args: { tuples: readonly FavoriteTuple[] }) => Promise<readonly LibraryDocument[]>
  media: (args: { ids: readonly number[] }) => Promise<readonly LibraryDocument[]>
  mediaLocators: (args: {
    locators: readonly MediaLocator[]
  }) => Promise<readonly LibraryDocument[]>
  scan: (args: {
    after: LibraryAfter | null
    limit: number
    saved: boolean
    userId: number
  }) => Promise<readonly LibraryDocument[]>
  sessions: (args: { ids: readonly number[] }) => Promise<readonly LibraryDocument[]>
  tasks: (args: { ids: readonly number[] }) => Promise<readonly LibraryDocument[]>
}>
export type LibraryRead = <T>(args: {
  work: (args: { reader: LibraryReader }) => Promise<T>
}) => Promise<T>
export type LibraryOptions = Readonly<{
  batchSize?: number
  cursorKey: Uint8Array
  pageSize?: number
  read: LibraryRead
  scanBudget?: number
}>
export type FavoriteRepository = LibraryReader &
  Readonly<{
    insertFavorite: (
      args: Readonly<{
        actor: string
        artifactId: number
        now: string
        userId: number
      }>,
    ) => Promise<void>
    removeFavorite: (args: Readonly<{ actor: string; id: number; now: string }>) => Promise<void>
    restoreFavorite: (args: Readonly<{ actor: string; id: number; now: string }>) => Promise<void>
  }>
export type FavoriteOptions = Readonly<{
  clock: () => string
  write: <T>(args: {
    artifactId: number
    userId: number
    work: (args: { repository: FavoriteRepository }) => Promise<T>
  }) => Promise<T>
}>
