import type { Payload, PayloadRequest } from 'payload'

import { createClient } from '@libsql/client'
import { createPayloadRequest } from 'payload'
import { expect, vi } from 'vitest'

import type { CreationCoordinator } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { prepareCreditAccount } from '../../src/creation/application/credits.js'
import {
  createPayloadCreditRepository,
  createPayloadCreditsService,
} from '../../src/creation/infrastructure/payload/credits-repository.js'
import { createCreationRuntime } from '../../src/creation/infrastructure/payload/session-repository.js'
import {
  createSQLiteUnitOfWork,
  getCreationSQLiteAdapter,
} from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createRedisCreationCoordinator } from '../../src/creation/infrastructure/redis/coordinator.js'
import { startRedisFixture } from './redis-fixture.js'
import { cleanupSQLiteFixture, gate, sqliteURL } from './sqlite.config.js'

const NOW = '2026-11-12T12:00:00.000Z'
const NEXT = '2026-11-12T13:00:00.000Z'
const command = {
  grantKey: 'trial-key',
  issuedCredits: 7,
  sourceType: 'trial',
  validFrom: '2026-11-12T11:00:00.000Z',
}

test.suite('Heymoro credit grant foundation', { config: './sqlite.config.ts', cron: false }, () => {
  test.afterAll(() => cleanupSQLiteFixture())
  test.afterEach(() => vi.restoreAllMocks())

  test('registers audited private credit tables without business unique constraints or foreign keys', async ({
    payload,
  }) => {
    const client = getCreationSQLiteAdapter({ payload }).client
    for (const slug of ['credit-accounts', 'credit-grants', 'credit-ledger']) {
      const config = payload.config.collections.find((item) => item.slug === slug)
      expect(config, slug).toBeDefined()
      const table = slug.replaceAll('-', '_')
      const fields = (await client.execute(`PRAGMA table_info(${table})`)).rows
      expect(fields.map((field) => field.name)).toEqual(
        expect.arrayContaining([
          'id',
          'created_at',
          'created_by',
          'updated_at',
          'updated_by',
          'is_deleted',
          'deleted_at',
          'deleted_by',
          'user_id',
        ]),
      )
      expect((await client.execute(`PRAGMA foreign_key_list(${table})`)).rows).toEqual([])
      expect(
        (await client.execute(`PRAGMA index_list(${table})`)).rows.every((row) => row.unique === 0),
      ).toBe(true)
      expect(
        await config!.access.admin!({ slug, req: await createPayloadRequest({ payload }) }),
      ).toBe(false)
      if (table === 'credit_grants') {
        const indexes = (await client.execute(`PRAGMA index_list(${table})`)).rows
        const indexedColumns = await Promise.all(
          indexes.map(async (index) =>
            (await client.execute(`PRAGMA index_info(${String(index.name)})`)).rows.map(
              (column) => column.name,
            ),
          ),
        )
        expect(indexedColumns).toContainEqual(['user_id'])
      }
    }
  })
  test('issues an audited real grant atomically and replays the same globally keyed issuance', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    const observed = vi.fn<(resource: string) => void>()
    const coordinate: CreationCoordinator = async ({ resource, work }) => {
      observed(resource)
      return work({ assertLease: () => {} })
    }
    const service = creditsService({ coordinate, payload })
    const created = await service.issueGrant({ command, userId })
    expect(created).toEqual({
      balance: { available: 7, reserved: 0, sources: [{ available: 7, sourceType: 'trial' }] },
      grantId: expect.any(Number),
      isNew: true,
    })
    expect(await service.issueGrant({ command, userId })).toEqual({ ...created, isNew: false })
    expect(observed.mock.calls.map(([resource]) => resource)).toEqual([
      `wallet:${userId}`,
      `wallet:${userId}`,
    ])
    const [account] = await rows({ payload, table: 'credit_accounts' })
    const [grant] = await rows({ payload, table: 'credit_grants' })
    const [ledger] = await rows({ payload, table: 'credit_ledger' })
    expect(account).toMatchObject({
      available_credits: 7,
      created_by: 'system:credits-fixture',
      reserved_credits: 0,
      user_id: userId,
    })
    expect(grant).toMatchObject({
      account_id: account!.id,
      available_credits: 7,
      grant_key: command.grantKey,
      issued_credits: 7,
      source_id: null,
      user_id: userId,
      valid_from: command.validFrom,
    })
    expect(ledger).toMatchObject({
      account_id: account!.id,
      amount_credits: 7,
      available_delta: 7,
      expired_delta: 0,
      grant_id: grant!.id,
      is_deleted: 0,
      operation: 'grant',
      reserved_delta: 0,
      user_id: userId,
    })
    expect(await rows({ payload, table: 'credit_ledger' })).toHaveLength(1)
    expect(JSON.stringify(created.balance)).not.toMatch(
      /grantKey|sourceId|createdBy|system:|trial-key/,
    )
  })

  test('keeps compensation as a real positive compensate issuance, not a separate balance', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    const result = await creditsService({ actor: 'admin:12', payload }).issueGrant({
      command: { ...command, sourceId: 'approved-case-1', sourceType: 'compensation' },
      userId,
    })
    expect(result.balance.sources).toEqual([{ available: 7, sourceType: 'compensation' }])
    expect((await rows({ payload, table: 'credit_ledger' }))[0]).toMatchObject({
      available_delta: 7,
      created_by: 'admin:12',
      operation: 'compensate',
    })
  })

  const invalidCommands = [
    null,
    [],
    'trial',
    { ...command, actor: 'system:spoof' },
    { ...command, availableCredits: 999 },
    { ...command, grantKey: '   ' },
    { ...command, grantKey: 'x'.repeat(161) },
    { ...command, issuedCredits: 0 },
    { ...command, issuedCredits: 1.5 },
    { ...command, issuedCredits: Number.MAX_SAFE_INTEGER + 1 },
    { ...command, sourceType: 'subscription' },
    { ...command, sourceType: 'topup' },
    { ...command, sourceId: 123 },
    { ...command, expiresAt: 123 },
    { ...command, validFrom: '2026-11-12T11:00:00Z' },
    { ...command, validFrom: '2026-11-12T11:00:00.000+00:00' },
    { ...command, validFrom: '2026-11-12T13:00:00.000Z' },
    { ...command, expiresAt: NOW },
    { ...command, expiresAt: command.validFrom },
  ]
  for (const [index, invalid] of invalidCommands.entries()) {
    test(`rejects invalid grant command ${index} without creating an empty wallet`, async ({
      payload,
    }) => {
      const userId = await activeUser({ payload })
      await expect(
        creditsService({ payload }).issueGrant({ command: invalid, userId }),
      ).rejects.toMatchObject({ code: 'INPUT_INVALID', status: 400 })
      expect(await rows({ payload, table: 'credit_accounts' })).toHaveLength(0)
      expect(await rows({ payload, table: 'credit_grants' })).toHaveLength(0)
      expect(await rows({ payload, table: 'credit_ledger' })).toHaveLength(0)
    })
  }

  test('preserves literal valid keys, permits omitted expiry/source ID, and freezes the host actor', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    const options = { actor: 'system:original', payload }
    const service = creditsService(options)
    options.actor = 'system:changed'
    await service.issueGrant({ command: { ...command, grantKey: '  literal-key  ' }, userId })
    expect((await rows({ payload, table: 'credit_grants' }))[0]).toMatchObject({
      created_by: 'system:original',
      expires_at: null,
      grant_key: '  literal-key  ',
      source_id: null,
    })
    for (const actor of ['user:1', 'admin:0', 'admin:9007199254740992', 'system:', 'anonymous']) {
      expect(() => creditsService({ actor, payload })).toThrow()
    }
  })

  test('requires the target user schema at construction and an active undeleted account for every operation', async ({
    payload,
  }) => {
    const target = Object.create(payload) as Payload
    Object.defineProperty(target, 'collections', {
      value: {
        ...payload.collections,
        users: {
          ...payload.collections.users,
          config: {
            ...payload.collections.users!.config,
            flattenedFields: payload.collections.users!.config.flattenedFields.filter(
              (field) => field.name !== 'isDeleted',
            ),
          },
        },
      },
    })
    const find = vi.spyOn(payload, 'find')
    expect(() => creditsService({ payload: target })).toThrow(/users.*isDeleted checkbox.*schema/)
    expect(find).not.toHaveBeenCalled()
    find.mockRestore()
    const userId = await activeUser({ payload })
    await payload.update({
      id: userId,
      collection: 'users',
      data: { status: 'disabled' },
      overrideAccess: true,
    })
    const service = creditsService({ payload })
    for (const operation of [
      () => service.issueGrant({ command, userId }),
      () => service.expire({ userId }),
      () => service.getBalance({ userId }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 })
    }
    expect(await rows({ payload, table: 'credit_accounts' })).toEqual([])
  })

  test('reads zero without writes or Redis and derives expiring/permanent balances from one captured clock', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    const observed = vi.fn<(resource: string) => void>()
    const coordinate: CreationCoordinator = async ({ resource, work }) => {
      observed(resource)
      return work({ assertLease: () => {} })
    }
    const clock = vi.fn(() => NOW)
    const service = creditsService({ clock, coordinate, payload })
    expect(await service.getBalance({ userId })).toEqual({ available: 0, reserved: 0, sources: [] })
    expect(observed).not.toHaveBeenCalled()
    expect(await rows({ payload, table: 'credit_accounts' })).toEqual([])
    await service.issueGrant({ command: { ...command, expiresAt: NEXT }, userId })
    await service.issueGrant({
      command: { ...command, grantKey: 'permanent', issuedCredits: 3, sourceType: 'compensation' },
      userId,
    })
    const before = await rows({ payload, table: 'credit_grants' })
    observed.mockClear()
    clock.mockReturnValue(NEXT)
    clock.mockClear()
    expect(await service.getBalance({ userId })).toEqual({
      available: 3,
      reserved: 0,
      sources: [{ available: 3, sourceType: 'compensation' }],
    })
    expect(clock).toHaveBeenCalledTimes(1)
    expect(observed).not.toHaveBeenCalled()
    expect(await rows({ payload, table: 'credit_grants' })).toEqual(before)
    expect(await rows({ payload, table: 'credit_ledger' })).toHaveLength(2)
  })

  test('expires only available, preserves historical reserved, and replays original issuance after expiry', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    const clock = vi.fn(() => NOW)
    const service = creditsService({ clock, payload })
    const input = { ...command, expiresAt: NEXT }
    const issued = await service.issueGrant({ command: input, userId })
    // Explicit historical metadata fixture, not an implementation of reservation.
    await execute({
      payload,
      sql: 'UPDATE credit_grants SET available_credits = 3, reserved_credits = 4',
    })
    clock.mockReturnValue(NEXT)
    expect(await service.getBalance({ userId })).toEqual({ available: 0, reserved: 4, sources: [] })
    expect(await service.expire({ userId })).toEqual({ available: 0, reserved: 4, sources: [] })
    expect(await service.expire({ userId })).toEqual({ available: 0, reserved: 4, sources: [] })
    expect(await service.issueGrant({ command: input, userId })).toEqual({
      balance: { available: 0, reserved: 4, sources: [] },
      grantId: issued.grantId,
      isNew: false,
    })
    expect((await rows({ payload, table: 'credit_grants' }))[0]).toMatchObject({
      available_credits: 0,
      expired_credits: 3,
      reserved_credits: 4,
    })
    expect((await rows({ payload, table: 'credit_accounts' }))[0]).toMatchObject({
      available_credits: 0,
      reserved_credits: 4,
    })
    expect(await rows({ payload, table: 'credit_ledger' })).toHaveLength(2)
    expect((await rows({ payload, table: 'credit_ledger' }))[1]).toMatchObject({
      amount_credits: 3,
      available_delta: -3,
      expired_delta: 3,
      operation: 'expire',
      reserved_delta: 0,
    })
  })

  test('rejects changed or cross-owner global keys without disclosing or creating another wallet', async ({
    payload,
  }) => {
    const first = await activeUser({ payload })
    const second = await activeUser({ payload })
    const service = creditsService({ payload })
    await service.issueGrant({ command, userId: first })
    for (const changed of [
      { ...command, issuedCredits: 8 },
      { ...command, sourceType: 'compensation' },
      { ...command, sourceId: 'new' },
      { ...command, expiresAt: NEXT },
    ]) {
      await expect(service.issueGrant({ command: changed, userId: first })).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
        status: 409,
      })
    }
    await expect(service.issueGrant({ command, userId: second })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    })
    expect(await rows({ payload, table: 'credit_accounts' })).toHaveLength(1)
    expect(await rows({ payload, table: 'credit_ledger' })).toHaveLength(1)
  })

  test('ignores drifted wallet projections on GET and repairs them in the protected write', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    const service = creditsService({ payload })
    await service.issueGrant({ command, userId })
    await execute({
      payload,
      sql: 'UPDATE credit_accounts SET available_credits = 999, reserved_credits = 42',
    })
    expect(await service.getBalance({ userId })).toMatchObject({ available: 7, reserved: 0 })
    expect((await rows({ payload, table: 'credit_accounts' }))[0]!.available_credits).toBe(999)
    await service.expire({ userId })
    expect((await rows({ payload, table: 'credit_accounts' }))[0]).toMatchObject({
      available_credits: 7,
      reserved_credits: 0,
    })
  })

  for (const [name, sql] of [
    [
      'soft-deleted grant',
      "UPDATE credit_grants SET is_deleted = 1, deleted_at = '2026-11-12T12:00:00.000Z', deleted_by = 'system:corruption-fixture'",
    ],
    [
      'soft-deleted wallet',
      "UPDATE credit_accounts SET is_deleted = 1, deleted_at = '2026-11-12T12:00:00.000Z', deleted_by = 'system:corruption-fixture'",
    ],
    ['orphaned grant', 'UPDATE credit_grants SET account_id = account_id + 100'],
    ['invalid batch ID', 'UPDATE credit_grants SET id = 0'],
    ['wrong owner', 'UPDATE credit_grants SET user_id = user_id + 100'],
    ['broken conservation', 'UPDATE credit_grants SET available_credits = available_credits + 1'],
  ]) {
    test(`rejects ${name} as an integrity conflict in both read and write`, async ({ payload }) => {
      const userId = await activeUser({ payload })
      const service = creditsService({ payload })
      await service.issueGrant({ command, userId })
      await execute({ payload, sql: sql! })
      await expect(service.getBalance({ userId })).rejects.toMatchObject({
        code: 'DATA_INTEGRITY_CONFLICT',
        status: 503,
      })
      await expect(service.issueGrant({ command, userId })).rejects.toMatchObject({
        code: name === 'wrong owner' ? 'IDEMPOTENCY_CONFLICT' : 'DATA_INTEGRITY_CONFLICT',
        status: name === 'wrong owner' ? 409 : 503,
      })
      expect(await rows({ payload, table: 'credit_ledger' })).toHaveLength(1)
    })
  }

  for (const table of ['credit_accounts', 'credit_grants']) {
    test(`detects duplicate logical keys in ${table}, including deleted rows`, async ({
      payload,
    }) => {
      const userId = await activeUser({ payload })
      const service = creditsService({ payload })
      await service.issueGrant({ command, userId })
      await duplicateRow({ payload, table })
      await expect(service.getBalance({ userId })).rejects.toMatchObject({
        code: 'DATA_INTEGRITY_CONFLICT',
      })
      await expect(service.issueGrant({ command, userId })).rejects.toMatchObject({
        code: 'DATA_INTEGRITY_CONFLICT',
      })
      expect(await rows({ payload, table: 'credit_ledger' })).toHaveLength(1)
    })
  }

  for (const mutation of [
    'DELETE FROM credit_ledger',
    'UPDATE credit_ledger SET available_delta = 999',
    'UPDATE credit_ledger SET user_id = user_id + 1',
    "UPDATE credit_ledger SET is_deleted = 1, deleted_at = '2026-11-12T12:00:00.000Z', deleted_by = 'system:corruption-fixture'",
  ]) {
    test(`requires the original issuance ledger for replay: ${mutation}`, async ({ payload }) => {
      const userId = await activeUser({ payload })
      const service = creditsService({ payload })
      await service.issueGrant({ command, userId })
      await execute({ payload, sql: mutation })
      await expect(service.issueGrant({ command, userId })).rejects.toMatchObject({
        code: 'DATA_INTEGRITY_CONFLICT',
        status: 503,
      })
      expect(await rows({ payload, table: 'credit_grants' })).toHaveLength(1)
    })
  }

  test('detects duplicate global event keys instead of appending around a corrupt ledger', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    const service = creditsService({ payload })
    await service.issueGrant({ command, userId })
    await duplicateRow({ payload, table: 'credit_ledger' })
    await expect(service.issueGrant({ command, userId })).rejects.toMatchObject({
      code: 'DATA_INTEGRITY_CONFLICT',
    })
    expect(await rows({ payload, table: 'credit_ledger' })).toHaveLength(2)
  })

  test('rejects a prior expire event with resurrected available credits', async ({ payload }) => {
    const userId = await activeUser({ payload })
    const clock = vi.fn(() => NOW)
    const service = creditsService({ clock, payload })
    await service.issueGrant({ command: { ...command, expiresAt: NEXT }, userId })
    clock.mockReturnValue(NEXT)
    await service.expire({ userId })
    await execute({
      payload,
      sql: 'UPDATE credit_grants SET available_credits = 7, expired_credits = 0',
    })
    await expect(service.expire({ userId })).rejects.toMatchObject({
      code: 'DATA_INTEGRITY_CONFLICT',
    })
    expect(await rows({ payload, table: 'credit_ledger' })).toHaveLength(2)
  })

  test('enforces field integers, grant conservation and immutable identities even inside a legal write gate', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    await creditsService({ payload }).issueGrant({ command, userId })
    const [account] = await rows({ payload, table: 'credit_accounts' })
    const [grant] = await rows({ payload, table: 'credit_grants' })
    for (const [collection, id, data] of [
      ['credit-accounts', account!.id, { userId: userId + 1 }],
      ['credit-accounts', account!.id, { availableCredits: 1.5 }],
      ['credit-grants', grant!.id, { grantKey: 'replacement' }],
      ['credit-grants', grant!.id, { sourceType: 'compensation' }],
      ['credit-grants', grant!.id, { sourceId: 'replacement' }],
      ['credit-grants', grant!.id, { issuedCredits: 8 }],
      ['credit-grants', grant!.id, { validFrom: NOW }],
      ['credit-grants', grant!.id, { expiresAt: NEXT }],
      ['credit-grants', grant!.id, { availableCredits: 6 }],
      ['credit-grants', grant!.id, { availableCredits: -1, reservedCredits: 8 }],
      [
        'credit-grants',
        grant!.id,
        { availableCredits: Number.MAX_SAFE_INTEGER, reservedCredits: 1 },
      ],
    ] as const) {
      await expect(
        fixtureWrite({
          payload,
          work: ({ req, runtime }) =>
            runtime.update({
              id: Number(id),
              collection,
              data: { ...data, updatedBy: 'system:credits-fixture' },
              req,
            }),
        }),
      ).rejects.toThrow()
    }
    expect((await rows({ payload, table: 'credit_grants' }))[0]!.available_credits).toBe(7)
  })

  test('keeps ledger append-only for updates, soft deletes and physical deletes even with a legal gate', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    await creditsService({ payload }).issueGrant({ command, userId })
    const [entry] = await rows({ payload, table: 'credit_ledger' })
    for (const data of [
      { availableDelta: 8 },
      { deletedAt: NOW, deletedBy: 'system:credits-fixture', isDeleted: true },
      { updatedBy: 'system:credits-fixture' },
    ]) {
      await expect(
        fixtureWrite({
          payload,
          work: ({ req, runtime }) =>
            runtime.update({
              id: Number(entry!.id),
              collection: 'credit-ledger',
              data: { ...data, updatedBy: 'system:credits-fixture' },
              req,
            }),
        }),
      ).rejects.toThrow(/append-only/)
    }
    await expect(
      fixtureWrite({
        payload,
        work: ({ req }) =>
          gate.run({
            req,
            work: () =>
              payload.delete({
                id: Number(entry!.id),
                collection: 'credit-ledger' as never,
                overrideAccess: true,
                req,
              }),
          }),
      }),
    ).rejects.toThrow(/deletion.*forbidden/)
    expect(await rows({ payload, table: 'credit_ledger' })).toHaveLength(1)
    await expect(
      payload.create({
        collection: 'credit-ledger' as never,
        data: entry as never,
        overrideAccess: true,
      }),
    ).rejects.toThrow()
  })

  test('rolls back account, grant and ledger if the real projection update fails after the append', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    await execute({
      payload,
      sql: "CREATE TRIGGER credit_projection_failure BEFORE UPDATE ON credit_accounts BEGIN SELECT RAISE(ABORT, 'fixture projection failure'); END",
    })
    try {
      await expect(creditsService({ payload }).issueGrant({ command, userId })).rejects.toThrow()
      for (const table of ['credit_accounts', 'credit_grants', 'credit_ledger']) {
        expect(await rows({ payload, table })).toEqual([])
      }
    } finally {
      await execute({ payload, sql: 'DROP TRIGGER credit_projection_failure' })
    }
  })

  test('rolls back expiry, its appended ledger and the new grant together on a later SQL failure', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    await creditsService({ payload }).issueGrant({
      command: { ...command, expiresAt: NEXT },
      userId,
    })
    const beforeGrants = await rows({ payload, table: 'credit_grants' })
    const beforeLedger = await rows({ payload, table: 'credit_ledger' })
    await execute({
      payload,
      sql: "CREATE TRIGGER credit_issuance_failure BEFORE INSERT ON credit_grants BEGIN SELECT RAISE(ABORT, 'fixture grant failure'); END",
    })
    try {
      await expect(
        creditsService({ clock: () => NEXT, payload }).issueGrant({
          command: { ...command, grantKey: 'later' },
          userId,
        }),
      ).rejects.toThrow()
      expect(await rows({ payload, table: 'credit_grants' })).toEqual(beforeGrants)
      expect(await rows({ payload, table: 'credit_ledger' })).toEqual(beforeLedger)
      expect((await rows({ payload, table: 'credit_accounts' }))[0]!.available_credits).toBe(7)
    } finally {
      await execute({ payload, sql: 'DROP TRIGGER credit_issuance_failure' })
    }
  })

  test('reuses transaction-bound preparation without nested wallet coordination or exposing the request', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    await creditsService({ payload }).issueGrant({
      command: { ...command, expiresAt: NEXT },
      userId,
    })
    const observed = vi.fn<(resource: string) => void>()
    const coordinate: CreationCoordinator = async ({ resource, work }) => {
      observed(resource)
      return work({ assertLease: () => {} })
    }
    const run = createSQLiteUnitOfWork({
      coordinate,
      gate,
      payload,
      retry: { backoffMs: 0, maxAttempts: 1 },
    })
    const state = await run({
      resource: `wallet:${userId}`,
      work: ({ req }) =>
        prepareCreditAccount({
          actor: 'system:t1-fixture',
          now: NEXT,
          repository: createPayloadCreditRepository({ gate, payload, req }),
          userId,
        }),
    })
    expect(state.balance.available).toBe(0)
    expect(observed).toHaveBeenCalledTimes(1)
    expect(Object.keys(state)).not.toContain('req')
    expect((await rows({ payload, table: 'credit_ledger' }))[1]!.created_by).toBe(
      'system:t1-fixture',
    )
  })

  test('reads beyond one grant page and checks overflow rather than truncating a wallet', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    const service = creditsService({ payload })
    await service.issueGrant({ command: { ...command, issuedCredits: 1 }, userId })
    const client = getCreationSQLiteAdapter({ payload }).client
    const columns = (await client.execute('PRAGMA table_info(credit_grants)')).rows
      .map((row) => String(row.name))
      .filter((name) => name !== 'id')
    const select = columns
      .map((column) => (column === 'grant_key' ? "'page-' || n" : column))
      .join(', ')
    const id = Number((await rows({ payload, table: 'credit_grants' }))[0]!.id)
    await client.execute(
      `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 130) INSERT INTO credit_grants (${columns.join(', ')}) SELECT ${select} FROM credit_grants CROSS JOIN sequence WHERE credit_grants.id = ${id}`,
    )
    const find = vi.spyOn(payload, 'find')
    expect(await service.getBalance({ userId })).toMatchObject({ available: 131 })
    const grantQueries = find.mock.calls.filter(
      ([args]) => String(args.collection) === 'credit-grants',
    )
    expect(grantQueries).toHaveLength(4)
    find.mockRestore()
    await execute({
      payload,
      sql: `UPDATE credit_grants SET issued_credits = ${Number.MAX_SAFE_INTEGER}, available_credits = ${Number.MAX_SAFE_INTEGER} WHERE id = ${id}`,
    })
    await expect(service.getBalance({ userId })).rejects.toMatchObject({
      code: 'DATA_INTEGRITY_CONFLICT',
    })
  })

  test('keeps balance within one real SQLite read snapshot across concurrent committed changes', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    const service = creditsService({ payload })
    await service.issueGrant({ command, userId })
    const other = createClient({ url: sqliteURL })
    const originalFind = payload.find.bind(payload)
    let hasChanged = false
    const spy = vi.spyOn(payload, 'find').mockImplementation(async (args) => {
      const result = await originalFind(args)
      if (!hasChanged && String(args.collection) === 'credit-accounts') {
        hasChanged = true
        await other.execute('UPDATE credit_grants SET available_credits = 0, consumed_credits = 7')
      }
      return result
    })
    try {
      expect(await service.getBalance({ userId })).toMatchObject({ available: 7 })
      spy.mockRestore()
      expect(await service.getBalance({ userId })).toMatchObject({ available: 0 })
    } finally {
      other.close()
    }
  })

  test('captures write time only after wallet acquisition, rejecting grants that expire while waiting', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    const clock = vi.fn(() => NOW)
    const coordinate: CreationCoordinator = async ({ work }) => {
      clock.mockReturnValue(NEXT)
      return work({ assertLease: () => {} })
    }
    await expect(
      creditsService({ clock, coordinate, payload }).issueGrant({
        command: { ...command, expiresAt: NEXT },
        userId,
      }),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
    expect(clock).toHaveBeenCalledTimes(1)
    for (const table of ['credit_accounts', 'credit_grants', 'credit_ledger']) {
      expect(await rows({ payload, table })).toEqual([])
    }
  })

  test('prepares expiry at the acquired wallet time and captures GET time inside its snapshot', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    const clock = vi.fn(() => NOW)
    await creditsService({ clock, payload }).issueGrant({
      command: { ...command, expiresAt: NEXT },
      userId,
    })
    const client = getCreationSQLiteAdapter({ payload }).client
    const originalTransaction = client.transaction.bind(client)
    const spy = vi.spyOn(client, 'transaction').mockImplementation(async (...args) => {
      const transaction = await originalTransaction(...args)
      clock.mockReturnValue(NEXT)
      return transaction
    })
    clock.mockClear()
    expect((await creditsService({ clock, payload }).getBalance({ userId })).available).toBe(0)
    expect(clock).toHaveBeenCalledTimes(1)
    spy.mockRestore()
    clock.mockReturnValue(NOW)
    const coordinate: CreationCoordinator = async ({ work }) => {
      clock.mockReturnValue(NEXT)
      return work({ assertLease: () => {} })
    }
    expect(
      (await creditsService({ clock, coordinate, payload }).expire({ userId })).available,
    ).toBe(0)
    expect((await rows({ payload, table: 'credit_grants' }))[0]!.expired_credits).toBe(7)
  })

  test('serializes real Redis same-wallet grants and rolls back every partial write after lease loss', async ({
    payload,
  }) => {
    const userId = await activeUser({ payload })
    const redis = await startRedisFixture()
    try {
      const coordinate = createRedisCreationCoordinator({
        client: redis.client,
        config: {
          acquireTimeoutMs: 3000,
          commandTimeoutMs: 200,
          leaseMs: 800,
          maxHoldMs: 5000,
          namespace: 'credit-wallet-fixture',
          renewEveryMs: 100,
          retryDelayMs: 10,
        },
      }).coordinate
      const service = creditsService({ coordinate, payload })
      const results = await Promise.all([
        service.issueGrant({ command, userId }),
        service.issueGrant({ command, userId }),
        service.issueGrant({ command, userId }),
      ])
      expect(results.filter((result) => result.isNew)).toHaveLength(1)
      expect(await rows({ payload, table: 'credit_grants' })).toHaveLength(1)
      expect(await rows({ payload, table: 'credit_ledger' })).toHaveLength(1)
      const originalCreate = payload.create.bind(payload)
      const spy = vi.spyOn(payload, 'create').mockImplementation(async (args) => {
        const result = await originalCreate(args)
        if (String(args.collection) === 'credit-ledger') {
          const [key] = await redis.client.keys('credit-wallet-fixture:*')
          expect(key).toBeDefined()
          await redis.client.set(key!, 'replacement-owner', 'PX', 3000)
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
        return result
      })
      await expect(
        service.issueGrant({ command: { ...command, grantKey: 'lost-lease' }, userId }),
      ).rejects.toMatchObject({ code: 'COORDINATION_UNAVAILABLE' })
      spy.mockRestore()
      expect(await rows({ payload, table: 'credit_grants' })).toHaveLength(1)
      expect(await rows({ payload, table: 'credit_ledger' })).toHaveLength(1)
      expect((await service.getBalance({ userId })).available).toBe(7)
    } finally {
      await redis.stop()
    }
  })

  test('rechecks the global key after real cross-wallet SQLite busy rollback without a unique index', async ({
    payload,
  }) => {
    const first = await activeUser({ payload })
    const second = await activeUser({ payload })
    let arrivals = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalFind = payload.find.bind(payload)
    const spy = vi.spyOn(payload, 'find').mockImplementation(async (args) => {
      const result = await originalFind(args)
      if (
        String(args.collection) === 'credit-grants' &&
        JSON.stringify(args.where) === JSON.stringify({ grantKey: { equals: command.grantKey } }) &&
        result.docs.length === 0 &&
        arrivals < 2
      ) {
        arrivals++
        if (arrivals === 2) {
          release()
        }
        await barrier
      }
      return result
    })
    const client = getCreationSQLiteAdapter({ payload }).client
    const originalTransaction = client.transaction.bind(client)
    const rollbacks: ReturnType<typeof vi.spyOn>[] = []
    const transactions = vi.spyOn(client, 'transaction').mockImplementation(async (...args) => {
      const transaction = await originalTransaction(...args)
      rollbacks.push(vi.spyOn(transaction, 'rollback'))
      return transaction
    })
    const results = await Promise.allSettled([
      creditsService({ payload }).issueGrant({ command, userId: first }),
      creditsService({ payload }).issueGrant({ command, userId: second }),
    ])
    expect(arrivals).toBe(2)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'IDEMPOTENCY_CONFLICT' },
    })
    expect(rollbacks.some((rollback) => rollback.mock.calls.length > 0)).toBe(true)
    expect(transactions.mock.calls.length).toBeGreaterThanOrEqual(3)
    spy.mockRestore()
    expect(await rows({ payload, table: 'credit_accounts' })).toHaveLength(1)
    expect(await rows({ payload, table: 'credit_grants' })).toHaveLength(1)
    expect(await rows({ payload, table: 'credit_ledger' })).toHaveLength(1)
  })
})

function creditsService({
  payload,
  ...options
}: { payload: Payload } & Partial<Parameters<typeof createPayloadCreditsService>[0]>) {
  return createPayloadCreditsService({
    actor: 'system:credits-fixture',
    clock: () => NOW,
    coordinate: async ({ work }) => work({ assertLease: () => {} }),
    gate,
    payload,
    retry: { backoffMs: 1, maxAttempts: 3 },
    ...options,
  })
}
async function activeUser({ payload }: { payload: Payload }) {
  return Number(
    (
      await payload.create({
        collection: 'users',
        overrideAccess: true,
        // Isolated fixture schema differs from the generated legacy User type.
        data: { isDeleted: false, status: 'active' } as never,
      })
    ).id,
  )
}
async function rows({ payload, table }: { payload: Payload; table: string }) {
  return (
    await getCreationSQLiteAdapter({ payload }).client.execute(`SELECT * FROM ${table} ORDER BY id`)
  ).rows
}
async function execute({ payload, sql }: { payload: Payload; sql: string }) {
  return getCreationSQLiteAdapter({ payload }).client.execute(sql)
}

function fixtureWrite<T>({
  payload,
  work,
}: {
  payload: Payload
  work: (args: {
    req: PayloadRequest
    runtime: ReturnType<typeof createCreationRuntime>
  }) => Promise<T>
}) {
  const runtime = createCreationRuntime({ gate, payload })
  return createSQLiteUnitOfWork({
    coordinate: async ({ work }) => work({ assertLease: () => {} }),
    gate,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  })({ resource: 'credits-schema-fixture', work: ({ req }) => work({ req, runtime }) })
}
async function duplicateRow({ payload, table }: { payload: Payload; table: string }) {
  const client = getCreationSQLiteAdapter({ payload }).client
  const columns = (await client.execute(`PRAGMA table_info(${table})`)).rows
    .map((row) => String(row.name))
    .filter((name) => name !== 'id')
    .join(', ')
  await client.execute(`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table} LIMIT 1`)
}
