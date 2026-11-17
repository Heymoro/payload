import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createCreditHistoryCursor,
  normalizeCreditHistoryQuery,
  assertCreditHistoryEntry,
} from '../src/creation/domain/credit-history.ts'
const key = new Uint8Array(32).fill(19)
const time = '2026-11-12T12:00:00.000Z'
const grant = {
  id: 3,
  grantKey: 'key:with:colon',
  sourceType: 'trial',
  issuedCredits: 5,
  validFrom: time,
  expiresAt: '2026-11-13T00:00:00.000Z',
}
const entry = {
  id: 1,
  isDeleted: false,
  createdAt: time,
  operation: 'grant',
  amountCredits: 5,
  availableDelta: 5,
  reservedDelta: 0,
  consumedDelta: 0,
  expiredDelta: 0,
  revokedDelta: 0,
  reservationId: null,
  eventKey: 'grant:key:with:colon:3',
  reasonCode: 'TRIAL_GRANT',
}
for (const purpose of ['credit-reservations', 'credit-ledger']) {
  test(`signed ${purpose} cursor roundtrip and independent scope`, () => {
    const codec = createCreditHistoryCursor({ cursorKey: key, purpose })
    const scope = { userId: 1, pageSize: 20 }
    const after = purpose === 'credit-reservations' ? { id: 8 } : { id: 8, time }
    const token = codec.encode({ ...scope, after })
    assert.deepEqual(codec.decode({ ...scope, token }), after)
    for (const changed of [{ userId: 2 }, { pageSize: 50 }, { token: token.slice(0, -2) + 'AA' }])
      assert.throws(() => codec.decode({ ...scope, token, ...changed }), { code: 'INPUT_INVALID' })
    assert.throws(
      () =>
        createCreditHistoryCursor({
          cursorKey: key,
          purpose: purpose === 'credit-ledger' ? 'credit-reservations' : 'credit-ledger',
        }).decode({ ...scope, token }),
      { code: 'INPUT_INVALID' },
    )
  })
}
for (const query of [
  null,
  [],
  { x: 1 },
  { cursor: '' },
  { cursor: 2 },
  Object.defineProperty({}, 'cursor', {
    get() {
      throw Error('executed getter')
    },
    enumerable: true,
  }),
  Object.defineProperty({}, 'cursor', { value: 'x' }),
  { [Symbol()]: 'x' },
])
  test('query rejects unsupported descriptor/value', () =>
    assert.throws(() => normalizeCreditHistoryQuery({ value: query }), { code: 'INPUT_INVALID' }))
test('query accepts only optional cursor', () => {
  assert.deepEqual(normalizeCreditHistoryQuery({ value: {} }), { cursor: undefined })
  assert.deepEqual(normalizeCreditHistoryQuery({ value: { cursor: 'abc' } }), { cursor: 'abc' })
})
const variants = [
  ['grant', 5, 5, 0, 0, 0, 'TRIAL_GRANT', 'grant:key:with:colon:3'],
  ['compensate', 5, 5, 0, 0, 0, 'COMPENSATION_GRANT', 'grant:key:with:colon:3'],
  ['reserve', 2, -2, 2, 0, 0, 'GENERATION_RESERVED', 'reserve:generation:7:3'],
  ['capture', 2, 0, -2, 2, 0, 'GENERATION_CAPTURED', 'capture:generation:7:3'],
  ['release', 2, 1, -2, 0, 1, 'GENERATION_RELEASED', 'release:generation:7:3'],
  ['expire', 2, -2, 0, 0, 2, 'CREDIT_EXPIRED', 'expire:3:2026-11-13T00:00:00.000Z'],
]
for (const [
  operation,
  amountCredits,
  availableDelta,
  reservedDelta,
  consumedDelta,
  expiredDelta,
  reasonCode,
  eventKey,
] of variants) {
  const isTask = ['reserve', 'capture', 'release'].includes(operation)
  const row = {
    ...entry,
    operation,
    amountCredits,
    availableDelta,
    reservedDelta,
    consumedDelta,
    expiredDelta,
    reasonCode,
    eventKey,
    reservationId: isTask ? 4 : null,
    createdAt: operation === 'expire' ? grant.expiresAt : time,
  }
  const batch = { ...grant, sourceType: operation === 'compensate' ? 'compensation' : 'trial' }
  const args = { entry: row, grant: batch, taskId: isTask ? 7 : null }
  test(`${operation} exact five delta and key/reason contract`, () => {
    assert.equal(assertCreditHistoryEntry(args).ledgerDelta, availableDelta + reservedDelta)
    assert.equal(
      assertCreditHistoryEntry(args).statusCredits,
      ['reserve', 'release'].includes(operation) ? amountCredits : null,
    )
    for (const field of [
      'availableDelta',
      'reservedDelta',
      'consumedDelta',
      'expiredDelta',
      'revokedDelta',
    ])
      assert.throws(
        () => assertCreditHistoryEntry({ ...args, entry: { ...row, [field]: row[field] + 1 } }),
        { code: 'DATA_INTEGRITY_CONFLICT' },
      )
    for (const changed of [
      { amountCredits: 0 },
      { reasonCode: 'fake' },
      { eventKey: 'fake' },
      { isDeleted: true },
      { createdAt: '2026-11-12T11:59:59.999Z' },
    ])
      assert.throws(() => assertCreditHistoryEntry({ ...args, entry: { ...row, ...changed } }), {
        code: 'DATA_INTEGRITY_CONFLICT',
      })
  })
}
test('issuance amount and delta cannot be forged together', () =>
  assert.throws(
    () =>
      assertCreditHistoryEntry({
        entry: { ...entry, amountCredits: 4, availableDelta: 4 },
        grant,
        taskId: null,
      }),
    { code: 'DATA_INTEGRITY_CONFLICT' },
  ))
test('expiry requires finite expiry and amount within issuance', () => {
  const row = {
    ...entry,
    operation: 'expire',
    reasonCode: 'CREDIT_EXPIRED',
    eventKey: `expire:3:${grant.expiresAt}`,
    amountCredits: 6,
    availableDelta: -6,
    expiredDelta: 6,
    createdAt: grant.expiresAt,
  }
  assert.throws(() => assertCreditHistoryEntry({ entry: row, grant, taskId: null }), {
    code: 'DATA_INTEGRITY_CONFLICT',
  })
  assert.throws(
    () =>
      assertCreditHistoryEntry({
        entry: { ...row, amountCredits: 2, availableDelta: -2, expiredDelta: 2 },
        grant: { ...grant, expiresAt: null },
        taskId: null,
      }),
    { code: 'DATA_INTEGRITY_CONFLICT' },
  )
})
test('revoke has no supported writer contract', () =>
  assert.throws(
    () =>
      assertCreditHistoryEntry({ entry: { ...entry, operation: 'revoke' }, grant, taskId: null }),
    { code: 'DATA_INTEGRITY_CONFLICT' },
  ))

import { createOwnerCredits } from '../src/creation/application/owner-credits.ts'
import { projectCreditReservations } from '../src/creation/application/credit-reservations.ts'
import { hashTaskClientInput } from '../src/creation/domain/input.ts'
const deletion = { isDeleted: false, deletedAt: null, deletedBy: null }
function pendingFixture() {
  const input = { description: '', userNotes: '', inputMediaIds: [] }
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
    quote: { costCredits: 0, issuedAt: time, validUntil: '2026-11-12T12:01:00.000Z' },
  }
  const task = {
    ...deletion,
    id: 7,
    userId: 1,
    sessionId: 2,
    templateId: 3,
    sourceTaskId: null,
    roundNo: 1,
    status: 'queued',
    costCredits: 0,
    description: '',
    userNotes: '',
    executionSnapshotJson: JSON.stringify(snapshot),
    requestHash: hashTaskClientInput({ clientInput }),
  }
  const session = {
    ...deletion,
    id: 2,
    userId: 1,
    templateId: 3,
    mode: 'free',
    nextRoundNo: 2,
  }
  const reservation = {
    ...deletion,
    id: 5,
    userId: 1,
    accountId: 6,
    taskId: 7,
    reservationKey: 'generation:7',
    status: 'reserved',
    amountCredits: 0,
    settledAt: null,
    reviewAfter: null,
  }
  const account = { ...deletion, id: 6, userId: 1, availableCredits: 0, reservedCredits: 0 }
  const reader = {
    reservations: async () => [reservation],
    tasks: async () => [task],
    sessions: async () => [session],
    allocations: async () => [],
    grants: async () => [],
    grantKeys: async () => [],
    reservationLedger: async () => [],
  }
  return {
    reservation,
    task,
    session,
    args: { account, now: time, reader, reservations: [reservation], userId: 1 },
  }
}
for (const reviewAfter of [
  '2026-11-12T12:00:00Z',
  '2027-02-30T12:00:00.000Z',
  '2026-11-13T12:00:00+00:00',
  1,
])
  test('projection rejects noncanonical reviewAfter even in future', async () => {
    const f = pendingFixture()
    f.reservation.reviewAfter = reviewAfter
    await assert.rejects(() => projectCreditReservations(f.args), {
      code: 'DATA_INTEGRITY_CONFLICT',
    })
  })
test('zero allocation empty ledger projection preserves exact zero cost DTO', async () => {
  const f = pendingFixture()
  assert.deepEqual(await projectCreditReservations(f.args), [
    {
      reservationId: 5,
      taskId: 7,
      sessionId: 2,
      roundNo: 1,
      reservedCredits: 0,
      taskStatus: 'queued',
      reviewHint: null,
    },
  ])
})
for (const name of ['account', 'reservations', 'ledger'])
  test(`${name} rejects descriptor-unsafe IDs and extra args before IO`, async () => {
    let reads = 0
    const service = createOwnerCredits({
      cursorKey: key,
      clock: () => time,
      readiness: () => true,
      read: async () => {
        reads++
        throw Error('unexpected IO')
      },
    })
    for (const args of [
      { userId: 0, query: {} },
      { userId: 1, query: {}, unexpected: 1 },
      Object.defineProperty({}, 'userId', {
        enumerable: true,
        get() {
          throw Error('getter executed')
        },
      }),
    ])
      await assert.rejects(() => service[name](args), { code: 'INPUT_INVALID' })
    assert.equal(reads, 0)
  })
