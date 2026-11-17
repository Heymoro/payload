import type { LibraryDocument } from './owner-library-types.js'
import type { TaskHistoryDTO, TaskHistoryReader } from './owner-task-history-types.js'

import { GenerationError, integer } from '../domain/generation.js'
import { assertGenerationAttempts } from '../domain/generation-attempts.js'
import { assertLibraryArtifactIdentity } from '../domain/library.js'
import { assertHistoryDeletion, historyExactly, historyTime } from '../domain/task-history.js'
import { assertTaskInputRows, taskDTO, validateTaskSnapshot } from './generation-evidence.js'
import { projectLibraryArtifacts } from './owner-library.js'
import { projectTaskClosedResolution } from './task-closed-resolution.js'

/** Complete page graph in one caller-owned snapshot. All ports are awaited serially. */
export async function projectTaskHistory({
  reader,
  sessions: suppliedSessions,
  tasks,
  userId,
}: {
  reader: TaskHistoryReader
  sessions?: readonly LibraryDocument[]
  tasks: readonly LibraryDocument[]
  userId: number
}): Promise<TaskHistoryDTO[]> {
  if (!tasks.length) {
    return []
  }
  const taskIds = unique({ values: tasks.map((task) => task.id) })
  if (taskIds.length !== tasks.length) {
    integrity()
  }
  const sessions =
    suppliedSessions ??
    (await reader.sessions({ ids: unique({ values: tasks.map((task) => task.sessionId) }) }))
  const rounds = await reader.rounds({
    tuples: tasks.map((task) => ({
      roundNo: integer({ value: task.roundNo }),
      sessionId: integer({ value: task.sessionId }),
    })),
  })
  const requests = await reader.requests({
    tuples: tasks.map((task) => ({
      clientRequestId: requestKey({ value: task.clientRequestId }),
      userId,
    })),
  })
  const inputs = await reader.inputs({ taskIds })
  const attempts = await reader.attempts({ taskIds })
  const artifacts = await reader.artifacts({ taskIds })
  for (const rows of [inputs, attempts, artifacts]) {
    const ids = unique({ values: rows.map((row) => row.id) })
    if (
      ids.length !== rows.length ||
      rows.some((row) => !taskIds.includes(integer({ value: row.taskId })))
    ) {
      integrity()
    }
  }
  const snapshots = tasks.map((task) => {
    assertHistoryDeletion({ row: task })
    const snapshot = validateTaskSnapshot({ task })
    const session = historyExactly({ id: integer({ value: task.sessionId }), rows: sessions })
    assertHistoryDeletion({ row: session })
    if (
      task.userId !== userId ||
      session.userId !== userId ||
      task.templateId !== session.templateId ||
      snapshot.templateId !== session.templateId ||
      snapshot.mode !== session.mode ||
      integer({ value: task.roundNo }) >= integer({ value: session.nextRoundNo })
    ) {
      integrity()
    }
    for (const matches of [
      rounds.filter((row) => row.sessionId === task.sessionId && row.roundNo === task.roundNo),
      requests.filter(
        (row) => row.userId === userId && row.clientRequestId === task.clientRequestId,
      ),
    ]) {
      if (matches.length !== 1 || matches[0]!.id !== task.id) {
        integrity()
      }
    }
    const slots = inputs
      .filter((row) => row.taskId === task.id)
      .sort((a, b) => integer({ value: a.position }) - integer({ value: b.position }))
    for (const row of slots) {
      assertHistoryDeletion({ row })
    }
    assertTaskInputRows({ inputs: slots, snapshot, task })
    const sequence = attempts
      .filter((row) => row.taskId === task.id)
      .sort((a, b) => integer({ value: a.attemptNo }) - integer({ value: b.attemptNo }))
    for (const row of sequence) {
      assertHistoryDeletion({ row })
    }
    assertGenerationAttempts({ attempts: sequence, snapshot, taskId: integer({ value: task.id }) })
    assertState({ sequence, task })
    return snapshot
  })
  const references = await reader.references({
    ids: unique({
      values: snapshots.flatMap((snapshot) => snapshot.media.map((row) => row.mediaId)),
    }),
  })
  const referenceIds = new Set<number>()
  for (const row of references) {
    const id = integer({ value: row.id })
    if (
      referenceIds.has(id) ||
      row.owner !== userId ||
      !snapshots.some((snapshot) => snapshot.media.some((media) => media.mediaId === id))
    ) {
      integrity()
    }
    referenceIds.add(id)
    assertHistoryDeletion({ row })
  }
  const active = references.filter((row) => row.isDeleted === false && row.lifecycle === 'active')
  const identities = active.length
    ? await reader.library.mediaLocators({
        locators: active.map((row) => ({
          backend: String(row.storageBackend),
          bucket: String(row.storageBucket),
          key: String(row.storageName),
        })),
      })
    : []
  for (const row of active) {
    const matches = identities.filter(
      (identity) =>
        identity.storageBackend === row.storageBackend &&
        identity.storageBucket === row.storageBucket &&
        identity.storageName === row.storageName,
    )
    if (matches.length !== 1 || matches[0]!.id !== row.id) {
      integrity()
    }
  }
  for (const artifact of artifacts) {
    assertLibraryArtifactIdentity({ artifact })
    const task = historyExactly({ id: integer({ value: artifact.taskId }), rows: tasks })
    if (
      task.status !== 'succeeded' ||
      artifact.sessionId !== task.sessionId ||
      artifact.userId !== userId
    ) {
      integrity()
    }
  }
  for (const task of tasks) {
    if (
      artifacts.filter((row) => row.taskId === task.id).length !==
      (task.status === 'succeeded' ? 1 : 0)
    ) {
      integrity()
    }
  }
  const artifactIdentities = artifacts.length
    ? await reader.library.artifactTuples({
        tuples: artifacts.map((row) => ({
          outputIndex: 1,
          taskId: integer({ value: row.taskId }),
        })),
      })
    : []
  for (const artifact of artifacts) {
    const matches = artifactIdentities.filter(
      (row) => row.taskId === artifact.taskId && row.outputIndex === 1,
    )
    if (matches.length !== 1 || matches[0]!.id !== artifact.id) {
      integrity()
    }
  }
  const delivered = await projectLibraryArtifacts({
    artifactIdentities,
    artifacts: artifacts.filter((row) => row.isDeleted === false),
    reader: reader.library,
    userId,
  })
  const closed = tasks.filter((task) => task.status === 'closed')
  const closedIds = closed.map((task) => integer({ value: task.id }))
  const reservations = closed.length ? await reader.reservations({ taskIds: closedIds }) : []
  const reservationIds = unique({ values: reservations.map((row) => row.id) })
  const allocations = closed.length ? await reader.allocations({ reservationIds }) : []
  const grants = closed.length
    ? await reader.grants({ ids: unique({ values: allocations.map((row) => row.grantId) }) })
    : []
  const grantIdentities = closed.length
    ? await reader.grantKeys({ keys: [...new Set(grants.map((row) => String(row.grantKey)))] })
    : []
  const accounts = closed.length
    ? await reader.accounts({
        ids: unique({ values: reservations.map((row) => row.accountId) }),
        userId,
      })
    : []
  const ledger = closed.length ? await reader.ledger({ reservationIds, taskIds: closedIds }) : []
  const audits = closed.length ? await reader.closureAudits({ taskIds: closedIds }) : []
  return tasks.map((task, index) => {
    const snapshot = snapshots[index]!
    const inputAvailability = snapshot.media.map((media) => {
      const row = references.find((reference) => reference.id === media.mediaId)
      const isActive = !!row && row.isDeleted === false && row.lifecycle === 'active'
      if (
        isActive &&
        (row.purpose !== 'reference' ||
          row.visibility !== 'private' ||
          row.sha256 !== media.sha256 ||
          row.mimeType !== media.mimeType ||
          row.filesize !== media.sizeBytes ||
          row.storageBackend !== media.storageRef.backend ||
          row.storageBucket !== media.storageRef.bucket ||
          row.storageName !== media.storageRef.key)
      ) {
        integrity()
      }
      return Object.freeze({
        mediaId: media.mediaId,
        position: media.position,
        status: isActive ? ('active' as const) : ('unavailable' as const),
      })
    })
    const sequence = attempts
      .filter((row) => row.taskId === task.id)
      .sort((a, b) => Number(a.attemptNo) - Number(b.attemptNo))
    return Object.freeze({
      ...taskDTO({ snapshot, task }),
      artifactIds: Object.freeze(
        delivered.filter((row) => row.taskId === task.id).map((row) => row.id),
      ),
      createdAt: historyTime({ value: task.createdAt }),
      finishedAt: task.finishedAt == null ? null : historyTime({ value: task.finishedAt }),
      inputAvailability: Object.freeze(inputAvailability),
      resolution:
        task.status === 'closed'
          ? projectTaskClosedResolution({
              accounts,
              allocations,
              attempt: sequence.at(-1)!,
              audits,
              grantIdentities,
              grants,
              ledger,
              reservations,
              task,
            })
          : null,
      startedAt: task.startedAt == null ? null : historyTime({ value: task.startedAt }),
    })
  })
}
function assertState({
  sequence,
  task,
}: {
  sequence: readonly LibraryDocument[]
  task: LibraryDocument
}) {
  const created = historyTime({ value: task.createdAt })
  const started = task.startedAt == null ? null : historyTime({ value: task.startedAt })
  const finished = task.finishedAt == null ? null : historyTime({ value: task.finishedAt })
  if ((started && started < created) || (finished && finished < (started ?? created))) {
    integrity()
  }
  const last = sequence.at(-1)
  switch (task.status) {
    case 'cancelled':
      if (
        !finished ||
        (task.errorCode != null && task.errorCode !== 'NOT_SENT') ||
        sequence.some((row) => row.status !== 'failed' || row.errorCode !== 'NOT_SENT')
      ) {
        integrity()
      }
      break
    case 'closed':
      if (
        !started ||
        !finished ||
        last?.status !== 'unknown' ||
        last.errorCode !== 'PROVIDER_UNKNOWN' ||
        task.errorCode !== 'UNKNOWN_CLOSED'
      ) {
        integrity()
      }
      break
    case 'failed':
      if (
        !started ||
        !finished ||
        last?.status !== 'failed' ||
        !['NOT_SENT', 'PROVIDER_REJECTED'].includes(String(task.errorCode)) ||
        task.errorCode !== last.errorCode
      ) {
        integrity()
      }
      break
    case 'queued':
      if (started || finished || last || task.errorCode != null) {
        integrity()
      }
      break
    case 'running':
      if (
        !started ||
        finished ||
        !last ||
        !['output_ready', 'prepared', 'sending'].includes(String(last.status)) ||
        last.errorCode != null ||
        task.errorCode != null
      ) {
        integrity()
      }
      break
    case 'succeeded':
      if (
        !started ||
        !finished ||
        last?.status !== 'succeeded' ||
        task.errorCode != null ||
        last.errorCode != null
      ) {
        integrity()
      }
      break
    case 'unknown':
      if (
        !started ||
        finished ||
        !last ||
        !['output_ready', 'unknown'].includes(String(last.status)) ||
        last.errorCode !== 'PROVIDER_UNKNOWN' ||
        task.errorCode !== 'PROVIDER_UNKNOWN'
      ) {
        integrity()
      }
      break
    default:
      integrity()
  }
}
function requestKey({ value }: { value: unknown }) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    integrity()
  }
  return value
}
function unique({ values }: { values: readonly unknown[] }) {
  return [...new Set(values.map((value) => integer({ value })))]
}
function integrity(): never {
  throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
}
