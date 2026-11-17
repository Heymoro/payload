import type {
  ArtifactDTO,
  LibraryDocument,
  LibraryOptions,
  LibraryReader,
} from './owner-library-types.js'

import { GenerationError, generationResultKey, integer, text } from '../domain/generation.js'
import {
  assertLibraryArtifactIdentity,
  createLibraryCursor,
  libraryInput,
  libraryTime,
  normalizeLibraryQuery,
  requestId,
} from '../domain/library.js'
import { validateTaskSnapshot } from './generation-evidence.js'

export function createOwnerLibrary({
  batchSize = 50,
  cursorKey,
  pageSize = 20,
  read,
  scanBudget = 500,
}: LibraryOptions) {
  for (const [value, max] of [
    [pageSize, 50],
    [batchSize, 128],
    [scanBudget, 10000],
  ]) {
    if (!Number.isSafeInteger(value) || value! < 1 || value! > max!) {
      throw new Error('Invalid bounded library configuration.')
    }
  }
  const codec = createLibraryCursor({ cursorKey })
  return Object.freeze({
    get: async (args: { artifactId: number; userId: number }) => {
      const input = libraryInput({ fields: ['userId', 'artifactId'], value: args })
      const userId = actorId({ value: input.userId })
      const artifactId = requestId({ value: input.artifactId })
      return read({
        work: async ({ reader }) => {
          await assertLibraryActor({ reader, userId })
          const artifact = await ownedLibraryArtifact({
            allowDeleted: false,
            artifactId,
            reader,
            userId,
          })
          return (await projectLibraryArtifacts({ artifacts: [artifact], reader, userId }))[0]!
        },
      })
    },
    list: async (args: { query: unknown; userId: number }) => {
      const input = libraryInput({ fields: ['userId', 'query'], value: args })
      const userId = actorId({ value: input.userId })
      const query = normalizeLibraryQuery({ value: input.query })
      const scope = Object.freeze({ pageSize, saved: query.saved, userId })
      let after = query.cursor ? codec.decode({ ...scope, token: query.cursor }) : null
      return read({
        work: async ({ reader }) => {
          await assertLibraryActor({ reader, userId })
          const items: ArtifactDTO[] = []
          let consumed = 0
          let hasMore = false
          while (consumed < scanBudget && items.length < pageSize) {
            const limit = Math.min(batchSize, scanBudget - consumed)
            const candidates = await reader.scan({ after, limit, saved: query.saved, userId })
            if (candidates.length > limit) {
              integrity()
            }
            if (!candidates.length) {
              hasMore = false
              break
            }
            const artifactIds = query.saved
              ? candidates.map((row) => integer({ value: row.artifactId }))
              : []
            const artifacts = query.saved
              ? await reader.artifacts({ ids: artifactIds })
              : candidates
            // Validate every consumed relation; do not validate or advance past prefetched, unconsumed rows.
            const consumedCandidates: LibraryDocument[] = []
            const consumedArtifacts: LibraryDocument[] = []
            let possibleItems = 0
            for (const candidate of candidates) {
              const time = dbTime({ value: candidate[query.saved ? 'savedAt' : 'createdAt'] })
              const id = integer({ value: candidate.id })
              if (candidate.userId !== userId || isDeleted({ row: candidate })) {
                integrity()
              }
              if (after && !(time < after.time || (time === after.time && id < after.id))) {
                integrity()
              }
              const artifact = query.saved
                ? exactly({ id: integer({ value: candidate.artifactId }), rows: artifacts })
                : candidate
              if (artifact.userId !== userId) {
                integrity()
              }
              assertLibraryArtifactIdentity({ artifact })
              consumedCandidates.push(candidate)
              consumedArtifacts.push(artifact)
              after = Object.freeze({ id, time })
              consumed++
              if (!isDeleted({ row: artifact })) {
                possibleItems++
              }
              if (items.length + possibleItems === pageSize || consumed === scanBudget) {
                break
              }
            }
            if (query.saved) {
              const relations = await reader.favorites({
                tuples: consumedCandidates.map((row) => ({
                  artifactId: integer({ value: row.artifactId }),
                  userId,
                })),
              })
              for (const row of consumedCandidates) {
                assertFavoriteTuple({
                  artifactId: integer({ value: row.artifactId }),
                  expectedId: integer({ value: row.id }),
                  rows: relations,
                  userId,
                })
              }
            }
            const artifactIdentities = await checkArtifactTuples({
              artifacts: consumedArtifacts,
              reader,
            })
            const active = consumedArtifacts.filter((row) => !isDeleted({ row }))
            const projected = await projectLibraryArtifacts({
              artifactIdentities,
              artifacts: active,
              reader,
              userId,
            })
            items.push(...projected)
            hasMore = consumedCandidates.length < candidates.length || candidates.length === limit
            if (!hasMore) {
              break
            }
          }
          return Object.freeze({
            hasMore,
            items: Object.freeze(items),
            nextCursor: hasMore && after ? codec.encode({ ...scope, after }) : null,
          })
        },
      })
    },
  })
}
export async function assertLibraryActor({
  reader,
  userId,
}: {
  reader: LibraryReader
  userId: number
}) {
  const rows = await reader.actor({ userId })
  if (
    rows.length !== 1 ||
    rows[0]!.id !== userId ||
    rows[0]!.status !== 'active' ||
    rows[0]!.isDeleted !== false
  ) {
    throw new GenerationError({ code: 'UNAUTHENTICATED' })
  }
}
export function actorId({ value }: { value: unknown }) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new GenerationError({ code: 'UNAUTHENTICATED' })
  }
  return value
}
export async function ownedLibraryArtifact({
  allowDeleted,
  artifactId,
  reader,
  userId,
}: {
  allowDeleted: boolean
  artifactId: number
  reader: LibraryReader
  userId: number
}) {
  const rows = await reader.artifacts({ ids: [artifactId] })
  if (rows.length > 1) {
    integrity()
  }
  const artifact = rows[0]
  if (
    !artifact ||
    artifact.id !== artifactId ||
    artifact.userId !== userId ||
    (!allowDeleted && isDeleted({ row: artifact }))
  ) {
    throw new GenerationError({ code: 'NOT_FOUND' })
  }
  assertLibraryArtifactIdentity({ artifact })
  return artifact
}
/** Delivery eligibility only: historical snapshot, complete attempt sequence and immutable media evidence; no financial graph or live template lookup. */
export async function projectLibraryArtifacts({
  artifactIdentities: checkedArtifactIdentities,
  artifacts,
  reader,
  userId,
}: {
  artifactIdentities?: readonly LibraryDocument[]
  artifacts: readonly LibraryDocument[]
  reader: LibraryReader
  userId: number
}): Promise<ArtifactDTO[]> {
  if (!artifacts.length) {
    return []
  }
  const taskIds = uniqueIds({ values: artifacts.map((row) => row.taskId) })
  const sessionIds = uniqueIds({ values: artifacts.map((row) => row.sessionId) })
  const mediaIds = uniqueIds({ values: artifacts.map((row) => row.mediaId) })
  const tasks = await reader.tasks({ ids: taskIds })
  const sessions = await reader.sessions({ ids: sessionIds })
  const attempts = await reader.attempts({ taskIds })
  const media = await reader.media({ ids: mediaIds })
  const locators = media.map((row) => ({
    backend: text({ value: row.storageBackend }),
    bucket: text({ value: row.storageBucket }),
    key: text({ value: row.storageName }),
  }))
  const identities = await reader.mediaLocators({ locators })
  const artifactIdentities =
    checkedArtifactIdentities ?? (await checkArtifactTuples({ artifacts, reader }))
  const favorites = await reader.favorites({
    tuples: artifacts.map((row) => ({ artifactId: integer({ value: row.id }), userId })),
  })
  return artifacts.map((artifact) => {
    assertLibraryArtifactIdentity({ artifact })
    const id = integer({ value: artifact.id })
    if (artifact.userId !== userId || isDeleted({ row: artifact }) || artifact.outputIndex !== 1) {
      integrity()
    }
    const task = exactly({ id: integer({ value: artifact.taskId }), rows: tasks })
    const session = exactly({ id: integer({ value: artifact.sessionId }), rows: sessions })
    const output = exactly({ id: integer({ value: artifact.mediaId }), rows: media })
    const snapshot = validateTaskSnapshot({ task })
    isDeleted({ row: task })
    isDeleted({ row: session })
    if (
      task.userId !== userId ||
      session.userId !== userId ||
      task.sessionId !== session.id ||
      task.status !== 'succeeded' ||
      task.templateId !== session.templateId ||
      snapshot.templateId !== session.templateId ||
      snapshot.templateId !== session.templateId ||
      snapshot.mode !== session.mode
    ) {
      integrity()
    }
    const sequence = attempts
      .filter((row) => row.taskId === task.id)
      .sort((a, b) => integer({ value: a.attemptNo }) - integer({ value: b.attemptNo }))
    if (!sequence.length) {
      integrity()
    }
    for (const [index, attempt] of sequence.entries()) {
      integer({ value: attempt.id })
      if (
        isDeleted({ row: attempt }) ||
        attempt.attemptNo !== index + 1 ||
        attempt.provider !== snapshot.executionPlan.provider ||
        attempt.model !== snapshot.executionPlan.model ||
        (index === sequence.length - 1
          ? attempt.status !== 'succeeded'
          : attempt.status !== 'failed' || attempt.errorCode !== 'NOT_SENT')
      ) {
        integrity()
      }
    }
    const last = sequence.at(-1)!
    if (
      isDeleted({ row: output }) ||
      output.owner !== userId ||
      output.lifecycle !== 'active' ||
      output.visibility !== 'private' ||
      output.purpose !== 'artifact' ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(String(output.mimeType)) ||
      typeof output.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(output.sha256)
    ) {
      integrity()
    }
    integer({ value: output.filesize })
    const width = integer({ value: output.width })
    const height = integer({ value: output.height })
    if (
      output.storageBackend !== snapshot.storageOutput.backend ||
      output.storageBucket !== snapshot.storageOutput.bucket ||
      last.resultStorageBackend !== output.storageBackend ||
      last.resultStorageBucket !== output.storageBucket ||
      last.resultStorageKey !== output.storageName ||
      last.resultSha256 !== output.sha256 ||
      output.storageName !==
        generationResultKey({
          attemptId: integer({ value: last.id }),
          keyRule: snapshot.storageOutput.keyRule,
          sha256: output.sha256,
          taskId: integer({ value: task.id }),
        })
    ) {
      integrity()
    }
    const matches = identities.filter(
      (row) =>
        row.storageBackend === output.storageBackend &&
        row.storageBucket === output.storageBucket &&
        row.storageName === output.storageName,
    )
    if (matches.length !== 1 || matches[0]!.id !== output.id) {
      integrity()
    }
    const artifactMatches = artifactIdentities.filter(
      (row) => row.taskId === artifact.taskId && row.outputIndex === artifact.outputIndex,
    )
    if (artifactMatches.length !== 1 || artifactMatches[0]!.id !== id) {
      integrity()
    }
    const favorite = assertFavoriteTuple({ artifactId: id, rows: favorites, userId })
    const isFavorite = !!favorite && !isDeleted({ row: favorite })
    return Object.freeze({
      id,
      createdAt: dbTime({ value: artifact.createdAt }),
      height,
      isFavorite,
      mediaId: integer({ value: output.id }),
      mimeType: text({ value: output.mimeType }),
      outputIndex: 1,
      savedAt: isFavorite ? dbTime({ value: favorite!.savedAt }) : null,
      sessionId: integer({ value: session.id }),
      taskId: integer({ value: task.id }),
      width,
    })
  })
}
export function assertFavoriteTuple({
  artifactId,
  expectedId,
  rows,
  userId,
}: {
  artifactId: number
  expectedId?: number
  rows: readonly LibraryDocument[]
  userId: number
}) {
  const matches = rows.filter((row) => row.userId === userId && row.artifactId === artifactId)
  if (
    matches.length > 1 ||
    (expectedId !== undefined && (matches.length !== 1 || matches[0]!.id !== expectedId))
  ) {
    integrity()
  }
  const row = matches[0]
  if (row) {
    integer({ value: row.id })
    isDeleted({ row })
    dbTime({ value: row.savedAt })
  }
  return row ?? null
}
function uniqueIds({ values }: { values: readonly unknown[] }) {
  return [...new Set(values.map((value) => integer({ value })))]
}
function exactly({ id, rows }: { id: number; rows: readonly LibraryDocument[] }) {
  const matches = rows.filter((row) => row.id === id)
  if (matches.length !== 1) {
    integrity()
  }
  return matches[0]!
}
function isDeleted({ row }: { row: LibraryDocument }) {
  if (typeof row.isDeleted !== 'boolean') {
    integrity()
  }
  return row.isDeleted
}
function dbTime({ value }: { value: unknown }) {
  try {
    return libraryTime({ value })
  } catch {
    return integrity()
  }
}
function integrity(): never {
  throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
}

async function checkArtifactTuples({
  artifacts,
  reader,
}: {
  artifacts: readonly LibraryDocument[]
  reader: LibraryReader
}) {
  const identities = await reader.artifactTuples({
    tuples: artifacts.map((row) => ({
      outputIndex: integer({ value: row.outputIndex }),
      taskId: integer({ value: row.taskId }),
    })),
  })
  for (const artifact of artifacts) {
    const matches = identities.filter(
      (row) => row.taskId === artifact.taskId && row.outputIndex === artifact.outputIndex,
    )
    if (matches.length !== 1 || matches[0]!.id !== artifact.id) {
      integrity()
    }
  }
  return identities
}
