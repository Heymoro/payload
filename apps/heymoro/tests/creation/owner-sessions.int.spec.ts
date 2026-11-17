import type { Payload } from 'payload'

import { createClient } from '@libsql/client'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createPayloadDraftService } from '../../src/creation/infrastructure/payload/draft-repository.js'
import {
  createPayloadOwnerSessions,
  createSessionsReader,
} from '../../src/creation/infrastructure/payload/owner-sessions-repository.js'
import { createPayloadSessionCreator } from '../../src/creation/infrastructure/payload/session-repository.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { audit, caps, NOW, seed, write } from './generation-fixture.js'
import { barrier } from './generation-worker-fixture.js'
import { cleanupLibrary, cursorKey, libraryFixture } from './library-fixture.js'
import { cleanupSQLiteFixture, gate, sqliteURL } from './sqlite.config.js'

const summaryFields = [
  'id',
  'title',
  'titleSource',
  'mode',
  'templateId',
  'lastActivityAt',
  'cover',
  'runningTask',
].sort()
async function emptySessions({ count = 1, payload }: { count?: number; payload: Payload }) {
  const f = await seed({ cost: 0, payload })
  const adapter = getCreationSQLiteAdapter({ payload })
  await adapter.client.execute(
    `UPDATE creation_sessions SET is_deleted=1,deleted_at=created_at,deleted_by=created_by WHERE id=${f.sessionId}`,
  )
  const creator = createPayloadSessionCreator({
    clock: () => NOW,
    coordinate: async ({ work }) => work({ assertLease: () => {} }),
    gate,
    hostCaps: caps,
    isCompatible: () => true,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  })
  const sessionIds: number[] = []
  for (let i = 0; i < count; i++) {
    const result = await creator({
      command: {
        clientRequestId: `history-${i}`,
        templateId: f.templateId,
      },
      userId: f.userId,
    })
    sessionIds.push(result.session.id)
  }
  const service = createPayloadOwnerSessions({ cursorKey, payload })
  return { ...f, adapter, service, sessionIds }
}
async function deliveredDraft({ payload }: { payload: Payload }) {
  const f = await libraryFixture({ payload })
  // generationFixture deliberately seeds no draft; add a controlled real empty draft for its existing worker session.
  await write({
    payload,
    work: ({ req, runtime }) =>
      runtime.create({
        collection: 'creation-drafts',
        data: {
          ...audit,
          description: '',
          sessionId: f.sessionId,
          userId: f.userId,
          userNotes: '',
        },
        req,
      }),
  })
  return { ...f, service: createPayloadOwnerSessions({ cursorKey, payload }) }
}

test.suite('Heymoro owner session history', { config: './sqlite.config.ts', cron: false }, () => {
  test.afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupLibrary()
  })
  test.afterAll(() => cleanupSQLiteFixture())
  test('should list twenty of twenty-one formally created empty sessions with bounded queries and no side effects', async ({
    payload,
  }) => {
    const f = await emptySessions({ count: 21, payload })
    const find = vi.spyOn(payload, 'find')
    const writes = [
      vi.spyOn(payload, 'create'),
      vi.spyOn(payload, 'update'),
      vi.spyOn(payload, 'delete'),
    ]
    const page = await f.service.list({ query: {}, userId: f.userId })
    expect(page.items.map((item) => item.id)).toEqual([...f.sessionIds].reverse().slice(0, 20))
    expect(page.hasMore).toBe(true)
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual(summaryFields)
      expect(item.cover).toBeNull()
      expect(item.runningTask).toBeNull()
      expect(Object.isFrozen(item)).toBe(true)
    }
    expect(find.mock.calls.length).toBeLessThanOrEqual(4)
    expect(
      find.mock.calls.every(
        ([args]) => !/credit|wallet|grant|ledger|draft|attempt/.test(String(args.collection)),
      ),
    ).toBe(true)
    for (const [args] of find.mock.calls) {
      expect(() =>
        gate.assert({ req: args.req as Parameters<typeof gate.assert>[0]['req'] }),
      ).toThrow('capability')
    }
    for (const spy of writes) {
      expect(spy).not.toHaveBeenCalled()
    }
    const next = await f.service.list({ query: { cursor: page.nextCursor }, userId: f.userId })
    expect(next.items.map((item) => item.id)).toEqual([f.sessionIds[0]])
    expect(next.hasMore).toBe(false)
    expect(next.nextCursor).toBeNull()
    const detail = await f.service.get({ sessionId: f.sessionIds[0]!, userId: f.userId })
    expect(Object.keys(detail).sort()).toEqual(
      [...summaryFields, 'creationClientRequestId', 'draft'].sort(),
    )
    expect(detail.creationClientRequestId).toBe('history-0')
    expect(detail.draft.input).toEqual({ description: '', inputMediaIds: [], userNotes: '' })
  })
  test('should batch real multi-round worker cover delivery without Redis S3 queue or financial IO', async ({
    payload,
  }) => {
    const f = await libraryFixture({ count: 2, payload })
    const service = createPayloadOwnerSessions({ cursorKey, payload })
    const find = vi.spyOn(payload, 'find')
    const writes = [
      vi.spyOn(payload, 'create'),
      vi.spyOn(payload, 'update'),
      vi.spyOn(payload, 'delete'),
    ]
    const redis = vi.spyOn(f.redis.client, 'sendCommand')
    const storageRequests = f.http.requests.length
    const page = await service.list({ query: {}, userId: f.userId })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.cover?.id).toBe(f.artifacts[1]!.id)
    expect(page.items[0]!.runningTask).toBeNull()
    expect(find.mock.calls.length).toBeLessThanOrEqual(12)
    expect(
      find.mock.calls.every(
        ([args]) => !/credit|wallet|grant|ledger|draft|payload-jobs/.test(String(args.collection)),
      ),
    ).toBe(true)
    for (const spy of writes) {
      expect(spy).not.toHaveBeenCalled()
    }
    expect(redis).not.toHaveBeenCalled()
    expect(f.http.requests).toHaveLength(storageRequests)
    const json = JSON.stringify(page)
    for (const secret of [
      'executionSnapshot',
      'PRIVATE SYSTEM INSTRUCTION',
      'storageBackend',
      'fixture-output',
      'createdBy',
      'clientRequestId',
      'autoNameStatus',
    ]) {
      expect(json).not.toContain(secret)
    }
  })
  test('should restore literal draft and inactive ordered media after template withdrawal without overwriting', async ({
    payload,
  }) => {
    const f = await deliveredDraft({ payload })
    const drafts = createPayloadDraftService({ ...f.options, hostCaps: caps })
    const saved = await drafts.save({
      input: {
        description: '',
        inputMediaIds: [...f.mediaIds].reverse(),
        userNotes: '  原文字\n  ',
      },
      sessionId: f.sessionId,
      userId: f.userId,
    })
    await f.adapter.client.execute("UPDATE creation_templates SET status='offline',name='MUTATED'")
    await f.adapter.client.execute("UPDATE creation_templates SET status='offline'")
    await f.adapter.client.execute(
      "UPDATE media SET lifecycle='inactive',is_deleted=1 WHERE purpose='reference'",
    )
    const writes = [
      vi.spyOn(payload, 'create'),
      vi.spyOn(payload, 'update'),
      vi.spyOn(payload, 'delete'),
    ]
    const detail = await f.service.get({ sessionId: f.sessionId, userId: f.userId })
    expect(detail.title).toBe('Fixture')
    expect(detail.templateId).toBe(f.templateId)
    expect(Object.hasOwn(detail, 'templateVersionId')).toBe(false)
    expect(detail.draft).toEqual(saved)
    expect(detail.cover?.id).toBe(f.artifacts[0]!.id)
    for (const spy of writes) {
      expect(spy).not.toHaveBeenCalled()
    }
  })
  for (const status of ['queued', 'running', 'unknown']) {
    test(`should project actual ${status} task with minimal running summary`, async ({
      payload,
    }) => {
      const f = await libraryFixture({ payload })
      const input = { ...f.input, inputMediaIds: f.mediaIds }
      const quote = await f.admission.quoteGenerate({
        input,
        sessionId: f.sessionId,
        userId: f.userId,
      })
      const accepted = await f.admission.submitGenerate({
        clientRequestId: 'second-round',
        input,
        quoteToken: quote.quoteToken,
        sessionId: f.sessionId,
        userId: f.userId,
      })
      const wait = barrier()
      let running: Promise<unknown> | undefined
      if (status === 'running') {
        f.state.engine = async () => {
          wait.enter()
          await wait.released
          return { kind: 'unknown', requestId: null }
        }
        running = f.running.run({ taskId: accepted.task.id })
        await wait.entered
      } else if (status === 'unknown') {
        f.state.engine = async () => ({ kind: 'unknown', requestId: null })
        await f.running.run({ taskId: accepted.task.id })
      }
      try {
        const result = await createPayloadOwnerSessions({ cursorKey, payload }).list({
          query: {},
          userId: f.userId,
        })
        expect(result.items[0]!.runningTask).toEqual({ id: accepted.task.id, roundNo: 2, status })
      } finally {
        wait.release()
        await running
      }
    })
  }
  test('should bind same-time pagination to user and page size reject tampering before IO and respect maximum fifty', async ({
    payload,
  }) => {
    const f = await emptySessions({ count: 3, payload })
    const service = createPayloadOwnerSessions({ cursorKey, pageSize: 1, payload })
    const a = await service.list({ query: {}, userId: f.userId })
    const other = await payload.create({
      collection: 'users',
      data: { status: 'active' } as never,
      overrideAccess: true,
    })
    const find = vi.spyOn(payload, 'find')
    for (const operation of [
      () => service.list({ query: { cursor: a.nextCursor }, userId: other.id }),
      () => f.service.list({ query: { cursor: a.nextCursor }, userId: f.userId }),
      () =>
        service.list({ query: { cursor: a.nextCursor!.slice(0, -2) + 'AA' }, userId: f.userId }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ status: 400 })
    }
    expect(find).not.toHaveBeenCalled()
    expect(() => createPayloadOwnerSessions({ cursorKey, pageSize: 51, payload })).toThrow()
    const max = await createPayloadOwnerSessions({ cursorKey, pageSize: 50, payload }).list({
      query: {},
      userId: f.userId,
    })
    expect(max.items).toHaveLength(3)
    const b = await service.list({ query: { cursor: a.nextCursor }, userId: f.userId })
    expect(b.items[0]!.id).toBe(f.sessionIds[1])
  })
  test('should omit normal deleted sessions and return uniform missing foreign deleted 404 with active actor gating', async ({
    payload,
  }) => {
    const f = await emptySessions({ payload })
    const id = f.sessionIds[0]!
    const other = await payload.create({
      collection: 'users',
      data: { status: 'active' } as never,
      overrideAccess: true,
    })
    for (const [userId, sessionId] of [
      [other.id, id],
      [f.userId, id + 999],
    ]) {
      await expect(f.service.get({ sessionId: sessionId!, userId: userId! })).rejects.toMatchObject(
        { status: 404 },
      )
    }
    await f.adapter.client.execute(
      `UPDATE creation_sessions SET is_deleted=1,deleted_at=created_at,deleted_by=created_by WHERE id=${id}`,
    )
    await expect(f.service.get({ sessionId: id, userId: f.userId })).rejects.toMatchObject({
      status: 404,
    })
    expect((await f.service.list({ query: {}, userId: f.userId })).items).toEqual([])
    await f.adapter.client.execute("UPDATE users SET status='disabled'")
    await expect(f.service.list({ query: {}, userId: f.userId })).rejects.toMatchObject({
      status: 401,
    })
  })
  test('should map coherent cover tombstones to null without requiring old media but retain global tuple checks', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    const service = createPayloadOwnerSessions({ cursorKey, payload })
    await f.adapter.client.execute(
      'UPDATE artifacts SET is_deleted=1,deleted_at=created_at,deleted_by=created_by',
    )
    await f.adapter.client.execute("DELETE FROM media WHERE purpose='artifact'")
    expect((await service.list({ query: {}, userId: f.userId })).items[0]!.cover).toBeNull()
    await f.adapter.client.execute(
      'INSERT INTO artifacts (user_id,session_id,task_id,media_id,output_index,created_at,updated_at,created_by,updated_by,is_deleted,deleted_at,deleted_by) SELECT user_id+100,session_id,task_id,media_id,output_index,created_at,updated_at,created_by,updated_by,1,created_at,created_by FROM artifacts',
    )
    await expect(service.list({ query: {}, userId: f.userId })).rejects.toMatchObject({
      status: 503,
    })
  })
  const corruptions = [
    ['missing cover', 'DELETE FROM artifacts'],
    ['foreign cover', 'UPDATE artifacts SET user_id=user_id+999'],
    ['wrong cover session', 'UPDATE artifacts SET session_id=session_id+999'],
    ['bad tombstone', 'UPDATE artifacts SET is_deleted=1,deleted_at=NULL,deleted_by=NULL'],
    ['missing media', "DELETE FROM media WHERE purpose='artifact'"],
    ['wrong attempt', "UPDATE generation_attempts SET model='wrong'"],
    ['foreign inflight', "UPDATE generation_tasks SET status='queued',user_id=user_id+999"],
    ['deleted inflight', "UPDATE generation_tasks SET status='unknown',is_deleted=1"],
    [
      'wrong inflight template',
      "UPDATE generation_tasks SET status='running',template_id=template_id+999",
    ],
    ['wrong inflight round', "UPDATE generation_tasks SET status='running',round_no=999"],
  ] as const
  for (const [name, sql] of corruptions) {
    test(`should reject ${name} evidence with 503`, async ({ payload }) => {
      const f = await libraryFixture({ payload })
      await f.adapter.client.execute(sql)
      await expect(
        createPayloadOwnerSessions({ cursorKey, payload }).list({ query: {}, userId: f.userId }),
      ).rejects.toMatchObject({ status: 503 })
    })
  }
  test('should reject two sessions sharing one cover instead of accepting cross-linked delivery', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    await f.adapter.client.execute(
      "INSERT INTO creation_sessions (user_id,template_id,client_request_id,request_hash,mode,title,title_source,cover_artifact_id,last_activity_at,next_round_no,created_at,updated_at,created_by,updated_by,is_deleted) SELECT user_id,template_id,'duplicate-cover',request_hash,mode,title,title_source,cover_artifact_id,last_activity_at,next_round_no,created_at,updated_at,created_by,updated_by,0 FROM creation_sessions",
    )
    await expect(
      createPayloadOwnerSessions({ cursorKey, payload }).list({ query: {}, userId: f.userId }),
    ).rejects.toMatchObject({ status: 503 })
  })
  test('should reject duplicate inflight rows including soft-deleted foreign duplicates and 2n overflow', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    await f.adapter.client.execute("UPDATE generation_tasks SET status='queued'")
    const copy =
      "INSERT INTO generation_tasks (user_id,session_id,template_id,round_no,status,cost_credits,client_request_id,request_hash,execution_snapshot_json,description,user_notes,created_at,updated_at,created_by,updated_by,is_deleted) SELECT user_id+999,session_id,template_id,round_no,'unknown',cost_credits,'duplicate-task',request_hash,execution_snapshot_json,description,user_notes,created_at,updated_at,created_by,updated_by,1 FROM generation_tasks LIMIT 1"
    await f.adapter.client.execute(copy)
    await f.adapter.client.execute(copy)
    await expect(
      createPayloadOwnerSessions({ cursorKey, payload }).list({ query: {}, userId: f.userId }),
    ).rejects.toMatchObject({ status: 503 })
  })
  for (const sql of [
    'DELETE FROM creation_drafts',
    'UPDATE creation_drafts SET user_id=user_id+99',
    'UPDATE creation_drafts SET is_deleted=1',
  ]) {
    test(`should reject malformed detail draft ${sql}`, async ({ payload }) => {
      const f = await emptySessions({ payload })
      await f.adapter.client.execute(sql)
      await expect(
        f.service.get({ sessionId: f.sessionIds[0]!, userId: f.userId }),
      ).rejects.toMatchObject({ status: 503 })
    })
  }
  test('should reject duplicate drafts and slots rather than silently recover partial input', async ({
    payload,
  }) => {
    const f = await deliveredDraft({ payload })
    const drafts = createPayloadDraftService({ ...f.options, hostCaps: caps })
    await drafts.save({
      input: { description: '', inputMediaIds: f.mediaIds, userNotes: '' },
      sessionId: f.sessionId,
      userId: f.userId,
    })
    await f.adapter.client.execute(
      'INSERT INTO draft_inputs (user_id,draft_id,position,media_id,created_at,updated_at,created_by,updated_by,is_deleted) SELECT user_id,draft_id,position,media_id,created_at,updated_at,created_by,updated_by,1 FROM draft_inputs LIMIT 1',
    )
    await expect(f.service.get({ sessionId: f.sessionId, userId: f.userId })).rejects.toMatchObject(
      { status: 503 },
    )
    await f.adapter.client.execute('DELETE FROM draft_inputs')
    await f.adapter.client.execute(
      'INSERT INTO creation_drafts (user_id,session_id,description,user_notes,created_at,updated_at,created_by,updated_by,is_deleted) SELECT user_id,session_id,description,user_notes,created_at,updated_at,created_by,updated_by,is_deleted FROM creation_drafts',
    )
    await expect(f.service.get({ sessionId: f.sessionId, userId: f.userId })).rejects.toMatchObject(
      { status: 503 },
    )
  })
  test('should preserve one snapshot for profile and draft while a second SQLite connection changes both', async ({
    payload,
  }) => {
    const f = await emptySessions({ payload })
    const id = f.sessionIds[0]!
    const other = createClient({ url: sqliteURL })
    const original = payload.find.bind(payload)
    let changed = false
    vi.spyOn(payload, 'find').mockImplementation(async (args) => {
      const result = await original(args)
      if (!changed && String(args.collection) === 'creation-sessions') {
        changed = true
        await other.execute(`UPDATE creation_sessions SET title='NEW TITLE' WHERE id=${id}`)
        await other.execute(
          `UPDATE creation_drafts SET user_notes='NEW DRAFT' WHERE session_id=${id}`,
        )
      }
      return result
    })
    try {
      const first = await f.service.get({ sessionId: id, userId: f.userId })
      expect(first.title).toBe('Fixture')
      expect(first.draft.input.userNotes).toBe('')
      const second = await f.service.get({ sessionId: id, userId: f.userId })
      expect(second.title).toBe('NEW TITLE')
      expect(second.draft.input.userNotes).toBe('NEW DRAFT')
    } finally {
      other.close()
    }
  })
  test('should synchronously gate every selected profile draft and library field with zero IO', async ({
    payload,
  }) => {
    const f = await emptySessions({ payload })
    const find = vi.spyOn(payload, 'find')
    const transaction = vi.spyOn(f.adapter.client, 'transaction')
    for (const [slug, fieldName] of [
      ['creation-sessions', 'lastActivityAt'],
      ['creation-sessions', 'coverArtifactId'],
      ['generation-tasks', 'roundNo'],
      ['creation-drafts', 'description'],
      ['draft-inputs', 'mediaId'],
      ['media', 'sha256'],
    ] as const) {
      const config = (payload.collections as Record<string, typeof payload.collections.users>)[
        slug
      ]!.config
      const original = config.flattenedFields
      config.flattenedFields = original.filter((field) => field.name !== fieldName)
      try {
        expect(() => createPayloadOwnerSessions({ cursorKey, payload })).toThrow()
      } finally {
        config.flattenedFields = original
      }
    }
    expect(find).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })
  test('should reject truncated batch evidence and preserve original infrastructure errors', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    const original = payload.find.bind(payload)
    vi.spyOn(payload, 'find').mockImplementation(async (args) => {
      const result = await original(args)
      return String(args.collection) === 'generation-attempts'
        ? { ...result, docs: [], totalDocs: 1 }
        : result
    })
    await expect(
      createPayloadOwnerSessions({ cursorKey, payload }).list({ query: {}, userId: f.userId }),
    ).rejects.toMatchObject({ status: 503 })
    vi.restoreAllMocks()
    for (const error of [
      new Error('fixture transport'),
      new AggregateError([new Error('fixture db'), new Error('fixture rollback')]),
    ]) {
      const reader = createSessionsReader({
        find: async () => {
          throw error
        },
      })
      await expect(reader.inflight({ sessionIds: [f.sessionId] })).rejects.toBe(error)
    }
  })
  test('should reject truncated inflight totals without owner or deletion prefiltering', async ({
    payload,
  }) => {
    const f = await libraryFixture({ payload })
    const original = payload.find.bind(payload)
    vi.spyOn(payload, 'find').mockImplementation(async (args) => {
      const result = await original(args)
      return String(args.collection) === 'generation-tasks' &&
        args.select &&
        'roundNo' in args.select
        ? { ...result, docs: [], totalDocs: 1 }
        : result
    })
    await expect(
      createPayloadOwnerSessions({ cursorKey, payload }).list({ query: {}, userId: f.userId }),
    ).rejects.toMatchObject({ status: 503 })
  })
  test('should preserve Error and AggregateError identities through the real read snapshot', async ({
    payload,
  }) => {
    const f = await emptySessions({ payload })
    for (const error of [
      new Error('fixture find transport'),
      new AggregateError([new Error('fixture low level')]),
    ]) {
      vi.spyOn(payload, 'find').mockRejectedValue(error)
      for (const operation of [
        () => f.service.list({ query: {}, userId: f.userId }),
        () => f.service.get({ sessionId: f.sessionIds[0]!, userId: f.userId }),
      ]) {
        await expect(operation()).rejects.toBe(error)
      }
      vi.restoreAllMocks()
    }
  })
})
