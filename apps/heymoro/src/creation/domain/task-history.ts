import { GenerationError } from './generation.js'
import { libraryInput, libraryTime, requestId } from './library.js'
import { createSignedCursor } from './signed-cursor.js'
export type TaskHistoryAfter = Readonly<{ roundNo: number }>
export type TaskHistoryScope = Readonly<{ pageSize: number; sessionId: number; userId: number }>
export function normalizeTaskHistoryQuery({ value }: { value: unknown }) {
  const query = libraryInput({ fields: ['cursor'], value })
  if (
    query.cursor !== undefined &&
    (typeof query.cursor !== 'string' || !query.cursor || query.cursor.length > 2048)
  ) {
    throw new GenerationError({ code: 'INPUT_INVALID' })
  }
  return Object.freeze({ cursor: query.cursor as string | undefined })
}
export function createTaskHistoryCursor({ cursorKey }: { cursorKey: Uint8Array }) {
  const envelope = createSignedCursor({ cursorKey })
  const canonical = ({
    after,
    pageSize,
    sessionId,
    userId,
  }: { after: TaskHistoryAfter } & TaskHistoryScope) => ({
    after: { roundNo: requestId({ value: after.roundNo }) },
    endpoint: 'session-generations',
    order: 'roundNo:desc',
    pageSize: requestId({ value: pageSize }),
    sessionId: requestId({ value: sessionId }),
    userId: requestId({ value: userId }),
    v: 1,
  })
  return Object.freeze({
    decode: ({ token, ...scope }: { token: string } & TaskHistoryScope): TaskHistoryAfter => {
      const parsed = envelope.decode({
        normalize: (value) =>
          canonical({ ...scope, after: (value as { after: TaskHistoryAfter }).after }),
        token,
      })
      return Object.freeze(parsed.after)
    },
    encode: (args: { after: TaskHistoryAfter } & TaskHistoryScope) =>
      envelope.encode({ value: canonical(args) }),
  })
}

export function assertHistoryDeletion({ row }: { row: Readonly<Record<string, unknown>> }) {
  if (row.isDeleted === false) {
    if (row.deletedAt != null || row.deletedBy != null) {
      integrity()
    }
  } else if (row.isDeleted === true) {
    historyTime({ value: row.deletedAt })
    if (
      typeof row.deletedBy !== 'string' ||
      !/^(?:(?:user|admin):[1-9]\d*|system:[A-Za-z0-9][\w.-]*)$/.test(row.deletedBy)
    ) {
      integrity()
    }
  } else {
    integrity()
  }
}
export function historyTime({ value }: { value: unknown }) {
  try {
    return libraryTime({ value })
  } catch {
    return integrity()
  }
}
export function historyExactly({
  id,
  rows,
}: {
  id: number
  rows: readonly Readonly<Record<string, unknown>>[]
}) {
  const matches = rows.filter((row) => row.id === id)
  if (matches.length !== 1) {
    integrity()
  }
  return matches[0]!
}

function integrity(): never {
  throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
}
