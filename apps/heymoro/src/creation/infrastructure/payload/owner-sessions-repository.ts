import type { Payload, Where } from 'payload'

import type { SessionsOptions, SessionsReader } from '../../application/owner-sessions-types.js'
import type { SnapshotFind } from './read-snapshot.js'

import { createOwnerSessions } from '../../application/owner-sessions.js'
import { GenerationError } from '../../domain/generation.js'
import { createDraftReader } from './draft-repository.js'
import { assertLibrarySchema, createLibraryReader } from './owner-library-repository.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'

export function createPayloadOwnerSessions({
  payload,
  ...options
}: { payload: Payload } & Omit<SessionsOptions, 'read'>) {
  assertLibrarySchema({ payload })
  assertSessionsSchema({ payload })
  const snapshot = createSQLiteReadSnapshot({ payload })
  return createOwnerSessions({
    ...options,
    read: ({ work }) =>
      snapshot({ work: ({ find }) => work({ reader: createSessionsReader({ find }) }) }),
  })
}
const selections = {
  'creation-drafts': ['userId', 'sessionId', 'isDeleted', 'description', 'userNotes', 'updatedAt'],
  'creation-sessions': [
    'userId',
    'clientRequestId',
    'templateId',
    'mode',
    'title',
    'titleSource',
    'lastActivityAt',
    'coverArtifactId',
    'nextRoundNo',
    'isDeleted',
    'deletedAt',
    'deletedBy',
  ],
  'draft-inputs': ['userId', 'draftId', 'position', 'mediaId', 'isDeleted'],
  'generation-tasks': ['userId', 'sessionId', 'templateId', 'roundNo', 'status', 'isDeleted'],
} as const
/** Gate all selected fields before opening any snapshot, including the reused draft reader. */
function assertSessionsSchema({ payload }: { payload: Payload }) {
  for (const [slug, names] of Object.entries(selections)) {
    const fields = (
      payload.collections as Record<string, Payload['collections'][keyof Payload['collections']]>
    )[slug]?.config.flattenedFields
    if (
      !fields ||
      names.some((name) => !fields.some((field) => field.name === name)) ||
      !fields.some((field) => field.name === 'isDeleted' && field.type === 'checkbox')
    ) {
      throw new Error(`Session history requires the complete target schema for ${slug}.`)
    }
  }
}
export function createSessionsReader({ find }: { find: SnapshotFind }): SessionsReader {
  // Reused readers must expose complete evidence, never a silently truncated bounded batch.
  const completeFind: SnapshotFind = async (args) => {
    const result = await find(args)
    assertResult({ ...result, isComplete: true, limit: args.limit })
    return result
  }
  const query = async ({
    collection,
    isComplete = true,
    limit,
    sort,
    where,
  }: {
    collection: keyof typeof selections
    isComplete?: boolean
    limit: number
    sort?: string[]
    where: Where
  }) => {
    const result = await find({
      collection,
      limit,
      select: Object.fromEntries(['id', ...selections[collection]].map((field) => [field, true])),
      showHiddenFields: true,
      sort,
      where,
    })
    assertResult({ ...result, isComplete, limit })
    return result.docs
  }
  return Object.freeze({
    draft: createDraftReader({ find: completeFind }),
    inflight: ({ sessionIds }) =>
      sessionIds.length
        ? query({
            collection: 'generation-tasks',
            limit: sessionIds.length * 2,
            // No owner/deletion prefilter: those facts are checked after fetching all evidence.
            where: {
              and: [
                { sessionId: { in: [...sessionIds] } },
                { status: { in: ['queued', 'running', 'unknown'] } },
              ],
            },
          })
        : Promise.resolve([]),
    library: createLibraryReader({ find: completeFind }),
    profiles: ({ ids }) =>
      ids.length
        ? query({
            collection: 'creation-sessions',
            limit: ids.length * 2,
            where: { id: { in: [...ids] } },
          })
        : Promise.resolve([]),
    requestProfiles: ({ clientRequestId, userId }) =>
      query({
        collection: 'creation-sessions',
        limit: 2,
        where: {
          and: [{ userId: { equals: userId } }, { clientRequestId: { equals: clientRequestId } }],
        },
      }),
    scan: ({ after, limit, userId }) => {
      const and: Where[] = [{ userId: { equals: userId } }, { isDeleted: { equals: false } }]
      if (after) {
        and.push({
          or: [
            { lastActivityAt: { less_than: after.time } },
            { and: [{ lastActivityAt: { equals: after.time } }, { id: { less_than: after.id } }] },
          ],
        })
      }
      return query({
        collection: 'creation-sessions',
        isComplete: false,
        limit,
        sort: ['-lastActivityAt', '-id'],
        where: { and },
      })
    },
  })
}
function assertResult({
  docs,
  isComplete,
  limit,
  totalDocs,
}: {
  docs: unknown
  isComplete: boolean
  limit: number
  totalDocs: number
}) {
  if (
    !Array.isArray(docs) ||
    !Number.isSafeInteger(totalDocs) ||
    totalDocs < docs.length ||
    (limit > 0 && docs.length > limit) ||
    (isComplete ? docs.length !== totalDocs : docs.length !== Math.min(totalDocs, limit))
  ) {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
}
