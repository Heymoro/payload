import type { TaskHandler } from 'payload'

import type { GenerationReader } from '../../application/generation-reader-types.js'
import type { GenerationWorkerOptions } from '../../application/generation-worker.js'
import type {
  WorkerPersistence,
  WorkerRepository,
} from '../../application/generation-worker-types.js'
import type { GenerationCoordinator } from './generation-repository.js'
import type { SnapshotFind } from './read-snapshot.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'

import { createGenerationWorker } from '../../application/generation-worker.js'
import { GenerationReconciliationError } from '../../domain/generation-reconciliation.js'
import { validateImage } from '../image/sharp-image-validator.js'
import { authenticateNativeAdminPrincipal, readNativeAdminById } from './admin-repository.js'
import { createPayloadCreditRepository } from './credits-repository.js'
import { namingQueue, namingTaskSlug } from './generation-jobs.js'
import { createGenerationReader } from './generation-reader.js'
import { createGenerationWorkerWriter } from './generation-worker-writer.js'
import { createPayloadVerifiedMediaRegistration } from './media-repository.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'
import { createCreationRuntime } from './session-repository.js'
import { createSQLiteUnitOfWork, CreationTransactionError } from './sqlite-unit-of-work.js'

type Options = { coordinateMany: GenerationCoordinator } & Omit<
  GenerationWorkerOptions,
  'persistence' | 'validateImage'
> &
  Omit<SQLiteUnitOfWorkOptions, 'coordinate'>
export function createPayloadGenerationWorker({ coordinateMany, ...options }: Options) {
  return createGenerationWorker({
    ...options,
    persistence: createPayloadGenerationPersistence({ ...options, coordinateMany }),
    validateImage,
  })
}
export type PayloadGenerationPersistence = Omit<WorkerPersistence, 'read'> &
  Readonly<{
    read: <T>(args: { work: (args: { reader: GenerationReader }) => Promise<T> }) => Promise<T>
  }>
export function createPayloadGenerationPersistence({
  coordinateMany,
  nativeAdmin,
  ...options
}: {
  nativeAdmin?: Readonly<{ authorization: string; id: number }>
} & Pick<
  Options,
  'coordinateMany' | 'gate' | 'payload' | 'retry' | 'storage'
>): PayloadGenerationPersistence {
  const { gate, payload, storage } = options
  const runtime = createCreationRuntime({ gate, payload })
  if (
    !payload.collections.auditLogs?.config.hooks.beforeOperation?.includes(gate.beforeOperation)
  ) {
    throw new Error('Creation audit target requires the same private gate.')
  }
  const read = createSQLiteReadSnapshot({ payload })
  const register = createPayloadVerifiedMediaRegistration({ gate, payload, storage })
  const identity = nativeAdmin ? Object.freeze({ ...nativeAdmin }) : null
  const authorize = async ({ find }: { find: SnapshotFind }) => {
    if (!identity) {
      return
    }
    const current = await readNativeAdminById({ id: identity.id, find })
    if (!current || current.role !== 'admin' || current.status !== 'active') {
      throw new GenerationReconciliationError({ code: 'RECONCILIATION_FORBIDDEN' })
    }
  }
  const persistence: PayloadGenerationPersistence = {
    isCommitUnknown: ({ error }) =>
      error instanceof CreationTransactionError && error.commitStarted,
    read: ({ work }) =>
      read({
        work: async ({ find }) => {
          await authorize({ find })
          return work({ reader: createGenerationReader({ find }) })
        },
      }),
    write: ({ resources, work }) =>
      coordinateMany({
        resources,
        work: ({ assertLease }) =>
          createSQLiteUnitOfWork({
            coordinate: ({ work: transactionWork }) => transactionWork({ assertLease }),
            gate,
            payload,
            retry: options.retry,
          })({
            resource: resources[0]!,
            work: async ({ req }) => {
              const find: SnapshotFind = (args) =>
                runtime.find({
                  ...args,
                  collection: args.collection as Parameters<typeof runtime.find>[0]['collection'],
                  req,
                })
              if (identity) {
                const id = await authenticateNativeAdminPrincipal({
                  authorization: identity.authorization,
                  owned: { gate, req },
                  payload,
                })
                if (id !== identity.id) {
                  throw new GenerationReconciliationError({ code: 'RECONCILIATION_UNAUTHORIZED' })
                }
                await authorize({ find })
              }
              const repository: WorkerRepository = {
                ...createGenerationReader({ find }),
                ...createGenerationWorkerWriter({ req, runtime }),
                credits: createPayloadCreditRepository({ gate, payload, req }),
                queueName: ({ sessionId }) =>
                  gate.run({
                    req,
                    work: async () => {
                      gate.assert({ req })
                      const jobs = payload.jobs as unknown as {
                        queue: (args: {
                          input: { sessionId: number }
                          overrideAccess: true
                          queue: string
                          req: typeof req
                          task: string
                        }) => Promise<unknown>
                      }
                      await jobs.queue({
                        input: { sessionId },
                        overrideAccess: true,
                        queue: namingQueue,
                        req,
                        task: namingTaskSlug,
                      })
                      gate.assert({ req })
                    },
                  }),
                registerMedia: (args) => register({ ...args, req }),
              }
              return work({ repository })
            },
          }),
      }),
  }
  return persistence
}

/** Ignore the queue request entirely: all state transitions own fresh requests, network owns none. */
export function createPayloadGenerationJobHandler({
  worker,
}: {
  worker: Pick<ReturnType<typeof createPayloadGenerationWorker>, 'run'>
}): TaskHandler<{ input: { taskId: number }; output: object }> {
  return async ({ input }) => {
    await worker.run(input)
    return { output: {} }
  }
}
