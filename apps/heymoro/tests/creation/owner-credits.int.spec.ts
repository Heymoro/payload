import { createClient } from '@libsql/client'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createPayloadCreditsService } from '../../src/creation/infrastructure/payload/credits-repository.js'
import {
  createOwnerCreditReader,
  createPayloadOwnerCredits,
} from '../../src/creation/infrastructure/payload/owner-credits-repository.js'
import { grant, NOW, seed } from './generation-fixture.js'
import { barrier, workerFixture } from './generation-worker-fixture.js'
import { cleanupLibrary, cursorKey, libraryFixture } from './library-fixture.js'
import { cleanupSQLiteFixture, gate, sqliteURL } from './sqlite.config.js'

test.suite('Heymoro owner credits', { config: './sqlite.config.ts', cron: false }, () => {
  test.afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupLibrary()
  })
  test.afterAll(() => cleanupSQLiteFixture())
  test('should return real balances with host configuration without write or network calls', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const readiness = vi.fn(() => false)
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness,
    })
    const writes = [
      vi.spyOn(payload, 'create'),
      vi.spyOn(payload, 'update'),
      vi.spyOn(payload, 'delete'),
    ]
    const redis = vi.spyOn(f.redis.client, 'sendCommand')
    const before = f.http.requests.length
    expect(await service.account({ userId: f.userId })).toEqual({
      available: 5,
      configured: false,
      reserved: 2,
      sources: [{ available: 5, sourceType: 'trial' }],
    })
    expect(readiness).toHaveBeenCalledExactlyOnceWith()
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled()
    }
    expect(redis).not.toHaveBeenCalled()
    expect(f.http.requests).toHaveLength(before)
  })
  test('should return empty account and lists without creating a wallet', async ({ payload }) => {
    const user = await payload.create({
      collection: 'users',
      data: { status: 'active' } as never,
      overrideAccess: true,
    })
    const service = createPayloadOwnerCredits({
      clock: () => NOW,
      cursorKey,
      payload,
      readiness: () => true,
    })
    const find = vi.spyOn(payload, 'find')
    const writes = [
      vi.spyOn(payload, 'create'),
      vi.spyOn(payload, 'update'),
      vi.spyOn(payload, 'delete'),
    ]
    expect(await service.account({ userId: Number(user.id) })).toEqual({
      available: 0,
      configured: true,
      reserved: 0,
      sources: [],
    })
    for (const method of [service.reservations, service.ledger]) {
      expect(await method({ query: {}, userId: Number(user.id) })).toEqual({
        hasMore: false,
        items: [],
        nextCursor: null,
      })
    }
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled()
    }
    expect(find.mock.calls.some(([args]) => String(args.collection) === 'credit-ledger')).toBe(true)
  })
  test('should exclude expired available but retain reserved without expiry writes', async ({
    payload,
  }) => {
    const f = await workerFixture({
      grants: [{ amount: 7, expiresAt: '2026-11-12T12:01:00.000Z' }],
      payload,
    })
    f.state.now = '2026-11-12T12:02:00.000Z'
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness: () => true,
    })
    expect(await service.account({ userId: f.userId })).toEqual({
      available: 0,
      configured: true,
      reserved: 2,
      sources: [],
    })
    expect((await service.reservations({ query: {}, userId: f.userId })).items).toEqual([
      {
        reservationId: expect.any(Number),
        reservedCredits: 2,
        reviewHint: null,
        roundNo: 1,
        sessionId: f.sessionId,
        taskId: f.taskId,
        taskStatus: 'queued',
      },
    ])
    expect(
      (
        await f.adapter.client.execute(
          "SELECT count(*) AS n FROM credit_ledger WHERE operation='expire'",
        )
      ).rows[0]!.n,
    ).toBe(0)
  })
  for (const outcome of ['capture', 'release', 'expired-release'] as const) {
    test(`should project real ${outcome} and reserve history without double consumption`, async ({
      payload,
    }) => {
      const f = await workerFixture({
        grants: [
          { amount: 1, expiresAt: '2026-11-12T12:01:00.000Z' },
          { amount: 1, expiresAt: null },
        ],
        payload,
      })
      const service = createPayloadOwnerCredits({
        clock: () => f.state.now,
        cursorKey,
        payload,
        readiness: () => true,
      })
      const before = await service.ledger({ query: {}, userId: f.userId })
      expect(
        before.items
          .filter((row) => 'operation' in row && row.operation === 'reserve')
          .map((row) => row.ledgerDelta),
      ).toEqual([0, 0])
      if (outcome !== 'capture') {
        f.state.engine = async () => ({ kind: 'rejected', requestId: null })
      }
      if (outcome === 'expired-release') {
        f.state.now = '2026-11-12T12:02:00.000Z'
      }
      await f.running.run({ taskId: f.taskId })
      expect((await service.reservations({ query: {}, userId: f.userId })).items).toEqual([])
      const history = await service.ledger({ query: {}, userId: f.userId })
      const events = history.items.filter(
        (row) =>
          'operation' in row && row.operation === (outcome === 'capture' ? 'capture' : 'release'),
      )
      expect(events).toHaveLength(2)
      expect(
        events.reduce((sum, row) => sum + ('ledgerDelta' in row ? row.ledgerDelta : 0), 0),
      ).toBe(outcome === 'capture' ? -2 : outcome === 'expired-release' ? -1 : 0)
      expect(
        history.items.filter((row) => 'operation' in row && row.operation === 'reserve'),
      ).toHaveLength(2)
      expect(
        history.items
          .filter((row) => 'operation' in row && row.operation === 'reserve')
          .every((row) => 'statusCredits' in row && row.statusCredits === 1),
      ).toBe(true)
      const serialized = JSON.stringify(history)
      for (const field of [
        'eventKey',
        'grantKey',
        'sourceId',
        'reasonCode',
        'createdBy',
        'PRIVATE SYSTEM',
        'storageBackend',
      ]) {
        expect(serialized).not.toContain(field)
      }
    })
  }
  test('should read current zero cost and unknown reconciliation plus historical parent tombstones', async ({
    payload,
  }) => {
    const f = await workerFixture({ cost: 0, payload })
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness: () => true,
    })
    const args = { query: {}, userId: f.userId }
    expect((await service.reservations(args)).items[0]).toMatchObject({
      reservedCredits: 0,
      reviewHint: null,
      taskStatus: 'queued',
    })
    f.state.engine = async () => ({ kind: 'unknown', requestId: null })
    await f.running.run({ taskId: f.taskId })
    await f.adapter.client.execute("UPDATE credit_reservations SET status='reconciliation'")
    for (const table of ['generation_tasks', 'creation_sessions']) {
      await f.adapter.client.execute(
        `UPDATE ${table} SET is_deleted=1,deleted_at=created_at,deleted_by=created_by`,
      )
    }
    expect((await service.reservations(args)).items[0]).toMatchObject({
      reservedCredits: 0,
      reviewHint: 'PENDING_REVIEW',
      taskStatus: 'unknown',
    })
    expect((await service.ledger(args)).items).toEqual([])
  })
  test('should strictly validate future and reached reviewAfter using one captured clock', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const clock = vi.fn(() => f.state.now)
    const service = createPayloadOwnerCredits({ clock, cursorKey, payload, readiness: () => true })
    await f.adapter.client.execute(
      "UPDATE credit_reservations SET review_after='2026-11-12T12:01:00.000Z'",
    )
    expect((await service.reservations({ query: {}, userId: f.userId })).items[0]).toMatchObject({
      reviewHint: null,
    })
    f.state.now = '2026-11-12T12:01:00.000Z'
    expect((await service.reservations({ query: {}, userId: f.userId })).items[0]).toMatchObject({
      reviewHint: 'PENDING_REVIEW',
    })
    expect(clock).toHaveBeenCalledTimes(2)
    await f.adapter.client.execute(
      "UPDATE credit_reservations SET review_after='2026-12-99T12:01:00.000Z'",
    )
    // Observe the actual date-decoder failure without converting infrastructure errors into data conflicts.
    const original = payload.find.bind(payload)
    let decodedError: unknown
    vi.spyOn(payload, 'find').mockImplementation(async (args) => {
      try {
        return await original(args)
      } catch (error) {
        decodedError = error
        throw error
      }
    })
    const writes = [
      vi.spyOn(payload, 'create'),
      vi.spyOn(payload, 'update'),
      vi.spyOn(payload, 'delete'),
    ]
    let observed: unknown
    try {
      await service.reservations({ query: {}, userId: f.userId })
    } catch (error) {
      observed = error
    }
    expect(observed).toBeInstanceOf(RangeError)
    expect(observed).toBe(decodedError)
    console.info('T07-C invalid review_after original decoder stack', (observed as Error).stack)
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled()
    }
  })
  test('should paginate independent scopes with equal timestamp ID tie breaker without consuming extra candidate', async ({
    payload,
  }) => {
    const f = await libraryFixture({ count: 3, payload })
    // Three actual admission transactions in independent sessions are still pending.
    for (let i = 0; i < 3; i++) {
      const session = await seed({ cost: 0, payload, userId: f.userId })
      const input = { ...session.input, inputMediaIds: f.mediaIds }
      const quote = await f.admission.quoteGenerate({
        input,
        sessionId: session.sessionId,
        userId: f.userId,
      })
      await f.admission.submitGenerate({
        clientRequestId: `credit-pending-${i}`,
        input,
        quoteToken: quote.quoteToken,
        sessionId: session.sessionId,
        userId: f.userId,
      })
    }
    await grant({ amount: 2, key: 'extra:grant:with:colon', payload, userId: f.userId })
    await grant({ amount: 3, key: 'other:grant', payload, userId: f.userId })
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      pageSize: 1,
      payload,
      readiness: () => true,
    })
    const first = await service.reservations({ query: {}, userId: f.userId })
    const second = await service.reservations({
      query: { cursor: first.nextCursor },
      userId: f.userId,
    })
    const third = await service.reservations({
      query: { cursor: second.nextCursor },
      userId: f.userId,
    })
    expect([
      first.items[0]!.reservationId,
      second.items[0]!.reservationId,
      third.items[0]!.reservationId,
    ]).toEqual(
      [
        ...new Set([
          first.items[0]!.reservationId,
          second.items[0]!.reservationId,
          third.items[0]!.reservationId,
        ]),
      ].sort((a, b) => b - a),
    )
    expect(third.hasMore).toBe(false)
    const ledger = await service.ledger({ query: {}, userId: f.userId })
    const ledgerNext = await service.ledger({
      query: { cursor: ledger.nextCursor },
      userId: f.userId,
    })
    expect(ledger.items[0]!.id).toBeGreaterThan(ledgerNext.items[0]!.id)
    const find = vi.spyOn(payload, 'find')
    for (const method of [service.reservations, service.ledger]) {
      for (const args of [
        {
          query: { cursor: (method === service.ledger ? first : ledger).nextCursor },
          userId: f.userId,
        },
        {
          query: { cursor: (method === service.ledger ? ledger : first).nextCursor },
          userId: f.userId + 999,
        },
        { query: { cursor: first.nextCursor!.slice(0, -2) + 'AA' }, userId: f.userId },
        { query: {}, userId: 0 },
        { query: { x: 1 }, userId: f.userId },
        {
          query: Object.defineProperty({}, 'cursor', {
            enumerable: true,
            get() {
              throw Error('getter')
            },
          }),
          userId: f.userId,
        },
      ]) {
        await expect(method(args)).rejects.toMatchObject({ status: 400 })
      }
    }
    await expect(
      createPayloadOwnerCredits({
        clock: () => f.state.now,
        cursorKey,
        payload,
        readiness: () => true,
      }).reservations({ query: { cursor: first.nextCursor }, userId: f.userId }),
    ).rejects.toMatchObject({ status: 400 })
    expect(find).not.toHaveBeenCalled()
  })
  test('should list only minimal bounded page facts without wallet scan N+1 or network/write capability', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness: () => {
        throw Error('lists never ask readiness')
      },
    })
    const find = vi.spyOn(payload, 'find')
    const redis = vi.spyOn(f.redis.client, 'sendCommand')
    const writes = [
      vi.spyOn(payload, 'create'),
      vi.spyOn(payload, 'update'),
      vi.spyOn(payload, 'delete'),
    ]
    const requests = f.http.requests.length
    for (const method of [service.reservations, service.ledger]) {
      find.mockClear()
      await method({ query: {}, userId: f.userId })
      expect(find.mock.calls.length).toBeLessThanOrEqual(12)
      expect(new Set(find.mock.calls.map(([args]) => args.req)).size).toBe(1)
      for (const [args] of find.mock.calls) {
        expect(
          /draft|template|attempt|artifact|media|audit|payload-jobs/.test(String(args.collection)),
        ).toBe(false)
        expect(() =>
          gate.assert({ req: args.req as Parameters<typeof gate.assert>[0]['req'] }),
        ).toThrow('capability')
        if (String(args.collection) === 'credit-grants') {
          expect(JSON.stringify(args.where)).not.toContain('accountId')
        }
      }
    }
    expect(redis).not.toHaveBeenCalled()
    expect(f.http.requests).toHaveLength(requests)
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled()
    }
  })
  const currentCorruptions = [
    ['wrong reservation owner', 'UPDATE credit_reservations SET user_id=user_id+999'],
    ['wrong reservation account', 'UPDATE credit_reservations SET account_id=account_id+999'],
    ['missing wallet', 'DELETE FROM credit_accounts'],
    ['reserved wallet underflow', 'UPDATE credit_accounts SET reserved_credits=0'],
    ['bad settled time', "UPDATE credit_reservations SET settled_at='2026-11-12T12:00:00.000Z'"],
    ['invalid queued reconciliation', "UPDATE credit_reservations SET status='reconciliation'"],
    ['bad reservation key', "UPDATE credit_reservations SET reservation_key='wrong'"],
    ['wrong reservation cost', 'UPDATE credit_reservations SET amount_credits=1'],
    ['missing task', 'DELETE FROM generation_tasks'],
    ['missing parent', 'DELETE FROM creation_sessions'],
    ['wrong parent', 'UPDATE creation_sessions SET user_id=user_id+999'],
    ['wrong template', 'UPDATE generation_tasks SET template_id=template_id+999'],
    ['bad snapshot', "UPDATE generation_tasks SET execution_snapshot_json='{}'"],
    ['missing allocations', 'DELETE FROM credit_allocations'],
    ['bad allocation amount', 'UPDATE credit_allocations SET amount_credits=1'],
    ['bad allocation state', "UPDATE credit_allocations SET status='captured'"],
    ['wrong grant owner', 'UPDATE credit_grants SET user_id=user_id+999'],
    ['wrong grant account', 'UPDATE credit_grants SET account_id=account_id+999'],
    [
      'grant reserved underflow',
      'UPDATE credit_grants SET reserved_credits=0,available_credits=issued_credits',
    ],
    ['missing reserve', "DELETE FROM credit_ledger WHERE operation='reserve'"],
    [
      'wrong reserve association',
      "UPDATE credit_ledger SET reservation_id=reservation_id+999 WHERE operation='reserve'",
    ],
    ['wrong reserve delta', "UPDATE credit_ledger SET consumed_delta=1 WHERE operation='reserve'"],
    [
      'wrong reserve reason',
      "UPDATE credit_ledger SET reason_code='WRONG' WHERE operation='reserve'",
    ],
  ] as const
  for (const [name, sql] of currentCorruptions) {
    test(`should reject current ${name}`, async ({ payload }) => {
      const f = await workerFixture({ payload })
      await f.adapter.client.execute(sql)
      await expect(
        createPayloadOwnerCredits({
          clock: () => f.state.now,
          cursorKey,
          payload,
          readiness: () => true,
        }).reservations({ query: {}, userId: f.userId }),
      ).rejects.toMatchObject({ status: 503 })
    })
  }
  for (const table of [
    'credit_accounts',
    'credit_reservations',
    'credit_allocations',
    'credit_grants',
    'credit_ledger',
  ]) {
    test(`should reject financial tombstones ${table}`, async ({ payload }) => {
      const f = await workerFixture({ payload })
      await f.adapter.client.execute(
        `UPDATE ${table} SET is_deleted=1,deleted_at=created_at,deleted_by=created_by`,
      )
      await expect(
        createPayloadOwnerCredits({
          clock: () => f.state.now,
          cursorKey,
          payload,
          readiness: () => true,
        }).reservations({ query: {}, userId: f.userId }),
      ).rejects.toMatchObject({ status: 503 })
    })
  }
  const ledgerCorruptions = [
    [
      'grant issued amount and delta forged together',
      "UPDATE credit_ledger SET amount_credits=6,available_delta=6 WHERE operation='grant'",
    ],
    ['unsupported revoke', "UPDATE credit_ledger SET operation='revoke' WHERE operation='grant'"],
    ['bad event key', "UPDATE credit_ledger SET event_key='wrong' WHERE operation='grant'"],
    [
      'bad event time',
      "UPDATE credit_ledger SET created_at='2026-11-12T10:59:59.999Z' WHERE operation='grant'",
    ],
    [
      'bad event amount zero',
      "UPDATE credit_ledger SET amount_credits=0,available_delta=0 WHERE operation='grant'",
    ],
    ['wrong event owner', 'UPDATE credit_ledger SET user_id=user_id+999'],
    ['wrong event account', 'UPDATE credit_ledger SET account_id=account_id+999'],
    ['missing grant', 'DELETE FROM credit_grants'],
    ['missing reservation', 'DELETE FROM credit_reservations'],
    ['missing allocation', 'DELETE FROM credit_allocations'],
    ['wrong historical allocation status', "UPDATE credit_allocations SET status='released'"],
  ] as const
  for (const [name, sql] of ledgerCorruptions) {
    test(`should reject history ${name}`, async ({ payload }) => {
      const f = await workerFixture({ payload })
      await f.adapter.client.execute(sql)
      await expect(
        createPayloadOwnerCredits({
          clock: () => f.state.now,
          cursorKey,
          payload,
          readiness: () => true,
        }).ledger({ query: {}, userId: f.userId }),
      ).rejects.toMatchObject({ status: 503 })
    })
  }
  test('should preserve original Error and AggregateError identity through snapshot and reader', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness: () => true,
    })
    for (const error of [
      new Error('fixture transport'),
      new AggregateError([new Error('fixture DB')]),
    ]) {
      vi.spyOn(payload, 'find').mockRejectedValue(error)
      for (const operation of [
        () => service.account({ userId: f.userId }),
        () => service.reservations({ query: {}, userId: f.userId }),
        () => service.ledger({ query: {}, userId: f.userId }),
      ]) {
        await expect(operation()).rejects.toBe(error)
      }
      vi.restoreAllMocks()
      await expect(
        createOwnerCreditReader({
          find: async () => {
            throw error
          },
        }).grants({ ids: [1] }),
      ).rejects.toBe(error)
    }
  })
  test('should reject missing invalid readiness at construction and non boolean on each account', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const find = vi.spyOn(payload, 'find')
    const transaction = vi.spyOn(f.adapter.client, 'transaction')
    for (const readiness of [undefined, null, true]) {
      expect(() =>
        createPayloadOwnerCredits({
          clock: () => f.state.now,
          cursorKey,
          payload,
          readiness: readiness as never,
        }),
      ).toThrow()
    }
    for (const pageSize of [0, 51, 1.2]) {
      expect(() =>
        createPayloadOwnerCredits({
          clock: () => f.state.now,
          cursorKey,
          pageSize,
          payload,
          readiness: () => true,
        }),
      ).toThrow()
    }
    expect(find).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
    for (const result of [Promise.resolve(true), 1, 'true', null]) {
      await expect(
        createPayloadOwnerCredits({
          clock: () => f.state.now,
          cursorKey,
          payload,
          readiness: (() => result) as never,
        }).account({ userId: f.userId }),
      ).rejects.toThrow('synchronously return a boolean')
    }
  })
  test('should hold one read snapshot under second SQLite connection mutation', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const other = createClient({ url: sqliteURL })
    const original = payload.find.bind(payload)
    let changed = false
    vi.spyOn(payload, 'find').mockImplementation(async (args) => {
      const result = await original(args)
      if (!changed && String(args.collection) === 'credit-reservations') {
        changed = true
        await other.execute('UPDATE credit_allocations SET amount_credits=1')
      }
      return result
    })
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness: () => true,
    })
    try {
      expect((await service.reservations({ query: {}, userId: f.userId })).items).toHaveLength(1)
      await expect(service.reservations({ query: {}, userId: f.userId })).rejects.toMatchObject({
        status: 503,
      })
    } finally {
      other.close()
    }
  })
  test('should support 131 real grants across original 128 page boundary and batched used grant identities', async ({
    payload,
  }) => {
    const f = await workerFixture({
      cost: 131,
      grants: Array.from({ length: 131 }, () => ({ amount: 1, expiresAt: null })),
      payload,
    })
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness: () => true,
    })
    const find = vi.spyOn(payload, 'find')
    expect(await service.account({ userId: f.userId })).toEqual({
      available: 0,
      configured: true,
      reserved: 131,
      sources: [],
    })
    expect(
      find.mock.calls.filter(
        ([args]) => String(args.collection) === 'credit-grants' && args.sort === 'id',
      ),
    ).toHaveLength(2)
    find.mockClear()
    expect((await service.reservations({ query: {}, userId: f.userId })).items[0]).toMatchObject({
      reservedCredits: 131,
    })
    expect(find.mock.calls.length).toBeLessThanOrEqual(13)
    expect(
      find.mock.calls.filter(([args]) => String(args.collection) === 'credit-grants'),
    ).toHaveLength(4)
    const original = payload.find.bind(payload)
    find.mockRestore()
    vi.spyOn(payload, 'find').mockImplementation(async (args) => {
      const result = await original(args)
      return String(args.collection) === 'credit-grants' && args.sort === 'id'
        ? { ...result, docs: result.docs.slice(0, 127) }
        : result
    })
    await expect(service.account({ userId: f.userId })).rejects.toMatchObject({ status: 503 })
  })
  test('should validate selected reservation totals against account and grant without a whole wallet audit', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const next = await seed({ cost: 2, payload, userId: f.userId })
    const input = { ...next.input, inputMediaIds: f.mediaIds }
    const quote = await f.admission.quoteGenerate({
      input,
      sessionId: next.sessionId,
      userId: f.userId,
    })
    await f.admission.submitGenerate({
      clientRequestId: 'two-reservation-total',
      input,
      quoteToken: quote.quoteToken,
      sessionId: next.sessionId,
      userId: f.userId,
    })
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness: () => true,
    })
    expect((await service.reservations({ query: {}, userId: f.userId })).items).toHaveLength(2)
    await f.adapter.client.execute('UPDATE credit_accounts SET reserved_credits=3')
    await expect(service.reservations({ query: {}, userId: f.userId })).rejects.toMatchObject({
      status: 503,
    })
    await f.adapter.client.execute('UPDATE credit_accounts SET reserved_credits=4')
    await f.adapter.client.execute(
      'UPDATE credit_grants SET reserved_credits=3, available_credits=4',
    )
    await expect(service.reservations({ query: {}, userId: f.userId })).rejects.toMatchObject({
      status: 503,
    })
  })
  test('should return current running state through actual worker without decoding attempts', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const wait = barrier()
    f.state.engine = async () => {
      wait.enter()
      await wait.released
      return { kind: 'unknown', requestId: null }
    }
    const running = f.running.run({ taskId: f.taskId })
    await wait.entered
    try {
      const result = await createPayloadOwnerCredits({
        clock: () => f.state.now,
        cursorKey,
        payload,
        readiness: () => true,
      }).reservations({ query: {}, userId: f.userId })
      expect(result.items[0]).toMatchObject({ reviewHint: null, taskStatus: 'running' })
    } finally {
      wait.release()
      await running
    }
  })
  test('should derive source from real compensation and trial batches and read actual expiry event', async ({
    payload,
  }) => {
    const f = await workerFixture({ cost: 0, payload })
    await grant({
      amount: 2,
      expiresAt: '2026-11-12T12:01:00.000Z',
      key: 'trial:expiry',
      payload,
      userId: f.userId,
    })
    const credits = createPayloadCreditsService({
      actor: 'system:credit-fixture',
      clock: () => f.state.now,
      coordinate: async ({ work }) => work({ assertLease: () => {} }),
      gate,
      payload,
      retry: { backoffMs: 0, maxAttempts: 1 },
    })
    await credits.issueGrant({
      command: {
        expiresAt: null,
        grantKey: 'comp:with:colon',
        issuedCredits: 3,
        sourceId: null,
        sourceType: 'compensation',
        validFrom: NOW,
      },
      userId: f.userId,
    })
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness: () => true,
    })
    expect((await service.account({ userId: f.userId })).sources).toEqual([
      { available: 3, sourceType: 'compensation' },
      { available: 2, sourceType: 'trial' },
    ])
    f.state.now = '2026-11-12T12:02:00.000Z'
    await credits.expire({ userId: f.userId })
    const rows = (await service.ledger({ query: {}, userId: f.userId })).items
    expect(rows.find((row) => row.operation === 'expire')).toMatchObject({
      expiredDelta: 2,
      ledgerDelta: -2,
      sourceType: 'trial',
      statusCredits: null,
    })
    expect(rows.find((row) => row.operation === 'compensate')).toMatchObject({
      ledgerDelta: 3,
      sourceType: 'compensation',
    })
    await f.adapter.client.execute(
      "UPDATE credit_grants SET expires_at=NULL WHERE grant_key='trial:expiry'",
    )
    await expect(service.ledger({ query: {}, userId: f.userId })).rejects.toMatchObject({
      status: 503,
    })
  })
  test('should reject expiry amount above issued even with mathematically consistent forged delta', async ({
    payload,
  }) => {
    const f = await workerFixture({ cost: 0, payload })
    await grant({
      amount: 2,
      expiresAt: '2026-11-12T12:01:00.000Z',
      key: 'expire-limit',
      payload,
      userId: f.userId,
    })
    f.state.now = '2026-11-12T12:02:00.000Z'
    await createPayloadCreditsService({
      actor: 'system:fixture',
      clock: () => f.state.now,
      coordinate: async ({ work }) => work({ assertLease: () => {} }),
      gate,
      payload,
      retry: { backoffMs: 0, maxAttempts: 1 },
    }).expire({ userId: f.userId })
    await f.adapter.client.execute(
      "UPDATE credit_ledger SET amount_credits=3,available_delta=-3,expired_delta=3 WHERE operation='expire'",
    )
    await expect(
      createPayloadOwnerCredits({
        clock: () => f.state.now,
        cursorKey,
        payload,
        readiness: () => true,
      }).ledger({ query: {}, userId: f.userId }),
    ).rejects.toMatchObject({ status: 503 })
  })
  for (const [table, override] of [
    ['credit_reservations', 'task_id+999 AS task_id'],
    ['credit_allocations', 'grant_id'],
    ['credit_grants', 'account_id+999 AS account_id'],
    ['credit_ledger', 'reservation_id+999 AS reservation_id'],
  ]) {
    test(`should expose globally duplicated deleted foreign ${table} candidates`, async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      const fields = (await f.adapter.client.execute(`PRAGMA table_info("${table}")`)).rows
        .map((row) => String(row.name))
        .filter((field) => field !== 'id')
      const overrideName = override!.split(' AS ')[1] ?? override!
      const select = fields.map((name) =>
        name === 'is_deleted'
          ? '1'
          : name === 'deleted_at'
            ? 'created_at'
            : name === 'deleted_by'
              ? 'created_by'
              : name === overrideName
                ? override!.split(' AS ')[0]
                : `"${name}"`,
      )
      await f.adapter.client.execute(
        `INSERT INTO "${table}" (${fields.map((name) => `"${name}"`).join(',')}) SELECT ${select.join(',')} FROM "${table}"${table === 'credit_ledger' ? " WHERE operation='reserve'" : ''} LIMIT 1`,
      )
      const service = createPayloadOwnerCredits({
        clock: () => f.state.now,
        cursorKey,
        payload,
        readiness: () => true,
      })
      await expect(service.reservations({ query: {}, userId: f.userId })).rejects.toMatchObject({
        status: 503,
      })
      await expect(service.ledger({ query: {}, userId: f.userId })).rejects.toMatchObject({
        status: 503,
      })
    })
  }
  test('should reject a zero cost global-prefix extra capture with foreign reservation association', async ({
    payload,
  }) => {
    const f = await workerFixture({ cost: 0, payload })
    await f.adapter.client.execute(
      `INSERT INTO credit_ledger(user_id,account_id,grant_id,reservation_id,event_key,operation,amount_credits,available_delta,reserved_delta,consumed_delta,expired_delta,revoked_delta,reason_code,created_at,updated_at,created_by,updated_by,is_deleted) SELECT user_id,account_id,999,id+999,'capture:generation:${f.taskId}:999','capture',1,0,-1,1,0,0,'GENERATION_CAPTURED',created_at,updated_at,created_by,updated_by,0 FROM credit_reservations`,
    )
    await expect(
      createPayloadOwnerCredits({
        clock: () => f.state.now,
        cursorKey,
        payload,
        readiness: () => true,
      }).reservations({ query: {}, userId: f.userId }),
    ).rejects.toMatchObject({ status: 503 })
  })
  test('should reject all actual selected schema omissions synchronously before IO', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness: () => true,
    })
    const find = vi.spyOn(payload, 'find')
    await service.account({ userId: f.userId })
    await service.reservations({ query: {}, userId: f.userId })
    await service.ledger({ query: {}, userId: f.userId })
    const selected = new Map<string, Set<string>>()
    for (const [args] of find.mock.calls) {
      const slug = String(args.collection)
      const names = selected.get(slug) ?? new Set<string>()
      for (const key of Object.keys(args.select ?? {})) {
        if (key !== 'id') {
          names.add(key)
        }
      }
      selected.set(slug, names)
    }
    find.mockClear()
    const transaction = vi.spyOn(f.adapter.client, 'transaction')
    for (const [slug, names] of selected) {
      const config = (payload.collections as Record<string, typeof payload.collections.users>)[
        slug
      ]!.config
      const fields = config.flattenedFields
      for (const name of names) {
        config.flattenedFields = fields.filter((field) => field.name !== name)
        try {
          expect(
            () =>
              createPayloadOwnerCredits({
                clock: () => f.state.now,
                cursorKey,
                payload,
                readiness: () => true,
              }),
            `${slug}.${name}`,
          ).toThrow()
        } finally {
          config.flattenedFields = fields
        }
      }
      config.flattenedFields = fields.map((field) =>
        field.name === 'isDeleted' ? ({ ...field, type: 'text' } as never) : field,
      )
      try {
        expect(() =>
          createPayloadOwnerCredits({
            clock: () => f.state.now,
            cursorKey,
            payload,
            readiness: () => true,
          }),
        ).toThrow()
      } finally {
        config.flattenedFields = fields
      }
    }
    expect(find).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })
  test('should reject truncated pages and complete associated queries rather than dropping evidence', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const original = payload.find.bind(payload)
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness: () => true,
    })
    for (const collection of [
      'users',
      'credit-accounts',
      'credit-reservations',
      'credit-allocations',
      'credit-grants',
      'credit-ledger',
      'generation-tasks',
      'creation-sessions',
    ]) {
      vi.spyOn(payload, 'find').mockImplementation(async (args) => {
        const result = await original(args)
        return String(args.collection) === collection
          ? { ...result, docs: [], totalDocs: 1 }
          : result
      })
      await expect(service.reservations({ query: {}, userId: f.userId })).rejects.toMatchObject({
        status: 503,
      })
      await expect(service.ledger({ query: {}, userId: f.userId })).rejects.toMatchObject({
        status: 503,
      })
      vi.restoreAllMocks()
    }
  })
  test('should explain captured real Payload SELECT with indexed user and account OR branches', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const original = f.adapter.client.transaction.bind(f.adapter.client)
    const statements: { args?: unknown[]; sql: string }[] = []
    vi.spyOn(f.adapter.client, 'transaction').mockImplementation(async (...args) => {
      const tx = await original(...args)
      return new Proxy(tx, {
        get(target, property) {
          if (property === 'execute') {
            return async (statement: { args?: unknown[]; sql: string }) => {
              statements.push(statement)
              return target.execute(statement as never)
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    })
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness: () => true,
    })
    await service.reservations({ query: {}, userId: f.userId })
    await service.ledger({ query: {}, userId: f.userId })
    for (const table of ['credit_reservations', 'credit_ledger']) {
      const statement = statements.find(
        (row) =>
          row.sql.toLowerCase().includes(`from "${table}"`) &&
          /order by/i.test(row.sql) &&
          / or /i.test(row.sql) &&
          /user_id/i.test(row.sql.split(/where/i)[1] ?? '') &&
          /account_id/i.test(row.sql.split(/where/i)[1] ?? ''),
      )
      expect(statement, table).toBeDefined()
      const explained = await f.adapter.client.execute({
        ...statement!,
        sql: `EXPLAIN QUERY PLAN ${statement!.sql}`,
      } as never)
      const detail = explained.rows.map((row) => String(row.detail)).join('\n')
      expect(detail).toContain('MULTI-INDEX OR')
      expect(detail).toMatch(/INDEX .*user/)
      expect(detail).toMatch(/INDEX .*account/)
      console.info('T07-C actual Payload SELECT plan', table, statement!.sql, detail)
    }
  })
  test('should preserve mixed-expiry trusted close history without reading closure audit or current wallet', async ({
    payload,
  }) => {
    const f = await workerFixture({
      grants: [
        { amount: 1, expiresAt: '2026-11-12T12:01:00.000Z' },
        { amount: 1, expiresAt: null },
      ],
      payload,
    })
    f.state.engine = async () => ({ kind: 'unknown', requestId: null })
    await f.running.run({ taskId: f.taskId })
    f.state.now = '2026-11-12T12:02:00.000Z'
    await f.running.closeUnknown({
      operationId: 'credits-trusted-close',
      reason: 'PROVIDER_UNRESOLVED',
      taskId: f.taskId,
    })
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness: () => true,
    })
    const find = vi.spyOn(payload, 'find')
    const events = (await service.ledger({ query: {}, userId: f.userId })).items
    expect(
      events
        .filter((row) => row.operation === 'release')
        .map((row) => [row.availableDelta, row.expiredDelta])
        .sort(),
    ).toEqual([
      [0, 1],
      [1, 0],
    ])
    expect(
      events.filter((row) => row.operation === 'reserve').map((row) => row.ledgerDelta),
    ).toEqual([0, 0])
    expect(
      find.mock.calls.some(([args]) =>
        /attempt|audit|media|artifact|draft|template/.test(String(args.collection)),
      ),
    ).toBe(false)
  })
  test('should not validate or consume the extra ledger candidate before its own page', async ({
    payload,
  }) => {
    const f = await workerFixture({ cost: 0, payload })
    await grant({ amount: 2, key: 'old-ledger', payload, userId: f.userId })
    await grant({ amount: 3, key: 'latest-ledger', payload, userId: f.userId })
    await f.adapter.client.execute(
      "UPDATE credit_ledger SET operation='revoke' WHERE id=(SELECT min(id) FROM credit_ledger)",
    )
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      pageSize: 1,
      payload,
      readiness: () => true,
    })
    const page = await service.ledger({ query: {}, userId: f.userId })
    expect(page.items[0]).toMatchObject({ ledgerDelta: 3, operation: 'grant' })
    expect(page.hasMore).toBe(true)
    await expect(
      service.ledger({ query: { cursor: page.nextCursor }, userId: f.userId }),
    ).rejects.toMatchObject({ status: 503 })
  })
  test('should reject both lists for inactive actors without traversing page facts', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    await f.adapter.client.execute("UPDATE users SET status='disabled'")
    const find = vi.spyOn(payload, 'find')
    const service = createPayloadOwnerCredits({
      clock: () => f.state.now,
      cursorKey,
      payload,
      readiness: () => true,
    })
    await expect(service.account({ userId: f.userId })).rejects.toMatchObject({ status: 401 })
    await expect(service.reservations({ query: {}, userId: f.userId })).rejects.toMatchObject({
      status: 401,
    })
    await expect(service.ledger({ query: {}, userId: f.userId })).rejects.toMatchObject({
      status: 401,
    })
    expect(find.mock.calls.every(([args]) => String(args.collection) === 'users')).toBe(true)
  })
})
