import type { LibraryDocument } from './owner-library-types.js'
import type {
  SessionDetailDTO,
  SessionsOptions,
  SessionsReader,
  SessionSummaryDTO,
} from './owner-sessions-types.js'

import { GenerationError, integer, text } from '../domain/generation.js'
import {
  assertLibraryArtifactIdentity,
  libraryInput,
  libraryTime,
  requestId,
} from '../domain/library.js'
import { createSessionsCursor, normalizeSessionsQuery } from '../domain/session-history.js'
import { normalizeSessionTitle } from '../domain/session-title.js'
import { draftResult, readDraftState } from './draft.js'
import { actorId, assertLibraryActor, projectLibraryArtifacts } from './owner-library.js'

export function createOwnerSessions({ cursorKey, pageSize = 20, read }: SessionsOptions) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new Error('Invalid bounded sessions configuration.')
  }
  const codec = createSessionsCursor({ cursorKey })
  return Object.freeze({
    get: async (args: { sessionId: number; userId: number }): Promise<SessionDetailDTO> => {
      const input = libraryInput({ fields: ['sessionId', 'userId'], value: args })
      const userId = actorId({ value: input.userId })
      const sessionId = requestId({ value: input.sessionId })
      return read({
        work: async ({ reader }) => {
          await assertLibraryActor({ reader: reader.library, userId })
          const rows = await reader.profiles({ ids: [sessionId] })
          if (rows.length > 1) {
            integrity()
          }
          const row = rows[0]
          if (!row || row.id !== sessionId || row.userId !== userId) {
            notFound()
          }
          const profile = sessionProfile({ row, userId })
          if (profile.isDeleted) {
            notFound()
          }
          const creationClientRequestId = row.clientRequestId
          if (
            typeof creationClientRequestId !== 'string' ||
            !creationClientRequestId.trim() ||
            creationClientRequestId.length > 128
          ) {
            integrity()
          }
          const requests = await reader.requestProfiles({
            clientRequestId: creationClientRequestId,
            userId,
          })
          if (requests.length !== 1 || requests[0]!.clientRequestId !== creationClientRequestId) {
            integrity()
          }
          const requestProfile = sessionProfile({ row: requests[0]!, userId })
          for (const field of ['id', 'userId', 'templateId', 'mode', 'isDeleted'] as const) {
            if (requestProfile[field] !== profile[field]) {
              integrity()
            }
          }
          const summary = (await summaries({ profiles: [profile], reader, userId }))[0]!
          const state = await readDraftState({ repository: reader.draft, sessionId, userId })
          for (const field of ['id', 'userId', 'templateId', 'mode', 'isDeleted'] as const) {
            if (state.session[field] !== profile[field]) {
              integrity()
            }
          }
          return Object.freeze({ ...summary, creationClientRequestId, draft: draftResult(state) })
        },
      })
    },
    list: async (args: { query: unknown; userId: number }) => {
      const input = libraryInput({ fields: ['query', 'userId'], value: args })
      const userId = actorId({ value: input.userId })
      const query = normalizeSessionsQuery({ value: input.query })
      const scope = { pageSize, userId }
      const after = query.cursor ? codec.decode({ ...scope, token: query.cursor }) : null
      return read({
        work: async ({ reader }) => {
          await assertLibraryActor({ reader: reader.library, userId })
          const rows = await reader.scan({ after, limit: pageSize + 1, userId })
          if (rows.length > pageSize + 1) {
            integrity()
          }
          const profiles = []
          let previous = after
          const ids = new Set<number>()
          for (const row of rows.slice(0, pageSize)) {
            const profile = sessionProfile({ row, userId })
            if (
              profile.isDeleted ||
              ids.has(profile.id) ||
              (previous &&
                !(
                  profile.lastActivityAt < previous.time ||
                  (profile.lastActivityAt === previous.time && profile.id < previous.id)
                ))
            ) {
              integrity()
            }
            profiles.push(profile)
            ids.add(profile.id)
            previous = { id: profile.id, time: profile.lastActivityAt }
          }
          const items = await summaries({ profiles, reader, userId })
          const hasMore = rows.length > pageSize
          return Object.freeze({
            hasMore,
            items: Object.freeze(items),
            nextCursor: hasMore && previous ? codec.encode({ ...scope, after: previous }) : null,
          })
        },
      })
    },
  })
}
function sessionProfile({ row, userId }: { row: LibraryDocument; userId: number }) {
  const id = integer({ value: row.id })
  const templateId = integer({ value: row.templateId })
  const nextRoundNo = integer({ value: row.nextRoundNo })
  const title = text({ value: row.title })
  try {
    // Check the shared write constraint without replacing the persisted title with its trimmed result.
    normalizeSessionTitle({ value: title })
  } catch {
    integrity()
  }
  const lastActivityAt = dbTime({ value: row.lastActivityAt })
  if (
    row.userId !== userId ||
    (row.mode !== 'effect' && row.mode !== 'free') ||
    (row.titleSource !== 'ai' && row.titleSource !== 'template' && row.titleSource !== 'user')
  ) {
    integrity()
  }
  assertDeletion({ row })
  const coverArtifactId =
    row.coverArtifactId == null ? null : integer({ value: row.coverArtifactId })
  return Object.freeze({
    id,
    coverArtifactId,
    isDeleted: row.isDeleted,
    lastActivityAt,
    mode: row.mode as SessionSummaryDTO['mode'],
    nextRoundNo,
    templateId,
    title,
    titleSource: row.titleSource as SessionSummaryDTO['titleSource'],
    userId,
  })
}
type Profile = ReturnType<typeof sessionProfile>
async function summaries({
  profiles,
  reader,
  userId,
}: {
  profiles: readonly Profile[]
  reader: SessionsReader
  userId: number
}): Promise<SessionSummaryDTO[]> {
  if (!profiles.length) {
    return []
  }
  const tasks = await reader.inflight({ sessionIds: profiles.map((profile) => profile.id) })
  const taskIds = new Set<number>()
  for (const task of tasks) {
    const profile = profiles.find((profile) => profile.id === task.sessionId)
    const id = integer({ value: task.id })
    const roundNo = integer({ value: task.roundNo })
    if (
      !profile ||
      taskIds.has(id) ||
      task.userId !== userId ||
      task.templateId !== profile.templateId ||
      task.isDeleted !== false ||
      roundNo >= profile.nextRoundNo ||
      !['queued', 'running', 'unknown'].includes(String(task.status))
    ) {
      integrity()
    }
    taskIds.add(id)
  }
  const coverIds = profiles.flatMap((profile) =>
    profile.coverArtifactId === null ? [] : [profile.coverArtifactId],
  )
  if (new Set(coverIds).size !== coverIds.length) {
    integrity()
  }
  const artifacts = coverIds.length ? await reader.library.artifacts({ ids: coverIds }) : []
  if (artifacts.length !== coverIds.length) {
    integrity()
  }
  for (const artifact of artifacts) {
    assertLibraryArtifactIdentity({ artifact })
    const profile = profiles.find((profile) => profile.coverArtifactId === artifact.id)
    if (!profile || artifact.userId !== userId || artifact.sessionId !== profile.id) {
      integrity()
    }
  }
  const artifactIdentities = artifacts.length
    ? await reader.library.artifactTuples({
        tuples: artifacts.map((artifact) => ({
          outputIndex: 1,
          taskId: integer({ value: artifact.taskId }),
        })),
      })
    : []
  for (const artifact of artifacts) {
    const matches = artifactIdentities.filter(
      (row) => row.taskId === artifact.taskId && row.outputIndex === artifact.outputIndex,
    )
    if (matches.length !== 1 || matches[0]!.id !== artifact.id) {
      integrity()
    }
  }
  const covers = await projectLibraryArtifacts({
    artifactIdentities,
    artifacts: artifacts.filter((artifact) => artifact.isDeleted === false),
    reader: reader.library,
    userId,
  })
  return profiles.map((profile) => {
    const inflight = tasks.filter((task) => task.sessionId === profile.id)
    if (inflight.length > 1) {
      integrity()
    }
    const task = inflight[0]
    const runningTask = task
      ? Object.freeze({
          id: integer({ value: task.id }),
          roundNo: integer({ value: task.roundNo }),
          status: task.status as 'queued' | 'running' | 'unknown',
        })
      : null
    return Object.freeze({
      id: profile.id,
      cover: covers.find((cover) => cover.id === profile.coverArtifactId) ?? null,
      lastActivityAt: profile.lastActivityAt,
      mode: profile.mode,
      runningTask,
      templateId: profile.templateId,
      title: profile.title,
      titleSource: profile.titleSource,
    })
  })
}
function assertDeletion({ row }: { row: LibraryDocument }) {
  if (row.isDeleted === false) {
    if (row.deletedAt != null || row.deletedBy != null) {
      integrity()
    }
  } else if (row.isDeleted === true) {
    dbTime({ value: row.deletedAt })
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
function notFound(): never {
  throw new GenerationError({ code: 'NOT_FOUND' })
}
