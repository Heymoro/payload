import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = fileURLToPath(new URL('../', import.meta.url))
const dataDir = await mkdtemp(path.join(tmpdir(), 'heymoro-creation-http-'))
await mkdir(path.join(dataDir, 'uploads'))
const listener = net.createServer()
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise((resolve) => listener.close(resolve))
const base = `http://127.0.0.1:${port}`
const log = await open(path.join(dataDir, 'server.log'), 'w', 0o600)
const environment = {
  ...process.env,
  NODE_ENV: 'development',
  PAYLOAD_SECRET: randomBytes(32).toString('hex'),
  DATABASE_URL: `file:${path.join(dataDir, 'test.sqlite')}`,
  UPLOAD_DIR: path.join(dataDir, 'uploads'),
  PUBLIC_API_URL: base,
  WECHAT_AUTH_PROVIDER: 'mock',
  PAYLOAD_DROP_DATABASE: 'false',
  HEYMORO_DIST_DIR: '.next-creation-check',
  HEYMORO_JOB_AUTORUN: 'false',
  OPENAI_API_KEY: '',
  HEYMORO_IMAGE_PROVIDER: 'fixture',
  HEYMORO_AUTOMATED_TEST: 'true',
}
let server
async function stopServer() {
  if (!server || server.exitCode !== null) return
  const closed = new Promise((resolve) => server.once('exit', resolve))
  server.kill('SIGTERM')
  await closed
}
async function startServer(extra = {}) {
  server = spawn(
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
    { cwd: root, stdio: ['ignore', log.fd, log.fd], env: { ...environment, ...extra } },
  )
  let ready = false
  for (let attempt = 0; attempt < 300; attempt++) {
    if (server.exitCode !== null) throw new Error('Isolated creation server exited')
    try {
      ready = (await fetch(`${base}/api/v1/health/ready`, { signal: AbortSignal.timeout(1500) })).ok
    } catch {}
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.ok(ready, 'isolated server must become ready')
}
async function request(route, { token, body, method = 'GET', status = 200, native = false } = {}) {
  const response = await fetch(base + (native ? '/api' : '/api/v1') + route, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  })
  assert.equal(
    response.status,
    status,
    `${method} ${route} expected ${status}, got ${response.status}: ${response.ok ? '[successful response]' : await response.clone().text()}`,
  )
  return response
}
const data = async (route, options) => {
  const result = await (await request(route, options)).json()
  assert.equal(typeof result.requestId, 'string')
  return result.data
}
const login = async () =>
  (
    await data('/auth/wechat', {
      method: 'POST',
      status: 201,
      body: { code: `mock:creation-${randomUUID()}` },
    })
  ).token
const session = (token, templateId = 'free') =>
  data('/creation-sessions', { token, method: 'POST', status: 201, body: { templateId } })
const submit = (token, sessionId, inputMediaIds = [], prompt = 'a blue forest') => ({
  token,
  method: 'POST',
  status: 201,
  body: { sessionId, prompt, inputMediaIds, clientRequestId: randomUUID() },
})
async function upload(token, bytes, type = 'image/png') {
  const form = new FormData()
  form.set(
    'file',
    new Blob([new Uint8Array(bytes)], { type }),
    type === 'image/png' ? 'reference.png' : 'reference.pdf',
  )
  return data('/media', { token, method: 'POST', status: 201, body: form })
}
async function runJobs(result = 'succeeded') {
  const worker = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/payload.mjs', 'jobs:run', '--queue', 'creation', '--limit', '20'],
    {
      cwd: root,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...environment, HEYMORO_FIXTURE_RESULT: result },
    },
  )
  const code = await new Promise((resolve) => worker.once('exit', resolve))
  assert.equal(code, 0, 'isolated durable jobs worker must exit successfully')
}
try {
  await startServer()
  const owner = await login(),
    foreign = await login()
  await request('/creation-sessions', { status: 401 })
  assert.deepEqual(await data('/creation-account', { token: owner }), {
    available: 2,
    reserved: 0,
    consumed: 0,
    configured: true,
  })
  const free = await session(owner),
    retro = await session(owner, 'retro'),
    foreignSession = await session(foreign)
  await request(`/creation-sessions/${free.id}`, { token: foreign, status: 404 })
  assert.equal(
    (
      await data(`/creation-sessions/${free.id}`, {
        token: owner,
        method: 'PATCH',
        body: { title: '  我的创作  ' },
      })
    ).title,
    '我的创作',
  )
  assert.equal((await data('/creation-sessions?page=1&limit=1', { token: owner })).totalDocs, 2)
  const input = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#112233' } })
    .png()
    .toBuffer()
  const image = await upload(owner, input),
    foreignImage = await upload(foreign, input),
    pdf = await upload(owner, Buffer.from('%PDF-1.4\n%%EOF'), 'application/pdf')
  for (const options of [
    submit(owner, retro.id),
    submit(owner, foreignSession.id),
    submit(owner, retro.id, [foreignImage.id]),
    submit(owner, retro.id, [pdf.id]),
  ]) {
    options.status = options.body.sessionId === foreignSession.id ? 404 : 400
    await request('/generations', options)
  }
  console.log(
    'PASS creation/session ownership, title/pagination, reference ownership, PDF/no-image rejection',
  )
  const options = submit(owner, retro.id, [image.id], '')
  const queued = await data('/generations', options)
  assert.equal(queued.status, 'queued')
  assert.equal(queued.provider, 'fixture')
  assert.equal(queued.outputMediaId, null)
  assert.equal((await data('/generations', { ...options, status: 200 })).id, queued.id)
  await request('/generations', {
    ...options,
    status: 409,
    body: { ...options.body, prompt: 'changed' },
  })
  const concurrent = await Promise.all(
    Array.from({ length: 3 }, () =>
      request('/generations', { ...submit(owner, free.id), status: 409 }),
    ),
  )
  assert.equal(concurrent.length, 3)
  assert.deepEqual(await data('/creation-account', { token: owner }), {
    available: 1,
    reserved: 1,
    consumed: 0,
    configured: true,
  })
  await request(`/generations/${queued.id}`, { token: foreign, status: 404 })
  await request(`/generations/${queued.id}`, {
    token: owner,
    method: 'PATCH',
    body: { status: 'succeeded' },
    status: 400,
  })
  for (const [route, method, body] of [
    ['/generations', 'POST', { owner: 1, status: 'succeeded' }],
    [`/generations/${queued.id}`, 'PATCH', { status: 'succeeded', outputMedia: image.id }],
    ['/creation-sessions', 'POST', { owner: 1, templateId: 'free', title: 'forged' }],
  ])
    await request(route, { native: true, token: owner, method, body, status: 403 })
  const graph = await request('/graphql', {
    native: true,
    token: owner,
    method: 'POST',
    body: {
      query: `mutation { updateGeneration(id: ${queued.id}, data: {status: succeeded}) { id status } }`,
    },
  })
  const graphResult = await graph.json()
  assert.ok(graphResult.errors?.length > 0)
  assert.equal(graphResult.data?.updateGeneration ?? null, null)
  await request('/payload-jobs/run', { native: true, token: owner, method: 'GET', status: 401 })
  await request(`/media/${image.id}`, { token: owner, method: 'DELETE', status: 409 })
  await runJobs()
  const output = await data(`/generations/${queued.id}`, { token: owner })
  assert.equal(output.status, 'succeeded')
  assert.notEqual(output.outputMediaId, image.id)
  const content = Buffer.from(
    await (await request(`/media/${output.outputMediaId}/content`, { token: owner })).arrayBuffer(),
  )
  assert.notDeepEqual(content, input)
  await request(`/media/${output.outputMediaId}/content`, { token: foreign, status: 404 })
  await request(`/media/${output.outputMediaId}`, { token: owner, method: 'DELETE', status: 409 })
  assert.equal(
    (
      await data(`/generations/${queued.id}`, {
        token: owner,
        method: 'PATCH',
        body: { saved: true },
      })
    ).saved,
    true,
  )
  assert.equal((await data('/artifacts?saved=true&page=1&limit=20', { token: owner })).totalDocs, 1)
  assert.equal(
    (await data('/artifacts?saved=true&page=1&limit=20', { token: foreign })).totalDocs,
    0,
  )
  assert.equal(
    (await data(`/creation-sessions/${retro.id}`, { token: owner })).generations.length,
    1,
  )
  console.log(
    'PASS durable job output persistence, owner-only retrieval, saved artifacts and input/output reference protection',
  )
  const failed = await data('/generations', submit(owner, free.id))
  await runJobs('failed')
  assert.equal((await data(`/generations/${failed.id}`, { token: owner })).status, 'failed')
  assert.deepEqual(await data('/creation-account', { token: owner }), {
    available: 1,
    reserved: 0,
    consumed: 1,
    configured: true,
  })
  const unknown = await data('/generations', submit(owner, free.id))
  await runJobs('unknown')
  assert.equal((await data(`/generations/${unknown.id}`, { token: owner })).status, 'unknown')
  assert.deepEqual(await data('/creation-account', { token: owner }), {
    available: 0,
    reserved: 1,
    consumed: 1,
    configured: true,
  })
  await runJobs()
  assert.equal((await data(`/generations/${unknown.id}`, { token: owner })).status, 'unknown')
  await request('/generations', { ...submit(owner, free.id), status: 409 })
  console.log(
    'PASS definite failure releases, ambiguous outcome reserves and never auto-repeats provider request',
  )
  const full = await session(foreign)
  const racing = await Promise.all(
    Array.from({ length: 3 }, async () => {
      const options = submit(foreign, full.id)
      const response = await fetch(base + '/api/v1/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${foreign}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(options.body),
      })
      return response.status
    }),
  )
  assert.deepEqual(racing.sort(), [201, 409, 409])
  assert.deepEqual(await data('/creation-account', { token: foreign }), {
    available: 1,
    reserved: 1,
    consumed: 0,
    configured: true,
  })
  await runJobs()
  await data('/generations', submit(foreign, full.id))
  await runJobs()
  await request('/generations', { ...submit(foreign, full.id), status: 402 })
  assert.deepEqual(await data('/creation-account', { token: foreign }), {
    available: 0,
    reserved: 0,
    consumed: 2,
    configured: true,
  })
  console.log('PASS two-credit server-enforced trial and exhausted rejection')
  await stopServer()
  await startServer({ HEYMORO_IMAGE_PROVIDER: 'openai' })
  const noConfigUser = await login(),
    noConfigSession = await session(noConfigUser)
  const rejected = await request('/generations', {
    ...submit(noConfigUser, noConfigSession.id),
    status: 503,
  })
  assert.equal((await rejected.json()).error.code, 'GENERATION_NOT_CONFIGURED')
  assert.deepEqual(await data('/creation-account', { token: noConfigUser }), {
    available: 2,
    reserved: 0,
    consumed: 0,
    configured: false,
  })
  assert.equal((await data(`/generations/${queued.id}`, { token: owner })).status, 'succeeded')
  console.log(
    'PASS unconfigured real provider rejects without reservation; sessions and completed outputs survive restart',
  )
} catch (error) {
  const contents = await readFile(path.join(dataDir, 'server.log'), 'utf8')
  console.error(
    contents
      .split('\n')
      .filter((line) => /errorName|diagnostic|Creation operation failed/.test(line))
      .join('\n'),
  )
  throw error
} finally {
  await stopServer()
  await log.close()
  await rm(dataDir, { recursive: true, force: true })
}
