import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTemplateTaxonomy } from '../src/creation/application/template-taxonomy.ts'

const NOW = '2026-11-15T12:00:00.000Z'
const term = (id = 1, changes = {}) => ({
  id,
  kind: 'category',
  code: `style-${id}`,
  name: ' 名称😀 ',
  status: 'active',
  sortOrder: 0,
  isDeleted: false,
  ...changes,
})
const input = (changes = {}) => ({ kind: 'category', code: 'style', name: ' 名称😀 ', ...changes })
function fixture({
  rows = [],
  admin = { id: 7, role: 'operator', status: 'active' },
  overrides = {},
  failure,
} = {}) {
  const state = { rows: structuredClone(rows), audits: [] }
  const calls = []
  const repository = {
    readAdmin: async (args) => {
      calls.push(['admin', args])
      return admin
    },
    listTerms: async (args) => {
      calls.push(['list', args])
      return structuredClone(state.rows)
    },
    readTerm: async ({ termId }) => {
      calls.push(['term', termId])
      return structuredClone(state.rows.find((row) => row.id === termId) ?? null)
    },
    findTermsByKey: async (args) => {
      calls.push(['key', args])
      return structuredClone(
        state.rows.filter((row) => row.kind === args.kind && row.code === args.code),
      )
    },
    insertTerm: async ({ data, actor, now }) => {
      calls.push(['insert', { data, actor, now }])
      const row = {
        ...data,
        id: Math.max(0, ...state.rows.map((row) => row.id)) + 1,
        isDeleted: false,
        createdAt: now,
        createdBy: actor,
        updatedAt: now,
        updatedBy: actor,
      }
      state.rows.push(row)
      return structuredClone(row)
    },
    updateTerm: async ({ before, data, actor, now }) => {
      calls.push(['update', { before, data, actor, now }])
      const row = state.rows.find((row) => row.id === before.id)
      Object.assign(row, data, { updatedAt: now, updatedBy: actor })
      return structuredClone(row)
    },
    appendAudit: async (args) => {
      calls.push(['audit', args])
      if (failure === 'audit') throw new Error('audit failure')
      state.audits.push(structuredClone(args))
    },
    ...overrides,
  }
  const service = createTemplateTaxonomy({
    clock: () => NOW,
    read: async ({ work }) => {
      calls.push(['snapshot'])
      return work({ repository })
    },
    write: async ({ resource, work }) => {
      calls.push(['uow', resource])
      const before = structuredClone(state)
      try {
        const result = await work({ repository })
        if (failure === 'unknown') throw new Error('commit unknown')
        return result
      } catch (error) {
        if (failure !== 'unknown') Object.assign(state, before)
        throw error
      }
    },
  })
  return { service, state, calls }
}
const rejects = (work, code) => assert.rejects(work, (error) => error.code === code)
const args = (operation) => ({
  adminId: 7,
  input:
    operation === 'createTerm'
      ? input()
      : operation === 'updateTerm'
        ? { id: 1, name: '新名' }
        : {},
})
for (const operation of ['listTerms', 'createTerm', 'updateTerm']) {
  for (const admin of [
    null,
    { id: 7, role: 'viewer', status: 'active' },
    { id: 7, role: 'unknown', status: 'active' },
    { id: 7, role: 'admin', status: 'disabled' },
    { id: 8, role: 'admin', status: 'active' },
  ]) {
    test(`should authenticate ${operation} before term reads/writes for ${JSON.stringify(admin)}`, async () => {
      const f = fixture({ rows: [term()], admin })
      await rejects(() => f.service[operation](args(operation)), 'UNAUTHENTICATED')
      assert.deepEqual(
        f.calls.map(([name]) => name),
        [operation === 'listTerms' ? 'snapshot' : 'uow', 'admin'],
      )
      assert.equal(f.state.audits.length, 0)
    })
  }
}
for (const role of ['admin', 'operator']) {
  test(`should create active ${role} terms with stable key and trusted actor, preserving literal name`, async () => {
    const f = fixture({ admin: { id: 7, role, status: 'active' } })
    const dto = await f.service.createTerm({
      adminId: 7,
      input: input({ sortOrder: -Number.MAX_SAFE_INTEGER }),
    })
    assert.deepEqual(dto, {
      id: 1,
      ...input({ sortOrder: -Number.MAX_SAFE_INTEGER }),
      status: 'active',
    })
    assert.equal(f.state.rows[0].isDeleted, false)
    assert.deepEqual(
      f.calls.map(([name]) => name),
      ['uow', 'admin', 'key', 'insert', 'audit'],
    )
    assert.equal(f.calls[0][1], 'taxonomy:category:style')
    assert.equal(f.state.rows[0].createdBy, 'admin:7')
    assert.equal(f.state.audits[0].adminId, 7)
    assert.deepEqual(f.state.audits[0].after, dto)
    assert.equal(f.state.audits[0].before, null)
  })
}
test('should allow the same code in different kinds but reserve tombstone keys', async () => {
  const f = fixture({ rows: [term(1, { code: 'style', isDeleted: true })] })
  await rejects(() => f.service.createTerm({ adminId: 7, input: input() }), 'PUBLICATION_CONFLICT')
  const label = await f.service.createTerm({ adminId: 7, input: input({ kind: 'label' }) })
  assert.equal(label.kind, 'label')
  assert.equal(f.state.audits.length, 1)
})
test('should reject duplicate logical candidates with 503 rather than choose one', async () => {
  const f = fixture({
    rows: [term(1, { code: 'style' }), term(2, { code: 'style', isDeleted: true })],
  })
  await rejects(
    () => f.service.createTerm({ adminId: 7, input: input() }),
    'DATA_INTEGRITY_CONFLICT',
  )
  await rejects(
    () => f.service.updateTerm({ adminId: 7, input: { id: 1, name: 'new' } }),
    'DATA_INTEGRITY_CONFLICT',
  )
  assert.equal(f.state.audits.length, 0)
})
test('should update only mutable fields under an ID lock and preserve creation and deletion metadata', async () => {
  const row = term(1, {
    createdBy: 'admin:2',
    createdAt: 'earlier',
    deletedAt: null,
    deletedBy: null,
  })
  const f = fixture({ rows: [row] })
  const updated = await f.service.updateTerm({
    adminId: 7,
    input: { id: 1, name: '新名😀', status: 'hidden', sortOrder: Number.MAX_SAFE_INTEGER },
  })
  assert.deepEqual(updated, {
    id: 1,
    kind: row.kind,
    code: row.code,
    name: '新名😀',
    status: 'hidden',
    sortOrder: Number.MAX_SAFE_INTEGER,
  })
  assert.equal(f.calls[0][1], 'taxonomy-term:1')
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ['uow', 'admin', 'term', 'key', 'update', 'audit'],
  )
  assert.equal(f.state.rows[0].createdBy, 'admin:2')
  assert.equal(f.state.rows[0].deletedAt, null)
  assert.equal(f.state.audits[0].before.name, row.name)
  assert.deepEqual(f.state.audits[0].after, updated)
})
test('should treat all-identical updates as no-op with zero audit or timestamp write', async () => {
  const row = term(1, { updatedAt: 'original', updatedBy: 'admin:2' })
  const f = fixture({ rows: [row] })
  await f.service.updateTerm({
    adminId: 7,
    input: { id: 1, name: row.name, status: row.status, sortOrder: row.sortOrder },
  })
  assert.deepEqual(f.state.rows, [row])
  assert.equal(f.state.audits.length, 0)
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ['uow', 'admin', 'term', 'key'],
  )
})
for (const rows of [[], [term(1, { isDeleted: true })]]) {
  test(`should return 404 for missing/deleted update target ${rows.length}`, async () => {
    const f = fixture({ rows })
    await rejects(
      () => f.service.updateTerm({ adminId: 7, input: { id: 1, status: 'hidden' } }),
      'NOT_FOUND',
    )
    assert.equal(
      f.calls.some(([name]) => name === 'key'),
      false,
    )
  })
}
for (const operation of ['createTerm', 'updateTerm']) {
  test(`should rollback ${operation} when audit fails`, async () => {
    const f = fixture({ rows: [term()], failure: 'audit' })
    const before = structuredClone(f.state)
    await assert.rejects(() => f.service[operation](args(operation)), /audit failure/)
    assert.deepEqual(f.state, before)
    assert.equal(f.calls.filter(([name]) => name === 'uow').length, 1)
  })
  test(`should preserve unknown ${operation} outcome without replay or compensating delete`, async () => {
    const f = fixture({ rows: [term()], failure: 'unknown' })
    await assert.rejects(() => f.service[operation](args(operation)), /commit unknown/)
    assert.equal(f.calls.filter(([name]) => name === 'uow').length, 1)
    assert.equal(f.state.audits.length, 1)
  })
}
test('should propagate arbitrary database errors without turning them into key conflicts', async () => {
  const failure = new Error('primary key failure')
  const f = fixture({
    overrides: {
      insertTerm: async () => {
        throw failure
      },
    },
  })
  await assert.rejects(
    () => f.service.createTerm({ adminId: 7, input: input() }),
    (error) => error === failure,
  )
  assert.equal(f.calls.filter(([name]) => name === 'uow').length, 1)
})
test('should return bounded immutable projected pages and validate the probe row', async () => {
  const rows = Array.from({ length: 21 }, (_, i) =>
    term(i + 2, { secret: 'PRIVATE', name: 'Filtered' }),
  )
  const f = fixture({ rows })
  const dto = await f.service.listTerms({
    adminId: 7,
    input: { afterId: 1, kind: 'category', status: 'active', keyword: 'Filtered' },
  })
  assert.equal(dto.items.length, 20)
  assert.equal(dto.nextAfterId, 21)
  assert.equal(JSON.stringify(dto).includes('PRIVATE'), false)
  assert.ok(Object.isFrozen(dto))
  assert.ok(Object.isFrozen(dto.items))
  assert.ok(Object.isFrozen(dto.items[0]))
  assert.deepEqual(f.calls[2], [
    'list',
    { afterId: 1, kind: 'category', status: 'active', keyword: 'Filtered', limit: 21 },
  ])
  assert.deepEqual(await fixture().service.listTerms({ adminId: 7, input: {} }), {
    items: [],
    nextAfterId: null,
  })
})
for (const changes of [
  { id: 1 },
  { id: 21 },
  { isDeleted: true },
  { kind: 'label' },
  { kind: 'tag' },
  { status: 'hidden' },
  { status: 'unknown' },
  { sortOrder: 1.5 },
  { code: 'UPPER' },
]) {
  test(`should reject inconsistent twenty-first list probe ${JSON.stringify(changes)}`, async () => {
    const rows = Array.from({ length: 21 }, (_, i) => term(i + 2, { name: 'Filtered' }))
    Object.assign(rows[20], changes)
    const f = fixture({ rows })
    await rejects(
      () =>
        f.service.listTerms({
          adminId: 7,
          input: { afterId: 1, kind: 'category', status: 'active', keyword: 'Filtered' },
        }),
      'DATA_INTEGRITY_CONFLICT',
    )
  })
}
test('should reject oversized repository pages and inconsistent logical-key responses', async () => {
  const f = fixture({ rows: Array.from({ length: 22 }, (_, i) => term(i + 1)) })
  await rejects(() => f.service.listTerms({ adminId: 7, input: {} }), 'DATA_INTEGRITY_CONFLICT')
  for (const rows of [[term(2)], []]) {
    const f = fixture({ rows: [term()], overrides: { findTermsByKey: async () => rows } })
    await rejects(
      () => f.service.updateTerm({ adminId: 7, input: { id: 1, status: 'hidden' } }),
      'DATA_INTEGRITY_CONFLICT',
    )
  }
})
const oddObjects = [
  null,
  [],
  new Date(),
  Object.create({ inherited: 1 }),
  { [Symbol('x')]: 1 },
  Object.defineProperty({}, 'x', {
    get() {
      throw new Error('getter executed')
    },
    enumerable: true,
  }),
  Object.defineProperty({}, 'name', { value: 'hidden', enumerable: false }),
]
for (const operation of ['listTerms', 'createTerm', 'updateTerm']) {
  for (const [index, value] of oddObjects.entries()) {
    test(`should reject malformed closed ${operation} input ${index} before opening a unit of work`, async () => {
      const f = fixture()
      await rejects(() => f.service[operation]({ adminId: 7, input: value }), 'INPUT_INVALID')
      assert.deepEqual(f.calls, [])
    })
  }
}
const createInvalid = [
  { kind: 'tag' },
  { kind: undefined },
  { code: '' },
  { code: 'A' },
  { code: 'a'.repeat(65) },
  { code: 'a.b' },
  { name: '' },
  { name: ' \t ' },
  { name: 'a'.repeat(81) },
  { name: 'a\u0000' },
  { name: 'a\u0085' },
  { name: 'a\u2028' },
  { name: 'a\u2029' },
  { name: '\ud800' },
  ...[undefined, null, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map((sortOrder) => ({
    sortOrder,
  })),
  ...[
    'id',
    'createdAt',
    'createdBy',
    'updatedBy',
    'isDeleted',
    'deletedAt',
    'owner',
    'visibility',
    'status',
  ].map((field) => ({ [field]: 'injected' })),
]
for (const [index, changes] of createInvalid.entries()) {
  test(`should reject create field injection/boundary ${index} before side effects`, async () => {
    const f = fixture()
    await rejects(
      () => f.service.createTerm({ adminId: 7, input: input(changes) }),
      'INPUT_INVALID',
    )
    assert.deepEqual(f.calls, [])
  })
}
const updateInvalid = [
  { id: 1 },
  { id: 0, name: 'new' },
  { id: '1', name: 'new' },
  ...['id2', 'kind', 'code', 'createdBy', 'updatedAt', 'isDeleted', 'deletedBy'].map((key) => ({
    id: 1,
    name: 'new',
    [key]: 'injected',
  })),
  { id: 1, name: undefined },
  { id: 1, status: undefined },
  { id: 1, sortOrder: undefined },
  { id: 1, status: 'deleted' },
  { id: 1, name: ' ' },
  { id: 1, sortOrder: 1.5 },
]
for (const [index, value] of updateInvalid.entries()) {
  test(`should reject update field injection/boundary ${index}`, async () => {
    const f = fixture()
    await rejects(() => f.service.updateTerm({ adminId: 7, input: value }), 'INPUT_INVALID')
    assert.deepEqual(f.calls, [])
  })
}
for (const value of [
  { afterId: 0 },
  { afterId: undefined },
  { afterId: 1.2 },
  { afterId: Number.MAX_SAFE_INTEGER + 1 },
  { kind: 'tag' },
  { kind: undefined },
  { status: 'deleted' },
  { status: undefined },
  { keyword: null },
  { keyword: undefined },
  { keyword: 1 },
  { keyword: '😀'.repeat(81) },
  { limit: 100 },
  { where: {} },
]) {
  test(`should reject invalid list boundary ${JSON.stringify(value)}`, async () => {
    const f = fixture()
    await rejects(() => f.service.listTerms({ adminId: 7, input: value }), 'INPUT_INVALID')
    assert.deepEqual(f.calls, [])
  })
}
test('should accept null list filters, eighty keyword codepoints, and exact UTF16 name boundary', async () => {
  const f = fixture()
  await f.service.listTerms({
    adminId: 7,
    input: { afterId: null, kind: null, status: null, keyword: '😀'.repeat(80) },
  })
  const created = await f.service.createTerm({
    adminId: 7,
    input: input({ name: '😀'.repeat(40) }),
  })
  assert.equal(created.name, '😀'.repeat(40))
})
for (const adminId of [null, 0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1]) {
  test(`should reject invalid admin ID ${adminId} before IO`, async () => {
    const f = fixture()
    for (const operation of ['listTerms', 'createTerm', 'updateTerm'])
      await rejects(() => f.service[operation]({ ...args(operation), adminId }), 'INPUT_INVALID')
    assert.deepEqual(f.calls, [])
  })
}

for (const keyword of ['%', '_', 'A_%字']) {
  test(`should pass Native contains keyword literally to the repository without reinterpreting SQL matching: ${keyword}`, async () => {
    const f = fixture({ rows: [term()] })
    const result = await f.service.listTerms({ adminId: 7, input: { keyword } })
    assert.equal(result.items.length, 1)
    assert.equal(f.calls[2][1].keyword, keyword)
    assert.equal(f.calls[2][1].limit, 21)
  })
}
