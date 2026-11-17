import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'

import { createGenerationWorker } from '../src/creation/application/generation-worker.ts'
import { hashTaskClientInput } from '../src/creation/domain/input.ts'
import { validateImage } from '../src/creation/infrastructure/image/sharp-image-validator.ts'
import { creationCollectionSlugs } from '../src/creation/infrastructure/payload/collections.ts'
import { createPayloadCreditRepository } from '../src/creation/infrastructure/payload/credits-repository.ts'
import { createGenerationReader } from '../src/creation/infrastructure/payload/generation-reader.ts'
import { createPayloadGenerationWorker } from '../src/creation/infrastructure/payload/generation-worker-repository.ts'
import { createGenerationWorkerWriter } from '../src/creation/infrastructure/payload/generation-worker-writer.ts'
import { createPayloadMediaService } from '../src/creation/infrastructure/payload/media-repository.ts'
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
  const realWorker = async (hostOptions = {}) => {
    const en = { translations: {}, dateFNSKey: 'en-US' }
    payload.config = { i18n: { fallbackLanguage: 'en', supportedLanguages: { en } } }
    payload.collections.users.config.flattenedFields.push({ name: 'isDeleted', type: 'checkbox' })
    payload.jobs = {
      queue: async (args) => {
        calls.push({ ...args, operation: 'queue' })
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
        transaction: async () => {
          const transaction = {
            closed: false,
            commit: async () => {},
            rollback: async () => {},
            close: () => {
              transaction.closed = true
            },
          }
          return transaction
        },
      },
    }
    const { persistence: unusedPersistence, ...options } = workerOptions
    assert.equal(unusedPersistence, persistence)
    return createPayloadGenerationWorker({
      ...options,
      ...hostOptions,
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
    })
  }
  return {
    calls,
    commitError,
    realWorker,
    realMedia: (hostOptions = {}) =>
      createPayloadMediaService({
        clock,
        imageLimits: workerOptions.imageLimits,
        storage,
        destination: { backend: 'unit-metadata', bucket: 'unit-output' },
        payload,
        gate,
        retry: { maxAttempts: 1, backoffMs: 0 },
        coordinate: async () => {
          assert.fail('image verification must precede writes')
        },
        ...hostOptions,
      }),
    row,
    rows,
    state,
    stored,
    worker,
  }
}
function transitions({ calls }) {
  return calls
    .filter(({ operation }) => ['create', 'update', 'queue'].includes(operation))
    .map(
      ({ operation, collection, data }) =>
        `${operation}:${collection ?? 'naming'}:${data?.status ?? data?.operation ?? ''}`,
    )
}
function assertLocking({ calls }) {
  let currentReq
  for (const call of calls) {
    if (call.operation === 'lock') {
      currentReq = call.req
      assert.deepEqual(call.resources, ['session:11:12', 'task:1', 'wallet:11'])
      const index = calls.indexOf(call)
      assert.deepEqual(calls[index + 1], { operation: 'clock', isLocked: true })
    } else if (call.operation === 'unlock') currentReq = undefined
    else if (['create', 'update', 'queue'].includes(call.operation))
      assert.equal(call.req, currentReq)
    else if (['engine', 'storage'].includes(call.operation)) assert.equal(currentReq, undefined)
  }
}

test('should run actual worker unknown writes in order under the same lock/request and never re-send', async () => {
  const fixture = await applicationFixture()
  assert.equal(await fixture.worker.run({ taskId: 1 }), 'unknown')
  assert.equal(await fixture.worker.run({ taskId: 1 }), 'pending')
  assert.equal(fixture.state.modelCalls, 1)
  assert.deepEqual(transitions(fixture), [
    'create:generation-attempts:prepared',
    'update:generation-tasks:running',
    'update:generation-attempts:sending',
    'update:generation-attempts:unknown',
    'update:generation-tasks:unknown',
  ])
  assert.equal(
    fixture.row({ collection: 'generation-attempts' }).providerRequestId,
    'provider-request',
  )
  assertLocking(fixture)
})
for (const commitUnknownAt of ['prepared', 'sending']) {
  test(`should keep ${commitUnknownAt} commit-unknown read-only on re-entry without another model call`, async () => {
    const fixture = await applicationFixture({ commitUnknownAt })
    await assert.rejects(
      fixture.worker.run({ taskId: 1 }),
      (error) => error === fixture.commitError,
    )
    const before = transitions(fixture)
    assert.equal(await fixture.worker.run({ taskId: 1 }), 'pending')
    assert.deepEqual(transitions(fixture), before)
    assert.equal(fixture.state.modelCalls, 0)
    assert.equal(fixture.rows.get('generation-attempts').length, 1)
    assertLocking(fixture)
  })
}
for (const [leaseUntil, shouldExpire] of [
  ['2026-11-13T11:59:59.999Z', true],
  [now, true],
  ['2026-11-13T12:00:00.001Z', false],
]) {
  test(`should keep actual worker prepared lease ${leaseUntil} ${shouldExpire ? 'expired' : 'live'}`, async () => {
    const fixture = await applicationFixture({ commitUnknownAt: 'prepared' })
    await assert.rejects(
      fixture.worker.run({ taskId: 1 }),
      (error) => error === fixture.commitError,
    )
    fixture.row({ collection: 'generation-attempts' }).leaseUntil = leaseUntil
    const result = await fixture.worker.run({ taskId: 1 })
    assert.equal(result, shouldExpire ? 'unknown' : 'pending')
    assert.equal(fixture.rows.get('generation-attempts').length, shouldExpire ? 2 : 1)
    if (shouldExpire) {
      assert.equal(fixture.row({ collection: 'generation-attempts' }).errorCode, 'NOT_SENT')
      assert.equal(fixture.row({ collection: 'generation-attempts' }).finishedAt, now)
    }
    assertLocking(fixture)
  })
}
for (const [engineKind, expiresAt, expectedAllocation] of [
  ['not_sent', null, 'released'],
  ['rejected', now, 'expired'],
]) {
  test(`should settle actual ${engineKind} release with allocation ${expectedAllocation} and fixed ordering`, async () => {
    const fixture = await applicationFixture({ engineKind, expiresAt })
    assert.equal(await fixture.worker.run({ taskId: 1 }), 'failed')
    assert.equal(fixture.row({ collection: 'credit-allocations' }).status, expectedAllocation)
    const grant = fixture.row({ collection: 'credit-grants' })
    assert.equal(grant.reservedCredits, 0)
    assert.equal(grant.availableCredits, expectedAllocation === 'released' ? 5 : 3)
    assert.equal(grant.expiredCredits, expectedAllocation === 'expired' ? 2 : 0)
    assert.deepEqual(transitions(fixture).slice(-7), [
      'update:credit-grants:',
      'create:credit-ledger:release',
      `update:credit-allocations:${expectedAllocation}`,
      'update:credit-accounts:',
      'update:credit-reservations:released',
      'update:generation-attempts:failed',
      'update:generation-tasks:failed',
    ])
    assert.equal(await fixture.worker.run({ taskId: 1 }), 'failed')
    assert.equal(fixture.state.modelCalls, 1)
    assertLocking(fixture)
  })
}
for (const titleSource of ['default', 'user']) {
  test(`should deliver actual recovered output and leave ${titleSource} naming policy in application`, async () => {
    const fixture = await applicationFixture({ titleSource })
    await fixture.worker.run({ taskId: 1 })
    fixture.state.storageCandidates = [fixture.stored()]
    assert.equal(await fixture.worker.run({ taskId: 1 }), 'succeeded')
    assert.equal(fixture.state.modelCalls, 1)
    const session = fixture.row({ collection: 'creation-sessions' })
    assert.equal(session.autoNameStatus, titleSource === 'user' ? 'skipped' : 'pending')
    assert.equal(session.coverArtifactId, fixture.row({ collection: 'artifacts' }).id)
    assert.deepEqual(transitions(fixture).slice(5), [
      'update:generation-attempts:output_ready',
      'create:media:',
      'create:artifacts:',
      'update:credit-grants:',
      'create:credit-ledger:capture',
      'update:credit-allocations:captured',
      'update:credit-accounts:',
      'update:credit-reservations:captured',
      'update:generation-attempts:succeeded',
      'update:generation-tasks:succeeded',
      ...(titleSource === 'user' ? [] : ['queue:naming:']),
      'update:creation-sessions:',
    ])
    assertLocking(fixture)
  })
}
test('should release zero-cost reservation without allocation or ledger writes', async () => {
  const fixture = await applicationFixture({ cost: 0, engineKind: 'not_sent' })
  assert.equal(await fixture.worker.run({ taskId: 1 }), 'failed')
  assert.equal(fixture.row({ collection: 'credit-reservations' }).status, 'released')
  assert.equal(fixture.rows.get('credit-allocations').length, 0)
  assert.equal(fixture.rows.get('credit-ledger').length, 0)
  assert.deepEqual(transitions(fixture).slice(-4), [
    'update:credit-accounts:',
    'update:credit-reservations:released',
    'update:generation-attempts:failed',
    'update:generation-tasks:failed',
  ])
  assertLocking(fixture)
})
test('should close unknown with trusted actor and preserve closed state when late storage output arrives', async () => {
  const fixture = await applicationFixture()
  await fixture.worker.run({ taskId: 1 })
  fixture.state.storageCandidates = [fixture.stored()]
  fixture.state.beforeRecovery = async () => {
    fixture.state.beforeRecovery = null
    assert.equal(
      await fixture.worker.closeUnknown({ taskId: 1, operationId: 'review-1', reason: 'REVIEWED' }),
      'closed',
    )
  }
  assert.equal(await fixture.worker.run({ taskId: 1 }), 'closed')
  assert.equal(fixture.state.modelCalls, 1)
  assert.equal(fixture.row({ collection: 'generation-tasks' }).status, 'closed')
  assert.equal(fixture.row({ collection: 'generation-tasks' }).updatedBy, 'admin:12')
  const attempt = fixture.row({ collection: 'generation-attempts' })
  assert.equal(attempt.status, 'unknown')
  assert.equal(attempt.errorCode, 'PROVIDER_UNKNOWN')
  assert.equal(attempt.finishedAt, undefined)
  assert.equal(fixture.rows.get('artifacts'), undefined)
  const audit = fixture.row({ collection: 'auditLogs' })
  assert.equal(audit.createdBy, 'admin:12')
  assert.equal(audit.actorId, '12')
  assert.equal(audit.actorType, 'admin')
  assert.deepEqual(audit.beforeState, { attemptId: attempt.id, status: 'unknown' })
  assert.deepEqual(audit.afterState, { attemptId: attempt.id, status: 'closed' })
  assert.equal(fixture.row({ collection: 'credit-reservations' }).status, 'released')
  assertLocking(fixture)
})

test('should wire the production worker factory to the semantic writer with fake transaction/Local API ports', async () => {
  const fixture = await applicationFixture()
  const worker = await fixture.realWorker()
  assert.equal(await worker.run({ taskId: 1 }), 'unknown')
  fixture.state.storageCandidates = [fixture.stored()]
  assert.equal(await worker.run({ taskId: 1 }), 'succeeded')
  assert.equal(fixture.state.modelCalls, 1)
  assert.equal(fixture.row({ collection: 'credit-reservations' }).status, 'captured')
  assert.equal(fixture.row({ collection: 'creation-sessions' }).autoNameStatus, 'pending')
  const calls = fixture.calls.filter(({ operation }) =>
    ['create', 'update', 'queue'].includes(operation),
  )
  const delivery = calls.slice(calls.findIndex(({ collection }) => collection === 'media'))
  assert.equal(delivery.length, 11)
  for (const call of delivery) assert.equal(call.req, delivery[0].req)
  assert.equal(fixture.rows.get('artifacts').length, 1)
})
for (const isComplete of [true, false]) {
  test(`should ${isComplete ? 'confirm' : 'reject'} a committed delivery using complete read-only evidence`, async () => {
    const fixture = await applicationFixture()
    await fixture.worker.run({ taskId: 1 })
    fixture.state.storageCandidates = [fixture.stored()]
    fixture.state.commitUnknownAt = 'succeeded'
    if (!isComplete)
      fixture.state.afterCommit = () => {
        fixture.rows.set(
          'credit-ledger',
          fixture.rows.get('credit-ledger').filter((entry) => entry.operation !== 'capture'),
        )
      }
    if (isComplete) assert.equal(await fixture.worker.run({ taskId: 1 }), 'succeeded')
    else
      await assert.rejects(
        fixture.worker.run({ taskId: 1 }),
        (error) => error.code === 'DATA_INTEGRITY_CONFLICT',
      )
    assert.equal(fixture.state.modelCalls, 1)
    assert.equal(fixture.rows.get('artifacts').length, 1)
    const writes = transitions(fixture)
    if (isComplete) assert.equal(await fixture.worker.run({ taskId: 1 }), 'succeeded')
    else
      await assert.rejects(
        fixture.worker.run({ taskId: 1 }),
        (error) => error.code === 'DATA_INTEGRITY_CONFLICT',
      )
    assert.deepEqual(transitions(fixture), writes)
    assertLocking(fixture)
  })
}

test('should invoke the injected real worker verifier outside locks before output storage', async () => {
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  const seen = []
  const fixture = await applicationFixture({
    imageValidator: async (args) => {
      seen.push(args)
      return validateImage(args)
    },
  })
  fixture.state.engineResult = {
    kind: 'output',
    bytes,
    contentType: 'image/png',
    requestId: 'provider-image',
  }
  assert.equal(await fixture.worker.run({ taskId: 1 }), 'unknown')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].input, bytes)
  assert.equal(seen[0].declaredMimeType, 'image/png')
  const validationIndex = fixture.calls.findIndex(({ operation }) => operation === 'validateImage')
  const storageIndex = fixture.calls.findIndex(({ operation }) => operation === 'putImmutable')
  assert(validationIndex >= 0 && storageIndex > validationIndex)
  assert.deepEqual(fixture.calls[storageIndex].bytes, bytes)
  assert.equal(fixture.row({ collection: 'generation-attempts' }).status, 'unknown')
  assert.equal(fixture.row({ collection: 'credit-reservations' }).status, 'reserved')
})

test('should bind both production Payload factories to the real decoder despite untyped host validator overrides', async () => {
  const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  for (const isValid of [true, false]) {
    for (const isFunction of [true, false]) {
      let hostCalls = 0
      const hostOptions = {
        validateImage: isFunction
          ? async (args) => {
              hostCalls++
              return validateImage(args)
            }
          : null,
      }
      const fixture = await applicationFixture()
      const worker = await fixture.realWorker(hostOptions)
      const bytes = isValid ? png : png.subarray(0, 63)
      fixture.state.engineResult = {
        kind: 'output',
        bytes,
        contentType: 'image/png',
        requestId: 'provider-image',
      }
      assert.equal(await worker.run({ taskId: 1 }), 'unknown')
      assert.equal(hostCalls, 0)
      assert.equal(
        fixture.calls.filter(({ operation }) => operation === 'putImmutable').length,
        isValid ? 1 : 0,
      )
      const media = fixture.realMedia(hostOptions)
      await assert.rejects(
        media.uploadForUser({ input: bytes, originalName: 'image.png', userId: 11 }),
        isValid ? /verified output storage sentinel/ : { code: 'INVALID_MEDIA' },
      )
      assert.equal(hostCalls, 0)
      assert.equal(
        fixture.calls.filter(({ operation }) => operation === 'putImmutable').length,
        isValid ? 2 : 0,
      )
      assert.equal(fixture.calls.filter(({ operation }) => operation === 'validateImage').length, 0)
    }
  }
})
