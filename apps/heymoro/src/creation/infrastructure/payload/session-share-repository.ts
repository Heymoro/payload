import type { PayloadRequest } from 'payload'

import { randomBytes, randomUUID } from 'node:crypto'

import type { SessionShare, ShareReader, ShareRepository } from '../../application/session-share.js'
import type { CreationCollectionSlug } from './collections.js'
import type { SnapshotFind } from './read-snapshot.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'

import { assertLibraryActor, projectLibraryArtifacts } from '../../application/owner-library.js'
import { createSessionShares } from '../../application/session-share.js'
import { GenerationError } from '../../domain/generation.js'
import { createLibraryReader } from './owner-library-repository.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'
import { createCreationRuntime } from './session-repository.js'
import { createSQLiteUnitOfWork } from './sqlite-unit-of-work.js'

type ImageReader = Parameters<typeof createSessionShares>[0]['readImage']
export function createPayloadSessionShares({
  clock,
  readImage,
  ...options
}: { clock: () => string; readImage: ImageReader } & SQLiteUnitOfWorkOptions) {
  const read = createSQLiteReadSnapshot(options)
  const write = createSQLiteUnitOfWork(options)
  return createSessionShares({
    clock,
    makeKey: () => randomBytes(24).toString('base64url'),
    read: ({ work }) => read({ work: ({ find }) => work({ repository: reader({ find }) }) }),
    readImage,
    write: ({ resource, work }) =>
      write({ resource, work: ({ req }) => work({ repository: repository({ options, req }) }) }),
  })
}
const shareFields = [
  'id',
  'sessionId',
  'templateId',
  'publicKey',
  'title',
  'artifactIdsJson',
  'status',
  'isDeleted',
]
function reader({ find }: { find: SnapshotFind }): ShareReader {
  const query = async ({
    bounded = false,
    collection,
    limit = 2,
    select,
    sort,
    where,
  }: { bounded?: boolean } & Parameters<SnapshotFind>[0]) => {
    const result = await find({ collection, limit, select, showHiddenFields: true, sort, where })
    if (
      result.docs.length > limit ||
      result.totalDocs < result.docs.length ||
      (!bounded && result.totalDocs !== result.docs.length)
    ) {
      throw integrity()
    }
    return result.docs
  }
  const lookup = async (where: Parameters<SnapshotFind>[0]['where']) =>
    (
      await query({
        collection: 'session-shares',
        limit: 2,
        select: Object.fromEntries(shareFields.map((f) => [f, true])),
        where,
      })
    ).map((row) => share({ row }))
  return {
    admin: async ({ adminId }) => {
      const rows = await query({
        collection: 'admins',
        limit: 2,
        select: { id: true, role: true, status: true },
        where: { id: { equals: adminId } },
      })
      if (rows.length > 1) {
        throw integrity()
      }
      return rows[0]
        ? {
            id: id({ value: rows[0].id }),
            role: string({ value: rows[0].role }),
            status: string({ value: rows[0].status }),
          }
        : null
    },
    byKey: ({ key }) => lookup({ publicKey: { equals: key } }),
    bySession: ({ sessionId }) => lookup({ sessionId: { equals: sessionId } }),
    sessions: async ({ afterId, limit }) =>
      (
        await query({
          bounded: true,
          collection: 'creation-sessions',
          limit,
          select: { id: true, templateId: true, title: true },
          sort: '-id',
          where: {
            and: [
              { isDeleted: { equals: false } },
              ...(afterId === null ? [] : [{ id: { less_than: afterId } }]),
            ],
          },
        })
      ).map((row) => ({
        id: id({ value: row.id }),
        templateId: id({ value: row.templateId }),
        title: string({ value: row.title }),
      })),
    source: async ({ artifactIds, sessionId }) => {
      const sessions = await query({
        collection: 'creation-sessions',
        limit: 2,
        select: { id: true, isDeleted: true, templateId: true, title: true, userId: true },
        where: { id: { equals: sessionId } },
      })
      if (sessions.length > 1) {
        throw integrity()
      }
      const session = sessions[0]
      if (!session || session.isDeleted !== false) {
        throw new GenerationError({ code: 'NOT_FOUND' })
      }
      const userId = id({ value: session.userId })
      const library = createLibraryReader({ find })
      try {
        await assertLibraryActor({ reader: library, userId })
      } catch (error) {
        if (error instanceof GenerationError && error.code === 'UNAUTHENTICATED') {
          throw new GenerationError({ code: 'NOT_FOUND' })
        }
        throw error
      }
      const rows = artifactIds
        ? await library.artifacts({ ids: artifactIds })
        : await query({
            bounded: true,
            collection: 'artifacts',
            limit: 21,
            select: {
              id: true,
              createdAt: true,
              deletedAt: true,
              deletedBy: true,
              isDeleted: true,
              mediaId: true,
              outputIndex: true,
              sessionId: true,
              taskId: true,
              userId: true,
            },
            sort: '-id',
            where: {
              and: [{ sessionId: { equals: sessionId } }, { isDeleted: { equals: false } }],
            },
          })
      let selected = artifactIds
        ? artifactIds.map((artifactId) => {
            const matches = rows.filter((row) => row.id === artifactId)
            if (matches.length !== 1) {
              throw new GenerationError({ code: 'NOT_FOUND' })
            }
            return matches[0]!
          })
        : rows.slice(0, 20).reverse()
      if (
        selected.some(
          (row) => row.sessionId !== sessionId || row.userId !== userId || row.isDeleted !== false,
        )
      ) {
        throw new GenerationError({ code: 'NOT_FOUND' })
      }
      const taskIds = [...new Set(selected.map((row) => id({ value: row.taskId })))]
      const tasks = taskIds.length ? await library.tasks({ ids: taskIds }) : []
      if (tasks.length !== taskIds.length) {
        throw integrity()
      }
      if (artifactIds && tasks.some((task) => task.isDeleted !== false)) {
        throw new GenerationError({ code: 'NOT_FOUND' })
      }
      if (!artifactIds) {
        selected = selected.filter((row) =>
          tasks.some((task) => task.id === row.taskId && task.isDeleted === false),
        )
      }
      const images = await projectLibraryArtifacts({ artifacts: selected, reader: library, userId })
      return {
        id: sessionId,
        images: images.map(({ id, createdAt, height, mediaId, width }) => ({
          id,
          createdAt,
          height,
          mediaId,
          width,
        })),
        templateId: id({ value: session.templateId }),
        title: string({ value: session.title }),
        userId,
      }
    },
  }
}
function repository({
  options,
  req,
}: {
  options: Pick<SQLiteUnitOfWorkOptions, 'gate' | 'payload'>
  req: PayloadRequest
}): ShareRepository {
  const runtime = createCreationRuntime(options)
  const find: SnapshotFind = (args) =>
    runtime.find({
      ...args,
      collection: args.collection as
        | 'admins'
        | 'auditLogs'
        | 'media'
        | 'users'
        | CreationCollectionSlug,
      req,
    })
  const audit = ({ actor, now }: { actor: string; now: string }) => ({
    createdAt: now,
    createdBy: actor,
    deletedAt: null,
    deletedBy: null,
    isDeleted: false,
    updatedAt: now,
    updatedBy: actor,
  })
  return {
    ...reader({ find }),
    audit: async ({ adminId, after, before, now }) => {
      const state = (value: null | SessionShare) =>
        value
          ? { artifactCount: JSON.parse(value.artifactIdsJson).length, status: value.status }
          : null
      const requestId = randomUUID()
      await runtime.create({
        collection: 'auditLogs',
        data: {
          ...audit({ actor: `admin:${adminId}`, now }),
          action: after.status === 'published' ? 'session.share.publish' : 'session.share.revoke',
          actorId: String(adminId),
          actorType: 'admin',
          afterState: state(after),
          beforeState: state(before),
          correlationId: requestId,
          requestId,
          resourceId: String(after.sessionId),
          resourceType: 'session-share',
          result: 'success',
          summary: {
            artifactCount: JSON.parse(after.artifactIdsJson).length,
            sessionId: after.sessionId,
          },
        },
        req,
      })
    },
    save: async ({ actor, before, data, now }) =>
      share({
        row: before
          ? await runtime.update({
              id: before.id,
              collection: 'session-shares',
              data: { ...data, updatedAt: now, updatedBy: actor },
              req,
            })
          : await runtime.create({
              collection: 'session-shares',
              data: { ...audit({ actor, now }), ...data },
              req,
            }),
      }),
  }
}
function share({ row }: { row: Record<string, unknown> }): SessionShare {
  if (
    typeof row.isDeleted !== 'boolean' ||
    !['published', 'revoked'].includes(String(row.status))
  ) {
    throw integrity()
  }
  return {
    id: id({ value: row.id }),
    artifactIdsJson: string({ value: row.artifactIdsJson }),
    isDeleted: row.isDeleted,
    publicKey: string({ value: row.publicKey }),
    sessionId: id({ value: row.sessionId }),
    status: row.status as SessionShare['status'],
    templateId: id({ value: row.templateId }),
    title: string({ value: row.title }),
  }
}
function id({ value }: { value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw integrity()
  }
  return value
}
function string({ value }: { value: unknown }): string {
  if (typeof value !== 'string') {
    throw integrity()
  }
  return value
}
function integrity() {
  return new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
}
