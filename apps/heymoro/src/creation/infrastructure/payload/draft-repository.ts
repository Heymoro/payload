import type {
  DraftDependencies,
  DraftReader,
  DraftRepository,
  DraftSlot,
} from '../../application/draft.js'
import type { SnapshotFind } from './read-snapshot.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'

import { createDraftService, DraftError } from '../../application/draft.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'
import { createCreationRuntime } from './session-repository.js'
import { createSQLiteUnitOfWork } from './sqlite-unit-of-work.js'

export function createPayloadDraftService({
  clock,
  hostCaps,
  ...options
}: Pick<DraftDependencies, 'clock' | 'hostCaps'> & SQLiteUnitOfWorkOptions) {
  const userFields = options.payload.collections.users?.config.flattenedFields
  if (
    !userFields?.some((field) => field.name === 'status') ||
    !userFields.some((field) => field.name === 'isDeleted' && field.type === 'checkbox')
  ) {
    throw new Error(
      'Creation drafts require users status and an isDeleted checkbox in the target schema.',
    )
  }
  const runtime = createCreationRuntime({ gate: options.gate, payload: options.payload })
  if (!options.payload.collections.media) {
    throw new Error('Creation requires the extended existing media collection.')
  }
  const write = createSQLiteUnitOfWork(options)
  const read = createSQLiteReadSnapshot({ payload: options.payload })
  return createDraftService({
    clock,
    hostCaps,
    read: ({ work }) =>
      read({ work: ({ find }) => work({ repository: createDraftReader({ find }) }) }),
    write: ({ resource, work }) =>
      write({
        resource,
        work: ({ req }) => {
          const find: SnapshotFind = (args) =>
            runtime.find({
              ...args,
              collection: args.collection as Parameters<typeof runtime.find>[0]['collection'],
              req,
            })
          const repository: DraftRepository = {
            ...createDraftReader({ find }),
            readMedia: async ({ mediaId }) => {
              const doc = await single({
                id: mediaId,
                collection: 'media',
                fields: [
                  'owner',
                  'isDeleted',
                  'lifecycle',
                  'visibility',
                  'purpose',
                  'mimeType',
                  'filesize',
                ],
                find,
              })
              return doc
                ? {
                    id: integer({ value: doc.id }),
                    filesize: doc.filesize == null ? null : numeric({ value: doc.filesize }),
                    isDeleted: boolean({ value: doc.isDeleted }),
                    lifecycle: string({ value: doc.lifecycle }),
                    mimeType: doc.mimeType == null ? null : string({ value: doc.mimeType }),
                    owner: doc.owner == null ? null : integer({ value: doc.owner }),
                    purpose: string({ value: doc.purpose }),
                    visibility: string({ value: doc.visibility }),
                  }
                : null
            },
            replace: async ({ actor, draft, input, now, session, slots }) => {
              const common = { updatedAt: now, updatedBy: actor }
              const result = await runtime.update({
                id: draft.id,
                collection: 'creation-drafts',
                data: { ...common, description: input.description, userNotes: input.userNotes },
                req,
              })
              const positions = new Map(slots.map((slot) => [slot.position, slot]))
              for (let index = 0; index < input.inputMediaIds.length; index++) {
                const position = index + 1
                const slot = positions.get(position)
                const data = {
                  ...common,
                  deletedAt: null,
                  deletedBy: null,
                  draftId: draft.id,
                  isDeleted: false,
                  mediaId: input.inputMediaIds[index]!,
                  position,
                  userId: session.userId,
                }
                if (slot) {
                  await runtime.update({ id: slot.id, collection: 'draft-inputs', data, req })
                } else {
                  await runtime.create({
                    collection: 'draft-inputs',
                    data: { ...data, createdAt: now, createdBy: actor },
                    req,
                  })
                }
              }
              for (const slot of slots) {
                if (!slot.isDeleted && slot.position > input.inputMediaIds.length) {
                  await runtime.update({
                    id: slot.id,
                    collection: 'draft-inputs',
                    data: { ...common, deletedAt: now, deletedBy: actor, isDeleted: true },
                    req,
                  })
                }
              }
              await runtime.update({
                id: session.id,
                collection: 'creation-sessions',
                data: { ...common, lastActivityAt: now },
                req,
              })
              return date({ value: result.updatedAt })
            },
          }
          return work({ repository })
        },
      }),
  })
}

export function createDraftReader({ find }: { find: SnapshotFind }): DraftReader {
  return Object.freeze({
    findDrafts: async ({ sessionId }) => {
      const { docs } = await find({
        collection: 'creation-drafts',
        limit: 2,
        select: select({
          fields: ['userId', 'sessionId', 'isDeleted', 'description', 'userNotes', 'updatedAt'],
        }),
        where: { sessionId: { equals: sessionId } },
      })
      return docs.map((doc) => ({
        id: integer({ value: doc.id }),
        description: string({ value: doc.description }),
        isDeleted: boolean({ value: doc.isDeleted }),
        sessionId: integer({ value: doc.sessionId }),
        updatedAt: date({ value: doc.updatedAt }),
        userId: integer({ value: doc.userId }),
        userNotes: string({ value: doc.userNotes }),
      }))
    },
    findSlots: async ({ draftId }) => {
      // limit:0 explicitly requests all history slots; never silently truncate a draft on restore.
      const { docs, totalDocs } = await find({
        collection: 'draft-inputs',
        limit: 0,
        select: select({ fields: ['userId', 'draftId', 'position', 'mediaId', 'isDeleted'] }),
        sort: 'position',
        where: { draftId: { equals: draftId } },
      })
      if (docs.length !== totalDocs) {
        throw conflict()
      }
      return docs.map((doc): DraftSlot => ({
        id: integer({ value: doc.id }),
        draftId: integer({ value: doc.draftId }),
        isDeleted: boolean({ value: doc.isDeleted }),
        mediaId: integer({ value: doc.mediaId }),
        position: integer({ value: doc.position }),
        userId: integer({ value: doc.userId }),
      }))
    },
    isAccountActive: async ({ userId }) => {
      const doc = await single({
        id: userId,
        collection: 'users',
        fields: ['status', 'isDeleted'],
        find,
      })
      return doc !== null && doc.status === 'active' && doc.isDeleted === false
    },
    readSession: async ({ sessionId }) => {
      const doc = await single({
        id: sessionId,
        collection: 'creation-sessions',
        fields: ['userId', 'isDeleted', 'templateId', 'mode'],
        find,
      })
      return doc
        ? {
            id: integer({ value: doc.id }),
            isDeleted: boolean({ value: doc.isDeleted }),
            mode: mode({ value: doc.mode }),
            templateId: integer({ value: doc.templateId }),
            userId: integer({ value: doc.userId }),
          }
        : null
    },
  })
}
async function single({
  id,
  collection,
  fields,
  find,
}: {
  collection: string
  fields: string[]
  find: SnapshotFind
  id: number
}) {
  const { docs } = await find({
    collection,
    limit: 2,
    select: select({ fields }),
    where: { id: { equals: id } },
  })
  if (docs.length > 1) {
    throw conflict()
  }
  return docs[0] ?? null
}
function select({ fields }: { fields: string[] }) {
  return Object.fromEntries(['id', ...fields].map((field) => [field, true]))
}
function conflict() {
  return new DraftError({ code: 'DATA_INTEGRITY_CONFLICT' })
}
function integer({ value }: { value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw conflict()
  }
  return value
}
function numeric({ value }: { value: unknown }): number {
  if (typeof value !== 'number') {
    throw conflict()
  }
  return value
}
function string({ value }: { value: unknown }): string {
  if (typeof value !== 'string') {
    throw conflict()
  }
  return value
}
function boolean({ value }: { value: unknown }): boolean {
  if (typeof value !== 'boolean') {
    throw conflict()
  }
  return value
}
function date({ value }: { value: unknown }): string {
  const result = string({ value })
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw conflict()
  }
  return result
}
function mode({ value }: { value: unknown }): 'effect' | 'free' {
  if (value !== 'effect' && value !== 'free') {
    throw conflict()
  }
  return value
}
