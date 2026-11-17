import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const load = () => import('../src/creation/infrastructure/payload/sqlite-begin-transaction.ts')
const busy = (code = 'SQLITE_BUSY') => Object.assign(new Error('synthetic contention'), { code })

for (const result of [null, 'transaction-id', 42]) {
  test(`begin acquisition preserves receiver, exact parameter list and result ${result}`, async () => {
    const { createSQLiteBeginTransaction } = await load()
    const receiver = {},
      options = { behavior: 'deferred' },
      seen = []
    const wrapped = createSQLiteBeginTransaction({
      beginTransaction: function (...args) {
        seen.push({ receiver: this, args })
        return Promise.resolve(result)
      },
      wait: async () => assert.fail('Successful acquisition must not wait'),
    })
    assert.equal(await wrapped.call(receiver, options), result)
    assert.equal(seen[0].receiver, receiver)
    assert.equal(seen[0].args[0], options)
    assert.equal(seen[0].args.length, 1)
    await wrapped.call(receiver)
    assert.equal(seen[1].args.length, 0)
    await wrapped.call(receiver, null)
    assert.equal(seen[2].args[0], null)
  })
}

for (const error of [
  busy(),
  busy('SQLITE_BUSY_SNAPSHOT'),
  new Error('outer', { cause: busy() }),
  new Error('Error: cannot begin transaction: SQLITE_BUSY: database is locked'),
  new Error('Error: cannot begin transaction: SQLITE_BUSY_SNAPSHOT: database is locked'),
]) {
  test(`recognized acquisition contention retries once then returns immediately (${error.code || 'wrapped'})`, async () => {
    const { createSQLiteBeginTransaction } = await load()
    let begins = 0
    const delays = []
    const wrapped = createSQLiteBeginTransaction({
      beginTransaction() {
        if (++begins === 1) throw error
        return Promise.resolve('acquired')
      },
      wait: async ({ delayMs }) => delays.push(delayMs),
    })
    assert.equal(await wrapped(), 'acquired')
    assert.equal(begins, 2)
    assert.deepEqual(delays, [25])
  })
}

test('single begin invocation exhausts exactly six calls and five waits, preserving last error identity', async () => {
  const { createSQLiteBeginTransaction } = await load()
  const errors = Array.from({ length: 6 }, () => busy()),
    delays = []
  let begins = 0
  const wrapped = createSQLiteBeginTransaction({
    beginTransaction: async () => {
      throw errors[begins++]
    },
    wait: async ({ delayMs }) => delays.push(delayMs),
  })
  await assert.rejects(wrapped(), (error) => error === errors[5])
  assert.equal(begins, 6)
  assert.deepEqual(delays, [25, 50, 100, 200, 400])
})

const cyclic = busy()
cyclic.cause = cyclic
let deep = busy()
for (let i = 0; i < 10; i++) deep = new Error('layer', { cause: deep })
const getter = new Error('getter')
Object.defineProperty(getter, 'code', {
  get() {
    throw Error('private getter')
  },
})
for (const error of [
  new Error('unknown'),
  { code: 'SQLITE_LOCKED', cause: busy() },
  { code: 'SQLITE_IOERR', message: 'SQLITE_BUSY' },
  { code: 'UNKNOWN', message: 'Error: cannot begin transaction: SQLITE_BUSY: database is locked' },
  new Error('SQLITE_BUSY: database is locked'),
  new Error('prefix Error: cannot begin transaction: SQLITE_BUSY: database is locked'),
  new Error('Error: cannot begin transaction: SQLITE_BUSY_SNAPSHOT_EXTRA: locked'),
  new Error('Error: cannot begin transaction: SQLITE_BUSYNESS: locked'),
  new Error('Error: cannot begin transaction: '),
  { code: null },
  cyclic,
  deep,
  getter,
]) {
  test('unknown, contradictory, misleading or uninspectable failures escape unchanged without waiting', async () => {
    const { createSQLiteBeginTransaction } = await load()
    let calls = 0
    const wrapped = createSQLiteBeginTransaction({
      beginTransaction: async () => {
        calls++
        throw error
      },
      wait: async () => assert.fail('Unknown acquisition must not retry'),
    })
    await assert.rejects(wrapped(), (value) => value === error)
    assert.equal(calls, 1)
  })
}

test('cause properties are snapshotted once; concurrent begin calls have independent budgets', async () => {
  const { createSQLiteBeginTransaction } = await load()
  const reads = { code: 0, cause: 0 },
    error = {}
  Object.defineProperties(error, {
    code: {
      get() {
        reads.code++
        return 'SQLITE_BUSY'
      },
    },
    cause: {
      get() {
        reads.cause++
        return undefined
      },
    },
  })
  const counts = new Map(),
    delays = []
  const wrapped = createSQLiteBeginTransaction({
    beginTransaction: async function ({ key }) {
      const count = (counts.get(key) || 0) + 1
      counts.set(key, count)
      if (count === 1) throw error
      return key
    },
    wait: async ({ delayMs }) => delays.push(delayMs),
  })
  assert.deepEqual(await Promise.all([wrapped({ key: 'a' }), wrapped({ key: 'b' })]), ['a', 'b'])
  assert.deepEqual(reads, { code: 2, cause: 2 })
  assert.deepEqual(delays, [25, 25])
})

test('the decorator only acquires; later work, commit and rollback failures are never replayed', async () => {
  const { createSQLiteBeginTransaction } = await load()
  let calls = 0
  const wrapped = createSQLiteBeginTransaction({
    beginTransaction: async () => {
      calls++
      return 'id'
    },
    wait: async () => assert.fail('No retry after acquisition'),
  })
  assert.equal(await wrapped(), 'id')
  for (const stage of ['work', 'commit', 'rollback']) {
    const failure = busy()
    await assert.rejects(
      (async () => {
        throw failure
      })(),
      (value) => value === failure,
      stage,
    )
  }
  assert.equal(calls, 1)
})

async function withNative({ run }) {
  const { createClient } = await import('@libsql/client')
  const { drizzle } = await import('drizzle-orm/libsql')
  const { beginTransaction } =
    await import('../../../packages/drizzle/src/transactions/beginTransaction.ts')
  const { createSQLiteBeginTransaction } = await load()
  const directory = mkdtempSync(path.join(tmpdir(), 'heymoro-begin-test-'))
  const writer = createClient({ url: `file:${path.join(directory, 'synthetic.sqlite')}` })
  const reader = createClient({ url: `file:${path.join(directory, 'synthetic.sqlite')}` })
  let held
  const logged = [],
    adapter = {
      initializing: Promise.resolve(),
      drizzle: drizzle(reader),
      sessions: {},
      transactionOptions: { behavior: 'deferred' },
      payload: {
        logger: {
          error({ err }) {
            logged.push(err.code)
          },
        },
      },
    }
  try {
    await writer.execute('PRAGMA journal_mode=WAL')
    await writer.execute('CREATE TABLE synthetic(id INTEGER)')
    held = await writer.transaction('write')
    await run({
      adapter,
      logged,
      beginTransaction,
      createSQLiteBeginTransaction,
      closeReader: () => reader.close(),
      release: async () => {
        await held.rollback()
        held.close()
        held = null
      },
    })
  } finally {
    try {
      for (const [id, session] of Object.entries(adapter.sessions)) {
        await session.reject()
        delete adapter.sessions[id]
      }
      if (held) {
        await held.rollback()
        held.close()
      }
    } finally {
      writer.close()
      reader.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

test('real unchanged framework wraps BUSY before registering a session; injected wait releases writer and one acquisition succeeds', async () => {
  await withNative({
    run: async ({ adapter, logged, beginTransaction, createSQLiteBeginTransaction, release }) => {
      const delays = []
      const wrapped = createSQLiteBeginTransaction({
        beginTransaction,
        wait: async ({ delayMs }) => {
          assert.equal(Object.keys(adapter.sessions).length, 0)
          assert.deepEqual(logged, ['SQLITE_BUSY'])
          delays.push(delayMs)
          await release()
        },
      })
      const id = await wrapped.call(adapter)
      assert.equal(typeof id, 'string')
      assert.deepEqual(delays, [25])
      assert.deepEqual(Object.keys(adapter.sessions), [id])
      await adapter.sessions[id].reject()
      delete adapter.sessions[id]
      assert.equal(Object.keys(adapter.sessions).length, 0)
    },
  })
})

test('real held writer exhausts the bounded begin budget without registering any session', async () => {
  await withNative({
    run: async ({ adapter, logged, beginTransaction, createSQLiteBeginTransaction }) => {
      const delays = []
      let lastError
      const wrapped = createSQLiteBeginTransaction({
        beginTransaction: async function (...args) {
          try {
            return await beginTransaction.apply(this, args)
          } catch (error) {
            lastError = error
            throw error
          }
        },
        wait: async ({ delayMs }) => delays.push(delayMs),
      })
      await assert.rejects(
        wrapped.call(adapter),
        (error) => error === lastError && error.code === undefined && error.cause === undefined,
      )
      assert.deepEqual(logged, Array(6).fill('SQLITE_BUSY'))
      assert.deepEqual(delays, [25, 50, 100, 200, 400])
      assert.deepEqual(Object.keys(adapter.sessions), [])
    },
  })
})

test('real framework unknown acquisition error remains one failure and registers no session', async () => {
  await withNative({
    run: async ({
      adapter,
      logged,
      beginTransaction,
      createSQLiteBeginTransaction,
      closeReader,
    }) => {
      closeReader()
      const wrapped = createSQLiteBeginTransaction({
        beginTransaction,
        wait: async () => assert.fail('Unknown framework error must not retry'),
      })
      await assert.rejects(
        wrapped.call(adapter),
        /Error: cannot begin transaction: The database connection is not open/,
      )
      assert.equal(logged.length, 1)
      assert(!['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT'].includes(logged[0]))
      assert.deepEqual(Object.keys(adapter.sessions), [])
    },
  })
})

test('formal composition installs retry on the real native adapter init and keeps its connect target guard', async () => {
  const { buildCorePayloadConfig } = await import('../src/creation/runtime/payload-config.ts')
  const { prepareTarget } = await import('../src/creation/runtime/target-profile.ts')
  const { hostConfig } = await import('./creation/runtime-seed.ts')
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'heymoro-begin-wiring-'))),
    dataDir = path.join(directory, 'target')
  const previous = process.env.NODE_ENV
  try {
    process.env.NODE_ENV = 'test'
    const config = await buildCorePayloadConfig({
      config: hostConfig({ dataDir }),
      initialization: prepareTarget({ dataDir }),
    })
    const codes = [],
      adapter = config.db.init({
        payload: {
          logger: {
            error({ err }) {
              codes.push(err.code)
            },
          },
        },
      })
    adapter.initializing = Promise.resolve()
    adapter.drizzle = {
      transaction: () =>
        Promise.reject(
          Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' }),
        ),
    }
    await assert.rejects(adapter.beginTransaction(), /SQLITE_BUSY/)
    assert.deepEqual(codes, Array(6).fill('SQLITE_BUSY'))
    assert.deepEqual(Object.keys(adapter.sessions), [])
    await assert.rejects(adapter.connect(), /schema|target|initialization/i)
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
