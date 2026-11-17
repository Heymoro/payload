import type { Payload, PayloadRequest } from 'payload'

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createPayloadRequest } from 'payload'
import { expect, vi } from 'vitest'

import type { WechatCodeExchange } from '../../src/creation/application/identity-types.js'
import type { IdentityPolicy } from '../../src/creation/domain/identity.js'
import type { CreationCoordinator } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createPayloadIdentityService } from '../../src/creation/infrastructure/payload/identity-repository.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createRedisCreationCoordinator } from '../../src/creation/infrastructure/redis/coordinator.js'
import { parseCoreConfig } from '../../src/creation/runtime/config.js'
import { prepareDevelopmentIdentity } from '../../src/creation/runtime/development-identity.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'
import { cleanupRuntime, config, directory, gate, redis, state } from './runtime.config.js'
import { controlledWrite, now, seedChain } from './runtime-seed.js'

const incomplete = { code: 'AUTH_LOGIN_INCOMPLETE', retryable: true, status: 503 }

test.suite('Heymoro formal Native identity', { config: './runtime.config.ts', cron: false }, () => {
  test.afterAll(cleanupRuntime)
  test.beforeEach(() => {
    state.wechatCalls = 0
    state.wechatResult = { openId: 'fixture-open', unionId: null }
    state.beforeWechat = null
  })
  test.afterEach(() => {
    vi.restoreAllMocks()
    state.beforeWechat = null
  })

  test('should reuse the real identity, opaque sessions and one 100-credit trial for the development identity adapter', async ({
    payload,
  }) => {
    const root = path.join(directory, 'development-profile')
    const dataDir = path.join(root, 'data')
    mkdirSync(root, { mode: 0o700 })
    mkdirSync(dataDir, { mode: 0o700 })
    writeFileSync(
      path.join(root, 'local-profile.json'),
      JSON.stringify({ purpose: 'heymoro-local-development' }),
      { mode: 0o600 },
    )
    const local = parseCoreConfig({
      value: { ...config, dataDir, identity: { ...config.identity, trial: null, wechat: null } },
    })
    const filename = path.join(root, 'core.json')
    writeFileSync(filename, JSON.stringify(local), { mode: 0o600 })
    const before = readFileSync(filename)
    const prepared = prepareDevelopmentIdentity({ config: local, mode: 'development' })
    const identity = service({
      exchange: prepared.ports!.wechat!,
      payload,
      policy: prepared.config.identity,
    })
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('External requests are forbidden in this test.'))
    const first = await identity.login({ input: { code: 'development-code-one' } })
    const second = await identity.login({ input: { code: 'development-code-two' } })
    expect(first.user.id).toBe(second.user.id)
    expect(first.token).not.toBe(second.token)
    expect(first.token).toMatch(/^[\w-]{43}$/)
    const authorization = `Bearer ${second.token}`
    expect(await identity.getMe({ authorization })).toEqual(second.user)
    expect((await payload.auth({ headers: new Headers({ authorization }) })).user).toMatchObject({
      id: second.user.id,
      collection: 'users',
    })
    expect(await rows({ collection: 'users', payload })).toHaveLength(1)
    expect(await rows({ collection: 'userSessions', payload })).toHaveLength(2)
    const identities = await rows({ collection: 'wechatIdentities', payload })
    expect(identities).toHaveLength(1)
    expect(identities[0]).toMatchObject({
      appId: 'heymoro-local-development-v1',
      openId: expect.stringMatching(/^local-development:/),
    })
    const grants = await rows({ collection: 'credit-grants', payload })
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({
      availableCredits: 100,
      grantKey: `trial:${first.user.id}`,
      issuedCredits: 100,
      userId: first.user.id,
    })
    expect(await rows({ collection: 'credit-ledger', payload })).toHaveLength(1)
    expect(await rows({ collection: 'auditLogs', payload })).toHaveLength(2)
    expect(state.wechatCalls).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
    expect(readFileSync(filename)).toEqual(before)
    expect(local.identity.wechat).toBeNull()
    expect(local.identity.trial).toBeNull()
  })

  test('should deliver real Native login, wallet issuance and minimal Payload authentication through the runtime getter', async ({
    payload,
  }) => {
    const identity = getCoreRuntime({ payload }).identity
    const result = await identity.login({ input: { code: 'fixture-once' } })
    const authorization = `Bearer ${result.token}`
    expect(state.wechatCalls).toBe(1)
    expect(result.token).toMatch(/^[\w-]{43}$/)
    expect(result.user).toEqual({
      id: result.user.id,
      avatarUrl: null,
      displayName: '微信用户',
      status: 'active',
    })
    expect(await identity.getMe({ authorization })).toEqual(result.user)
    expect((await payload.auth({ headers: new Headers({ authorization }) })).user).toMatchObject({
      id: result.user.id,
      collection: 'users',
    })
    expect(await identity.authenticate({ authorization })).toEqual(
      (await payload.auth({ headers: new Headers({ authorization }) })).user,
    )
    const users = await rows({ collection: 'users', payload })
    const wx = await rows({ collection: 'wechatIdentities', payload })
    const sessions = await rows({ collection: 'userSessions', payload })
    const grants = await rows({ collection: 'credit-grants', payload })
    const ledger = await rows({ collection: 'credit-ledger', payload })
    const audits = await rows({ collection: 'auditLogs', payload })
    expect(users).toHaveLength(1)
    expect(wx).toHaveLength(1)
    expect(sessions).toHaveLength(1)
    expect(wx[0]).toMatchObject({
      appId: 'fixture-app',
      createdAt: users[0]!.createdAt,
      createdBy: 'system:wechat-auth',
      openId: 'fixture-open',
      user: result.user.id,
    })
    expect(sessions[0]).toMatchObject({
      createdBy: 'system:wechat-auth',
      expiresAt: result.expiresAt,
      tokenHash: hash(result.token),
      user: result.user.id,
    })
    expect(grants).toHaveLength(1)
    expect(ledger).toHaveLength(1)
    expect(grants[0]).toMatchObject({
      availableCredits: 7,
      grantKey: `trial:${result.user.id}`,
      issuedCredits: 7,
      sourceId: `wechat-signup:${result.user.id}:${wx[0]!.createdAt}`,
      sourceType: 'trial',
      userId: result.user.id,
    })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      action: 'auth.wechat.session.create',
      actorId: 'wechat-auth',
      actorType: 'system',
      resourceId: String(sessions[0]!.id),
      resourceType: 'user-session',
      summary: { createdUser: true },
    })
    expect(audits[0]!.requestId).toMatch(/^[a-f0-9-]{36}$/)
    expect(audits[0]!.correlationId).toBe(audits[0]!.requestId)
    expect(JSON.stringify(audits)).not.toMatch(/fixture-open|tokenHash|session_key|微信用户/)
    expect(
      JSON.stringify([...users, ...wx, ...sessions, ...grants, ...ledger, ...audits]),
    ).not.toContain(result.token)
    expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
  })

  test('should reject malformed login before any exchange, lease or SQLite work', async ({
    payload,
  }) => {
    const transactions = vi.spyOn(getCreationSQLiteAdapter({ payload }).client, 'transaction')
    const leases = vi.spyOn(redis.client, 'set')
    await expect(
      getCoreRuntime({ payload }).identity.login({ input: { code: 'bad code' } }),
    ).rejects.toMatchObject({ code: 'AUTH_INPUT_INVALID' })
    expect(state.wechatCalls).toBe(0)
    expect(transactions).not.toHaveBeenCalled()
    expect(leases).not.toHaveBeenCalled()
  })

  test('should keep code exchange and B wallet outside the fully released A identity lease and request', async ({
    payload,
  }) => {
    const adapter = getCreationSQLiteAdapter({ payload })
    let identityRequest: PayloadRequest | undefined
    state.beforeWechat = async () => {
      expect(Object.keys(adapter.sessions)).toEqual([])
      expect(await redis.client.keys(`${config.redis.namespace}:*`)).toEqual([])
    }
    const originalCreate = payload.create.bind(payload)
    const identityResource = `wechat-identity:${hash(JSON.stringify(['fixture-app', 'fixture-open']))}`
    const identityKey = `${config.redis.namespace}:${hash(identityResource)}`
    let checkedWallet = false
    vi.spyOn(payload, 'create').mockImplementation(async (args) => {
      if (args.collection === 'userSessions') {
        identityRequest = args.req as PayloadRequest
      }
      if (String(args.collection) === 'credit-accounts') {
        expect(identityRequest).toBeDefined()
        expect(identityRequest!.transactionID).toBeUndefined()
        expect(await redis.client.get(identityKey)).toBeNull()
        expect(args.req).not.toBe(identityRequest)
        checkedWallet = true
      }
      return originalCreate(args)
    })
    await getCoreRuntime({ payload }).identity.login({ input: { code: 'fixture-once' } })
    expect(checkedWallet).toBe(true)
  })

  test('should serialize concurrent same-app/open logins into one Native owner and one fixed trial', async ({
    payload,
  }) => {
    const identity = getCoreRuntime({ payload }).identity
    const results = await Promise.all([
      identity.login({ input: { code: 'new-code-A' } }),
      identity.login({ input: { code: 'new-code-B' } }),
      identity.login({ input: { code: 'new-code-C' } }),
    ])
    expect(new Set(results.map((result) => result.user.id)).size).toBe(1)
    expect(new Set(results.map((result) => result.token)).size).toBe(3)
    expect(await rows({ collection: 'users', payload })).toHaveLength(1)
    expect(await rows({ collection: 'wechatIdentities', payload })).toHaveLength(1)
    expect(await rows({ collection: 'userSessions', payload })).toHaveLength(3)
    expect(await rows({ collection: 'credit-grants', payload })).toHaveLength(1)
    expect(await rows({ collection: 'credit-ledger', payload })).toHaveLength(1)
    expect(state.wechatCalls).toBe(3)
  })

  test('should never merge different apps or opens by unionId or overwrite an existing union', async ({
    payload,
  }) => {
    const one = service({
      exchange: async () => ({ openId: 'same-open', unionId: 'shared-union' }),
      payload,
    })
    const two = service({
      exchange: async () => ({ openId: 'same-open', unionId: 'shared-union' }),
      payload,
      policy: {
        ...config.identity,
        wechat: { ...config.identity.wechat!, appId: 'fixture-app-2' },
      },
    })
    const three = service({
      exchange: async () => ({ openId: 'other-open', unionId: 'shared-union' }),
      payload,
    })
    const results = await Promise.all([
      one.login({ input: { code: 'A' } }),
      two.login({ input: { code: 'B' } }),
      three.login({ input: { code: 'C' } }),
    ])
    expect(new Set(results.map((result) => result.user.id)).size).toBe(3)
    const changed = service({
      exchange: async () => ({ openId: 'same-open', unionId: 'different-union' }),
      payload,
    })
    expect((await changed.login({ input: { code: 'D' } })).user.id).toBe(results[0]!.user.id)
    expect(
      (await rows({ collection: 'wechatIdentities', payload }))
        .filter((row) => row.openId === 'same-open')
        .map((row) => row.unionId),
    ).toEqual(['shared-union', 'shared-union'])
  })

  for (const table of ['users', 'wechat_identities', 'user_sessions', 'audit_logs']) {
    test(`should roll back all of A when the real ${table} insert is rejected`, async ({
      payload,
    }) => {
      const client = getCreationSQLiteAdapter({ payload }).client
      await client.execute(
        `CREATE TRIGGER fixture_identity_insert_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture insert rejection'); END`,
      )
      try {
        await expect(
          getCoreRuntime({ payload }).identity.login({ input: { code: 'A' } }),
        ).rejects.toMatchObject(incomplete)
        for (const collection of [
          'users',
          'wechatIdentities',
          'userSessions',
          'auditLogs',
          'credit-grants',
        ]) {
          expect(await rows({ collection, payload })).toHaveLength(0)
        }
      } finally {
        await client.execute('DROP TRIGGER fixture_identity_insert_failure')
      }
      expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
    })
  }

  test('should confirm A, hide the token on B failure, and recover with a new code without compensating A', async ({
    payload,
  }) => {
    const client = getCreationSQLiteAdapter({ payload }).client
    await client.execute(
      "CREATE TRIGGER fixture_trial_insert_failure BEFORE INSERT ON credit_grants BEGIN SELECT RAISE(ABORT, 'fixture trial rejection'); END",
    )
    try {
      await expect(
        getCoreRuntime({ payload }).identity.login({ input: { code: 'A' } }),
      ).rejects.toMatchObject(incomplete)
    } finally {
      await client.execute('DROP TRIGGER fixture_trial_insert_failure')
    }
    expect(await rows({ collection: 'users', payload })).toHaveLength(1)
    expect(await rows({ collection: 'userSessions', payload })).toHaveLength(1)
    expect(await rows({ collection: 'auditLogs', payload })).toHaveLength(1)
    expect(await rows({ collection: 'credit-grants', payload })).toHaveLength(0)
    const recovered = await getCoreRuntime({ payload }).identity.login({ input: { code: 'new-B' } })
    expect(recovered.user.id).toBe((await rows({ collection: 'users', payload }))[0]!.id)
    expect(await rows({ collection: 'userSessions', payload })).toHaveLength(2)
    expect(await rows({ collection: 'credit-grants', payload })).toHaveLength(1)
    expect(await rows({ collection: 'credit-ledger', payload })).toHaveLength(1)
    expect(state.wechatCalls).toBe(2)
  })

  for (const phase of ['A-before', 'A-ack', 'B-before', 'B-ack']) {
    test(`should not automatically retry ${phase} unknown commit and should recover through a new code`, async ({
      payload,
    }) => {
      const adapter = getCreationSQLiteAdapter({ payload })
      const original = adapter.client.transaction.bind(adapter.client)
      let transactions = 0
      let failures = 0
      vi.spyOn(adapter.client, 'transaction').mockImplementation(async (...args) => {
        const transaction = await original(...args)
        const current = ++transactions
        return new Proxy(transaction, {
          get: (target, property) => {
            if (property === 'commit' && current === (phase.startsWith('A') ? 1 : 3)) {
              return async () => {
                failures++
                if (phase.endsWith('ack')) {
                  await target.commit()
                }
                throw Object.assign(new Error('fixture unknown commit acknowledgement'), {
                  code: 'SQLITE_BUSY',
                })
              }
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      })
      await expect(
        getCoreRuntime({ payload }).identity.login({ input: { code: 'A' } }),
      ).rejects.toMatchObject(incomplete)
      expect(failures).toBe(1)
      expect(state.wechatCalls).toBe(1)
      expect(transactions).toBe(phase.startsWith('A') ? 1 : 3)
      vi.restoreAllMocks()
      expect(Object.keys(adapter.sessions)).toEqual([])
      await getCoreRuntime({ payload }).identity.login({ input: { code: 'new-B' } })
      expect(await rows({ collection: 'users', payload })).toHaveLength(1)
      expect(await rows({ collection: 'wechatIdentities', payload })).toHaveLength(1)
      expect(await rows({ collection: 'credit-grants', payload })).toHaveLength(1)
      expect(
        (await rows({ collection: 'credit-ledger', payload })).filter(
          (row) => row.operation === 'grant',
        ),
      ).toHaveLength(1)
    })
  }

  test('should retain the same token material and one exchange across a confirmed SQLite busy retry', async ({
    payload,
  }) => {
    const original = payload.create.bind(payload)
    let failures = 0
    let entropyCalls = 0
    let exchanges = 0
    vi.spyOn(payload, 'create').mockImplementation(async (args) => {
      if (args.collection === 'users' && failures++ === 0) {
        throw Object.assign(new Error('fixture busy'), { code: 'SQLITE_BUSY' })
      }
      return original(args)
    })
    const identity = service({
      entropy: () => {
        entropyCalls++
        return Buffer.alloc(32, 21)
      },
      exchange: async () => {
        exchanges++
        return { openId: 'busy-open', unionId: null }
      },
      payload,
    })
    const result = await identity.login({ input: { code: 'once' } })
    expect(result.token).toBe(Buffer.alloc(32, 21).toString('base64url'))
    expect(entropyCalls).toBe(1)
    expect(exchanges).toBe(1)
    expect(await rows({ collection: 'users', payload })).toHaveLength(1)
  })

  test('should roll back A after real Redis lease removal before the next write', async ({
    payload,
  }) => {
    const original = payload.create.bind(payload)
    let removed = false
    vi.spyOn(payload, 'create').mockImplementation(async (args) => {
      const result = await original(args)
      if (args.collection === 'users') {
        const keys = await redis.client.keys(`${config.redis.namespace}:*`)
        expect(keys).toHaveLength(1)
        await redis.client.del(...keys)
        removed = true
        await new Promise((resolve) => setTimeout(resolve, config.redis.renewEveryMs + 100))
      }
      return result
    })
    await expect(
      getCoreRuntime({ payload }).identity.login({ input: { code: 'once' } }),
    ).rejects.toMatchObject(incomplete)
    expect(removed).toBe(true)
    for (const collection of ['users', 'wechatIdentities', 'userSessions', 'auditLogs']) {
      expect(await rows({ collection, payload })).toHaveLength(0)
    }
  })

  test('should replay original trial terms after policy change and expiry rather than issuing or extending', async ({
    payload,
  }) => {
    const first = await getCoreRuntime({ payload }).identity.login({ input: { code: 'A' } })
    const originalGrant = (await rows({ collection: 'credit-grants', payload }))[0]!
    const later = service({
      clock: () => '2026-11-14T12:00:00.000Z',
      payload,
      policy: { ...config.identity, trial: { issuedCredits: 99, validForSeconds: null } },
    })
    expect((await later.login({ input: { code: 'B' } })).user.id).toBe(first.user.id)
    const grants = await rows({ collection: 'credit-grants', payload })
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({
      availableCredits: 0,
      expiredCredits: 7,
      expiresAt: originalGrant.expiresAt,
      grantKey: originalGrant.grantKey,
      issuedCredits: 7,
      sourceId: originalGrant.sourceId,
      validFrom: originalGrant.validFrom,
    })
    expect(
      (await rows({ collection: 'credit-ledger', payload })).map((row) => row.operation).sort(),
    ).toEqual(['expire', 'grant'])
  })

  test('should allow explicit trial pause without backfill then issue once on a later new-code login', async ({
    payload,
  }) => {
    const paused = service({ payload, policy: { ...config.identity, trial: null } })
    const first = await paused.login({ input: { code: 'A' } })
    expect(await rows({ collection: 'credit-grants', payload })).toHaveLength(0)
    await getCoreRuntime({ payload }).identity.login({ input: { code: 'B' } })
    expect(await rows({ collection: 'credit-grants', payload })).toHaveLength(1)
    const ledger = await rows({ collection: 'credit-ledger', payload })
    await paused.login({ input: { code: 'C' } })
    expect(await rows({ collection: 'credit-ledger', payload })).toEqual(ledger)
    expect(first.user.id).toBe((await rows({ collection: 'users', payload }))[0]!.id)
  })

  test('should not backfill admin/legacy Native identity chains', async ({ payload }) => {
    await controlledWrite({
      gate,
      payload,
      work: async ({ req }) => {
        const audit = {
          createdAt: now,
          createdBy: 'system:legacy-import',
          isDeleted: false,
          updatedAt: now,
          updatedBy: 'system:legacy-import',
        }
        const user = await gate.run({
          req,
          work: () =>
            payload.create({
              collection: 'users',
              data: { ...audit, displayName: 'Legacy', status: 'active' } as never,
              overrideAccess: true,
              req,
            }),
        })
        await gate.run({
          req,
          work: () =>
            payload.create({
              collection: 'wechatIdentities',
              data: {
                ...audit,
                appId: 'fixture-app',
                openId: 'fixture-open',
                user: user.id,
              } as never,
              overrideAccess: true,
              req,
            }),
        })
      },
    })
    expect(
      (await getCoreRuntime({ payload }).identity.login({ input: { code: 'A' } })).user.displayName,
    ).toBe('Legacy')
    expect(await rows({ collection: 'credit-grants', payload })).toHaveLength(0)
  })

  test('should preserve a genuinely consumed trial after real generation and a later policy change', async ({
    payload,
  }) => {
    state.kind = 'output'
    const runtime = getCoreRuntime({ payload })
    const login = await runtime.identity.login({ input: { code: 'A' } })
    const templateFixture = await seedChain({ config, gate, payload })
    const userId = login.user.id
    const created = await runtime.session({
      command: {
        clientRequestId: 'identity-spend-session',
        templateId: templateFixture.templateId,
      },
      userId,
    })
    const sessionId = created.session.id
    const input = { description: 'A real fixture image', inputMediaIds: [], userNotes: '' }
    const quote = await runtime.admission.quoteGenerate({ input, sessionId, userId })
    const accepted = await runtime.admission.submitGenerate({
      clientRequestId: 'identity-spend-task',
      input,
      quoteToken: quote.quoteToken,
      sessionId,
      userId,
    })
    await payload.jobs.run({ limit: 5, overrideAccess: true, queue: 'creation' })
    expect((await runtime.tasks.get({ taskId: accepted.task.id, userId })).status).toBe('succeeded')
    expect((await runtime.credits.account({ userId })).available).toBe(5)
    const changed = service({
      payload,
      policy: { ...config.identity, trial: { issuedCredits: 99, validForSeconds: null } },
    })
    expect((await changed.login({ input: { code: 'B' } })).user.id).toBe(userId)
    const grants = (await rows({ collection: 'credit-grants', payload })).filter(
      (row) => row.userId === userId,
    )
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({
      availableCredits: 5,
      consumedCredits: 2,
      grantKey: `trial:${userId}`,
      issuedCredits: 7,
    })
    expect((await runtime.credits.account({ userId })).available).toBe(5)
  })

  for (const corruption of ['wrong-owner', 'tombstone', 'source', 'duplicate']) {
    test(`should fail B closed for a real fixed-key trial ${corruption} without hiding A`, async ({
      payload,
    }) => {
      const runtime = getCoreRuntime({ payload })
      await runtime.identity.login({ input: { code: 'A' } })
      const client = getCreationSQLiteAdapter({ payload }).client
      if (corruption === 'wrong-owner') {
        await client.execute('UPDATE credit_grants SET user_id = 999999')
      }
      if (corruption === 'tombstone') {
        await client.execute('UPDATE credit_grants SET is_deleted = 1')
      }
      if (corruption === 'source') {
        await client.execute("UPDATE credit_grants SET source_id = 'wrong-source'")
      }
      if (corruption === 'duplicate') {
        const columns = (await client.execute("PRAGMA table_info('credit_grants')")).rows
          .filter((row) => row.name !== 'id')
          .map((row) => quote(String(row.name)))
          .join(',')
        await client.execute(
          `INSERT INTO credit_grants (${columns}) SELECT ${columns} FROM credit_grants LIMIT 1`,
        )
      }
      await expect(runtime.identity.login({ input: { code: 'B' } })).rejects.toMatchObject(
        incomplete,
      )
      expect(await rows({ collection: 'users', payload })).toHaveLength(1)
      expect(await rows({ collection: 'userSessions', payload })).toHaveLength(2)
      expect(await rows({ collection: 'auditLogs', payload })).toHaveLength(2)
      expect(
        (await rows({ collection: 'credit-ledger', payload })).filter(
          (row) => row.operation === 'grant',
        ),
      ).toHaveLength(1)
    })
  }

  for (const condition of ['revoked', 'expired', 'deleted']) {
    test(`should reserve token hashes globally even for ${condition} sessions without generating another token`, async ({
      payload,
    }) => {
      const identity = service({ entropy: () => Buffer.alloc(32, 42), payload })
      const first = await identity.login({ input: { code: 'A' } })
      const session = (await rows({ collection: 'userSessions', payload }))[0]!
      await mutate({
        id: Number(session.id),
        collection: 'userSessions',
        data:
          condition === 'revoked'
            ? { revokedAt: now }
            : condition === 'expired'
              ? { expiresAt: now }
              : { deletedAt: now, deletedBy: 'system:fixture', isDeleted: true },
        payload,
      })
      await expect(identity.login({ input: { code: 'B' } })).rejects.toMatchObject({
        code: 'AUTH_DATA_INTEGRITY_CONFLICT',
      })
      expect(await rows({ collection: 'userSessions', payload })).toHaveLength(1)
      expect((await rows({ collection: 'users', payload }))[0]!.id).toBe(first.user.id)
    })
  }

  test('should reject a complete Wx tombstone without recreating or merging its user', async ({
    payload,
  }) => {
    const runtime = getCoreRuntime({ payload })
    await runtime.identity.login({ input: { code: 'A' } })
    const wxId = Number((await rows({ collection: 'wechatIdentities', payload }))[0]!.id)
    await controlledWrite({
      gate,
      payload,
      work: ({ req }) =>
        gate.run({
          req,
          work: () =>
            payload.update({
              id: wxId,
              collection: 'wechatIdentities',
              data: {
                deletedAt: now,
                deletedBy: 'system:fixture',
                isDeleted: true,
                updatedBy: 'system:fixture',
              } as never,
              overrideAccess: true,
              req,
            }),
        }),
    })
    await expect(runtime.identity.login({ input: { code: 'B' } })).rejects.toMatchObject({
      code: 'AUTH_DATA_INTEGRITY_CONFLICT',
    })
    expect(await rows({ collection: 'users', payload })).toHaveLength(1)
    expect(await rows({ collection: 'userSessions', payload })).toHaveLength(1)
  })

  test('should disable only new login when wechat is null and preserve read/profile/logout', async ({
    payload,
  }) => {
    const login = await getCoreRuntime({ payload }).identity.login({ input: { code: 'A' } })
    const authorization = `Bearer ${login.token}`
    const identity = service({ payload, policy: { ...config.identity, wechat: null } })
    await expect(identity.login({ input: { code: 'B' } })).rejects.toMatchObject({
      code: 'AUTH_UNCONFIGURED',
    })
    expect(await identity.getMe({ authorization })).toEqual(login.user)
    expect(
      await identity.updateProfile({ authorization, input: { displayName: 'New' } }),
    ).toMatchObject({ displayName: 'New' })
    expect(await identity.logout({ authorization })).toEqual({ revoked: true })
    expect(await identity.authenticate({ authorization })).toBeNull()
  })

  test('should authenticate and getMe in one read-only snapshot with no Redis or provider calls', async ({
    payload,
  }) => {
    const identity = getCoreRuntime({ payload }).identity
    const login = await identity.login({ input: { code: 'A' } })
    const authorization = `Bearer ${login.token}`
    const create = vi.spyOn(payload, 'create')
    const update = vi.spyOn(payload, 'update')
    const leases = vi.spyOn(redis.client, 'set')
    const transactions = vi.spyOn(getCreationSQLiteAdapter({ payload }).client, 'transaction')
    expect(await identity.getMe({ authorization })).toEqual(login.user)
    expect(transactions).toHaveBeenCalledExactlyOnceWith('deferred')
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(leases).not.toHaveBeenCalled()
    expect(state.wechatCalls).toBe(1)
  })

  test('should update profile minimally, omit nickname audit, and perform a true no-op for the same name', async ({
    payload,
  }) => {
    const identity = getCoreRuntime({ payload }).identity
    const login = await identity.login({ input: { code: 'A' } })
    const authorization = `Bearer ${login.token}`
    for (const input of [
      {},
      { avatarUrl: 'https://external.invalid', displayName: 'New' },
      { displayName: 'New', status: 'disabled' },
      { displayName: 'New', updatedBy: 'admin:999' },
    ]) {
      await expect(identity.updateProfile({ authorization, input })).rejects.toMatchObject({
        code: 'AUTH_INPUT_INVALID',
      })
    }
    expect(
      await identity.updateProfile({ authorization, input: { displayName: '  New name  ' } }),
    ).toMatchObject({ id: login.user.id, displayName: 'New name' })
    const before = await rows({ collection: 'users', payload })
    const audits = await rows({ collection: 'auditLogs', payload })
    const writes = vi.spyOn(payload, 'update')
    await identity.updateProfile({ authorization, input: { displayName: 'New name' } })
    expect(writes).not.toHaveBeenCalled()
    expect(await rows({ collection: 'users', payload })).toEqual(before)
    expect(await rows({ collection: 'auditLogs', payload })).toEqual(audits)
    expect(audits[1]).toMatchObject({
      action: 'user.profile.update',
      actorId: String(login.user.id),
      actorType: 'user',
      createdBy: `user:${login.user.id}`,
      summary: { changedFields: ['displayName'] },
    })
    expect(JSON.stringify(audits)).not.toContain('New name')
  })

  for (const action of ['profile', 'logout']) {
    test(`should atomically roll back ${action} if its audit append fails`, async ({ payload }) => {
      const identity = getCoreRuntime({ payload }).identity
      const login = await identity.login({ input: { code: 'A' } })
      const authorization = `Bearer ${login.token}`
      const users = await rows({ collection: 'users', payload })
      const sessions = await rows({ collection: 'userSessions', payload })
      const client = getCreationSQLiteAdapter({ payload }).client
      await client.execute(
        "CREATE TRIGGER fixture_profile_audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'fixture audit rejection'); END",
      )
      try {
        await expect(
          action === 'profile'
            ? identity.updateProfile({ authorization, input: { displayName: 'New' } })
            : identity.logout({ authorization }),
        ).rejects.toBeDefined()
      } finally {
        await client.execute('DROP TRIGGER fixture_profile_audit_failure')
      }
      expect(await rows({ collection: 'users', payload })).toEqual(users)
      expect(await rows({ collection: 'userSessions', payload })).toEqual(sessions)
    })
  }

  for (const condition of ['expired', 'disabled', 'user-deleted', 'session-deleted']) {
    test(`should handle ${condition} credentials with strict Native auth and idempotent logout`, async ({
      payload,
    }) => {
      const identity = getCoreRuntime({ payload }).identity
      const login = await identity.login({ input: { code: 'A' } })
      const authorization = `Bearer ${login.token}`
      const session = (await rows({ collection: 'userSessions', payload }))[0]!
      await mutate({
        id:
          condition === 'disabled' || condition === 'user-deleted'
            ? login.user.id
            : Number(session.id),
        collection:
          condition === 'disabled' || condition === 'user-deleted' ? 'users' : 'userSessions',
        data:
          condition === 'expired'
            ? { expiresAt: now }
            : condition === 'disabled'
              ? { status: 'disabled' }
              : { deletedAt: now, deletedBy: 'system:fixture', isDeleted: true },
        payload,
      })
      expect(await identity.authenticate({ authorization })).toBeNull()
      expect((await payload.auth({ headers: new Headers({ authorization }) })).user).toBeNull()
      await expect(
        identity.updateProfile({ authorization, input: { displayName: 'New' } }),
      ).rejects.toMatchObject({ code: 'AUTH_UNAUTHENTICATED' })
      expect(await identity.logout({ authorization })).toEqual({
        revoked: condition !== 'session-deleted',
      })
      const after = await rows({ collection: 'userSessions', payload })
      const audits = await rows({ collection: 'auditLogs', payload })
      expect(await identity.logout({ authorization })).toEqual({ revoked: false })
      expect(await rows({ collection: 'userSessions', payload })).toEqual(after)
      expect(await rows({ collection: 'auditLogs', payload })).toEqual(audits)
    })
  }

  test('should coordinate profile/logout and never reactivate an account during concurrent disable', async ({
    payload,
  }) => {
    const identity = getCoreRuntime({ payload }).identity
    const login = await identity.login({ input: { code: 'A' } })
    const authorization = `Bearer ${login.token}`
    const results = await Promise.allSettled([
      identity.updateProfile({ authorization, input: { displayName: 'First' } }),
      identity.logout({ authorization }),
    ])
    expect(results[1]!.status).toBe('fulfilled')
    expect(await identity.authenticate({ authorization })).toBeNull()
    const fresh = await identity.login({ input: { code: 'B' } })
    const bearer = `Bearer ${fresh.token}`
    await Promise.allSettled([
      identity.updateProfile({ authorization: bearer, input: { displayName: 'Second' } }),
      mutate({ id: login.user.id, collection: 'users', data: { status: 'disabled' }, payload }),
    ])
    expect((await rows({ collection: 'users', payload }))[0]!.status).toBe('disabled')
    expect(await identity.authenticate({ authorization: bearer })).toBeNull()
  })

  test('should keep Native unique/FK constraints, reject a duplicate session globally, and restore the fixture index', async ({
    payload,
  }) => {
    const identity = getCoreRuntime({ payload }).identity
    const login = await identity.login({ input: { code: 'A' } })
    const client = getCreationSQLiteAdapter({ payload }).client
    const indexes = await client.execute(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='user_sessions' AND sql LIKE '%UNIQUE%' AND sql LIKE '%token_hash%'",
    )
    expect(indexes.rows).toHaveLength(1)
    const index = indexes.rows[0]!
    const columns = (await client.execute("PRAGMA table_info('user_sessions')")).rows
      .filter((row) => row.name !== 'id')
      .map((row) => quote(String(row.name)))
      .join(',')
    const duplicate = `INSERT INTO user_sessions (${columns}) SELECT ${columns} FROM user_sessions LIMIT 1`
    await expect(client.execute(duplicate)).rejects.toBeDefined()
    await client.execute(`DROP INDEX ${quote(String(index.name))}`)
    let duplicateId: number | undefined
    try {
      duplicateId = Number((await client.execute(duplicate)).lastInsertRowid)
      await expect(
        identity.getMe({ authorization: `Bearer ${login.token}` }),
      ).rejects.toMatchObject({ code: 'AUTH_DATA_INTEGRITY_CONFLICT' })
      expect(
        (await payload.auth({ headers: new Headers({ authorization: `Bearer ${login.token}` }) }))
          .user,
      ).toBeNull()
      await expect(
        identity.logout({ authorization: `Bearer ${login.token}` }),
      ).rejects.toMatchObject({ code: 'AUTH_DATA_INTEGRITY_CONFLICT' })
    } finally {
      if (duplicateId !== undefined) {
        await client.execute({ args: [duplicateId], sql: 'DELETE FROM user_sessions WHERE id = ?' })
      }
      await client.execute(String(index.sql))
    }
    expect(await identity.authenticate({ authorization: `Bearer ${login.token}` })).not.toBeNull()
    expect(
      (await client.execute("PRAGMA foreign_key_list('user_sessions')")).rows.length,
    ).toBeGreaterThan(0)
  })

  test('should reject malformed audit and wrong-link session facts without granting Native principals', async ({
    payload,
  }) => {
    const identity = getCoreRuntime({ payload }).identity
    const login = await identity.login({ input: { code: 'A' } })
    const authorization = `Bearer ${login.token}`
    const client = getCreationSQLiteAdapter({ payload }).client
    await client.execute("UPDATE user_sessions SET deleted_by = 'system:orphan'")
    await expect(identity.getMe({ authorization })).rejects.toMatchObject({
      code: 'AUTH_DATA_INTEGRITY_CONFLICT',
    })
    expect((await payload.auth({ headers: new Headers({ authorization }) })).user).toBeNull()
    await client.execute('UPDATE user_sessions SET deleted_by = NULL')
    await client.execute('PRAGMA foreign_keys = OFF')
    try {
      await client.execute('UPDATE user_sessions SET user_id = 999999')
      await expect(identity.logout({ authorization })).rejects.toMatchObject({
        code: 'AUTH_DATA_INTEGRITY_CONFLICT',
      })
      expect((await payload.auth({ headers: new Headers({ authorization }) })).user).toBeNull()
    } finally {
      await client.execute({ args: [login.user.id], sql: 'UPDATE user_sessions SET user_id = ?' })
      await client.execute('PRAGMA foreign_keys = ON')
    }
  })

  test('should refuse raw Native identity writes even with spoofed context/user and isolate new verified owners', async ({
    payload,
  }) => {
    const identity = getCoreRuntime({ payload }).identity
    const one = await identity.login({ input: { code: 'A' } })
    const req = await createPayloadRequest({ payload })
    req.context = { actor: `user:${one.user.id}`, creationWrite: true, trusted: true }
    req.user = { id: one.user.id, collection: 'users' } as never
    await expect(
      payload.update({
        id: one.user.id,
        collection: 'users',
        data: { displayName: 'spoofed' } as never,
        overrideAccess: true,
        req,
      }),
    ).rejects.toThrow(/capability/)
    state.wechatResult = { openId: 'different-verified-owner', unionId: null }
    const other = await identity.login({
      authorization: `Bearer ${one.token}`,
      input: { code: 'B' },
    } as never)
    expect(other.user.id).not.toBe(one.user.id)
    const audit = (await rows({ collection: 'auditLogs', payload })).at(-1)!
    expect(audit.actorType).toBe('system')
    expect(audit.actorId).toBe('wechat-auth')
    for (const authorization of [
      `Bearer ${one.token},${other.token}`,
      `Bearer ${one.token} extra`,
      'Bearer x.y.z',
    ]) {
      expect((await payload.auth({ headers: new Headers({ authorization }) })).user).toBeNull()
    }
    expect(
      payload.config.endpoints
        .filter(({ path }) => path.startsWith('/v1/'))
        .map(({ path }) => path),
    ).toEqual([
      '/v1/health/ready',
      '/v1/auth/wechat',
      '/v1/me',
      '/v1/me',
      '/v1/auth/logout',
      '/v1/templates',
      '/v1/template-taxonomies',
      '/v1/templates/:templateId',
      '/v1/creation-presets/free',
      '/v1/creation-sessions',
      '/v1/creation-sessions',
      '/v1/creation-sessions/:sessionId',
      '/v1/creation-sessions/:sessionId',
      '/v1/creation-sessions/:sessionId/draft',
      '/v1/creation-sessions/:sessionId/draft',
      '/v1/media',
      '/v1/media/:mediaId/content',
      '/v1/media/examples/:mediaId/content',
      '/v1/admin/media/examples',
      '/v1/artifacts',
      '/v1/artifacts/:artifactId',
      '/v1/artifacts/:artifactId/favorite',
      '/v1/artifacts/:artifactId/favorite',
      '/v1/creation-account',
      '/v1/credits/reservations',
      '/v1/credits/ledger',
      '/v1/generation-quotes',
      '/v1/generations',
      '/v1/artifacts/:artifactId/regenerations',
      '/v1/generations/:taskId',
      '/v1/creation-sessions/:sessionId/generations',
      '/v1/session-shares/:key',
      '/v1/session-shares/:key/images/:artifactId',
      '/v1/session-shares/:key/cover',
      '/v1/admin/session-shares',
      '/v1/admin/session-shares/:sessionId',
      '/v1/admin/session-shares/:sessionId',
      '/v1/admin/session-shares/:sessionId/revoke',
      '/v1/admin/session-shares/:sessionId/images/:artifactId',
    ])
  })
})

function service({
  clock = () => now,
  coordinate = createRedisCreationCoordinator({ client: redis.client, config: config.redis })
    .coordinate,
  entropy,
  exchange = async () => ({ openId: 'fixture-open', unionId: null }),
  payload,
  policy = config.identity,
}: {
  clock?: () => string
  coordinate?: CreationCoordinator
  entropy?: () => Uint8Array
  exchange?: WechatCodeExchange
  payload: Payload
  policy?: IdentityPolicy
}) {
  return createPayloadIdentityService({
    clock,
    coordinate,
    entropy,
    exchange: policy.wechat ? exchange : null,
    gate,
    payload,
    policy,
    retry: { backoffMs: 10, maxAttempts: 3 },
  })
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
function quote(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}
async function rows({
  collection,
  payload,
}: {
  collection: string
  payload: Payload
}): Promise<Record<string, unknown>[]> {
  const api = payload as unknown as {
    find: (args: object) => Promise<{ docs: Record<string, unknown>[] }>
  }
  return (
    await api.find({
      collection,
      depth: 0,
      limit: 100,
      overrideAccess: true,
      pagination: false,
      showHiddenFields: true,
      sort: 'id',
    })
  ).docs
}
function mutate({
  id,
  collection,
  data,
  payload,
}: {
  collection: 'users' | 'userSessions'
  data: Record<string, unknown>
  id: number
  payload: Payload
}) {
  return controlledWrite({
    gate,
    payload,
    work: ({ req }) =>
      gate.run({
        req,
        work: () =>
          payload.update({
            id,
            collection,
            data: { ...data, updatedAt: now, updatedBy: 'system:fixture' } as never,
            overrideAccess: true,
            req,
          }),
      }),
  })
}
