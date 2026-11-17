import type { SnapshotFind } from './read-snapshot.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'

import { createArtifactFavorite } from '../../application/artifact-favorite.js'
import { assertLibrarySchema, createLibraryReader } from './owner-library-repository.js'
import { createCreationRuntime } from './session-repository.js'
import { createSQLiteUnitOfWork } from './sqlite-unit-of-work.js'

export function createPayloadArtifactFavorite({
  clock,
  ...options
}: { clock: () => string } & SQLiteUnitOfWorkOptions) {
  assertLibrarySchema({ payload: options.payload })
  const runtime = createCreationRuntime(options)
  const run = createSQLiteUnitOfWork(options)
  return createArtifactFavorite({
    clock,
    write: ({ artifactId, userId, work }) =>
      run({
        resource: `favorite:${userId}:${artifactId}`,
        work: ({ req }) => {
          const find: SnapshotFind = (args) =>
            runtime.find({
              ...args,
              collection: args.collection as Parameters<typeof runtime.find>[0]['collection'],
              req,
            })
          return work({
            repository: {
              ...createLibraryReader({ find }),
              insertFavorite: async ({ actor, artifactId, now, userId }) => {
                await runtime.create({
                  collection: 'saved-artifacts',
                  data: {
                    artifactId,
                    createdAt: now,
                    createdBy: actor,
                    deletedAt: null,
                    deletedBy: null,
                    isDeleted: false,
                    savedAt: now,
                    updatedAt: now,
                    updatedBy: actor,
                    userId,
                  },
                  req,
                })
              },
              // Payload owns updatedAt on updates; command time controls savedAt/deletedAt.
              removeFavorite: async ({ id, actor, now }) => {
                await runtime.update({
                  id,
                  collection: 'saved-artifacts',
                  data: {
                    deletedAt: now,
                    deletedBy: actor,
                    isDeleted: true,
                    updatedBy: actor,
                  },
                  req,
                })
              },
              restoreFavorite: async ({ id, actor, now }) => {
                await runtime.update({
                  id,
                  collection: 'saved-artifacts',
                  data: {
                    deletedAt: null,
                    deletedBy: null,
                    isDeleted: false,
                    savedAt: now,
                    updatedBy: actor,
                  },
                  req,
                })
              },
            },
          })
        },
      }),
  })
}
