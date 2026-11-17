import type { NamingReader, SessionContextReader } from './generation-reader-types.js'
import type { NamingSession } from './session-naming-types.js'

import { GenerationError, generationTime, integer, text } from '../domain/generation.js'
import { deleted, singleCandidate } from './generation-evidence.js'
import { assertDelivered } from './generation-settlement-evidence.js'
import { conflict, readAcceptedGeneration } from './generation-worker-types.js'

export async function readNamingSession({
  reader,
  sessionId,
}: {
  reader: SessionContextReader
  sessionId: number
}): Promise<NamingSession> {
  const doc = singleCandidate({
    candidates: await reader.findSessionCandidates({ sessionId: integer({ value: sessionId }) }),
  })
  if (!doc || deleted({ doc })) {
    throw new GenerationError({ code: 'NOT_FOUND' })
  }
  if (
    !['ai', 'template', 'user'].includes(String(doc.titleSource)) ||
    !['failed', 'idle', 'pending', 'sending', 'skipped', 'succeeded', 'unknown'].includes(
      String(doc.autoNameStatus),
    )
  ) {
    conflict()
  }
  const startedAt =
    doc.autoNameStartedAt == null
      ? null
      : generationTime({ now: text({ value: doc.autoNameStartedAt }) })
  const namedAt =
    doc.autoNamedAt == null ? null : generationTime({ now: text({ value: doc.autoNamedAt }) })
  if (
    (doc.autoNameStatus === 'sending' && !startedAt) ||
    (doc.autoNameStatus === 'succeeded' && (!startedAt || !namedAt))
  ) {
    conflict()
  }
  return {
    id: integer({ value: doc.id }),
    namedAt,
    startedAt,
    status: doc.autoNameStatus as NamingSession['status'],
    title: text({ value: doc.title }),
    titleSource: doc.titleSource as NamingSession['titleSource'],
    userId: integer({ value: doc.userId }),
  }
}

/** Select by session first, including deleted rows; a broken first output never advances to the next. */
export async function readFirstNamingContext({
  reader,
  session,
}: {
  reader: NamingReader
  session: NamingSession
}) {
  const artifacts = await reader.readFirstSessionArtifact({ sessionId: session.id })
  const artifact = artifacts[0]
  if (!artifact || deleted({ doc: artifact })) {
    throw new GenerationError({ code: 'NOT_FOUND' })
  }
  if (
    artifact.userId !== session.userId ||
    artifact.sessionId !== session.id ||
    artifact.outputIndex !== 1
  ) {
    conflict()
  }
  const state = await readAcceptedGeneration({
    reader,
    taskId: integer({ value: artifact.taskId }),
  })
  if (state.task.userId !== session.userId || state.task.sessionId !== session.id) {
    conflict()
  }
  await assertDelivered({ reader, state })
  const media = singleCandidate({
    candidates: await reader.findMediaCandidates({ mediaId: integer({ value: artifact.mediaId }) }),
  })
  if (!media) {
    conflict()
  }
  const source = {
    expected: {
      bytes: new Uint8Array(),
      filesize: integer({ value: media.filesize }),
      height: integer({ value: media.height }),
      mimeType: text({ value: media.mimeType }),
      sha256: text({ value: media.sha256 }),
      width: integer({ value: media.width }),
    },
    ref: {
      backend: text({ value: media.storageBackend }),
      bucket: text({ value: media.storageBucket }),
      key: text({ value: media.storageName }),
    },
  }
  const input = {
    description: state.snapshot.input.description,
    intent: state.snapshot.executionPlan.systemPrompt,
    userNotes: state.snapshot.input.userNotes,
  }
  return {
    fingerprint: JSON.stringify({
      artifact,
      input,
      snapshot: state.task.executionSnapshotJson,
      source,
    }),
    input,
    source,
  }
}
