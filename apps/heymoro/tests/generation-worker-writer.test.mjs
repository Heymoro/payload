import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { createGenerationWorker } from '../src/creation/application/generation-worker.ts'
import * as workerTypes from '../src/creation/application/generation-worker-types.ts'
import { createGenerationWorkerWriter } from '../src/creation/infrastructure/payload/generation-worker-writer.ts'

test('should give the loaded worker semantic writes instead of application audit and CRUD assembly', async () => {
  assert.equal(typeof createGenerationWorker, 'function')
  assert.equal(workerTypes.workerActor, 'system:generation')
  assert.equal('workerAudit' in workerTypes, false)
  assert.equal('workerUpdate' in workerTypes, false)
  for (const name of ['generation-worker', 'generation-settlement', 'generation-funds']) {
    const source = await readFile(
      new URL(`../src/creation/application/${name}.ts`, import.meta.url),
      'utf8',
    )
    assert.doesNotMatch(source, /repository\.(?:create|updateExpected)\(/)
  }
})

const now = '2026-11-13T12:00:00.000Z'
const actor = 'system:generation'
const opaque = Object.freeze({ untrusted: true })
const facts = poisoned({
  args: {
    sha256: 'digest',
    ref: poisoned({ args: { backend: 's3', bucket: 'bucket', key: 'key' } }),
  },
})
const updateAudit = { updatedAt: now, updatedBy: actor }
const createAudit = {
  ...updateAudit,
  createdAt: now,
  createdBy: actor,
  deletedAt: null,
  deletedBy: null,
  isDeleted: false,
}
const status = (value) => ({ status: { equals: value } })
const cases = [
  [
    'recordAttemptProviderUnknown',
    { attemptId: 1, previousAttemptStatus: opaque, providerRequestId: opaque },
    'generation-attempts',
    1,
    { errorCode: 'PROVIDER_UNKNOWN', providerRequestId: opaque, status: 'unknown' },
    status(opaque),
  ],
  [
    'recordTaskProviderUnknown',
    { taskId: 2, previousTaskStatus: undefined },
    'generation-tasks',
    2,
    { errorCode: 'PROVIDER_UNKNOWN', status: 'unknown' },
    status(undefined),
  ],
  [
    'recordAttemptOutput',
    {
      attemptId: 1,
      previousAttemptStatus: opaque,
      providerRequestId: undefined,
      isClosed: false,
      facts,
    },
    'generation-attempts',
    1,
    {
      providerRequestId: undefined,
      resultSha256: 'digest',
      resultStorageBackend: 's3',
      resultStorageBucket: 'bucket',
      resultStorageKey: 'key',
      status: 'output_ready',
    },
    status(opaque),
  ],
  [
    'expirePreparedAttempt',
    { attemptId: 1 },
    'generation-attempts',
    1,
    { errorCode: 'NOT_SENT', finishedAt: now, status: 'failed' },
    { and: [status('prepared'), { leaseUntil: { less_than_equal: now } }] },
  ],
  [
    'insertPreparedAttempt',
    { attemptNo: 2, leaseUntil: 'lease', model: 'model', provider: 'provider', taskId: 2 },
    'generation-attempts',
    null,
    {
      attemptNo: 2,
      leaseUntil: 'lease',
      model: 'model',
      provider: 'provider',
      startedAt: now,
      status: 'prepared',
      taskId: 2,
    },
  ],
  [
    'recordTaskRunning',
    { taskId: 2, previousTaskStatus: null, startedAt: opaque },
    'generation-tasks',
    2,
    { startedAt: opaque, status: 'running' },
    status(null),
  ],
  [
    'recordAttemptSending',
    { attemptId: 1 },
    'generation-attempts',
    1,
    { status: 'sending' },
    { and: [status('prepared'), { leaseUntil: { greater_than: now } }] },
  ],
  [
    'closeUnknownTask',
    { taskId: 2, actor: 'admin:12' },
    'generation-tasks',
    2,
    { errorCode: 'UNKNOWN_CLOSED', finishedAt: now, status: 'closed', updatedBy: 'admin:12' },
    status('unknown'),
  ],
  [
    'appendUnknownCloseAudit',
    {
      taskId: 2,
      attemptId: opaque,
      actor: 'admin:12',
      operationId: 'operation',
      reason: 'REVIEWED',
    },
    'auditLogs',
    null,
    {
      ...createAudit,
      createdBy: 'admin:12',
      updatedBy: 'admin:12',
      action: 'GENERATION_UNKNOWN_CLOSED',
      actorId: '12',
      actorType: 'admin',
      afterState: { attemptId: opaque, status: 'closed' },
      beforeState: { attemptId: opaque, status: 'unknown' },
      correlationId: 'operation',
      requestId: 'operation',
      resourceId: '2',
      resourceType: 'generation-task',
      result: 'success',
      summary: { reason: 'REVIEWED', taskId: 2 },
    },
  ],
  [
    'insertDeliveredArtifact',
    { mediaId: 3, sessionId: opaque, taskId: 2, userId: undefined },
    'artifacts',
    null,
    { mediaId: 3, outputIndex: 1, sessionId: opaque, taskId: 2, userId: undefined },
  ],
  [
    'recordAttemptSucceeded',
    { attemptId: 1 },
    'generation-attempts',
    1,
    { errorCode: null, finishedAt: now, status: 'succeeded' },
    status('output_ready'),
  ],
  [
    'recordTaskSucceeded',
    { taskId: 2, previousTaskStatus: opaque },
    'generation-tasks',
    2,
    { errorCode: null, finishedAt: now, status: 'succeeded' },
    status(opaque),
  ],
  [
    'recordSessionDelivery',
    {
      sessionId: 4,
      artifactId: opaque,
      expectedTitleSource: undefined,
      expectedAutoNameStatus: opaque,
      namingStatus: null,
    },
    'creation-sessions',
    4,
    { autoNameStatus: null, coverArtifactId: opaque, lastActivityAt: now },
    { and: [{ titleSource: { equals: undefined } }, { autoNameStatus: { equals: opaque } }] },
  ],
  [
    'recordAttemptFailed',
    { attemptId: 1, reason: 'NOT_SENT', previousAttemptStatus: opaque, providerRequestId: null },
    'generation-attempts',
    1,
    { errorCode: 'NOT_SENT', finishedAt: now, providerRequestId: null, status: 'failed' },
    status(opaque),
  ],
  [
    'recordTaskFailed',
    { taskId: 2, reason: 'PROVIDER_REJECTED' },
    'generation-tasks',
    2,
    { errorCode: 'PROVIDER_REJECTED', finishedAt: now, status: 'failed' },
    status('running'),
  ],
  [
    'settleGenerationAllocation',
    { allocationId: 5, operation: 'release', isExpired: true },
    'credit-allocations',
    5,
    { status: 'expired' },
    status('reserved'),
  ],
  [
    'settleGenerationReservation',
    { reservationId: 6, operation: 'capture', previousReservationStatus: opaque },
    'credit-reservations',
    6,
    { settledAt: now, status: 'captured' },
    status(opaque),
  ],
]
function poisoned({ args }) {
  for (const key of ['unexpected', 'data', 'where', 'expected', 'collection', 'patch']) {
    Object.defineProperty(args, key, {
      enumerable: true,
      get: () => assert.fail(`Extra ${key} read`),
    })
  }
  return args
}
for (const [method, args, collection, id, fields, expected] of cases) {
  test(`should map ${method} with complete physical fields and the same request`, async () => {
    const createWriter = createGenerationWorkerWriter
    const req = { transactionID: 'same-request' }
    const calls = []
    const returned = {
      id: opaque,
      get unexpected() {
        assert.fail('Projection read extra')
      },
    }
    const runtime = {
      create: async (call) => {
        calls.push(call)
        return returned
      },
      updateExpected: async (call) => {
        calls.push(call)
        return returned
      },
    }
    const writer = createWriter({ req, runtime })
    const result = await writer[method](poisoned({ args: { ...args, now } }))
    const data = { ...(id === null ? createAudit : updateAudit), ...fields }
    assert.deepEqual(calls, [{ collection, req, ...(id === null ? {} : { id, expected }), data }])
    assert.equal(calls[0].req, req)
    for (const key of [
      'previousAttemptStatus',
      'previousTaskStatus',
      'previousReservationStatus',
    ]) {
      if (Object.hasOwn(args, key)) assert.equal(calls[0].expected.status.equals, args[key])
    }
    if (method === 'recordSessionDelivery') {
      assert.equal(calls[0].expected.and[0].titleSource.equals, args.expectedTitleSource)
      assert.equal(calls[0].expected.and[1].autoNameStatus.equals, args.expectedAutoNameStatus)
      assert.equal(calls[0].data.coverArtifactId, args.artifactId)
    }
    if (method === 'appendUnknownCloseAudit') {
      assert.equal(calls[0].data.beforeState.attemptId, args.attemptId)
      assert.equal(calls[0].data.afterState.attemptId, args.attemptId)
    }
    if (method === 'insertPreparedAttempt' || method === 'insertDeliveredArtifact') {
      assert.deepEqual(result, { id: opaque })
      assert.equal(result.id, opaque)
    } else assert.equal(result, undefined)
    for (const value of Object.values(calls[0].data)) {
      if (value && typeof value === 'object' && 'untrusted' in value) assert.equal(value, opaque)
    }
    const error = new Error(method)
    const broken = createWriter({
      req,
      runtime: {
        create: async () => {
          throw error
        },
        updateExpected: async () => {
          throw error
        },
      },
    })
    await assert.rejects(broken[method]({ ...args, now }), (actual) => actual === error)
  })
}

async function runtimeFixture({
  response = { docs: [{ id: 1 }], errors: [] },
  leaseUntil = now,
} = {}) {
  const { createCreationRuntime } =
    await import('../src/creation/infrastructure/payload/session-repository.ts')
  const { createCreationWriteGate } =
    await import('../src/creation/infrastructure/payload/write-gate.ts')
  const { creationCollectionSlugs } =
    await import('../src/creation/infrastructure/payload/collections.ts')
  const gate = createCreationWriteGate()
  const transaction = {}
  const req = { transactionID: 'transaction' }
  const binding = gate.bind({
    req,
    transactionID: 'transaction',
    transaction,
    sessions: { transaction: { db: transaction } },
    assertLease: () => {},
  })
  const calls = []
  const payload = {
    collections: Object.fromEntries(
      [...creationCollectionSlugs, 'users', 'media', 'auditLogs'].map((slug) => [
        slug,
        {
          config: {
            hooks: { beforeOperation: [gate.beforeOperation] },
            flattenedFields: [{ name: 'status' }],
          },
        },
      ]),
    ),
    update: async (args) => {
      calls.push(args)
      return typeof response === 'function' ? response({ args, leaseUntil }) : response
    },
  }
  const runtime = createCreationRuntime({ payload, gate })
  const writer = createGenerationWorkerWriter({ req, runtime })
  return { binding, calls, req, writer }
}
for (const [name, response] of [
  ['zero rows', { docs: [], errors: [] }],
  ['two rows', { docs: [{ id: 1 }, { id: 1 }], errors: [] }],
  ['errors', { docs: [{ id: 1 }], errors: [{ message: 'invalid' }] }],
  ['wrong identity', { docs: [{ id: 2 }], errors: [] }],
]) {
  test(`should abort the real request capability on ${name}`, async () => {
    const { binding, calls, req, writer } = await runtimeFixture({ response })
    await assert.rejects(
      writer.recordAttemptSending({ attemptId: 1, now }),
      /conditional creation|identity mismatch/,
    )
    assert.throws(() => binding.assert(), /aborted/)
    assert.equal(calls[0].req, req)
    assert.deepEqual(calls[0].where, {
      and: [
        { id: { equals: 1 } },
        { and: [status('prepared'), { leaseUntil: { greater_than: now } }] },
      ],
    })
    binding.close()
  })
}
for (const [relation, leaseUntil] of [
  ['before', '2026-11-13T11:59:59.999Z'],
  ['equal', now],
  ['after', '2026-11-13T12:00:00.001Z'],
]) {
  for (const method of ['expirePreparedAttempt', 'recordAttemptSending']) {
    test(`should preserve the ${method} lease boundary ${relation} now through the real runtime`, async () => {
      const isMatch = method === 'expirePreparedAttempt' ? leaseUntil <= now : leaseUntil > now
      const fixture = await runtimeFixture({
        leaseUntil,
        response: ({ args, leaseUntil: lease }) => {
          const expected = args.where.and[1].and[1].leaseUntil
          const matches =
            'greater_than' in expected
              ? lease > expected.greater_than
              : lease <= expected.less_than_equal
          return { docs: matches ? [{ id: 1 }] : [], errors: [] }
        },
      })
      if (isMatch) {
        assert.equal(await fixture.writer[method]({ attemptId: 1, now }), undefined)
        fixture.binding.assert()
      } else {
        await assert.rejects(fixture.writer[method]({ attemptId: 1, now }), /exactly one/)
        assert.throws(() => fixture.binding.assert(), /aborted/)
      }
      fixture.binding.close()
    })
  }
}
test('should keep a closed late output unknown without extending lease or changing finish/error facts', async () => {
  const calls = []
  const writer = createGenerationWorkerWriter({
    req: {},
    runtime: {
      updateExpected: async (args) => {
        calls.push(args)
        return { id: 1 }
      },
    },
  })
  await writer.recordAttemptOutput({
    attemptId: 1,
    now,
    previousAttemptStatus: 'unknown',
    providerRequestId: opaque,
    facts,
    isClosed: true,
  })
  assert.equal(calls[0].data.status, 'unknown')
  for (const key of ['errorCode', 'finishedAt', 'leaseUntil'])
    assert.equal(key in calls[0].data, false)
})
for (const [operation, isExpired, expected] of [
  ['capture', true, 'captured'],
  ['capture', false, 'captured'],
  ['release', true, 'expired'],
  ['release', false, 'released'],
]) {
  test(`should map allocation ${operation} expiry ${isExpired} to ${expected}`, async () => {
    const calls = []
    const writer = createGenerationWorkerWriter({
      req: {},
      runtime: {
        updateExpected: async (args) => {
          calls.push(args)
          return { id: 1 }
        },
      },
    })
    await writer.settleGenerationAllocation({ allocationId: 1, now, operation, isExpired })
    assert.equal(calls[0].data.status, expected)
  })
}

test('should preserve an original Local API error and abort through the real runtime', async () => {
  const error = new Error('local-update')
  const fixture = await runtimeFixture({
    response: () => {
      throw error
    },
  })
  await assert.rejects(
    fixture.writer.recordAttemptSending({ attemptId: 1, now }),
    (actual) => actual === error,
  )
  assert.throws(() => fixture.binding.assert(), /aborted/)
  fixture.binding.close()
})
