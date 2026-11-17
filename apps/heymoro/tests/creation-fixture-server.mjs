// Explicit automated integration fixture, never a production or real-AI backend.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, open, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

assert.notEqual(process.env.NODE_ENV, 'production', 'fixture server is test-only')
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(path.join(tmpdir(), 'heymoro-client-fixture-'))
await mkdir(path.join(directory, 'uploads'))
const listener = net.createServer()
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise((resolve) => listener.close(resolve))
const log = await open(path.join(directory, 'server.log'), 'w', 0o600)
const base = `http://127.0.0.1:${port}`
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
      DATABASE_URL: `file:${path.join(directory, 'fixture.sqlite')}`,
      UPLOAD_DIR: path.join(directory, 'uploads'),
      PUBLIC_API_URL: base,
      WECHAT_AUTH_PROVIDER: 'mock',
      PAYLOAD_DROP_DATABASE: 'false',
      HEYMORO_DIST_DIR: '.next-creation-client-check',
      HEYMORO_JOB_AUTORUN: 'true',
      OPENAI_API_KEY: '',
      HEYMORO_IMAGE_PROVIDER: 'fixture',
      HEYMORO_AUTOMATED_TEST: 'true',
      HEYMORO_FIXTURE_RESULT: 'succeeded',
    },
  },
)
let stopped = false
async function cleanup(code = 0) {
  if (stopped) return
  stopped = true
  if (child.exitCode === null) {
    const done = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await done
  }
  await log.close()
  await rm(directory, { recursive: true, force: true })
  process.exitCode = code
}
process.once('SIGINT', () => {
  void cleanup()
})
process.once('SIGTERM', () => {
  void cleanup()
})
const lifetime = setTimeout(() => {
  void cleanup()
}, 30 * 60_000)
lifetime.unref()
try {
  let ready = false
  for (let attempt = 0; attempt < 300 && !stopped; attempt++) {
    if (child.exitCode !== null) throw new Error('Fixture backend exited before ready')
    try {
      ready = (await fetch(`${base}/api/v1/health/ready`, { signal: AbortSignal.timeout(1500) })).ok
    } catch {}
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.ok(ready, 'fixture backend must become ready')
  console.log(
    JSON.stringify({
      provider: 'fixture',
      baseUrl: base,
      pid: process.pid,
      cleanup: `kill -TERM ${process.pid}`,
      temporaryDataDir: directory,
    }),
  )
  await new Promise((resolve) => child.once('exit', resolve))
  await cleanup()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Fixture startup failed')
  await cleanup(1)
}
