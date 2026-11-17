import type { Transaction } from '@libsql/client'
import type { Payload } from 'payload'

import { createPayloadRequest } from 'payload'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createCreationRuntime } from '../../src/creation/infrastructure/payload/session-repository.js'
import { update, write } from './generation-fixture.js'
import { barrier, close, image, sqlRows, workerFixture } from './generation-worker-fixture.js'
import { cleanupSQLiteFixture, gate } from './sqlite.config.js'

test.suite(
  'Heymoro atomic delivery and trusted reconciliation',
  { config: './sqlite.config.ts', cron: false },
  () => {
    test.afterAll(() => cleanupSQLiteFixture())
    test.afterEach(async () => {
      vi.restoreAllMocks()
      for (const work of close.splice(0).reverse()) {
        await work()
      }
    })
    for (const [table, timing, condition] of [
      ['media', 'INSERT', "NEW.purpose = 'artifact'"],
      ['artifacts', 'INSERT', '1'],
      ['credit_ledger', 'INSERT', "NEW.operation = 'capture'"],
      ['credit_allocations', 'UPDATE', "NEW.status = 'captured'"],
      ['credit_grants', 'UPDATE', 'NEW.consumed_credits > OLD.consumed_credits'],
      ['credit_accounts', 'UPDATE', 'NEW.reserved_credits < OLD.reserved_credits'],
      ['credit_reservations', 'UPDATE', "NEW.status = 'captured'"],
      ['generation_tasks', 'UPDATE', "NEW.status = 'succeeded'"],
      ['creation_sessions', 'UPDATE', "NEW.auto_name_status = 'pending'"],
      ['payload_jobs', 'INSERT', "NEW.task_slug = 'heymoro-name-v1'"],
    ]) {
      test(`rolls the complete T2 back when ${table} fails, retaining the private object`, async ({
        payload,
      }) => {
        const f = await workerFixture({ payload })
        await f.adapter.client.execute(
          `CREATE TRIGGER settlement_abort BEFORE ${timing} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'fixture T2 failure'); END`,
        )
        try {
          await expect(f.running.run({ taskId: f.taskId })).rejects.toThrow()
          expect((await sqlRows(f, 'generation_attempts'))[0]?.status).toBe('output_ready')
          expect((await sqlRows(f, 'credit_reservations'))[0]?.status).toBe('reserved')
          expect((await sqlRows(f, 'credit_accounts'))[0]?.reserved_credits).toBe(2)
          expect(await sqlRows(f, 'artifacts')).toHaveLength(0)
          expect(
            (await sqlRows(f, 'media')).filter((row) => row.purpose === 'artifact'),
          ).toHaveLength(0)
          expect(
            (await sqlRows(f, 'credit_ledger')).filter((row) => row.operation === 'capture'),
          ).toHaveLength(0)
          expect([...f.http.objects.keys()].filter((key) => key.startsWith('tasks/'))).toHaveLength(
            1,
          )
        } finally {
          await f.adapter.client.execute('DROP TRIGGER settlement_abort')
        }
        await f.worker().run({ taskId: f.taskId })
        expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('succeeded')
        expect(f.state.calls).toBe(1)
      })
    }
    test('confirms the whole T2 graph after real COMMIT and lost ACK; never recaptures', async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      loseCommitAck({
        f,
        payload,
        when: ({ collection, data }) =>
          collection === 'generation-tasks' && data.status === 'succeeded',
      })
      await f.running.run({ taskId: f.taskId })
      vi.restoreAllMocks()
      await f.worker().run({ taskId: f.taskId })
      expect(await sqlRows(f, 'artifacts')).toHaveLength(1)
      expect(
        (await sqlRows(f, 'credit_ledger')).filter((e) => e.operation === 'capture'),
      ).toHaveLength(1)
      expect(f.state.calls).toBe(1)
    })
    test('does not send when the sending COMMIT acknowledgement is lost', async ({ payload }) => {
      const f = await workerFixture({ payload })
      loseCommitAck({
        f,
        payload,
        when: ({ collection, data }) =>
          collection === 'generation-attempts' && data.status === 'sending',
      })
      await expect(f.running.run({ taskId: f.taskId })).rejects.toMatchObject({
        commitStarted: true,
      })
      vi.restoreAllMocks()
      expect(f.state.calls).toBe(0)
      expect((await sqlRows(f, 'generation_attempts'))[0]?.status).toBe('sending')
      f.state.now = '2026-11-12T13:00:00.000Z'
      await f.worker().run({ taskId: f.taskId })
      expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('unknown')
      expect((await sqlRows(f, 'credit_reservations'))[0]?.status).toBe('reserved')
      expect(f.state.calls).toBe(0)
    })
    test('closes unknown once across different operation IDs with append-only audit and no public capability', async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      f.state.engine = async () => ({ kind: 'unknown', requestId: 'unknown-request' })
      await f.running.run({ taskId: f.taskId })
      await expect(
        f.worker({ trustedClose: null }).closeUnknown({
          operationId: 'close-x',
          reason: 'PROVIDER_UNRESOLVED',
          taskId: f.taskId,
        }),
      ).rejects.toThrow(/capability/)
      await expect(
        f.running.closeUnknown({
          operationId: 'close-x',
          reason: 'USER_REQUEST',
          taskId: f.taskId,
        }),
      ).rejects.toThrow(/capability/)
      await f.running.closeUnknown({
        operationId: 'close-1',
        reason: 'PROVIDER_UNRESOLVED',
        taskId: f.taskId,
      })
      await f.running.closeUnknown({
        operationId: 'close-2',
        reason: 'PROVIDER_UNRESOLVED',
        taskId: f.taskId,
      })
      expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('closed')
      expect((await sqlRows(f, 'generation_attempts'))[0]?.status).toBe('unknown')
      expect(
        (await sqlRows(f, 'credit_ledger')).filter((e) => e.operation === 'release'),
      ).toHaveLength(1)
      const logs = await sqlRows(f, 'audit_logs')
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({
        action: 'GENERATION_UNKNOWN_CLOSED',
        correlation_id: 'close-1',
        created_by: 'system:fixture-reconciler',
        resource_id: String(f.taskId),
      })
      await expect(
        write({
          payload,
          work: ({ req, runtime }) =>
            runtime.update({
              id: Number(logs[0]!.id),
              collection: 'auditLogs',
              data: { action: 'REPLACED' },
              req,
            }),
        }),
      ).rejects.toThrow(/append-only/)
      const req = await createPayloadRequest({ payload })
      await expect(
        createCreationRuntime({ gate, payload }).update({
          id: f.taskId,
          collection: 'generation-tasks',
          data: { status: 'closed' },
          req,
        }),
      ).rejects.toThrow()
    })
    test('rolls audit failure and release back together, and confirms close after lost ACK', async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      f.state.engine = async () => ({ kind: 'unknown', requestId: null })
      await f.running.run({ taskId: f.taskId })
      await f.adapter.client.execute(
        "CREATE TRIGGER close_abort BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END",
      )
      try {
        await expect(
          f.running.closeUnknown({
            operationId: 'close-1',
            reason: 'PROVIDER_UNRESOLVED',
            taskId: f.taskId,
          }),
        ).rejects.toThrow()
      } finally {
        await f.adapter.client.execute('DROP TRIGGER close_abort')
      }
      expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('unknown')
      expect((await sqlRows(f, 'credit_reservations'))[0]?.status).toBe('reserved')
      expect(
        (await sqlRows(f, 'credit_ledger')).filter((e) => e.operation === 'release'),
      ).toHaveLength(0)
      loseCommitAck({
        f,
        payload,
        when: ({ collection, data }) =>
          collection === 'generation-tasks' && data.status === 'closed',
      })
      await f.running.closeUnknown({
        operationId: 'close-1',
        reason: 'PROVIDER_UNRESOLVED',
        taskId: f.taskId,
      })
      vi.restoreAllMocks()
      expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('closed')
      expect(await sqlRows(f, 'audit_logs')).toHaveLength(1)
    })
    test('a late output after trusted close stays private unknown evidence, not visible delivery or capture', async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      const wait = barrier()
      f.state.engine = async () => {
        wait.enter()
        await wait.released
        return {
          bytes: await image(),
          contentType: 'image/png',
          kind: 'output',
          requestId: 'late-output',
        }
      }
      const inflight = f.running.run({ taskId: f.taskId })
      await wait.entered
      // Simulates a separate recovery process observing the expired committed sending attempt.
      f.state.now = '2026-11-12T13:00:00.000Z'
      await f.worker().run({ taskId: f.taskId })
      await f.running.closeUnknown({
        operationId: 'close-late',
        reason: 'PROVIDER_UNRESOLVED',
        taskId: f.taskId,
      })
      wait.release()
      await inflight
      expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('closed')
      expect((await sqlRows(f, 'generation_attempts'))[0]).toMatchObject({
        provider_request_id: 'late-output',
        result_storage_backend: 'fixture-metadata',
        status: 'unknown',
      })
      expect(await sqlRows(f, 'artifacts')).toHaveLength(0)
      expect(
        (await sqlRows(f, 'credit_ledger')).filter((e) => e.operation === 'capture'),
      ).toHaveLength(0)
    })
    for (const operation of ['capture', 'release'] as const) {
      test(`settles multiple grants across expiry with exact ${operation} deltas`, async ({
        payload,
      }) => {
        const f = await workerFixture({
          cost: 4,
          grants: [
            { amount: 2, expiresAt: '2026-11-12T12:00:30.000Z' },
            { amount: 5, expiresAt: null },
          ],
          payload,
        })
        f.state.now = '2026-11-12T12:01:00.000Z'
        if (operation === 'release') {
          f.state.engine = async () => ({ kind: 'rejected', requestId: null })
        }
        await f.running.run({ taskId: f.taskId })
        const events = (await sqlRows(f, 'credit_ledger')).filter((e) => e.operation === operation)
        expect(events).toHaveLength(2)
        expect(
          events.map((e) => [
            e.amount_credits,
            e.available_delta,
            e.reserved_delta,
            e.consumed_delta,
            e.expired_delta,
          ]),
        ).toEqual(
          operation === 'capture'
            ? [
                [2, 0, -2, 2, 0],
                [2, 0, -2, 2, 0],
              ]
            : [
                [2, 0, -2, 0, 2],
                [2, 2, -2, 0, 0],
              ],
        )
        expect((await sqlRows(f, 'credit_accounts'))[0]).toMatchObject({
          available_credits: operation === 'capture' ? 3 : 5,
          reserved_credits: 0,
        })
        expect((await sqlRows(f, 'credit_allocations')).map((a) => a.status)).toEqual(
          operation === 'capture' ? ['captured', 'captured'] : ['expired', 'released'],
        )
      })
    }
    for (const kind of ['output', 'rejected'] as const) {
      test(`zero-cost ${kind} closes with empty allocations and no invented ledger`, async ({
        payload,
      }) => {
        const f = await workerFixture({ cost: 0, payload })
        if (kind === 'rejected') {
          f.state.engine = async () => ({ kind, requestId: null })
        }
        await f.running.run({ taskId: f.taskId })
        expect(await sqlRows(f, 'credit_allocations')).toHaveLength(0)
        expect(await sqlRows(f, 'credit_ledger')).toHaveLength(0)
        expect((await sqlRows(f, 'credit_reservations'))[0]?.status).toBe(
          kind === 'output' ? 'captured' : 'released',
        )
      })
    }
    for (const outcome of ['output', 'rejected', 'unknown'] as const) {
      test(`disabled owners still settle accepted ${outcome}, but new T1 is denied`, async ({
        payload,
      }) => {
        const f = await workerFixture({ payload })
        await payload.update({
          id: f.userId,
          collection: 'users',
          data: { status: 'disabled' } as never,
          overrideAccess: true,
        })
        if (outcome !== 'output') {
          f.state.engine = async () => ({ kind: outcome, requestId: null })
        }
        await f.running.run({ taskId: f.taskId })
        if (outcome === 'unknown') {
          await f.running.closeUnknown({
            operationId: 'disabled-close',
            reason: 'PROVIDER_UNRESOLVED',
            taskId: f.taskId,
          })
        }
        expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe(
          outcome === 'output' ? 'succeeded' : outcome === 'rejected' ? 'failed' : 'closed',
        )
        await expect(
          f.admission.quoteGenerate({ input: f.input, sessionId: f.sessionId, userId: f.userId }),
        ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
      })
    }
    test('competing T2 recovery and trusted close choose one financial terminal under the same resources', async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      f.state.engine = async () => ({ kind: 'unknown', requestId: null })
      await f.running.run({ taskId: f.taskId })
      const attempt = (await sqlRows(f, 'generation_attempts'))[0]!
      const bytes = await image()
      const { createHash } = await import('node:crypto')
      const hash = createHash('sha256').update(bytes).digest('hex')
      await f.storage.putImmutable({
        bytes,
        contentType: 'image/png',
        ref: {
          backend: 'fixture-metadata',
          bucket: 'fixture-output',
          key: `tasks/${f.taskId}/attempts/${attempt.id}/result-${hash}`,
        },
      })
      const results = await Promise.allSettled([
        f.worker().run({ taskId: f.taskId }),
        f.running.closeUnknown({
          operationId: 'race-close',
          reason: 'PROVIDER_UNRESOLVED',
          taskId: f.taskId,
        }),
      ])
      expect(results.some((result) => result.status === 'fulfilled')).toBe(true)
      const task = (await sqlRows(f, 'generation_tasks'))[0]!
      expect(['succeeded', 'closed']).toContain(task.status)
      const events = (await sqlRows(f, 'credit_ledger')).filter(
        (e) => e.operation === 'capture' || e.operation === 'release',
      )
      expect(events).toHaveLength(1)
      expect(events[0]!.operation).toBe(task.status === 'succeeded' ? 'capture' : 'release')
      expect(await sqlRows(f, 'artifacts')).toHaveLength(task.status === 'succeeded' ? 1 : 0)
      await f.running.closeUnknown({
        operationId: 'race-replay',
        reason: 'PROVIDER_UNRESOLVED',
        taskId: f.taskId,
      })
      expect(
        (await sqlRows(f, 'credit_ledger')).filter(
          (e) => e.operation === 'capture' || e.operation === 'release',
        ),
      ).toHaveLength(1)
    })
    for (const corruption of [
      'wrong-owner',
      'duplicate-account',
      'duplicate-key',
      'deleted-grant',
      'contradictory-capture',
      'noncurrent-attempt',
    ] as const) {
      test(`rejects ${corruption} accepted facts without adding financial events`, async ({
        payload,
      }) => {
        const f = await workerFixture({ payload })
        if (corruption === 'wrong-owner') {
          await f.adapter.client.execute(
            `UPDATE media SET owner = owner + 100 WHERE id = ${f.mediaIds[0]}`,
          )
        }
        if (corruption === 'duplicate-account') {
          await duplicateRow({ f, table: 'credit_accounts' })
        }
        if (corruption === 'duplicate-key') {
          await duplicateRow({ f, table: 'credit_grants' })
        }
        if (corruption === 'deleted-grant') {
          await f.adapter.client.execute('UPDATE credit_grants SET is_deleted = 1')
        }
        if (corruption === 'contradictory-capture') {
          await duplicateRow({
            f,
            replacements: {
              event_key: "'capture:generation:' || " + f.taskId + " || ':' || grant_id",
              operation: "'capture'",
            },
            table: 'credit_ledger',
            where: "operation = 'reserve'",
          })
        }
        if (corruption === 'noncurrent-attempt') {
          f.state.engine = async () => ({ kind: 'unknown', requestId: null })
          await f.running.run({ taskId: f.taskId })
          await f.adapter.client.execute('UPDATE generation_attempts SET attempt_no = 99')
        }
        const ledger = await sqlRows(f, 'credit_ledger')
        const account = await sqlRows(f, 'credit_accounts')
        await expect(f.worker().run({ taskId: f.taskId })).rejects.toMatchObject({
          code: 'DATA_INTEGRITY_CONFLICT',
        })
        expect(await sqlRows(f, 'credit_ledger')).toEqual(ledger)
        expect(await sqlRows(f, 'credit_accounts')).toEqual(account)
        expect(f.state.calls).toBe(corruption === 'noncurrent-attempt' ? 1 : 0)
      })
    }
    test('terminal T2 replay validates the full capture graph rather than the succeeded label', async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      await f.running.run({ taskId: f.taskId })
      await f.adapter.client.execute("DELETE FROM credit_ledger WHERE operation = 'capture'")
      await expect(f.worker().run({ taskId: f.taskId })).rejects.toMatchObject({
        code: 'DATA_INTEGRITY_CONFLICT',
      })
      expect(f.state.calls).toBe(1)
      expect(
        (await sqlRows(f, 'credit_ledger')).filter((e) => e.operation === 'capture'),
      ).toHaveLength(0)
    })
    test('conditional update requires exactly one affected row and rolls back a zero-match transaction', async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      await expect(
        write({
          payload,
          work: ({ req, runtime }) =>
            runtime.updateExpected({
              id: f.taskId,
              collection: 'generation-tasks',
              data: { status: 'failed' },
              expected: { status: { equals: 'running' } },
              req,
            }),
        }),
      ).rejects.toThrow(/exactly one/)
      expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('queued')
    })
    test('blocked accepted owner facts do not become a front-door authorization dependency', async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      await f.adapter.client.execute("UPDATE users SET status = 'blocked'")
      await f.running.run({ taskId: f.taskId })
      expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('succeeded')
      await expect(
        f.admission.quoteGenerate({ input: f.input, sessionId: f.sessionId, userId: f.userId }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    })
    test('user-titled sessions are skipped without scheduling an AI naming job', async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      await update({
        id: f.sessionId,
        collection: 'creation-sessions',
        data: { title: 'My title', titleSource: 'user' },
        payload,
      })
      await f.running.run({ taskId: f.taskId })
      expect((await sqlRows(f, 'creation_sessions'))[0]).toMatchObject({
        auto_name_status: 'skipped',
        title: 'My title',
        title_source: 'user',
      })
      expect(
        (await sqlRows(f, 'payload_jobs')).filter((job) => job.task_slug === 'heymoro-name-v1'),
      ).toHaveLength(0)
    })
    test('fails closed for unregistered naming execution while keeping durable delivered work', async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      await f.running.run({ taskId: f.taskId })
      await payload.jobs.run({
        limit: 1,
        overrideAccess: true,
        queue: 'creation-naming',
        silent: true,
      })
      const job = (await sqlRows(f, 'payload_jobs')).find(
        (job) => job.task_slug === 'heymoro-name-v1',
      )!
      expect(job.has_error).toBe(1)
      expect(job.total_tried).toBe(1)
      expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe('succeeded')
    })
    for (const autoNameStatus of ['sending', 'unknown', 'succeeded'] as const) {
      test(`second T2 preserves ${autoNameStatus} naming evidence after the user sets a title`, async ({
        payload,
      }) => {
        const f = await workerFixture({ payload })
        await f.running.run({ taskId: f.taskId })
        await update({
          id: f.sessionId,
          collection: 'creation-sessions',
          data: {
            autoNameStartedAt: f.state.now,
            autoNameStatus,
            ...(autoNameStatus === 'succeeded' ? { autoNamedAt: f.state.now } : {}),
          },
          payload,
        })
        await update({
          id: f.sessionId,
          collection: 'creation-sessions',
          data: { title: 'User title after sending', titleSource: 'user' },
          payload,
        })
        const input = { ...f.input, inputMediaIds: f.mediaIds }
        const quote = await f.admission.quoteGenerate({
          input,
          sessionId: f.sessionId,
          userId: f.userId,
        })
        const second = await f.admission.submitGenerate({
          clientRequestId: 'second-naming-evidence',
          input,
          quoteToken: quote.quoteToken,
          sessionId: f.sessionId,
          userId: f.userId,
        })
        await f.running.run({ taskId: second.task.id })
        expect((await sqlRows(f, 'creation_sessions'))[0]).toMatchObject({
          auto_name_started_at: f.state.now,
          auto_name_status: autoNameStatus,
          title: 'User title after sending',
          title_source: 'user',
        })
        expect(
          (await sqlRows(f, 'payload_jobs')).filter((job) => job.task_slug === 'heymoro-name-v1'),
        ).toHaveLength(1)
        expect(f.state.calls).toBe(2)
      })
    }
  },
)

function loseCommitAck({
  f,
  payload,
  when,
}: {
  f: Awaited<ReturnType<typeof workerFixture>>
  payload: Payload
  when: (args: { collection: string; data: Record<string, unknown> }) => boolean
}) {
  let isArmed = false
  const originalUpdate = payload.update.bind(payload)
  vi.spyOn(payload, 'update').mockImplementation((async (args: {
    collection: string
    data: Record<string, unknown>
  }) => {
    const result = await originalUpdate(args as never)
    if (when(args)) {
      isArmed = true
    }
    return result
  }) as never)
  const original = f.adapter.client.transaction.bind(f.adapter.client)
  vi.spyOn(f.adapter.client, 'transaction').mockImplementation(async (...args: unknown[]) => {
    const [mode] = args
    if (mode !== undefined && mode !== 'read' && mode !== 'write' && mode !== 'deferred') {
      throw new Error('Invalid fixture transaction mode')
    }
    const transaction = await (mode === undefined ? original() : original(mode))
    return new Proxy(transaction, {
      get: (target: Transaction, property) => {
        if (property === 'commit') {
          return async () => {
            await target.commit()
            if (isArmed) {
              isArmed = false
              throw new Error('fixture ACK lost after actual COMMIT')
            }
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  })
}

async function duplicateRow({
  f,
  replacements = {},
  table,
  where = '1',
}: {
  f: Awaited<ReturnType<typeof workerFixture>>
  replacements?: Record<string, string>
  table: string
  where?: string
}) {
  const fields = (await f.adapter.client.execute(`PRAGMA table_info(${table})`)).rows
    .map((row) => String(row.name))
    .filter((name) => name !== 'id')
  await f.adapter.client.execute(
    `INSERT INTO ${table} (${fields.join(',')}) SELECT ${fields.map((field) => replacements[field] ?? field).join(',')} FROM ${table} WHERE ${where} LIMIT 1`,
  )
}
