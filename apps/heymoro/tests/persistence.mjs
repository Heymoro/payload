import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

const phase = process.argv[2]
assert.ok(['prepare', 'verify'].includes(phase), 'Use prepare, restart the app, then verify')
const base = new URL(process.env.PUBLIC_API_URL)
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
assert.equal(process.env.WECHAT_AUTH_PROVIDER, 'mock')
const state = process.env.HEYMORO_PERSISTENCE_STATE
  ? resolve(process.env.HEYMORO_PERSISTENCE_STATE)
  : new URL('../.data/persistence-check.json', import.meta.url)
const filename = 'persistence-check.png'
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
async function request(path, { body, token, method = 'GET', status = 200 } = {}) {
  const multipart = body instanceof FormData
  const response = await fetch(new URL(`/api/v1${path}`, base), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  })
  assert.equal(response.status, status, `${method} ${path}`)
  return response
}
if (phase === 'prepare') {
  const login = await (
    await request('/auth/wechat', {
      method: 'POST',
      body: { code: `mock:persist-${randomUUID()}` },
      status: 201,
    })
  ).json()
  const token = login.data.token
  const title = `Persistence ${randomUUID()}`
  const form = new FormData()
  form.set('file', new Blob([image], { type: 'image/png' }), filename)
  const upload = await (
    await request('/media', { method: 'POST', token, body: form, status: 201 })
  ).json()
  const fileId = upload.data.id
  const record = await (
    await request('/records', {
      method: 'POST',
      token,
      body: { title, attachments: [fileId] },
      status: 201,
    })
  ).json()
  assert.deepEqual(record.data.attachments, [fileId])
  await writeFile(state, JSON.stringify({ token, id: record.data.id, fileId, title }), {
    mode: 0o600,
    flag: 'wx',
  })
  console.log('PASS isolated session, record and uploaded attachment created before restart')
} else {
  const { token, id, fileId, title } = JSON.parse(await readFile(state, 'utf8'))
  assert.ok(Number.isSafeInteger(fileId), 'Run prepare with this version of the test first')
  await request('/me', { token })
  const record = await (await request(`/records/${id}`, { token })).json()
  assert.equal(record.data.title, title)
  assert.deepEqual(record.data.attachments, [fileId])
  const metadata = await (await request(`/media/${fileId}`, { token })).json()
  assert.equal(metadata.data.originalName, filename)
  const content = await request(`/media/${fileId}/content`, { token })
  assert.equal(content.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), image)
  await request(`/media/${fileId}/content`, { status: 401 })
  await request(`/media/${fileId}`, { method: 'DELETE', token, status: 409 })
  await request(`/records/${id}`, { method: 'DELETE', token, status: 204 })
  await request(`/media/${fileId}`, { method: 'DELETE', token, status: 202 })
  await request(`/media/${fileId}/content`, { token, status: 404 })
  await request('/auth/logout', { method: 'POST', token, status: 204 })
  await request('/me', { token, status: 401 })
  await unlink(state)
  console.log(
    'PASS session, record, attachment and exact image bytes survived restart; access, delete and logout verified',
  )
}
