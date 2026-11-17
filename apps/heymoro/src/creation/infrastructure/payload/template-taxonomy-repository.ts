import type { PayloadRequest, Where } from 'payload'

import { randomUUID } from 'node:crypto'

import type {
  TaxonomyFact,
  TaxonomyReader,
  TaxonomyRepository,
} from '../../application/template-taxonomy.js'
import type { SnapshotFind } from './read-snapshot.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'

import { createTemplateTaxonomy } from '../../application/template-taxonomy.js'
import { TemplatePublicationError } from '../../domain/template-publication.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'
import { createCreationRuntime } from './session-repository.js'
import { createSQLiteUnitOfWork } from './sqlite-unit-of-work.js'

export function createPayloadTemplateTaxonomy({
  clock,
  ...options
}: { clock: () => string } & SQLiteUnitOfWorkOptions) {
  const runtime = createCreationRuntime(options)
  const read = createSQLiteReadSnapshot(options)
  const write = createSQLiteUnitOfWork(options)
  return createTemplateTaxonomy({
    clock,
    read: ({ work }) => read({ work: ({ find }) => work({ repository: reader({ find }) }) }),
    write: ({ resource, work }) =>
      write({
        resource,
        work: ({ req }) => work({ repository: repository({ req, runtime }) }),
      }),
  })
}
function reader({ find }: { find: SnapshotFind }): TaxonomyReader {
  const rows = async ({ limit, where }: { limit: number; where: Where }) => {
    const result = await find({
      collection: 'taxonomy-terms',
      limit,
      select,
      showHiddenFields: true,
      sort: 'id',
      where,
    })
    if (result.docs.length > limit || result.totalDocs !== result.docs.length) {
      integrity()
    }
    return result.docs.map((row) => term({ row }))
  }
  return Object.freeze({
    findTermsByKey: ({ code, kind }) =>
      rows({ limit: 2, where: { and: [{ code: { equals: code } }, { kind: { equals: kind } }] } }),
    listTerms: ({ afterId, keyword, kind, limit, status }) =>
      rows({
        limit,
        where: {
          and: [
            { isDeleted: { equals: false } },
            ...(afterId === null ? [] : [{ id: { greater_than: afterId } }]),
            ...(kind === null ? [] : [{ kind: { equals: kind } }]),
            ...(status === null ? [] : [{ status: { equals: status } }]),
            ...(keyword === ''
              ? []
              : [{ or: [{ name: { contains: keyword } }, { code: { contains: keyword } }] }]),
          ],
        },
      }),
    readAdmin: async ({ adminId }) => {
      const result = await find({
        collection: 'admins',
        limit: 2,
        select: { id: true, role: true, status: true },
        showHiddenFields: true,
        where: { id: { equals: adminId } },
      })
      if (result.docs.length > 1) {
        integrity()
      }
      const row = result.docs[0]
      if (!row) {
        return null
      }
      if (
        typeof row.id !== 'number' ||
        !Number.isSafeInteger(row.id) ||
        row.id < 1 ||
        typeof row.role !== 'string' ||
        typeof row.status !== 'string'
      ) {
        integrity()
      }
      return { id: row.id, role: row.role, status: row.status }
    },
    readTerm: async ({ termId }) => {
      const found = await rows({ limit: 2, where: { id: { equals: termId } } })
      if (found.length > 1) {
        integrity()
      }
      return found[0] ?? null
    },
  })
}
function repository({
  req,
  runtime,
}: {
  req: PayloadRequest
  runtime: ReturnType<typeof createCreationRuntime>
}): TaxonomyRepository {
  const find: SnapshotFind = (args) =>
    runtime.find({
      ...args,
      collection: args.collection as Parameters<typeof runtime.find>[0]['collection'],
      req,
    })
  return Object.freeze({
    ...reader({ find }),
    appendAudit: async ({ adminId, after, before, now }) => {
      const requestId = randomUUID()
      await runtime.create({
        collection: 'auditLogs',
        data: {
          ...audit({ actor: `admin:${adminId}`, now }),
          action: before === null ? 'taxonomy.create' : 'taxonomy.update',
          actorId: String(adminId),
          actorType: 'admin',
          afterState: after,
          beforeState: before,
          correlationId: requestId,
          requestId,
          resourceId: String(after.id),
          resourceType: 'taxonomy-term',
          result: 'success',
          summary: after,
        },
        req,
      })
    },
    insertTerm: async ({ actor, data, now }) =>
      term({
        row: await runtime.create({
          collection: 'taxonomy-terms',
          data: { ...audit({ actor, now }), ...data },
          req,
        }),
      }),
    updateTerm: async ({ actor, before, data, now }) =>
      term({
        row: await runtime.updateExpected({
          id: before.id,
          collection: 'taxonomy-terms',
          data: { ...data, updatedAt: now, updatedBy: actor },
          expected: {
            and: Object.entries(before).map(([key, value]) => ({ [key]: { equals: value } })),
          },
          req,
        }),
      }),
  })
}
const select = Object.fromEntries(
  ['id', 'kind', 'code', 'name', 'status', 'sortOrder', 'isDeleted'].map((key) => [key, true]),
)
function term({ row }: { row: Record<string, unknown> }): TaxonomyFact {
  if (
    typeof row.id !== 'number' ||
    typeof row.code !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.sortOrder !== 'number' ||
    typeof row.isDeleted !== 'boolean' ||
    (row.kind !== 'category' && row.kind !== 'label') ||
    (row.status !== 'active' && row.status !== 'hidden')
  ) {
    integrity()
  }
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    isDeleted: row.isDeleted,
    kind: row.kind,
    sortOrder: row.sortOrder,
    status: row.status,
  }
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
function integrity(): never {
  throw new TemplatePublicationError('DATA_INTEGRITY_CONFLICT')
}
