import assert from 'node:assert/strict'
import test from 'node:test'
import { createWechatCodeExchange } from '../src/creation/infrastructure/wechat/code-exchange.ts'
const config = {
  appId: 'fixture-app',
  appSecret: 'FIXTURE_SECRET',
  timeoutMs: 35,
  maxResponseBytes: 256,
}
const failure = { code: 'AUTH_PROVIDER_UNAVAILABLE', status: 503, retryable: true }
const good = () =>
  new Response(
    JSON.stringify({
      openid: 'verified-open',
      unionid: 'verified-union',
      session_key: 'PRIVATE_SESSION_KEY',
      nickname: 'untrusted',
    }),
  )
test('fixed official GET endpoint uses exactly four parameters and never follows redirects', async () => {
  let calls = 0
  const exchange = createWechatCodeExchange({
    config,
    fetch: async (url, init) => {
      calls++
      assert.equal(url.origin + url.pathname, 'https://api.weixin.qq.com/sns/jscode2session')
      assert.deepEqual(
        [...url.searchParams],
        [
          ['appid', 'fixture-app'],
          ['secret', 'FIXTURE_SECRET'],
          ['js_code', 'ONCE_CODE'],
          ['grant_type', 'authorization_code'],
        ],
      )
      assert.equal(init.method, 'GET')
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal)
      return good()
    },
  })
  assert.equal(calls, 0)
  assert.deepEqual(await exchange({ code: 'ONCE_CODE' }), {
    openId: 'verified-open',
    unionId: 'verified-union',
  })
  assert.equal(calls, 1)
})
test('verified output is frozen and excludes session_key and untrusted profile', async () => {
  const result = await createWechatCodeExchange({ config, fetch: async () => good() })({
    code: 'ONCE_CODE',
  })
  assert.deepEqual(result, { openId: 'verified-open', unionId: 'verified-union' })
  assert.ok(Object.isFrozen(result))
})
for (const body of [
  'not-json',
  'null',
  '[]',
  '{}',
  '{"openid":""}',
  '{"openid":"x","errcode":40029,"errmsg":"PRIVATE_UPSTREAM"}',
  '{"openid":"x","errcode":"0"}',
  '{"openid":"x","unionid":7}',
  '{"openid":"x\\n"}',
])
  test('provider validates JSON facts without leaking upstream error text', async () => {
    await assert.rejects(
      createWechatCodeExchange({ config, fetch: async () => new Response(body) })({
        code: 'ONCE_CODE',
      }),
      failure,
    )
  })
for (const status of [302, 400, 500])
  test('HTTP failure is controlled and not retried: ' + status, async () => {
    let count = 0
    await assert.rejects(
      createWechatCodeExchange({
        config,
        fetch: async () => {
          count++
          return new Response('PRIVATE_UPSTREAM', { status })
        },
      })({ code: 'ONCE_CODE' }),
      failure,
    )
    assert.equal(count, 1)
  })
test('actual streaming bytes are bounded, ignoring Content-Length', async () => {
  let cancelled = false
  const body = new ReadableStream({
    pull(c) {
      c.enqueue(new TextEncoder().encode('x'.repeat(200)))
    },
    cancel() {
      cancelled = true
    },
  })
  await assert.rejects(
    createWechatCodeExchange({
      config,
      fetch: async () => new Response(body, { headers: { 'content-length': '1' } }),
    })({ code: 'ONCE_CODE' }),
    failure,
  )
  assert.ok(cancelled)
})
test('timeout bounds a fetch that ignores abort and never returns headers', async () => {
  await assert.rejects(
    createWechatCodeExchange({ config, fetch: () => new Promise(() => {}) })({ code: 'ONCE_CODE' }),
    failure,
  )
})
test('one whole timeout also bounds a response stream that never completes', async () => {
  let signal
  let cancelled = false
  const body = new ReadableStream({
    pull() {
      return new Promise(() => {})
    },
    cancel() {
      cancelled = true
    },
  })
  await assert.rejects(
    createWechatCodeExchange({
      config,
      fetch: async (_, init) => {
        signal = init.signal
        return new Response(body)
      },
    })({ code: 'ONCE_CODE' }),
    failure,
  )
  assert.ok(signal.aborted)
  assert.ok(cancelled)
})
test('transport exceptions discard raw URL, code, secret and cause', async () => {
  try {
    await createWechatCodeExchange({
      config,
      fetch: async () => {
        throw Error(
          'https://api.weixin.qq.com?secret=FIXTURE_SECRET&code=ONCE_CODE PRIVATE_UPSTREAM',
        )
      },
    })({ code: 'ONCE_CODE' })
    assert.fail('expected provider rejection')
  } catch (error) {
    assert.equal(error.code, 'AUTH_PROVIDER_UNAVAILABLE')
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(
      JSON.stringify(error) + error.message,
      /FIXTURE_SECRET|ONCE_CODE|PRIVATE_UPSTREAM|https:/,
    )
  }
})

test('a never-settling stream cancellation does not keep the deadline path waiting', async () => {
  const body = new ReadableStream({
    pull() {
      return new Promise(() => {})
    },
    cancel() {
      return new Promise(() => {})
    },
  })
  await assert.rejects(
    createWechatCodeExchange({ config, fetch: async () => new Response(body) })({
      code: 'ONCE_CODE',
    }),
    failure,
  )
})
test('headers time and slow stream share one total budget, with malformed UTF-8 controlled', async () => {
  const body = new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 70))
      controller.close()
    },
  })
  await assert.rejects(
    createWechatCodeExchange({
      config,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return new Response(body)
      },
    })({ code: 'ONCE_CODE' }),
    failure,
  )
  await assert.rejects(
    createWechatCodeExchange({ config, fetch: async () => new Response(Uint8Array.of(0xff)) })({
      code: 'ONCE_CODE',
    }),
    failure,
  )
})
test('HTTP failure and unexpected redirected responses cancel owned bodies', async () => {
  for (const kind of ['http', 'redirected']) {
    let cancelled = false
    const body = new ReadableStream({
      cancel() {
        cancelled = true
      },
    })
    const response = new Response(body, { status: kind === 'http' ? 500 : 200 })
    if (kind === 'redirected') Object.defineProperty(response, 'redirected', { value: true })
    await assert.rejects(
      createWechatCodeExchange({ config, fetch: async () => response })({ code: 'ONCE_CODE' }),
      failure,
    )
    assert.ok(cancelled)
  }
})
test('optional absent unionId is represented only as a null verified fact', async () => {
  assert.deepEqual(
    await createWechatCodeExchange({
      config,
      fetch: async () => new Response('{"openid":"verified","errcode":0}'),
    })({ code: 'ONCE_CODE' }),
    { openId: 'verified', unionId: null },
  )
})
