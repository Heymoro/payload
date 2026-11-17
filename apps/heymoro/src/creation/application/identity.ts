import { createHash, randomBytes } from 'node:crypto'

import type {
  IdentityOptions,
  IdentityRead,
  IdentityReader,
  LoginResult,
} from './identity-types.js'

import {
  addIdentitySeconds,
  assertIdentitySession,
  assertIdentityUser,
  assertWechatIdentity,
  credentialIsValid,
  identityDTO,
  IdentityError,
  identityIntegrity,
  identityPrincipal,
  isIdentityDate,
  isTrialEligible,
  parseBearer,
  parseIdentityPolicy,
  parseLoginCommand,
  parseProfileCommand,
  parseVerifiedWechat,
} from '../domain/identity.js'
import { createRequestId, isRequestId } from '../domain/request-id.js'

export function createIdentityService({
  clock,
  entropy = () => randomBytes(32),
  exchange,
  persistence,
  policy: rawPolicy,
  trial,
}: IdentityOptions) {
  const policy = parseIdentityPolicy({ value: rawPolicy })
  const authenticate = createIdentityAuthenticator({ clock, read: persistence.read })
  return Object.freeze({
    authenticate,
    getMe: async ({ authorization }: { authorization: unknown }) => {
      const tokenHash = requiredTokenHash({ authorization })
      return persistence.read({
        work: async ({ reader }) => {
          const credential = await readIdentityCredential({ reader, tokenHash })
          if (!credential || !credentialIsValid({ ...credential, now: clock() })) {
            throw unauthenticated()
          }
          return identityDTO({ user: credential.user })
        },
      })
    },
    login: async ({
      input,
      requestId: trustedRequestId,
    }: {
      input: unknown
      requestId?: string
    }): Promise<LoginResult> => {
      const requestId = mutationRequestId({ value: trustedRequestId })
      const command = parseLoginCommand({ input })
      if (!policy.wechat || !exchange) {
        throw new IdentityError({ code: 'AUTH_UNCONFIGURED' })
      }
      let token: string
      try {
        // Detect a broken host clock or entropy source before spending a one-time provider code.
        addIdentitySeconds({ now: clock(), seconds: policy.sessionTtlSeconds })
        const bytes = entropy()
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
          throw identityIntegrity()
        }
        token = Buffer.from(bytes).toString('base64url')
      } catch {
        throw identityIntegrity()
      }
      const tokenHash = hashToken({ token })
      let verified
      try {
        verified = parseVerifiedWechat({ value: await exchange(command) })
      } catch {
        throw new IdentityError({ code: 'AUTH_PROVIDER_UNAVAILABLE' })
      }
      const appId = policy.wechat.appId
      const resource = `wechat-identity:${createHash('sha256')
        .update(JSON.stringify([appId, verified.openId]))
        .digest('hex')}`
      let committed
      try {
        committed = await persistence.write({
          resource,
          work: async ({ repository }) => {
            const now = clock()
            const expiresAt = addIdentitySeconds({ now, seconds: policy.sessionTtlSeconds })
            const matches = await repository.findWechatIdentities({
              appId,
              openId: verified.openId,
            })
            if (matches.length > 1) {
              throw identityIntegrity()
            }
            let identity = matches[0]
            let user
            const createdUser = !identity
            if (identity) {
              assertWechatIdentity({ appId, identity, openId: verified.openId })
              if (identity.isDeleted) {
                throw identityIntegrity()
              }
              const users = await repository.findUsersById({ userId: identity.user })
              if (users.length !== 1) {
                throw identityIntegrity()
              }
              user = users[0]!
              assertIdentityUser({ user })
              if (user.id !== identity.user) {
                throw identityIntegrity()
              }
              if (user.isDeleted || user.status !== 'active') {
                throw unauthenticated()
              }
            } else {
              user = await repository.insertUser({ now })
              assertIdentityUser({ user })
              identity = await repository.insertWechatIdentity({
                appId,
                now,
                userId: user.id,
                verified,
              })
              assertWechatIdentity({ appId, identity, openId: verified.openId })
              if (!isTrialEligible({ identity, user }) || user.createdAt !== now) {
                throw identityIntegrity()
              }
            }
            // Include revoked, expired and soft-deleted hashes. A collision never generates another token.
            if ((await repository.findSessionsByHash({ tokenHash })).length !== 0) {
              throw identityIntegrity()
            }
            const session = await repository.insertSession({
              expiresAt,
              now,
              tokenHash,
              userId: user.id,
            })
            assertIdentitySession({ session, tokenHash })
            if (
              session.user !== user.id ||
              session.isDeleted ||
              session.revokedAt !== null ||
              session.expiresAt !== expiresAt
            ) {
              throw identityIntegrity()
            }
            await repository.appendAudit({
              action: 'auth.wechat.session.create',
              createdUser,
              now,
              requestId,
              resourceId: session.id,
              userId: user.id,
            })
            return Object.freeze({
              expiresAt,
              identityCreatedAt: identity.createdAt,
              isEligible: isTrialEligible({ identity, user }),
              user: identityDTO({ user }),
            })
          },
        })
      } catch (error) {
        if (error instanceof IdentityError) {
          throw error
        }
        // In particular, an unknown A commit is never automatically repeated or compensated here.
        throw new IdentityError({ code: 'AUTH_LOGIN_INCOMPLETE' })
      }
      // A's transaction and identity lease have both ended before B's independent wallet UOW.
      try {
        await trial({
          identityCreatedAt: committed.identityCreatedAt,
          isEligible: committed.isEligible,
          userId: committed.user.id,
        })
      } catch {
        throw new IdentityError({ code: 'AUTH_LOGIN_INCOMPLETE' })
      }
      return Object.freeze({ expiresAt: committed.expiresAt, token, user: committed.user })
    },
    logout: async ({
      authorization,
      requestId: trustedRequestId,
    }: {
      authorization: unknown
      requestId?: string
    }) => {
      const requestId = mutationRequestId({ value: trustedRequestId })
      const token = parseBearer({ authorization })
      if (!token) {
        return Object.freeze({ revoked: false })
      }
      const tokenHash = hashToken({ token })
      return persistence.write({
        resource: `user-session:${tokenHash}`,
        work: async ({ repository }) => {
          const credential = await readIdentityCredential({ reader: repository, tokenHash })
          if (
            !credential ||
            credential.session.isDeleted ||
            credential.session.revokedAt !== null
          ) {
            return Object.freeze({ revoked: false })
          }
          const now = clock()
          // Expiry/disabled/deleted User does not prevent revocation of an otherwise sound Session.
          if (!isIdentityDate({ value: now })) {
            throw identityIntegrity()
          }
          await repository.revokeSession({
            now,
            sessionId: credential.session.id,
            userId: credential.user.id,
          })
          await repository.appendAudit({
            action: 'auth.session.revoke',
            now,
            requestId,
            resourceId: credential.session.id,
            userId: credential.user.id,
          })
          return Object.freeze({ revoked: true })
        },
      })
    },
    updateProfile: async ({
      authorization,
      input,
      requestId: trustedRequestId,
    }: {
      authorization: unknown
      input: unknown
      requestId?: string
    }) => {
      const requestId = mutationRequestId({ value: trustedRequestId })
      const command = parseProfileCommand({ input })
      const tokenHash = requiredTokenHash({ authorization })
      return persistence.write({
        resource: `user-session:${tokenHash}`,
        work: async ({ repository }) => {
          const credential = await readIdentityCredential({ reader: repository, tokenHash })
          const now = clock()
          if (!credential || !credentialIsValid({ ...credential, now })) {
            throw unauthenticated()
          }
          if (credential.user.displayName === command.displayName) {
            return identityDTO({ user: credential.user })
          }
          const user = await repository.updateProfile({
            displayName: command.displayName,
            now,
            userId: credential.user.id,
          })
          assertIdentityUser({ user })
          if (user.id !== credential.user.id || user.displayName !== command.displayName) {
            throw identityIntegrity()
          }
          await repository.appendAudit({
            action: 'user.profile.update',
            now,
            requestId,
            resourceId: user.id,
            userId: user.id,
          })
          return identityDTO({ user })
        },
      })
    },
  })
}

/** Native strategy and formal authenticate share the reader and exact same credential facts. */
export function createIdentityAuthenticator({
  clock,
  read,
}: {
  clock: () => string
  read: IdentityRead
}) {
  return async ({ authorization }: { authorization: unknown }) => {
    const token = parseBearer({ authorization })
    if (!token) {
      return null
    }
    return read({
      work: async ({ reader }) => {
        const credential = await readIdentityCredential({ reader, tokenHash: hashToken({ token }) })
        if (!credential || !credentialIsValid({ ...credential, now: clock() })) {
          return null
        }
        return identityPrincipal({ user: credential.user })
      },
    })
  }
}
export async function readIdentityCredential({
  reader,
  tokenHash,
}: {
  reader: IdentityReader
  tokenHash: string
}) {
  const sessions = await reader.findSessionsByHash({ tokenHash })
  if (sessions.length > 1) {
    throw identityIntegrity()
  }
  const session = sessions[0]
  if (!session) {
    return null
  }
  assertIdentitySession({ session, tokenHash })
  const users = await reader.findUsersById({ userId: session.user })
  if (users.length !== 1) {
    throw identityIntegrity()
  }
  const user = users[0]!
  assertIdentityUser({ user })
  if (user.id !== session.user) {
    throw identityIntegrity()
  }
  return Object.freeze({ session, user })
}
function requiredTokenHash({ authorization }: { authorization: unknown }) {
  const token = parseBearer({ authorization })
  if (!token) {
    throw unauthenticated()
  }
  return hashToken({ token })
}
function hashToken({ token }: { token: string }) {
  return createHash('sha256').update(token).digest('hex')
}
function unauthenticated() {
  return new IdentityError({ code: 'AUTH_UNAUTHENTICATED' })
}

function mutationRequestId({ value }: { value: unknown }): string {
  if (value === undefined) {
    return createRequestId()
  }
  if (typeof value !== 'string' || !isRequestId({ value })) {
    throw new IdentityError({ code: 'AUTH_INPUT_INVALID' })
  }
  return value
}
