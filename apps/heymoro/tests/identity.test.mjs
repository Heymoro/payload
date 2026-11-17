import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCoreConfig } from '../src/creation/runtime/config.ts'
import { hostConfig } from './creation/runtime-seed.ts'

test('host identity policy is mandatory rather than a hidden session/trial default', () => {
  const value = structuredClone(hostConfig({ dataDir: '/tmp/identity-policy-unit' }))
  delete value.identity
  assert.throws(() => parseCoreConfig({ value }), /Invalid core configuration/)
})

import {
  parseLoginCommand,
  parseProfileCommand,
  parseIdentityPolicy,
  parseBearer,
  addIdentitySeconds,
} from '../src/creation/domain/identity.ts'
const policy = () => ({
  sessionTtlSeconds: 3600,
  trial: { issuedCredits: 7, validForSeconds: 86400 },
  wechat: {
    appId: 'fixture-app',
    appSecret: 'fixture-secret',
    timeoutMs: 100,
    maxResponseBytes: 1024,
  },
})
const invalid = { code: 'AUTH_INPUT_INVALID', status: 400 }
for (const input of [
  null,
  [],
  {},
  { code: '' },
  { code: 'a b' },
  { code: 'a\n' },
  { code: 'a'.repeat(513) },
  { code: 'x', openId: 'spoof' },
  { code: 'x', [Symbol('x')]: 1 },
  Object.assign(Object.create({}), { code: 'x' }),
  Object.defineProperty({}, 'code', {
    get() {
      throw Error('getter must not run')
    },
  }),
])
  test('login rejects malformed/expanded command before side effects', () => {
    assert.throws(() => parseLoginCommand({ input }), invalid)
  })
test('login snapshots and freezes the code command', () => {
  const input = { code: 'one-time-code' }
  const parsed = parseLoginCommand({ input })
  input.code = 'mutated'
  assert.deepEqual(parsed, { code: 'one-time-code' })
  assert.ok(Object.isFrozen(parsed))
})
for (const input of [
  {},
  { displayName: '' },
  { displayName: '  ' },
  { displayName: 'x'.repeat(81) },
  { displayName: 'x', avatarUrl: 'https://example.invalid' },
  { displayName: 'x', status: 'disabled' },
  { displayName: 'x', updatedBy: 'admin:1' },
])
  test('profile accepts only a nonempty displayName', () =>
    assert.throws(() => parseProfileCommand({ input }), invalid))
test('profile trims and freezes only the allowed displayName', () =>
  assert.deepEqual(parseProfileCommand({ input: { displayName: '  昵称  ' } }), {
    displayName: '昵称',
  }))
for (const change of [
  (p) => delete p.sessionTtlSeconds,
  (p) => (p.sessionTtlSeconds = 59),
  (p) => (p.sessionTtlSeconds = 2592001),
  (p) => (p.sessionTtlSeconds = '3600'),
  (p) => (p.trial = {}),
  (p) => (p.trial.issuedCredits = 0),
  (p) => (p.trial.validForSeconds = Number.MAX_SAFE_INTEGER),
  (p) => (p.wechat.timeoutMs = 10001),
  (p) => (p.wechat.maxResponseBytes = 255),
  (p) => (p.wechat.appSecret = 'bad\u0000secret'),
  (p) => (p.wechat.appId = 'a'.repeat(129)),
  (p) => (p.wechat.url = 'https://evil.invalid'),
  (p) => (p.mock = true),
])
  test('identity host policy rejects defaults, overflow and provider switches', () => {
    const value = policy()
    change(value)
    assert.throws(() => parseIdentityPolicy({ value }))
  })
test('identity nulls explicitly suspend new trial and new login only', () => {
  const value = { sessionTtlSeconds: 60, trial: null, wechat: null }
  const parsed = parseIdentityPolicy({ value })
  assert.deepEqual(parsed, value)
  assert.ok(Object.isFrozen(parsed))
})
test('policy is copied and deeply frozen', () => {
  const value = policy()
  const parsed = parseIdentityPolicy({ value })
  value.wechat.appId = 'mutated'
  assert.equal(parsed.wechat.appId, 'fixture-app')
  assert.ok(Object.isFrozen(parsed.trial))
  assert.ok(Object.isFrozen(parsed.wechat))
})
test('strict opaque Bearer accepts canonical 32-byte token only', () => {
  const token = Buffer.alloc(32, 9).toString('base64url')
  assert.equal(parseBearer({ authorization: `Bearer ${token}` }), token)
  for (const authorization of [
    null,
    token,
    `bearer ${token}`,
    `Bearer  ${token}`,
    `Bearer ${token} `,
    `Bearer ${token},${token}`,
    `Bearer ${token} extra`,
    'Bearer x.y.z',
    `Bearer ${'a'.repeat(43)}`,
  ])
    assert.equal(parseBearer({ authorization }), null)
})
test('new identity timestamps enforce four-digit UTC milliseconds after safe addition', () => {
  assert.equal(
    addIdentitySeconds({ now: '2026-11-12T12:00:00.000Z', seconds: 60 }),
    '2026-11-12T12:01:00.000Z',
  )
  for (const now of [
    '9999-12-31T23:59:59.999Z',
    '+010000-01-01T00:00:00.000Z',
    '2026-11-12T12:00:00Z',
    'invalid',
  ])
    assert.throws(() => addIdentitySeconds({ now, seconds: 60 }))
  for (const seconds of [0, -1, 1.1, Number.MAX_SAFE_INTEGER])
    assert.throws(() => addIdentitySeconds({ now: '2026-11-12T12:00:00.000Z', seconds }))
})

import { createHash } from 'node:crypto'
import { createIdentityService } from '../src/creation/application/identity.ts'
import { createTrialEntitlement } from '../src/creation/application/trial-entitlement.ts'
import { CreditsError } from '../src/creation/domain/credits.ts'
const now = '2026-11-12T12:00:00.000Z'
const audit = {
  createdAt: now,
  updatedAt: now,
  createdBy: 'system:wechat-auth',
  updatedBy: 'system:wechat-auth',
  isDeleted: false,
  deletedAt: null,
  deletedBy: null,
}
function fixture(overrides = {}) {
  let state = { users: [], wechat: [], sessions: [], audits: [] }
  const events = []
  let isWriting = false
  let codeCalls = 0
  let entropyCalls = 0
  const reader = () => ({
    findUsersById: async ({ userId }) => state.users.filter((x) => x.id === userId),
    findWechatIdentities: async ({ appId, openId }) =>
      state.wechat.filter((x) => x.appId === appId && x.openId === openId),
    findSessionsByHash: async ({ tokenHash }) =>
      state.sessions.filter((x) => x.tokenHash === tokenHash),
  })
  const persistence = {
    read: async ({ work }) => {
      events.push('read')
      return work({ reader: reader() })
    },
    write: async ({ resource, work }) => {
      events.push(resource)
      isWriting = true
      const previous = structuredClone(state)
      try {
        return await work({
          repository: {
            ...reader(),
            insertUser: async ({ now }) => {
              const user = {
                ...audit,
                createdAt: now,
                updatedAt: now,
                id: state.users.length + 1,
                displayName: '微信用户',
                avatarUrl: null,
                status: 'active',
              }
              state.users.push(user)
              return user
            },
            insertWechatIdentity: async ({ appId, verified, userId, now }) => {
              const row = {
                ...audit,
                createdAt: now,
                updatedAt: now,
                id: state.wechat.length + 1,
                appId,
                ...verified,
                user: userId,
              }
              state.wechat.push(row)
              return row
            },
            insertSession: async ({ now, ...input }) => {
              const row = {
                ...audit,
                createdAt: now,
                updatedAt: now,
                id: state.sessions.length + 1,
                user: input.userId,
                expiresAt: input.expiresAt,
                tokenHash: input.tokenHash,
                revokedAt: null,
              }
              state.sessions.push(row)
              return row
            },
            appendAudit: async (args) => {
              state.audits.push(args)
            },
            updateProfile: async ({ userId, displayName, now }) => {
              const user = state.users.find((x) => x.id === userId)
              Object.assign(user, { displayName, updatedAt: now, updatedBy: `user:${userId}` })
              return { ...user }
            },
            revokeSession: async ({ sessionId, now, userId }) => {
              Object.assign(
                state.sessions.find((x) => x.id === sessionId),
                { revokedAt: now, updatedAt: now, updatedBy: `user:${userId}` },
              )
            },
          },
        })
      } catch (e) {
        state = previous
        throw e
      } finally {
        isWriting = false
        events.push('released')
      }
    },
  }
  const options = {
    clock: () => now,
    policy: policy(),
    entropy: () => {
      entropyCalls++
      return Buffer.alloc(32, entropyCalls)
    },
    exchange: async ({ code }) => {
      codeCalls++
      assert.ok(!isWriting)
      events.push('exchange:' + code)
      return { openId: 'verified-open', unionId: null }
    },
    persistence,
    trial: async (args) => {
      assert.ok(!isWriting)
      events.push('trial')
      assert.ok(args.isEligible)
    },
    ...overrides,
  }
  return {
    get state() {
      return state
    },
    events,
    options,
    get codeCalls() {
      return codeCalls
    },
    get entropyCalls() {
      return entropyCalls
    },
    service: createIdentityService(options),
  }
}
test('login exchanges once outside A, releases identity lease before B, delivers only after trial', async () => {
  let unblock
  const barrier = new Promise((r) => (unblock = r))
  const f = fixture({
    trial: async () => {
      f.events.push('trial')
      await barrier
    },
  })
  let delivered = false
  const pending = f.service.login({ input: { code: 'once' } }).then((result) => {
    delivered = true
    return result
  })
  await new Promise((r) => setImmediate(r))
  assert.equal(delivered, false)
  assert.equal(f.state.sessions.length, 1)
  assert.equal(f.events.at(-2), 'released')
  unblock()
  const result = await pending
  assert.equal(f.codeCalls, 1)
  assert.equal(result.user.displayName, '微信用户')
  assert.equal(result.expiresAt, '2026-11-12T13:00:00.000Z')
  assert.equal(result.token, Buffer.alloc(32, 1).toString('base64url'))
  assert.equal(
    f.state.sessions[0].tokenHash,
    createHash('sha256').update(result.token).digest('hex'),
  )
  assert.equal(JSON.stringify(f.state).includes(result.token), false)
  assert.equal(f.state.audits[0].action, 'auth.wechat.session.create')
})
test('invalid command stops login before provider, entropy, persistence or trial', async () => {
  const f = fixture()
  await assert.rejects(f.service.login({ input: { code: 'bad code' } }), invalid)
  assert.equal(f.codeCalls, 0)
  assert.equal(f.entropyCalls, 0)
  assert.deepEqual(f.events, [])
})
test('login captures input and verified facts before awaiting its deferred transaction', async () => {
  let release
  const barrier = new Promise((r) => (release = r))
  const verified = { openId: 'captured', unionId: null }
  const f = fixture({ exchange: async () => verified })
  const old = f.options.persistence.write
  f.options.persistence.write = async (args) => {
    await barrier
    return old(args)
  }
  const input = { code: 'original' }
  const pending = f.service.login({ input })
  input.code = 'mutated'
  await new Promise((r) => setImmediate(r))
  verified.openId = 'mutated'
  release()
  await pending
  assert.equal(f.state.wechat[0].openId, 'captured')
})
for (const exchange of [
  () => {
    throw Error('PRIVATE_UPSTREAM')
  },
  async () => {
    throw Error('PRIVATE_UPSTREAM')
  },
  async () => ({ openId: '', unionId: null }),
  async () => ({ openId: 'x', unionId: null, session_key: 'PRIVATE' }),
])
  test('bad provider ports fail before identity transaction with sanitized error', async () => {
    const f = fixture({ exchange })
    await assert.rejects(f.service.login({ input: { code: 'once' } }), {
      code: 'AUTH_PROVIDER_UNAVAILABLE',
    })
    assert.equal(f.state.sessions.length, 0)
    assert.deepEqual(f.events, [])
  })
for (const overrides of [
  { entropy: () => new Uint8Array(31) },
  {
    entropy: () => {
      throw Error('bad entropy')
    },
  },
  { clock: () => '+010000-01-01T00:00:00.000Z' },
  { clock: () => '9999-12-31T23:59:59.999Z' },
])
  test('bad host entropy or new-session date performs no code exchange', async () => {
    const f = fixture(overrides)
    await assert.rejects(f.service.login({ input: { code: 'once' } }))
    assert.equal(f.codeCalls, 0)
    assert.deepEqual(f.events, [])
  })
test('wechat null closes only login while normal session authentication remains available', async () => {
  const f = fixture()
  const result = await f.service.login({ input: { code: 'first' } })
  const service = createIdentityService({
    ...f.options,
    policy: { ...policy(), wechat: null },
    exchange: null,
  })
  await assert.rejects(service.login({ input: { code: 'second' } }), { code: 'AUTH_UNCONFIGURED' })
  assert.equal(
    (await service.getMe({ authorization: `Bearer ${result.token}` })).id,
    result.user.id,
  )
})
test('A confirmed plus B failure retains identity/session, hides raw token and requires a new code', async () => {
  const f = fixture({
    trial: async () => {
      throw Error('PRIVATE trial failure')
    },
  })
  await assert.rejects(f.service.login({ input: { code: 'once' } }), {
    code: 'AUTH_LOGIN_INCOMPLETE',
    status: 503,
    retryable: true,
  })
  assert.equal(f.state.users.length, 1)
  assert.equal(f.state.sessions.length, 1)
  assert.equal(f.state.audits.length, 1)
})
test('a global token hash collision is not regenerated and rolls back new identity', async () => {
  const f = fixture({ entropy: () => Buffer.alloc(32, 1) })
  await f.service.login({ input: { code: 'first' } })
  await assert.rejects(f.service.login({ input: { code: 'second' } }), {
    code: 'AUTH_DATA_INTEGRITY_CONFLICT',
  })
  assert.equal(f.state.users.length, 1)
  assert.equal(f.state.sessions.length, 1)
  assert.equal(f.codeCalls, 2)
})
test('shared credential reads return minimal DTO/principal and profile no-op produces no audit', async () => {
  const f = fixture()
  const result = await f.service.login({ input: { code: 'once' } })
  const authorization = `Bearer ${result.token}`
  assert.deepEqual(await f.service.getMe({ authorization }), result.user)
  assert.deepEqual(Object.keys(await f.service.authenticate({ authorization })).sort(), [
    'collection',
    'createdAt',
    'displayName',
    'id',
    'status',
    'updatedAt',
  ])
  await f.service.updateProfile({ authorization, input: { displayName: '  New name  ' } })
  assert.equal((await f.service.getMe({ authorization })).displayName, 'New name')
  assert.equal(f.state.audits.length, 2)
  await f.service.updateProfile({ authorization, input: { displayName: 'New name' } })
  assert.equal(f.state.audits.length, 2)
  assert.equal(f.state.audits[1].userId, result.user.id)
  assert.equal(JSON.stringify(f.state.audits).includes('New name'), false)
})
test('logout revokes expired/disabled credentials and repeats without audit or timestamp writes', async () => {
  const f = fixture()
  const result = await f.service.login({ input: { code: 'once' } })
  const authorization = `Bearer ${result.token}`
  f.state.users[0].status = 'disabled'
  f.state.sessions[0].expiresAt = now
  assert.equal(await f.service.authenticate({ authorization }), null)
  assert.deepEqual(await f.service.logout({ authorization }), { revoked: true })
  const snapshot = JSON.stringify(f.state)
  assert.deepEqual(await f.service.logout({ authorization }), { revoked: false })
  assert.equal(JSON.stringify(f.state), snapshot)
  await assert.rejects(f.service.updateProfile({ authorization, input: { displayName: 'x' } }), {
    code: 'AUTH_UNAUTHENTICATED',
  })
})
for (const change of [
  (s) => s.sessions.push({ ...s.sessions[0], id: 2 }),
  (s) => (s.sessions[0].user = 99),
  (s) => (s.sessions[0].deletedBy = 'system:orphan'),
  (s) => (s.users[0].deletedAt = now),
])
  test('credential structural corruption fails rather than authorizing a partial lookup', async () => {
    const f = fixture()
    const result = await f.service.login({ input: { code: 'once' } })
    change(f.state)
    await assert.rejects(f.service.getMe({ authorization: `Bearer ${result.token}` }), {
      code: 'AUTH_DATA_INTEGRITY_CONFLICT',
    })
  })
const trialIdentity = { userId: 1, identityCreatedAt: now, isEligible: true }
function trialFixture(overrides = {}) {
  let grants = []
  const calls = []
  const options = {
    policy: { issuedCredits: 7, validForSeconds: 60 },
    clock: () => now,
    findGrantsByKey: async () => grants,
    issueGrant: async (args) => {
      calls.push(args)
      return {}
    },
    ...overrides,
  }
  return {
    get grants() {
      return grants
    },
    set grants(value) {
      grants = value
    },
    calls,
    options,
    ensure: createTrialEntitlement(options),
  }
}
function trialGrant(changes = {}) {
  return {
    id: 1,
    accountId: 1,
    userId: 1,
    isDeleted: false,
    grantKey: 'trial:1',
    sourceType: 'trial',
    sourceId: `wechat-signup:1:${now}`,
    issuedCredits: 7,
    availableCredits: 7,
    reservedCredits: 0,
    consumedCredits: 0,
    expiredCredits: 0,
    revokedCredits: 0,
    validFrom: now,
    expiresAt: '2026-11-12T12:01:00.000Z',
    ...changes,
  }
}
test('first trial uses fixed identity source and ensure-time policy with no legacy backfill', async () => {
  const f = trialFixture()
  await f.ensure({ ...trialIdentity, isEligible: false })
  assert.equal(f.calls.length, 0)
  await f.ensure(trialIdentity)
  assert.deepEqual(f.calls[0], {
    userId: 1,
    command: {
      grantKey: 'trial:1',
      sourceType: 'trial',
      sourceId: `wechat-signup:1:${now}`,
      issuedCredits: 7,
      validFrom: now,
      expiresAt: '2026-11-12T12:01:00.000Z',
    },
  })
})
test('changed trial policy replays original terms even after original balance is consumed or expired', async () => {
  const f = trialFixture({
    policy: { issuedCredits: 99, validForSeconds: null },
    clock: () => '2026-11-13T12:00:00.000Z',
  })
  f.grants = [trialGrant({ availableCredits: 0, consumedCredits: 7 })]
  await f.ensure(trialIdentity)
  assert.equal(f.calls[0].command.issuedCredits, 7)
  assert.equal(f.calls[0].command.expiresAt, '2026-11-12T12:01:00.000Z')
})
test('null trial policy recognizes a prior fixed-key grant without issuing or doing a full money replay', async () => {
  const f = trialFixture({ policy: null })
  f.grants = [trialGrant()]
  await f.ensure(trialIdentity)
  assert.equal(f.calls.length, 0)
  f.grants = [trialGrant({ sourceId: 'wrong' })]
  await assert.rejects(f.ensure(trialIdentity), { code: 'AUTH_DATA_INTEGRITY_CONFLICT' })
})
for (const grants of [
  [trialGrant({ userId: 2 })],
  [trialGrant({ isDeleted: true })],
  [trialGrant(), trialGrant({ id: 2 })],
  [trialGrant({ sourceType: 'topup' })],
  [trialGrant({ sourceId: 'bad' })],
])
  test('trial refuses global wrong owner, tombstone, duplicate or source', async () => {
    const f = trialFixture()
    f.grants = grants
    await assert.rejects(f.ensure(trialIdentity), { code: 'AUTH_DATA_INTEGRITY_CONFLICT' })
    assert.equal(f.calls.length, 0)
  })
test('only fixed-key idempotency competition is reread then replayed with its original terms', async () => {
  let calls = 0
  const f = trialFixture({
    issueGrant: async (args) => {
      calls++
      if (calls === 1) {
        f.grants = [trialGrant({ issuedCredits: 9, availableCredits: 9 })]
        throw new CreditsError({ code: 'IDEMPOTENCY_CONFLICT' })
      }
      assert.equal(args.command.issuedCredits, 9)
    },
  })
  await f.ensure(trialIdentity)
  assert.equal(calls, 2)
  const bad = trialFixture({
    issueGrant: async () => {
      throw new CreditsError({ code: 'DATA_INTEGRITY_CONFLICT' })
    },
  })
  await assert.rejects(bad.ensure(trialIdentity), { code: 'DATA_INTEGRITY_CONFLICT' })
})

test('nonexpiring trial accepts the final four-digit UTC millisecond without inventing an expiry', async () => {
  const f = trialFixture({
    policy: { issuedCredits: 7, validForSeconds: null },
    clock: () => '9999-12-31T23:59:59.999Z',
  })
  await f.ensure(trialIdentity)
  assert.equal(f.calls[0].command.validFrom, '9999-12-31T23:59:59.999Z')
  assert.equal(f.calls[0].command.expiresAt, null)
})
test('logout does not impose new-session expiration arithmetic on an existing historical credential', async () => {
  const f = fixture()
  const login = await f.service.login({ input: { code: 'once' } })
  f.state.sessions[0].expiresAt = '+010000-01-01T00:00:00.000Z'
  const identity = createIdentityService({ ...f.options, clock: () => '9999-12-31T23:59:59.999Z' })
  assert.equal(
    (await identity.authenticate({ authorization: `Bearer ${login.token}` })).id,
    login.user.id,
  )
  assert.deepEqual(await identity.logout({ authorization: `Bearer ${login.token}` }), {
    revoked: true,
  })
})
test('strict core JSON shape rejects accessors and symbols without invoking arbitrary host getters', () => {
  const value = structuredClone(hostConfig({ dataDir: '/tmp/identity-policy-unit' }))
  let reads = 0
  Object.defineProperty(value, 'identity', {
    enumerable: true,
    get() {
      reads++
      return policy()
    },
  })
  assert.throws(() => parseCoreConfig({ value }))
  assert.equal(reads, 0)
  const symbols = structuredClone(hostConfig({ dataDir: '/tmp/identity-policy-unit' }))
  symbols[Symbol('switch')] = true
  assert.throws(() => parseCoreConfig({ value: symbols }))
})

test('missing or malformed getMe credentials are rejected before opening any read snapshot', async () => {
  const f = fixture()
  for (const authorization of [undefined, null, 'Bearer x.y.z', 'Bearer not-canonical'])
    await assert.rejects(f.service.getMe({ authorization }), { code: 'AUTH_UNAUTHENTICATED' })
  assert.deepEqual(f.events, [])
})
