export type WechatIdentity = {
  appId: string
  avatarUrl?: string
  displayName?: string
  openId: string
  unionId?: string
}

import { readRuntimeConfig } from './runtime.js'

type WechatCodeExchangeResponse = {
  errcode?: number
  errmsg?: string
  openid?: string
  session_key?: string
  unionid?: string
}

function mockIdentity(code: string): WechatIdentity {
  const config = readRuntimeConfig(process.env)
  if (config.nodeEnv === 'production') {
    throw new Error('Mock WeChat identity provider is disabled in production')
  }

  const [, rawId = 'user'] = code.split(':', 2)
  const safeId = rawId.replace(/[^\w-]/g, '').slice(0, 64) || 'user'
  return {
    appId: config.wechatAppId,
    displayName: `Mock ${safeId}`,
    openId: `mock-openid-${safeId}`,
  }
}

export async function exchangeWechatCode(code: string): Promise<WechatIdentity> {
  const config = readRuntimeConfig(process.env)
  if (config.wechatAuthProvider === 'mock') {
    return mockIdentity(code)
  }

  const { wechatAppId: appId, wechatAppSecret: appSecret } = config
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
  url.searchParams.set('appid', appId)
  url.searchParams.set('secret', appSecret)
  url.searchParams.set('js_code', code)
  url.searchParams.set('grant_type', 'authorization_code')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`WeChat identity exchange returned HTTP ${response.status}`)
    }

    const result = (await response.json()) as WechatCodeExchangeResponse
    if (result.errcode || !result.openid) {
      throw new Error(`WeChat identity exchange failed: ${result.errmsg || 'unknown error'}`)
    }

    return {
      appId,
      openId: result.openid,
      unionId: result.unionid,
    }
  } finally {
    clearTimeout(timeout)
  }
}
