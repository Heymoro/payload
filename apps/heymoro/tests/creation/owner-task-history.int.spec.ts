import { createClient } from '@libsql/client'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import {
  createPayloadOwnerTaskHistory,
  createTaskHistoryReader,
} from '../../src/creation/infrastructure/payload/owner-task-history-repository.js'
import { barrier, workerFixture } from './generation-worker-fixture.js'
import { cleanupLibrary, cursorKey, libraryFixture } from './library-fixture.js'
import { cleanupSQLiteFixture, gate, sqliteURL } from './sqlite.config.js'
test.suite('Heymoro owner task history', { config: './sqlite.config.ts', cron: false }, () => {
  test.afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupLibrary()
  })
  test.afterAll(() => cleanupSQLiteFixture())
  test('returns immutable original input and delivered artifact without wallet current template or draft reads', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    const find = vi.spyOn(payload, 'find')
    const result = await createPayloadOwnerTaskHistory({ cursorKey, payload }).get({
      taskId: f.taskId,
      userId: f.userId,
    })
    expect(result.status).toBe('succeeded')
    expect(result.input).toEqual({ ...f.input, inputMediaIds: f.mediaIds })
    expect(result.artifactIds).toEqual([f.artifacts[0]!.id])
    expect(result.inputAvailability).toEqual(
      f.mediaIds.map((mediaId, index) => ({ mediaId, position: index + 1, status: 'active' })),
    )
    expect(result.resolution).toBeNull()
    expect(Object.isFrozen(result)).toBe(true)
    expect(
      find.mock.calls.every(([args]) => !/credit|draft|template/.test(String(args.collection))),
    ).toBe(true)
  })

  test('first page returns latest twenty including current inflight and older page has no gaps or side effects', async ({
    payload,
  }) => {
    const f = await libraryFixture({ count: 20, payload })
    const input = { ...f.input, inputMediaIds: f.mediaIds }
    const quote = await f.admission.quoteGenerate({
      input,
      sessionId: f.sessionId,
      userId: f.userId,
    })
    const accepted = await f.admission.submitGenerate({
      clientRequestId: 'latest-pending',
      input,
      quoteToken: quote.quoteToken,
      sessionId: f.sessionId,
      userId: f.userId,
    })
    const service = createPayloadOwnerTaskHistory({ cursorKey, payload })
    const find = vi.spyOn(payload, 'find')
    const writes = [
      vi.spyOn(payload, 'create'),
      vi.spyOn(payload, 'update'),
      vi.spyOn(payload, 'delete'),
    ]
    const redis = vi.spyOn(f.redis.client, 'sendCommand')
    const storageRequests = f.http.requests.length
    const page = await service.list({ query: {}, sessionId: f.sessionId, userId: f.userId })
    expect(page.items.map((item) => item.roundNo)).toEqual(
      Array.from({ length: 20 }, (_, i) => 21 - i),
    )
    expect(page.items[0]!.id).toBe(accepted.task.id)
    expect(page.items[0]!.status).toBe('queued')
    expect(page.hasMore).toBe(true)
    expect(find.mock.calls.length).toBeLessThanOrEqual(19)
    const reqs = find.mock.calls.map(([args]) => args.req)
    expect(new Set(reqs).size).toBe(1)
    for (const [args] of find.mock.calls) {
      expect(/credit|draft|template|payload-jobs/.test(String(args.collection))).toBe(false)
      expect(() =>
        gate.assert({ req: args.req as Parameters<typeof gate.assert>[0]['req'] }),
      ).toThrow('capability')
    }
    expect(redis).not.toHaveBeenCalled()
    expect(f.http.requests).toHaveLength(storageRequests)
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled()
    }
    const older = await service.list({
      query: { cursor: page.nextCursor },
      sessionId: f.sessionId,
      userId: f.userId,
    })
    expect(older.items.map((item) => item.roundNo)).toEqual([1])
    expect(older.hasMore).toBe(false)
    expect(older.nextCursor).toBeNull()
    const json = JSON.stringify(page)
    for (const secret of [
      'executionSnapshot',
      'PRIVATE SYSTEM',
      'sha256',
      'storageName',
      'createdBy',
      'fixture-output',
    ]) {
      expect(json).not.toContain(secret)
    }
  })
  for (const status of ['queued', 'running', 'failed', 'unknown', 'closed'] as const) {
    test(`projects real ${status} state without hand-built successful evidence`, async ({
      payload,
    }) => {
      const f = await workerFixture({ payload })
      const wait = barrier()
      let running: Promise<unknown> | undefined
      if (status === 'running') {
        f.state.engine = async () => {
          wait.enter()
          await wait.released
          return { kind: 'unknown', requestId: null }
        }
        running = f.running.run({ taskId: f.taskId })
        await wait.entered
      } else if (status === 'failed') {
        f.state.engine = async () => ({ kind: 'rejected', requestId: null })
        await f.running.run({ taskId: f.taskId })
      } else if (status === 'unknown' || status === 'closed') {
        f.state.engine = async () => ({ kind: 'unknown', requestId: null })
        await f.running.run({ taskId: f.taskId })
        if (status === 'closed') {
          await f.running.closeUnknown({
            operationId: 'history-close',
            reason: 'PROVIDER_UNRESOLVED',
            taskId: f.taskId,
          })
        }
      }
      try {
        const result = await createPayloadOwnerTaskHistory({ cursorKey, payload }).get({
          taskId: f.taskId,
          userId: f.userId,
        })
        expect(result.status).toBe(status)
        expect(result.artifactIds).toEqual([])
        expect(result.input.inputMediaIds).toEqual(f.mediaIds)
        if (status === 'closed') {
          expect(result.resolution).toEqual({
            closedAt: f.state.now,
            reason: 'UNKNOWN_CLOSED',
            releasedAvailableCredits: 2,
            releasedExpiredCredits: 0,
          })
        } else {
          expect(result.resolution).toBeNull()
        }
      } finally {
        wait.release()
        await running
      }
    })
  }
  for (const cost of [0, 2]) {
    test(`reads historical mixed expiry and zero cost release graph cost=${cost} without today's reinterpretation`, async ({
      payload,
    }) => {
      const f = await workerFixture({
        cost,
        grants: cost
          ? [
              { amount: 1, expiresAt: '2026-11-12T12:01:00.000Z' },
              { amount: 1, expiresAt: null },
            ]
          : [],
        payload,
      })
      f.state.engine = async () => ({ kind: 'unknown', requestId: null })
      await f.running.run({ taskId: f.taskId })
      f.state.now = '2026-11-12T12:02:00.000Z'
      await f.running.closeUnknown({
        operationId: 'mixed-close',
        reason: 'PROVIDER_UNRESOLVED',
        taskId: f.taskId,
      })
      const find = vi.spyOn(payload, 'find')
      const result = await createPayloadOwnerTaskHistory({ cursorKey, payload }).get({
        taskId: f.taskId,
        userId: f.userId,
      })
      expect(result.resolution).toEqual({
        closedAt: f.state.now,
        reason: 'UNKNOWN_CLOSED',
        releasedAvailableCredits: cost ? 1 : 0,
        releasedExpiredCredits: cost ? 1 : 0,
      })
      const grantCalls = find.mock.calls.filter(
        ([args]) => String(args.collection) === 'credit-grants',
      )
      if (cost) {
        expect(grantCalls).toHaveLength(2)
      } else {
        expect(grantCalls).toHaveLength(0)
      }
    })
  }
  test('preserves missing deleted inactive reference slots and literal text after current template withdrawal', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    await f.adapter.client.execute("UPDATE creation_templates SET status='offline'")
    await f.adapter.client.execute("UPDATE creation_templates SET status='offline'")
    await f.adapter.client.execute(`DELETE FROM media WHERE id=${f.mediaIds[0]}`)
    await f.adapter.client.execute(
      `UPDATE media SET lifecycle='inactive' WHERE id=${f.mediaIds[1]}`,
    )
    const result = await createPayloadOwnerTaskHistory({ cursorKey, payload }).get({
      taskId: f.taskId,
      userId: f.userId,
    })
    expect(result.input).toEqual({ ...f.input, inputMediaIds: f.mediaIds })
    expect(result.inputAvailability.map((row) => row.status)).toEqual([
      'unavailable',
      'unavailable',
    ])
    await f.adapter.client.execute(
      `UPDATE media SET is_deleted=1,deleted_at=created_at,deleted_by=created_by WHERE id=${f.mediaIds[1]}`,
    )
    expect(
      (
        await createPayloadOwnerTaskHistory({ cursorKey, payload }).get({
          taskId: f.taskId,
          userId: f.userId,
        })
      ).inputAvailability.map((row) => row.status),
    ).toEqual(['unavailable', 'unavailable'])
    await f.adapter.client.execute(`UPDATE media SET owner=owner+999 WHERE id=${f.mediaIds[1]}`)
    await expect(
      createPayloadOwnerTaskHistory({ cursorKey, payload }).get({
        taskId: f.taskId,
        userId: f.userId,
      }),
    ).rejects.toMatchObject({ status: 503 })
  })
  test('allows known normal task and parent tombstones skips task in list and leaves B1 inaccessible', async ({
    payload,
  }) => {
    const f = await libraryFixture({ count: 3, payload })
    await f.adapter.client.execute(
      'UPDATE creation_sessions SET is_deleted=1,deleted_at=created_at,deleted_by=created_by',
    )
    await f.adapter.client.execute(
      `UPDATE generation_tasks SET is_deleted=1,deleted_at=created_at,deleted_by=created_by WHERE id=${f.taskId}`,
    )
    const service = createPayloadOwnerTaskHistory({ cursorKey, payload })
    expect((await service.get({ taskId: f.taskId, userId: f.userId })).artifactIds).toEqual([
      f.artifacts[0]!.id,
    ])
    expect(
      (await service.list({ query: {}, sessionId: f.sessionId, userId: f.userId })).items.map(
        (row) => row.roundNo,
      ),
    ).toEqual([3, 2])
  })
  test('normal Artifact tombstone hides IDs without querying old output media but physical absence is corruption', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    await f.adapter.client.execute(
      'UPDATE artifacts SET is_deleted=1,deleted_at=created_at,deleted_by=created_by',
    )
    await f.adapter.client.execute("DELETE FROM media WHERE purpose='artifact'")
    const service = createPayloadOwnerTaskHistory({ cursorKey, payload })
    expect((await service.get({ taskId: f.taskId, userId: f.userId })).artifactIds).toEqual([])
    await f.adapter.client.execute('DELETE FROM artifacts')
    await expect(service.get({ taskId: f.taskId, userId: f.userId })).rejects.toMatchObject({
      status: 503,
    })
  })
  test('binds cursors to actor session page size and rejects malformed args before IO', async ({
    payload,
  }) => {
    const f = await libraryFixture({ count: 2, payload })
    const service = createPayloadOwnerTaskHistory({ cursorKey, pageSize: 1, payload })
    const page = await service.list({ query: {}, sessionId: f.sessionId, userId: f.userId })
    const find = vi.spyOn(payload, 'find')
    for (const args of [
      { query: { cursor: page.nextCursor }, sessionId: f.sessionId, userId: f.userId + 99 },
      { query: { cursor: page.nextCursor }, sessionId: f.sessionId + 99, userId: f.userId },
      {
        query: { cursor: page.nextCursor!.slice(0, -2) + 'AA' },
        sessionId: f.sessionId,
        userId: f.userId,
      },
      { query: { unexpected: 'x' }, sessionId: f.sessionId, userId: f.userId },
    ]) {
      await expect(service.list(args)).rejects.toMatchObject({ status: 400 })
    }
    await expect(
      createPayloadOwnerTaskHistory({ cursorKey, payload }).list({
        query: { cursor: page.nextCursor },
        sessionId: f.sessionId,
        userId: f.userId,
      }),
    ).rejects.toMatchObject({ status: 400 })
    expect(find).not.toHaveBeenCalled()
  })
  test('returns uniform missing foreign 404 and gates disabled current actor', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    const other = await payload.create({
      collection: 'users',
      data: { status: 'active' } as never,
      overrideAccess: true,
    })
    const service = createPayloadOwnerTaskHistory({ cursorKey, payload })
    for (const operation of [
      () => service.get({ taskId: f.taskId, userId: other.id }),
      () => service.get({ taskId: f.taskId + 999, userId: f.userId }),
      () => service.list({ query: {}, sessionId: f.sessionId, userId: other.id }),
      () => service.list({ query: {}, sessionId: f.sessionId + 999, userId: f.userId }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ status: 404 })
    }
    await f.adapter.client.execute("UPDATE users SET status='disabled'")
    await expect(service.get({ taskId: f.taskId, userId: f.userId })).rejects.toMatchObject({
      status: 401,
    })
  })
  const corruptions = [
    ['bad parent', 'UPDATE creation_sessions SET user_id=user_id+99'],
    ['missing parent', 'DELETE FROM creation_sessions'],
    ['wrong mode', "UPDATE creation_sessions SET mode='free'"],
    ['bad task tombstone', 'UPDATE generation_tasks SET is_deleted=1'],
    ['bad input group', 'UPDATE generation_inputs SET user_id=user_id+99'],
    ['bad input position', 'UPDATE generation_inputs SET position=9'],
    ['bad input snapshot', "UPDATE generation_inputs SET content_sha256='wrong'"],
    [
      'deleted input',
      'UPDATE generation_inputs SET is_deleted=1,deleted_at=created_at,deleted_by=created_by',
    ],
    ['wrong reference locator', "UPDATE media SET storage_name='wrong' WHERE purpose='reference'"],
    ['wrong reference MIME', "UPDATE media SET mime_type='image/jpeg' WHERE purpose='reference'"],
    ['wrong reference size', "UPDATE media SET filesize=1 WHERE purpose='reference'"],
    ['wrong reference SHA', "UPDATE media SET sha256='wrong' WHERE purpose='reference'"],
    [
      'bad active reference purpose',
      "UPDATE media SET purpose='artifact' WHERE purpose='reference'",
    ],
    [
      'deleted attempt',
      'UPDATE generation_attempts SET is_deleted=1,deleted_at=created_at,deleted_by=created_by',
    ],
    ['wrong attempt provider', "UPDATE generation_attempts SET provider='wrong'"],
    ['wrong task error', "UPDATE generation_tasks SET error_code='NOT_SENT'"],
    ['wrong task time', 'UPDATE generation_tasks SET started_at=NULL'],
    ['wrong artifact parent', 'UPDATE artifacts SET session_id=session_id+99'],
    ['bad artifact tombstone', 'UPDATE artifacts SET is_deleted=1'],
  ] as const
  for (const [name, sql] of corruptions) {
    test(`rejects ${name} evidence`, async ({ payload }) => {
      const f = await libraryFixture({ payload })
      await f.adapter.client.execute(sql)
      await expect(
        createPayloadOwnerTaskHistory({ cursorKey, payload }).get({
          taskId: f.taskId,
          userId: f.userId,
        }),
      ).rejects.toMatchObject({ status: 503 })
    })
  }
  const closedCorruptions = [
    ['wrong reservation key', "UPDATE credit_reservations SET reservation_key='wrong'"],
    ['wrong reservation amount', 'UPDATE credit_reservations SET amount_credits=99'],
    ['wrong settlement time', 'UPDATE credit_reservations SET settled_at=NULL'],
    [
      'deleted allocation',
      'UPDATE credit_allocations SET is_deleted=1,deleted_at=created_at,deleted_by=created_by',
    ],
    ['missing release', "DELETE FROM credit_ledger WHERE operation='release'"],
    [
      'bad release reason',
      "UPDATE credit_ledger SET reason_code='WRONG' WHERE operation='release'",
    ],
    [
      'wrong release association',
      "UPDATE credit_ledger SET reservation_id=reservation_id+99 WHERE operation='release'",
    ],
    [
      'wrong reserve association',
      "UPDATE credit_ledger SET reservation_id=reservation_id+99 WHERE operation='reserve'",
    ],
    ['bad release delta', "UPDATE credit_ledger SET consumed_delta=1 WHERE operation='release'"],
    [
      'deleted ledger',
      "UPDATE credit_ledger SET is_deleted=1,deleted_at=created_at,deleted_by=created_by WHERE operation='release'",
    ],
    ['wrong account', 'UPDATE credit_accounts SET user_id=user_id+99'],
    ['wrong grant', 'UPDATE credit_grants SET user_id=user_id+99'],
    ['wrong audit type', "UPDATE audit_logs SET resource_type='wrong'"],
    ['bad audit outcome', "UPDATE audit_logs SET result='failure'"],
    [
      'deleted audit',
      'UPDATE audit_logs SET is_deleted=1,deleted_at=created_at,deleted_by=created_by',
    ],
    ['missing audit', 'DELETE FROM audit_logs'],
    [
      'bad before state',
      `UPDATE audit_logs SET before_state='{"attemptId":999,"status":"unknown"}'`,
    ],
  ] as const
  for (const [name, sql] of closedCorruptions) {
    test(`rejects closed ${name}`, async ({ payload }) => {
      const f = await workerFixture({ payload })
      f.state.engine = async () => ({ kind: 'unknown', requestId: null })
      await f.running.run({ taskId: f.taskId })
      await f.running.closeUnknown({
        operationId: 'corrupt-close',
        reason: 'PROVIDER_UNRESOLVED',
        taskId: f.taskId,
      })
      await f.adapter.client.execute(sql)
      await expect(
        createPayloadOwnerTaskHistory({ cursorKey, payload }).get({
          taskId: f.taskId,
          userId: f.userId,
        }),
      ).rejects.toMatchObject({ status: 503 })
    })
  }
  test('holds one snapshot under second SQLite connection mutations', async ({ payload }) => {
    const f = await libraryFixture({ payload })
    const other = createClient({ url: sqliteURL })
    const original = payload.find.bind(payload)
    let changed = false
    vi.spyOn(payload, 'find').mockImplementation(async (args) => {
      const result = await original(args)
      if (!changed && String(args.collection) === 'generation-tasks') {
        changed = true
        await other.execute("UPDATE generation_inputs SET content_sha256='changed'")
      }
      return result
    })
    const service = createPayloadOwnerTaskHistory({ cursorKey, payload })
    try {
      expect((await service.get({ taskId: f.taskId, userId: f.userId })).status).toBe('succeeded')
      await expect(service.get({ taskId: f.taskId, userId: f.userId })).rejects.toMatchObject({
        status: 503,
      })
    } finally {
      other.close()
    }
  })
  test('gates every selected schema field synchronously with zero database calls', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    const find = vi.spyOn(payload, 'find')
    const transaction = vi.spyOn(f.adapter.client, 'transaction')
    for (const [slug, name] of [
      ['generation-tasks', 'roundNo'],
      ['generation-inputs', 'contentSha256'],
      ['generation-attempts', 'leaseUntil'],
      ['credit-ledger', 'reasonCode'],
      ['auditLogs', 'beforeState'],
      ['media', 'deletedAt'],
    ] as const) {
      const config = (payload.collections as Record<string, typeof payload.collections.users>)[
        slug
      ]!.config
      const fields = config.flattenedFields
      config.flattenedFields = fields.filter((field) => field.name !== name)
      try {
        expect(() => createPayloadOwnerTaskHistory({ cursorKey, payload })).toThrow()
      } finally {
        config.flattenedFields = fields
      }
    }
    expect(find).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })
  test('rejects truncated complete batch and reused LibraryReader totals', async ({ payload }) => {
    const f = await libraryFixture({ payload })
    const original = payload.find.bind(payload)
    for (const collection of ['generation-inputs', 'generation-attempts', 'media', 'artifacts']) {
      vi.spyOn(payload, 'find').mockImplementation(async (args) => {
        const result = await original(args)
        return String(args.collection) === collection
          ? { ...result, docs: [], totalDocs: 1 }
          : result
      })
      await expect(
        createPayloadOwnerTaskHistory({ cursorKey, payload }).get({
          taskId: f.taskId,
          userId: f.userId,
        }),
      ).rejects.toMatchObject({ status: 503 })
      vi.restoreAllMocks()
    }
  })
  test('preserves original Error and AggregateError through snapshot and concrete reader', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    for (const error of [
      new Error('fixture transport'),
      new AggregateError([new Error('fixture db')]),
    ]) {
      vi.spyOn(payload, 'find').mockRejectedValue(error)
      await expect(
        createPayloadOwnerTaskHistory({ cursorKey, payload }).get({
          taskId: f.taskId,
          userId: f.userId,
        }),
      ).rejects.toBe(error)
      vi.restoreAllMocks()
      const reader = createTaskHistoryReader({
        find: async () => {
          throw error
        },
      })
      await expect(reader.inputs({ taskIds: [f.taskId] })).rejects.toBe(error)
    }
  })
  const duplicateCases = [
    ['generation_tasks', 'round tuple', 'user_id+999 AS user_id', false],
    ['generation_tasks', 'request tuple', 'round_no+100 AS round_no', false],
    ['generation_inputs', 'input slot', 'position', false],
    ['generation_attempts', 'attempt sequence', 'attempt_no', false],
    ['artifacts', 'Artifact tuple', 'task_id', false],
    ['media', 'global locator', 'storage_name', false],
    ['credit_reservations', 'reservation key with wrong task', 'task_id+999 AS task_id', true],
    ['credit_grants', 'global grant key', 'account_id+999 AS account_id', true],
    [
      'credit_ledger',
      'global ledger key with wrong reservation',
      'reservation_id+999 AS reservation_id',
      true,
    ],
    ['audit_logs', 'closure action and resource wrong type', "'wrong' AS resource_type", true],
  ] as const
  for (const [table, name, expression, isClosed] of duplicateCases) {
    test(`detects global deleted duplicate ${name}`, async ({ payload }) => {
      const f = await workerFixture({ payload })
      if (isClosed) {
        f.state.engine = async () => ({ kind: 'unknown', requestId: null })
        await f.running.run({ taskId: f.taskId })
        await f.running.closeUnknown({
          operationId: 'duplicate-close',
          reason: 'PROVIDER_UNRESOLVED',
          taskId: f.taskId,
        })
      } else {
        await f.running.run({ taskId: f.taskId })
      }
      const fields = (await f.adapter.client.execute(`PRAGMA table_info("${table}")`)).rows
        .map((row) => String(row.name))
        .filter((name) => name !== 'id')
      const overrideName = expression.includes(' AS ') ? expression.split(' AS ')[1]! : expression
      const select = fields.map((name) =>
        name === 'is_deleted'
          ? '1'
          : name === 'deleted_at'
            ? 'created_at'
            : name === 'deleted_by'
              ? 'created_by'
              : name === overrideName
                ? expression.split(' AS ')[0]
                : `"${name}"`,
      )
      const where =
        table === 'media'
          ? ` WHERE id=${f.mediaIds[0]}`
          : table === 'credit_ledger'
            ? " WHERE operation='release'"
            : ''
      await f.adapter.client.execute(
        `INSERT INTO "${table}" (${fields.map((name) => `"${name}"`).join(',')}) SELECT ${select.join(',')} FROM "${table}"${where} LIMIT 1`,
      )
      await expect(
        createPayloadOwnerTaskHistory({ cursorKey, payload }).get({
          taskId: f.taskId,
          userId: f.userId,
        }),
      ).rejects.toMatchObject({ status: 503 })
    })
  }
  test('real scan budget permits tombstone empty page continuation without compressing round gaps', async ({
    payload,
  }) => {
    const f = await libraryFixture({ count: 4, payload })
    await f.adapter.client.execute(
      'UPDATE generation_tasks SET is_deleted=1,deleted_at=created_at,deleted_by=created_by WHERE round_no>=3',
    )
    const service = createPayloadOwnerTaskHistory({
      cursorKey,
      pageSize: 1,
      payload,
      scanBudget: 2,
    })
    const first = await service.list({ query: {}, sessionId: f.sessionId, userId: f.userId })
    expect(first.items).toEqual([])
    expect(first.hasMore).toBe(true)
    const next = await service.list({
      query: { cursor: first.nextCursor },
      sessionId: f.sessionId,
      userId: f.userId,
    })
    expect(next.items.map((row) => row.roundNo)).toEqual([2])
    await f.adapter.client.execute('DELETE FROM generation_tasks WHERE round_no=3')
    expect(
      (
        await createPayloadOwnerTaskHistory({ cursorKey, payload }).list({
          query: {},
          sessionId: f.sessionId,
          userId: f.userId,
        })
      ).items.map((row) => row.roundNo),
    ).toEqual([2, 1])
  })
  test('non-success rejects even normally deleted Artifact facts', async ({ payload }) => {
    const f = await workerFixture({ payload })
    f.state.engine = async () => ({ kind: 'unknown', requestId: null })
    await f.running.run({ taskId: f.taskId })
    await f.adapter.client.execute(
      `INSERT INTO artifacts(user_id,session_id,task_id,media_id,output_index,created_at,updated_at,created_by,updated_by,is_deleted,deleted_at,deleted_by) VALUES(${f.userId},${f.sessionId},${f.taskId},999,1,'${f.state.now}','${f.state.now}','system:fixture','system:fixture',1,'${f.state.now}','system:fixture')`,
    )
    await expect(
      createPayloadOwnerTaskHistory({ cursorKey, payload }).get({
        taskId: f.taskId,
        userId: f.userId,
      }),
    ).rejects.toMatchObject({ status: 503 })
  })

  test('zero cost still rejects global-prefix extra capture even with wrong reservation association', async ({
    payload,
  }) => {
    const f = await workerFixture({ cost: 0, payload })
    f.state.engine = async () => ({ kind: 'unknown', requestId: null })
    await f.running.run({ taskId: f.taskId })
    await f.running.closeUnknown({
      operationId: 'zero-extra',
      reason: 'PROVIDER_UNRESOLVED',
      taskId: f.taskId,
    })
    await f.adapter.client.execute(
      `INSERT INTO credit_ledger(user_id,account_id,grant_id,reservation_id,event_key,operation,amount_credits,available_delta,reserved_delta,consumed_delta,expired_delta,revoked_delta,reason_code,created_at,updated_at,created_by,updated_by,is_deleted) SELECT user_id,account_id,999,id+999,'capture:generation:${f.taskId}:999','capture',1,0,-1,1,0,0,'GENERATION_CAPTURED',created_at,updated_at,created_by,updated_by,0 FROM credit_reservations WHERE task_id=${f.taskId}`,
    )
    await expect(
      createPayloadOwnerTaskHistory({ cursorKey, payload }).get({
        taskId: f.taskId,
        userId: f.userId,
      }),
    ).rejects.toMatchObject({ status: 503 })
  })
  test('all projected target and reused Library selected fields have constructor schema gates without IO', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    const find = vi.spyOn(payload, 'find')
    const transaction = vi.spyOn(f.adapter.client, 'transaction')
    const fieldsBySlug: Record<string, string[]> = {
      artifacts: ['userId', 'taskId', 'sessionId', 'mediaId', 'outputIndex', 'createdAt'],
      auditLogs: [
        'action',
        'resourceId',
        'resourceType',
        'result',
        'correlationId',
        'requestId',
        'beforeState',
        'afterState',
      ],
      'creation-sessions': ['userId', 'templateId', 'mode', 'nextRoundNo'],
      'credit-accounts': ['userId'],
      'credit-allocations': ['reservationId', 'grantId', 'status', 'amountCredits'],
      'credit-grants': [
        'userId',
        'accountId',
        'grantKey',
        'sourceType',
        'sourceId',
        'validFrom',
        'expiresAt',
        'issuedCredits',
        'availableCredits',
        'reservedCredits',
        'consumedCredits',
        'expiredCredits',
        'revokedCredits',
      ],
      'credit-ledger': [
        'userId',
        'accountId',
        'grantId',
        'reservationId',
        'eventKey',
        'operation',
        'reasonCode',
        'amountCredits',
        'availableDelta',
        'reservedDelta',
        'consumedDelta',
        'expiredDelta',
        'revokedDelta',
      ],
      'credit-reservations': [
        'userId',
        'accountId',
        'taskId',
        'reservationKey',
        'status',
        'amountCredits',
        'settledAt',
      ],
      'generation-attempts': [
        'taskId',
        'attemptNo',
        'provider',
        'model',
        'status',
        'errorCode',
        'leaseUntil',
        'resultStorageBackend',
        'resultStorageBucket',
        'resultStorageKey',
        'resultSha256',
      ],
      'generation-inputs': ['userId', 'taskId', 'mediaId', 'position', 'contentSha256'],
      'generation-tasks': [
        'userId',
        'sessionId',
        'sourceTaskId',
        'roundNo',
        'clientRequestId',
        'status',
        'costCredits',
        'errorCode',
        'description',
        'userNotes',
        'executionSnapshotJson',
        'requestHash',
        'createdAt',
        'startedAt',
        'finishedAt',
      ],
      media: [
        'owner',
        'lifecycle',
        'purpose',
        'visibility',
        'mimeType',
        'filesize',
        'sha256',
        'storageBackend',
        'storageBucket',
        'storageName',
        'width',
        'height',
      ],
      'saved-artifacts': [
        'userId',
        'artifactId',
        'savedAt',
        'createdAt',
        'updatedAt',
        'createdBy',
        'updatedBy',
      ],
      users: ['status'],
    }
    for (const [slug, names] of Object.entries(fieldsBySlug)) {
      const config = (payload.collections as Record<string, typeof payload.collections.users>)[
        slug
      ]!.config
      const fields = config.flattenedFields
      const deletion = slug === 'users' ? ['isDeleted'] : ['isDeleted', 'deletedAt', 'deletedBy']
      for (const name of [...names, ...deletion]) {
        config.flattenedFields = fields.filter((field) => field.name !== name)
        try {
          expect(
            () => createPayloadOwnerTaskHistory({ cursorKey, payload }),
            `${slug}.${name}`,
          ).toThrow()
        } finally {
          config.flattenedFields = fields
        }
      }
    }
    expect(find).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })
})
