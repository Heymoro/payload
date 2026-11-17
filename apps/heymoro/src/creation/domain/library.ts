import { GenerationError, integer } from './generation.js'
import { createSignedCursor } from './signed-cursor.js'

export type LibraryAfter = Readonly<{ id: number; time: string }>
export type LibraryScope = Readonly<{ pageSize: number; saved: boolean; userId: number }>
export function normalizeLibraryQuery({ value }: { value: unknown }) {
  const query = libraryInput({ fields: ['saved', 'cursor'], value })
  if (query.saved !== undefined && query.saved !== 'true' && query.saved !== 'false') {
    invalid()
  }
  if (
    query.cursor !== undefined &&
    (typeof query.cursor !== 'string' || !query.cursor || query.cursor.length > 2048)
  ) {
    invalid()
  }
  return Object.freeze({
    cursor: query.cursor as string | undefined,
    saved: query.saved === 'true',
  })
}
export function libraryInput({
  fields,
  value,
}: {
  fields: readonly string[]
  value: unknown
}): Readonly<Record<string, unknown>> {
  if (
    !value ||
    typeof value !== 'object' ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  ) {
    invalid()
  }
  const copy: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      typeof key !== 'string' ||
      !fields.includes(key) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      invalid()
    }
    copy[key] = descriptor.value
  }
  return Object.freeze(copy)
}
export function requestId({ value }: { value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid()
  }
  return value
}
/** Four-digit UTC keys have the same calendar and lexical order as the database sort. */
export function libraryTime({ value }: { value: unknown }): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    invalid()
  }
  return value
}
export function createLibraryCursor({ cursorKey }: { cursorKey: Uint8Array }) {
  const envelope = createSignedCursor({ cursorKey })
  const canonical = ({
    after,
    pageSize,
    saved,
    userId,
  }: { after: LibraryAfter } & LibraryScope) => {
    requestId({ value: userId })
    requestId({ value: pageSize })
    requestId({ value: after.id })
    libraryTime({ value: after.time })
    if (typeof saved !== 'boolean') {
      invalid()
    }
    return {
      after: { id: after.id, time: after.time },
      endpoint: 'artifacts',
      order: saved ? 'savedAt,id:desc' : 'createdAt,id:desc',
      pageSize,
      saved,
      userId,
      v: 1,
    }
  }
  const encode = (args: { after: LibraryAfter } & LibraryScope) =>
    envelope.encode({ value: canonical(args) })
  const decode = ({ token, ...scope }: { token: string } & LibraryScope): LibraryAfter => {
    const value = envelope.decode({
      normalize: (value) => {
        const parsed = value as { after: LibraryAfter }
        const after = Object.freeze({
          id: requestId({ value: parsed.after.id }),
          time: libraryTime({ value: parsed.after.time }),
        })
        // Keep the existing business normalization and exact V1 field order.
        return canonical({ ...scope, after })
      },
      token,
    })
    return Object.freeze(value.after)
  }
  return Object.freeze({ decode, encode })
}
export function validateFavoriteDocument({
  data,
  originalDoc,
}: {
  data: Record<string, unknown>
  originalDoc?: Record<string, unknown>
}) {
  const merged = { ...originalDoc, ...data }
  requestId({ value: merged.userId })
  requestId({ value: merged.artifactId })
  libraryTime({ value: merged.savedAt })
  if (originalDoc) {
    for (const field of ['userId', 'artifactId']) {
      if (merged[field] !== originalDoc[field]) {
        throw new Error('Favorite identity is immutable.')
      }
    }
    if (originalDoc.isDeleted === false && merged.savedAt !== originalDoc.savedAt) {
      throw new Error('Active favorite savedAt is immutable.')
    }
  }
}
function invalid(): never {
  throw new GenerationError({ code: 'INPUT_INVALID' })
}

/** An owned tombstone may be skipped/cleaned only when its identity and deletion evidence are coherent. */
export function assertLibraryArtifactIdentity({
  artifact,
}: {
  artifact: Readonly<Record<string, unknown>>
}) {
  try {
    for (const field of ['id', 'userId', 'taskId', 'sessionId', 'mediaId']) {
      integer({ value: artifact[field] })
    }
    if (artifact.outputIndex !== 1 || typeof artifact.isDeleted !== 'boolean') {
      throw new Error()
    }
    if (artifact.isDeleted) {
      libraryTime({ value: artifact.deletedAt })
      if (
        typeof artifact.deletedBy !== 'string' ||
        !/^(?:(?:user|admin):[1-9]\d*|system:[A-Za-z0-9][\w.-]*)$/.test(artifact.deletedBy)
      ) {
        throw new Error()
      }
    } else if (artifact.deletedAt != null || artifact.deletedBy != null) {
      throw new Error()
    }
  } catch {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
}
