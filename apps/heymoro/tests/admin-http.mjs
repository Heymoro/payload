import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdir, open, readdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = fileURLToPath(new URL('../', import.meta.url))
const dataDir = path.join(root, '.data', `admin-acceptance-${Date.now()}`)
await mkdir(path.join(dataDir, 'uploads'), { recursive: true })
const listener = net.createServer()
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise((resolve) => listener.close(resolve))
const base = `http://127.0.0.1:${port}`
const log = await open(path.join(dataDir, 'server.log'), 'w', 0o600)
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
    cwd: root,
    stdio: ['ignore', log.fd, log.fd],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PAYLOAD_SECRET: randomBytes(32).toString('hex'),
      DATABASE_URL: `file:${path.join(dataDir, 'test.sqlite')}`,
      UPLOAD_DIR: path.join(dataDir, 'uploads'),
      PUBLIC_API_URL: base,
      WECHAT_AUTH_PROVIDER: 'mock',
      PAYLOAD_DROP_DATABASE: 'false',
      HEYMORO_DIST_DIR: '.next-admin-check',
    },
  },
)
async function request(route, { token, body, method = 'GET', status = 200 } = {}) {
  const response = await fetch(base + '/api' + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `JWT ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  })
  assert.equal(response.status, status, `${method} ${route}: ${await response.clone().text()}`)
  return response.json()
}
try {
  let ready = false
  for (let n = 0; n < 200; n++) {
    if (child.exitCode !== null)
      throw new Error('Isolated backend exited; inspect its ignored server.log')
    try {
      ready = (await fetch(base + '/api/v1/health/ready', { signal: AbortSignal.timeout(1000) })).ok
    } catch {}
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.ok(ready, 'Isolated backend must become ready')
  const password = randomBytes(24).toString('hex')
  const first = await request('/admins/first-register', {
    method: 'POST',
    body: { email: 'first@local.test', password, role: 'operator' },
  })
  assert.equal(first.user.role, 'admin')
  assert.equal(first.user.status, 'active')
  const token = first.token,
    id = first.user.id
  await request(`/admins/${id}`, {
    token,
    method: 'PATCH',
    body: { role: 'operator' },
    status: 400,
  })
  await request(`/admins/${id}`, {
    token,
    method: 'PATCH',
    body: { status: 'disabled' },
    status: 400,
  })
  await request(`/admins/${id}`, { token, method: 'DELETE', status: 400 })
  console.log('PASS empty database bootstrap and last active administrator protection')
  const operator = await request('/admins', {
    token,
    method: 'POST',
    status: 201,
    body: { email: 'operator@local.test', password, role: 'operator' },
  })
  const login = await request('/admins/login', {
    method: 'POST',
    body: { email: 'operator@local.test', password },
  })
  for (const collection of ['userSessions', 'wechatIdentities']) {
    await request(`/${collection}`, { token: login.token, status: 403 })
    await request(`/${collection}`, { token: login.token, method: 'POST', body: {}, status: 403 })
  }
  await request('/users', { token: login.token })
  console.log('PASS operator business reads allowed; identity/session stores denied')
  const business = await request('/v1/auth/wechat', {
    method: 'POST',
    body: { code: 'mock:disabled-user-check' },
    status: 201,
  })
  const bearer = { Authorization: `Bearer ${business.data.token}` }
  assert.equal((await fetch(base + '/api/v1/me', { headers: bearer })).status, 200)
  for (const route of ['/admins', '/auditLogs', '/userSessions', '/wechatIdentities']) {
    const response = await fetch(base + '/api' + route, { headers: bearer })
    assert.equal(response.status, 403, `Business session must not access ${route}`)
  }
  assert.equal(
    (await fetch(base + '/api/v1/media/cleanup', { method: 'POST', headers: bearer })).status,
    403,
  )
  assert.equal(
    (await fetch(base + '/api/v1/me', { headers: { Authorization: `JWT ${token}` } })).status,
    401,
  )
  await request('/v1/records', {
    token,
    method: 'POST',
    body: { title: 'Not a business user' },
    status: 401,
  })
  await request('/v1/media/cleanup', { token: login.token, method: 'POST', body: {}, status: 403 })
  console.log(
    'PASS client and admin identities remain separate; user/operator cannot run management cleanup',
  )

  // Exercise the facade, native client REST and the same native REST used by Admin.
  for (const entry of [
    { route: '/v1/records', headers: bearer, native: false },
    { route: '/records', headers: bearer, native: true },
    {
      route: '/records',
      headers: { Authorization: `JWT ${token}` },
      native: true,
      owner: business.data.user.id,
    },
  ]) {
    const send = async (body, { method = 'POST', id = '', status = 200 } = {}) => {
      const response = await fetch(base + '/api' + entry.route + id, {
        method,
        headers: { 'Content-Type': 'application/json', ...entry.headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30000),
      })
      assert.equal(
        response.status,
        status,
        `${entry.route} ${method}: ${await response.clone().text()}`,
      )
      return response.status === 204 ? null : response.json()
    }
    const created = await send(
      { title: '  normalized title  ', ...(entry.owner ? { owner: entry.owner } : {}) },
      { status: 201 },
    )
    const doc = entry.native ? created.doc : created.data
    try {
      assert.equal(doc.title, 'normalized title', entry.route)
      const updated = await send(
        { title: '  updated title  ' },
        { method: 'PATCH', id: `/${doc.id}` },
      )
      assert.equal((entry.native ? updated.doc : updated.data).title, 'updated title')
      await send({ body: 'body-only patch' }, { method: 'PATCH', id: `/${doc.id}` })
      for (const input of [
        { title: '   ' },
        { title: 'x'.repeat(101) },
        { body: 'x'.repeat(10001) },
      ]) {
        const rejected = await send(input, { method: 'PATCH', id: `/${doc.id}`, status: 400 })
        if (!entry.native) assert.equal(rejected.error.code, 'VALIDATION_FAILED')
      }
      const current = await send(null, { method: 'GET', id: `/${doc.id}` })
      assert.equal((entry.native ? current : current.data).title, 'updated title')
      assert.equal((entry.native ? current : current.data).body, 'body-only patch')
    } finally {
      await send(null, { method: 'DELETE', id: `/${doc.id}`, status: entry.native ? 200 : 204 })
    }
  }
  console.log(
    'PASS shared record title/body constraints across v1, native client and management REST',
  )

  await request(`/users/${business.data.user.id}`, {
    token,
    method: 'PATCH',
    body: { status: 'disabled' },
  })
  assert.equal((await fetch(base + '/api/v1/me', { headers: bearer })).status, 401)
  console.log('PASS disabled business user loses its existing opaque session')
  const expiring = await request('/v1/auth/wechat', {
    method: 'POST',
    body: { code: 'mock:expired-user-check' },
    status: 201,
  })
  const expirationHeaders = { Authorization: `Bearer ${expiring.data.token}` }
  assert.equal((await fetch(base + '/api/v1/me', { headers: expirationHeaders })).status, 200)
  // Only this script's freshly-created isolated database is edited; no clock waiting.
  const fixtureDB = new DatabaseSync(path.join(dataDir, 'test.sqlite'))
  try {
    fixtureDB
      .prepare('UPDATE user_sessions SET expires_at = ? WHERE token_hash = ?')
      .run(
        new Date(Date.now() - 60000).toISOString(),
        createHash('sha256').update(expiring.data.token).digest('hex'),
      )
  } finally {
    fixtureDB.close()
  }
  assert.equal((await fetch(base + '/api/v1/me', { headers: expirationHeaders })).status, 401)
  console.log('PASS expired opaque session rejected without waiting for wall-clock expiry')

  const fileUser = await request('/v1/auth/wechat', {
    method: 'POST',
    body: { code: 'mock:cleanup-check' },
    status: 201,
  })
  const fileHeaders = { Authorization: `Bearer ${fileUser.data.token}` }
  const imageFixtures = [
    {
      index: 54,
      mimeType: 'image/jpeg',
      extension: 'jpg',
      bytes: await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } })
        .jpeg()
        .toBuffer(),
    },
    {
      index: 55,
      mimeType: 'image/png',
      extension: 'png',
      bytes: await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } })
        .png()
        .toBuffer(),
    },
  ]
  const ids = []
  for (let n = 0; n < 56; n++) {
    const form = new FormData()
    const image = imageFixtures.find((fixture) => fixture.index === n)
    form.set(
      'file',
      new Blob([image?.bytes || '%PDF-1.4\n%%EOF'], { type: image?.mimeType || 'application/pdf' }),
      `cleanup-${n}.${image?.extension || 'pdf'}`,
    )
    const response = await fetch(base + '/api/v1/media', {
      method: 'POST',
      headers: fileHeaders,
      body: form,
    })
    assert.equal(response.status, 201)
    ids.push((await response.json()).data.id)
  }
  // File read ACL covers C-end users and existing Payload Web management actors.
  const otherReader = await request('/v1/auth/wechat', {
    method: 'POST',
    body: { code: 'mock:other-file-reader' },
    status: 201,
  })
  const otherHeaders = { Authorization: `Bearer ${otherReader.data.token}` }
  const adminHeaders = { Authorization: `JWT ${token}` },
    operatorHeaders = { Authorization: `JWT ${login.token}` }
  const ownNative = await request(`/media/${ids[0]}?depth=0`, { token })
  const storedFilename = ownNative.filename
  assert.equal(typeof storedFilename, 'string')
  for (const image of imageFixtures) {
    image.id = ids[image.index]
    image.filename = (await request(`/media/${image.id}?depth=0`, { token })).filename
  }
  const privateError = '/private/fixture-only/uploads/internal-error'
  await request(`/media/${ids[0]}`, {
    token,
    method: 'PATCH',
    body: { lastDeleteError: privateError, deleteAttempts: 3 },
  })
  const read = async (route, headers, status = 200) => {
    const response = await fetch(base + '/api' + route, {
      headers,
      signal: AbortSignal.timeout(30000),
    })
    assert.equal(response.status, status, `${route}: ${await response.clone().text()}`)
    return response
  }
  const assertPrivateMetadata = (doc) => {
    for (const name of [
      'storageName',
      'filename',
      'url',
      'thumbnailURL',
      'original',
      'variants',
      'pendingDeleteAt',
      'deleteAttempts',
      'lastDeleteError',
    ]) {
      assert.ok(
        doc[name] === undefined || doc[name] === null,
        `Client field ${name} must not disclose private metadata`,
      )
    }
    assert.ok(!JSON.stringify(doc).includes(storedFilename))
    assert.ok(!JSON.stringify(doc).includes(privateError))
  }
  for (const actor of [
    { headers: fileHeaders, own: true, count: 56 },
    { headers: otherHeaders, own: false, count: 0 },
    { headers: adminHeaders, own: true, count: 56, staff: true },
    { headers: operatorHeaders, own: true, count: 56, staff: true },
  ]) {
    const listing = await (await read('/v1/media?limit=50', actor.headers)).json()
    assert.equal(listing.data.totalDocs, actor.count)
    for (const item of listing.data.items) {
      assert.equal(item.ownerId, fileUser.data.user.id)
      assertPrivateMetadata(item)
    }
    const nativeListing = await (await read('/media?depth=0&limit=100', actor.headers)).json()
    assert.equal(nativeListing.totalDocs, actor.count)
    for (const item of nativeListing.docs) if (!actor.staff) assertPrivateMetadata(item)
    for (const route of [
      `/v1/media/${ids[0]}`,
      `/v1/media/${ids[0]}/content`,
      `/media/${ids[0]}?depth=0`,
    ]) {
      const response = await read(route, actor.headers, actor.own ? 200 : 404)
      if (actor.own && !route.endsWith('/content')) {
        const result = await response.json()
        const doc = route.startsWith('/v1/') ? result.data : result
        if (!actor.staff || route.startsWith('/v1/')) assertPrivateMetadata(doc)
        if (route.startsWith('/v1/')) assert.equal(doc.ownerId, fileUser.data.user.id)
      }
    }
    const nativeFile = await read(
      `/media/file/${storedFilename}`,
      actor.headers,
      actor.own ? 200 : 403,
    )
    if (actor.own) {
      assert.equal(await nativeFile.text(), '%PDF-1.4\n%%EOF')
      assert.match(nativeFile.headers.get('content-type'), /application\/pdf/)
      assert.equal(nativeFile.headers.get('cache-control'), 'private,no-store')
      const partial = await read(
        `/media/file/${storedFilename}`,
        { ...actor.headers, Range: 'bytes=0-4' },
        206,
      )
      assert.equal(await partial.text(), '%PDF-')
      assert.equal(partial.headers.get('content-range'), 'bytes 0-4/14')
      const invalidRange = await read(
        `/media/file/${storedFilename}`,
        { ...actor.headers, Range: 'bytes=1000-2000' },
        416,
      )
      assert.equal(invalidRange.headers.get('content-range'), 'bytes */14')
    }
    for (const image of imageFixtures) {
      for (const [route, denied] of [
        [`/media/file/${image.filename}`, 403],
        [`/v1/media/${image.id}/content`, 404],
      ]) {
        const response = await read(route, actor.headers, actor.own ? 200 : denied)
        if (actor.own) {
          assert.match(response.headers.get('content-type'), new RegExp(image.mimeType))
          assert.equal(response.headers.get('cache-control'), 'private,no-store')
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), image.bytes)
        }
      }
    }
    const graphResponse = await fetch(base + '/api/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...actor.headers },
      body: JSON.stringify({
        query: `{ Media(id: ${ids[0]}) { id originalName owner { id } filename url lastDeleteError deleteAttempts } allMedia(limit: 100) { totalDocs docs { id originalName } } }`,
      }),
      signal: AbortSignal.timeout(30000),
    })
    assert.equal(graphResponse.status, 200)
    const graph = await graphResponse.json()
    assert.equal(graph.data?.allMedia?.totalDocs, actor.count, JSON.stringify(graph))
    if (actor.own) {
      assert.equal(graph.data?.Media?.id, ids[0], JSON.stringify(graph))
      if (!actor.staff) assertPrivateMetadata(graph.data.Media)
    } else assert.equal(graph.data?.Media, null)
  }
  for (const headers of [{}, bearer]) {
    await read('/v1/media', headers, 401)
    await read(`/v1/media/${ids[0]}`, headers, 401)
    await read(`/v1/media/${ids[0]}/content`, headers, 401)
    await read('/media', headers, 403)
    await read(`/media/file/${storedFilename}`, headers, 403)
  }
  for (const [headers, targetOwner] of [
    [fileHeaders, otherReader.data.user.id],
    [otherHeaders, fileUser.data.user.id],
  ]) {
    const filter = encodeURIComponent(JSON.stringify({ owner: { equals: targetOwner } }))
    const result = await (
      await read(`/media?depth=0&overrideAccess=true&where=${filter}`, headers)
    ).json()
    assert.equal(result.totalDocs, 0)
  }
  const forced = await (
    await read(
      `/media/${ids[0]}?depth=0&showHiddenFields=true&select[storageName]=true&select[filename]=true&select[url]=true&select[lastDeleteError]=true`,
      fileHeaders,
    )
  ).json()
  assertPrivateMetadata(forced)
  const hiddenGraph = await fetch(base + '/api/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...fileHeaders },
    body: JSON.stringify({
      query: `{ Media(id: ${ids[0]}) { id storageName filename url lastDeleteError } }`,
    }),
    signal: AbortSignal.timeout(30000),
  })
  const hiddenGraphBody = await hiddenGraph.json()
  assert.ok(!JSON.stringify(hiddenGraphBody).includes(storedFilename))
  assert.ok(!JSON.stringify(hiddenGraphBody).includes(privateError))

  for (const headers of [fileHeaders, operatorHeaders]) {
    const mutation = await fetch(base + `/api/media/${ids[0]}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ owner: otherReader.data.user.id }),
    })
    assert.equal(mutation.status, 403)
    assert.equal(
      (await fetch(base + `/api/media/${ids[0]}`, { method: 'DELETE', headers })).status,
      403,
    )
  }
  assert.equal(
    (await request(`/media/${ids[0]}?depth=0`, { token: login.token })).lastDeleteError,
    privateError,
  )
  await request(`/media/${ids[0]}`, {
    token,
    method: 'PATCH',
    body: { lastDeleteError: null, deleteAttempts: 0 },
  })
  console.log(
    'PASS media read ACL across v1/native REST/GraphQL plus native file denials: own, foreign, Web admin/operator, anonymous and disabled; private fields and writes protected',
  )
  console.log(
    'PASS native file URL PDF/JPEG/PNG full bytes, MIME, private cache headers, valid/invalid Range and role permissions',
  )

  for (const entry of [
    { route: '/v1/records', headers: fileHeaders, native: false },
    { route: '/records', headers: fileHeaders, native: true },
    {
      route: '/records',
      headers: { Authorization: `JWT ${token}` },
      native: true,
      owner: fileUser.data.user.id,
    },
  ]) {
    const create = async (attachments, status) => {
      const response = await fetch(base + '/api' + entry.route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...entry.headers },
        body: JSON.stringify({
          title: 'attachment boundary',
          attachments,
          ...(entry.owner ? { owner: entry.owner } : {}),
        }),
        signal: AbortSignal.timeout(30000),
      })
      assert.equal(
        response.status,
        status,
        `${entry.route} attachment limit: ${await response.clone().text()}`,
      )
      return response.json()
    }
    const tooMany = await create(ids.slice(0, 21), 400)
    if (!entry.native) assert.equal(tooMany.error.code, 'VALIDATION_FAILED')
    const unknownTooMany = await create(
      Array.from({ length: 21 }, (_, index) => 900000 + index),
      400,
    )
    if (!entry.native) assert.equal(unknownTooMany.error.code, 'VALIDATION_FAILED')
    const accepted = await create(ids.slice(0, 20), 201)
    const doc = entry.native ? accepted.doc : accepted.data
    const rejectedPatch = await fetch(base + '/api' + entry.route + `/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...entry.headers },
      body: JSON.stringify({ attachments: ids.slice(0, 21) }),
      signal: AbortSignal.timeout(30000),
    })
    assert.equal(rejectedPatch.status, 400)
    const unchanged = await fetch(base + '/api' + entry.route + `/${doc.id}`, {
      headers: entry.headers,
    })
    assert.equal(unchanged.status, 200)
    const current = await unchanged.json()
    assert.equal((entry.native ? current : current.data).attachments.length, 20)
    const removed = await fetch(base + '/api' + entry.route + `/${doc.id}`, {
      method: 'DELETE',
      headers: entry.headers,
    })
    assert.equal(removed.status, entry.native ? 200 : 204)
  }
  console.log(
    'PASS 20/21 attachment create/update boundaries across v1, native client and management REST',
  )

  const ageFixture = new DatabaseSync(path.join(dataDir, 'test.sqlite'))
  try {
    ageFixture
      .prepare('UPDATE media SET created_at = ? WHERE id = ?')
      .run('2010-01-01T00:00:00.000Z', ids[0])
  } finally {
    ageFixture.close()
  }
  for (const fileID of ids.slice(1)) {
    assert.equal(
      (await fetch(base + `/api/v1/media/${fileID}`, { method: 'DELETE', headers: fileHeaders }))
        .status,
      202,
    )
  }
  const pendingNative = await request(`/media/${ids[1]}?depth=0`, { token })
  for (const headers of [adminHeaders, operatorHeaders]) {
    await read(`/media/${ids[1]}?depth=0`, headers)
    const pendingFile = await read(`/media/file/${pendingNative.filename}`, headers)
    assert.equal(await pendingFile.text(), '%PDF-1.4\n%%EOF')
    await read(`/v1/media/${ids[1]}`, headers, 404)
    await read(`/v1/media/${ids[1]}/content`, headers, 404)
    assert.equal((await (await read('/media?depth=0', headers)).json()).totalDocs, 56)
    assert.equal((await (await read('/v1/media', headers)).json()).data.totalDocs, 1)
  }
  await read(`/media/${ids[1]}?depth=0`, fileHeaders, 404)
  await read(`/media/file/${pendingNative.filename}`, fileHeaders, 403)
  await read(`/v1/media/${ids[1]}`, fileHeaders, 404)
  assert.equal((await (await read('/media?depth=0', fileHeaders)).json()).totalDocs, 1)
  await request(`/media/${ids[1]}`, {
    token,
    method: 'PATCH',
    body: { lifecycle: 'physicalDeleted' },
  })
  await read(`/media/${ids[1]}`, fileHeaders, 404)
  await read(`/media/file/${pendingNative.filename}`, fileHeaders, 403)
  await read(`/v1/media/${ids[1]}`, fileHeaders, 404)
  await request(`/media/${ids[1]}`, {
    token,
    method: 'PATCH',
    body: { lifecycle: 'pendingDelete' },
  })
  console.log(
    'PASS pending media hidden from C-end reads; Web staff management visibility and active-only v1 semantics preserved',
  )

  // Independent active file remains; 55 explicitly deleted files drain across two batches.
  const firstBatch = await request('/v1/media/cleanup', { token, method: 'POST', body: {} })
  const secondBatch = await request('/v1/media/cleanup', { token, method: 'POST', body: {} })
  assert.equal(firstBatch.data.removed, 50)
  assert.equal(secondBatch.data.removed, 5)
  assert.equal((await readdir(path.join(dataDir, 'uploads'))).length, 1)
  for (const headers of [adminHeaders, operatorHeaders])
    await read(`/media/file/${pendingNative.filename}`, headers, 404)
  await read(`/media/file/${pendingNative.filename}`, fileHeaders, 403)
  assert.equal(
    (await fetch(base + `/api/v1/media/${ids[0]}/content`, { headers: fileHeaders })).status,
    200,
  )
  console.log(
    'PASS 55 explicitly deleted files cleaned in batches; active standalone file preserved',
  )
  assert.equal(
    (await fetch(base + `/api/v1/media/${ids[0]}`, { method: 'DELETE', headers: fileHeaders }))
      .status,
    202,
  )
  await chmod(path.join(dataDir, 'uploads'), 0o500)
  let failedBatch
  try {
    failedBatch = await request('/v1/media/cleanup', { token, method: 'POST', body: {} })
  } finally {
    await chmod(path.join(dataDir, 'uploads'), 0o700)
  }
  assert.equal(failedBatch.data.retried, 1)
  assert.equal(
    (await request('/v1/media/cleanup', { token, method: 'POST', body: {} })).data.removed,
    1,
  )
  assert.equal((await readdir(path.join(dataDir, 'uploads'))).length, 0)
  console.log(
    'PASS physical-delete permission failure remains retryable after permission restoration',
  )

  const raceRequest = (route, method, headers, body) =>
    fetch(base + '/api' + route, {
      method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    })
  const raceRecord = await raceRequest('/v1/records', 'POST', fileHeaders, {
    title: 'Attachment race fixture',
  })
  assert.equal(raceRecord.status, 201)
  const recordRoute = `/v1/records/${(await raceRecord.json()).data.id}`
  const raceFiles = []
  for (let n = 0; n < 8; n++) {
    const form = new FormData()
    form.set('file', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), `race-${n}.pdf`)
    const uploaded = await fetch(base + '/api/v1/media', {
      method: 'POST',
      headers: fileHeaders,
      body: form,
    })
    assert.equal(uploaded.status, 201)
    raceFiles.push((await uploaded.json()).data.id)
  }
  for (const [index, fileID] of raceFiles.entries()) {
    const mediaRoute = `/v1/media/${fileID}`
    if (index % 2 === 1) {
      assert.equal(
        (await raceRequest(recordRoute, 'PATCH', fileHeaders, { attachments: [fileID] })).status,
        200,
      )
      const inUse = await raceRequest(mediaRoute, 'DELETE', fileHeaders)
      assert.equal(inUse.status, 409)
      assert.equal((await inUse.json()).error.code, 'FILE_IN_USE')
      const [detach, queueDuringDetach] = await Promise.all([
        raceRequest(recordRoute, 'PATCH', fileHeaders, { attachments: [] }),
        raceRequest(mediaRoute, 'DELETE', fileHeaders),
      ])
      assert.equal(detach.status, 200)
      assert.ok([202, 409].includes(queueDuringDetach.status))
      assert.equal((await raceRequest(mediaRoute, 'DELETE', fileHeaders)).status, 202)
    } else {
      const [attach, queue] = await Promise.all([
        raceRequest(recordRoute, 'PATCH', fileHeaders, { attachments: [fileID] }),
        raceRequest(mediaRoute, 'DELETE', fileHeaders),
      ])
      if (attach.status === 200) {
        assert.equal(
          queue.status,
          409,
          'A committed attachment must prevent the same file from being queued',
        )
        assert.equal((await queue.json()).error.code, 'FILE_IN_USE')
        assert.equal(
          await (await read(`${mediaRoute}/content`, fileHeaders)).text(),
          '%PDF-1.4\n%%EOF',
        )
        assert.equal(
          (await raceRequest(recordRoute, 'PATCH', fileHeaders, { attachments: [] })).status,
          200,
        )
        assert.equal((await raceRequest(mediaRoute, 'DELETE', fileHeaders)).status, 202)
      } else {
        assert.equal(attach.status, 400, await attach.clone().text())
        assert.equal((await attach.json()).error.code, 'FILE_NOT_ATTACHABLE')
        assert.equal(queue.status, 202)
      }
    }
    assert.deepEqual((await (await read(recordRoute, fileHeaders)).json()).data.attachments, [])
  }
  const [firstRaceBatch, secondRaceBatch, attachDuringCleanup] = await Promise.all([
    request('/v1/media/cleanup', { token, method: 'POST' }),
    request('/v1/media/cleanup', { token, method: 'POST' }),
    raceRequest(recordRoute, 'PATCH', fileHeaders, { attachments: [raceFiles[0]] }),
  ])
  assert.equal(attachDuringCleanup.status, 400, await attachDuringCleanup.clone().text())
  assert.equal((await attachDuringCleanup.json()).error.code, 'FILE_NOT_ATTACHABLE')
  const batches = [firstRaceBatch, secondRaceBatch]
  assert.equal(
    batches.reduce((total, batch) => total + batch.data.removed, 0),
    raceFiles.length,
  )
  for (const { data } of batches) {
    assert.equal(data.retried, 0)
    assert.equal(data.blocked, 0)
  }
  assert.deepEqual(await readdir(path.join(dataDir, 'uploads')), [])
  for (const fileID of raceFiles) await read(`/media/${fileID}`, adminHeaders, 404)
  console.log(
    'PASS concurrent attach/detach versus delete and duplicate cleanup preserve references, bytes and batch totals',
  )

  const legacyForm = new FormData()
  const legacyBytes = '%PDF-1.4\n%%EOF'
  legacyForm.set(
    'file',
    new Blob([legacyBytes], { type: 'application/pdf' }),
    'legacy-reference.pdf',
  )
  const legacyUpload = await fetch(base + '/api/v1/media', {
    method: 'POST',
    headers: fileHeaders,
    body: legacyForm,
  })
  assert.equal(legacyUpload.status, 201)
  const legacyID = (await legacyUpload.json()).data.id
  assert.equal(
    (await raceRequest(recordRoute, 'PATCH', fileHeaders, { attachments: [legacyID] })).status,
    200,
  )
  // Emulate a row already left in the inconsistent state by an older writer.
  await request(`/media/${legacyID}`, {
    token,
    method: 'PATCH',
    body: { lifecycle: 'pendingDelete', pendingDeleteAt: new Date().toISOString() },
  })
  const blocked = await request('/v1/media/cleanup', { token, method: 'POST' })
  assert.deepEqual(blocked.data, { queued: 0, removed: 0, retried: 0, blocked: 1 })
  const legacyNative = await request(`/media/${legacyID}`, { token })
  assert.equal(legacyNative.lastDeleteError, 'FILE_IN_USE')
  assert.equal(
    await (await read(`/media/file/${legacyNative.filename}`, adminHeaders)).text(),
    legacyBytes,
  )
  assert.deepEqual((await (await read(recordRoute, fileHeaders)).json()).data.attachments, [
    legacyID,
  ])
  assert.equal(
    (await raceRequest(recordRoute, 'PATCH', fileHeaders, { attachments: [] })).status,
    200,
  )
  assert.equal((await request('/v1/media/cleanup', { token, method: 'POST' })).data.removed, 1)
  await read(`/media/${legacyID}`, adminHeaders, 404)
  assert.deepEqual(await readdir(path.join(dataDir, 'uploads')), [])
  console.log('PASS cleanup keeps legacy pending referenced bytes until the record is detached')
  const second = await request('/admins', {
    token,
    method: 'POST',
    status: 201,
    body: { email: 'second@local.test', password, role: 'admin' },
  })
  const secondLogin = await request('/admins/login', {
    method: 'POST',
    body: { email: 'second@local.test', password },
  })
  await request(`/admins/${second.doc.id}`, {
    token,
    method: 'PATCH',
    body: { status: 'disabled' },
  })
  await request('/users', { token: secondLogin.token, status: 403 })
  await request('/media', { token: secondLogin.token, status: 403 })
  await request('/v1/media', { token: secondLogin.token, status: 401 })
  await request(`/admins/${operator.doc.id}`, {
    token,
    method: 'PATCH',
    body: { status: 'disabled' },
  })
  await request('/media', { token: login.token, status: 403 })
  await request('/v1/media', { token: login.token, status: 401 })
  await request(`/admins/${operator.doc.id}`, { token, method: 'DELETE' })
  console.log('PASS disabled administrator loses business permissions with its existing JWT')
  await request('/admins?where[status][equals]=active', {
    token,
    method: 'PATCH',
    body: { status: 'disabled' },
    status: 400,
  })
  await request('/admins?where[status][equals]=active', { token, method: 'DELETE', status: 400 })
  const third = await request('/admins', {
    token,
    method: 'POST',
    status: 201,
    body: { email: 'third@local.test', password, role: 'admin' },
  })
  const thirdLogin = await request('/admins/login', {
    method: 'POST',
    body: { email: 'third@local.test', password },
  })
  const changes = await Promise.all([
    fetch(base + `/api/admins/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `JWT ${thirdLogin.token}` },
      body: JSON.stringify({ status: 'disabled' }),
      signal: AbortSignal.timeout(30000),
    }),
    fetch(base + `/api/admins/${third.doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `JWT ${token}` },
      body: JSON.stringify({ status: 'disabled' }),
      signal: AbortSignal.timeout(30000),
    }),
  ])
  assert.equal(
    changes.filter((response) => response.status === 200).length,
    1,
    'Exactly one concurrent deactivation can succeed',
  )
  const survivor = changes[0].status === 200 ? thirdLogin.token : token
  const remaining = await request(
    '/admins?where[status][equals]=active&where[role][equals]=admin',
    { token: survivor },
  )
  assert.equal(remaining.totalDocs, 1)
  console.log('PASS bulk mutations denied; concurrent deactivation retains an active administrator')
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
