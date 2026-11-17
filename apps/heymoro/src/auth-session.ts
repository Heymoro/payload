import type { AuthStrategyFunction, PayloadRequest } from 'payload'

import { createOpaqueToken, hashOpaqueToken } from './auth-crypto.js'

const SESSION_DAYS = 7
const MAX_SESSION_SECONDS = 7 * 24 * 60 * 60

function getBearerToken(headers: Headers): null | string {
  const value = headers.get('authorization')
  if (!value) {
    return null
  }
  const [scheme, token] = value.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null
  }
  return token
}

export const authenticateUserSession: AuthStrategyFunction = async ({ headers, payload, req }) => {
  const token = getBearerToken(headers)
  if (!token) {
    return { user: null }
  }

  const now = new Date()
  const tokenHash = hashOpaqueToken(token)
  const sessions = await payload.find({
    collection: 'userSessions',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [
        { tokenHash: { equals: tokenHash } },
        { revokedAt: { exists: false } },
        { expiresAt: { greater_than: now.toISOString() } },
      ],
    },
  })

  const session = sessions.docs[0]
  if (!session) {
    return { user: null }
  }

  const userId = typeof session.user === 'object' ? session.user.id : session.user
  const user = await payload.findByID({
    id: userId,
    collection: 'users',
    depth: 0,
    overrideAccess: true,
    req,
  })

  if (!user || user.status !== 'active') {
    return { user: null }
  }

  return {
    user: {
      ...user,
      collection: 'users',
    },
  }
}

export async function createUserSession(args: {
  payload: PayloadRequest['payload']
  req?: PayloadRequest
  ttlSeconds?: number
  userId: number
}): Promise<{ expiresAt: string; token: string }> {
  const token = createOpaqueToken()
  const ttlSeconds = Math.min(
    Math.max(Math.floor(args.ttlSeconds ?? SESSION_DAYS * 24 * 60 * 60), 60),
    MAX_SESSION_SECONDS,
  )
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
  await args.payload.create({
    collection: 'userSessions',
    data: {
      expiresAt,
      tokenHash: hashOpaqueToken(token),
      user: args.userId,
    },
    overrideAccess: true,
    req: args.req,
  })
  return { expiresAt, token }
}

export async function revokeUserSession(args: {
  payload: PayloadRequest['payload']
  req?: PayloadRequest
  token: string
}): Promise<void> {
  const sessions = await args.payload.find({
    collection: 'userSessions',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req: args.req,
    where: { tokenHash: { equals: hashOpaqueToken(args.token) } },
  })
  const session = sessions.docs[0]
  if (!session || session.revokedAt) {
    return
  }

  await args.payload.update({
    id: session.id,
    collection: 'userSessions',
    data: { revokedAt: new Date().toISOString() },
    overrideAccess: true,
    req: args.req,
  })
}

export function extractBearerToken(headers: Headers): null | string {
  return getBearerToken(headers)
}
