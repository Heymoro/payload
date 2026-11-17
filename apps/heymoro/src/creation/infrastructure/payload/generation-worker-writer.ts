import type { PayloadRequest } from 'payload'

import type {
  AttemptLifecycleWriter,
  GenerationSettlementWriter,
} from '../../application/generation-worker-types.js'
import type { createCreationRuntime } from './session-repository.js'

import { workerActor } from '../../application/generation-worker-types.js'

/** Only physical mappings live here; the caller owns policy, facts and transition order. */
export function createGenerationWorkerWriter({
  req,
  runtime,
}: {
  req: PayloadRequest
  runtime: Pick<ReturnType<typeof createCreationRuntime>, 'create' | 'updateExpected'>
}): AttemptLifecycleWriter & GenerationSettlementWriter {
  return Object.freeze({
    appendUnknownCloseAudit: async ({ actor, attemptId, now, operationId, reason, taskId }) => {
      const [actorType, actorId] = actor.split(':')
      await runtime.create({
        collection: 'auditLogs',
        data: {
          ...workerAudit({ actor, now }),
          action: 'GENERATION_UNKNOWN_CLOSED',
          actorId,
          actorType,
          afterState: { attemptId, status: 'closed' },
          beforeState: { attemptId, status: 'unknown' },
          correlationId: operationId,
          requestId: operationId,
          resourceId: String(taskId),
          resourceType: 'generation-task',
          result: 'success',
          summary: { reason, taskId },
        },
        req,
      })
    },
    closeUnknownTask: async ({ actor, now, taskId }) => {
      await runtime.updateExpected({
        id: taskId,
        collection: 'generation-tasks',
        data: {
          ...workerUpdate({ now }),
          errorCode: 'UNKNOWN_CLOSED',
          finishedAt: now,
          status: 'closed',
          updatedBy: actor,
        },
        expected: { status: { equals: 'unknown' } },
        req,
      })
    },
    expirePreparedAttempt: async ({ attemptId, now }) => {
      await runtime.updateExpected({
        id: attemptId,
        collection: 'generation-attempts',
        data: {
          ...workerUpdate({ now }),
          errorCode: 'NOT_SENT',
          finishedAt: now,
          status: 'failed',
        },
        expected: {
          and: [{ status: { equals: 'prepared' } }, { leaseUntil: { less_than_equal: now } }],
        },
        req,
      })
    },
    insertDeliveredArtifact: async ({ mediaId, now, sessionId, taskId, userId }) => {
      const created = await runtime.create({
        collection: 'artifacts',
        data: { ...workerAudit({ now }), mediaId, outputIndex: 1, sessionId, taskId, userId },
        req,
      })
      return { id: created.id }
    },
    insertPreparedAttempt: async ({ attemptNo, leaseUntil, model, now, provider, taskId }) => {
      const created = await runtime.create({
        collection: 'generation-attempts',
        data: {
          ...workerAudit({ now }),
          attemptNo,
          leaseUntil,
          model,
          provider,
          startedAt: now,
          status: 'prepared',
          taskId,
        },
        req,
      })
      return { id: created.id }
    },
    recordAttemptFailed: async ({
      attemptId,
      now,
      previousAttemptStatus,
      providerRequestId,
      reason,
    }) => {
      await runtime.updateExpected({
        id: attemptId,
        collection: 'generation-attempts',
        data: {
          ...workerUpdate({ now }),
          errorCode: reason,
          finishedAt: now,
          providerRequestId,
          status: 'failed',
        },
        expected: { status: { equals: previousAttemptStatus } },
        req,
      })
    },
    recordAttemptOutput: async ({
      attemptId,
      facts,
      isClosed,
      now,
      previousAttemptStatus,
      providerRequestId,
    }) => {
      await runtime.updateExpected({
        id: attemptId,
        collection: 'generation-attempts',
        data: {
          ...workerUpdate({ now }),
          providerRequestId,
          resultSha256: facts.sha256,
          resultStorageBackend: facts.ref.backend,
          resultStorageBucket: facts.ref.bucket,
          resultStorageKey: facts.ref.key,
          status: isClosed ? 'unknown' : 'output_ready',
        },
        expected: { status: { equals: previousAttemptStatus } },
        req,
      })
    },
    recordAttemptProviderUnknown: async ({
      attemptId,
      now,
      previousAttemptStatus,
      providerRequestId,
    }) => {
      await runtime.updateExpected({
        id: attemptId,
        collection: 'generation-attempts',
        data: {
          ...workerUpdate({ now }),
          errorCode: 'PROVIDER_UNKNOWN',
          providerRequestId,
          status: 'unknown',
        },
        expected: { status: { equals: previousAttemptStatus } },
        req,
      })
    },
    recordAttemptSending: async ({ attemptId, now }) => {
      await runtime.updateExpected({
        id: attemptId,
        collection: 'generation-attempts',
        data: { ...workerUpdate({ now }), status: 'sending' },
        expected: {
          and: [{ status: { equals: 'prepared' } }, { leaseUntil: { greater_than: now } }],
        },
        req,
      })
    },
    recordAttemptSucceeded: async ({ attemptId, now }) => {
      await runtime.updateExpected({
        id: attemptId,
        collection: 'generation-attempts',
        data: { ...workerUpdate({ now }), errorCode: null, finishedAt: now, status: 'succeeded' },
        expected: { status: { equals: 'output_ready' } },
        req,
      })
    },
    recordSessionDelivery: async ({
      artifactId,
      expectedAutoNameStatus,
      expectedTitleSource,
      namingStatus,
      now,
      sessionId,
    }) => {
      await runtime.updateExpected({
        id: sessionId,
        collection: 'creation-sessions',
        data: {
          ...workerUpdate({ now }),
          autoNameStatus: namingStatus,
          coverArtifactId: artifactId,
          lastActivityAt: now,
        },
        expected: {
          and: [
            { titleSource: { equals: expectedTitleSource } },
            { autoNameStatus: { equals: expectedAutoNameStatus } },
          ],
        },
        req,
      })
    },
    recordTaskFailed: async ({ now, reason, taskId }) => {
      await runtime.updateExpected({
        id: taskId,
        collection: 'generation-tasks',
        data: { ...workerUpdate({ now }), errorCode: reason, finishedAt: now, status: 'failed' },
        expected: { status: { equals: 'running' } },
        req,
      })
    },
    recordTaskProviderUnknown: async ({ now, previousTaskStatus, taskId }) => {
      await runtime.updateExpected({
        id: taskId,
        collection: 'generation-tasks',
        data: { ...workerUpdate({ now }), errorCode: 'PROVIDER_UNKNOWN', status: 'unknown' },
        expected: { status: { equals: previousTaskStatus } },
        req,
      })
    },
    recordTaskRunning: async ({ now, previousTaskStatus, startedAt, taskId }) => {
      await runtime.updateExpected({
        id: taskId,
        collection: 'generation-tasks',
        data: { ...workerUpdate({ now }), startedAt, status: 'running' },
        expected: { status: { equals: previousTaskStatus } },
        req,
      })
    },
    recordTaskSucceeded: async ({ now, previousTaskStatus, taskId }) => {
      await runtime.updateExpected({
        id: taskId,
        collection: 'generation-tasks',
        data: { ...workerUpdate({ now }), errorCode: null, finishedAt: now, status: 'succeeded' },
        expected: { status: { equals: previousTaskStatus } },
        req,
      })
    },
    settleGenerationAllocation: async ({ allocationId, isExpired, now, operation }) => {
      await runtime.updateExpected({
        id: allocationId,
        collection: 'credit-allocations',
        data: {
          ...workerUpdate({ now }),
          status: operation === 'capture' ? 'captured' : isExpired ? 'expired' : 'released',
        },
        expected: { status: { equals: 'reserved' } },
        req,
      })
    },
    settleGenerationReservation: async ({
      now,
      operation,
      previousReservationStatus,
      reservationId,
    }) => {
      await runtime.updateExpected({
        id: reservationId,
        collection: 'credit-reservations',
        data: {
          ...workerUpdate({ now }),
          settledAt: now,
          status: operation === 'capture' ? 'captured' : 'released',
        },
        expected: { status: { equals: previousReservationStatus } },
        req,
      })
    },
  })
}

function workerAudit({ actor = workerActor, now }: { actor?: string; now: string }) {
  return {
    createdAt: now,
    createdBy: actor,
    deletedAt: null,
    deletedBy: null,
    isDeleted: false,
    updatedAt: now,
    updatedBy: actor,
  }
}
function workerUpdate({ now }: { now: string }) {
  return { updatedAt: now, updatedBy: workerActor }
}
