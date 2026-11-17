import type { ReconciliationResult } from '../domain/generation-reconciliation.js'
import type { ImageLimits } from '../domain/image.js'
import type { ObjectStorage } from '../domain/media.js'
import type {
  AcceptedGenerationReader,
  DeliveryEvidenceReader,
  GenerationReader,
} from './generation-reader-types.js'
import type { GenerationWorkerOptions } from './generation-worker.js'
import type { AcceptedGeneration, WorkerPersistence } from './generation-worker-types.js'

import { isAdminRequestId } from '../domain/admin.js'
import { GenerationError, integer } from '../domain/generation.js'
import {
  GenerationReconciliationError,
  isReconciliationOperationId,
  parseGenerationReconciliationCommand,
} from '../domain/generation-reconciliation.js'
import { deleted } from './generation-evidence.js'
import { assertClosed, assertDelivered } from './generation-settlement-evidence.js'
import { createGenerationWorker } from './generation-worker.js'
import { conflict, readAcceptedGeneration } from './generation-worker-types.js'

export type ReconciliationReader = AcceptedGenerationReader &
  DeliveryEvidenceReader &
  Pick<GenerationReader, 'findCloseOperationConflicts'>
export type ReconciliationPersistence = Omit<WorkerPersistence, 'read'> &
  Readonly<{
    isTransactionUncertain: (args: { error: unknown }) => boolean
    read: <T>(args: { work: (args: { reader: ReconciliationReader }) => Promise<T> }) => Promise<T>
  }>

/** A request-local policy around the existing recovery/settlement kernel, not another financial writer. */
export function createGenerationReconciliation({
  actor,
  clock,
  imageLimits,
  persistence,
  storage,
  workerOptions,
}: {
  actor: string
  clock: () => string
  imageLimits: ImageLimits
  persistence: ReconciliationPersistence
  storage: ObjectStorage
  workerOptions: Omit<GenerationWorkerOptions, 'persistence' | 'trustedClose'>
}) {
  if (!/^admin:[1-9]\d*$/.test(actor) || !Number.isSafeInteger(Number(actor.slice(6)))) {
    throw new GenerationReconciliationError({ code: 'RECONCILIATION_UNAUTHORIZED' })
  }
  return Object.freeze({
    execute: async ({
      input,
      requestId,
    }: {
      input: unknown
      requestId: string
    }): Promise<ReconciliationResult> => {
      const command = parseGenerationReconciliationCommand({ input })
      if (!isAdminRequestId({ value: requestId })) {
        throw new GenerationReconciliationError({ code: 'RECONCILIATION_INVALID_INPUT' })
      }
      let hasUncertainWrite = false
      let hasConfirmedWrite = false
      let hasAttemptedWrite = false
      let isClosing = false
      const recoveryRequired = new Error('Recovery required.')
      const operationId = 'operationId' in command ? command.operationId : undefined
      const guard = async ({
        beforeWrite = false,
        reader,
      }: {
        beforeWrite?: boolean
        reader: ReconciliationReader
      }) => {
        const state = await readAcceptedGeneration({ reader, taskId: command.taskId })
        if ('attemptId' in command && state.attempt?.id !== command.attemptId) {
          conflict()
        }
        const closing = await assertCommandEvidence({ operationId, reader, state })
        if (
          hasUncertainWrite &&
          isClosing &&
          state.task.status === 'closed' &&
          closing?.originalOperationId !== operationId
        ) {
          conflict()
        }
        if (
          beforeWrite &&
          isClosing &&
          !['closed', 'succeeded'].includes(String(state.task.status))
        ) {
          if (state.attempt?.status === 'output_ready') {
            throw recoveryRequired
          }
          if (state.task.status !== 'unknown' || state.attempt?.status !== 'unknown') {
            conflict()
          }
          if (hasOutputFacts({ state })) {
            conflict()
          }
        }
        return { ...state, closing }
      }
      const guarded: WorkerPersistence = {
        isCommitUnknown: ({ error }) => persistence.isCommitUnknown({ error }),
        read: ({ work }) =>
          persistence.read({
            work: async ({ reader }) => {
              await guard({ reader })
              return work({ reader })
            },
          }),
        write: async ({ resources, work }) => {
          hasAttemptedWrite = true
          try {
            const result = await persistence.write({
              resources,
              work: async ({ repository }) => {
                await guard({ beforeWrite: true, reader: repository })
                const value = await work({ repository })
                await guard({ reader: repository })
                return value
              },
            })
            hasConfirmedWrite = true
            return result
          } catch (error) {
            if (
              persistence.isCommitUnknown({ error }) ||
              persistence.isTransactionUncertain({ error })
            ) {
              hasUncertainWrite = true
            }
            throw error
          }
        },
      }
      const worker = createGenerationWorker({
        ...workerOptions,
        clock,
        imageLimits,
        persistence: guarded,
        storage,
        trustedClose: { actor, reasons: ['PROVIDER_UNRESOLVED'] },
      })
      const read = () => persistence.read({ work: ({ reader }) => guard({ reader }) })
      try {
        const initial = await read()
        if (
          command.action !== 'inspect' &&
          !['closed', 'succeeded'].includes(String(initial.task.status))
        ) {
          if (
            !initial.attempt ||
            !['output_ready', 'sending', 'unknown'].includes(String(initial.attempt.status))
          ) {
            conflict()
          }
          if (command.action === 'recover') {
            await worker.recoverOnly({ attemptId: command.attemptId, taskId: command.taskId })
          } else {
            // Network observation owns neither the Redis resources nor a SQLite request.
            const observation = await storage.findAttemptCandidates({
              attemptId: command.attemptId,
              maxBytes: imageLimits.maxBytes,
              maxCandidates: 2,
              maxPages: 4,
              storageOutput: initial.snapshot.storageOutput,
              taskId: command.taskId,
            })
            if (observation.status === 'complete' && observation.candidates.length === 1) {
              await worker.recoverOnly({ attemptId: command.attemptId, taskId: command.taskId })
            } else if (observation.status === 'complete' && observation.candidates.length === 0) {
              if (hasOutputFacts({ state: initial })) {
                conflict()
              }
              isClosing = true
              try {
                await worker.closeUnknown({
                  operationId: command.operationId,
                  reason: 'PROVIDER_UNRESOLVED',
                  taskId: command.taskId,
                })
              } catch (error) {
                if (error !== recoveryRequired) {
                  throw error
                }
                isClosing = false
                await worker.recoverOnly({ attemptId: command.attemptId, taskId: command.taskId })
              }
            }
          }
        }
        const current = await read()
        // A kernel confirmation may have swallowed the commit error; only the complete guarded graph confirms it.
        if (hasUncertainWrite && !['closed', 'succeeded'].includes(String(current.task.status))) {
          throw new GenerationReconciliationError({
            code: 'RECONCILIATION_OUTCOME_UNKNOWN',
            outcome: 'unknown',
            requestId,
          })
        }
        return Object.freeze({
          action: command.action,
          attemptId: current.attempt ? integer({ value: current.attempt.id }) : null,
          outcome: 'confirmed',
          requestId,
          result:
            current.task.status === 'closed'
              ? 'closed'
              : current.task.status === 'succeeded'
                ? 'succeeded'
                : current.task.status === 'failed'
                  ? 'failed'
                  : current.task.status === 'cancelled'
                    ? 'cancelled'
                    : 'pending',
          taskId: command.taskId,
          taskStatus: String(current.task.status),
          ...(current.closing ?? {}),
        })
      } catch (error) {
        const outcome =
          hasUncertainWrite || hasConfirmedWrite
            ? 'unknown'
            : hasAttemptedWrite
              ? 'rolled_back'
              : 'not_started'
        const code =
          outcome === 'unknown'
            ? 'RECONCILIATION_OUTCOME_UNKNOWN'
            : error instanceof GenerationReconciliationError
              ? error.code
              : error instanceof GenerationError
                ? 'RECONCILIATION_DATA_INTEGRITY'
                : 'RECONCILIATION_FAILED'
        throw new GenerationReconciliationError({ code, outcome, requestId })
      }
    },
  })
}

async function assertCommandEvidence({
  operationId,
  reader,
  state,
}: {
  operationId?: string
  reader: ReconciliationReader
  state: AcceptedGeneration
}) {
  const taskId = integer({ value: state.task.id })
  const conflicts = operationId
    ? await reader.findCloseOperationConflicts({ operationId, taskId })
    : []
  if (state.task.status !== 'closed') {
    if (conflicts.length || (await reader.findTaskCloseAuditCandidates({ taskId })).length) {
      conflict()
    }
    if (state.task.status === 'succeeded') {
      await assertDelivered({ reader, state })
    }
    return null
  }
  await assertClosed({ reader, state })
  if (
    state.task.errorCode !== 'UNKNOWN_CLOSED' ||
    typeof state.task.finishedAt !== 'string' ||
    !Number.isFinite(Date.parse(state.task.finishedAt)) ||
    new Date(state.task.finishedAt).toISOString() !== state.task.finishedAt
  ) {
    conflict()
  }
  const logs = await reader.findTaskCloseAuditCandidates({ taskId })
  const audit = logs[0]!
  const before = dataRecord({ value: audit.beforeState })
  const after = dataRecord({ value: audit.afterState })
  const summary = dataRecord({ value: audit.summary })
  const originalOperationId = audit.correlationId
  if (
    typeof originalOperationId !== 'string' ||
    !isReconciliationOperationId({ value: originalOperationId }) ||
    audit.requestId !== originalOperationId ||
    audit.action !== 'GENERATION_UNKNOWN_CLOSED' ||
    audit.resourceType !== 'generation-task' ||
    audit.resourceId !== String(taskId) ||
    before.attemptId !== state.attempt?.id ||
    before.status !== 'unknown' ||
    after.attemptId !== state.attempt?.id ||
    after.status !== 'closed' ||
    summary.reason !== 'PROVIDER_UNRESOLVED' ||
    summary.taskId !== taskId ||
    !(
      (audit.actorType === 'admin' &&
        typeof audit.actorId === 'string' &&
        /^[1-9]\d*$/.test(audit.actorId) &&
        Number.isSafeInteger(Number(audit.actorId))) ||
      (audit.actorType === 'system' &&
        typeof audit.actorId === 'string' &&
        /^[A-Z0-9][\w.-]*$/i.test(audit.actorId))
    )
  ) {
    conflict()
  }
  const originalConflicts = await reader.findCloseOperationConflicts({
    operationId: originalOperationId,
    taskId,
  })
  if (
    originalConflicts.length !== 1 ||
    originalConflicts[0]!.id !== audit.id ||
    deleted({ doc: originalConflicts[0]! }) ||
    conflicts.some((candidate) => candidate.id !== audit.id || deleted({ doc: candidate }))
  ) {
    conflict()
  }
  const reservations = await reader.findGenerationReservationCandidates({ taskId })
  if (reservations.length !== 1 || reservations[0]!.status !== 'released') {
    conflict()
  }
  const allocations = await reader.readReservationAllocations({
    reservationId: integer({ value: reservations[0]!.id }),
  })
  let releasedCredits = 0
  let expiredCredits = 0
  for (const allocation of allocations) {
    if (allocation.status === 'released') {
      releasedCredits += integer({ value: allocation.amountCredits })
    } else if (allocation.status === 'expired') {
      expiredCredits += integer({ value: allocation.amountCredits })
    } else {
      conflict()
    }
  }
  return { expiredCredits, originalOperationId, releasedCredits }
}
function hasOutputFacts({ state }: { state: AcceptedGeneration }) {
  return (
    state.attempt &&
    ['resultSha256', 'resultStorageBackend', 'resultStorageBucket', 'resultStorageKey'].some(
      (key) => state.attempt![key as keyof typeof state.attempt] != null,
    )
  )
}
function dataRecord({ value }: { value: unknown }): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    conflict()
  }
  const result: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (!property || !('value' in property)) {
      conflict()
    }
    Object.defineProperty(result, key, { enumerable: true, value: property.value })
  }
  return result
}
