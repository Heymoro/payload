import assert from 'node:assert/strict'
import test from 'node:test'
import { createCurrentTemplates } from '../src/creation/application/current-template.ts'

const now = '2026-11-17T12:00:00.000Z'
const caps = {
  allowedMimeTypes: ['image/png'],
  minImages: 0,
  maxImages: 4,
  maxImageBytes: 1000,
  maxTotalImageBytes: 4000,
  maxDescriptionLength: 200,
  maxNotesLength: 100,
}
const execution = {
  registry: {
    image: {
      provider: 'fixture',
      model: 'image',
      apiKey: 'SECRET_API',
      allowedParameters: ['size', 'count', 'enabled'],
      parameterRules: {
        size: { type: 'string', values: ['small', 'large'], isRequired: true },
        count: { type: 'number', minimum: 0, maximum: 4, isInteger: true },
        enabled: { type: 'boolean' },
      },
      storageBackends: ['SECRET_STORAGE'],
    },
  },
  storageOutput: {
    backend: 'SECRET_STORAGE',
    bucket: 'SECRET_BUCKET',
    keyRule: 'task-attempt-result-v1',
  },
}
const body = () => ({
  costCredits: 3,
  schemaVersion: 1,
  minClientCapability: 'v1',
  displayConfigJson: JSON.stringify({ name: 'Free' }),
  inputSchemaJson: JSON.stringify({ ...caps, maxNotesLength: 0 }),
  generationConfigJson: JSON.stringify({
    executorId: 'image',
    systemPrompt: ' PRIVATE  \n prompt ',
    parameters: { size: 'small', count: 0, enabled: false },
  }),
  shareConfigJson: '{}',
})

// In-memory semantic ports with rollback, not a SQLite/Redis or browser claim.
function fixture({ ...options } = {}) {
  const state = {
    rows: [],
    audits: [],
    failAudit: false,
    admin: { id: 1, role: 'operator', status: 'active' },
  }
  const calls = []
  const settings = {
    acceptedCapabilities: ['v1', 'v2'],
    execution: structuredClone(execution),
    hostCaps: structuredClone(caps),
    maxExampleMedia: 20,
    ...options,
  }
  const repository = {
    readAdmin: async () => {
      calls.push('admin')
      return state.admin
    },
    readTemplate: async ({ templateId }) => {
      calls.push('template')
      return state.rows.find((row) => row.id === templateId) || null
    },
    findByCode: async ({ code }) => {
      calls.push('code')
      return state.rows.filter((row) => row.code === code)
    },
    list: async (query) => {
      calls.push(query)
      return state.rows
    },
    readTerm: async () => assert.fail('free fixture does not reference taxonomy'),
    readMedia: async () => assert.fail('free fixture does not reference media'),
    insert: async ({ body, code, kind, name }) => {
      const row = {
        id: state.rows.length + 1,
        ...body,
        code,
        kind,
        name,
        status: 'offline',
        isDeleted: false,
      }
      state.rows.push(row)
      return row
    },
    update: async ({ before, body, name, status }) => {
      const row = {
        ...before,
        ...body,
        ...(name === undefined ? {} : { name }),
        ...(status === undefined ? {} : { status }),
      }
      state.rows[state.rows.findIndex((item) => item.id === row.id)] = row
      return row
    },
    appendAudit: async (entry) => {
      if (state.failAudit) throw Error('fixture audit failure')
      state.audits.push(structuredClone(entry))
    },
  }
  const service = createCurrentTemplates({
    ...settings,
    clock: () => now,
    read: ({ work }) => work({ repository }),
    write: async ({ resource, work }) => {
      calls.push(resource)
      const before = structuredClone(state)
      try {
        return await work({ repository })
      } catch (error) {
        Object.assign(state, before)
        throw error
      }
    },
  })
  return { service, state, calls, settings }
}
const create = ({ service }) =>
  service.create({ adminId: 1, code: 'free', kind: 'free', configuration: body() })

test('options expose copied immutable host rules without credentials or storage configuration', async () => {
  const f = fixture()
  const dto = await f.service.getOptions({ adminId: 1 })
  assert.deepEqual(Object.keys(dto).sort(), [
    'acceptedCapabilities',
    'executors',
    'hostCaps',
    'schemaVersion',
  ])
  assert.deepEqual(dto.executors[0].parameterRules, execution.registry.image.parameterRules)
  assert.doesNotMatch(JSON.stringify(dto), /SECRET|apiKey|storage|quoteKey/)
  f.settings.execution.registry.image.parameterRules.size.values.push('changed')
  f.settings.hostCaps.allowedMimeTypes.push('image/jpeg')
  assert.deepEqual(dto.executors[0].parameterRules.size.values, ['small', 'large'])
  assert.deepEqual(dto.hostCaps.allowedMimeTypes, ['image/png'])
  assert.ok(Object.isFrozen(dto.executors[0].parameterRules.size.values))
  assert.deepEqual(f.calls, ['admin'])
})

test('maintenance options and empty list remain readable before a model executor is configured', async () => {
  const f = fixture({ execution: null })
  assert.deepEqual((await f.service.getOptions({ adminId: 1 })).executors, [])
  assert.deepEqual(await f.service.list({ adminId: 1 }), {
    items: [],
    hasMore: false,
    nextAfterId: null,
  })
})

for (const operation of ['create', 'get', 'list', 'getOptions', 'save', 'setStatus']) {
  test(`current ${operation} rechecks administrator before any business query or mutation`, async () => {
    const f = fixture()
    f.state.admin = { id: 1, role: 'operator', status: 'disabled' }
    await assert.rejects(
      f.service[operation]({
        adminId: 1,
        templateId: 1,
        code: 'free',
        kind: 'free',
        configuration: body(),
        status: 'published',
      }),
      { code: 'UNAUTHENTICATED' },
    )
    assert.equal(f.calls.filter((call) => call === 'admin').length, 1)
    assert.equal(
      f.calls.some((call) => call === 'template' || call === 'code' || typeof call === 'object'),
      false,
    )
    assert.deepEqual(f.state.rows, [])
  })
}

test('one current row supports create, publish, immediate save and offline without a version API', async () => {
  const f = fixture()
  const originalBody = body()
  const row = await create(f)
  assert.equal(row.status, 'offline')
  await f.service.setStatus({ adminId: 1, templateId: row.id, status: 'published' })
  const changed = {
    ...originalBody,
    costCredits: 8,
    generationConfigJson: originalBody.generationConfigJson.replace('PRIVATE', 'NEW'),
  }
  const saved = await f.service.save({ adminId: 1, templateId: row.id, configuration: changed })
  assert.equal(saved.id, row.id)
  assert.equal(saved.status, 'published')
  assert.equal(saved.costCredits, 8)
  assert.equal(saved.generationConfigJson, changed.generationConfigJson)
  assert.equal(row.generationConfigJson, originalBody.generationConfigJson)
  await f.service.setStatus({ adminId: 1, templateId: row.id, status: 'offline' })
  assert.equal(f.state.rows.length, 1)
  assert.equal(f.state.audits.length, 4)
  assert.deepEqual(Object.keys(f.service).sort(), [
    'create',
    'get',
    'getOptions',
    'list',
    'save',
    'setStatus',
  ])
  assert.equal(/versionId|versionNo|publishedVersionId/.test(JSON.stringify(f.state.rows)), false)
})

test('same-row save rolls back when its audit fails', async () => {
  const f = fixture()
  await create(f)
  f.state.failAudit = true
  const before = structuredClone(f.state)
  await assert.rejects(
    f.service.save({ adminId: 1, templateId: 1, configuration: { ...body(), costCredits: 9 } }),
    /audit failure/,
  )
  assert.deepEqual(f.state, before)
})

test('list returns twenty plus one pagination without exposing private JSON', async () => {
  const f = fixture()
  f.state.rows = Array.from({ length: 21 }, (_, n) => ({
    ...body(),
    id: n + 1,
    code: `style-${n}`,
    kind: 'effect',
    name: `Style ${n}`,
    status: 'published',
    isDeleted: false,
  }))
  const result = await f.service.list({
    adminId: 1,
    input: { keyword: '猫', afterId: 3, status: 'published' },
  })
  assert.equal(result.items.length, 20)
  assert.equal(result.hasMore, true)
  assert.equal(result.nextAfterId, 20)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|generationConfigJson|inputSchemaJson/)
  assert.deepEqual(f.calls[1], { afterId: 3, keyword: '猫', limit: 21, status: 'published' })
})

test('duplicate logical codes including tombstones are rejected in service rather than reused', async () => {
  const f = fixture()
  await create(f)
  f.state.rows[0] = { ...f.state.rows[0], isDeleted: true }
  await assert.rejects(create(f), { code: 'PUBLICATION_CONFLICT' })
  assert.equal(f.state.rows.length, 1)
  assert.equal(f.state.audits.length, 1)
})

for (const change of [
  { version: 1 },
  { revision: 1 },
  { costCredits: -1 },
  { shareConfigJson: '{"channel":"unregistered"}' },
  { shareConfigJson: '[]' },
  { shareConfigJson: '{broken' },
]) {
  test(`configuration rejects obsolete or invalid fields before IO ${JSON.stringify(change)}`, async () => {
    const f = fixture()
    await assert.rejects(
      f.service.create({
        adminId: 1,
        code: 'free',
        kind: 'free',
        configuration: { ...body(), ...change },
      }),
      { code: 'INPUT_INVALID' },
    )
    assert.deepEqual(f.calls, [])
  })
}
