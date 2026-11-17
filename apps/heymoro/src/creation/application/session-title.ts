import type { TitlePersistence } from './session-naming-types.js'

import { GenerationError, generationTime } from '../domain/generation.js'
import { normalizeTitleCommand } from '../domain/session-title.js'
import { active } from './generation-evidence.js'
import { readNamingSession } from './session-naming-context.js'

export function createSessionTitleService({
  clock,
  persistence,
}: {
  clock: () => string
  persistence: TitlePersistence
}) {
  return async ({
    command,
    sessionId,
    userId,
  }: {
    command: unknown
    sessionId: number
    userId: number
  }) => {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new GenerationError({ code: 'UNAUTHENTICATED' })
    }
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      throw new GenerationError({ code: 'INPUT_INVALID' })
    }
    const title = normalizeTitleCommand({ value: command })
    return persistence.write({
      session: { id: sessionId, userId },
      work: async ({ repository }) => {
        await active({ reader: repository, userId })
        const session = await readNamingSession({ reader: repository, sessionId })
        if (session.userId !== userId) {
          throw new GenerationError({ code: 'NOT_FOUND' })
        }
        const now = generationTime({ now: clock() })
        await repository.updateSession({
          data: { title, titleSource: 'user', updatedAt: now, updatedBy: `user:${userId}` },
          session,
        })
        return { sessionId, title, titleSource: 'user' as const }
      },
    })
  }
}
