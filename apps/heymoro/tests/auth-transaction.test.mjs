import test from 'node:test'
import assert from 'node:assert/strict'
import { withWriteTransaction } from '../src/service-transaction.ts'

test('SQLite begin-lock contention is retried before work, never re-running verified work', async () => {
  let begins = 0,
    work = 0,
    commits = 0
  const req = {
    payload: {
      db: {
        beginTransaction: async () => {
          if (++begins < 3) throw new Error('SQLITE_BUSY: database is locked')
          return 'tx'
        },
        commitTransaction: async () => {
          commits++
        },
      },
    },
    context: {},
  }
  assert.equal(
    await withWriteTransaction({
      req,
      work: async () => {
        work++
        return 7
      },
    }),
    7,
  )
  assert.equal(work, 1)
  assert.equal(begins, 3)
  assert.equal(commits, 1)
  assert.equal(req.transactionID, undefined)
})
test('failed identity work rolls back once without retrying external/verified work', async () => {
  let work = 0,
    rollbacks = 0
  const req = {
    payload: {
      db: {
        beginTransaction: async () => 'tx',
        rollbackTransaction: async () => {
          rollbacks++
        },
      },
    },
    context: {},
  }
  await assert.rejects(
    withWriteTransaction({
      req,
      work: async () => {
        work++
        throw new Error('WORK_FAILED')
      },
    }),
    /WORK_FAILED/,
  )
  assert.equal(work, 1)
  assert.equal(rollbacks, 1)
})

test('identity insertion failure after rollback never deletes a reused user ID', async () => {
  const { authEndpoints } = await import('../src/endpoint-auth.ts')
  const env = {
    DATABASE_URL: 'file:./unused-test.sqlite',
    PAYLOAD_SECRET: 'transaction-unit-test-only',
    UPLOAD_DIR: '/tmp/unified-unit',
    PUBLIC_API_URL: 'http://localhost:3001',
    WECHAT_AUTH_PROVIDER: 'mock',
  }
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  let deletes = 0,
    identityReads = 0
  const req = { headers: new Headers(), context: {}, json: async () => ({ code: 'mock:rollback' }) }
  req.payload = {
    collections: { users: { config: { auth: { disableLocalStrategy: true } } } },
    logger: { error() {}, warn() {} },
    db: { beginTransaction: async () => 'identity-tx', rollbackTransaction: async () => {} },
    find: async () => ({ docs: ++identityReads === 1 ? [] : [{ user: 7 }] }),
    create: async ({ collection }) => {
      if (collection === 'users') return { id: 7 }
      delete req.transactionID // mirrors a nested framework write rolling back the outer transaction
      throw new Error('IDENTITY_WRITE_FAILED')
    },
    delete: async () => {
      deletes++
    },
  }
  try {
    const response = await authEndpoints
      .find((endpoint) => endpoint.path === '/v1/auth/wechat')
      .handler(req)
    assert.equal(response.status, 502)
    assert.equal(deletes, 0)
    assert.equal(identityReads, 1)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
