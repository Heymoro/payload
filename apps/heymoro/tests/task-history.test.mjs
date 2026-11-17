import assert from 'node:assert/strict'
import test from 'node:test'
import { createOwnerTaskHistory } from '../src/creation/application/owner-task-history.ts'
const cursorKey = new Uint8Array(32).fill(9)
test('rejects strict unknown query before snapshot IO', async () => {
  let reads = 0
  const service = createOwnerTaskHistory({
    cursorKey,
    read: async () => {
      reads++
      throw Error('unexpected IO')
    },
  })
  await assert.rejects(() => service.list({ userId: 1, sessionId: 2, query: { saved: 'false' } }), {
    code: 'INPUT_INVALID',
  })
  assert.equal(reads, 0)
})

import { createHmac } from 'node:crypto'
import { hashTaskClientInput } from '../src/creation/domain/input.ts'
import {
  createTaskHistoryCursor,
  normalizeTaskHistoryQuery,
} from '../src/creation/domain/task-history.ts'
import { assertGenerationAttempts } from '../src/creation/domain/generation-attempts.ts'
const time = '2026-11-12T00:00:00.000Z'
const deletion = { isDeleted: false, deletedAt: null, deletedBy: null }
function fixture(count = 1, options = {}) {
  const input = { inputMediaIds: [], description: '  original\n ', userNotes: '' }
  const clientInput = { operation: 'generate', sessionId: 2, input }
  const snapshot = {
    schemaVersion: 1,
    clientInput,
    input,
    mode: 'free',
    templateId: 3,
    templateVersionId: 4,
    executionPlan: {
      executorId: 'x',
      provider: 'p',
      model: 'm',
      parameters: {},
      systemPrompt: 'PRIVATE',
    },
    media: [],
    storageOutput: { backend: 'fixture', bucket: 'output', keyRule: 'task-attempt-result-v1' },
    quote: { costCredits: 0, issuedAt: time, validUntil: '2026-11-12T00:01:00.000Z' },
  }
  const tasks = Array.from({ length: count }, (_, index) => ({
    ...deletion,
    id: index + 10,
    userId: 1,
    sessionId: 2,
    templateId: 3,
    sourceTaskId: null,
    roundNo: index + 1,
    clientRequestId: `request-${index}`,
    status: 'queued',
    costCredits: 0,
    errorCode: null,
    description: input.description,
    userNotes: '',
    executionSnapshotJson: JSON.stringify(snapshot),
    requestHash: hashTaskClientInput({ clientInput }),
    createdAt: time,
    startedAt: null,
    finishedAt: null,
  }))
  let calls = 0
  const parent = {
    ...deletion,
    id: 2,
    userId: 1,
    templateId: 3,
    mode: 'free',
    nextRoundNo: count + 1,
  }
  const reader = {
    library: { actor: async () => [{ id: 1, status: 'active', isDeleted: false }] },
    tasks: async ({ ids }) => tasks.filter((row) => ids.includes(row.id)),
    sessions: async () => [parent],
    scan: async ({ after, limit }) =>
      tasks
        .filter((row) => !after || row.roundNo < after.roundNo)
        .toReversed()
        .slice(0, limit),
    rounds: async ({ tuples }) =>
      tasks.filter((row) =>
        tuples.some((tuple) => tuple.sessionId === row.sessionId && tuple.roundNo === row.roundNo),
      ),
    requests: async ({ tuples }) =>
      tasks.filter((row) =>
        tuples.some(
          (tuple) => tuple.userId === row.userId && tuple.clientRequestId === row.clientRequestId,
        ),
      ),
    inputs: async () => [],
    attempts: async () => [],
    artifacts: async () => [],
    references: async () => [],
  }
  const service = createOwnerTaskHistory({
    cursorKey,
    read: ({ work }) => {
      calls++
      return work({ reader })
    },
    ...options,
  })
  return { tasks, reader, parent, snapshot, service, calls: () => calls }
}
test('returns only frozen history white list and independent original input', async () => {
  const f = fixture()
  const result = await f.service.get({ userId: 1, taskId: 10 })
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      'artifactIds',
      'clientRequestId',
      'costCredits',
      'createdAt',
      'errorCode',
      'finishedAt',
      'id',
      'input',
      'inputAvailability',
      'resolution',
      'roundNo',
      'sessionId',
      'sourceTaskId',
      'startedAt',
      'status',
      'templateId',
    ].sort(),
  )
  assert.equal(result.input.description, '  original\n ')
  for (const object of [
    result,
    result.input,
    result.input.inputMediaIds,
    result.artifactIds,
    result.inputAvailability,
  ])
    assert.ok(Object.isFrozen(object))
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
})
test('first page of 1000 rounds contains latest without traversing all history', async () => {
  const f = fixture(1000)
  let scans = 0
  const original = f.reader.scan
  f.reader.scan = (args) => {
    scans++
    return original(args)
  }
  const a = await f.service.list({ userId: 1, sessionId: 2, query: {} })
  assert.deepEqual(
    a.items.map((row) => row.roundNo),
    Array.from({ length: 20 }, (_, i) => 1000 - i),
  )
  assert.equal(scans, 1)
  const b = await f.service.list({ userId: 1, sessionId: 2, query: { cursor: a.nextCursor } })
  assert.equal(b.items[0].roundNo, 980)
  assert.equal(b.items.at(-1).roundNo, 961)
})
test('skips tombstones consumes exact budget and continues from empty page', async () => {
  const f = fixture(4, { pageSize: 1, scanBudget: 2 })
  for (const row of f.tasks.slice(2))
    Object.assign(row, { isDeleted: true, deletedAt: time, deletedBy: 'system:fixture' })
  const a = await f.service.list({ userId: 1, sessionId: 2, query: {} })
  assert.deepEqual(a.items, [])
  assert.equal(a.hasMore, true)
  assert.deepEqual(
    createTaskHistoryCursor({ cursorKey }).decode({
      token: a.nextCursor,
      userId: 1,
      sessionId: 2,
      pageSize: 1,
    }),
    { roundNo: 3 },
  )
  const b = await f.service.list({ userId: 1, sessionId: 2, query: { cursor: a.nextCursor } })
  assert.equal(b.items[0].roundNo, 2)
  assert.equal((await f.service.get({ userId: 1, taskId: 13 })).roundNo, 4)
})
test('does not inspect or consume unreturned prefetched candidate', async () => {
  const f = fixture(1, { pageSize: 1 })
  f.reader.scan = async () => [f.tasks[0], { roundNo: 'unconsumed' }]
  const page = await f.service.list({ userId: 1, sessionId: 2, query: {} })
  assert.equal(page.items.length, 1)
  assert.equal(page.hasMore, true)
})
test('accepts known parent tombstone without restoring writability', async () => {
  const f = fixture()
  Object.assign(f.parent, { isDeleted: true, deletedAt: time, deletedBy: 'user:1' })
  assert.equal((await f.service.get({ userId: 1, taskId: 10 })).id, 10)
  assert.equal((await f.service.list({ userId: 1, sessionId: 2, query: {} })).items.length, 1)
})
for (const change of [
  { userId: 2 },
  { sessionId: 99 },
  { roundNo: 0 },
  { roundNo: 2 },
  { clientRequestId: ' ' },
  { clientRequestId: 'x'.repeat(129) },
  { templateId: 99 },
  { startedAt: time },
  { finishedAt: time },
  { errorCode: 'SECRET' },
  { createdAt: '2026-02-29T00:00:00.000Z' },
  { deletedAt: time },
  { isDeleted: true },
])
  test(`rejects bad consumed task ${JSON.stringify(change)}`, async () => {
    const f = fixture()
    Object.assign(f.tasks[0], change)
    await assert.rejects(() => f.service.list({ userId: 1, sessionId: 2, query: {} }), {
      status: 503,
    })
  })
test('rejects global tuple duplicates including foreign deleted rows', async () => {
  for (const method of ['rounds', 'requests']) {
    const f = fixture()
    f.reader[method] = async () => [f.tasks[0], { ...f.tasks[0], id: 999, isDeleted: true }]
    await assert.rejects(() => f.service.get({ userId: 1, taskId: 10 }), { status: 503 })
  }
})
test('strict descriptor-safe arguments are rejected with no getters or IO', async () => {
  const f = fixture()
  let getters = 0
  for (const query of [
    null,
    [],
    { cursor: '' },
    { cursor: 1 },
    { cursor: 'x'.repeat(2049) },
    { [Symbol()]: 1 },
    Object.defineProperty({}, 'cursor', { value: 'x' }),
    Object.defineProperty({}, 'cursor', {
      enumerable: true,
      get() {
        getters++
        return 'x'
      },
    }),
  ]) {
    await assert.rejects(() => f.service.list({ userId: 1, sessionId: 2, query }), { status: 400 })
  }
  await assert.rejects(() => f.service.get({ userId: 1, taskId: 0 }), { status: 400 })
  await assert.rejects(() => f.service.get({ userId: 0, taskId: 10 }), { status: 401 })
  assert.equal(f.calls(), 0)
  assert.equal(getters, 0)
  assert.ok(Object.isFrozen(normalizeTaskHistoryQuery({ value: Object.create(null) })))
})
test('cursor binds DESC endpoint user session page size and canonical envelope', () => {
  const codec = createTaskHistoryCursor({ cursorKey })
  const scope = { userId: 1, sessionId: 2, pageSize: 20 }
  const token = codec.encode({ ...scope, after: { roundNo: 80 } })
  assert.deepEqual(codec.decode({ ...scope, token }), { roundNo: 80 })
  for (const change of [{ userId: 2 }, { sessionId: 3 }, { pageSize: 50 }])
    assert.throws(() => codec.decode({ ...scope, ...change, token }), { status: 400 })
  const json = Buffer.from(token.split('.')[0], 'base64url').toString()
  for (const changed of [
    json.replace('roundNo:desc', 'roundNo:asc'),
    json.replace('"v":1', '"v":1,"v":1'),
    json.replace('"v":1', '"extra":1,"v":1'),
    json.replace('"roundNo":80', '"roundNo":80.0'),
  ]) {
    const body = Buffer.from(changed).toString('base64url')
    const signed = body + '.' + createHmac('sha256', cursorKey).update(body).digest('base64url')
    assert.throws(() => codec.decode({ ...scope, token: signed }), { status: 400 })
  }
})
test('attempt helper preserves original sequence checks and is not a complete state validator', () => {
  const f = fixture()
  assert.doesNotThrow(() =>
    assertGenerationAttempts({ attempts: [], snapshot: f.snapshot, taskId: 10 }),
  )
  const attempt = {
    id: 1,
    taskId: 10,
    attemptNo: 1,
    provider: 'p',
    model: 'm',
    status: 'prepared',
    isDeleted: false,
  }
  assert.doesNotThrow(() =>
    assertGenerationAttempts({ attempts: [attempt], snapshot: f.snapshot, taskId: 10 }),
  )
  for (const change of [
    { attemptNo: 2 },
    { model: 'wrong' },
    { isDeleted: true },
    { resultSha256: 'partial' },
  ])
    assert.throws(
      () =>
        assertGenerationAttempts({
          attempts: [{ ...attempt, ...change }],
          snapshot: f.snapshot,
          taskId: 10,
        }),
      { status: 503 },
    )
})
for (const error of [new Error('fixture transport'), new AggregateError([new Error('fixture db')])])
  test(`preserves ${error.name} identity`, async () => {
    const service = createOwnerTaskHistory({
      cursorKey,
      read: async () => {
        throw error
      },
    })
    for (const op of [
      () => service.get({ userId: 1, taskId: 10 }),
      () => service.list({ userId: 1, sessionId: 2, query: {} }),
    ])
      await assert.rejects(op, (actual) => actual === error)
  })
test('rejects invalid bounded config synchronously', () => {
  for (const config of [
    { pageSize: 0 },
    { pageSize: 51 },
    { batchSize: 129 },
    { scanBudget: 10001 },
    { scanBudget: 0 },
  ])
    assert.throws(() => createOwnerTaskHistory({ cursorKey, read: async () => {}, ...config }))
})
for (const status of ['running', 'unknown'])
  test(`rejects uncontrolled last attempt error for ${status}`, async () => {
    const f = fixture()
    Object.assign(f.tasks[0], {
      status,
      startedAt: time,
      errorCode: status === 'unknown' ? 'PROVIDER_UNKNOWN' : null,
    })
    f.reader.attempts = async () => [
      {
        ...deletion,
        id: 50,
        taskId: 10,
        attemptNo: 1,
        provider: 'p',
        model: 'm',
        status: status === 'unknown' ? 'unknown' : 'prepared',
        errorCode: 'SECRET',
      },
    ]
    await assert.rejects(() => f.service.get({ userId: 1, taskId: 10 }), { status: 503 })
  })
test('reads only minimal safe pre-send cancelled historical state without settlement claims', async () => {
  const f = fixture()
  Object.assign(f.tasks[0], { status: 'cancelled', finishedAt: time })
  const result = await f.service.get({ userId: 1, taskId: 10 })
  assert.equal(result.status, 'cancelled')
  assert.equal(result.resolution, null)
  f.reader.attempts = async () => [
    {
      ...deletion,
      id: 50,
      taskId: 10,
      attemptNo: 1,
      provider: 'p',
      model: 'm',
      status: 'unknown',
      errorCode: 'PROVIDER_UNKNOWN',
    },
  ]
  await assert.rejects(() => f.service.get({ userId: 1, taskId: 10 }), { status: 503 })
})

for (const status of ['running', 'unknown', 'failed']) {
  test(`independently validates ${status} task timeline and last attempt mapping`, async () => {
    const f = fixture()
    const errorCode =
      status === 'unknown' ? 'PROVIDER_UNKNOWN' : status === 'failed' ? 'NOT_SENT' : null
    Object.assign(f.tasks[0], {
      status,
      startedAt: time,
      finishedAt: status === 'failed' ? time : null,
      errorCode,
    })
    const attempt = {
      ...deletion,
      id: 50,
      taskId: 10,
      attemptNo: 1,
      provider: 'p',
      model: 'm',
      status: status === 'running' ? 'sending' : status,
      errorCode,
    }
    f.reader.attempts = async () => [attempt]
    assert.equal((await f.service.get({ userId: 1, taskId: 10 })).status, status)
    for (const change of [
      { startedAt: null },
      { startedAt: '2026-11-11T23:59:59.999Z' },
      { finishedAt: status === 'failed' ? null : time },
      { startedAt: '+010000-01-01T00:00:00.000Z' },
      { createdAt: '2026-11-12T00:00:01.000Z' },
      { errorCode: 'SECRET' },
    ]) {
      const original = { ...f.tasks[0] }
      Object.assign(f.tasks[0], change)
      await assert.rejects(() => f.service.get({ userId: 1, taskId: 10 }), { status: 503 })
      Object.assign(f.tasks[0], original)
    }
    f.reader.attempts = async () => []
    await assert.rejects(() => f.service.get({ userId: 1, taskId: 10 }), { status: 503 })
  })
}
