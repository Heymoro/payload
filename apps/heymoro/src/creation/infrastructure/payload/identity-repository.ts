import type { AuthStrategyFunction, Payload, PayloadRequest } from 'payload'

import type {
  IdentityOptions,
  IdentityReader,
  IdentityRepository,
} from '../../application/identity-types.js'
import type {
  IdentityAudit,
  IdentitySession,
  IdentityUser,
  WechatIdentity,
} from '../../domain/identity.js'
import type { SnapshotFind, SnapshotFindArguments } from './read-snapshot.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'
import type { CreationWriteGate } from './write-gate.js'

import { createIdentityAuthenticator, createIdentityService } from '../../application/identity.js'
import { createTrialEntitlement } from '../../application/trial-entitlement.js'
import { identityIntegrity, wechatAuthActor } from '../../domain/identity.js'
import { createCreditReader, createPayloadCreditsService } from './credits-repository.js'
import { createSQLiteReadSnapshot } from './read-snapshot.js'
import { createSQLiteUnitOfWork } from './sqlite-unit-of-work.js'

export function createPayloadIdentityService({
  clock,
  entropy,
  exchange,
  policy,
  ...options
}: Omit<IdentityOptions, 'persistence' | 'trial'> & SQLiteUnitOfWorkOptions) {
  const read = createSQLiteReadSnapshot({ payload: options.payload })
  const write = createSQLiteUnitOfWork(options)
  const credits = createPayloadCreditsService({ ...options, actor: wechatAuthActor, clock })
  const trial = createTrialEntitlement({
    clock,
    findGrantsByKey: (args) =>
      read({ work: ({ find }) => createCreditReader({ find }).findGrantsByKey(args) }),
    issueGrant: credits.issueGrant,
    policy: policy.trial,
  })
  return createIdentityService({
    clock,
    entropy,
    exchange,
    persistence: {
      read: ({ work }) =>
        read({ work: ({ find }) => work({ reader: createPayloadIdentityReader({ find }) }) }),
      write: ({ resource, work }) =>
        write({
          resource,
          work: ({ req }) =>
            work({ repository: createPayloadIdentityRepository({ ...options, req }) }),
        }),
    },
    policy,
    trial,
  })
}

/** Only a snapshot reader is reachable from Native auth; no write gate, Redis, provider or trial service. */
export function createPayloadIdentityAuthentication({
  clock,
}: {
  clock: () => string
}): AuthStrategyFunction {
  return async ({ headers, payload }) => {
    try {
      const snapshot = createSQLiteReadSnapshot({ payload })
      const authenticate = createIdentityAuthenticator({
        clock,
        read: ({ work }) =>
          snapshot({ work: ({ find }) => work({ reader: createPayloadIdentityReader({ find }) }) }),
      })
      return { user: await authenticate({ authorization: headers.get('authorization') }) }
    } catch {
      return { user: null }
    }
  }
}
export function createPayloadIdentityReader({ find }: { find: SnapshotFind }): IdentityReader {
  const rows = async (args: Omit<SnapshotFindArguments, 'limit' | 'showHiddenFields'>) => {
    const result = await find({ ...args, limit: 2, showHiddenFields: true, sort: 'id' })
    if (result.totalDocs > 2 || result.totalDocs !== result.docs.length) {
      throw identityIntegrity()
    }
    return result.docs
  }
  return Object.freeze({
    findSessionsByHash: async ({ tokenHash }) =>
      Object.freeze(
        (
          await rows({
            collection: 'userSessions',
            select: sessionSelect,
            where: { tokenHash: { equals: tokenHash } },
          })
        ).map((row) => sessionRecord({ row })),
      ),
    findUsersById: async ({ userId }) =>
      Object.freeze(
        (
          await rows({ collection: 'users', select: userSelect, where: { id: { equals: userId } } })
        ).map((row) => userRecord({ row })),
      ),
    findWechatIdentities: async ({ appId, openId }) =>
      Object.freeze(
        (
          await rows({
            collection: 'wechatIdentities',
            select: wechatSelect,
            where: { and: [{ appId: { equals: appId } }, { openId: { equals: openId } }] },
          })
        ).map((row) => wechatRecord({ row })),
      ),
  })
}

/** Dedicated Native adapter: every operation uses one private UOW request and the same gate. */
export function createPayloadIdentityRepository({
  gate,
  payload,
  req,
}: {
  gate: CreationWriteGate
  payload: Payload
  req: PayloadRequest
}): IdentityRepository {
  gate.assert({ req })
  type Collection = 'auditLogs' | 'users' | 'userSessions' | 'wechatIdentities'
  type LocalOptions = {
    collection: Collection
    depth: 0
    overrideAccess: true
    req: PayloadRequest
    showHiddenFields: true
  }
  // Generated Payload declarations also include legacy collections. This boundary permits only these Native operations.
  const local = payload as unknown as {
    create: (
      args: { data: Record<string, unknown> } & LocalOptions,
    ) => Promise<Record<string, unknown>>
    find: (
      args: { depth: 0; overrideAccess: true; req: PayloadRequest } & SnapshotFindArguments,
    ) => Promise<{ docs: Record<string, unknown>[]; totalDocs: number }>
    update: (
      args: { data: Record<string, unknown>; id: number } & LocalOptions,
    ) => Promise<Record<string, unknown>>
  }
  const find: SnapshotFind = (args) =>
    gate.run({ req, work: () => local.find({ ...args, depth: 0, overrideAccess: true, req }) })
  const insert = ({
    collection,
    data,
  }: {
    collection: Collection
    data: Record<string, unknown>
  }) =>
    gate.run({
      req,
      work: () =>
        local.create({
          collection,
          data,
          depth: 0,
          overrideAccess: true,
          req,
          showHiddenFields: true,
        }),
    })
  const update = ({
    id,
    collection,
    data,
  }: {
    collection: Collection
    data: Record<string, unknown>
    id: number
  }) =>
    gate.run({
      req,
      work: () =>
        local.update({
          id,
          collection,
          data,
          depth: 0,
          overrideAccess: true,
          req,
          showHiddenFields: true,
        }),
    })
  return Object.freeze({
    ...createPayloadIdentityReader({ find }),
    appendAudit: async ({ action, createdUser, now, requestId, resourceId, userId }) => {
      const isLogin = action === 'auth.wechat.session.create'
      const actor = isLogin ? wechatAuthActor : `user:${userId}`
      await insert({
        collection: 'auditLogs',
        data: {
          ...audit({ actor, now }),
          action,
          actorId: isLogin ? 'wechat-auth' : String(userId),
          actorType: isLogin ? 'system' : 'user',
          correlationId: requestId,
          requestId,
          resourceId: String(resourceId),
          resourceType: action === 'user.profile.update' ? 'user' : 'user-session',
          result: 'success',
          summary: isLogin
            ? { createdUser: createdUser === true }
            : { changedFields: [action === 'user.profile.update' ? 'displayName' : 'revokedAt'] },
        },
      })
    },
    insertSession: async ({ expiresAt, now, tokenHash, userId }) =>
      sessionRecord({
        row: await insert({
          collection: 'userSessions',
          data: {
            ...audit({ actor: wechatAuthActor, now }),
            expiresAt,
            revokedAt: null,
            tokenHash,
            user: userId,
          },
        }),
      }),
    insertUser: async ({ now }) =>
      userRecord({
        row: await insert({
          collection: 'users',
          data: {
            ...audit({ actor: wechatAuthActor, now }),
            displayName: '微信用户',
            status: 'active',
          },
        }),
      }),
    insertWechatIdentity: async ({ appId, now, userId, verified }) =>
      wechatRecord({
        row: await insert({
          collection: 'wechatIdentities',
          data: {
            ...audit({ actor: wechatAuthActor, now }),
            appId,
            openId: verified.openId,
            unionId: verified.unionId,
            user: userId,
          },
        }),
      }),
    revokeSession: async ({ now, sessionId, userId }) => {
      await update({
        id: sessionId,
        collection: 'userSessions',
        data: { revokedAt: now, updatedAt: now, updatedBy: `user:${userId}` },
      })
    },
    updateProfile: async ({ displayName, now, userId }) =>
      userRecord({
        row: await update({
          id: userId,
          collection: 'users',
          data: { displayName, updatedAt: now, updatedBy: `user:${userId}` },
        }),
      }),
  })
}
const auditNames = [
  'id',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  'isDeleted',
  'deletedAt',
  'deletedBy',
]
const sessionSelect = select({
  names: [...auditNames, 'user', 'expiresAt', 'revokedAt', 'tokenHash'],
})
const userSelect = select({ names: [...auditNames, 'avatarUrl', 'displayName', 'status'] })
const wechatSelect = select({ names: [...auditNames, 'appId', 'openId', 'unionId', 'user'] })
function select({ names }: { names: string[] }) {
  return Object.fromEntries(names.map((name) => [name, true]))
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
function auditRecord({ row }: { row: Record<string, unknown> }): IdentityAudit {
  return Object.freeze({
    id: row.id as number,
    createdAt: row.createdAt as string,
    createdBy: row.createdBy as string,
    deletedAt: (row.deletedAt ?? null) as null | string,
    deletedBy: (row.deletedBy ?? null) as null | string,
    isDeleted: row.isDeleted as boolean,
    updatedAt: row.updatedAt as string,
    updatedBy: row.updatedBy as string,
  })
}
function userRecord({ row }: { row: Record<string, unknown> }): IdentityUser {
  return Object.freeze({
    ...auditRecord({ row }),
    avatarUrl: (row.avatarUrl ?? null) as null | string,
    displayName: row.displayName as string,
    status: row.status as IdentityUser['status'],
  })
}
function sessionRecord({ row }: { row: Record<string, unknown> }): IdentitySession {
  return Object.freeze({
    ...auditRecord({ row }),
    expiresAt: row.expiresAt as string,
    revokedAt: (row.revokedAt ?? null) as null | string,
    tokenHash: row.tokenHash as string,
    user: row.user as number,
  })
}
function wechatRecord({ row }: { row: Record<string, unknown> }): WechatIdentity {
  return Object.freeze({
    ...auditRecord({ row }),
    appId: row.appId as string,
    openId: row.openId as string,
    unionId: (row.unionId ?? null) as null | string,
    user: row.user as number,
  })
}
