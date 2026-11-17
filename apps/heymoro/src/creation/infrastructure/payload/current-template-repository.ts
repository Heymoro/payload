import type { CollectionConfig, PayloadRequest, Where } from 'payload'

import { randomUUID } from 'node:crypto'

import type {
  CurrentTemplateOptions,
  CurrentTemplateReader,
  CurrentTemplateRecord,
  CurrentTemplateRepository,
} from '../../application/current-template.js'
import type { SnapshotFind } from './read-snapshot.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'

import { createCurrentTemplates } from '../../application/current-template.js'
import { TemplatePublicationError } from '../../domain/template-publication.js'
import { createPayloadMediaReader } from './media-repository.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'
import { createSQLiteUnitOfWork } from './sqlite-unit-of-work.js'

type RuntimeLocalAPI = {
  collections: Record<string, { config: CollectionConfig }>
  create: (args: {
    collection: 'auditLogs' | 'creation-templates'
    data: Record<string, unknown>
    depth: 0
    overrideAccess: true
    req: PayloadRequest
  }) => Promise<unknown>
  find: (
    args: {
      depth: 0
      overrideAccess: true
      pagination: false
      req: PayloadRequest
    } & Parameters<SnapshotFind>[0],
  ) => Promise<{ docs: unknown[]; totalDocs: number }>
  update: (args: {
    collection: 'creation-templates'
    data: Record<string, unknown>
    depth: 0
    overrideAccess: true
    req: PayloadRequest
    where: Where
  }) => Promise<{ docs: unknown[]; errors: unknown[] }>
}

const bodyFields = [
  'costCredits',
  'displayConfigJson',
  'generationConfigJson',
  'inputSchemaJson',
  'minClientCapability',
  'schemaVersion',
  'shareConfigJson',
] as const
const selected = Object.fromEntries(
  ['id', 'code', 'isDeleted', 'kind', 'name', 'status', ...bodyFields].map((name) => [name, true]),
)

export function createPayloadCurrentTemplates({
  acceptedCapabilities,
  clock,
  execution,
  hostCaps,
  maxExampleMedia,
  ...options
}: { clock: () => string } & CurrentTemplateOptions & SQLiteUnitOfWorkOptions) {
  const local = options.payload as unknown as RuntimeLocalAPI
  for (const slug of ['creation-templates', 'taxonomy-terms', 'media', 'auditLogs']) {
    if (
      !local.collections[slug]?.config.hooks?.beforeOperation?.includes(
        options.gate.beforeOperation,
      )
    ) {
      throw new Error(`Current template collection ${slug} requires its write gate.`)
    }
  }
  const read = createSQLiteReadSnapshot(options)
  const write = createSQLiteUnitOfWork(options)
  return createCurrentTemplates({
    acceptedCapabilities,
    clock,
    execution,
    hostCaps,
    maxExampleMedia,
    read: ({ work }) => read({ work: ({ find }) => work({ repository: reader({ find }) }) }),
    write: ({ resource, work }) =>
      write({ resource, work: ({ req }) => work({ repository: repository({ options, req }) }) }),
  })
}

function reader({ find }: { find: SnapshotFind }): CurrentTemplateReader {
  const rows = async ({
    collection,
    limit = 2,
    select,
    where,
  }: {
    collection: string
    limit?: number
    select: Record<string, boolean>
    where: Where
  }) => {
    const result = await find({
      collection,
      limit,
      select,
      showHiddenFields: true,
      sort: 'id',
      where,
    })
    if (result.docs.length > limit || result.docs.length !== result.totalDocs) {
      throw integrity()
    }
    return result.docs
  }
  const one = async (args: Parameters<typeof rows>[0]) => {
    const found = await rows(args)
    if (found.length > 1) {
      throw integrity()
    }
    return found[0] ?? null
  }
  const media = createPayloadMediaReader({ find })
  return {
    findByCode: async ({ code }) =>
      (
        await rows({
          collection: 'creation-templates',
          select: selected,
          where: { code: { equals: code } },
        })
      ).map((row) => template({ row })),
    list: async ({ afterId, keyword, limit, status }) =>
      (
        await rows({
          collection: 'creation-templates',
          limit,
          select: selected,
          where: {
            and: [
              { isDeleted: { equals: false } },
              ...(afterId === null ? [] : [{ id: { greater_than: afterId } }]),
              ...(status === null ? [] : [{ status: { equals: status } }]),
              ...(keyword === ''
                ? []
                : [{ or: [{ code: { contains: keyword } }, { name: { contains: keyword } }] }]),
            ],
          },
        })
      ).map((row) => template({ row })),
    readAdmin: async ({ adminId }) => {
      const row = await one({
        collection: 'admins',
        select: { id: true, role: true, status: true },
        where: { id: { equals: adminId } },
      })
      return row
        ? {
            id: readNumber({ value: row.id }),
            role: readString({ value: row.role }),
            status: readString({ value: row.status }),
          }
        : null
    },
    readMedia: media.readMedia,
    readShowcase: async ({ key }) => {
      const row = await one({
        collection: 'session-shares',
        select: { id: true, isDeleted: true, status: true, templateId: true },
        where: { publicKey: { equals: key } },
      })
      return row
        ? {
            isDeleted: readBoolean({ value: row.isDeleted }),
            status: readString({ value: row.status }),
            templateId: readNumber({ value: row.templateId }),
          }
        : null
    },
    readTemplate: async ({ templateId }) => {
      const row = await one({
        collection: 'creation-templates',
        select: selected,
        where: { id: { equals: templateId } },
      })
      return row ? template({ row }) : null
    },
    readTerm: async ({ termId }) => {
      const row = await one({
        collection: 'taxonomy-terms',
        select: { id: true, name: true, isDeleted: true, kind: true, status: true },
        where: { id: { equals: termId } },
      })
      return row
        ? {
            id: readNumber({ value: row.id }),
            name: readString({ value: row.name }),
            isDeleted: readBoolean({ value: row.isDeleted }),
            kind: readString({ value: row.kind }),
            status: readString({ value: row.status }),
          }
        : null
    },
  }
}
function repository({
  options,
  req,
}: {
  options: Pick<SQLiteUnitOfWorkOptions, 'gate' | 'payload'>
  req: PayloadRequest
}): CurrentTemplateRepository {
  const { gate } = options
  const payload = options.payload as unknown as RuntimeLocalAPI
  const find: SnapshotFind = (args) =>
    gate.run({
      req,
      work: async () => {
        const result = await payload.find({
          ...args,
          collection: args.collection,
          depth: 0,
          overrideAccess: true,
          pagination: false,
          req,
        })
        return {
          docs: result.docs.map((value) => record({ value })),
          totalDocs: result.totalDocs,
        }
      },
    })
  const runtime = {
    create: ({
      collection,
      data,
    }: {
      collection: 'auditLogs' | 'creation-templates'
      data: Record<string, unknown>
      req: PayloadRequest
    }) =>
      gate.run({
        req,
        work: async () =>
          record({
            value: await payload.create({
              collection,
              data,
              depth: 0,
              overrideAccess: true,
              req,
            }),
          }),
      }),
    updateExpected: ({
      id,
      data,
      expected,
    }: {
      collection: 'creation-templates'
      data: Record<string, unknown>
      expected: Where
      id: number
      req: PayloadRequest
    }) =>
      gate.run({
        req,
        work: async () => {
          const result = await payload.update({
            collection: 'creation-templates',
            data,
            depth: 0,
            overrideAccess: true,
            req,
            where: { and: [{ id: { equals: id } }, expected] },
          })
          if (
            result.docs.length !== 1 ||
            record({ value: result.docs[0] }).id !== id ||
            result.errors.length
          ) {
            gate.abort({ req })
            throw integrity()
          }
          return record({ value: result.docs[0] })
        },
      }),
  }
  return {
    ...reader({ find }),
    appendAudit: async ({ adminId, after, before, now }) => {
      const requestId = randomUUID()
      const state = (row: CurrentTemplateRecord | null) =>
        row
          ? { id: row.id, name: row.name, costCredits: row.costCredits, status: row.status }
          : null
      await runtime.create({
        collection: 'auditLogs',
        data: {
          ...audit({ actor: `admin:${adminId}`, now }),
          action:
            before === null
              ? 'template.create'
              : before.status === after.status
                ? 'template.update'
                : `template.${after.status === 'published' ? 'publish' : 'offline'}`,
          actorId: String(adminId),
          actorType: 'admin',
          afterState: state(after),
          beforeState: state(before),
          correlationId: requestId,
          requestId,
          resourceId: String(after.id),
          resourceType: 'creation-template',
          result: 'success',
          summary: { code: after.code, status: after.status },
        },
        req,
      })
    },
    insert: async ({ name, actor, body, code, kind, now }) =>
      template({
        row: await runtime.create({
          collection: 'creation-templates',
          data: {
            ...audit({ actor, now }),
            ...body,
            name,
            code,
            kind,
            primaryCategoryId: JSON.parse(body.displayConfigJson).categoryId ?? null,
            sortOrder: 0,
            status: 'offline',
          },
          req,
        }),
      }),
    update: async ({ name, actor, before, body, now, status }) =>
      template({
        row: await runtime.updateExpected({
          id: before.id,
          collection: 'creation-templates',
          data: {
            ...(body ?? {}),
            ...(name === undefined ? {} : { name }),
            ...(body
              ? { primaryCategoryId: JSON.parse(body.displayConfigJson).categoryId ?? null }
              : {}),
            ...(status === undefined ? {} : { status }),
            updatedAt: now,
            updatedBy: actor,
          },
          expected: {
            and: [
              { code: { equals: before.code } },
              { kind: { equals: before.kind } },
              { isDeleted: { equals: false } },
            ],
          },
          req,
        }),
      }),
  }
}
function record({ value }: { value: unknown }): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw integrity()
  }
  return value as Record<string, unknown>
}
function template({ row }: { row: Record<string, unknown> }): CurrentTemplateRecord {
  if (
    !['effect', 'free'].includes(String(row.kind)) ||
    !['offline', 'published'].includes(String(row.status))
  ) {
    throw integrity()
  }
  return {
    id: readNumber({ value: row.id }),
    name: readString({ value: row.name }),
    code: readString({ value: row.code }),
    costCredits: readNumber({ minimum: 0, value: row.costCredits }),
    displayConfigJson: readString({ value: row.displayConfigJson }),
    generationConfigJson: readString({ value: row.generationConfigJson }),
    inputSchemaJson: readString({ value: row.inputSchemaJson }),
    isDeleted: readBoolean({ value: row.isDeleted }),
    kind: row.kind as CurrentTemplateRecord['kind'],
    minClientCapability: readString({ value: row.minClientCapability }),
    schemaVersion: readNumber({ value: row.schemaVersion }),
    shareConfigJson: readString({ value: row.shareConfigJson }),
    status: row.status as CurrentTemplateRecord['status'],
  }
}
function readNumber({ minimum = 1, value }: { minimum?: number; value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw integrity()
  }
  return value
}
function readString({ value }: { value: unknown }): string {
  if (typeof value !== 'string') {
    throw integrity()
  }
  return value
}
function readBoolean({ value }: { value: unknown }): boolean {
  if (typeof value !== 'boolean') {
    throw integrity()
  }
  return value
}
function integrity() {
  return new TemplatePublicationError('DATA_INTEGRITY_CONFLICT')
}
function audit({ actor, now }: { actor: string; now: string }) {
  return {
    createdAt: now,
    createdBy: actor,
    deletedAt: null,
    deletedBy: null,
    isDeleted: false,
    updatedAt: now,
    updatedBy: actor,
  }
}
