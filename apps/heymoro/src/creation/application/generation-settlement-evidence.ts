import type { StoredImage } from '../domain/media.js'
import type { DeliveryEvidenceReader } from './generation-reader-types.js'
import type { AcceptedGeneration } from './generation-worker-types.js'

import { generationResultKey, integer, text } from '../domain/generation.js'
import { deleted, singleCandidate } from './generation-evidence.js'
import { conflict } from './generation-worker-types.js'

export function assertOutput({ facts, state }: { facts: StoredImage; state: AcceptedGeneration }) {
  const { attempt, snapshot, task } = state
  if (
    !attempt ||
    facts.ref.backend !== snapshot.storageOutput.backend ||
    facts.ref.bucket !== snapshot.storageOutput.bucket ||
    facts.ref.key !==
      generationResultKey({
        attemptId: integer({ value: attempt.id }),
        keyRule: snapshot.storageOutput.keyRule,
        sha256: facts.sha256,
        taskId: integer({ value: task.id }),
      }) ||
    attempt.resultStorageBackend !== facts.ref.backend ||
    attempt.resultStorageBucket !== facts.ref.bucket ||
    attempt.resultStorageKey !== facts.ref.key ||
    attempt.resultSha256 !== facts.sha256
  ) {
    conflict()
  }
}
export async function assertDelivered({
  reader,
  state,
}: {
  reader: Pick<
    DeliveryEvidenceReader,
    'findMediaCandidates' | 'findMediaLocationCandidates' | 'readTaskArtifacts'
  >
  state: AcceptedGeneration
}) {
  if (state.task.status !== 'succeeded' || state.attempt?.status !== 'succeeded') {
    conflict()
  }
  const artifacts = await reader.readTaskArtifacts({ taskId: integer({ value: state.task.id }) })
  const artifact = artifacts[0]
  if (
    artifacts.length !== 1 ||
    !artifact ||
    deleted({ doc: artifact }) ||
    artifact.userId !== state.task.userId ||
    artifact.sessionId !== state.task.sessionId ||
    artifact.outputIndex !== 1
  ) {
    conflict()
  }
  const media = singleCandidate({
    candidates: await reader.findMediaCandidates({ mediaId: integer({ value: artifact.mediaId }) }),
  })
  if (
    !media ||
    deleted({ doc: media }) ||
    media.owner !== state.task.userId ||
    media.lifecycle !== 'active' ||
    media.visibility !== 'private' ||
    media.purpose !== 'artifact' ||
    media.storageBackend !== state.attempt.resultStorageBackend ||
    media.storageBucket !== state.attempt.resultStorageBucket ||
    media.storageName !== state.attempt.resultStorageKey ||
    media.sha256 !== state.attempt.resultSha256
  ) {
    conflict()
  }
  integer({ value: media.filesize })
  integer({ value: media.width })
  integer({ value: media.height })
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(String(media.mimeType))) {
    conflict()
  }
  const identities = await reader.findMediaLocationCandidates({
    ref: {
      backend: text({ value: media.storageBackend }),
      bucket: text({ value: media.storageBucket }),
      key: text({ value: media.storageName }),
    },
  })
  if (identities.length !== 1 || identities[0]!.id !== media.id) {
    conflict()
  }
  if (
    media.storageBackend !== state.snapshot.storageOutput.backend ||
    media.storageBucket !== state.snapshot.storageOutput.bucket ||
    media.storageName !==
      generationResultKey({
        attemptId: integer({ value: state.attempt.id }),
        keyRule: state.snapshot.storageOutput.keyRule,
        sha256: String(media.sha256),
        taskId: integer({ value: state.task.id }),
      })
  ) {
    conflict()
  }
}
export async function assertFailed({
  reader,
  state,
}: {
  reader: Pick<DeliveryEvidenceReader, 'findTaskArtifactCandidates'>
  state: AcceptedGeneration
}) {
  if (
    state.task.status !== 'failed' ||
    state.attempt?.status !== 'failed' ||
    state.task.errorCode !== state.attempt.errorCode ||
    !['NOT_SENT', 'PROVIDER_REJECTED'].includes(String(state.attempt.errorCode))
  ) {
    conflict()
  }
  if (
    (await reader.findTaskArtifactCandidates({ taskId: integer({ value: state.task.id }) })).length
  ) {
    conflict()
  }
}
export async function assertClosed({
  reader,
  state,
}: {
  reader: Pick<
    DeliveryEvidenceReader,
    'findTaskArtifactCandidates' | 'findTaskCloseAuditCandidates'
  >
  state: AcceptedGeneration
}) {
  if (state.task.status !== 'closed' || state.attempt?.status !== 'unknown') {
    conflict()
  }
  const logs = await reader.findTaskCloseAuditCandidates({
    taskId: integer({ value: state.task.id }),
  })
  if (
    logs.length !== 1 ||
    deleted({ doc: logs[0]! }) ||
    !logs[0]!.correlationId ||
    !logs[0]!.requestId ||
    (await reader.findTaskArtifactCandidates({ taskId: integer({ value: state.task.id }) })).length
  ) {
    conflict()
  }
}
