import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// Runs against the existing local server, not Vitest's in-process request handler.
// The mock-only restriction prevents accidental writes to a deployed account.
const base = new URL(process.env.PUBLIC_API_URL || 'http://localhost:3000')
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname),
  'This smoke test is local-only',
)
assert.equal(process.env.WECHAT_AUTH_PROVIDER, 'mock', 'Use the local mock configuration')
const sessions = []
let recordID
let mediaID
let owner

async function request(path, { token, body, method = 'GET', status = 200 } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const response = await fetch(new URL(`/api${path}`, base), {
    method,
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  assert.equal(response.status, status, `${method} ${path}`)
  return response
}
async function login(suffix) {
  const response = await request('/v1/auth/wechat', {
    method: 'POST',
    status: 201,
    body: { code: `mock:http-${suffix}-${randomUUID()}` },
  })
  const { data } = await response.json()
  assert.ok(data.user.displayName.startsWith('Mock '))
  sessions.push(data.token)
  return data.token
}

try {
  await request('/v1/health/ready')
  await request('/v1/me', { status: 401 })
  // The local profile must not expose the original fixture's destructive helpers.
  await request('/re-initialize', { method: 'POST', status: 404 })
  await request('/local-api', { method: 'POST', status: 404 })
  console.log('PASS readiness, authentication requirement, fixture routes disabled')

  owner = await login('owner')
  const other = await login('other')
  await request('/v1/me', { token: owner })
  const created = await request('/v1/records', {
    method: 'POST',
    token: owner,
    status: 201,
    body: { title: 'HTTP integration smoke' },
  })
  recordID = (await created.json()).data.id
  await request(`/v1/records/${recordID}`, { token: other, status: 404 })
  await request(`/v1/records/${recordID}`, {
    method: 'PATCH',
    token: owner,
    body: { title: 'HTTP integration updated' },
  })
  console.log('PASS mock login, profile, record create/update and cross-user isolation')

  const form = new FormData()
  const pdf = '%PDF-1.4\n%%EOF'
  form.set('file', new Blob([pdf], { type: 'application/pdf' }), 'http-smoke.pdf')
  const uploaded = await request('/v1/media', {
    method: 'POST',
    token: owner,
    body: form,
    status: 201,
  })
  mediaID = (await uploaded.json()).data.id
  assert.equal(await (await request(`/v1/media/${mediaID}/content`, { token: owner })).text(), pdf)
  await request(`/v1/media/${mediaID}/content`, { token: other, status: 404 })
  await request(`/v1/records/${recordID}`, {
    method: 'PATCH',
    token: owner,
    body: { attachments: [mediaID] },
  })
  await request(`/v1/media/${mediaID}`, { method: 'DELETE', token: owner, status: 409 })
  console.log('PASS multipart upload, authenticated download and referenced-file protection')
} finally {
  // Only remove business objects created by this run; retain audit/session records.
  try {
    if (recordID)
      await request(`/v1/records/${recordID}`, { method: 'DELETE', token: owner, status: 204 })
    if (mediaID)
      await request(`/v1/media/${mediaID}`, { method: 'DELETE', token: owner, status: 202 })
  } finally {
    for (const token of sessions) {
      await request('/v1/auth/logout', { method: 'POST', token, status: 204 })
      await request('/v1/me', { token, status: 401 })
    }
  }
}
console.log('PASS record deletion, media deletion queued and sessions revoked')
