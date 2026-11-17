import type { Endpoint, PayloadRequest } from 'payload'

import { randomUUID } from 'node:crypto'

import { createUserSession, extractBearerToken, revokeUserSession } from './auth-session.js'
import { exchangeWechatCode } from './auth-wechatIdentity.js'
import { createAccountForIdentity } from './service-accounts.js'
import { withWriteTransaction } from './service-transaction.js'

type WechatAuthBody = {
  code?: unknown
}

function requestId(req: PayloadRequest): string {
  return req.headers.get('x-request-id') || randomUUID()
}

function errorResponse(
  req: PayloadRequest,
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json({ error: { code, message }, requestId: requestId(req) }, { status })
}

function userDto(user: {
  avatarUrl?: null | string
  displayName: string
  id: number
  status: string
}) {
  return {
    id: user.id,
    avatarUrl: user.avatarUrl || null,
    displayName: user.displayName,
    status: user.status,
  }
}

async function findWechatIdentity(req: PayloadRequest, appId: string, openId: string) {
  const result = await req.payload.find({
    collection: 'wechatIdentities',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [{ appId: { equals: appId } }, { openId: { equals: openId } }],
    },
  })
  return result.docs[0]
}

function relationId(relation: { id: number } | number): number {
  return typeof relation === 'object' ? relation.id : relation
}

async function resolveUserForIdentity(
  req: PayloadRequest,
  identity: Awaited<ReturnType<typeof exchangeWechatCode>>,
) {
  const existingIdentity = await findWechatIdentity(req, identity.appId, identity.openId)
  if (existingIdentity) {
    return relationId(existingIdentity.user)
  }

  const user = await createAccountForIdentity({ identity, payload: req.payload, req })

  const identityWriteHasTransaction = Boolean(await req.transactionID)
  try {
    await req.payload.create({
      collection: 'wechatIdentities',
      data: {
        appId: identity.appId,
        openId: identity.openId,
        unionId: identity.unionId,
        user: user.id,
      },
      overrideAccess: true,
      req,
    })
    return user.id
  } catch (error) {
    // A nested failed write may already have rolled back the whole transaction.
    // Do not query or compensate using an ID whose row no longer belongs to us.
    if (identityWriteHasTransaction) {
      throw error
    }
    // The compound unique index arbitrates concurrent first-login requests.
    // If another request won, use its user and remove this request's orphan.
    const concurrentIdentity = await findWechatIdentity(req, identity.appId, identity.openId)
    try {
      await req.payload.delete({ id: user.id, collection: 'users', overrideAccess: true, req })
    } catch (cleanupError) {
      req.payload.logger.warn(
        { err: cleanupError },
        'Could not clean up concurrent WeChat login user',
      )
    }
    if (concurrentIdentity) {
      return relationId(concurrentIdentity.user)
    }
    throw error
  }
}

export const authEndpoints: Endpoint[] = [
  {
    handler: async (req) => {
      let body: WechatAuthBody
      try {
        body = (await req.json?.()) as WechatAuthBody
      } catch {
        return errorResponse(req, 400, 'INVALID_JSON', '请求格式无效')
      }

      if (typeof body?.code !== 'string' || body.code.length < 1 || body.code.length > 512) {
        return errorResponse(req, 400, 'INVALID_CODE', '微信登录凭证无效')
      }

      try {
        const identity = await exchangeWechatCode(body.code)
        return await withWriteTransaction({
          req,
          work: async () => {
            const userId = await resolveUserForIdentity(req, identity)

            const user = await req.payload.findByID({
              id: userId,
              collection: 'users',
              depth: 0,
              overrideAccess: true,
              req,
            })
            if (user.status !== 'active') {
              return errorResponse(req, 403, 'AUTH_DISABLED', '账号已被停用')
            }

            const session = await createUserSession({ payload: req.payload, req, userId })
            return Response.json(
              {
                data: {
                  expiresAt: session.expiresAt,
                  token: session.token,
                  user: userDto(user),
                },
                requestId: requestId(req),
              },
              { status: 201 },
            )
          },
        })
      } catch (error) {
        req.payload.logger.error({ err: error }, 'WeChat authentication failed')
        return errorResponse(req, 502, 'WECHAT_AUTH_FAILED', '微信登录失败，请稍后重试')
      }
    },
    method: 'post',
    path: '/v1/auth/wechat',
  },
  {
    handler: async (req) => {
      const token = extractBearerToken(req.headers)
      if (token) {
        await revokeUserSession({ payload: req.payload, req, token })
      }
      return new Response(null, { status: 204 })
    },
    method: 'post',
    path: '/v1/auth/logout',
  },
  {
    method: 'get',
    path: '/v1/me',
    // eslint-disable-next-line @typescript-eslint/require-await -- Native handlers retain the Promise contract.
    handler: async (req) => {
      if (!req.user || req.user.collection !== 'users') {
        return errorResponse(req, 401, 'AUTH_REQUIRED', '请先登录')
      }
      return Response.json({ data: userDto(req.user), requestId: requestId(req) })
    },
  },
  {
    handler: async (req) => {
      if (!req.user || req.user.collection !== 'users') {
        return errorResponse(req, 401, 'AUTH_REQUIRED', '请先登录')
      }
      let body: unknown
      try {
        body = await req.json?.()
      } catch {
        return errorResponse(req, 400, 'INVALID_JSON', '请求格式无效')
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return errorResponse(req, 400, 'VALIDATION_FAILED', '请求格式无效')
      }
      const input = body as Record<string, unknown>
      const data: { avatarUrl?: null | string; displayName?: string } = {}
      if ('displayName' in input) {
        if (
          typeof input.displayName !== 'string' ||
          input.displayName.trim().length < 1 ||
          input.displayName.trim().length > 80
        ) {
          return errorResponse(req, 400, 'VALIDATION_FAILED', '昵称长度必须为 1-80 个字符')
        }
        data.displayName = input.displayName.trim()
      }
      if ('avatarUrl' in input) {
        if (
          input.avatarUrl !== null &&
          (typeof input.avatarUrl !== 'string' || input.avatarUrl.length > 2048)
        ) {
          return errorResponse(req, 400, 'VALIDATION_FAILED', '头像地址无效')
        }
        data.avatarUrl = input.avatarUrl as null | string
      }
      if (Object.keys(data).length === 0) {
        return errorResponse(req, 400, 'VALIDATION_FAILED', '没有可更新的字段')
      }

      const user = await req.payload.update({
        id: req.user.id,
        collection: 'users',
        data,
        overrideAccess: false,
        req,
        user: req.user,
      })
      return Response.json({ data: userDto(user), requestId: requestId(req) })
    },
    method: 'patch',
    path: '/v1/me',
  },
]
