import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cp, mkdir, open } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
await cp(path.join(root, 'src/app'), path.join(root, 'tests/unified-account/host/app'), {
  recursive: true,
})
const dir = path.join(root, '.data', `unified-spike-${Date.now()}`)
await mkdir(dir, { recursive: true })
const listener = net.createServer()
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise((resolve) => listener.close(resolve))
const base = `http://127.0.0.1:${port}`
const controlToken = randomBytes(32).toString('hex')
const log = await open(path.join(dir, 'server.log'), 'w', 0o600)
const child = spawn(
  process.execPath,
  [
    fileURLToPath(import.meta.resolve('next/dist/bin/next')),
    'dev',
    '--webpack',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  {
    cwd: path.join(root, 'tests/unified-account/host'),
    stdio: ['ignore', log.fd, log.fd],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      SPIKE_DATA_DIR: dir,
      SPIKE_CONTROL_TOKEN: controlToken,
      DATABASE_URL: `file:${path.join(dir, 'spike.sqlite')}`,
      PAYLOAD_SECRET: randomBytes(32).toString('hex'),
      PAYLOAD_DROP_DATABASE: 'false',
      PUBLIC_API_URL: base,
      WECHAT_AUTH_PROVIDER: 'mock',
      UPLOAD_DIR: path.join(dir, 'uploads'),
    },
  },
)
async function request(route, { method = 'GET', headers = {}, body, status = 200 } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(60000),
  })
  assert.equal(
    response.status,
    status,
    `${method} ${route} returned ${response.status}; see isolated server.log`,
  )
  return response
}
const json = async (route, options) => (await request(route, options)).json()
const control = (body) =>
  json('/api/spike/control', { method: 'POST', headers: { 'x-spike-control': controlToken }, body })
try {
  // Must be denied even before a users table exists.
  let ready = false
  for (let n = 0; n < 180; n++) {
    if (child.exitCode !== null) throw new Error('Spike server exited')
    try {
      const response = await fetch(base + '/api/users/first-register', {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(1000),
      })
      ready = response.status === 403
    } catch {}
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.ok(ready, 'Spike ingress must close anonymous management bootstrap')
  await request('/api/v1/health/ready')
  const wechatOne = await json('/api/v1/auth/wechat', {
    method: 'POST',
    body: { code: 'mock:unified-one' },
    status: 201,
  })
  const wechatTwo = await json('/api/v1/auth/wechat', {
    method: 'POST',
    body: { code: 'mock:unified-two' },
    status: 201,
  })
  const repeated = await json('/api/v1/auth/wechat', {
    method: 'POST',
    body: { code: 'mock:unified-one' },
    status: 201,
  })
  assert.equal(repeated.data.user.id, wechatOne.data.user.id)
  const before = await control({ action: 'inventory' })
  assert.equal(before.count, 2)
  for (const account of before.items) {
    assert.equal(account.managementRole, 'none')
    assert.equal(account.managementCredentialsEnabled, false)
    assert.ok(!account.email)
  }
  const id = before.items[0].id,
    otherID = before.items[1].id
  const client = wechatOne.data
  const other = wechatTwo.data
  assert.equal(wechatOne.data.user.id, id)
  const bearer = { Authorization: `Bearer ${client.token}` }
  assert.equal((await json('/api/v1/me', { headers: bearer })).id, id)
  const visible = await json('/api/users', { headers: {}, status: 403 })
  assert.ok(visible.errors)
  const password = randomBytes(32).toString('hex')
  await control({ action: 'enroll', id, email: 'unified@local.test', password })
  const login = await request('/api/users/login', {
    method: 'POST',
    body: { email: 'unified@local.test', password },
  })
  const native = await login.json()
  assert.equal(native.user.id, id)
  assert.equal((await control({ action: 'inventory' })).count, 2)
  const jwt = { Authorization: `JWT ${native.token}` }
  const cookie = login.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ')
  assert.ok(cookie.includes('unified-spike-token='))
  assert.equal((await json('/api/users', { headers: { Cookie: cookie } })).totalDocs, 2)
  console.log(
    'PASS one users.id: no-email client creation, multiple null emails, native credential enrollment and login; no extra account',
  )
  assert.equal((await json('/api/v1/me', { headers: bearer })).id, id)
  const managed = await json('/api/users', { headers: jwt })
  assert.equal(managed.totalDocs, 2)
  await request('/api/v1/media/cleanup', { method: 'POST', headers: jwt })
  await request('/api/v1/media/cleanup', { method: 'POST', headers: bearer, status: 401 })
  await request('/api/v1/me', { headers: jwt, status: 401 })
  await request('/api/users', { headers: bearer, status: 401 })
  const graphql = await json('/api/graphql', {
    method: 'POST',
    headers: jwt,
    body: { query: '{ Users { totalDocs } }' },
  })
  assert.equal(graphql.data.Users.totalDocs, 2)
  await request('/admin', { headers: { Cookie: cookie } })
  console.log(
    'PASS same account: client identity stays client-scoped while native JWT/cookie opens fixture management REST, GraphQL and admin page',
  )
  const expired = await control({ action: 'session', id: otherID })
  await control({ action: 'expire', token: expired.token })
  await request('/api/v1/me', {
    headers: { Authorization: `Bearer ${expired.token}` },
    status: 401,
  })
  for (const token of [client.token, 'invalid', other.token, expired.token]) {
    if (token === other.token) await control({ action: 'revoke', token })
    for (const route of ['/admin', '/api/users', '/api/graphql', '/api/v1/me', '/admin/users']) {
      await request(route, {
        method: route === '/admin/users' ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, Cookie: cookie },
        status: 401,
      })
    }
  }
  await request('/api/users', { headers: { Authorization: `Bearer ${native.token}` }, status: 401 })
  const canonical = await request('/api/users/first-register/', {
    method: 'POST',
    body: { managementRole: 'admin' },
    status: 308,
  })
  assert.equal(
    new URL(canonical.headers.get('location'), base).pathname,
    '/api/users/first-register',
  )
  await request('/api/users/first-register', {
    method: 'POST',
    body: { managementRole: 'admin' },
    status: 403,
  })
  await request('/api/%75sers/first-register', { method: 'POST', status: 403 })
  console.log(
    'PASS mixed/invalid/revoked Bearer cannot fall back to native cookie, including ordinary admin-path POST and encoded bootstrap path',
  )
  await request('/api/users', {
    method: 'POST',
    body: {
      username: 'injected',
      password,
      managementRole: 'admin',
      managementCredentialsEnabled: true,
    },
    status: 403,
  })
  await control({ action: 'patch', id, data: { managementRole: 'operator' } })
  await request(`/api/users/${otherID}`, {
    method: 'PATCH',
    headers: jwt,
    body: { managementRole: 'admin' },
    status: 403,
  })
  await request('/api/v1/media/cleanup', { method: 'POST', headers: jwt, status: 403 })
  await control({ action: 'patch', id, data: { managementRole: 'none' } })
  await request('/api/users', { headers: jwt, status: 403 })
  await request('/api/v1/me', { headers: bearer })
  await control({
    action: 'patch',
    id,
    data: { managementRole: 'admin', managementCredentialsEnabled: false },
  })
  await request('/api/users', { headers: jwt, status: 403 })
  await request('/api/users/login', {
    method: 'POST',
    body: { email: 'unified@local.test', password },
    status: 403,
  })
  await control({
    action: 'patch',
    id,
    data: { managementCredentialsEnabled: true, status: 'disabled' },
  })
  await request('/api/users', { headers: jwt, status: 403 })
  await request('/api/v1/me', { headers: bearer, status: 401 })
  console.log(
    'PASS management revocation does not disable client; credentials/global disable invalidate management and/or client access',
  )
  await control({
    action: 'patch',
    id,
    data: { status: 'active', managementRole: 'admin', managementCredentialsEnabled: true },
  })
  await request('/api/users/logout', { method: 'POST', headers: jwt })
  await request('/api/users', { headers: jwt, status: 403 })
  await request('/api/v1/me', { headers: bearer })
  console.log('PASS native logout revokes native session without revoking client session')
  const concurrent = await Promise.all(
    [1, 2].map(() =>
      json('/api/v1/auth/wechat', {
        method: 'POST',
        body: { code: 'mock:unified-concurrent' },
        status: 201,
      }),
    ),
  )
  assert.equal(concurrent[0].data.user.id, concurrent[1].data.user.id)
  assert.equal((await control({ action: 'inventory' })).count, 3)
  console.log(
    'PASS existing mock WeChat flow and concurrent identity creation keep one canonical account',
  )
  console.log(
    'PASS isolated phase-1 core compatibility checks; full business ACL/server-function/credential-flow checks remain before migration',
  )
} catch (error) {
  console.error(`Spike diagnostic log: ${path.join(dir, 'server.log')}`)
  throw error
} finally {
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  await log.close()
}
