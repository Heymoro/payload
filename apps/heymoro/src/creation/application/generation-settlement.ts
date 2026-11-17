import type { StoredImage } from '../domain/media.js'
import type { DeliveryEvidenceReader } from './generation-reader-types.js'
import type {
  AcceptedGeneration,
  WorkerPersistence,
  WorkerRepository,
} from './generation-worker-types.js'

import { generationTime, integer } from '../domain/generation.js'
import { deleted, singleCandidate } from './generation-evidence.js'
import { settleGenerationFunds } from './generation-funds.js'
import {
  assertClosed,
  assertDelivered,
  assertFailed,
  assertOutput,
} from './generation-settlement-evidence.js'
import {
  conflict,
  readAcceptedGeneration,
  workerActor,
  workerResources,
} from './generation-worker-types.js'

export type TrustedClose = Readonly<{ actor: string; reasons: readonly string[] }>
export function createGenerationSettlement({
  clock,
  persistence,
  trustedClose,
}: {
  clock: () => string
  persistence: WorkerPersistence
  trustedClose: null | TrustedClose
}) {
  if (
    trustedClose &&
    (!/^(?:admin:[1-9]\d*|system:[A-Za-z0-9][\w.-]*)$/.test(trustedClose.actor) ||
      trustedClose.reasons.length === 0 ||
      trustedClose.reasons.some((reason) => !/^[A-Z][A-Z0-9_]{0,79}$/.test(reason)))
  ) {
    throw new Error('Explicit trusted reconciliation policy required.')
  }
  const policy = trustedClose ? structuredClone(trustedClose) : null
  async function transact<T>({
    confirm,
    taskId,
    work,
  }: {
    confirm: (args: { reader: DeliveryEvidenceReader; state: AcceptedGeneration }) => Promise<T>
    taskId: number
    work: (args: {
      now: string
      repository: WorkerRepository
      state: AcceptedGeneration
    }) => Promise<T>
  }) {
    const initial = await persistence.read({
      work: ({ reader }) => readAcceptedGeneration({ reader, taskId }),
    })
    try {
      return await persistence.write({
        resources: workerResources({ task: initial.task }),
        work: async ({ repository }) =>
          work({
            now: generationTime({ now: clock() }),
            repository,
            state: await readAcceptedGeneration({ reader: repository, taskId }),
          }),
      })
    } catch (error) {
      if (!persistence.isCommitUnknown({ error })) {
        throw error
      }
      // Confirmation is read-only. A missing complete graph leaves the unknown commit unresolved.
      return persistence.read({
        work: async ({ reader }) =>
          confirm({ reader, state: await readAcceptedGeneration({ reader, taskId }) }),
      })
    }
  }
  return Object.freeze({
    closeUnknown: async ({
      operationId,
      reason,
      taskId,
    }: {
      operationId: string
      reason: string
      taskId: number
    }) => {
      if (
        !policy ||
        !policy.reasons.includes(reason) ||
        typeof operationId !== 'string' ||
        !/^[A-Z0-9][\w.-]{0,127}$/i.test(operationId)
      ) {
        throw new Error('Trusted internal reconciliation capability required.')
      }
      return transact({
        confirm: async ({ reader, state }) => {
          await assertClosed({ reader, state })
          return 'closed' as const
        },
        taskId,
        work: async ({ now, repository, state }) => {
          if (state.task.status === 'closed') {
            await assertClosed({ reader: repository, state })
            return 'closed' as const
          }
          if (state.task.status === 'succeeded') {
            await assertDelivered({ reader: repository, state })
            return 'succeeded' as const
          }
          if (state.task.status !== 'unknown' || state.attempt?.status !== 'unknown') {
            conflict()
          }
          if (
            (await repository.findCloseOperationConflicts({ operationId, taskId })).length !== 0
          ) {
            conflict()
          }
          await settleGenerationFunds({ now, operation: 'release', repository, task: state.task })
          await repository.closeUnknownTask({ actor: policy.actor, now, taskId })
          await repository.appendUnknownCloseAudit({
            actor: policy.actor,
            attemptId: state.attempt.id,
            now,
            operationId,
            reason,
            taskId,
          })
          await assertClosed({
            reader: repository,
            state: await readAcceptedGeneration({ reader: repository, taskId }),
          })
          return 'closed' as const
        },
      })
    },
    deliver: async ({
      attemptId,
      facts,
      taskId,
    }: {
      attemptId: number
      facts: StoredImage
      taskId: number
    }) =>
      transact({
        confirm: async ({ reader, state }) => {
          await assertDelivered({ reader, state })
          return 'succeeded' as const
        },
        taskId,
        work: async ({ now, repository, state }) => {
          const { attempt, snapshot, task } = state
          if (task.status === 'succeeded') {
            await assertDelivered({ reader: repository, state })
            return 'succeeded' as const
          }
          if (task.status === 'closed') {
            await assertClosed({ reader: repository, state })
            return 'closed' as const
          }
          if (
            !attempt ||
            attempt.id !== attemptId ||
            attempt.status !== 'output_ready' ||
            !['running', 'unknown'].includes(String(task.status))
          ) {
            conflict()
          }
          assertOutput({ facts, state })
          if ((await repository.findTaskArtifactCandidates({ taskId })).length !== 0) {
            conflict()
          }
          const media = await repository.registerMedia({
            actor: workerActor,
            facts,
            now,
            originalName: 'generation.png',
            owner: integer({ value: task.userId }),
            purpose: 'artifact',
            visibility: 'private',
          })
          const artifact = await repository.insertDeliveredArtifact({
            mediaId: media.id,
            now,
            sessionId: task.sessionId,
            taskId,
            userId: task.userId,
          })
          await settleGenerationFunds({ now, operation: 'capture', repository, task })
          await repository.recordAttemptSucceeded({ attemptId, now })
          await repository.recordTaskSucceeded({ now, previousTaskStatus: task.status, taskId })
          const session = singleCandidate({
            candidates: await repository.findSessionCandidates({
              sessionId: integer({ value: task.sessionId }),
            }),
          })
          if (
            !session ||
            deleted({ doc: session }) ||
            session.userId !== task.userId ||
            session.templateId !== snapshot.templateId
          ) {
            conflict()
          }
          const naming =
            session.autoNameStatus === 'idle'
              ? session.titleSource === 'user'
                ? 'skipped'
                : 'pending'
              : session.autoNameStatus
          if (naming === 'pending' && session.autoNameStatus === 'idle') {
            await repository.queueName({ sessionId: integer({ value: session.id }) })
          }
          await repository.recordSessionDelivery({
            artifactId: artifact.id,
            expectedAutoNameStatus: session.autoNameStatus,
            expectedTitleSource: session.titleSource,
            namingStatus: naming,
            now,
            sessionId: integer({ value: session.id }),
          })
          await assertDelivered({
            reader: repository,
            state: await readAcceptedGeneration({ reader: repository, taskId }),
          })
          return 'succeeded' as const
        },
      }),
    fail: async ({
      attemptId,
      reason,
      requestId = null,
      taskId,
    }: {
      attemptId: number
      reason: 'NOT_SENT' | 'PROVIDER_REJECTED'
      requestId?: null | string
      taskId: number
    }) =>
      transact({
        confirm: async ({ reader, state }) => {
          await assertFailed({ reader, state })
          return 'failed' as const
        },
        taskId,
        work: async ({ now, repository, state }) => {
          if (!['NOT_SENT', 'PROVIDER_REJECTED'].includes(reason)) {
            conflict()
          }
          if (state.task.status === 'failed') {
            await assertFailed({ reader: repository, state })
            return 'failed' as const
          }
          if (
            !state.attempt ||
            state.attempt.id !== attemptId ||
            !['prepared', 'sending'].includes(String(state.attempt.status)) ||
            state.task.status !== 'running' ||
            (reason === 'PROVIDER_REJECTED' && state.attempt.status !== 'sending')
          ) {
            conflict()
          }
          await settleGenerationFunds({ now, operation: 'release', repository, task: state.task })
          await repository.recordAttemptFailed({
            attemptId,
            now,
            previousAttemptStatus: state.attempt.status,
            providerRequestId: requestId ?? state.attempt.providerRequestId,
            reason,
          })
          await repository.recordTaskFailed({ now, reason, taskId })
          await assertFailed({
            reader: repository,
            state: await readAcceptedGeneration({ reader: repository, taskId }),
          })
          return 'failed' as const
        },
      }),
  })
}
