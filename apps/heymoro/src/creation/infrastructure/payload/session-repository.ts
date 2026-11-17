import type { Payload, PayloadRequest, Where } from 'payload'

import type {
  EmptyDraftRecord,
  SessionAudit,
  SessionCreationDependencies,
  SessionCreationRepository,
  SessionRecord,
} from '../../application/session.js'
import type { CreationCollectionSlug } from './collections.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'
import type { CreationWriteGate } from './write-gate.js'

import { createSessionCreator } from '../../application/session.js'
import { creationCollectionSlugs } from './collections.js'
import { createSQLiteUnitOfWork } from './sqlite-unit-of-work.js'

type RuntimeDocument = Record<string, unknown>
type FindArguments = {
  collection: 'admins' | 'auditLogs' | 'media' | 'users' | CreationCollectionSlug
  limit: number
  req: PayloadRequest
  select?: Record<string, boolean>
  showHiddenFields?: true
  sort?: string | string[]
  where?: Where
}
type CreateArguments = {
  collection: 'auditLogs' | 'media' | CreationCollectionSlug
  data: RuntimeDocument
  req: PayloadRequest
}
type UpdateArguments = { id: number } & CreateArguments
type RuntimeUpdateArguments = ({ where: Where } & CreateArguments) | UpdateArguments
type RuntimeLocalAPI = {
  collections: Record<string, Payload['collections'][keyof Payload['collections']]>
  create: (args: { depth: 0; overrideAccess: true } & CreateArguments) => Promise<unknown>
  find: (
    args: { depth: 0; overrideAccess: true; pagination: false } & FindArguments,
  ) => Promise<unknown>
  update: (
    args: {
      depth: 0
      overrideAccess: true
    } & RuntimeUpdateArguments,
  ) => Promise<unknown>
}

export function createPayloadSessionCreator({
  clock,
  hostCaps,
  isCompatible,
  ...options
}: Pick<SessionCreationDependencies, 'clock' | 'hostCaps' | 'isCompatible'> &
  SQLiteUnitOfWorkOptions) {
  const userFields = options.payload.collections.users?.config.flattenedFields
  if (
    !userFields?.some((field) => field.name === 'status') ||
    !userFields.some((field) => field.name === 'isDeleted' && field.type === 'checkbox')
  ) {
    throw new Error(
      'Creation sessions require users status and an isDeleted checkbox in the target schema.',
    )
  }
  const run = createSQLiteUnitOfWork(options)
  return createSessionCreator({
    clock,
    hostCaps,
    isCompatible,
    runCoordinatedTransaction: ({ resource, work }) =>
      run({
        resource,
        work: ({ req }) =>
          work({
            repository: createPayloadSessionRepository({
              gate: options.gate,
              payload: options.payload,
              req,
            }),
          }),
      }),
  })
}

export function createPayloadSessionRepository({
  gate,
  payload,
  req,
}: {
  gate: CreationWriteGate
  payload: Payload
  req: PayloadRequest
}): SessionCreationRepository {
  const runtime = createCreationRuntime({ gate, payload })
  let isRunning = false
  const serial = async <T>({ work }: { work: () => Promise<T> }): Promise<T> => {
    // Reject sealed entry before the operation-failure path; a late caller must not abort commit.
    gate.assert({ req })
    try {
      if (isRunning) {
        throw new Error('Concurrent creation repository operations are forbidden.')
      }
      isRunning = true
      const result = await work()
      gate.assert({ req })
      return result
    } catch (error) {
      gate.abort({ req })
      throw error
    } finally {
      isRunning = false
    }
  }
  const find = (args: Omit<FindArguments, 'req'>) => runtime.find({ ...args, req })

  return Object.freeze({
    findSessionsByRequest: ({ clientRequestId, userId }) =>
      serial({
        work: async () => {
          const { docs } = await find({
            collection: 'creation-sessions',
            limit: 2,
            where: {
              and: [
                { userId: { equals: userId } },
                { clientRequestId: { equals: clientRequestId } },
              ],
            },
          })
          return docs.map((doc) => sessionRecord({ doc }))
        },
      }),
    insertEmptyDraft: ({ draft }) =>
      serial({
        work: async () =>
          draftRecord({
            doc: await runtime.create({ collection: 'creation-drafts', data: { ...draft }, req }),
          }),
      }),
    insertSession: ({ session }) =>
      serial({
        work: async () =>
          sessionRecord({
            doc: await runtime.create({
              collection: 'creation-sessions',
              data: { ...session },
              req,
            }),
          }),
      }),
    isAccountActive: ({ userId }) =>
      serial({
        work: async () => {
          const { docs } = await find({
            collection: 'users',
            limit: 2,
            where: { id: { equals: userId } },
          })
          return docs.length === 1 && docs[0]!.status === 'active' && docs[0]!.isDeleted === false
        },
      }),
    readTemplate: ({ templateId }) =>
      serial({
        work: async () => {
          const { docs } = await find({
            collection: 'creation-templates',
            limit: 2,
            select: {
              id: true,
              displayConfigJson: true,
              inputSchemaJson: true,
              isDeleted: true,
              kind: true,
              minClientCapability: true,
              schemaVersion: true,
              status: true,
            },
            where: { id: { equals: templateId } },
          })
          if (docs.length > 1) {
            throw new Error('Multiple template primary keys were returned.')
          }
          const doc = docs[0]
          return doc
            ? {
                id: integer({ value: doc.id }),
                displayConfigJson: string({ value: doc.displayConfigJson }),
                inputSchemaJson: string({ value: doc.inputSchemaJson }),
                isDeleted: boolean({ value: doc.isDeleted }),
                kind: choice({ options: ['effect', 'free'], value: doc.kind }),
                minClientCapability: string({ value: doc.minClientCapability }),
                schemaVersion: integer({ value: doc.schemaVersion }),
                status: string({ value: doc.status }),
              }
            : null
        },
      }),
  })
}

/** Single generated-types boundary: verify actual slugs/hooks, accept unknown, strictly map every returned domain field. */
export function createCreationRuntime({
  gate,
  payload,
}: {
  gate: CreationWriteGate
  payload: Payload
}) {
  const local = payload as unknown as RuntimeLocalAPI
  for (const slug of creationCollectionSlugs) {
    if (!local.collections[slug]?.config.hooks.beforeOperation?.includes(gate.beforeOperation)) {
      throw new Error(`Creation collection ${slug} is not registered with this write gate.`)
    }
  }
  if (
    local.collections.media &&
    !local.collections.media.config.hooks.beforeOperation?.includes(gate.beforeOperation)
  ) {
    throw new Error('Creation media is not registered with this write gate.')
  }
  if (!local.collections.users?.config.flattenedFields.some((field) => field.name === 'status')) {
    throw new Error('Creation requires the existing users status field.')
  }
  return Object.freeze({
    create: (args: CreateArguments) =>
      gate.run({
        req: args.req,
        work: async () =>
          record({ value: await local.create({ ...args, depth: 0, overrideAccess: true }) }),
      }),
    find: (args: FindArguments) =>
      gate.run({
        req: args.req,
        work: async () => {
          const result = record({
            value: await local.find({ ...args, depth: 0, overrideAccess: true, pagination: false }),
          })
          if (!Array.isArray(result.docs)) {
            throw new Error('Payload returned invalid documents.')
          }
          return {
            docs: result.docs.map((value) => record({ value })),
            totalDocs: integer({ minimum: 0, value: result.totalDocs }),
          }
        },
      }),
    update: (args: UpdateArguments) =>
      gate.run({
        req: args.req,
        work: async () =>
          record({ value: await local.update({ ...args, depth: 0, overrideAccess: true }) }),
      }),
    updateExpected: ({ id, expected, ...args }: { expected: Where } & UpdateArguments) =>
      gate.run({
        req: args.req,
        work: async () => {
          const result = record({
            value: await local.update({
              ...args,
              depth: 0,
              overrideAccess: true,
              where: { and: [{ id: { equals: id } }, expected] },
            }),
          })
          if (
            !Array.isArray(result.docs) ||
            result.docs.length !== 1 ||
            (Array.isArray(result.errors) && result.errors.length !== 0)
          ) {
            gate.abort({ req: args.req })
            throw new Error('Expected exactly one conditional creation update.')
          }
          const doc = record({ value: result.docs[0] })
          if (doc.id !== id) {
            gate.abort({ req: args.req })
            throw new Error('Conditional creation identity mismatch.')
          }
          return doc
        },
      }),
  })
}

function sessionRecord({ doc }: { doc: RuntimeDocument }): SessionRecord {
  return {
    ...auditRecord({ doc }),
    id: integer({ value: doc.id }),
    autoNamedAt: nullableDate({ value: doc.autoNamedAt }),
    autoNameStartedAt: nullableDate({ value: doc.autoNameStartedAt }),
    autoNameStatus: choice({
      options: ['idle', 'pending', 'sending', 'succeeded', 'failed', 'unknown', 'skipped'],
      value: doc.autoNameStatus,
    }),
    clientRequestId: string({ value: doc.clientRequestId }),
    coverArtifactId: nullableInteger({ value: doc.coverArtifactId }),
    lastActivityAt: date({ value: doc.lastActivityAt }),
    mode: choice({ options: ['effect', 'free'], value: doc.mode }),
    nextRoundNo: integer({ value: doc.nextRoundNo }),
    requestHash: string({ value: doc.requestHash }),
    templateId: integer({ value: doc.templateId }),
    title: string({ value: doc.title }),
    titleSource: choice({ options: ['template', 'ai', 'user'], value: doc.titleSource }),
    userId: integer({ value: doc.userId }),
  }
}
function draftRecord({ doc }: { doc: RuntimeDocument }): EmptyDraftRecord {
  return {
    ...auditRecord({ doc }),
    id: integer({ value: doc.id }),
    description: string({ value: doc.description }),
    sessionId: integer({ value: doc.sessionId }),
    userId: integer({ value: doc.userId }),
    userNotes: string({ value: doc.userNotes }),
  }
}
function auditRecord({ doc }: { doc: RuntimeDocument }): SessionAudit {
  return {
    createdAt: date({ value: doc.createdAt }),
    createdBy: string({ value: doc.createdBy }),
    deletedAt: nullableDate({ value: doc.deletedAt }),
    deletedBy: doc.deletedBy == null ? null : string({ value: doc.deletedBy }),
    isDeleted: boolean({ value: doc.isDeleted }),
    updatedAt: date({ value: doc.updatedAt }),
    updatedBy: string({ value: doc.updatedBy }),
  }
}
function record({ value }: { value: unknown }): RuntimeDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Payload returned an invalid record.')
  }
  return value as RuntimeDocument
}
function integer({ minimum = 1, value }: { minimum?: number; value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error('Payload returned an invalid integer.')
  }
  return value
}
function nullableInteger({ value }: { value: unknown }): null | number {
  return value == null ? null : integer({ value })
}
function string({ value }: { value: unknown }): string {
  if (typeof value !== 'string') {
    throw new Error('Payload returned an invalid string.')
  }
  return value
}
function boolean({ value }: { value: unknown }): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('Payload returned an invalid boolean.')
  }
  return value
}
function date({ value }: { value: unknown }): string {
  const result = string({ value })
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new Error('Payload returned an invalid UTC timestamp.')
  }
  return result
}
function nullableDate({ value }: { value: unknown }): null | string {
  return value == null ? null : date({ value })
}
function choice<const T extends string>({
  options,
  value,
}: {
  options: readonly T[]
  value: unknown
}): T {
  const result = string({ value })
  const match = options.find((option) => option === result)
  if (match === undefined) {
    throw new Error('Payload returned an invalid enum value.')
  }
  return match
}
