import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

const domain = () => import('../src/creation/domain/session.ts')
const application = () => import('../src/creation/application/session.ts')
const now = '2026-11-12T15:30:00.000Z'
const command = { templateId: 11, clientRequestId: '  请求:/\n🔑  ' }
const hash = (value) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
const requestHash = hash({ templateId: 11 })
const hostCaps = {
  allowedMimeTypes: ['image/jpeg', 'image/png'],
  maxDescriptionLength: 200,
  maxImageBytes: 1000,
  maxImages: 4,
  maxNotesLength: 100,
  maxTotalImageBytes: 3000,
  minImages: 0,
}
const display = {
  name: '复古全家福',
  coverMediaId: 21,
  examples: [{ inputMediaIds: [31], outputMediaId: 32 }],
}
const publicInput = (mode) =>
  mode === 'effect'
    ? { ...hostCaps, minImages: 1, maxDescriptionLength: 0 }
    : { ...hostCaps, maxNotesLength: 0 }
const audit = {
  createdAt: now,
  createdBy: 'user:7',
  updatedAt: now,
  updatedBy: 'user:7',
  isDeleted: false,
  deletedAt: null,
  deletedBy: null,
}

const expectError =
  ({ code, status }) =>
  (error) => {
    assert.equal(error.name, 'SessionError')
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    return true
  }

// This is an in-memory fake port, including snapshot rollback, not a DB/Redis adapter.
async function fixture({
  isCompatible = () => true,
  caps = structuredClone(hostCaps),
  coordinationError,
  sessionError,
  draftError,
} = {}) {
  const { createSessionCreator } = await application()
  const state = {
    isAccountActive: true,
    sessions: [],
    drafts: [],
    template: {
      id: 11,
      name: '复古全家福',
      kind: 'effect',
      status: 'published',
      schemaVersion: 1,
      displayConfigJson: JSON.stringify(display),
      inputSchemaJson: JSON.stringify(publicInput('effect')),
      minClientCapability: 'image-v2',
      isDeleted: false,
    },
  }
  const calls = []
  const resources = []
  let clockCalls = 0
  const createSession = createSessionCreator({
    clock: () => {
      clockCalls++
      return now
    },
    isCompatible,
    hostCaps: caps,
    runCoordinatedTransaction: async ({ resource, work }) => {
      resources.push(resource)
      if (coordinationError) throw coordinationError
      const before = structuredClone(state)
      const repository = {
        isAccountActive: async ({ userId }) => {
          calls.push(['account', userId])
          return state.isAccountActive
        },
        findSessionsByRequest: async ({ userId, clientRequestId, includeDeleted }) => {
          assert.equal(includeDeleted, true)
          calls.push(['lookup', userId, clientRequestId])
          return state.sessions.filter(
            (session) => session.userId === userId && session.clientRequestId === clientRequestId,
          )
        },
        readTemplate: async ({ templateId }) => {
          calls.push(['template', templateId])
          return state.template
        },
        insertSession: async ({ session }) => {
          calls.push(['insertSession'])
          if (sessionError) throw sessionError
          const saved = { ...session, id: 101 + state.sessions.length }
          state.sessions.push(saved)
          return saved
        },
        insertEmptyDraft: async ({ draft }) => {
          calls.push(['insertEmptyDraft'])
          if (draftError) throw draftError
          const saved = { ...draft, id: 201 + state.drafts.length }
          state.drafts.push(saved)
          return saved
        },
      }
      try {
        return await work({ repository })
      } catch (error) {
        Object.assign(state, before)
        throw error
      }
    },
  })
  return { state, calls, resources, createSession, clockCalls: () => clockCalls }
}

test('should normalize a copied frozen command and preserve the full request key', async () => {
  const { normalizeSessionCommand } = await domain()
  const value = Object.assign(Object.create(null), {
    clientRequestId: command.clientRequestId,
    templateId: 11,
  })
  const normalized = normalizeSessionCommand({ value })

  assert.deepEqual(normalized, command)
  assert.deepEqual(Object.keys(normalized), ['clientRequestId', 'templateId'])
  assert.notEqual(normalized, value)
  assert.ok(Object.isFrozen(normalized))
  assert.equal(Object.isFrozen(value), false)
})

test('should hash stable template identity without including the request nonce', async () => {
  const { hashSessionCommand } = await domain()

  assert.equal(hashSessionCommand({ command }), requestHash)
  assert.equal(
    hashSessionCommand({
      command: { clientRequestId: 'different', templateId: 11 },
    }),
    requestHash,
  )
  assert.notEqual(hashSessionCommand({ command: { ...command, templateId: 12 } }), requestHash)
})

test('should reject non-JSON shapes, unknown fields, nulls, and explicitly undefined fields', async () => {
  const { normalizeSessionCommand, SessionError } = await domain()
  const values = [
    undefined,
    null,
    [],
    'x',
    1,
    true,
    new Date(),
    new (class Command {})(),
    Object.create(command),
    {},
    { ...command, extra: 1 },
    { ...command, templateVersionId: 22 },
    { ...command, userId: 7 },
    { ...command, [Symbol('x')]: 1 },
  ]

  for (const field of Object.keys(command)) {
    for (const value of [null, undefined]) values.push({ ...command, [field]: value })
    const missing = { ...command }
    delete missing[field]
    values.push(missing)
  }
  values.push(
    Object.defineProperty({ ...command }, 'templateId', { get: () => 11, enumerable: true }),
  )
  values.push(Object.defineProperty({ ...command }, 'templateId', { value: 11, enumerable: false }))
  for (const value of values)
    assert.throws(
      () => normalizeSessionCommand({ value }),
      (error) => {
        assert.ok(error instanceof SessionError)
        return expectError({ code: 'INPUT_INVALID', status: 400 })(error)
      },
    )
})

test('should require positive safe integer template IDs and a nonblank key of at most 128 code units', async () => {
  const { normalizeSessionCommand } = await domain()

  for (const field of ['templateId']) {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', false, {}]) {
      assert.throws(
        () => normalizeSessionCommand({ value: { ...command, [field]: value } }),
        expectError({ code: 'INPUT_INVALID', status: 400 }),
      )
    }
    assert.equal(
      normalizeSessionCommand({ value: { ...command, [field]: Number.MAX_SAFE_INTEGER } })[field],
      Number.MAX_SAFE_INTEGER,
    )
  }
  for (const clientRequestId of ['', ' \t\n', 'x'.repeat(129), 1, false, [], {}]) {
    assert.throws(
      () => normalizeSessionCommand({ value: { ...command, clientRequestId } }),
      expectError({ code: 'INPUT_INVALID', status: 400 }),
    )
  }
  assert.equal(
    normalizeSessionCommand({ value: { ...command, clientRequestId: 'x'.repeat(128) } })
      .clientRequestId.length,
    128,
  )
})

for (const mode of ['effect', 'free'])
  test(`should create one stable-template ${mode} session and a truly empty audited draft`, async () => {
    const f = await fixture()
    f.state.template.kind = mode
    f.state.template.inputSchemaJson = JSON.stringify(publicInput(mode))
    const result = await f.createSession({ userId: 7, command })
    const expectedSession = {
      ...audit,
      id: 101,
      userId: 7,
      ...command,
      requestHash,
      mode,
      title: '复古全家福',
      titleSource: 'template',
      autoNameStatus: 'idle',
      autoNameStartedAt: null,
      autoNamedAt: null,
      coverArtifactId: null,
      nextRoundNo: 1,
      lastActivityAt: now,
    }

    assert.deepEqual(result, { session: expectedSession, isNew: true })
    assert.deepEqual(f.state.sessions, [expectedSession])
    assert.deepEqual(f.state.drafts, [
      { ...audit, id: 201, userId: 7, sessionId: 101, description: '', userNotes: '' },
    ])
    assert.deepEqual(
      f.calls.map(([name]) => name),
      ['account', 'lookup', 'template', 'insertSession', 'insertEmptyDraft'],
    )
    assert.equal(f.clockCalls(), 1)
  })

test('should replay the exact existing session without touching its title, audit, or nonempty draft', async () => {
  const f = await fixture()
  const original = await f.createSession({ userId: 7, command })
  original.session.title = '用户名称'
  original.session.titleSource = 'user'
  f.state.drafts[0].description = '已编辑'
  f.state.drafts[0].userNotes = '既有备注'
  const before = structuredClone(f.state)
  f.calls.length = 0
  const result = await f.createSession({ userId: 7, command: { ...command } })

  assert.equal(result.isNew, false)
  assert.equal(result.session, original.session)
  assert.deepEqual(f.state, before)
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ['account', 'lookup'],
  )
  assert.equal(f.clockCalls(), 1)
})

test('should replay the original session after current template changes or removal', async () => {
  const f = await fixture()
  const original = await f.createSession({ userId: 7, command })
  f.state.template.displayConfigJson = JSON.stringify({ ...display, name: 'Changed title' })
  f.state.template.status = 'offline'
  f.state.template = null
  f.calls.length = 0

  assert.deepEqual(await f.createSession({ userId: 7, command }), {
    session: original.session,
    isNew: false,
  })
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ['account', 'lookup'],
  )
})

test('should reject same-key mismatched template or persisted digest without writes', async () => {
  for (const change of [{ templateId: 12 }, { requestHash: 'corrupt' }]) {
    const f = await fixture()
    await f.createSession({ userId: 7, command })
    Object.assign(f.state.sessions[0], change)
    const before = structuredClone(f.state)
    f.calls.length = 0

    await assert.rejects(
      f.createSession({ userId: 7, command }),
      expectError({ code: 'IDEMPOTENCY_CONFLICT', status: 409 }),
    )
    assert.deepEqual(f.state, before)
    assert.deepEqual(
      f.calls.map(([name]) => name),
      ['account', 'lookup'],
    )
  }
})

test('should preserve a soft-deleted key and reject replay without restoring or recreating', async () => {
  const f = await fixture()
  await f.createSession({ userId: 7, command })
  f.state.sessions[0].isDeleted = true
  const before = structuredClone(f.state)
  f.calls.length = 0

  await assert.rejects(
    f.createSession({ userId: 7, command }),
    expectError({ code: 'SESSION_UNAVAILABLE', status: 409 }),
  )
  assert.deepEqual(f.state, before)
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ['account', 'lookup'],
  )
})

test('should reject multiple matching rows including deleted rows instead of choosing one', async () => {
  const f = await fixture()
  await f.createSession({ userId: 7, command })
  f.state.sessions.push({ ...f.state.sessions[0], id: 102, isDeleted: true })
  const before = structuredClone(f.state)

  await assert.rejects(
    f.createSession({ userId: 7, command }),
    expectError({ code: 'DATA_INTEGRITY_CONFLICT', status: 503 }),
  )
  assert.deepEqual(f.state, before)
})

test('should verify account validity before even looking up an existing key', async () => {
  const f = await fixture()
  await f.createSession({ userId: 7, command })
  f.state.isAccountActive = false
  f.calls.length = 0
  const before = structuredClone(f.state)

  await assert.rejects(
    f.createSession({ userId: 7, command }),
    expectError({ code: 'UNAUTHENTICATED', status: 401 }),
  )
  assert.deepEqual(f.calls, [['account', 7]])
  assert.deepEqual(f.state, before)
})

test('should reject invalid trusted user IDs before entering the transaction port', async () => {
  const f = await fixture()

  for (const userId of [
    undefined,
    null,
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '7',
  ]) {
    await assert.rejects(
      f.createSession({ userId, command }),
      expectError({ code: 'UNAUTHENTICATED', status: 401 }),
    )
  }
  assert.deepEqual(f.resources, [])
  assert.deepEqual(f.calls, [])
})

test('should reject malformed commands before entering the transaction port', async () => {
  const f = await fixture()

  await assert.rejects(
    f.createSession({ userId: 7, command: { ...command, createdBy: 'admin:1' } }),
    expectError({ code: 'INPUT_INVALID', status: 400 }),
  )
  assert.deepEqual(f.resources, [])
  assert.deepEqual(f.calls, [])
})

test('should isolate the same request key by account and derive every actor from the trusted user', async () => {
  const f = await fixture()
  const first = await f.createSession({ userId: 7, command })
  const second = await f.createSession({ userId: 8, command })

  assert.equal(second.isNew, true)
  assert.notEqual(first.session.id, second.session.id)
  assert.equal(second.session.userId, 8)
  assert.equal(second.session.createdBy, 'user:8')
  assert.equal(second.session.updatedBy, 'user:8')
  assert.equal(f.state.drafts[1].createdBy, 'user:8')
  assert.equal(f.state.drafts[1].updatedBy, 'user:8')
  assert.equal(f.state.drafts[1].sessionId, second.session.id)
  assert.equal(f.state.drafts[1].userId, 8)
})

test('should coordinate on stable account-and-key digests without embedding raw arbitrary keys', async () => {
  const f = await fixture()
  await f.createSession({ userId: 7, command })
  await f.createSession({ userId: 7, command })
  await f.createSession({ userId: 8, command })
  await f.createSession({ userId: 7, command: { ...command, clientRequestId: 'other' } })

  assert.equal(f.resources[0], f.resources[1])
  assert.notEqual(f.resources[0], f.resources[2])
  assert.notEqual(f.resources[0], f.resources[3])
  assert.match(f.resources[0], /^creation-session:[a-f0-9]{64}$/)
  assert.equal(f.resources[0].includes(command.clientRequestId), false)
})

test('should reject missing, deleted, offline, foreign, unsupported or invalid current templates without writes', async () => {
  const changes = [
    (s) => {
      s.template = null
    },
    (s) => {
      s.template.isDeleted = true
    },
    (s) => {
      s.template.status = 'offline'
    },
    (s) => {
      s.template.status = 'draft'
    },
    (s) => {
      s.template.id = 12
    },
    (s) => {
      s.template.kind = 'unknown'
    },
    (s) => {
      s.template.schemaVersion = 2
    },
    (s) => {
      s.template.displayConfigJson = '{'
    },
  ]

  for (const change of changes) {
    const f = await fixture()
    change(f.state)
    await assert.rejects(
      f.createSession({ userId: 7, command }),
      expectError({ code: 'TEMPLATE_UNAVAILABLE', status: 409 }),
    )
    assert.deepEqual(f.state.sessions, [])
    assert.deepEqual(f.state.drafts, [])
    assert.equal(
      f.calls.some(([name]) => name.startsWith('insert')),
      false,
    )
  }
})

test('should delegate schema/capability compatibility to a synchronous host policy and reject unsupported versions', async () => {
  const inputs = []
  const f = await fixture({
    isCompatible: (value) => {
      inputs.push(value)
      return false
    },
  })

  await assert.rejects(
    f.createSession({ userId: 7, command }),
    expectError({ code: 'TEMPLATE_UNAVAILABLE', status: 409 }),
  )
  assert.deepEqual(inputs, [{ schemaVersion: 1, minClientCapability: 'image-v2' }])
  assert.deepEqual(f.state.sessions, [])
  assert.deepEqual(f.state.drafts, [])
})

for (const failedInsert of ['session', 'draft'])
  test(`should propagate the original ${failedInsert} insert failure with no retry (fake-port rollback only)`, async () => {
    const failure = new Error(`${failedInsert} failed`)
    const f = await fixture({
      [failedInsert === 'session' ? 'sessionError' : 'draftError']: failure,
    })

    await assert.rejects(f.createSession({ userId: 7, command }), (error) => error === failure)
    assert.deepEqual(f.state.sessions, [])
    assert.deepEqual(f.state.drafts, [])
    assert.equal(f.resources.length, 1)
    assert.equal(f.calls.filter(([name]) => name === 'insertSession').length, 1)
    assert.equal(
      f.calls.filter(([name]) => name === 'insertEmptyDraft').length,
      failedInsert === 'draft' ? 1 : 0,
    )
  })

test('should propagate coordination failure unchanged without touching repository or clock', async () => {
  const failure = new Error('coordination unavailable')
  const f = await fixture({ coordinationError: failure })

  await assert.rejects(f.createSession({ userId: 7, command }), (error) => error === failure)
  assert.deepEqual(f.calls, [])
  assert.equal(f.clockCalls(), 0)
  assert.deepEqual(f.state.sessions, [])
  assert.deepEqual(f.state.drafts, [])
})

test('should derive title only from the current public display configuration, trimming its edges', async () => {
  const f = await fixture()
  f.state.template.name = 'Mutable name must not leak'
  f.state.template.displayConfigJson = JSON.stringify({ ...display, name: '  Published name  ' })
  const result = await f.createSession({ userId: 7, command })
  assert.equal(result.session.title, 'Published name')
})

test('should reject invalid public configuration before either insert', async () => {
  const invalidConfigurations = [
    { displayConfigJson: '{' },
    { displayConfigJson: null },
    { inputSchemaJson: null },
    { inputSchemaJson: '{}' },
    { schemaVersion: 2 },
    ...['', 'x'.repeat(101), 'bad\nname', 'bad\u2028name', 'bad\u2029name'].map((name) => ({
      displayConfigJson: JSON.stringify({ ...display, name }),
    })),
  ]
  for (const change of invalidConfigurations) {
    const f = await fixture()
    Object.assign(f.state.template, change)
    await assert.rejects(
      f.createSession({ userId: 7, command }),
      expectError({ code: 'TEMPLATE_UNAVAILABLE', status: 409 }),
    )
    assert.equal(
      f.calls.some(([name]) => name.startsWith('insert')),
      false,
    )
  }
})

test('should snapshot host caps before caller mutation and reject an empty MIME intersection', async () => {
  const caps = { ...hostCaps, allowedMimeTypes: ['image/webp'] }
  const f = await fixture({ caps })
  caps.allowedMimeTypes.push('image/jpeg')
  await assert.rejects(
    f.createSession({ userId: 7, command }),
    expectError({ code: 'TEMPLATE_UNAVAILABLE', status: 409 }),
  )
  assert.equal(
    f.calls.some(([name]) => name.startsWith('insert')),
    false,
  )
})

test('should reject invalid host caps at creator initialization', async () => {
  await assert.rejects(fixture({ caps: { ...hostCaps, maxImages: -1 } }))
})
