import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

const module = () => import('../src/creation/infrastructure/payload/generation-consumer.ts')

test('consumer selects only explicitly configured queues', async () => {
  const { configuredGenerationQueues } = await module()
  const config = { image: {}, execution: {}, quote: {}, naming: {} }
  assert.deepEqual(configuredGenerationQueues({ config }), ['creation', 'creation-naming'])
  for (const field of ['image', 'execution', 'quote']) {
    assert.deepEqual(configuredGenerationQueues({ config: { ...config, [field]: null } }), [
      'creation-naming',
    ])
  }
  assert.deepEqual(configuredGenerationQueues({ config: { ...config, naming: null } }), [
    'creation',
  ])
})

test('unconfigured continuous consumer never queries jobs', async () => {
  const { consumeGenerationJobs } = await module()
  await consumeGenerationJobs({
    queues: [],
    isContinuous: true,
    run: () => assert.fail('unconfigured consumer must not claim work'),
  })
})

test('one-shot default preserves the bounded five-job drain with sequential execution', async () => {
  const { consumeGenerationJobs } = await module()
  const calls = []
  await consumeGenerationJobs({
    queues: ['creation', 'creation-naming'],
    run: async (args) => calls.push(args),
  })
  assert.deepEqual(calls, [
    { queue: 'creation', limit: 5, sequential: true, overrideAccess: true },
    { queue: 'creation-naming', limit: 5, sequential: true, overrideAccess: true },
  ])
})

test('already stopped consumer claims nothing and invalid polling intervals fail before work', async () => {
  const { consumeGenerationJobs } = await module()
  await consumeGenerationJobs({
    queues: ['creation'],
    signal: AbortSignal.abort(),
    run: () => assert.fail('already stopped'),
  })
  for (const intervalMs of [0, -1, 0.5, Infinity, 60_001]) {
    await assert.rejects(
      consumeGenerationJobs({
        queues: ['creation'],
        intervalMs,
        run: () => assert.fail('invalid interval'),
      }),
      /polling interval/,
    )
  }
})

test('continuous consumer serializes new rounds and stops before claiming another job', async () => {
  const { consumeGenerationJobs } = await module()
  const controller = new AbortController()
  let active = 0
  let maximum = 0
  const calls = []
  await consumeGenerationJobs({
    queues: ['creation', 'creation-naming'],
    isContinuous: true,
    intervalMs: 1,
    signal: controller.signal,
    run: async ({ queue }) => {
      active++
      maximum = Math.max(maximum, active)
      calls.push(queue)
      await sleep(2)
      active--
      if (calls.length === 3) controller.abort()
    },
  })
  assert.deepEqual(calls, ['creation', 'creation-naming', 'creation'])
  assert.equal(maximum, 1)
  assert.equal(active, 0)
})

test('stop waits for an in-flight job and does not cancel or replay it', async () => {
  const { consumeGenerationJobs } = await module()
  const controller = new AbortController()
  const started = Promise.withResolvers()
  const delivered = Promise.withResolvers()
  let calls = 0
  let isDone = false
  const consumer = consumeGenerationJobs({
    queues: ['creation', 'creation-naming'],
    isContinuous: true,
    signal: controller.signal,
    run: async () => {
      calls++
      started.resolve()
      await delivered.promise
    },
  }).then(() => {
    isDone = true
  })
  await started.promise
  controller.abort()
  await Promise.resolve()
  assert.equal(isDone, false)
  delivered.resolve()
  await consumer
  assert.equal(calls, 1)
})

test('stop interrupts idle polling, while unexpected job errors fail without retry', async () => {
  const { consumeGenerationJobs } = await module()
  const controller = new AbortController()
  const consumer = consumeGenerationJobs({
    queues: ['creation'],
    isContinuous: true,
    intervalMs: 60_000,
    signal: controller.signal,
    run: async () => {
      setImmediate(() => controller.abort())
    },
  })
  await consumer
  let calls = 0
  const error = new Error('fixture consumer failure')
  await assert.rejects(
    consumeGenerationJobs({
      queues: ['creation'],
      isContinuous: true,
      run: async () => {
        calls++
        throw error
      },
    }),
    (actual) => actual === error,
  )
  assert.equal(calls, 1)
})
