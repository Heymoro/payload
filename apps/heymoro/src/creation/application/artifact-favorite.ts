import type { FavoriteOptions } from './owner-library-types.js'

import { GenerationError, integer } from '../domain/generation.js'
import { libraryInput, libraryTime, requestId } from '../domain/library.js'
import {
  actorId,
  assertFavoriteTuple,
  assertLibraryActor,
  ownedLibraryArtifact,
  projectLibraryArtifacts,
} from './owner-library.js'

export function createArtifactFavorite({ clock, write }: FavoriteOptions) {
  return Object.freeze({
    set: async (args: { artifactId: number; isFavorite: boolean; userId: number }) => {
      const input = libraryInput({ fields: ['userId', 'artifactId', 'isFavorite'], value: args })
      const userId = actorId({ value: input.userId })
      const artifactId = requestId({ value: input.artifactId })
      const isFavorite = input.isFavorite
      if (typeof isFavorite !== 'boolean') {
        throw new GenerationError({ code: 'INPUT_INVALID' })
      }
      return write({
        artifactId,
        userId,
        work: async ({ repository }) => {
          await assertLibraryActor({ reader: repository, userId })
          const artifact = await ownedLibraryArtifact({
            allowDeleted: !isFavorite,
            artifactId,
            reader: repository,
            userId,
          })
          if (isFavorite) {
            await projectLibraryArtifacts({ artifacts: [artifact], reader: repository, userId })
          }
          const rows = await repository.favorites({ tuples: [{ artifactId, userId }] })
          const favorite = assertFavoriteTuple({ artifactId, rows, userId })
          if ((!favorite && !isFavorite) || (favorite && favorite.isDeleted === !isFavorite)) {
            return Object.freeze({
              isFavorite,
              savedAt: isFavorite ? libraryTime({ value: favorite!.savedAt }) : null,
            })
          }
          // Coordination is already held and the write decision is fixed before sampling time.
          const now = libraryTime({ value: clock() })
          const actor = `user:${userId}`
          if (!favorite) {
            await repository.insertFavorite({ actor, artifactId, now, userId })
          } else if (isFavorite) {
            await repository.restoreFavorite({ id: integer({ value: favorite.id }), actor, now })
          } else {
            await repository.removeFavorite({ id: integer({ value: favorite.id }), actor, now })
          }
          return Object.freeze({ isFavorite, savedAt: isFavorite ? now : null })
        },
      })
    },
  })
}
