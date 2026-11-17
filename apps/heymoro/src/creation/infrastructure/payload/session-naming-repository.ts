import type { TaskHandler } from 'payload'

import type { NamingReader, RenameReader } from '../../application/generation-reader-types.js'
import type { SessionNamingOptions } from '../../application/session-naming.js'
import type { TitlePersistence } from '../../application/session-naming-types.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'

import { createSessionNaming } from '../../application/session-naming.js'
import { createGenerationReader } from './generation-reader.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'
import { createCreationRuntime } from './session-repository.js'
import { createSQLiteUnitOfWork, CreationTransactionError } from './sqlite-unit-of-work.js'

/** Shared short-transaction port for internal naming and separately authorized user title edits. */
export function createPayloadTitlePersistence(
  options: SQLiteUnitOfWorkOptions,
): TitlePersistence<NamingReader & RenameReader> {
  const { gate, payload } = options
  const runtime = createCreationRuntime({ gate, payload })
  const read = createSQLiteReadSnapshot({ payload })
  const write = createSQLiteUnitOfWork(options)
  return {
    isCommitUnknown: ({ error }) =>
      error instanceof CreationTransactionError && error.commitStarted,
    read: ({ work }) =>
      read({ work: ({ find }) => work({ reader: createGenerationReader({ find }) }) }),
    write: ({ session, work }) =>
      write({
        resource: `session:${session.userId}:${session.id}`,
        work: ({ req }) =>
          work({
            repository: {
              ...createGenerationReader({
                find: (args) =>
                  runtime.find({
                    ...args,
                    collection: args.collection as Parameters<typeof runtime.find>[0]['collection'],
                    req,
                  }),
              }),
              updateSession: async ({ data, session: current }) => {
                await runtime.updateExpected({
                  id: current.id,
                  collection: 'creation-sessions',
                  data: { ...data },
                  expected: {
                    and: [
                      { userId: { equals: current.userId } },
                      { isDeleted: { equals: false } },
                      { autoNameStatus: { equals: current.status } },
                      { autoNameStartedAt: { equals: current.startedAt } },
                    ],
                  },
                  req,
                })
              },
            },
          }),
      }),
  }
}
export function createPayloadSessionNaming(
  options: Omit<SessionNamingOptions, 'persistence'> & SQLiteUnitOfWorkOptions,
) {
  return createSessionNaming({ ...options, persistence: createPayloadTitlePersistence(options) })
}
export function createPayloadSessionNamingJobHandler({
  worker,
}: {
  worker: Pick<ReturnType<typeof createPayloadSessionNaming>, 'run'>
}): TaskHandler<{ input: { sessionId: number }; output: object }> {
  return async ({ input }) => {
    await worker.run(input)
    return { output: {} }
  }
}
