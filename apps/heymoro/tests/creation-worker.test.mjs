import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

const directory = await mkdtemp(path.join(tmpdir(), 'heymoro-worker-unit-'))
const previous = { ...process.env }
Object.assign(process.env, {
  UPLOAD_DIR: directory,
  HEYMORO_IMAGE_PROVIDER: 'fixture',
  HEYMORO_AUTOMATED_TEST: 'true',
  NODE_ENV: 'test',
})
const { runGeneration } = await import('../src/service-creation.ts')
test.after(async () => {
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
  Object.assign(process.env, previous)
  await rm(directory, { recursive: true, force: true })
})
function request({
  status = 'queued',
  commitErrorAfterSuccess = false,
  completionFails = false,
} = {}) {
  let document = {
    id: 1,
    owner: 2,
    status,
    provider: 'fixture',
    model: 'fixture',
    systemPrompt: 'server only',
    prompt: 'hello',
    inputMediaIds: [],
  }
  let transactionSnapshot
  let media = null,
    outputUpdates = 0,
    hasLostAcknowledgement = false
  const req = {
    context: {},
    payload: {
      db: {
        beginTransaction: async () => {
          transactionSnapshot = structuredClone(document)
          return 'tx'
        },
        commitTransaction: async () => {
          if (
            commitErrorAfterSuccess &&
            document.status === 'succeeded' &&
            !hasLostAcknowledgement
          ) {
            hasLostAcknowledgement = true
            throw new Error('COMMIT_ACK_LOST')
          }
        },
        rollbackTransaction: async () => {
          if (!(commitErrorAfterSuccess && document.status === 'succeeded')) {
            document = transactionSnapshot
            media = null
          }
        },
      },
      findByID: async ({ collection }) =>
        collection === 'generations' ? structuredClone(document) : media,
      create: async ({ data }) => {
        media = { ...data, id: 50 }
        return media
      },
      update: async ({ data }) => {
        if (data.status === 'succeeded') {
          outputUpdates++
          if (completionFails) throw new Error('WRITE_FAILED')
        }
        document = { ...document, ...data }
        return structuredClone(document)
      },
    },
  }
  return { req, getDocument: () => document, getOutputUpdates: () => outputUpdates }
}
test('should not repeat unknown or already running provider requests', async () => {
  for (const status of ['unknown', 'succeeded', 'failed', 'running']) {
    const state = request({ status })
    await runGeneration({ req: state.req, generationId: 1 })
    assert.equal(state.getOutputUpdates(), 0)
    assert.equal(state.getDocument().status, status === 'running' ? 'unknown' : status)
  }
})
test('should preserve reserved credit and remove uncommitted output when completion persistence fails', async () => {
  const before = await readdir(directory)
  const state = request({ completionFails: true })
  await runGeneration({ req: state.req, generationId: 1 })
  assert.equal(state.getDocument().status, 'unknown')
  assert.equal(state.getDocument().outputMedia, undefined)
  assert.deepEqual(await readdir(directory), before)
})
test('should keep committed output when database commit succeeds but acknowledgement is lost', async () => {
  const before = await readdir(directory)
  const state = request({ commitErrorAfterSuccess: true })
  await runGeneration({ req: state.req, generationId: 1 })
  assert.equal(state.getDocument().status, 'succeeded')
  assert.equal(state.getDocument().outputMedia, 50)
  assert.equal((await readdir(directory)).length, before.length + 1)
})
