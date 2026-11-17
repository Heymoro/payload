import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createGenerationService } from '../src/creation/application/generation.ts'
import { hashTaskClientInput } from '../src/creation/domain/input.ts'
import { createQuoteCodec } from '../src/creation/domain/quote.ts'
import { creationCollectionSlugs } from '../src/creation/infrastructure/payload/collections.ts'
import { createGenerationReader } from '../src/creation/infrastructure/payload/generation-reader.ts'
import { createPayloadGenerationRepository } from '../src/creation/infrastructure/payload/generation-repository.ts'

const now = '2026-11-12T12:00:00.000Z'
const taskArgs = {
  clientRequestId: ' request ',
  costCredits: 2,
  description: ' literal\n',
  executionSnapshotJson: '{"unchanged":true}',
  now,
  requestHash: 'a'.repeat(64),
  roundNo: 3,
  sessionId: 12,
  sourceTaskId: null,
  templateId: 14,
  userId: 11,
  userNotes: ' notes ',
}
const projectionFields = [
  'clientRequestId',
  'costCredits',
  'errorCode',
  'id',
  'roundNo',
  'sessionId',
  'sourceTaskId',
  'status',
  'templateId',
]
const caps = {
  allowedMimeTypes: ['image/png'],
  maxDescriptionLength: 200,
  maxImageBytes: 1000,
  maxImages: 4,
  maxNotesLength: 100,
  maxTotalImageBytes: 2000,
  minImages: 0,
}
function audit({ actor }) {
  return {
    createdAt: now,
    createdBy: actor,
    deletedAt: null,
    deletedBy: null,
    isDeleted: false,
    updatedAt: now,
    updatedBy: actor,
  }
}
function poisoned({ args }) {
  return Object.defineProperty({ ...args }, 'unexpected', {
    enumerable: true,
    get: () => assert.fail('Caller extras must not be read or spread'),
  })
}
function fixture() {
  const calls = []
  const rows = new Map()
  const req = { transactionID: 'unit-transaction' }
  let nextId = 100
  const gate = {
    assert: ({ req: request }) => {
      assert.equal(request, req)
      calls.push({ operation: 'assert' })
    },
    beforeOperation: () => {},
    run: async ({ req: request, work }) => {
      assert.equal(request, req)
      calls.push({ operation: 'gate' })
      return work()
    },
  }
  const payload = {
    collections: Object.fromEntries(
      [...creationCollectionSlugs, 'media', 'auditLogs', 'users'].map((slug) => [
        slug,
        {
          config: {
            flattenedFields: [{ name: 'status' }, { name: 'isDeleted', type: 'checkbox' }],
            hooks: { beforeOperation: [gate.beforeOperation] },
          },
        },
      ]),
    ),
    create: async (args) => {
      calls.push({ ...args, operation: 'create' })
      const doc = { ...args.data, id: nextId++ }
      rows.set(args.collection, [...(rows.get(args.collection) ?? []), doc])
      return { ...doc, unexpected: 'private' }
    },
    find: async (args) => {
      calls.push({ ...args, operation: 'find' })
      let docs = (rows.get(args.collection) ?? []).filter((doc) =>
        matches({ doc, where: args.where }),
      )
      if (args.sort) {
        const fields = Array.isArray(args.sort) ? args.sort : [args.sort]
        docs = [...docs].sort((left, right) => {
          for (const field of fields) {
            const key = field.replace(/^-/, '')
            const direction = field.startsWith('-') ? -1 : 1
            if (left[key] !== right[key]) return (left[key] < right[key] ? -1 : 1) * direction
          }
          return 0
        })
      }
      const totalDocs = docs.length
      if (args.limit) docs = docs.slice(0, args.limit)
      return { docs, totalDocs }
    },
    jobs: {
      queue: async (args) => {
        calls.push({ ...args, operation: 'queue' })
      },
    },
    update: async (args) => {
      calls.push({ ...args, operation: 'update' })
      const doc = rows.get(args.collection)?.find((value) => value.id === args.id)
      if (doc) Object.assign(doc, args.data)
      return { id: args.id, ...args.data }
    },
  }
  const repository = createPayloadGenerationRepository({ gate, payload, req })
  calls.length = 0
  return { calls, gate, payload, repository, req, rows }
}
function matches({ doc, where }) {
  if (!where) return true
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'and') return condition.every((value) => matches({ doc, where: value }))
    if (field === 'or') return condition.some((value) => matches({ doc, where: value }))
    return Object.entries(condition).every(([operator, value]) => {
      if (operator === 'equals') return doc[field] === value
      if (operator === 'in') return value.includes(doc[field])
      if (operator === 'greater_than') return doc[field] > value
      if (operator === 'greater_than_equal') return doc[field] >= value
      if (operator === 'less_than') return doc[field] < value
      assert.fail(`Unexpected test predicate ${operator}`)
    })
  })
}
function writes({ calls }) {
  return calls.filter(({ operation }) => ['create', 'update', 'queue'].includes(operation))
}
function applicationFixture({ cost = 2, hasAccount = true } = {}) {
  const state = fixture()
  const { calls, payload, repository, rows } = state
  const seed = ({ collection, docs }) =>
    rows.set(
      collection,
      docs.map((doc) => ({ isDeleted: false, ...doc })),
    )
  seed({ collection: 'users', docs: [{ id: 11, status: 'active' }] })
  seed({
    collection: 'creation-sessions',
    docs: [{ id: 12, mode: 'free', nextRoundNo: 3, templateId: 13, userId: 11 }],
  })
  seed({
    collection: 'creation-templates',
    docs: [
      {
        costCredits: cost,
        displayConfigJson: JSON.stringify({ name: 'Unit', coverMediaId: 1, examples: [] }),
        generationConfigJson: JSON.stringify({
          executorId: 'unit-v1',
          parameters: {},
          systemPrompt: 'Unit prompt',
        }),
        id: 13,
        kind: 'free',
        inputSchemaJson: JSON.stringify({ ...caps, maxNotesLength: 0 }),
        minClientCapability: 'v1',
        schemaVersion: 1,
        status: 'published',
      },
    ],
  })
  seed({
    collection: 'media',
    docs: [22, 21].map((id) => ({
      filesize: 500,
      id,
      lifecycle: 'active',
      mimeType: 'image/png',
      owner: 11,
      purpose: 'reference',
      sha256: String(id === 22 ? 2 : 1).repeat(64),
      storageBackend: 'unit-metadata',
      storageBucket: 'unit-input',
      storageName: `unit/${id}.png`,
      visibility: 'private',
    })),
  })
  seed({
    collection: 'credit-accounts',
    docs: hasAccount ? [{ id: 30, userId: 11, availableCredits: 5, reservedCredits: 0 }] : [],
  })
  seed({
    collection: 'credit-grants',
    docs: hasAccount
      ? [
          { id: 33, expiresAt: null, availableCredits: 2 },
          { id: 32, expiresAt: '2026-11-14T00:00:00.000Z', availableCredits: 1 },
          { id: 31, expiresAt: '2026-11-14T00:00:00.000Z', availableCredits: 1 },
          { id: 34, expiresAt: '2026-11-11T00:00:00.000Z', availableCredits: 1 },
        ].map((grant) => ({
          accountId: 30,
          consumedCredits: 0,
          expiredCredits: 0,
          grantKey: `unit:${grant.id}`,
          issuedCredits: grant.availableCredits,
          reservedCredits: 0,
          revokedCredits: 0,
          sourceId: null,
          sourceType: 'trial',
          userId: 11,
          validFrom: '2026-11-10T00:00:00.000Z',
          ...grant,
        }))
      : [],
  })
  let isLocked = false
  const quoteCodec = createQuoteCodec({
    issuer: 'unit',
    audience: 'unit-submission',
    signingKid: 'unit',
    keys: { unit: new Uint8Array(32).fill(17) },
    ttlSeconds: 60,
  })
  const service = createGenerationService({
    clock: () => {
      calls.push({ isLocked, operation: 'clock' })
      return now
    },
    execution: {
      registry: {
        'unit-v1': {
          allowedParameters: [],
          model: 'unit-model',
          parameterRules: {},
          provider: 'unit-provider',
          storageBackends: ['unit-metadata'],
        },
      },
      storageOutput: {
        backend: 'unit-metadata',
        bucket: 'unit-output',
        keyRule: 'task-attempt-result-v1',
      },
    },
    hostCaps: caps,
    isCompatible: () => true,
    quoteCodec,
    read: ({ work }) =>
      work({ reader: createGenerationReader({ find: (args) => payload.find(args) }) }),
    write: async ({ resources, work }) => {
      calls.push({ operation: 'lock', resources })
      isLocked = true
      try {
        return await work({ repository })
      } finally {
        isLocked = false
      }
    },
  })
  const args = {
    input: { description: ' literal\n', inputMediaIds: [22, 21], userNotes: '' },
    sessionId: 12,
    userId: 11,
  }
  return { ...state, args, service }
}

test('should expose semantic submission writes without runtime generic CRUD', () => {
  const { repository } = fixture()
  for (const key of ['create', 'update', 'updateExpected', 'queue'])
    assert.equal(key in repository, false, key)
  for (const key of [
    'insertQueuedTask',
    'insertOrderedTaskInputs',
    'insertGenerationReservation',
    'insertGenerationAllocation',
    'advanceSessionRound',
    'enqueueGeneration',
  ])
    assert.equal(typeof repository[key], 'function', key)
})

test('should map queued task fields and return only nine untrusted projected fields', async () => {
  const { calls, payload, repository, req } = fixture()
  const returned = Object.fromEntries(projectionFields.map((key) => [key, { key }]))
  payload.create = async (args) => {
    calls.push({ ...args, operation: 'create' })
    return { ...returned, unexpected: 'private' }
  }
  const result = await repository.insertQueuedTask(
    poisoned({ args: { ...taskArgs, status: 'succeeded', createdBy: 'caller' } }),
  )
  assert.deepEqual(result, returned)
  const { now: ignored, ...input } = taskArgs
  assert.equal(ignored, now)
  assert.deepEqual(writes({ calls }), [
    {
      collection: 'generation-tasks',
      data: {
        ...audit({ actor: 'user:11' }),
        ...input,
        errorCode: null,
        finishedAt: null,
        startedAt: null,
        status: 'queued',
      },
      depth: 0,
      operation: 'create',
      overrideAccess: true,
      req,
    },
  ])
  assert.equal(writes({ calls })[0].req, req)
})

test('should map reservation and allocation fixed audit and state without caller extras', async () => {
  const { calls, repository, req } = fixture()
  const result = await repository.insertGenerationReservation(
    poisoned({
      args: {
        accountId: 30,
        amountCredits: 2,
        now,
        reservationKey: 'generation:100',
        taskId: 100,
        userId: 11,
        status: 'captured',
      },
    }),
  )
  assert.deepEqual(result, { id: 100 })
  assert.equal(
    await repository.insertGenerationAllocation(
      poisoned({
        args: { amountCredits: 2, grantId: 31, now, reservationId: 100, status: 'captured' },
      }),
    ),
    undefined,
  )
  assert.deepEqual(writes({ calls }), [
    {
      collection: 'credit-reservations',
      data: {
        ...audit({ actor: 'system:generation' }),
        accountId: 30,
        amountCredits: 2,
        reservationKey: 'generation:100',
        reviewAfter: null,
        settledAt: null,
        status: 'reserved',
        taskId: 100,
        userId: 11,
      },
      depth: 0,
      operation: 'create',
      overrideAccess: true,
      req,
    },
    {
      collection: 'credit-allocations',
      data: {
        ...audit({ actor: 'system:generation' }),
        amountCredits: 2,
        grantId: 31,
        reservationId: 100,
        status: 'reserved',
      },
      depth: 0,
      operation: 'create',
      overrideAccess: true,
      req,
    },
  ])
  for (const call of writes({ calls })) assert.equal(call.req, req)
})

test('should insert inputs in caller order serially without sorting or deduplication', async () => {
  const { calls, payload, repository, req } = fixture()
  let release
  payload.create = async (args) => {
    calls.push({ ...args, operation: 'create' })
    if (calls.filter(({ operation }) => operation === 'create').length === 1)
      await new Promise((resolve) => {
        release = resolve
      })
    return { id: 1 }
  }
  const inputs = [
    { contentSha256: 'b', mediaId: 22, position: 7 },
    { contentSha256: 'a', mediaId: 21, position: 2 },
    { contentSha256: 'a', mediaId: 21, position: 2 },
  ]
  const pending = repository.insertOrderedTaskInputs(
    poisoned({
      args: {
        inputs: inputs.map((input) => poisoned({ args: input })),
        now,
        taskId: 100,
        userId: 11,
      },
    }),
  )
  await Promise.resolve()
  assert.equal(writes({ calls }).length, 1)
  release()
  assert.equal(await pending, undefined)
  assert.deepEqual(
    writes({ calls }),
    inputs.map((input) => ({
      collection: 'generation-inputs',
      data: { ...audit({ actor: 'user:11' }), ...input, taskId: 100, userId: 11 },
      depth: 0,
      operation: 'create',
      overrideAccess: true,
      req,
    })),
  )
  for (const call of writes({ calls })) assert.equal(call.req, req)
})

test('should stop ordered input writes on the original error', async () => {
  const { calls, payload, repository } = fixture()
  const error = new Error('unit input failure')
  payload.create = async (args) => {
    calls.push({ ...args, operation: 'create' })
    if (args.data.position === 2) throw error
    return { id: 1 }
  }
  await assert.rejects(
    repository.insertOrderedTaskInputs({
      inputs: [1, 2, 3].map((position) => ({ contentSha256: 'a', mediaId: 21, position })),
      now,
      taskId: 100,
      userId: 11,
    }),
    (caught) => caught === error,
  )
  assert.deepEqual(
    writes({ calls }).map(({ data }) => data.position),
    [1, 2],
  )
})

test('should advance only session activity and round through ordinary update', async () => {
  const { calls, repository, req } = fixture()
  assert.equal(
    await repository.advanceSessionRound(
      poisoned({
        args: {
          nextRoundNo: 4,
          now,
          sessionId: 12,
          userId: 11,
          title: 'untrusted',
          isDeleted: true,
        },
      }),
    ),
    undefined,
  )
  assert.deepEqual(writes({ calls }), [
    {
      collection: 'creation-sessions',
      data: { lastActivityAt: now, nextRoundNo: 4, updatedAt: now, updatedBy: 'user:11' },
      depth: 0,
      id: 12,
      operation: 'update',
      overrideAccess: true,
      req,
    },
  ])
  assert.equal(writes({ calls })[0].req, req)
})

test('should enqueue fixed task shape inside the same gate with before and after assertions', async () => {
  const { calls, repository, req } = fixture()
  assert.equal(
    await repository.enqueueGeneration(
      poisoned({ args: { taskId: 100, queue: 'other', task: 'other', input: {} } }),
    ),
    undefined,
  )
  assert.deepEqual(calls, [
    { operation: 'gate' },
    { operation: 'assert' },
    {
      input: { taskId: 100 },
      operation: 'queue',
      overrideAccess: true,
      queue: 'creation',
      req,
      task: 'heymoro-generate-v1',
    },
    { operation: 'assert' },
  ])
  assert.equal(calls[2].req, req)
})

test('should propagate original write errors for all remaining semantic adapters', async () => {
  for (const [method, args, operation] of [
    ['insertQueuedTask', taskArgs, 'create'],
    [
      'insertGenerationReservation',
      {
        accountId: 30,
        amountCredits: 2,
        now,
        reservationKey: 'generation:100',
        taskId: 100,
        userId: 11,
      },
      'create',
    ],
    [
      'insertGenerationAllocation',
      { amountCredits: 2, grantId: 31, now, reservationId: 100 },
      'create',
    ],
    ['advanceSessionRound', { nextRoundNo: 4, now, sessionId: 12, userId: 11 }, 'update'],
    ['enqueueGeneration', { taskId: 100 }, 'queue'],
  ]) {
    const { payload, repository } = fixture()
    const error = new Error(method)
    const fail = async () => {
      throw error
    }
    if (operation === 'queue') payload.jobs.queue = fail
    else payload[operation] = fail
    await assert.rejects(repository[method](args), (caught) => caught === error)
  }
})

test('should honor enqueue gate checks before and after dispatch with original error identity', async () => {
  for (const failedCheck of [1, 2]) {
    const { calls, gate, repository } = fixture()
    const error = new Error(`lease-check:${failedCheck}`)
    let checks = 0
    gate.assert = () => {
      if (++checks === failedCheck) throw error
    }
    await assert.rejects(
      repository.enqueueGeneration({ taskId: 100 }),
      (caught) => caught === error,
    )
    assert.equal(writes({ calls }).length, failedCheck - 1)
  }
})

test('should run actual admission in task-input-wallet-reservation-allocation-projection-session-job order', async () => {
  const state = applicationFixture()
  const { args, calls, rows, service } = state
  const quote = await service.quoteGenerate(args)
  calls.length = 0
  const result = await service.submitGenerate({
    ...args,
    clientRequestId: 'unit-submit',
    quoteToken: quote.quoteToken,
  })
  assert.equal(result.isNew, true)
  assert.deepEqual(calls.find(({ operation }) => operation === 'lock').resources, [
    'session:11:12',
    'wallet:11',
  ])
  assert.deepEqual(
    calls.filter(({ operation }) => operation === 'clock'),
    [{ isLocked: true, operation: 'clock' }],
  )
  assert.deepEqual(
    writes(state).map(({ collection, data, operation }) =>
      operation === 'queue'
        ? 'job'
        : `${operation}:${collection}${collection === 'credit-ledger' ? `:${data.operation}` : ''}`,
    ),
    [
      'create:generation-tasks',
      'create:generation-inputs',
      'create:generation-inputs',
      'update:credit-grants',
      'create:credit-ledger:expire',
      'update:credit-accounts',
      'create:credit-reservations',
      'create:credit-allocations',
      'update:credit-grants',
      'create:credit-ledger:reserve',
      'create:credit-allocations',
      'update:credit-grants',
      'create:credit-ledger:reserve',
      'update:credit-accounts',
      'update:creation-sessions',
      'job',
    ],
  )
  assert.deepEqual(
    rows.get('generation-inputs').map(({ mediaId, position }) => [mediaId, position]),
    [
      [22, 1],
      [21, 2],
    ],
  )
  assert.deepEqual(
    rows.get('credit-allocations').map(({ amountCredits, grantId }) => [grantId, amountCredits]),
    [
      [31, 1],
      [32, 1],
    ],
  )
  const task = rows.get('generation-tasks')[0]
  const snapshot = JSON.parse(task.executionSnapshotJson)
  assert.equal(task.requestHash, hashTaskClientInput({ clientInput: snapshot.clientInput }))
  assert.equal(task.description, args.input.description)
  assert.deepEqual(snapshot.input, args.input)
  const lock = calls.findIndex(({ operation }) => operation === 'lock')
  const taskWrite = calls.findIndex(
    ({ collection, operation }) => collection === 'generation-tasks' && operation === 'create',
  )
  assert.deepEqual(
    calls
      .slice(lock + 1, taskWrite)
      .filter(({ operation }) => operation === 'find')
      .map(({ collection }) => collection),
    [
      'users',
      'generation-tasks',
      'creation-sessions',
      'creation-templates',
      'media',
      'media',
      'generation-tasks',
      'generation-tasks',
    ],
  )
})

test('should recheck idempotency inside lock and return prior task without writes or quote/config dependency', async () => {
  const state = applicationFixture()
  const { args, calls, rows, service } = state
  const quote = await service.quoteGenerate(args)
  const submission = { ...args, clientRequestId: 'unit-replay', quoteToken: quote.quoteToken }
  const first = await service.submitGenerate(submission)
  rows.set('creation-templates', [])
  rows.set('creation-templates', [])
  calls.length = 0
  const replay = await service.submitGenerate({ ...submission, quoteToken: 'expired-or-invalid' })
  assert.equal(replay.isNew, false)
  assert.deepEqual(replay.task, first.task)
  assert.deepEqual(writes(state), [])
  const lock = calls.findIndex(({ operation }) => operation === 'lock')
  assert.deepEqual(
    calls
      .slice(lock + 1)
      .filter(({ operation }) => operation === 'find')
      .slice(0, 2)
      .map(({ collection }) => collection),
    ['users', 'generation-tasks'],
  )
  await assert.rejects(
    service.submitGenerate({ ...submission, input: { ...args.input, description: 'changed' } }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  )
})

test('should retain zero-cost account and zero reservation without allocation or ledger', async () => {
  const state = applicationFixture({ cost: 0, hasAccount: false })
  const { args, rows, service } = state
  const quote = await service.quoteGenerate(args)
  state.calls.length = 0
  const result = await service.submitGenerate({
    ...args,
    clientRequestId: 'unit-zero',
    quoteToken: quote.quoteToken,
  })
  assert.equal(result.task.costCredits, 0)
  assert.deepEqual(
    writes(state).map(({ collection, operation }) =>
      operation === 'queue' ? 'job' : `${operation}:${collection}`,
    ),
    [
      'create:generation-tasks',
      'create:generation-inputs',
      'create:generation-inputs',
      'create:credit-accounts',
      'create:credit-reservations',
      'update:credit-accounts',
      'update:creation-sessions',
      'job',
    ],
  )
  assert.equal(rows.get('credit-reservations')[0].amountCredits, 0)
  assert.equal(rows.get('credit-reservations')[0].accountId, rows.get('credit-accounts')[0].id)
  assert.equal(rows.has('credit-allocations'), false)
  assert.equal(rows.has('credit-ledger'), false)
})

test('should detect a request that appears only after the admission lock', async () => {
  const state = applicationFixture()
  const { args, calls, payload, service } = state
  const quote = await service.quoteGenerate(args)
  const submission = { ...args, clientRequestId: 'unit-race', quoteToken: quote.quoteToken }
  const first = await service.submitGenerate(submission)
  const find = payload.find
  let hasHiddenInitialRequest = false
  payload.find = (query) => {
    if (!query.req && query.collection === 'generation-tasks' && !hasHiddenInitialRequest) {
      hasHiddenInitialRequest = true
      calls.push({ ...query, operation: 'find' })
      return Promise.resolve({ docs: [], totalDocs: 0 })
    }
    return find(query)
  }
  calls.length = 0
  const replay = await service.submitGenerate({
    ...submission,
    quoteToken: 'not-verified-on-replay',
  })
  assert.equal(hasHiddenInitialRequest, true)
  assert.equal(replay.isNew, false)
  assert.deepEqual(replay.task, first.task)
  assert.deepEqual(writes(state), [])
})

test('should reject changed active, blocking and round state inside the lock before any write', async () => {
  for (const [change, expectedCode] of [
    ['inactive', 'UNAUTHENTICATED'],
    ['blocking', 'GENERATION_IN_PROGRESS'],
    ['round', 'DATA_INTEGRITY_CONFLICT'],
    ['overflow', 'DATA_INTEGRITY_CONFLICT'],
  ]) {
    const state = applicationFixture()
    const { args, calls, payload, rows, service } = state
    const quote = await service.quoteGenerate(args)
    const find = payload.find
    let hasChangedLockedState = false
    payload.find = (query) => {
      if (query.req && !hasChangedLockedState) {
        hasChangedLockedState = true
        if (change === 'inactive') rows.get('users')[0].status = 'disabled'
        if (change === 'overflow')
          rows.get('creation-sessions')[0].nextRoundNo = Number.MAX_SAFE_INTEGER
        if (change === 'blocking' || change === 'round') {
          rows.set('generation-tasks', [
            {
              id: 90,
              isDeleted: false,
              roundNo: 3,
              sessionId: 12,
              status: change === 'blocking' ? 'queued' : 'succeeded',
            },
          ])
        }
      }
      return find(query)
    }
    calls.length = 0
    await assert.rejects(
      service.submitGenerate({
        ...args,
        clientRequestId: `unit-${change}`,
        quoteToken: quote.quoteToken,
      }),
      { code: expectedCode },
    )
    assert.equal(hasChangedLockedState, true)
    assert.deepEqual(writes(state), [])
  }
})

test('same-price prompt edit invalidates old quote before any task or funds write', async () => {
  const { args, service, rows } = applicationFixture()
  const quote = await service.quoteGenerate(args)
  const template = rows.get('creation-templates')[0]
  const generation = JSON.parse(template.generationConfigJson)
  template.generationConfigJson = JSON.stringify({ ...generation, systemPrompt: 'Changed prompt' })
  await assert.rejects(
    service.submitGenerate({
      ...args,
      clientRequestId: 'changed-config',
      quoteToken: quote.quoteToken,
    }),
    { code: 'QUOTE_CHANGED' },
  )
  assert.equal((rows.get('generation-tasks') ?? []).length, 0)
  assert.equal((rows.get('credit-reservations') ?? []).length, 0)
})

test('accepted task retains original plan after save and replays even with invalid old quote and offline template', async () => {
  const { args, service, rows } = applicationFixture()
  const quote = await service.quoteGenerate(args)
  const command = { ...args, clientRequestId: 'kept-config', quoteToken: quote.quoteToken }
  const accepted = await service.submitGenerate(command)
  const template = rows.get('creation-templates')[0]
  template.status = 'offline'
  template.generationConfigJson = 'changed'
  const retry = await service.submitGenerate({ ...command, quoteToken: 'not-a-token' })
  assert.equal(retry.task.id, accepted.task.id)
  assert.equal(retry.isNew, false)
  const tasks = rows.get('generation-tasks')
  assert.equal(tasks.length, 1)
  assert.equal(JSON.parse(tasks[0].executionSnapshotJson).executionPlan.systemPrompt, 'Unit prompt')
  assert.equal(Object.hasOwn(tasks[0], 'templateVersionId'), false)
})
