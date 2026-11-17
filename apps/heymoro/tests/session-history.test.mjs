import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import { createOwnerSessions } from '../src/creation/application/owner-sessions.ts'
import {
  createSessionsCursor,
  normalizeSessionsQuery,
} from '../src/creation/domain/session-history.ts'
import { createLibraryCursor } from '../src/creation/domain/library.ts'

const cursorKey = new Uint8Array(32).fill(7)
const time = '2026-11-12T00:00:00.000Z'
const profile = {
  id: 9,
  userId: 1,
  clientRequestId: 'history-fixture',
  title: '  原名  ',
  titleSource: 'template',
  mode: 'effect',
  templateId: 2,
  lastActivityAt: time,
  nextRoundNo: 2,
  coverArtifactId: null,
  isDeleted: false,
  deletedAt: null,
  deletedBy: null,
}
function fixture(overrides = {}) {
  let calls = 0
  const reader = {
    library: { actor: async () => [{ id: 1, status: 'active', isDeleted: false }] },
    scan: async () => [profile],
    profiles: async () => [profile],
    requestProfiles: async ({ clientRequestId, userId }) =>
      (await reader.profiles({ ids: [profile.id] })).filter(
        (row) => row.userId === userId && row.clientRequestId === clientRequestId,
      ),
    inflight: async () => [],
    draft: {
      isAccountActive: async () => true,
      readSession: async () => profile,
      findDrafts: async () => [
        {
          id: 20,
          userId: 1,
          sessionId: 9,
          isDeleted: false,
          description: '',
          userNotes: '  literal\n ',
          updatedAt: time,
        },
      ],
      findSlots: async () => [
        { id: 21, draftId: 20, userId: 1, position: 1, mediaId: 999, isDeleted: false },
      ],
    },
    ...overrides,
  }
  return {
    service: createOwnerSessions({
      cursorKey,
      read: ({ work }) => {
        calls++
        return work({ reader })
      },
    }),
    calls: () => calls,
    reader,
  }
}
test('lists one immutable session rather than a task and restores literal draft including invalid media IDs', async () => {
  const { service } = fixture()
  const result = await service.list({ userId: 1, query: {} })
  assert.deepEqual(result, {
    items: [
      {
        id: 9,
        title: '  原名  ',
        titleSource: 'template',
        mode: 'effect',
        templateId: 2,
        lastActivityAt: time,
        cover: null,
        runningTask: null,
      },
    ],
    hasMore: false,
    nextCursor: null,
  })
  assert.ok(Object.isFrozen(result.items[0]))
  const detail = await service.get({ userId: 1, sessionId: 9 })
  assert.deepEqual(detail.draft, {
    input: { inputMediaIds: [999], description: '', userNotes: '  literal\n ' },
    updatedAt: time,
  })
})
test('rejects descriptor unsafe input before IO without invoking getters', async () => {
  const f = fixture()
  let calls = 0
  for (const query of [
    null,
    [],
    { saved: 'false' },
    { owner: 1 },
    { cursor: '' },
    { cursor: 1 },
    { cursor: 'x'.repeat(2049) },
    { [Symbol()]: 1 },
    Object.defineProperty({}, 'cursor', { value: 'x' }),
    Object.defineProperty({}, 'cursor', {
      enumerable: true,
      get() {
        calls++
        return 'x'
      },
    }),
  ])
    await assert.rejects(() => f.service.list({ userId: 1, query }), { code: 'INPUT_INVALID' })
  await assert.rejects(() => f.service.get({ userId: 1, sessionId: 0 }), { code: 'INPUT_INVALID' })
  await assert.rejects(() => f.service.get({ userId: 0, sessionId: 1 }), {
    code: 'UNAUTHENTICATED',
  })
  assert.equal(f.calls(), 0)
  assert.equal(calls, 0)
})
test('normalizes into an independent frozen descriptor-safe query', () => {
  const value = Object.assign(Object.create(null), { cursor: 'abc' })
  assert.deepEqual(normalizeSessionsQuery({ value }), { cursor: 'abc' })
  assert.equal(Object.isFrozen(value), false)
})
test('binds session cursors to endpoint user page size and strict canonical JSON using an owned key', () => {
  const supplied = cursorKey.slice()
  const codec = createSessionsCursor({ cursorKey: supplied })
  const scope = { userId: 1, pageSize: 20 }
  const after = { id: 9, time }
  const token = codec.encode({ ...scope, after })
  supplied.fill(0)
  assert.deepEqual(codec.decode({ ...scope, token }), after)
  for (const other of [{ userId: 2 }, { pageSize: 10 }])
    assert.throws(() => codec.decode({ ...scope, ...other, token }), { code: 'INPUT_INVALID' })
  assert.throws(
    () => createLibraryCursor({ cursorKey }).decode({ ...scope, saved: false, token }),
    { code: 'INPUT_INVALID' },
  )
  const json = Buffer.from(token.split('.')[0], 'base64url').toString()
  for (const changed of [
    json.replace('"v":1', '"v":1,"v":1'),
    json.replace('"v":1', '"v":1,"extra":1'),
    json.replace('"id":9', '"id":9.0'),
    json.replace('2026-11-12', '2026-02-29'),
    json.replace('creation-sessions', 'artifacts'),
    json.replace('"id":9', '"id":9007199254740992'),
  ]) {
    const body = Buffer.from(changed).toString('base64url')
    const signed = body + '.' + createHmac('sha256', cursorKey).update(body).digest('base64url')
    assert.throws(() => codec.decode({ ...scope, token: signed }), { code: 'INPUT_INVALID' })
  }
  assert.throws(() => codec.decode({ ...scope, token: token.slice(0, -2) + 'AA' }), {
    code: 'INPUT_INVALID',
  })
})
test('preserves both original Artifact V1 golden wire encodings', () => {
  const codec = createLibraryCursor({ cursorKey })
  const signatures = [
    'Jk-UUk9jReIBVBsctMIZxh0g6IaGtN2OMfqQ773w6Vc',
    'kqVVFDQZClRjkzMN3p7CZz2axbbo_JBJvwBehbMgX-k',
  ]
  for (const [i, saved] of [false, true].entries()) {
    const json = `{"after":{"id":9,"time":"${time}"},"endpoint":"artifacts","order":"${saved ? 'savedAt' : 'createdAt'},id:desc","pageSize":20,"saved":${saved},"userId":1,"v":1}`
    const golden = Buffer.from(json).toString('base64url') + '.' + signatures[i]
    assert.equal(codec.encode({ userId: 1, pageSize: 20, saved, after: { id: 9, time } }), golden)
    assert.deepEqual(codec.decode({ userId: 1, pageSize: 20, saved, token: golden }), {
      id: 9,
      time,
    })
  }
})
for (const status of ['queued', 'running', 'unknown'])
  test(`projects only minimal ${status} inflight evidence`, async () => {
    const { service } = fixture({
      inflight: async () => [
        {
          id: 11,
          userId: 1,
          sessionId: 9,
          templateId: 2,
          roundNo: 1,
          status,
          isDeleted: false,
        },
      ],
    })
    assert.deepEqual((await service.list({ userId: 1, query: {} })).items[0].runningTask, {
      id: 11,
      roundNo: 1,
      status,
    })
  })
for (const change of [
  { userId: 2 },
  { isDeleted: true },
  { templateId: 4 },
  { roundNo: 2 },
  { roundNo: 0 },
  { status: 'succeeded' },
])
  test(`rejects corrupt inflight ${JSON.stringify(change)}`, async () => {
    const { service } = fixture({
      inflight: async () => [
        {
          id: 11,
          userId: 1,
          sessionId: 9,
          templateId: 2,
          roundNo: 1,
          status: 'queued',
          isDeleted: false,
          ...change,
        },
      ],
    })
    await assert.rejects(() => service.list({ userId: 1, query: {} }), { status: 503 })
  })
test('rejects duplicate inflight evidence and session order instead of overwriting maps', async () => {
  const task = {
    id: 11,
    userId: 1,
    sessionId: 9,
    templateId: 2,
    roundNo: 1,
    status: 'queued',
    isDeleted: false,
  }
  await assert.rejects(
    () =>
      fixture({ inflight: async () => [task, { ...task, id: 12 }] }).service.list({
        userId: 1,
        query: {},
      }),
    { status: 503 },
  )
  await assert.rejects(
    () => fixture({ scan: async () => [profile, profile] }).service.list({ userId: 1, query: {} }),
    { status: 503 },
  )
})
for (const change of [
  { lastActivityAt: '2026-02-29T00:00:00.000Z' },
  { lastActivityAt: '+010000-01-01T00:00:00.000Z' },
  { nextRoundNo: 0 },
  { deletedAt: time },
  { mode: 'other' },
])
  test(`rejects malformed stored profile ${JSON.stringify(change)}`, async () => {
    await assert.rejects(
      () =>
        fixture({ scan: async () => [{ ...profile, ...change }] }).service.list({
          userId: 1,
          query: {},
        }),
      { status: 503 },
    )
  })
test('checks the draft session identity against the already read profile', async () => {
  const f = fixture()
  f.reader.draft.readSession = async () => ({ ...profile, templateId: 99 })
  await assert.rejects(() => f.service.get({ userId: 1, sessionId: 9 }), { status: 503 })
})
for (const error of [
  new Error('transport'),
  new AggregateError([new Error('db'), new Error('rollback')]),
])
  test(`preserves original ${error.name} identity`, async () => {
    const service = createOwnerSessions({
      cursorKey,
      read: async () => {
        throw error
      },
    })
    for (const op of [
      () => service.list({ userId: 1, query: {} }),
      () => service.get({ userId: 1, sessionId: 9 }),
    ])
      await assert.rejects(op, (actual) => actual === error)
  })
test('rejects invalid page bounds and cursor keys before read', () => {
  for (const pageSize of [0, 51, 1.1, NaN])
    assert.throws(() =>
      createOwnerSessions({ cursorKey, pageSize, read: async () => assert.fail('IO') }),
    )
  assert.throws(() => createSessionsCursor({ cursorKey: new Uint8Array(31) }))
})

for (const title of ['', '  ', 'x'.repeat(101), 'bad\nname', 'bad\u2028name'])
  test(`rejects invalid persisted title ${JSON.stringify(title)}`, async () => {
    await assert.rejects(
      () =>
        fixture({ scan: async () => [{ ...profile, title }] }).service.list({
          userId: 1,
          query: {},
        }),
      { status: 503 },
    )
  })
test('does not consume or validate an extra prefetched candidate', async () => {
  const f = fixture()
  f.reader.scan = async () => [profile, { id: 'unconsumed' }]
  const service = createOwnerSessions({
    cursorKey,
    pageSize: 1,
    read: ({ work }) => work({ reader: f.reader }),
  })
  const result = await service.list({ userId: 1, query: {} })
  assert.equal(result.items[0].id, 9)
  assert.equal(result.hasMore, true)
  assert.deepEqual(
    createSessionsCursor({ cursorKey }).decode({
      token: result.nextCursor,
      userId: 1,
      pageSize: 1,
    }),
    { id: 9, time },
  )
})
