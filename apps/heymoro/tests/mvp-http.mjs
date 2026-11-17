import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const base = new URL(process.env.PUBLIC_API_URL)
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
assert.equal(process.env.WECHAT_AUTH_PROVIDER, 'mock')
const sessions = [],
  records = [],
  files = []
async function request(path, { token, body, method = 'GET', status = 200 } = {}) {
  const response = await fetch(new URL(`/api/v1${path}`, base), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  })
  assert.equal(response.status, status, `${method} ${path}: ${response.status}`)
  return response
}
const data = async (path, options) => (await (await request(path, options)).json()).data
async function login() {
  const result = await data('/auth/wechat', {
    method: 'POST',
    status: 201,
    body: { code: `mock:mvp-${randomUUID()}` },
  })
  sessions.push(result.token)
  return result.token
}
async function upload(token, name) {
  const form = new FormData()
  form.set('file', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), name)
  const file = await data('/media', { method: 'POST', status: 201, token, body: form })
  files.push({ id: file.id, token })
  return file.id
}
try {
  const owner = await login(),
    other = await login()
  await request('/me', { method: 'PATCH', status: 401, body: { displayName: 'Denied' } })
  await data('/me', {
    method: 'PATCH',
    token: owner,
    body: { displayName: '  修改昵称  ', avatarUrl: null, status: 'disabled' },
  })
  assert.equal((await data('/me', { token: owner })).displayName, '修改昵称')
  assert.equal((await data('/me', { token: owner })).status, 'active')
  assert.notEqual((await data('/me', { token: other })).displayName, '修改昵称')
  for (const body of [{ displayName: ' ' }, { displayName: 'x'.repeat(81) }, {}])
    await request('/me', { token: owner, method: 'PATCH', body, status: 400 })
  console.log('PASS profile update/readback, validation and privileged fields protected')

  const a = await upload(owner, '中文文档.pdf'),
    b = await upload(owner, 'second.pdf'),
    c = await upload(owner, 'third.pdf')
  const foreign = await upload(other, 'foreign.pdf')
  const metadata = await data(`/media/${a}`, { token: owner })
  assert.equal(metadata.id, a)
  assert.equal(metadata.originalName, '中文文档.pdf')
  assert.equal(metadata.mimeType, 'application/pdf')
  assert.equal(metadata.storageName, undefined)
  await request(`/media/${a}`, { token: other, status: 404 })
  await request(`/media/${a}`, { status: 401 })
  await request('/media/9007199254740991', { token: owner, status: 404 })
  console.log('PASS private attachment metadata, own/foreign/anonymous/missing access')
  const download = await request(`/media/${a}/content`, { token: owner })
  assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''/)
  assert.match(await download.text(), /%PDF/)
  for (let index = 0; index < 21; index++) {
    const record = await data('/records', {
      token: owner,
      method: 'POST',
      status: 201,
      body: { title: `MVP ${index}`, body: 'Original body' },
    })
    records.push({ id: record.id, token: owner })
  }
  const id = records[0].id
  await data(`/records/${id}`, {
    token: owner,
    method: 'PATCH',
    body: { title: 'Edited', attachments: [a] },
  })
  const edited = await data(`/records/${id}`, { token: owner })
  assert.equal(edited.title, 'Edited')
  assert.equal(edited.body, 'Original body')
  assert.deepEqual(edited.attachments, [a])
  await request(`/records/${id}`, {
    token: other,
    method: 'PATCH',
    body: { title: 'Denied' },
    status: 404,
  })
  await request(`/records/${id}`, {
    token: owner,
    method: 'PATCH',
    body: { attachments: [foreign] },
    status: 400,
  })
  assert.deepEqual((await data(`/records/${id}`, { token: owner })).attachments, [a])
  await request(`/media/${a}`, { token: owner, method: 'DELETE', status: 409 })
  await data(`/records/${id}`, { token: owner, method: 'PATCH', body: { attachments: [b, c] } })
  await data(`/records/${id}`, { token: owner, method: 'PATCH', body: { attachments: [] } })
  assert.deepEqual((await data(`/records/${id}`, { token: owner })).attachments, [])
  console.log('PASS edit/readback, attachment add/replace/remove, ownership and Chinese filename')

  for (const [path, expected] of [
    ['records', 21],
    ['media', 3],
  ]) {
    const seen = new Set()
    let page = 1,
      pages = 1
    do {
      const result = await data(`/${path}?page=${page}&limit=2`, { token: owner })
      assert.equal(result.page, page)
      assert.equal(result.totalDocs, expected)
      for (const item of result.items) {
        assert.ok(!seen.has(item.id))
        seen.add(item.id)
      }
      pages = result.totalPages
      page++
    } while (page <= pages)
    assert.equal(seen.size, expected)
    await request(`/${path}?page=Infinity`, { token: owner, status: 400 })
    await request(`/${path}?page=1.5`, { token: owner, status: 400 })
    assert.equal((await data(`/${path}?limit=80`, { token: owner })).limit, 50)
  }
  await request(`/media/${a}`, { token: owner, method: 'DELETE', status: 202 })
  await request(`/media/${a}`, { token: owner, status: 404 })
  console.log(
    'PASS record/file multipage traversal, stable ordering, invalid pagination and removed metadata rejected',
  )
} finally {
  for (const { id, token } of records)
    await request(`/records/${id}`, { token, method: 'DELETE', status: 204 })
  for (const { id, token } of files)
    await request(`/media/${id}`, { token, method: 'DELETE', status: 202 })
  for (const token of sessions)
    await request('/auth/logout', { token, method: 'POST', status: 204 })
}
