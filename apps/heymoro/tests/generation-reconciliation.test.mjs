import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGenerationWorker } from '../src/creation/application/generation-worker.ts'
import { hashTaskClientInput } from '../src/creation/domain/input.ts'
import { validateImage } from '../src/creation/infrastructure/image/sharp-image-validator.ts'
import { creationCollectionSlugs } from '../src/creation/infrastructure/payload/collections.ts'
import { createPayloadCreditRepository } from '../src/creation/infrastructure/payload/credits-repository.ts'
import { createGenerationReader } from '../src/creation/infrastructure/payload/generation-reader.ts'
import { createGenerationWorkerWriter } from '../src/creation/infrastructure/payload/generation-worker-writer.ts'
import { createCreationRuntime } from '../src/creation/infrastructure/payload/session-repository.ts'
import { createCreationWriteGate } from '../src/creation/infrastructure/payload/write-gate.ts'

const now = '2026-11-13T12:00:00.000Z'
const createAudit = {
  createdAt: now,
  createdBy: 'system:generation',
  deletedAt: null,
  deletedBy: null,
  isDeleted: false,
  updatedAt: now,
  updatedBy: 'system:generation',
}

function matches({ doc, where }) {
  if (!where) return true
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'and') return condition.every((part) => matches({ doc, where: part }))
    if (field === 'or') return condition.some((part) => matches({ doc, where: part }))
    return Object.entries(condition).every(([operator, value]) => {
      if (operator === 'equals') return doc[field] === value
      if (operator === 'in') return value.includes(doc[field])
      if (operator === 'greater_than') return doc[field] > value
      if (operator === 'greater_than_equal') return doc[field] >= value
      if (operator === 'less_than') return doc[field] < value
      if (operator === 'less_than_equal') return doc[field] <= value
      assert.fail(`Unexpected memory predicate ${operator}`)
    })
  })
}
/** Explicit in-memory persistence port: no database, Native adapter, server or SDK. */
async function applicationFixture({
  cost = 2,
  expiresAt = null,
  titleSource = 'default',
  engineKind = 'unknown',
  commitUnknownAt = null,
  imageValidator = validateImage,
} = {}) {
  const createWriter = createGenerationWorkerWriter
  const gate = createCreationWriteGate()
  const rows = new Map()
  const calls = []
  let nextId = 100
  let isLocked = false
  let transactionNo = 0
  const state = {
    now,
    modelCalls: 0,
    storageCandidates: [],
    beforeRecovery: null,
    engineKind,
    commitUnknownAt,
  }
  const commitError = new Error('commit result unknown')
  const seed = ({ collection, docs }) =>
    rows.set(
      collection,
      docs.map((doc) => ({ ...createAudit, ...doc })),
    )
  const input = { inputMediaIds: [], description: 'Literal task', userNotes: '' }
  const clientInput = { operation: 'generate', sessionId: 12, input }
  const executionPlan = {
    executorId: 'unit-v1',
    provider: 'unit-provider',
    model: 'unit-model',
    parameters: {},
    systemPrompt: 'Unit prompt',
  }
  const storageOutput = {
    backend: 'unit-metadata',
    bucket: 'unit-output',
    keyRule: 'task-attempt-result-v1',
  }
  const snapshot = {
    schemaVersion: 1,
    clientInput,
    input,
    mode: 'free',
    templateId: 13,
    templateVersionId: 14,
    executionPlan,
    media: [],
    storageOutput,
    quote: { costCredits: cost, issuedAt: now, validUntil: '2026-11-13T12:01:00.000Z' },
  }
  seed({
    collection: 'generation-tasks',
    docs: [
      {
        id: 1,
        sessionId: 12,
        userId: 11,
        templateId: 13,
        costCredits: cost,
        description: input.description,
        userNotes: '',
        sourceTaskId: null,
        requestHash: hashTaskClientInput({ clientInput }),
        executionSnapshotJson: JSON.stringify(snapshot),
        status: 'queued',
        startedAt: null,
        finishedAt: null,
        errorCode: null,
      },
    ],
  })
  seed({
    collection: 'creation-sessions',
    docs: [
      {
        id: 12,
        userId: 11,
        mode: 'free',
        templateId: 13,
        titleSource,
        autoNameStatus: 'idle',
      },
    ],
  })
  seed({ collection: 'users', docs: [{ id: 11, status: 'active' }] })
  seed({
    collection: 'credit-accounts',
    docs: [{ id: 30, userId: 11, availableCredits: cost ? 3 : 0, reservedCredits: cost }],
  })
  seed({
    collection: 'credit-reservations',
    docs: [
      {
        id: 40,
        accountId: 30,
        userId: 11,
        taskId: 1,
        reservationKey: 'generation:1',
        amountCredits: cost,
        status: 'reserved',
      },
    ],
  })
  seed({
    collection: 'credit-grants',
    docs: cost
      ? [
          {
            id: 31,
            accountId: 30,
            userId: 11,
            grantKey: 'unit:31',
            issuedCredits: 3 + cost,
            availableCredits: 3,
            reservedCredits: cost,
            consumedCredits: 0,
            expiredCredits: 0,
            revokedCredits: 0,
            validFrom: '2026-11-10T00:00:00.000Z',
            expiresAt,
            sourceId: null,
            sourceType: 'trial',
          },
        ]
      : [],
  })
  seed({
    collection: 'credit-allocations',
    docs: cost
      ? [{ id: 41, reservationId: 40, grantId: 31, amountCredits: cost, status: 'reserved' }]
      : [],
  })
  seed({
    collection: 'credit-ledger',
    docs: cost
      ? [
          {
            id: 42,
            accountId: 30,
            userId: 11,
            grantId: 31,
            reservationId: 40,
            eventKey: 'reserve:generation:1:31',
            operation: 'reserve',
            amountCredits: cost,
            availableDelta: -cost,
            reservedDelta: cost,
            consumedDelta: 0,
            expiredDelta: 0,
            revokedDelta: 0,
            reasonCode: 'GENERATION_RESERVED',
          },
        ]
      : [],
  })
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
    find: async (args) => {
      if (args.collection === 'admins') calls.push({ operation: 'admin-read', req: args.req })
      let docs = (rows.get(args.collection) ?? []).filter((doc) =>
        matches({ doc, where: args.where }),
      )
      if (args.sort) {
        const fields = Array.isArray(args.sort) ? args.sort : [args.sort]
        docs = [...docs].sort((left, right) => {
          for (const field of fields) {
            const key = field.replace(/^-/, '')
            if (left[key] !== right[key])
              return (left[key] < right[key] ? -1 : 1) * (field.startsWith('-') ? -1 : 1)
          }
          return 0
        })
      }
      const totalDocs = docs.length
      if (args.limit) docs = docs.slice(0, args.limit)
      return { docs: docs.map((doc) => ({ ...doc })), totalDocs }
    },
    create: async (args) => {
      assert.equal(isLocked, true)
      gate.assert({ req: args.req })
      calls.push({ ...args, operation: 'create' })
      const doc = { id: nextId++, ...args.data }
      rows.set(args.collection, [...(rows.get(args.collection) ?? []), doc])
      return { ...doc }
    },
    update: async (args) => {
      assert.equal(isLocked, true)
      gate.assert({ req: args.req })
      calls.push({ ...args, operation: 'update' })
      const docs = (rows.get(args.collection) ?? []).filter((doc) =>
        args.where ? matches({ doc, where: args.where }) : doc.id === args.id,
      )
      for (const doc of docs) Object.assign(doc, args.data)
      return args.where ? { docs: docs.map((doc) => ({ ...doc })), errors: [] } : { ...docs[0] }
    },
  }
  const runtime = createCreationRuntime({ payload, gate })
  const read = ({ work }) =>
    work({ reader: createGenerationReader({ find: (args) => payload.find(args) }) })
  const persistence = {
    read,
    isCommitUnknown: ({ error }) => error === commitError,
    isTransactionUncertain: ({ error }) => error === commitError,
    write: async ({ resources, work }) => {
      assert.equal(isLocked, false)
      const req = { transactionID: `memory-${++transactionNo}` }
      const transaction = {}
      const binding = gate.bind({
        req,
        transactionID: req.transactionID,
        transaction,
        sessions: { [req.transactionID]: { db: transaction } },
        assertLease: () => {},
      })
      isLocked = true
      calls.push({ operation: 'lock', resources, req })
      try {
        const repository = {
          ...createGenerationReader({ find: (args) => runtime.find({ ...args, req }) }),
          ...createWriter({ runtime, req }),
          credits: createPayloadCreditRepository({ payload, gate, req }),
          queueName: async ({ sessionId }) => {
            calls.push({ operation: 'queue', sessionId, req })
          },
          registerMedia: async ({ facts: stored, owner }) => {
            const media = await runtime.create({
              collection: 'media',
              req,
              data: {
                ...createAudit,
                owner,
                lifecycle: 'active',
                purpose: 'artifact',
                visibility: 'private',
                storageBackend: stored.ref.backend,
                storageBucket: stored.ref.bucket,
                storageName: stored.ref.key,
                sha256: stored.sha256,
                filesize: stored.filesize,
                mimeType: stored.mimeType,
                width: stored.width,
                height: stored.height,
              },
            })
            return { id: media.id }
          },
        }
        const result = await work({ repository })
        binding.assert()
        const latest = rows.get('generation-attempts')?.at(-1)
        if (state.commitUnknownAt && latest?.status === state.commitUnknownAt) {
          state.commitUnknownAt = null
          if (state.afterCommit) state.afterCommit()
          throw commitError
        }
        return result
      } finally {
        binding.close()
        isLocked = false
        calls.push({ operation: 'unlock', req })
      }
    },
  }
  const clock = () => {
    calls.push({ operation: 'clock', isLocked })
    return state.now
  }
  const trustedClose = { actor: 'admin:12', reasons: ['REVIEWED'] }
  const storage = {
    putImmutable: async ({ bytes, contentType }) => {
      assert.equal(isLocked, false)
      calls.push({ operation: 'putImmutable', bytes, contentType })
      throw new Error('verified output storage sentinel')
    },
    assertVerified: () => {},
    findAttemptCandidates: async () => {
      assert.equal(isLocked, false)
      calls.push({ operation: 'storage' })
      if (state.beforeRecovery) await state.beforeRecovery()
      return { status: 'complete', candidates: state.storageCandidates }
    },
  }
  const workerOptions = {
    validateImage: async (args) => {
      assert.equal(isLocked, false)
      calls.push({ operation: 'validateImage' })
      return imageValidator(args)
    },
    clock,
    persistence,
    storage,
    trustedClose,
    imageLimits: {
      allowedMimeTypes: ['image/png'],
      maxBytes: 1000,
      maxPixels: 1000,
      timeoutMs: 1000,
    },
    execution: {
      registry: {
        'unit-v1': {
          provider: executionPlan.provider,
          model: executionPlan.model,
          parameterRules: {},
          allowedParameters: [],
          storageBackends: [storageOutput.backend],
        },
      },
      storageOutput,
    },
    leaseMs: 10000,
    engineTimeoutMs: 1000,
    engine: async () => {
      assert.equal(isLocked, false)
      state.modelCalls++
      calls.push({ operation: 'engine' })
      return state.engineResult ?? { kind: state.engineKind, requestId: 'provider-request' }
    },
  }
  const worker = createGenerationWorker(workerOptions)
  const row = ({ collection }) => rows.get(collection)?.[0]
  const stored = ({ attemptId = row({ collection: 'generation-attempts' }).id } = {}) => ({
    ref: { ...storageOutput, key: `tasks/1/attempts/${attemptId}/result-${'a'.repeat(64)}` },
    sha256: 'a'.repeat(64),
    filesize: 100,
    width: 2,
    height: 3,
    mimeType: 'image/png',
  })
  const hostOptions = () => {
    const en = { translations: {}, dateFNSKey: 'en-US' }
    payload.config = { i18n: { fallbackLanguage: 'en', supportedLanguages: { en } } }
    payload.collections.users.config.flattenedFields.push({ name: 'isDeleted', type: 'checkbox' })
    payload.collections.admins = {
      config: { hooks: { beforeOperation: [gate.beforeOperation] }, flattenedFields: [] },
    }
    payload.auth = async (args) => {
      calls.push({ operation: 'auth', req: args.req, transactionID: args.req?.transactionID })
      if (args.req) gate.assert({ req: args.req })
      if (state.onAuth) await state.onAuth(args)
      return state.principal === undefined
        ? { user: { collection: 'admins', id: 12 } }
        : { user: state.principal }
    }
    payload.jobs = {
      queue: async (args) => {
        calls.push({ operation: 'queue', req: args.req })
      },
    }
    payload.db = {
      name: 'sqlite',
      autoIncrement: true,
      idType: 'number',
      clientConfig: { url: 'file:memory-port' },
      schema: {},
      sessions: {},
      initializing: Promise.resolve(),
      client: {
        transaction: async () => ({
          closed: false,
          commit: async () => {},
          rollback: async () => {},
          close() {
            this.closed = true
          },
        }),
      },
    }
    return {
      ...workerOptions,
      payload,
      gate,
      retry: { maxAttempts: 1, backoffMs: 0 },
      coordinateMany: async ({ resources, work }) => {
        assert.equal(isLocked, false)
        assert.deepEqual(resources, ['session:11:12', 'task:1', 'wallet:11'])
        isLocked = true
        try {
          return await work({ assertLease: () => {} })
        } finally {
          isLocked = false
        }
      },
    }
  }
  return {
    rows,
    calls,
    state,
    row,
    stored,
    persistence,
    workerOptions,
    worker,
    clock,
    storage,
    hostOptions,
  }
}

const authorization = 'JWT a.b.c'
const requestId = 'a4fc34ee-82dd-4fd7-b311-22de786384c1'
const command = (action, extras = {}) => ({ action, authorization, taskId: 1, ...extras })
const domain = () => import('../src/creation/domain/generation-reconciliation.ts')
const application = () => import('../src/creation/application/generation-reconciliation.ts')
async function reconciliation(f, overrides = {}) {
  const { createGenerationReconciliation } = await application()
  return createGenerationReconciliation({
    clock: f.clock,
    persistence: f.persistence,
    storage: f.storage,
    imageLimits: f.workerOptions.imageLimits,
    workerOptions: f.workerOptions,
    actor: 'admin:12',
    ...overrides,
  })
}
async function unknownFixture(options) {
  const f = await applicationFixture(options)
  await f.worker.run({ taskId: 1 })
  assert.equal(f.row({ collection: 'generation-tasks' }).status, 'unknown')
  return f
}
function currentAttempt(f) {
  return f.row({ collection: 'generation-attempts' }).id
}
const execute = (service, input) => service.execute({ input, requestId })

test('reconciliation parser copies and freezes only exact own data commands', async () => {
  const { parseGenerationReconciliationCommand: parse } = await domain()
  const input = command('close-undelivered', {
    attemptId: 1,
    operationId: 'close.1',
    confirmedUndelivered: true,
  })
  const parsed = parse({ input })
  input.taskId = 2
  assert.equal(parsed.taskId, 1)
  assert.ok(Object.isFrozen(parsed))
  assert.equal(parse({ input: command('inspect') }).action, 'inspect')
  assert.equal(parse({ input: command('recover', { attemptId: 2 }) }).attemptId, 2)
  let getters = 0
  const getter = command('inspect')
  Object.defineProperty(getter, 'taskId', {
    enumerable: true,
    get() {
      getters++
      return 1
    },
  })
  for (const bad of [
    null,
    [],
    new Date(),
    getter,
    ...['actor', 'reason', 'userId', 'url', 'key', 'attemptId'].map((key) =>
      command('inspect', { [key]: 1 }),
    ),
    command('recover'),
    command('recover', { attemptId: 1, operationId: 'bad' }),
    command('close-undelivered', {
      attemptId: 1,
      operationId: 'close.1',
      confirmedUndelivered: false,
    }),
    ...[0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1].map((taskId) =>
      command('inspect', { taskId }),
    ),
    command('inspect', { authorization: 'Bearer a.b.c' }),
    command('inspect', { operationId: ' bad ' }),
    Object.assign(Object.create({}), command('inspect')),
    { ...command('inspect'), [Symbol('x')]: 1 },
  ]) {
    assert.throws(() => parse({ input: bad }), {
      code: 'RECONCILIATION_INVALID_INPUT',
      outcome: 'not_started',
    })
  }
  assert.equal(getters, 0)
})

test('recovery-only rejects queued/prepared and old attempts without calling the engine', async () => {
  const f = await applicationFixture()
  assert.equal(typeof f.worker.recoverOnly, 'function')
  await assert.rejects(f.worker.recoverOnly({ taskId: 1, attemptId: 1 }))
  assert.equal(f.state.modelCalls, 0)
  await f.worker.run({ taskId: 1 })
  const before = f.state.modelCalls
  await assert.rejects(f.worker.recoverOnly({ taskId: 1, attemptId: currentAttempt(f) + 1 }))
  assert.equal(await f.worker.recoverOnly({ taskId: 1, attemptId: currentAttempt(f) }), 'pending')
  assert.equal(f.state.modelCalls, before)
})

test('inspect is read-only and pending storage never releases funds', async () => {
  const f = await unknownFixture()
  const s = await reconciliation(f)
  const before = f.calls.length
  const result = await execute(s, command('inspect'))
  assert.equal(result.result, 'pending')
  assert.equal(result.outcome, 'confirmed')
  assert.equal(result.taskStatus, 'unknown')
  assert.equal(
    f.calls.slice(before).filter((x) => ['storage', 'lock', 'engine'].includes(x.operation)).length,
    0,
  )
  await execute(s, command('recover', { attemptId: currentAttempt(f) }))
  assert.equal(f.row({ collection: 'credit-reservations' }).status, 'reserved')
})

test('complete absence closes once using fixed reason and original operation even with a new unused op', async () => {
  const f = await unknownFixture()
  const s = await reconciliation(f)
  const close = command('close-undelivered', {
    attemptId: currentAttempt(f),
    operationId: 'close.1',
    confirmedUndelivered: true,
  })
  const result = await execute(s, close)
  assert.equal(result.result, 'closed')
  assert.equal(result.originalOperationId, 'close.1')
  assert.equal(result.releasedCredits, 2)
  assert.equal(result.expiredCredits, 0)
  assert.equal(f.row({ collection: 'credit-reservations' }).status, 'released')
  assert.equal(f.row({ collection: 'auditLogs' }).summary.reason, 'PROVIDER_UNRESOLVED')
  assert.equal(f.row({ collection: 'auditLogs' }).actorId, '12')
  assert.equal((await execute(s, close)).originalOperationId, 'close.1')
  assert.equal(
    (await execute(s, { ...close, operationId: 'close.2' })).originalOperationId,
    'close.1',
  )
  assert.equal(f.rows.get('auditLogs').length, 1)
  assert.equal(f.rows.get('credit-ledger').filter((x) => x.operation === 'release').length, 1)
  assert.equal(f.state.modelCalls, 1)
})

test('complete one output takes recovery before close and captures once, never calls model again', async () => {
  const f = await unknownFixture()
  f.state.storageCandidates = [f.stored()]
  const s = await reconciliation(f)
  const input = command('close-undelivered', {
    attemptId: currentAttempt(f),
    operationId: 'recover.1',
    confirmedUndelivered: true,
  })
  assert.equal((await execute(s, input)).result, 'succeeded')
  assert.equal((await execute(s, input)).result, 'succeeded')
  assert.equal(f.rows.get('credit-ledger').filter((x) => x.operation === 'capture').length, 1)
  assert.equal(f.rows.get('credit-ledger').filter((x) => x.operation === 'release').length, 0)
  assert.equal(f.rows.get('artifacts').length, 1)
  assert.equal(f.state.modelCalls, 1)
})

for (const kind of ['partial', 'many', 'throw', 'facts-without-object'])
  test(`close never treats ${kind} as absence`, async () => {
    const f = await unknownFixture()
    const storage = {
      ...f.storage,
      findAttemptCandidates: async () => {
        if (kind === 'throw') throw Error('PRIVATE_PATH')
        return {
          status: kind === 'partial' ? 'incomplete' : 'complete',
          candidates: kind === 'many' ? [f.stored(), f.stored()] : [],
        }
      },
    }
    if (kind === 'facts-without-object')
      Object.assign(f.row({ collection: 'generation-attempts' }), { resultSha256: 'a'.repeat(64) })
    const s = await reconciliation(f, { storage })
    const input = command('close-undelivered', {
      attemptId: currentAttempt(f),
      operationId: 'close.bad',
      confirmedUndelivered: true,
    })
    if (kind === 'partial' || kind === 'many')
      assert.equal((await execute(s, input)).result, 'pending')
    else await assert.rejects(execute(s, input))
    assert.equal(f.row({ collection: 'credit-reservations' }).status, 'reserved')
  })

test('op collision and tombstone guard applies before closed/succeeded shortcuts', async () => {
  for (const terminal of ['unknown', 'closed', 'succeeded']) {
    const f = await unknownFixture()
    const s = await reconciliation(f)
    const input = command('close-undelivered', {
      attemptId: currentAttempt(f),
      operationId: 'close.1',
      confirmedUndelivered: true,
    })
    if (terminal === 'closed') await execute(s, input)
    if (terminal === 'succeeded') {
      f.state.storageCandidates = [f.stored()]
      await execute(s, command('recover', { attemptId: currentAttempt(f) }))
    }
    f.rows.set('auditLogs', [
      ...(f.rows.get('auditLogs') ?? []),
      {
        ...createAudit,
        id: 999,
        isDeleted: true,
        action: 'generation.unknown.close',
        resourceType: 'generation-task',
        resourceId: '999',
        correlationId: 'collision',
        requestId: 'collision',
      },
    ])
    await assert.rejects(execute(s, { ...input, operationId: 'collision' }), {
      code: 'RECONCILIATION_DATA_INTEGRITY',
    })
  }
})

for (const field of ['errorCode', 'finishedAt', 'actorId', 'requestId', 'summary', 'beforeState'])
  test(`closed confirmation rejects corrupt ${field}`, async () => {
    const f = await unknownFixture()
    const s = await reconciliation(f)
    const input = command('close-undelivered', {
      attemptId: currentAttempt(f),
      operationId: 'close.1',
      confirmedUndelivered: true,
    })
    await execute(s, input)
    const doc = ['errorCode', 'finishedAt'].includes(field)
      ? f.row({ collection: 'generation-tasks' })
      : f.row({ collection: 'auditLogs' })
    doc[field] = null
    await assert.rejects(execute(s, input), { code: 'RECONCILIATION_DATA_INTEGRITY' })
  })

test('expiry and zero cost retain kernel settlement accounting', async () => {
  for (const options of [{ expiresAt: '2026-11-13T12:00:00.000Z' }, { cost: 0 }]) {
    const f = await unknownFixture(options)
    const s = await reconciliation(f)
    const r = await execute(
      s,
      command('close-undelivered', {
        attemptId: currentAttempt(f),
        operationId: 'expiry.1',
        confirmedUndelivered: true,
      }),
    )
    assert.equal(r.releasedCredits, 0)
    assert.equal(r.expiredCredits, options.cost === 0 ? 0 : 2)
    assert.equal(f.row({ collection: 'credit-reservations' }).status, 'released')
  }
})

test('shared Native authentication supports standalone identity and owned-request auth with exact current admin reads', async () => {
  const mod = await import('../src/creation/infrastructure/payload/admin-repository.ts')
  assert.equal(typeof mod.authenticateNativeAdminPrincipal, 'function')
  assert.equal(typeof mod.readNativeAdminById, 'function')
  const calls = []
  const payload = {
    auth: async (args) => {
      calls.push(args)
      return { user: { collection: 'admins', id: 12 } }
    },
  }
  assert.equal(await mod.authenticateNativeAdminPrincipal({ payload, authorization }), 12)
  assert.equal(calls[0].req, undefined)
  const req = { transactionID: 'owned' }
  const gate = {
    run: async (args) => {
      assert.equal(args.req, req)
      return args.work()
    },
  }
  assert.equal(
    await mod.authenticateNativeAdminPrincipal({ payload, authorization, owned: { gate, req } }),
    12,
  )
  assert.equal(calls[1].req, req)
  const current = await mod.readNativeAdminById({
    id: 12,
    find: async (args) => {
      assert.deepEqual(args.where, { id: { equals: 12 } })
      assert.deepEqual(args.select, { id: true, email: true, role: true, status: true })
      return { totalDocs: 1, docs: [{ id: 12, role: 'operator', status: 'active' }] }
    },
  })
  assert.equal(current.role, 'operator')
  await assert.rejects(
    mod.readNativeAdminById({
      id: 12,
      find: async () => ({ totalDocs: 2, docs: [{ id: 12, role: 'admin', status: 'active' }] }),
    }),
    { code: 'ADMIN_DATA_INTEGRITY' },
  )
  assert.equal(
    await mod.authenticateNativeAdminPrincipal({
      payload: { auth: async () => ({ user: { id: 12, collection: 'users' } }) },
      authorization,
    }),
    null,
  )
})

test('formal Native adapter binds preauth identity and current active admin for every read and same owned write req', async () => {
  const { createPayloadGenerationReconciliation } =
    await import('../src/creation/infrastructure/payload/generation-reconciliation-repository.ts')
  const f = await unknownFixture()
  f.rows.set('admins', [{ id: 12, role: 'admin', status: 'active' }])
  const service = createPayloadGenerationReconciliation(f.hostOptions())
  const result = await execute(
    service,
    command('close-undelivered', {
      attemptId: currentAttempt(f),
      operationId: 'native.1',
      confirmedUndelivered: true,
    }),
  )
  assert.equal(result.result, 'closed')
  const auth = f.calls.filter((x) => x.operation === 'auth')
  assert.equal(auth[0].req, undefined)
  assert.equal(auth.length, 2)
  assert.ok(auth[1].transactionID)
  assert.ok(f.calls.some((x) => x.operation === 'admin-read' && x.req === auth[1].req))
  for (const write of f.calls.filter(
    (x) => ['create', 'update', 'queue'].includes(x.operation) && x.req === auth[1].req,
  ))
    assert.equal(write.req, auth[1].req)
  assert.equal(f.row({ collection: 'auditLogs' }).actorId, '12')
})

for (const failure of [
  'operator',
  'disabled',
  'user-token',
  'demoted-after-preauth',
  'identity-change-on-write',
  'disabled-on-write',
])
  test(`formal adapter rejects ${failure} without financial writes`, async () => {
    const { createPayloadGenerationReconciliation } =
      await import('../src/creation/infrastructure/payload/generation-reconciliation-repository.ts')
    const f = await unknownFixture()
    f.rows.set('admins', [
      {
        id: 12,
        role: failure === 'operator' ? 'operator' : 'admin',
        status: failure === 'disabled' ? 'disabled' : 'active',
      },
    ])
    const options = f.hostOptions()
    if (failure === 'user-token') f.state.principal = { id: 12, collection: 'users' }
    f.state.onAuth = (args) => {
      if (failure === 'demoted-after-preauth' && !args.req)
        f.row({ collection: 'admins' }).role = 'operator'
      if (failure === 'disabled-on-write' && args.req)
        f.row({ collection: 'admins' }).status = 'disabled'
      if (failure === 'identity-change-on-write' && args.req)
        f.state.principal = { id: 13, collection: 'admins' }
    }
    await assert.rejects(
      execute(
        createPayloadGenerationReconciliation(options),
        command('close-undelivered', {
          attemptId: currentAttempt(f),
          operationId: 'native.fail',
          confirmedUndelivered: true,
        }),
      ),
    )
    assert.equal(f.row({ collection: 'credit-reservations' }).status, 'reserved')
    assert.equal(f.rows.get('auditLogs'), undefined)
  })

for (const evidence of ['complete', 'missing', 'read-failure', 'auth-failure'])
  test(`lost COMMIT ACK keeps ${evidence} outcome honest`, async () => {
    const f = await unknownFixture()
    f.state.commitUnknownAt = 'unknown'
    if (evidence === 'missing')
      f.state.afterCommit = () => {
        f.row({ collection: 'generation-tasks' }).errorCode = null
      }
    let afterCommit = false
    if (evidence === 'read-failure' || evidence === 'auth-failure')
      f.state.afterCommit = () => {
        afterCommit = true
      }
    const persistence = {
      ...f.persistence,
      read: (args) => {
        if (afterCommit) throw Error(evidence)
        return f.persistence.read(args)
      },
    }
    const s = await reconciliation(f, { persistence })
    const input = command('close-undelivered', {
      attemptId: currentAttempt(f),
      operationId: 'unknown.1',
      confirmedUndelivered: true,
    })
    if (evidence === 'complete') assert.equal((await execute(s, input)).outcome, 'confirmed')
    else
      await assert.rejects(execute(s, input), {
        code: 'RECONCILIATION_OUTCOME_UNKNOWN',
        outcome: 'unknown',
      })
  })

test('rollback-unconfirmed before COMMIT is unknown rather than ordinary rolled_back', async () => {
  const { CreationTransactionError } =
    await import('../src/creation/infrastructure/payload/sqlite-unit-of-work.ts')
  const f = await unknownFixture()
  const txError = new CreationTransactionError({
    attempt: { hasBegun: true, commitStarted: false, rollbackConfirmed: false },
    error: Error('PRIVATE_ROLLBACK'),
  })
  const persistence = {
    ...f.persistence,
    isTransactionUncertain: ({ error }) => error instanceof CreationTransactionError,
    write: async () => {
      throw txError
    },
  }
  const s = await reconciliation(f, { persistence })
  await assert.rejects(
    execute(
      s,
      command('close-undelivered', {
        attemptId: currentAttempt(f),
        operationId: 'rollback.1',
        confirmedUndelivered: true,
      }),
    ),
    { outcome: 'unknown' },
  )
})

test('recover with an already committed output stage never calls a later failure an entire rollback', async () => {
  const f = await unknownFixture()
  f.state.storageCandidates = [f.stored()]
  let writes = 0
  const persistence = {
    ...f.persistence,
    write: (args) => {
      if (++writes === 2) throw Error('PRIVATE_DELIVERY')
      return f.persistence.write(args)
    },
  }
  const s = await reconciliation(f, { persistence })
  await assert.rejects(execute(s, command('recover', { attemptId: currentAttempt(f) })), {
    outcome: 'unknown',
  })
  assert.equal(f.row({ collection: 'generation-attempts' }).status, 'output_ready')
  assert.equal(f.row({ collection: 'credit-reservations' }).status, 'reserved')
  assert.equal(f.state.modelCalls, 1)
})

test('strict command parser rejects a literal own __proto__ field rather than dropping it', async () => {
  const { parseGenerationReconciliationCommand } = await domain()
  const input = JSON.parse(
    '{"action":"inspect","authorization":"JWT a.b.c","taskId":1,"__proto__":{"actor":"admin:99"}}',
  )
  assert.throws(() => parseGenerationReconciliationCommand({ input }), {
    code: 'RECONCILIATION_INVALID_INPUT',
  })
})

test('expected attempt is rechecked inside write and output_ready race chooses recovery rather than release', async () => {
  for (const change of ['attempt', 'output_ready']) {
    const f = await unknownFixture()
    const originalWrite = f.persistence.write
    let first = true
    const persistence = {
      ...f.persistence,
      write: async (args) => {
        if (first) {
          first = false
          const attempt = f.row({ collection: 'generation-attempts' })
          if (change === 'attempt') attempt.id += 1
          else {
            const facts = f.stored()
            Object.assign(attempt, {
              status: 'output_ready',
              resultSha256: facts.sha256,
              resultStorageBackend: facts.ref.backend,
              resultStorageBucket: facts.ref.bucket,
              resultStorageKey: facts.ref.key,
            })
            f.state.storageCandidates = [facts]
          }
        }
        return originalWrite(args)
      },
    }
    const attemptId = currentAttempt(f)
    const s = await reconciliation(f, { persistence })
    const input = command('close-undelivered', {
      attemptId,
      operationId: 'race.1',
      confirmedUndelivered: true,
    })
    if (change === 'attempt')
      await assert.rejects(execute(s, input), { code: 'RECONCILIATION_DATA_INTEGRITY' })
    else assert.equal((await execute(s, input)).result, 'succeeded')
    assert.equal(
      (f.rows.get('credit-ledger') ?? []).filter((x) => x.operation === 'release').length,
      0,
    )
    assert.equal(f.state.modelCalls, 1)
  }
})

test('lost close ACK never confirms a different concurrent original operation', async () => {
  const f = await unknownFixture()
  f.state.commitUnknownAt = 'unknown'
  f.state.afterCommit = () => {
    const audit = f.row({ collection: 'auditLogs' })
    audit.correlationId = 'other.close'
    audit.requestId = 'other.close'
  }
  const s = await reconciliation(f)
  await assert.rejects(
    execute(
      s,
      command('close-undelivered', {
        attemptId: currentAttempt(f),
        operationId: 'close.mine',
        confirmedUndelivered: true,
      }),
    ),
    { outcome: 'unknown' },
  )
})

for (const action of ['inspect', 'recover'])
  test(`${action} rejects contradictory close audit tombstones even without operation input`, async () => {
    const f = await unknownFixture()
    f.rows.set('auditLogs', [
      {
        ...createAudit,
        id: 999,
        isDeleted: true,
        action: 'GENERATION_UNKNOWN_CLOSED',
        resourceType: 'generation-task',
        resourceId: '1',
        correlationId: 'old.close',
        requestId: 'old.close',
      },
    ])
    const s = await reconciliation(f)
    await assert.rejects(
      execute(s, command(action, action === 'recover' ? { attemptId: currentAttempt(f) } : {})),
      { code: 'RECONCILIATION_DATA_INTEGRITY' },
    )
  })

test('closed confirmation requires canonical finishedAt rather than any Date.parse-compatible string', async () => {
  const f = await unknownFixture()
  const s = await reconciliation(f)
  const input = command('close-undelivered', {
    attemptId: currentAttempt(f),
    operationId: 'time.1',
    confirmedUndelivered: true,
  })
  await execute(s, input)
  f.row({ collection: 'generation-tasks' }).finishedAt = '1'
  await assert.rejects(execute(s, command('inspect')), { code: 'RECONCILIATION_DATA_INTEGRITY' })
})

for (const status of ['failed', 'cancelled'])
  test(`inspect reports ${status} as an existing terminal without writes, storage or model calls`, async () => {
    const f = await applicationFixture({ engineKind: 'rejected' })
    assert.equal(await f.worker.run({ taskId: 1 }), 'failed')
    f.row({ collection: 'generation-tasks' }).status = status
    const before = structuredClone(f.rows)
    const callOffset = f.calls.length
    const modelCalls = f.state.modelCalls
    const service = await reconciliation(f)
    const result = await execute(service, command('inspect'))
    assert.equal(result.outcome, 'confirmed')
    assert.equal(result.taskStatus, status)
    assert.equal(result.result, status)
    assert.deepEqual(f.rows, before)
    assert.equal(f.state.modelCalls, modelCalls)
    assert.equal(
      f.calls
        .slice(callOffset)
        .filter((x) =>
          ['lock', 'storage', 'engine', 'create', 'update', 'queue', 'putImmutable'].includes(
            x.operation,
          ),
        ).length,
      0,
    )
    assert.equal(f.row({ collection: 'credit-reservations' }).status, 'released')
    assert.equal(f.rows.get('credit-ledger').filter((x) => x.operation === 'release').length, 1)
  })
