import type { StoredImage } from '../domain/media.js'
import type { CreditRepository } from './credits.js'
import type {
  AcceptedGenerationReader,
  DeliveryEvidenceReader,
  GenerationReader,
} from './generation-reader-types.js'
import type { GenerationDocument } from './generation-types.js'
import type { MediaRecord, MediaRegistration } from './media.js'

import { GenerationError, integer, text } from '../domain/generation.js'
import { assertGenerationAttempts } from '../domain/generation-attempts.js'
import {
  assertRelatedGrant,
  assertTaskEvidence,
  deleted,
  singleCandidate,
  validateTaskSnapshot,
} from './generation-evidence.js'

export type AttemptLifecycleWriter = Readonly<{
  expirePreparedAttempt: (args: Readonly<{ attemptId: number; now: string }>) => Promise<void>
  insertPreparedAttempt: (
    args: Readonly<{
      attemptNo: number
      leaseUntil: string
      model: string
      now: string
      provider: string
      taskId: number
    }>,
  ) => Promise<Readonly<{ id: unknown }>>
  recordAttemptOutput: (
    args: Readonly<{
      attemptId: number
      facts: StoredImage
      isClosed: boolean
      now: string
      previousAttemptStatus: unknown
      providerRequestId: unknown
    }>,
  ) => Promise<void>
  recordAttemptProviderUnknown: (
    args: Readonly<{
      attemptId: number
      now: string
      previousAttemptStatus: unknown
      providerRequestId: unknown
    }>,
  ) => Promise<void>
  recordAttemptSending: (args: Readonly<{ attemptId: number; now: string }>) => Promise<void>
  recordTaskProviderUnknown: (
    args: Readonly<{ now: string; previousTaskStatus: unknown; taskId: number }>,
  ) => Promise<void>
  recordTaskRunning: (
    args: Readonly<{
      now: string
      previousTaskStatus: unknown
      startedAt: unknown
      taskId: number
    }>,
  ) => Promise<void>
}>
export type GenerationSettlementWriter = Readonly<{
  appendUnknownCloseAudit: (
    args: Readonly<{
      actor: string
      attemptId: unknown
      now: string
      operationId: string
      reason: string
      taskId: number
    }>,
  ) => Promise<void>
  closeUnknownTask: (
    args: Readonly<{ actor: string; now: string; taskId: number }>,
  ) => Promise<void>
  insertDeliveredArtifact: (
    args: Readonly<{
      mediaId: number
      now: string
      sessionId: unknown
      taskId: number
      userId: unknown
    }>,
  ) => Promise<Readonly<{ id: unknown }>>
  recordAttemptFailed: (
    args: Readonly<{
      attemptId: number
      now: string
      previousAttemptStatus: unknown
      providerRequestId: unknown
      reason: 'NOT_SENT' | 'PROVIDER_REJECTED'
    }>,
  ) => Promise<void>
  recordAttemptSucceeded: (args: Readonly<{ attemptId: number; now: string }>) => Promise<void>
  recordSessionDelivery: (
    args: Readonly<{
      artifactId: unknown
      expectedAutoNameStatus: unknown
      expectedTitleSource: unknown
      namingStatus: unknown
      now: string
      sessionId: number
    }>,
  ) => Promise<void>
  recordTaskFailed: (
    args: Readonly<{ now: string; reason: 'NOT_SENT' | 'PROVIDER_REJECTED'; taskId: number }>,
  ) => Promise<void>
  recordTaskSucceeded: (
    args: Readonly<{ now: string; previousTaskStatus: unknown; taskId: number }>,
  ) => Promise<void>
  settleGenerationAllocation: (
    args: Readonly<{
      allocationId: number
      isExpired: boolean
      now: string
      operation: 'capture' | 'release'
    }>,
  ) => Promise<void>
  settleGenerationReservation: (
    args: Readonly<{
      now: string
      operation: 'capture' | 'release'
      previousReservationStatus: unknown
      reservationId: number
    }>,
  ) => Promise<void>
}>
export type WorkerRepository = AcceptedGenerationReader &
  AttemptLifecycleWriter &
  DeliveryEvidenceReader &
  GenerationSettlementWriter &
  Pick<GenerationReader, 'findCloseOperationConflicts' | 'findTaskReservationCandidates'> &
  Readonly<{
    credits: CreditRepository
    queueName: (args: { sessionId: number }) => Promise<void>
    registerMedia: (args: MediaRegistration) => Promise<MediaRecord>
  }>
export type WorkerPersistence = Readonly<{
  isCommitUnknown: (args: { error: unknown }) => boolean
  read: <T>(args: {
    work: (args: { reader: AcceptedGenerationReader & DeliveryEvidenceReader }) => Promise<T>
  }) => Promise<T>
  write: <T>(args: {
    resources: readonly string[]
    work: (args: { repository: WorkerRepository }) => Promise<T>
  }) => Promise<T>
}>
export type AcceptedGeneration = Awaited<ReturnType<typeof readAcceptedGeneration>>
export const workerActor = 'system:generation'
export function conflict(): never {
  throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
}
export function workerResources({ task }: { task: GenerationDocument }) {
  return [
    `session:${integer({ value: task.userId })}:${integer({ value: task.sessionId })}`,
    `task:${integer({ value: task.id })}`,
    `wallet:${integer({ value: task.userId })}`,
  ]
}

/** One consistent accepted graph. No live-user authorization or current template configuration. */
export async function readAcceptedGeneration({
  reader,
  taskId,
}: {
  reader: AcceptedGenerationReader
  taskId: number
}) {
  integer({ value: taskId })
  const task = singleCandidate({ candidates: await reader.findTaskCandidates({ taskId }) })
  if (!task || deleted({ doc: task })) {
    conflict()
  }
  const snapshot = validateTaskSnapshot({ task })
  await assertTaskEvidence({ reader, snapshot, task })
  const accounts = await reader.findOwnerAccountCandidates({
    userId: integer({ value: task.userId }),
  })
  const account = accounts[0]
  if (accounts.length !== 1 || !account || deleted({ doc: account })) {
    conflict()
  }
  const grants = await reader.readRelatedGrants({
    accountId: integer({ value: account.id }),
    userId: integer({ value: task.userId }),
  })
  let reserved = 0
  let available = 0
  for (const grant of grants) {
    assertRelatedGrant({ doc: grant })
    if (grant.accountId !== account.id || grant.userId !== task.userId) {
      conflict()
    }
    available += integer({ minimum: 0, value: grant.availableCredits })
    if (!Number.isSafeInteger(available)) {
      conflict()
    }
    reserved += integer({ minimum: 0, value: grant.reservedCredits })
    if (!Number.isSafeInteger(reserved)) {
      conflict()
    }
  }
  for (let offset = 0; offset < grants.length; offset += 128) {
    const batch = grants.slice(offset, offset + 128)
    const expected = new Map(
      batch.map((grant) => [text({ value: grant.grantKey }), integer({ value: grant.id })]),
    )
    if (expected.size !== batch.length) {
      conflict()
    }
    // At 2n rows any truncated result already contains a duplicate or a foreign identity.
    const identities = await reader.findGrantKeysCandidates({ grantKeys: [...expected.keys()] })
    const seen = new Set<string>()
    for (const identity of identities) {
      const key = text({ value: identity.grantKey })
      if (deleted({ doc: identity }) || expected.get(key) !== identity.id || seen.has(key)) {
        conflict()
      }
      seen.add(key)
    }
    if (seen.size !== batch.length) {
      conflict()
    }
  }
  if (
    reserved !== account.reservedCredits ||
    integer({ minimum: 0, value: account.availableCredits }) > available
  ) {
    conflict()
  }
  const attempts = await reader.readTaskAttempts({ taskId })
  assertGenerationAttempts({ attempts, snapshot, taskId })
  const attempt = attempts.at(-1) ?? null
  if (
    (task.status === 'queued' && attempt) ||
    (task.status === 'running' && !attempt) ||
    (task.status === 'unknown' &&
      attempt?.status !== 'unknown' &&
      attempt?.status !== 'output_ready') ||
    (task.status === 'succeeded' && attempt?.status !== 'succeeded') ||
    (task.status === 'closed' && attempt?.status !== 'unknown')
  ) {
    conflict()
  }
  return { attempt, attempts, snapshot, task }
}
