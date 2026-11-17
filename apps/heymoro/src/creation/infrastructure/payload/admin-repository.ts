import type { Payload, PayloadRequest, Where } from 'payload'

import type { AdministrationRepository } from '../../application/admin.js'
import type { SnapshotFind } from './read-snapshot.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'
import type { CreationWriteGate } from './write-gate.js'

import { createAdministration } from '../../application/admin.js'
import { AdminCommandError, adminRecord } from '../../domain/admin.js'
import { createSQLiteUnitOfWork, CreationTransactionError } from './sqlite-unit-of-work.js'

/** Narrow Native adapter. Only these commands receive an owned request, never callers. */
export function createPayloadAdministration(
  options: { clock: () => string; mode?: string } & SQLiteUnitOfWorkOptions,
) {
  const write = createSQLiteUnitOfWork(options)
  return createAdministration({
    clock: options.clock,
    mode: options.mode ?? process.env.NODE_ENV,
    write: async ({ resource, work }) => {
      try {
        return await write({
          resource,
          work: ({ req }) => work({ repository: repository({ options, req }) }),
        })
      } catch (error) {
        if (error instanceof CreationTransactionError) {
          throw new AdminCommandError({ code: 'ADMIN_OUTCOME_UNKNOWN', outcome: 'unknown' })
        }
        throw error
      }
    },
  })
}

/** Independent Native preauthentication only locates the actual admins identity. */
export async function authenticateNativeAdminPrincipal({
  authorization,
  owned,
  payload,
}: {
  authorization: string
  owned?: Readonly<{ gate: CreationWriteGate; req: PayloadRequest }>
  payload: Pick<Payload, 'auth'>
}): Promise<null | number> {
  const authenticate = () =>
    payload.auth({
      headers: new Headers({ Authorization: authorization, DisableAutologin: 'true' }),
      ...(owned ? { req: owned.req } : {}),
    })
  const result = await (owned
    ? owned.gate.run({ req: owned.req, work: authenticate })
    : authenticate())
  if (!result.user) {
    return null
  }
  const collection = Object.getOwnPropertyDescriptor(result.user, 'collection')
  if (!collection || !('value' in collection) || collection.value !== 'admins') {
    return null
  }
  const id = Object.getOwnPropertyDescriptor(result.user, 'id')
  if (
    !id ||
    !('value' in id) ||
    typeof id.value !== 'number' ||
    !Number.isSafeInteger(id.value) ||
    id.value < 1
  ) {
    throw new AdminCommandError({ code: 'ADMIN_DATA_INTEGRITY' })
  }
  return id.value
}

/** Fixed exact-id query, usable with SnapshotFind or an owned-request find. */
export async function readNativeAdminById({ id, find }: { find: SnapshotFind; id: number }) {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new AdminCommandError({ code: 'ADMIN_DATA_INTEGRITY' })
  }
  return (await readAdminRows({ expectedId: id, find, where: { id: { equals: id } } }))[0] ?? null
}

async function readAdminRows({
  expectedEmail,
  expectedId,
  find,
  where,
}: {
  expectedEmail?: string
  expectedId?: number
  find: SnapshotFind
  where: Where
}) {
  const result = await find({
    collection: 'admins',
    limit: 2,
    select: { id: true, email: true, role: true, status: true },
    where,
  })
  if (
    !Array.isArray(result.docs) ||
    !Number.isSafeInteger(result.totalDocs) ||
    result.totalDocs < 0 ||
    result.totalDocs !== result.docs.length ||
    result.totalDocs > 1
  ) {
    throw new AdminCommandError({ code: 'ADMIN_DATA_INTEGRITY' })
  }
  return result.docs.map((value) => {
    const record = adminRecord({ value })
    if (
      (expectedId !== undefined && record.id !== expectedId) ||
      (expectedEmail !== undefined && value.email !== expectedEmail)
    ) {
      throw new AdminCommandError({ code: 'ADMIN_DATA_INTEGRITY' })
    }
    return record
  })
}

function repository({
  options,
  req,
}: {
  options: SQLiteUnitOfWorkOptions
  req: PayloadRequest
}): AdministrationRepository {
  const { gate, payload } = options
  // Native declarations merge unrelated adapters/collection schemas. The selected runtime boundary is checked below.
  const native = payload as unknown as {
    count: (args: {
      collection: 'admins'
      overrideAccess: true
      req: PayloadRequest
      where?: Where
    }) => Promise<{ totalDocs: number }>
    create: (args: {
      collection: 'admins' | 'auditLogs'
      data: Record<string, unknown>
      depth: 0
      overrideAccess: true
      req: PayloadRequest
    }) => Promise<Record<string, unknown>>
    find: (
      args: {
        depth: 0
        overrideAccess: true
        pagination: false
        req: PayloadRequest
      } & Parameters<SnapshotFind>[0],
    ) => Promise<{ docs: Record<string, unknown>[]; totalDocs: number }>
    update: (args: {
      collection: 'admins'
      data: Record<string, unknown>
      depth: 0
      id: number
      overrideAccess: true
      req: PayloadRequest
    }) => Promise<Record<string, unknown>>
  }
  const find: SnapshotFind = (args) =>
    gate.run({
      req,
      work: () => native.find({ ...args, depth: 0, overrideAccess: true, pagination: false, req }),
    })
  const rows = (args: { expectedEmail?: string; expectedId?: number; where: Where }) =>
    readAdminRows({ ...args, find })
  const count = async ({ where }: { where?: Where } = {}) => {
    const result = await gate.run({
      req,
      work: () => native.count({ collection: 'admins', overrideAccess: true, req, where }),
    })
    if (!Number.isSafeInteger(result.totalDocs) || result.totalDocs < 0) {
      throw new AdminCommandError({ code: 'ADMIN_DATA_INTEGRITY' })
    }
    return result.totalDocs
  }
  return Object.freeze({
    appendAudit: async ({
      id,
      action,
      actor,
      afterState,
      beforeState,
      now,
      requestId,
      summary,
    }) => {
      await gate.run({
        req,
        work: () =>
          native.create({
            collection: 'auditLogs',
            data: {
              action,
              actorId: actor.slice(actor.indexOf(':') + 1),
              actorType: actor.startsWith('admin:') ? 'admin' : 'system',
              afterState,
              beforeState,
              correlationId: requestId,
              createdAt: now,
              createdBy: actor,
              deletedAt: null,
              deletedBy: null,
              isDeleted: false,
              requestId,
              resourceId: String(id),
              resourceType: 'admin',
              result: 'success',
              summary: { ...summary, changedFields: [...summary.changedFields] },
              updatedAt: now,
              updatedBy: actor,
            },
            depth: 0,
            overrideAccess: true,
            req,
          }),
      })
    },
    authenticate: async ({ authorization }) => {
      const id = await authenticateNativeAdminPrincipal({
        authorization,
        owned: { gate, req },
        payload,
      })
      return id === null ? null : readNativeAdminById({ id, find })
    },
    countAll: () => count(),
    countOtherActive: ({ id }) =>
      count({
        where: {
          and: [
            { role: { equals: 'admin' } },
            { status: { equals: 'active' } },
            { id: { not_equals: id } },
          ],
        },
      }),
    findEmail: ({ email }) => rows({ expectedEmail: email, where: { email: { equals: email } } }),
    findId: async ({ id }) =>
      (await rows({ expectedId: id, where: { id: { equals: id } } }))[0] ?? null,
    insert: async (data) =>
      adminRecord({
        value: await gate.run({
          req,
          work: () =>
            native.create({
              collection: 'admins',
              data: { ...data },
              depth: 0,
              overrideAccess: true,
              req,
            }),
        }),
      }),
    update: async ({ id, changes }) =>
      adminRecord({
        value: await gate.run({
          req,
          work: () =>
            native.update({
              id,
              collection: 'admins',
              data: { ...changes },
              depth: 0,
              overrideAccess: true,
              req,
            }),
        }),
      }),
  })
}
