import assert from 'node:assert/strict'
import test from 'node:test'
import { createOwnerLibrary } from '../src/creation/application/owner-library.ts'
import { createHmac } from 'node:crypto'
import {
  createLibraryCursor,
  libraryTime,
  normalizeLibraryQuery,
  validateFavoriteDocument,
} from '../src/creation/domain/library.ts'

const key = new Uint8Array(32).fill(7)
const scope = { userId: 1, saved: false, pageSize: 20 }
const after = { time: '2026-11-12T00:00:00.000Z', id: 9 }

test('normalizes only URL true and false without changing the caller', () => {
  const query = Object.assign(Object.create(null), { saved: 'true' })
  assert.deepEqual(normalizeLibraryQuery({ value: query }), { saved: true, cursor: undefined })
  assert.equal(Object.isFrozen(query), false)
  assert.deepEqual(
    normalizeLibraryQuery({ value: { saved: 'false' } }),
    normalizeLibraryQuery({ value: {} }),
  )
})
test('rejects extra, hidden, symbol and accessor input before touching a getter', () => {
  let calls = 0
  const accessor = Object.defineProperty({}, 'saved', {
    enumerable: true,
    get() {
      calls++
      return 'true'
    },
  })
  for (const value of [
    accessor,
    { owner: 1 },
    { saved: true },
    { saved: 1 },
    { saved: {} },
    { saved: 'TRUE' },
    { [Symbol()]: 1 },
    Object.defineProperty({}, 'saved', { value: 'true' }),
    [],
  ]) {
    assert.throws(() => normalizeLibraryQuery({ value }), { code: 'INPUT_INVALID', status: 400 })
  }
  assert.equal(calls, 0)
})
test('validates real canonical four digit UTC calendar keys', () => {
  for (const value of [
    '0000-01-01T00:00:00.000Z',
    '9999-12-31T23:59:59.999Z',
    '2024-02-29T00:00:00.000Z',
  ])
    assert.equal(libraryTime({ value }), value)
  for (const value of [
    '2026-02-29T00:00:00.000Z',
    '+010000-01-01T00:00:00.000Z',
    '2026-01-01',
    '2026-01-01T24:00:00.000Z',
  ])
    assert.throws(() => libraryTime({ value }))
})
test('authenticates scoped canonical cursors and owns a copy of the signing key', () => {
  const supplied = key.slice()
  const codec = createLibraryCursor({ cursorKey: supplied })
  const token = codec.encode({ ...scope, after })
  supplied.fill(0)
  assert.deepEqual(codec.decode({ ...scope, token }), after)
  for (const changes of [{ userId: 2 }, { saved: true }, { pageSize: 10 }])
    assert.throws(() => codec.decode({ ...scope, ...changes, token }), { code: 'INPUT_INVALID' })
  assert.throws(() => codec.decode({ ...scope, token: token.slice(0, -2) + 'AA' }), {
    code: 'INPUT_INVALID',
  })
  assert.throws(() => codec.decode({ ...scope, token: 'a'.repeat(4097) }), {
    code: 'INPUT_INVALID',
  })
})
test('rejects weak cursor configuration', () => {
  for (const cursorKey of [new Uint8Array(31), [], 'key', undefined])
    assert.throws(() => createLibraryCursor({ cursorKey }))
})

test('rejects signed duplicate JSON keys and unknown fields rather than accepting parsed last values', () => {
  const codec = createLibraryCursor({ cursorKey: key })
  const valid = codec.encode({ ...scope, after }).split('.')[0]
  const canonical = Buffer.from(valid, 'base64url').toString()
  for (const json of [
    canonical.replace('"v":1', '"v":1,"v":1'),
    canonical.replace('"v":1', '"v":1,"extra":1'),
    canonical.replace('"id":9', '"id":9.0'),
  ]) {
    const body = Buffer.from(json).toString('base64url')
    const token = body + '.' + createHmac('sha256', key).update(body).digest('base64url')
    assert.throws(() => codec.decode({ ...scope, token }), { code: 'INPUT_INVALID' })
  }
})
test('favorite identities and active savedAt are immutable while restoration may update savedAt', () => {
  const originalDoc = { userId: 1, artifactId: 2, savedAt: after.time, isDeleted: false }
  for (const data of [{ userId: 3 }, { artifactId: 3 }, { savedAt: '2026-11-13T00:00:00.000Z' }])
    assert.throws(() => validateFavoriteDocument({ originalDoc, data }))
  assert.doesNotThrow(() =>
    validateFavoriteDocument({
      originalDoc: { ...originalDoc, isDeleted: true },
      data: { isDeleted: false, savedAt: '2026-11-13T00:00:00.000Z' },
    }),
  )
})

test('rejects invalid bounded host limits before any read', () => {
  let calls = 0
  const read = async () => {
    calls++
    throw new Error('Unexpected IO')
  }
  for (const config of [
    { pageSize: 0 },
    { pageSize: 51 },
    { pageSize: 1.5 },
    { batchSize: 0 },
    { batchSize: 129 },
    { scanBudget: 0 },
    { scanBudget: 10001 },
  ])
    assert.throws(() => createOwnerLibrary({ cursorKey: key, read, ...config }))
  assert.equal(calls, 0)
})
test('rejects correctly signed malformed dates unsafe IDs endpoints and scope JSON', () => {
  const codec = createLibraryCursor({ cursorKey: key })
  const json = Buffer.from(codec.encode({ ...scope, after }).split('.')[0], 'base64url').toString()
  for (const changed of [
    json.replace('"id":9', '"id":9007199254740992'),
    json.replace('"id":9', '"id":0'),
    json.replace('2026-11-12', '2026-02-29'),
    json.replace('"artifacts"', '"sessions"'),
    json.replace('"v":1', '"v":2'),
    '{',
  ]) {
    const body = Buffer.from(changed).toString('base64url')
    const token = body + '.' + createHmac('sha256', key).update(body).digest('base64url')
    assert.throws(() => codec.decode({ ...scope, token }), { code: 'INPUT_INVALID' })
  }
})

const transportError = new Error('Fixture database transport failure')
for (const error of [
  transportError,
  new AggregateError(
    [transportError, new Error('Fixture rollback failure')],
    'Fixture snapshot failure',
  ),
]) {
  test(`preserves original ${error.name} from read for both library operations`, async () => {
    const library = createOwnerLibrary({
      cursorKey: key,
      read: async () => {
        throw error
      },
    })
    for (const operation of [
      () => library.list({ userId: 1, query: {} }),
      () => library.get({ userId: 1, artifactId: 1 }),
    ])
      await assert.rejects(operation, (actual) => actual === error)
  })
}

test('classifies invalid calendar and extended-year projection times locally as integrity errors', async () => {
  for (const createdAt of ['2026-02-29T00:00:00.000Z', '+010000-01-01T00:00:00.000Z']) {
    const library = createOwnerLibrary({
      cursorKey: key,
      read: ({ work }) =>
        work({
          reader: {
            actor: async () => [{ id: 1, status: 'active', isDeleted: false }],
            scan: async () => [{ id: 1, userId: 1, isDeleted: false, createdAt }],
          },
        }),
    })
    await assert.rejects(() => library.list({ userId: 1, query: {} }), {
      code: 'DATA_INTEGRITY_CONFLICT',
      status: 503,
    })
  }
})
