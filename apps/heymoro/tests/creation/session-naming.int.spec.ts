import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { MediaStorageError } from '../../src/creation/domain/media.js'
import { createNamingEngine } from '../../src/creation/infrastructure/ai/naming-engine.js'
import { createPayloadSessionNamingJobHandler } from '../../src/creation/infrastructure/payload/session-naming-repository.js'
import { update } from './generation-fixture.js'
import { barrier, close, image, sqlRows } from './generation-worker-fixture.js'
import { financialGraph, namingFixture, namingHTTP, sessionRow } from './session-naming-fixture.js'
import { cleanupSQLiteFixture } from './sqlite.config.js'

test.suite(
  'Heymoro once-only session naming',
  { config: './sqlite.config.ts', cron: false },
  () => {
    test.afterEach(async () => {
      vi.restoreAllMocks()
      for (const work of close.splice(0).reverse()) {
        await work()
      }
    })
    test.afterAll(() => cleanupSQLiteFixture())
    test('real naming queue names the first captured image without changing the financial graph', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      const ledger = await sqlRows(f, 'credit_ledger')
      await payload.jobs.run({ limit: 10, overrideAccess: true, queue: 'creation-naming' })
      expect((await sqlRows(f, 'creation_sessions'))[0]?.auto_name_status).toBe('succeeded')
      expect(await sqlRows(f, 'credit_ledger')).toEqual(ledger)
      await payload.jobs.queue({
        input: { sessionId: f.sessionId },
        overrideAccess: true,
        queue: 'creation-naming',
        task: 'heymoro-name-v1',
      } as never)
      await payload.jobs.run({ limit: 10, overrideAccess: true, queue: 'creation-naming' })
      expect(f.nameState.calls).toBe(1)
      expect(await sqlRows(f, 'credit_ledger')).toEqual(ledger)
    })
    test('concurrent and repeated jobs share one persistent sender', async ({ payload }) => {
      const f = await namingFixture({ payload })
      const wait = barrier()
      f.nameState.engine = async () => {
        wait.enter()
        await wait.released
        return { name: 'Once', kind: 'name', requestId: null }
      }
      const first = f.naming.run({ sessionId: f.sessionId })
      await wait.entered
      expect(await f.nameWorker().run({ sessionId: f.sessionId })).toBe('sending')
      wait.release()
      expect(await first).toBe('succeeded')
      await f.naming.run({ sessionId: f.sessionId })
      expect(f.nameState.calls).toBe(1)
      expect(await sessionRow(f)).toMatchObject({
        auto_name_status: 'succeeded',
        title: 'Once',
        title_source: 'ai',
      })
    })
    test('an actual sending COMMIT losing its ACK never authorizes HTTP, even after read confirmation', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      const original = f.adapter.client.transaction.bind(f.adapter.client)
      let lost = false
      const spy = vi
        .spyOn(f.adapter.client, 'transaction')
        .mockImplementation(async (...args: unknown[]) => {
          const [mode] = args
          if (mode !== undefined && mode !== 'read' && mode !== 'write' && mode !== 'deferred') {
            throw new Error('Fixture mode')
          }
          const tx = await (mode === undefined ? original() : original(mode))
          if (mode !== 'deferred' || lost) {
            return tx
          }
          return new Proxy(tx, {
            get(target, property) {
              if (property === 'commit') {
                return async () => {
                  const sending = (
                    await target.execute('SELECT auto_name_status FROM creation_sessions')
                  ).rows.some((row) => row.auto_name_status === 'sending')
                  await target.commit()
                  if (sending) {
                    lost = true
                    throw new Error('Fixture dropped ACK')
                  }
                }
              }
              const value: unknown = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        })
      expect(await f.naming.run({ sessionId: f.sessionId })).toBe('sending')
      spy.mockRestore()
      expect(lost).toBe(true)
      expect(f.nameState.calls).toBe(0)
      expect((await sessionRow(f)).auto_name_started_at).toBe(f.state.now)
      expect(await f.nameWorker().run({ sessionId: f.sessionId })).toBe('sending')
      f.state.now = '2026-11-12T12:00:03.000Z'
      expect(await f.nameWorker().run({ sessionId: f.sessionId })).toBe('unknown')
      expect(f.nameState.calls).toBe(0)
    })
    test('SQL sending trigger failure rolls back pending with no pretend send', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      await f.adapter.client.execute(
        "CREATE TRIGGER name_send_abort BEFORE UPDATE ON creation_sessions WHEN NEW.auto_name_status = 'sending' BEGIN SELECT RAISE(ABORT, 'fixture sending failure'); END",
      )
      try {
        await expect(f.naming.run({ sessionId: f.sessionId })).rejects.toThrow()
      } finally {
        await f.adapter.client.execute('DROP TRIGGER name_send_abort')
      }
      expect(await sessionRow(f)).toMatchObject({
        auto_name_started_at: null,
        auto_name_status: 'pending',
      })
      expect(f.nameState.calls).toBe(0)
      expect(await f.naming.run({ sessionId: f.sessionId })).toBe('succeeded')
    })
    test('crash after confirmed sending but before HTTP is not retried on restart', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      let crash = true
      const worker = f.nameWorker({
        coordinate: async (args) => {
          const result = await f.namingOptions.coordinate(args)
          if (crash) {
            crash = false
            throw new Error('Fixture process stopped after sending COMMIT')
          }
          return result
        },
      })
      await expect(worker.run({ sessionId: f.sessionId })).rejects.toThrow(
        'Fixture process stopped',
      )
      expect((await sessionRow(f)).auto_name_status).toBe('sending')
      expect(f.nameState.calls).toBe(0)
      await f.nameWorker().run({ sessionId: f.sessionId })
      expect(f.nameState.calls).toBe(0)
      f.state.now = '2026-11-12T12:00:03.000Z'
      expect(await f.nameWorker().run({ sessionId: f.sessionId })).toBe('unknown')
    })
    test('clock is sampled after waiting for the session lock, not before', async ({ payload }) => {
      const f = await namingFixture({ payload })
      const worker = f.nameWorker({
        coordinate: async (args) => {
          f.state.now = '2026-11-12T12:00:30.000Z'
          return f.namingOptions.coordinate(args)
        },
      })
      expect(await worker.run({ sessionId: f.sessionId })).toBe('succeeded')
      expect((await sessionRow(f)).auto_name_started_at).toBe('2026-11-12T12:00:30.000Z')
    })
    test('real user rename before pending skips with zero provider calls', async ({ payload }) => {
      const f = await namingFixture({ deliver: false, payload })
      await f.rename({
        command: { title: '  My title  ' },
        sessionId: f.sessionId,
        userId: f.userId,
      })
      await f.running.run({ taskId: f.taskId })
      expect(await f.naming.run({ sessionId: f.sessionId })).toBe('skipped')
      expect(f.nameState.calls).toBe(0)
      expect(await sessionRow(f)).toMatchObject({
        auto_name_started_at: null,
        title: 'My title',
        title_source: 'user',
        updated_by: 'system:generation',
      })
    })
    test('pending user title short-circuits even a missing source without source I/O', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      await f.rename({ command: { title: 'User wins' }, sessionId: f.sessionId, userId: f.userId })
      const get = vi.fn(f.storage.getVerified)
      expect(
        await f
          .nameWorker({ storage: { ...f.storage, getVerified: get } })
          .run({ sessionId: f.sessionId }),
      ).toBe('skipped')
      expect(get).not.toHaveBeenCalled()
      expect(f.nameState.calls).toBe(0)
    })
    test('user rename during sending preserves start evidence and original input, late name only skips', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      const graph = await financialGraph(f)
      const wait = barrier()
      f.nameState.engine = async () => {
        wait.enter()
        await wait.released
        return { name: 'Wrong late name', kind: 'name', requestId: null }
      }
      const running = f.naming.run({ sessionId: f.sessionId })
      await wait.entered
      const startedAt = (await sessionRow(f)).auto_name_started_at
      await f.rename({ command: { title: 'User wins' }, sessionId: f.sessionId, userId: f.userId })
      expect(await sessionRow(f)).toMatchObject({
        auto_name_started_at: startedAt,
        auto_name_status: 'sending',
        updated_by: `user:${f.userId}`,
      })
      wait.release()
      expect(await running).toBe('skipped')
      expect(await sessionRow(f)).toMatchObject({
        auto_name_started_at: startedAt,
        auto_named_at: null,
        title: 'User wins',
        title_source: 'user',
      })
      expect(await financialGraph(f)).toEqual(graph)
    })
    test('late output cannot revive unknown or overwrite a subsequent user title', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      const wait = barrier()
      f.nameState.engine = async () => {
        wait.enter()
        await wait.released
        return { name: 'Late', kind: 'name', requestId: null }
      }
      const running = f.naming.run({ sessionId: f.sessionId })
      await wait.entered
      f.state.now = '2026-11-12T12:00:03.000Z'
      expect(await f.nameWorker().run({ sessionId: f.sessionId })).toBe('unknown')
      await f.rename({ command: { title: 'Keep mine' }, sessionId: f.sessionId, userId: f.userId })
      wait.release()
      expect(await running).toBe('unknown')
      expect(await f.naming.run({ sessionId: f.sessionId })).toBe('unknown')
      expect(await sessionRow(f)).toMatchObject({
        auto_name_status: 'unknown',
        auto_named_at: null,
        title: 'Keep mine',
      })
      expect(f.nameState.calls).toBe(1)
    })
    test('engine deadline aborts locally and a resolving-late promise is ignored forever', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      const wait = barrier()
      let signal: AbortSignal | undefined
      f.nameState.engine = async (args) => {
        signal = args.signal
        await wait.released
        return { name: 'Late', kind: 'name', requestId: null }
      }
      const graph = await financialGraph(f)
      expect(await f.nameWorker({ engineTimeoutMs: 25 }).run({ sessionId: f.sessionId })).toBe(
        'unknown',
      )
      expect(signal?.aborted).toBe(true)
      wait.release()
      await new Promise((resolve) => setTimeout(resolve, 10))
      await f.naming.run({ sessionId: f.sessionId })
      expect(f.nameState.calls).toBe(1)
      expect((await sessionRow(f)).auto_named_at).toBeNull()
      expect(await financialGraph(f)).toEqual(graph)
    })
    for (const mode of ['success', 'timeout', 'disconnect', 'bad-json'] as const) {
      test(`real Responses SDK ${mode} has no business lock or transaction and never retries`, async ({
        payload,
      }) => {
        const f = await namingFixture({ payload })
        const graph = await financialGraph(f)
        const http = await namingHTTP({ mode, observe: f.assertNamingOutside })
        const worker = f.nameWorker({ engine: http.engine })
        expect(await worker.run({ sessionId: f.sessionId })).toBe(
          mode === 'success' ? 'succeeded' : 'unknown',
        )
        await worker.run({ sessionId: f.sessionId })
        expect(http.requests).toHaveLength(1)
        expect(http.requests[0]?.path).toBe('/v1/responses')
        expect(http.requests[0]?.body.model).toBe('explicit-fixture-naming-model')
        expect(JSON.stringify(http.requests[0]?.body)).not.toMatch(
          /sessionId|taskId|storageName|fixture-output/,
        )
        expect(await financialGraph(f)).toEqual(graph)
      })
    }
    for (const missing of ['engine', 'key', 'model', 'provider'] as const) {
      test(`missing ${missing} fails once preserving captured image and template title`, async ({
        payload,
      }) => {
        const f = await namingFixture({ payload })
        const graph = await financialGraph(f)
        const http = await namingHTTP()
        const options = {
          ...http.options,
          ...(missing === 'key' ? { apiKey: '' } : {}),
          registered:
            missing === 'model'
              ? null
              : missing === 'provider'
                ? { ...http.options.registered, provider: 'other' }
                : http.options.registered,
        }
        const engine =
          missing === 'engine'
            ? null
            : createNamingEngine(options as Parameters<typeof createNamingEngine>[0])
        expect(await f.nameWorker({ engine }).run({ sessionId: f.sessionId })).toBe('failed')
        expect(await f.nameWorker({ engine }).run({ sessionId: f.sessionId })).toBe('failed')
        expect(await sessionRow(f)).toMatchObject({
          auto_named_at: null,
          title: 'Fixture',
          title_source: 'template',
        })
        expect(http.requests).toHaveLength(0)
        expect(await financialGraph(f)).toEqual(graph)
      })
    }
    test('internal naming accepts disabled owner but new rename requires active identity and ownership', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      const other = await payload.create({
        collection: 'users',
        data: { status: 'active' } as never,
        overrideAccess: true,
      })
      await expect(
        f.rename({
          command: { title: 'Foreign' },
          sessionId: f.sessionId,
          userId: Number(other.id),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
      await payload.update({
        id: f.userId,
        collection: 'users',
        data: { status: 'disabled' } as never,
        overrideAccess: true,
      })
      await expect(
        f.rename({ command: { title: 'Disabled' }, sessionId: f.sessionId, userId: f.userId }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 })
      expect(await f.naming.run({ sessionId: f.sessionId })).toBe('succeeded')
    })
    test('deleted sessions and inactive, absent, or invalid principals never rename', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      for (const userId of [0, -1, NaN, 999999]) {
        await expect(
          f.rename({ command: { title: 'Title' }, sessionId: f.sessionId, userId }),
        ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
      }
      await update({
        id: f.sessionId,
        collection: 'creation-sessions',
        data: { deletedAt: f.state.now, deletedBy: 'system:fixture-delete', isDeleted: true },
        payload,
      })
      await expect(
        f.rename({ command: { title: 'Title' }, sessionId: f.sessionId, userId: f.userId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
    test('rename command is exact, rejects controls and extra fields, accepts boundary length and audits actor', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      const getter = Object.defineProperty({}, 'title', {
        enumerable: true,
        get() {
          throw new Error('Untrusted getter must not execute')
        },
      })
      for (const command of [
        null,
        [],
        {},
        { title: '' },
        { title: '  ' },
        { title: 'a\nb' },
        { title: 'a\tb' },
        { title: 'x'.repeat(101) },
        { actor: 'admin', title: 'a' },
        getter,
      ]) {
        await expect(
          f.rename({ command, sessionId: f.sessionId, userId: f.userId }),
        ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
      }
      await f.rename({
        command: { title: 'x'.repeat(100) },
        sessionId: f.sessionId,
        userId: f.userId,
      })
      expect(await sessionRow(f)).toMatchObject({
        title: 'x'.repeat(100),
        title_source: 'user',
        updated_by: `user:${f.userId}`,
      })
    })
    test('source 404 before sending fails pending, never calls naming engine', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      const graph = await financialGraph(f)
      const storage = {
        ...f.storage,
        getVerified: async () => {
          await f.assertNamingOutside()
          throw new MediaStorageError('NOT_FOUND')
        },
      }
      expect(await f.nameWorker({ storage }).run({ sessionId: f.sessionId })).toBe('failed')
      expect(f.nameState.calls).toBe(0)
      expect(await financialGraph(f)).toEqual(graph)
    })
    test('a delayed old source 404 cannot turn another sender failed', async ({ payload }) => {
      const f = await namingFixture({ payload })
      const sourceWait = barrier()
      const engineWait = barrier()
      const old = f
        .nameWorker({
          storage: {
            ...f.storage,
            getVerified: async () => {
              sourceWait.enter()
              await sourceWait.released
              throw new MediaStorageError('NOT_FOUND')
            },
          },
        })
        .run({ sessionId: f.sessionId })
      await sourceWait.entered
      f.nameState.engine = async () => {
        engineWait.enter()
        await engineWait.released
        return { name: 'Current sender', kind: 'name', requestId: null }
      }
      const newer = f.naming.run({ sessionId: f.sessionId })
      await engineWait.entered
      sourceWait.release()
      expect(await old).toBe('sending')
      expect((await sessionRow(f)).auto_name_status).toBe('sending')
      engineWait.release()
      expect(await newer).toBe('succeeded')
      expect(f.nameState.calls).toBe(1)
    })
    for (const fault of ['artifact-owner', 'media-hash', 'captured-ledger'] as const) {
      test(`${fault} inconsistency stops without repair or paid call`, async ({ payload }) => {
        const f = await namingFixture({ payload })
        if (fault === 'artifact-owner') {
          await f.adapter.client.execute('UPDATE artifacts SET user_id = 999999')
        } else if (fault === 'media-hash') {
          await f.adapter.client.execute(
            "UPDATE media SET sha256 = 'bad' WHERE purpose = 'artifact'",
          )
        } else {
          await f.adapter.client.execute(
            "UPDATE credit_ledger SET consumed_delta = 999 WHERE operation = 'capture'",
          )
        }
        const graph = await financialGraph(f)
        await expect(f.naming.run({ sessionId: f.sessionId })).rejects.toMatchObject({
          code: 'DATA_INTEGRITY_CONFLICT',
        })
        expect(f.nameState.calls).toBe(0)
        expect((await sessionRow(f)).auto_name_status).toBe('pending')
        expect(await financialGraph(f)).toEqual(graph)
      })
    }
    test('first successful artifact and its accepted snapshot, not round number, current cover, draft or template, supplies naming', async ({
      payload,
    }) => {
      const f = await namingFixture({ deliver: false, payload })
      f.state.engine = async () => ({ kind: 'rejected', requestId: null })
      await f.running.run({ taskId: f.taskId })
      const submit = async (key: string, notes: string) => {
        const input = { ...f.input, inputMediaIds: f.mediaIds, userNotes: notes }
        const quote = await f.admission.quoteGenerate({
          input,
          sessionId: f.sessionId,
          userId: f.userId,
        })
        return f.admission.submitGenerate({
          clientRequestId: key,
          input,
          quoteToken: quote.quoteToken,
          sessionId: f.sessionId,
          userId: f.userId,
        })
      }
      const first = await submit('first-success', '  first accepted notes\n ')
      const firstBytes = await image('yellow')
      f.state.engine = async () => ({
        bytes: firstBytes,
        contentType: 'image/png',
        kind: 'output',
        requestId: null,
      })
      await f.running.run({ taskId: first.task.id })
      const second = await submit('second-success', 'Later accepted notes')
      f.state.engine = async () => ({
        bytes: await image('purple'),
        contentType: 'image/png',
        kind: 'output',
        requestId: null,
      })
      await f.running.run({ taskId: second.task.id })
      await f.adapter.client.execute(
        "UPDATE creation_drafts SET description = 'changed draft', user_notes = 'changed notes'",
      )
      await f.adapter.client.execute("UPDATE creation_templates SET generation_config_json = '{}' ")
      const artifacts = await sqlRows(f, 'artifacts')
      expect((await sessionRow(f)).cover_artifact_id).toBe(artifacts[1]?.id)
      const graph = await financialGraph(f)
      f.nameState.engine = async (args) => {
        expect(Buffer.from(args.image.bytes)).toEqual(firstBytes)
        expect(args.input).toEqual({
          description: '',
          intent: 'PRIVATE SYSTEM INSTRUCTION',
          userNotes: '  first accepted notes\n ',
        })
        return { name: 'Original first', kind: 'name', requestId: null }
      }
      expect(await f.naming.run({ sessionId: f.sessionId })).toBe('succeeded')
      expect(await financialGraph(f)).toEqual(graph)
      await f.running.run({ taskId: second.task.id })
      expect(f.nameState.calls).toBe(1)
    })
    test('soft-deleted first artifact is not replaced by a later cover', async ({ payload }) => {
      const f = await namingFixture({ payload })
      const first = (await sqlRows(f, 'artifacts'))[0]!
      const quote = await f.admission.quoteGenerate({
        input: { ...f.input, inputMediaIds: f.mediaIds },
        sessionId: f.sessionId,
        userId: f.userId,
      })
      const second = await f.admission.submitGenerate({
        clientRequestId: 'later-cover',
        input: { ...f.input, inputMediaIds: f.mediaIds },
        quoteToken: quote.quoteToken,
        sessionId: f.sessionId,
        userId: f.userId,
      })
      await f.running.run({ taskId: second.task.id })
      await update({
        id: Number(first.id),
        collection: 'artifacts',
        data: { deletedAt: f.state.now, deletedBy: 'system:fixture-delete', isDeleted: true },
        payload,
      })
      expect(await f.naming.run({ sessionId: f.sessionId })).toBe('failed')
      expect(f.nameState.calls).toBe(0)
    })
    test('job handler ignores queue request and uses only its typed input', async () => {
      const run = vi.fn(async () => 'succeeded' as const)
      const handler = createPayloadSessionNamingJobHandler({ worker: { run } })
      expect(
        await handler({
          input: { sessionId: 7 },
          req: new Proxy(
            {},
            {
              get() {
                throw new Error('Job req must stay unused')
              },
            },
          ),
        } as never),
      ).toEqual({ output: {} })
      expect(run).toHaveBeenCalledExactlyOnceWith({ sessionId: 7 })
    })

    for (const result of [
      { name: 'x'.repeat(101), kind: 'name', requestId: null },
      { name: 'bad\nname', kind: 'name', requestId: null },
      { kind: 'nonsense', requestId: null },
      null,
    ]) {
      test('malformed engine result is unknown once and never changes delivered image', async ({
        payload,
      }) => {
        const f = await namingFixture({ payload })
        const graph = await financialGraph(f)
        f.nameState.engine = async () => result as never
        expect(await f.naming.run({ sessionId: f.sessionId })).toBe('unknown')
        await f.naming.run({ sessionId: f.sessionId })
        expect(f.nameState.calls).toBe(1)
        expect(await financialGraph(f)).toEqual(graph)
      })
    }
    for (const kind of ['not_sent', 'rejected'] as const) {
      test(`explicit ${kind} naming failure preserves image and does not release or recapture funds`, async ({
        payload,
      }) => {
        const f = await namingFixture({ payload })
        const graph = await financialGraph(f)
        f.nameState.engine = async () => ({ kind, requestId: null })
        expect(await f.naming.run({ sessionId: f.sessionId })).toBe('failed')
        await f.naming.run({ sessionId: f.sessionId })
        expect(f.nameState.calls).toBe(1)
        expect(await financialGraph(f)).toEqual(graph)
      })
    }
    test('source integrity error leaves state untouched, never pretends a success or repairs facts', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      const graph = await financialGraph(f)
      await expect(
        f
          .nameWorker({
            storage: {
              ...f.storage,
              getVerified: async () => {
                throw new MediaStorageError('CONTENT_CONFLICT')
              },
            },
          })
          .run({ sessionId: f.sessionId }),
      ).rejects.toMatchObject({ code: 'CONTENT_CONFLICT' })
      expect((await sessionRow(f)).auto_name_status).toBe('pending')
      expect(f.nameState.calls).toBe(0)
      expect(await financialGraph(f)).toEqual(graph)
    })
    test('lost coordination lease blocks sending and cannot repair state', async ({ payload }) => {
      const f = await namingFixture({ payload })
      await expect(
        f
          .nameWorker({
            coordinate: async ({ work }) =>
              work({
                assertLease: () => {
                  throw new Error('Fixture lost lease')
                },
              }),
          })
          .run({ sessionId: f.sessionId }),
      ).rejects.toThrow('Fixture lost lease')
      expect((await sessionRow(f)).auto_name_status).toBe('pending')
      expect(f.nameState.calls).toBe(0)
    })
    test('context is rechecked after source I/O before sending', async ({ payload }) => {
      const f = await namingFixture({ payload })
      const original = f.storage.getVerified
      const storage = {
        ...f.storage,
        getVerified: async (args: Parameters<typeof original>[0]) => {
          const result = await original(args)
          await f.adapter.client.execute(
            "UPDATE media SET sha256 = 'bad' WHERE purpose = 'artifact'",
          )
          return result
        },
      }
      await expect(f.nameWorker({ storage }).run({ sessionId: f.sessionId })).rejects.toMatchObject(
        { code: 'DATA_INTEGRITY_CONFLICT' },
      )
      expect((await sessionRow(f)).auto_name_status).toBe('pending')
      expect(f.nameState.calls).toBe(0)
    })
    test('AI naming configuration and parameters are snapshotted separately from image plan', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      const http = await namingHTTP()
      const options = structuredClone({ ...http.options, fetch: undefined })
      const engine = createNamingEngine({ ...options, fetch: http.options.fetch })
      options.registered.model = 'mutated-model'
      options.registered.parameters.max_output_tokens = 999
      expect(await f.nameWorker({ engine }).run({ sessionId: f.sessionId })).toBe('succeeded')
      expect(http.requests[0]?.body.model).toBe('explicit-fixture-naming-model')
      expect(http.requests[0]?.body.max_output_tokens).toBe(128)
    })
    test('misaligned naming budget rejects before the SDK transport', async ({ payload }) => {
      const f = await namingFixture({ payload })
      const http = await namingHTTP()
      const engine = createNamingEngine({ ...http.options, engineBudgetMs: 500 })
      expect(await f.nameWorker({ engine }).run({ sessionId: f.sessionId })).toBe('failed')
      expect(http.requests).toHaveLength(0)
    })
    test('renaming a successfully named session preserves terminal evidence and replay does not rewrite it to skipped', async ({
      payload,
    }) => {
      const f = await namingFixture({ payload })
      await f.naming.run({ sessionId: f.sessionId })
      const named = await sessionRow(f)
      await f.rename({
        command: { title: 'User after AI' },
        sessionId: f.sessionId,
        userId: f.userId,
      })
      expect(await f.naming.run({ sessionId: f.sessionId })).toBe('succeeded')
      expect(await sessionRow(f)).toMatchObject({
        auto_name_started_at: named.auto_name_started_at,
        auto_named_at: named.auto_named_at,
        title: 'User after AI',
        title_source: 'user',
      })
      expect(f.nameState.calls).toBe(1)
    })
  },
)
