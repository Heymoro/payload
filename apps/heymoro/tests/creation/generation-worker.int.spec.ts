import type { InStatement, Transaction } from '@libsql/client'

import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { readAcceptedGeneration } from '../../src/creation/application/generation-worker-types.js'
import { createGenerationReader } from '../../src/creation/infrastructure/payload/generation-reader.js'
import { createSQLiteReadSnapshot } from '../../src/creation/infrastructure/payload/read-snapshot.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { grant, update } from './generation-fixture.js'
import {
  barrier,
  close,
  image,
  imageLimits,
  sqlRows,
  workerFixture,
} from './generation-worker-fixture.js'
import { cleanupSQLiteFixture } from './sqlite.config.js'

test.suite('Heymoro real generation worker', { config: './sqlite.config.ts', cron: false }, () => {
  test.afterEach(async () => {
    vi.restoreAllMocks()
    for (const work of close.splice(0).reverse()) {
      await work()
    }
  })
  test.afterAll(() => cleanupSQLiteFixture())
  test('accepts bounded model budgets above sixty seconds without wall-clock waiting', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    await expect(
      f.worker({ engineTimeoutMs: 180_000, leaseMs: 210_000 }).run({ taskId: f.taskId }),
    ).resolves.toBe('succeeded')
    expect(f.state.calls).toBe(1)
    expect(() => f.worker({ engineTimeoutMs: 300_000, leaseMs: 600_000 })).not.toThrow()
    for (const budgets of [
      { engineTimeoutMs: 300_001, leaseMs: 600_000 },
      { engineTimeoutMs: 180_000, leaseMs: 600_001 },
      { engineTimeoutMs: 180_000, leaseMs: 179_999 },
    ]) {
      expect(() => f.worker(budgets)).toThrow('Explicit bounded execution budget required.')
    }
  })
  test('does not send or resend when preparation consumes the remaining long engine budget', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const original = f.storage.getVerified
    const storage = {
      ...f.storage,
      getVerified: async (args: Parameters<typeof original>[0]) => {
        const result = await original(args)
        f.state.now = '2026-11-12T12:00:40.000Z'
        return result
      },
    }
    await expect(
      f.worker({ engineTimeoutMs: 180_000, leaseMs: 210_000, storage }).run({ taskId: f.taskId }),
    ).resolves.toBe('unknown')
    expect(f.state.calls).toBe(0)
    expect((await sqlRows(f, 'credit_reservations'))[0]?.status).toBe('reserved')
    f.state.now = '2026-11-12T13:00:00.000Z'
    await f.worker().run({ taskId: f.taskId })
    expect(f.state.calls).toBe(0)
  })
  test('uses real adapter index searches and keeps task 1 separate from task 10 and 100 prefixes', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const fields = (await f.adapter.client.execute('PRAGMA table_info(credit_ledger)')).rows
      .map((row) => String(row.name))
      .filter((name) => name !== 'id')
    for (const suffix of ['0', '00']) {
      const expressions = fields.map((field) =>
        field === 'event_key'
          ? `'capture:generation:${f.taskId}${suffix}:999999'`
          : field === 'reservation_id' || field === 'grant_id'
            ? '999999'
            : field,
      )
      await f.adapter.client.execute(
        `INSERT INTO credit_ledger (${fields.join(',')}) SELECT ${expressions.join(',')} FROM credit_ledger WHERE operation = 'reserve' LIMIT 1`,
      )
    }
    const statements: Exclude<InStatement, string>[] = []
    const original = f.adapter.client.transaction.bind(f.adapter.client)
    const transactionSpy = vi
      .spyOn(f.adapter.client, 'transaction')
      .mockImplementation(async (...args: unknown[]) => {
        const [mode] = args
        if (mode !== undefined && mode !== 'read' && mode !== 'write' && mode !== 'deferred') {
          throw new Error('Invalid fixture transaction mode')
        }
        const transaction = await (mode === undefined ? original() : original(mode))
        return new Proxy(transaction, {
          get: (target: Transaction, property) => {
            if (property === 'execute') {
              return async (statement: InStatement) => {
                if (
                  typeof statement !== 'string' &&
                  /from "credit_ledger"/i.test(statement.sql) &&
                  /\bor\b/i.test(statement.sql) &&
                  JSON.stringify(statement.args).includes(`reserve:generation:${f.taskId}:`)
                ) {
                  statements.push(structuredClone(statement))
                }
                return target.execute(statement)
              }
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      })
    await createSQLiteReadSnapshot({ payload })({
      work: ({ find }) =>
        readAcceptedGeneration({ reader: createGenerationReader({ find }), taskId: f.taskId }),
    })
    transactionSpy.mockRestore()
    expect(statements.length).toBeGreaterThan(0)
    const indexes = (await f.adapter.client.execute('PRAGMA index_list(credit_ledger)')).rows
    const indexed: Record<string, string> = {}
    for (const index of indexes) {
      const columns = (
        await f.adapter.client.execute(`PRAGMA index_info('${String(index.name)}')`)
      ).rows.map((row) => String(row.name))
      if (columns.length === 1) {
        indexed[columns[0]!] = String(index.name)
      }
    }
    expect(indexed.event_key).toBeDefined()
    expect(indexed.reservation_id).toBeDefined()
    for (const statement of statements) {
      const plan = (
        await f.adapter.client.execute({
          args: statement.args,
          sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
        })
      ).rows.map((row) => String(row.detail))
      console.info(
        'Actual Payload ledger query plan',
        JSON.stringify({ args: statement.args, plan, sql: statement.sql }),
      )
      expect(plan.some((detail) => /\bSCAN\s+["`]?credit_ledger\b/i.test(detail))).toBe(false)
      expect(plan.some((detail) => detail.includes(`USING INDEX ${indexed.reservation_id}`))).toBe(
        true,
      )
      expect(
        plan.filter((detail) => detail.includes(`USING INDEX ${indexed.event_key}`)).length,
      ).toBeGreaterThanOrEqual(3)
    }
    await f.running.run({ taskId: f.taskId })
    expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('succeeded')
    expect(f.state.calls).toBe(1)
  })
  test('rejects a noncanonical event key linked to this reservation even outside every task prefix', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const fields = (await f.adapter.client.execute('PRAGMA table_info(credit_ledger)')).rows
      .map((row) => String(row.name))
      .filter((name) => name !== 'id')
    await f.adapter.client.execute(
      `INSERT INTO credit_ledger (${fields.join(',')}) SELECT ${fields.map((field) => (field === 'event_key' ? "'noncanonical-financial-event'" : field)).join(',')} FROM credit_ledger WHERE operation = 'reserve' LIMIT 1`,
    )
    await expect(f.running.run({ taskId: f.taskId })).rejects.toMatchObject({
      code: 'DATA_INTEGRITY_CONFLICT',
      status: 503,
    })
    expect(f.state.calls).toBe(0)
  })
  test('persists attempt identities and output evidence in the actual SQLite schema', async ({
    payload,
  }) => {
    const result = await getCreationSQLiteAdapter({ payload }).client.execute(
      "PRAGMA table_info('generation_attempts')",
    )
    expect(result.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'task_id',
        'attempt_no',
        'provider',
        'model',
        'status',
        'provider_request_id',
        'lease_until',
        'started_at',
        'finished_at',
        'error_code',
        'result_storage_backend',
        'result_storage_bucket',
        'result_storage_key',
        'result_sha256',
      ]),
    )
  })
  test('runs the real queued Payload job, captures exactly once and persists naming with delivery', async ({
    payload,
  }) => {
    const fixture = await workerFixture({ payload })
    await payload.jobs.run({ limit: 1, overrideAccess: true, queue: 'creation' })
    const tasks = (await fixture.adapter.client.execute('SELECT * FROM generation_tasks')).rows
    expect(tasks[0]?.status).toBe('succeeded')
    expect(fixture.state.calls).toBe(1)
    await fixture.running.run({ taskId: fixture.taskId })
    expect(fixture.state.calls).toBe(1)
    expect((await fixture.adapter.client.execute('SELECT * FROM artifacts')).rows).toHaveLength(1)
    expect(
      (
        await fixture.adapter.client.execute(
          "SELECT * FROM credit_ledger WHERE operation = 'capture'",
        )
      ).rows,
    ).toHaveLength(1)
    expect(
      (
        await fixture.adapter.client.execute(
          "SELECT * FROM payload_jobs WHERE task_slug = 'heymoro-name-v1'",
        )
      ).rows,
    ).toHaveLength(1)
  })

  test('rejects a contradictory wallet projection before sending, without repairing funds', async ({
    payload,
  }) => {
    const fixture = await workerFixture({ payload })
    await fixture.adapter.client.execute(
      'UPDATE credit_accounts SET reserved_credits = reserved_credits + 1',
    )
    await expect(fixture.running.run({ taskId: fixture.taskId })).rejects.toMatchObject({
      code: 'DATA_INTEGRITY_CONFLICT',
    })
    expect(fixture.state.calls).toBe(0)
    expect(
      (await fixture.adapter.client.execute('SELECT * FROM generation_attempts')).rows,
    ).toHaveLength(0)
  })

  test('concurrent jobs share one sending gate and never invoke the engine twice', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const wait = barrier()
    f.state.engine = async () => {
      wait.enter()
      await wait.released
      return { bytes: await image(), contentType: 'image/png', kind: 'output', requestId: null }
    }
    const first = f.running.run({ taskId: f.taskId })
    await wait.entered
    try {
      await f.running.run({ taskId: f.taskId })
      expect(f.state.calls).toBe(1)
    } finally {
      wait.release()
    }
    await first
    expect(f.state.calls).toBe(1)
    expect(await sqlRows(f, 'artifacts')).toHaveLength(1)
  })
  test('recovers expired prepared holders at a higher attempt and fences the old sender', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const wait = barrier()
    let blocked = false
    const old = f.worker({
      storage: {
        ...f.storage,
        getVerified: async (args) => {
          if (!blocked) {
            blocked = true
            wait.enter()
            await wait.released
          }
          return f.storage.getVerified(args)
        },
      },
    })
    const first = old.run({ taskId: f.taskId })
    await wait.entered
    f.state.now = '2026-11-12T12:01:00.000Z'
    try {
      await f.running.run({ taskId: f.taskId })
    } finally {
      wait.release()
    }
    await first
    expect(f.state.calls).toBe(1)
    expect(
      (await sqlRows(f, 'generation_attempts')).map((a) => [a.attempt_no, a.status, a.error_code]),
    ).toEqual([
      [1, 'failed', 'NOT_SENT'],
      [2, 'succeeded', null],
    ])
  })
  for (const mode of [
    'crash',
    'timeout',
    'malformed',
    'null-result',
    'invalid-request-id',
    'invalid-image',
  ] as const) {
    test(`keeps ${mode} outcomes unknown and reserved after restart and lease expiry`, async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      let observedSignal: AbortSignal | undefined
      f.state.engine = async ({ signal }) => {
        observedSignal = signal
        if (mode === 'crash') {
          throw new Error('fixture disconnected')
        }
        if (mode === 'timeout') {
          return new Promise(() => {})
        }
        if (mode === 'null-result') {
          return null as never
        }
        if (mode === 'invalid-request-id') {
          return { kind: 'rejected', requestId: 123 } as never
        }
        if (mode === 'malformed') {
          return { kind: 'not-a-result' } as never
        }
        return {
          bytes: Buffer.from('not image'),
          contentType: 'image/png',
          kind: 'output',
          requestId: null,
        }
      }
      await f.worker({ engineTimeoutMs: 25 }).run({ taskId: f.taskId })
      if (mode === 'timeout') {
        expect(observedSignal?.aborted).toBe(true)
      }
      expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('unknown')
      expect((await sqlRows(f, 'credit_reservations'))[0]?.status).toBe('reserved')
      f.state.now = '2026-11-12T13:00:00.000Z'
      await f.worker().run({ taskId: f.taskId })
      expect(f.state.calls).toBe(1)
      expect(await sqlRows(f, 'artifacts')).toHaveLength(0)
      expect(
        (await sqlRows(f, 'credit_ledger')).filter((e) => e.operation === 'release'),
      ).toHaveLength(0)
    })
  }
  for (const kind of ['not_sent', 'rejected'] as const) {
    test(`releases only the explicit ${kind} outcome and replays with one ledger`, async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      f.state.engine = async () => ({ kind, requestId: null })
      await f.running.run({ taskId: f.taskId })
      await f.running.run({ taskId: f.taskId })
      expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('failed')
      expect((await sqlRows(f, 'credit_accounts'))[0]).toMatchObject({
        available_credits: 7,
        reserved_credits: 0,
      })
      expect(
        (await sqlRows(f, 'credit_ledger')).filter((e) => e.operation === 'release'),
      ).toHaveLength(1)
      expect(f.state.calls).toBe(1)
    })
  }
  test('fails unsupported execution before any engine invocation', async ({ payload }) => {
    const f = await workerFixture({ payload })
    await f.worker({ execution: null }).run({ taskId: f.taskId })
    expect(f.state.calls).toBe(0)
    expect((await sqlRows(f, 'generation_tasks'))[0]).toMatchObject({
      error_code: 'NOT_SENT',
      status: 'failed',
    })
  })
  test('recovers an output object after output_ready SQL rollback without invoking the engine again', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    await f.adapter.client.execute(
      "CREATE TRIGGER worker_output_abort BEFORE UPDATE ON generation_attempts WHEN NEW.status = 'output_ready' BEGIN SELECT RAISE(ABORT, 'fixture output_ready failure'); END",
    )
    await expect(f.running.run({ taskId: f.taskId })).rejects.toThrow()
    expect((await sqlRows(f, 'generation_attempts'))[0]?.status).toBe('sending')
    expect([...f.http.objects.keys()].filter((key) => key.startsWith('tasks/'))).toHaveLength(1)
    await f.adapter.client.execute('DROP TRIGGER worker_output_abort')
    await f.worker().run({ taskId: f.taskId })
    expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('succeeded')
    expect(f.state.calls).toBe(1)
  })
  for (const fault of ['conflict', 'incomplete', 'wrong-destination'] as const) {
    test(`does not deliver a ${fault} recovery candidate`, async ({ payload }) => {
      const f = await workerFixture({ payload })
      f.state.engine = async () => ({ kind: 'unknown', requestId: null })
      await f.running.run({ taskId: f.taskId })
      const attempt = (await sqlRows(f, 'generation_attempts'))[0]!
      const output = await image()
      const { createHash } = await import('node:crypto')
      const hash = createHash('sha256').update(output).digest('hex')
      const key = `tasks/${f.taskId}/attempts/${attempt.id}/result-${hash}`
      f.http.objects.set(
        fault === 'wrong-destination' ? key.replace('tasks/', 'other-tasks/') : key,
        { type: 'image/png', bytes: output },
      )
      if (fault === 'conflict') {
        f.http.objects.set(`tasks/${f.taskId}/attempts/${attempt.id}/result-${'f'.repeat(64)}`, {
          type: 'image/png',
          bytes: output,
        })
      }
      if (fault === 'incomplete') {
        f.http.setFault('repeat-page')
      }
      await f.worker().run({ taskId: f.taskId })
      expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('unknown')
      expect(await sqlRows(f, 'artifacts')).toHaveLength(0)
      expect(f.state.calls).toBe(1)
    })
  }
  test('treats real S3 output acknowledgement loss as recoverable evidence, never as a new model call', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    f.state.engine = async () => {
      f.http.setFault('ack-lost')
      return { bytes: await image(), contentType: 'image/png', kind: 'output', requestId: null }
    }
    await f.running.run({ taskId: f.taskId })
    await f.worker().run({ taskId: f.taskId })
    expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('succeeded')
    expect(f.state.calls).toBe(1)
    expect(await sqlRows(f, 'artifacts')).toHaveLength(1)
  })

  test('rejects a failed task replay whose current attempt contradicts its terminal evidence', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    f.state.engine = async () => ({ kind: 'rejected', requestId: null })
    await f.running.run({ taskId: f.taskId })
    await f.adapter.client.execute("UPDATE generation_attempts SET status = 'unknown'")
    await expect(f.worker().run({ taskId: f.taskId })).rejects.toMatchObject({
      code: 'DATA_INTEGRITY_CONFLICT',
    })
    expect(f.state.calls).toBe(1)
  })

  test('rejects an inflated available projection without spending or silently repairing it', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    await f.adapter.client.execute(
      'UPDATE credit_accounts SET available_credits = available_credits + 100',
    )
    await expect(f.running.run({ taskId: f.taskId })).rejects.toMatchObject({
      code: 'DATA_INTEGRITY_CONFLICT',
    })
    expect(f.state.calls).toBe(0)
  })
  test('rejects duplicate logical output media evidence on terminal T2 replay', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    await f.running.run({ taskId: f.taskId })
    const fields = (await f.adapter.client.execute('PRAGMA table_info(media)')).rows
      .map((row) => String(row.name))
      .filter((name) => name !== 'id')
    await f.adapter.client.execute(
      `INSERT INTO media (${fields.join(',')}) SELECT ${fields.join(',')} FROM media WHERE purpose = 'artifact' LIMIT 1`,
    )
    await expect(f.worker().run({ taskId: f.taskId })).rejects.toMatchObject({
      code: 'DATA_INTEGRITY_CONFLICT',
    })
    expect(f.state.calls).toBe(1)
  })
  test('rejects immutable attempt identities, partial output evidence and illegal state transitions', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    f.state.engine = async () => ({ kind: 'unknown', requestId: null })
    await f.running.run({ taskId: f.taskId })
    const attempt = (await sqlRows(f, 'generation_attempts'))[0]!
    for (const data of [
      { taskId: f.taskId + 1 },
      { attemptNo: 99 },
      { provider: 'another' },
      { model: 'another' },
      { resultStorageKey: 'partial/key' },
      { status: 'sending' },
      { deletedAt: f.state.now, deletedBy: 'system:fixture', isDeleted: true },
    ]) {
      await expect(
        update({ id: Number(attempt.id), collection: 'generation-attempts', data, payload }),
      ).rejects.toThrow()
    }
    expect((await sqlRows(f, 'generation_attempts'))[0]).toMatchObject({
      attempt_no: 1,
      result_storage_key: null,
      status: 'unknown',
    })
  })
  test('keeps Redis failures separate from definite provider failure and never sends without its gate', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    let reads = 0
    const w = f.worker({
      storage: {
        ...f.storage,
        getVerified: async (args) => {
          const result = await f.storage.getVerified(args)
          if (++reads === 2) {
            await f.redis.stop()
          }
          return result
        },
      },
    })
    await expect(w.run({ taskId: f.taskId })).rejects.toThrow()
    expect(f.state.calls).toBe(0)
    expect((await sqlRows(f, 'generation_attempts'))[0]?.status).toBe('prepared')
    expect((await sqlRows(f, 'credit_reservations'))[0]?.status).toBe('reserved')
    expect(
      (await sqlRows(f, 'credit_ledger')).filter((e) => e.operation === 'release'),
    ).toHaveLength(0)
  })

  test('retains a trustworthy provider request ID on explicit rejection', async ({ payload }) => {
    const f = await workerFixture({ payload })
    f.state.engine = async () => ({ kind: 'rejected', requestId: 'rejected-request-id' })
    await f.running.run({ taskId: f.taskId })
    expect((await sqlRows(f, 'generation_attempts'))[0]?.provider_request_id).toBe(
      'rejected-request-id',
    )
  })
  test('rejects a globally keyed settlement event even with a foreign reservation and unallocated grant', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const fields = (await f.adapter.client.execute('PRAGMA table_info(credit_ledger)')).rows
      .map((row) => String(row.name))
      .filter((name) => name !== 'id')
    const expressions = fields.map((field) =>
      field === 'event_key'
        ? `'capture:generation:${f.taskId}:999999'`
        : field === 'reservation_id'
          ? '999999'
          : field === 'grant_id'
            ? '999999'
            : field,
    )
    await f.adapter.client.execute(
      `INSERT INTO credit_ledger (${fields.join(',')}) SELECT ${expressions.join(',')} FROM credit_ledger WHERE operation = 'reserve' LIMIT 1`,
    )
    await expect(f.running.run({ taskId: f.taskId })).rejects.toMatchObject({
      code: 'DATA_INTEGRITY_CONFLICT',
    })
    expect(f.state.calls).toBe(0)
  })
  test('checks 131 global grant identities in two bounded queries per accepted zero-cost graph', async ({
    payload,
  }) => {
    const f = await workerFixture({ cost: 0, grants: [{ amount: 1, expiresAt: null }], payload })
    const fields = (await f.adapter.client.execute('PRAGMA table_info(credit_grants)')).rows
      .map((row) => String(row.name))
      .filter((name) => name !== 'id')
    const values = fields.map((field) => (field === 'grant_key' ? "'worker-page-' || n" : field))
    await f.adapter.client.execute(
      `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 130) INSERT INTO credit_grants (${fields.join(',')}) SELECT ${values.join(',')} FROM credit_grants CROSS JOIN sequence WHERE credit_grants.id = (SELECT MIN(id) FROM credit_grants)`,
    )
    await f.adapter.client.execute('UPDATE credit_accounts SET available_credits = 131')
    expect(await sqlRows(f, 'credit_grants')).toHaveLength(131)
    expect(await sqlRows(f, 'credit_allocations')).toHaveLength(0)
    const find = vi.spyOn(payload, 'find')
    await createSQLiteReadSnapshot({ payload })({
      work: ({ find }) =>
        readAcceptedGeneration({ reader: createGenerationReader({ find }), taskId: f.taskId }),
    })
    const identities = find.mock.calls.filter(
      ([args]) =>
        String(args.collection) === 'credit-grants' &&
        JSON.stringify(args.where).includes('grantKey'),
    )
    expect(identities).toHaveLength(2)
    expect(identities.map(([args]) => args.limit)).toEqual([256, 6])
    find.mockRestore()
    await f.running.run({ taskId: f.taskId })
    expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('succeeded')
  })
  for (const isDeleted of [false, true]) {
    test(`rejects a global cross-wallet duplicate grant identity including isDeleted=${isDeleted}`, async ({
      payload,
    }) => {
      const f = await workerFixture({ cost: 0, grants: [{ amount: 1, expiresAt: null }], payload })
      const fields = (await f.adapter.client.execute('PRAGMA table_info(credit_grants)')).rows
        .map((row) => String(row.name))
        .filter((name) => name !== 'id')
      const values = fields.map((field) =>
        field === 'account_id' || field === 'user_id'
          ? `${field} + 1000`
          : field === 'is_deleted'
            ? isDeleted
              ? '1'
              : '0'
            : field,
      )
      await f.adapter.client.execute(
        `INSERT INTO credit_grants (${fields.join(',')}) SELECT ${values.join(',')} FROM credit_grants LIMIT 1`,
      )
      const ledger = await sqlRows(f, 'credit_ledger')
      await expect(f.running.run({ taskId: f.taskId })).rejects.toMatchObject({
        code: 'DATA_INTEGRITY_CONFLICT',
        status: 503,
      })
      expect(f.state.calls).toBe(0)
      expect(await sqlRows(f, 'credit_ledger')).toEqual(ledger)
    })
  }

  test('rejects invalid image limits at construction before any engine invocation', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    for (const invalid of [
      { maxBytes: 0 },
      { maxPixels: 0 },
      { timeoutMs: 0 },
      { allowedMimeTypes: [] },
    ]) {
      let error: unknown
      try {
        f.worker({ imageLimits: { ...imageLimits, ...invalid } })
      } catch (caught) {
        error = caught
      }
      expect(f.state.calls).toBe(0)
      expect(error).toBeInstanceOf(Error)
    }
  })
  test('snapshots image limits and the MIME array before an awaited engine can observe caller mutation', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const limits = { ...imageLimits, allowedMimeTypes: ['image/png'] }
    const wait = barrier()
    f.state.engine = async () => {
      wait.enter()
      await wait.released
      return { bytes: await image(), contentType: 'image/png', kind: 'output', requestId: null }
    }
    const w = f.worker({ imageLimits: limits })
    const inflight = w.run({ taskId: f.taskId })
    await wait.entered
    try {
      limits.maxBytes = 0
      limits.maxPixels = 0
      limits.timeoutMs = 0
      limits.allowedMimeTypes[0] = 'image/jpeg'
    } finally {
      wait.release()
    }
    await inflight
    expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('succeeded')
    expect(f.state.calls).toBe(1)
  })

  test('accepts a legitimate issuance grantKey containing a task-event substring', async ({
    payload,
  }) => {
    const f = await workerFixture({ cost: 0, payload })
    await grant({ key: `note-reserve:generation:${f.taskId}:trial`, payload, userId: f.userId })
    await f.running.run({ taskId: f.taskId })
    expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('succeeded')
    expect(f.state.calls).toBe(1)
  })
  test('settles a trusted pre-engine source-object 404 as NOT_SENT exactly once', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const source = (await sqlRows(f, 'media')).find((row) => row.id === f.mediaIds[0])!
    expect(f.http.objects.delete(String(source.storage_name))).toBe(true)
    await expect(f.running.run({ taskId: f.taskId })).resolves.toBe('failed')
    expect(f.state.calls).toBe(0)
    expect((await sqlRows(f, 'generation_tasks'))[0]).toMatchObject({
      error_code: 'NOT_SENT',
      status: 'failed',
    })
    expect((await sqlRows(f, 'generation_attempts'))[0]).toMatchObject({
      error_code: 'NOT_SENT',
      status: 'failed',
    })
    expect((await sqlRows(f, 'credit_reservations'))[0]?.status).toBe('released')
    expect((await sqlRows(f, 'credit_accounts'))[0]).toMatchObject({
      available_credits: 7,
      reserved_credits: 0,
    })
    const ledger = await sqlRows(f, 'credit_ledger')
    expect(ledger.filter((row) => row.operation === 'release')).toHaveLength(1)
    await f.running.run({ taskId: f.taskId })
    expect(await sqlRows(f, 'credit_ledger')).toEqual(ledger)
    expect(f.state.calls).toBe(0)
  })
  test('a stale holder with a delayed real 404 cannot release the newer sending attempt', async ({
    payload,
  }) => {
    const f = await workerFixture({ payload })
    const failedRead = barrier()
    const sending = barrier()
    let blocked = false
    const source = (await sqlRows(f, 'media')).find((row) => row.id === f.mediaIds[0])!
    const key = String(source.storage_name)
    const object = f.http.objects.get(key)!
    const old = f.worker({
      storage: {
        ...f.storage,
        getVerified: async (args) => {
          if (blocked) {
            return f.storage.getVerified(args)
          }
          blocked = true
          expect(f.http.objects.delete(key)).toBe(true)
          let failure: unknown
          try {
            await f.storage.getVerified(args)
          } catch (error) {
            failure = error
          }
          expect(failure).toMatchObject({ name: 'MediaStorageError', code: 'NOT_FOUND' })
          failedRead.enter()
          await failedRead.released
          throw failure
        },
      },
    })
    const oldRun = old.run({ taskId: f.taskId })
    await failedRead.entered
    f.http.objects.set(key, object)
    f.state.now = '2026-11-12T12:01:00.000Z'
    f.state.engine = async () => {
      sending.enter()
      await sending.released
      return { bytes: await image(), contentType: 'image/png', kind: 'output', requestId: null }
    }
    const newRun = f.running.run({ taskId: f.taskId })
    await sending.entered
    try {
      failedRead.release()
      await expect(oldRun).rejects.toMatchObject({ code: 'DATA_INTEGRITY_CONFLICT' })
      expect((await sqlRows(f, 'generation_attempts')).map((row) => row.status)).toEqual([
        'failed',
        'sending',
      ])
      expect((await sqlRows(f, 'credit_reservations'))[0]?.status).toBe('reserved')
      expect(
        (await sqlRows(f, 'credit_ledger')).filter((row) => row.operation === 'release'),
      ).toHaveLength(0)
    } finally {
      failedRead.release()
      sending.release()
      await oldRun.catch(() => undefined)
      await newRun
    }
    expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('succeeded')
    expect(
      (await sqlRows(f, 'credit_ledger')).filter((row) => row.operation === 'capture'),
    ).toHaveLength(1)
    expect(f.state.calls).toBe(1)
  })
})
