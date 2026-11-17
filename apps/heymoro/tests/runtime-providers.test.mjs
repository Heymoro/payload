import assert from 'node:assert/strict'
import test from 'node:test'

test('lazy Redis construction has zero IO, shares first connect, and closes once', async () => {
  const { createLazyRedis } = await import('../src/creation/runtime/providers.ts')
  let connected = 0
  let closed = 0
  const owned = createLazyRedis({
    connect: async () => {
      connected++
      return {
        client: { set: async () => 'OK', eval: async () => 1 },
        close: async () => {
          closed++
        },
      }
    },
  })
  assert.equal(connected, 0)
  await Promise.all([owned.client.set('a', 'o', 'PX', 10, 'NX'), owned.client.eval('s', 1, 'a')])
  assert.equal(connected, 1)
  await Promise.all([owned.close(), owned.close()])
  assert.equal(closed, 1)
  await assert.rejects(owned.client.eval('s', 1, 'a'))
})
test('failed Redis connect clears pending for next explicit call; close drains late connect', async () => {
  const { createLazyRedis } = await import('../src/creation/runtime/providers.ts')
  let calls = 0
  const owned = createLazyRedis({
    connect: async () => {
      if (++calls === 1) throw new Error('offline')
      return { client: { set: async () => 'OK', eval: async () => 1 }, close: async () => {} }
    },
  })
  await assert.rejects(owned.client.eval('s', 1))
  assert.equal(await owned.client.eval('s', 1), 1)
  assert.equal(calls, 2)
  await owned.close()
})
test('S3 first operations singleflight probes while synchronous verified evidence keeps identity', async () => {
  const { createVerifiedStorage } = await import('../src/creation/runtime/providers.ts')
  let probes = 0
  const facts = {}
  const inner = {
    verifyBackend: async () => {
      probes++
    },
    getVerified: async () => facts,
    assertVerified: ({ facts: value }) => assert.equal(value, facts),
    close: () => {},
  }
  const storage = createVerifiedStorage({ inner })
  const ref = { backend: 'local', bucket: 'bucket', key: 'key' }
  const results = await Promise.all([storage.getVerified({ ref }), storage.getVerified({ ref })])
  assert.equal(probes, 1)
  assert.equal(results[0], facts)
  storage.assertVerified({ facts, ref })
  await storage.close()
  await assert.rejects(storage.getVerified({ ref }))
})

test('actual unavailable Redis and S3 endpoints are untouched at construction and fail first operations', async () => {
  const { createRuntimeProviders } = await import('../src/creation/runtime/providers.ts')
  const { hostConfig } = await import('./creation/runtime-seed.ts')
  const providers = createRuntimeProviders({
    config: hostConfig({ dataDir: '/unused/core-target' }),
  })
  try {
    await assert.rejects(
      providers.coordinate({
        resource: 'offline-test',
        work: async () => assert.fail('must not enter write'),
      }),
      (error) => error.status === 503,
    )
    await assert.rejects(
      providers.storage.getVerified({
        ref: {
          backend: 'fixture-metadata',
          bucket: 'fixture-input',
          key: 'references/1/00000000-0000-0000-0000-000000000000/' + 'a'.repeat(64),
        },
      }),
    )
  } finally {
    await providers.close()
  }
})

test('late Redis connect is drained by concurrent close without issuing commands', async () => {
  const { createLazyRedis } = await import('../src/creation/runtime/providers.ts')
  let resolveConnect
  let closed = 0
  let commands = 0
  const pending = new Promise((resolve) => {
    resolveConnect = resolve
  })
  const owned = createLazyRedis({ connect: () => pending })
  const operation = owned.client.eval('test', 1)
  await Promise.resolve()
  const closing = owned.close()
  resolveConnect({
    client: {
      eval: async () => {
        commands++
        return 1
      },
      set: async () => 'OK',
    },
    close: async () => {
      closed++
    },
  })
  await assert.rejects(operation)
  await Promise.all([closing, owned.close()])
  assert.equal(closed, 1)
  assert.equal(commands, 0)
})
test('S3 failed probe clears pending; closing an in-flight probe prevents late object IO', async () => {
  const { createVerifiedStorage } = await import('../src/creation/runtime/providers.ts')
  let probes = 0
  let reads = 0
  let closed = 0
  let release
  const barrier = new Promise((resolve) => {
    release = resolve
  })
  const inner = {
    verifyBackend: async () => {
      if (++probes === 1) throw Error('offline')
      await barrier
    },
    getVerified: async () => {
      reads++
      return {}
    },
    assertVerified: () => {},
    close: () => {
      closed++
    },
  }
  const storage = createVerifiedStorage({ inner })
  const args = { ref: { backend: 'local', bucket: 'bucket', key: 'key' } }
  await assert.rejects(storage.getVerified(args))
  const operation = storage.getVerified(args)
  await Promise.resolve()
  await Promise.resolve()
  const closing = storage.close()
  release()
  await assert.rejects(operation)
  await Promise.all([closing, storage.close()])
  assert.equal(probes, 2)
  assert.equal(reads, 0)
  assert.equal(closed, 1)
})

test('Redis close drains accepted eval and set commands on resolution and rejection', async (t) => {
  const { createLazyRedis } = await import('../src/creation/runtime/providers.ts')
  for (const method of ['eval', 'set'])
    for (const outcome of ['resolve', 'reject']) {
      await t.test(`${method} ${outcome}`, async () => {
        let started
        const issued = new Promise((resolve) => {
          started = resolve
        })
        let resolveCommand
        let rejectCommand
        const deferred = new Promise((resolve, reject) => {
          resolveCommand = resolve
          rejectCommand = reject
        })
        let closed = 0
        let commands = 0
        const command = () => {
          commands++
          started()
          return deferred
        }
        const owned = createLazyRedis({
          connect: async () => ({
            client: { eval: command, set: command },
            close: async () => {
              closed++
            },
          }),
        })
        const operation =
          method === 'eval'
            ? owned.client.eval('test', 1)
            : owned.client.set('key', 'owner', 'PX', 10, 'NX')
        const observed = operation.then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        await issued
        let isCloseSettled = false
        const first = owned.close()
        const second = owned.close()
        first.then(() => {
          isCloseSettled = true
        })
        try {
          await new Promise((resolve) => setImmediate(resolve))
          assert.equal(closed, 0, 'owner must stay open while an accepted command is pending')
          assert.equal(isCloseSettled, false)
          await assert.rejects(owned.client.eval('late', 1))
        } finally {
          if (outcome === 'resolve') resolveCommand(method === 'eval' ? 1 : 'OK')
          else rejectCommand(new Error('fixture command failure'))
          await Promise.all([observed, first, second])
        }
        const result = await observed
        if (outcome === 'resolve') assert.equal(result.value, method === 'eval' ? 1 : 'OK')
        else assert.match(result.error.message, /fixture command failure/)
        assert.equal(closed, 1)
        assert.equal(commands, 1)
      })
    }
})
