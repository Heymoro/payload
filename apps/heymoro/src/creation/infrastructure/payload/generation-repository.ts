import type { Payload, PayloadRequest } from 'payload'

import type {
  GenerationDependencies,
  GenerationRepository,
} from '../../application/generation-types.js'
import type { SnapshotFind } from './read-snapshot.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'
import type { CreationWriteGate } from './write-gate.js'

import { createGenerationService } from '../../application/generation.js'
import { createPayloadCreditRepository } from './credits-repository.js'
import { generationQueue, generationTaskSlug } from './generation-jobs.js'
import { createGenerationReader } from './generation-reader.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'
import { createCreationRuntime } from './session-repository.js'
import { createSQLiteUnitOfWork } from './sqlite-unit-of-work.js'

export type GenerationCoordinator = <T>(args: {
  resources: readonly string[]
  work: (args: { assertLease: () => void }) => Promise<T>
}) => Promise<T>
export function createPayloadGenerationService({
  clock,
  coordinateMany,
  execution,
  hostCaps,
  isCompatible,
  quoteCodec,
  ...options
}: { coordinateMany: GenerationCoordinator } & Omit<SQLiteUnitOfWorkOptions, 'coordinate'> &
  Pick<
    GenerationDependencies,
    'clock' | 'execution' | 'hostCaps' | 'isCompatible' | 'quoteCodec'
  >) {
  const fields = options.payload.collections.users?.config.flattenedFields
  if (
    !fields?.some((field) => field.name === 'status') ||
    !fields.some((field) => field.name === 'isDeleted' && field.type === 'checkbox')
  ) {
    throw new Error(
      'Creation generation requires users status and an isDeleted checkbox in the target schema.',
    )
  }
  createCreationRuntime({ gate: options.gate, payload: options.payload })
  const read = createSQLiteReadSnapshot({ payload: options.payload })
  return createGenerationService({
    clock,
    execution,
    hostCaps,
    isCompatible,
    quoteCodec,
    read: ({ work }) =>
      read({ work: ({ find }) => work({ reader: createGenerationReader({ find }) }) }),
    write: ({ resources, work }) =>
      coordinateMany({
        resources,
        work: ({ assertLease }) => {
          // Reuse the proven UOW and its complete retry/rollback semantics without reacquiring outer resources.
          const run = createSQLiteUnitOfWork({
            ...options,
            coordinate: ({ work: transactionWork }) => transactionWork({ assertLease }),
          })
          return run({
            resource: resources[0]!,
            work: ({ req }) => {
              const repository = createPayloadGenerationRepository({
                gate: options.gate,
                payload: options.payload,
                req,
              })
              return work({ repository })
            },
          })
        },
      }),
  })
}
export function createPayloadGenerationRepository({
  gate,
  payload,
  req,
}: {
  gate: CreationWriteGate
  payload: Payload
  req: PayloadRequest
}): GenerationRepository {
  const runtime = createCreationRuntime({ gate, payload })
  const find: SnapshotFind = (args) =>
    runtime.find({
      ...args,
      collection: args.collection as Parameters<typeof runtime.find>[0]['collection'],
      req,
    })
  const repository: GenerationRepository = {
    ...createGenerationReader({ find }),
    advanceSessionRound: async ({ nextRoundNo, now, sessionId, userId }) => {
      await runtime.update({
        id: sessionId,
        collection: 'creation-sessions',
        data: {
          lastActivityAt: now,
          nextRoundNo,
          updatedAt: now,
          updatedBy: `user:${userId}`,
        },
        req,
      })
    },
    credits: createPayloadCreditRepository({ gate, payload, req }),
    enqueueGeneration: ({ taskId }) =>
      gate.run({
        req,
        work: async () => {
          gate.assert({ req })
          const jobs = payload.jobs as unknown as {
            queue: (args: {
              input: { taskId: number }
              overrideAccess: true
              queue: string
              req: PayloadRequest
              task: string
            }) => Promise<unknown>
          }
          await jobs.queue({
            input: { taskId },
            overrideAccess: true,
            queue: generationQueue,
            req,
            task: generationTaskSlug,
          })
          gate.assert({ req })
        },
      }),
    insertGenerationAllocation: async ({ amountCredits, grantId, now, reservationId }) => {
      await runtime.create({
        collection: 'credit-allocations',
        data: {
          ...creationAudit({ actor: 'system:generation', now }),
          amountCredits,
          grantId,
          reservationId,
          status: 'reserved',
        },
        req,
      })
    },
    insertGenerationReservation: async ({
      accountId,
      amountCredits,
      now,
      reservationKey,
      taskId,
      userId,
    }) => {
      const reservation = await runtime.create({
        collection: 'credit-reservations',
        data: {
          ...creationAudit({ actor: 'system:generation', now }),
          accountId,
          amountCredits,
          reservationKey,
          reviewAfter: null,
          settledAt: null,
          status: 'reserved',
          taskId,
          userId,
        },
        req,
      })
      return { id: reservation.id }
    },
    insertOrderedTaskInputs: async ({ inputs, now, taskId, userId }) => {
      for (const input of inputs) {
        await runtime.create({
          collection: 'generation-inputs',
          data: {
            ...creationAudit({ actor: `user:${userId}`, now }),
            contentSha256: input.contentSha256,
            mediaId: input.mediaId,
            position: input.position,
            taskId,
            userId,
          },
          req,
        })
      }
    },
    insertQueuedTask: async ({
      clientRequestId,
      costCredits,
      description,
      executionSnapshotJson,
      now,
      requestHash,
      roundNo,
      sessionId,
      sourceTaskId,
      templateId,
      userId,
      userNotes,
    }) => {
      const task = await runtime.create({
        collection: 'generation-tasks',
        data: {
          ...creationAudit({ actor: `user:${userId}`, now }),
          clientRequestId,
          costCredits,
          description,
          errorCode: null,
          executionSnapshotJson,
          finishedAt: null,
          requestHash,
          roundNo,
          sessionId,
          sourceTaskId,
          startedAt: null,
          status: 'queued',
          templateId,
          userId,
          userNotes,
        },
        req,
      })
      return {
        id: task.id,
        clientRequestId: task.clientRequestId,
        costCredits: task.costCredits,
        errorCode: task.errorCode,
        roundNo: task.roundNo,
        sessionId: task.sessionId,
        sourceTaskId: task.sourceTaskId,
        status: task.status,
        templateId: task.templateId,
      }
    },
  }
  return repository
}

function creationAudit({ actor, now }: { actor: string; now: string }) {
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
