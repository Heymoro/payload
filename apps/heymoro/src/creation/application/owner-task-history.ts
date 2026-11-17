import type { LibraryDocument } from './owner-library-types.js'
import type { TaskHistoryDTO, TaskHistoryOptions } from './owner-task-history-types.js'

import { GenerationError, integer } from '../domain/generation.js'
import { libraryInput, requestId } from '../domain/library.js'
import {
  assertHistoryDeletion,
  createTaskHistoryCursor,
  normalizeTaskHistoryQuery,
} from '../domain/task-history.js'
import { actorId, assertLibraryActor } from './owner-library.js'
import { projectTaskHistory } from './task-history-projection.js'
export function createOwnerTaskHistory({
  batchSize = 50,
  cursorKey,
  pageSize = 20,
  read,
  scanBudget = 500,
}: TaskHistoryOptions) {
  for (const [value, max] of [
    [pageSize, 50],
    [batchSize, 128],
    [scanBudget, 10000],
  ]) {
    if (!Number.isSafeInteger(value) || value! < 1 || value! > max!) {
      throw new Error('Invalid bounded task history configuration.')
    }
  }
  const codec = createTaskHistoryCursor({ cursorKey })
  return Object.freeze({
    get: async (args: { taskId: number; userId: number }): Promise<TaskHistoryDTO> => {
      const input = libraryInput({ fields: ['taskId', 'userId'], value: args })
      const userId = actorId({ value: input.userId })
      const taskId = requestId({ value: input.taskId })
      return read({
        work: async ({ reader }) => {
          await assertLibraryActor({ reader: reader.library, userId })
          const rows = await reader.tasks({ ids: [taskId] })
          if (rows.length > 1) {
            integrity()
          }
          const task = rows[0]
          if (!task || task.id !== taskId || task.userId !== userId) {
            notFound()
          }
          return (await projectTaskHistory({ reader, tasks: [task], userId }))[0]!
        },
      })
    },
    list: async (args: { query: unknown; sessionId: number; userId: number }) => {
      const input = libraryInput({ fields: ['query', 'sessionId', 'userId'], value: args })
      const userId = actorId({ value: input.userId })
      const sessionId = requestId({ value: input.sessionId })
      const query = normalizeTaskHistoryQuery({ value: input.query })
      const scope = { pageSize, sessionId, userId }
      let after = query.cursor ? codec.decode({ ...scope, token: query.cursor }) : null
      return read({
        work: async ({ reader }) => {
          await assertLibraryActor({ reader: reader.library, userId })
          const parents = await reader.sessions({ ids: [sessionId] })
          if (parents.length > 1) {
            integrity()
          }
          const parent = parents[0]
          if (!parent || parent.id !== sessionId || parent.userId !== userId) {
            notFound()
          }
          assertHistoryDeletion({ row: parent })
          integer({ value: parent.nextRoundNo })
          const items: TaskHistoryDTO[] = []
          let consumed = 0
          let hasMore = false
          while (items.length < pageSize && consumed < scanBudget) {
            const limit = Math.min(batchSize, scanBudget - consumed)
            const candidates = await reader.scan({ after, limit, sessionId })
            if (candidates.length > limit) {
              integrity()
            }
            if (!candidates.length) {
              hasMore = false
              break
            }
            const tasks: LibraryDocument[] = []
            let visible = 0
            for (const task of candidates) {
              const roundNo = integer({ value: task.roundNo })
              if (
                (after && roundNo >= after.roundNo) ||
                roundNo >= Number(parent.nextRoundNo) ||
                task.sessionId !== sessionId ||
                task.userId !== userId
              ) {
                integrity()
              }
              assertHistoryDeletion({ row: task })
              tasks.push(task)
              after = Object.freeze({ roundNo })
              consumed++
              if (task.isDeleted === false) {
                visible++
              }
              if (items.length + visible === pageSize || consumed === scanBudget) {
                break
              }
            }
            const projected = await projectTaskHistory({ reader, sessions: parents, tasks, userId })
            items.push(...projected.filter((_, index) => tasks[index]!.isDeleted === false))
            hasMore = tasks.length < candidates.length || candidates.length === limit
            if (!hasMore) {
              break
            }
          }
          return Object.freeze({
            hasMore,
            items: Object.freeze(items),
            nextCursor: hasMore && after ? codec.encode({ ...scope, after }) : null,
          })
        },
      })
    },
  })
}
function integrity(): never {
  throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
}
function notFound(): never {
  throw new GenerationError({ code: 'NOT_FOUND' })
}
