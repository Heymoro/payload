import type { LibraryAfter } from './library.js'

import { GenerationError } from './generation.js'
import { libraryInput, libraryTime, requestId } from './library.js'
import { createSignedCursor } from './signed-cursor.js'

export type SessionsAfter = LibraryAfter
export type SessionsScope = Readonly<{ pageSize: number; userId: number }>
export function normalizeSessionsQuery({ value }: { value: unknown }) {
  const query = libraryInput({ fields: ['cursor'], value })
  if (
    query.cursor !== undefined &&
    (typeof query.cursor !== 'string' || !query.cursor || query.cursor.length > 2048)
  ) {
    throw new GenerationError({ code: 'INPUT_INVALID' })
  }
  return Object.freeze({ cursor: query.cursor as string | undefined })
}
export function createSessionsCursor({ cursorKey }: { cursorKey: Uint8Array }) {
  const envelope = createSignedCursor({ cursorKey })
  const canonical = ({ after, pageSize, userId }: { after: SessionsAfter } & SessionsScope) => ({
    after: { id: requestId({ value: after.id }), time: libraryTime({ value: after.time }) },
    endpoint: 'creation-sessions',
    order: 'lastActivityAt,id:desc',
    pageSize: requestId({ value: pageSize }),
    userId: requestId({ value: userId }),
    v: 1,
  })
  return Object.freeze({
    decode: ({ token, ...scope }: { token: string } & SessionsScope): SessionsAfter => {
      const value = envelope.decode({
        normalize: (parsed) =>
          canonical({
            ...scope,
            after: (parsed as { after: SessionsAfter }).after,
          }),
        token,
      })
      return Object.freeze(value.after)
    },
    encode: (args: { after: SessionsAfter } & SessionsScope) =>
      envelope.encode({ value: canonical(args) }),
  })
}
