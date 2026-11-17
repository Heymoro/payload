import type { WechatCodeExchange } from '../../application/identity-types.js'
import type { WechatConfiguration } from '../../domain/identity.js'

import {
  IdentityError,
  parseLoginCommand,
  parseVerifiedWechat,
  parseWechatConfiguration,
} from '../../domain/identity.js'

/** Fixed official transport. Neither host JSON nor a login command can select a URL. */
export function createWechatCodeExchange({
  config,
  fetch = globalThis.fetch,
}: {
  config: WechatConfiguration
  fetch?: typeof globalThis.fetch
}): WechatCodeExchange {
  const settings = parseWechatConfiguration({ value: config })
  return async ({ code }) => {
    const command = parseLoginCommand({ input: { code } })
    const abort = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancel = () => {
      void reader?.cancel().catch(() => undefined)
    }
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort()
        cancel()
        reject(new IdentityError({ code: 'AUTH_PROVIDER_UNAVAILABLE' }))
      }, settings.timeoutMs)
    })
    const operation = async () => {
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
      url.searchParams.set('appid', settings.appId)
      url.searchParams.set('secret', settings.appSecret)
      url.searchParams.set('js_code', command.code)
      url.searchParams.set('grant_type', 'authorization_code')
      const response = await fetch(url, { method: 'GET', redirect: 'error', signal: abort.signal })
      if (abort.signal.aborted) {
        void response.body?.cancel().catch(() => undefined)
        throw new Error('Exchange deadline exceeded.')
      }
      reader = response.body?.getReader()
      if (!response.ok || response.redirected || !reader) {
        throw new Error('Invalid exchange response.')
      }
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const chunk = await reader.read()
        if (abort.signal.aborted) {
          throw new Error('Exchange deadline exceeded.')
        }
        if (chunk.done) {
          break
        }
        size += chunk.value.byteLength
        if (size > settings.maxResponseBytes) {
          throw new Error('Exchange response limit exceeded.')
        }
        chunks.push(chunk.value)
      }
      const bytes = Buffer.concat(chunks, size)
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        ('errcode' in value && value.errcode !== 0)
      ) {
        throw new Error('Invalid exchange facts.')
      }
      const data = value as Record<string, unknown>
      return parseVerifiedWechat({ value: { openId: data.openid, unionId: data.unionid ?? null } })
    }
    try {
      return await Promise.race([operation(), timeout])
    } catch {
      abort.abort()
      cancel()
      // In particular, fetch errors carry the query URL. Never retain their cause.
      throw new IdentityError({ code: 'AUTH_PROVIDER_UNAVAILABLE' })
    } finally {
      clearTimeout(timer)
    }
  }
}
