import type { Payload, PayloadRequest } from 'payload'

import { REST_GET, REST_POST, REST_PUT } from '@payloadcms/next/routes'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { expect, vi } from 'vitest'

import type { TaskHistoryDTO } from '../../src/creation/application/owner-task-history-types.js'
import type { TaskDTO } from '../../src/creation/domain/generation.js'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { generationEndpoints } from '../../src/creation/http/generation-endpoints.js'
import { CREATION_JSON_MAX_BYTES } from '../../src/creation/http/request.js'
import { wrapProductREST } from '../../src/creation/http/rest-route.js'
import { createPayloadCreditsService } from '../../src/creation/infrastructure/payload/credits-repository.js'
import { createPayloadVerifiedMediaRegistration } from '../../src/creation/infrastructure/payload/media-repository.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createS3ObjectStorage } from '../../src/creation/infrastructure/s3/object-storage.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'
import { cleanupRuntime, config, gate, http, state } from './runtime.config.js'
import { controlledWrite, now, seedChain, seedIdentity } from './runtime-seed.js'

type Owner = { token: string; userId: number }
type Input = { description: string; inputMediaIds: number[]; userNotes: string }
type Quote = {
  costCredits: number
  quoteToken: string
  templateId: number
  validUntil: string
}
type Page = { hasMore: boolean; items: TaskHistoryDTO[]; nextCursor: null | string }
type Envelope<T> = {
  data: T
  error: { code: string; message: string; retryable: boolean }
  requestId: string
}
const taskFields = [
  'clientRequestId',
  'costCredits',
  'errorCode',
  'id',
  'input',
  'roundNo',
  'sessionId',
  'sourceTaskId',
  'status',
  'templateId',
]
const historyFields = [
  ...taskFields,
  'artifactIds',
  'createdAt',
  'finishedAt',
  'inputAvailability',
  'resolution',
  'startedAt',
]
const originalInput: Input = { description: '  Draw a tree\n', inputMediaIds: [], userNotes: '' }

// Real Native REST handlers and same-root services; no Next server or paid model is started.
test.suite('Heymoro Native generation HTTP', { config: './runtime.config.ts', cron: false }, () => {
  test.afterAll(cleanupRuntime)
  test.beforeEach(reset)
  test.afterEach(() => {
    vi.restoreAllMocks()
    reset()
  })

  test('should quote read-only, admit exact TaskDTO once, replay expired acceptance and preserve free text', async ({
    payload,
  }) => {
    const owner = await seedChain({ config, gate, payload })
    const sessionId = await session({ owner, payload })
    await data({
      body: { description: 'Draft is not a command' },
      method: 'put',
      owner,
      path: `/v1/creation-sessions/${sessionId}/draft`,
      payload,
    })
    const before = await snapshot({ payload })
    const calls = network()
    const quote = await quoteGenerate({ input: originalInput, owner, payload, sessionId })
    expect(Object.keys(quote).sort()).toEqual([
      'costCredits',
      'quoteToken',
      'templateId',
      'validUntil',
    ])
    expect(quote).toMatchObject({ costCredits: 2, templateId: owner.templateId })
    expect(await snapshot({ payload })).toEqual(before)
    expect(network()).toEqual(calls)
    const body = {
      clientRequestId: '  free-command  ',
      input: originalInput,
      quoteToken: quote.quoteToken,
      sessionId,
    }
    const replies = await Promise.all([
      native({ body, method: 'post', owner, path: '/v1/generations', payload }),
      native({ body, method: 'post', owner, path: '/v1/generations', payload }),
    ])
    expect(replies.map(({ status }) => status).sort()).toEqual([200, 201])
    const tasks = await Promise.all(replies.map((response) => envelope<TaskDTO>({ response })))
    expect(tasks[0]!.data).toEqual(tasks[1]!.data)
    const task = tasks[0]!.data
    expect(Object.keys(task).sort()).toEqual([...taskFields].sort())
    expect(task).toMatchObject({
      clientRequestId: '  free-command  ',
      costCredits: 2,
      input: originalInput,
      roundNo: 1,
      sessionId,
      sourceTaskId: null,
      status: 'queued',
    })
    expect(network()).toEqual(calls)
    await failure({
      body: { ...body, input: { ...originalInput, description: 'changed' } },
      code: 'IDEMPOTENCY_CONFLICT',
      method: 'post',
      owner,
      path: '/v1/generations',
      payload,
      status: 409,
    })
    await failure({
      body: { ...body, clientRequestId: 'another-in-flight' },
      code: 'GENERATION_IN_PROGRESS',
      method: 'post',
      owner,
      path: '/v1/generations',
      payload,
      status: 409,
    })
    state.now = '2026-11-12T12:01:01.000Z'
    expect(await data({ body, method: 'post', owner, path: '/v1/generations', payload })).toEqual(
      task,
    )
    await failure({
      body: { ...body, clientRequestId: 'unaccepted-expired' },
      code: 'QUOTE_EXPIRED',
      method: 'post',
      owner,
      path: '/v1/generations',
      payload,
      status: 409,
    })
    state.now = now
    const otherSession = await session({ key: 'changed-quote', owner, payload })
    const otherQuote = await quoteGenerate({
      input: originalInput,
      owner,
      payload,
      sessionId: otherSession,
    })
    await failure({
      body: {
        ...body,
        clientRequestId: 'changed-quote',
        input: { ...originalInput, description: 'changed' },
        quoteToken: otherQuote.quoteToken,
        sessionId: otherSession,
      },
      code: 'QUOTE_CHANGED',
      method: 'post',
      owner,
      path: '/v1/generations',
      payload,
      status: 409,
    })
    for (const input of [{}, { description: ' ' }, { ...originalInput, userNotes: 'forbidden' }]) {
      await failure({
        body: { input, sessionId: otherSession },
        code: 'userNotes' in input ? 'INPUT_INVALID' : 'DESCRIPTION_REQUIRED',
        method: 'post',
        owner,
        path: '/v1/generation-quotes',
        payload,
        status: 400,
      })
    }
    await payload.jobs.run({ limit: 5, overrideAccess: true, queue: 'creation' })
    await payload.jobs.run({ limit: 5, overrideAccess: true, queue: 'creation-naming' })
    expect(state.imageCalls - calls.image).toBe(1)
    expect(state.namingCalls - calls.naming).toBe(1)
    const history = await data<TaskHistoryDTO>({
      owner,
      path: `/v1/generations/${task.id}`,
      payload,
    })
    expect(Object.keys(history).sort()).toEqual([...historyFields].sort())
    expect(history).toMatchObject({
      artifactIds: [expect.any(Number)],
      input: originalInput,
      inputAvailability: [],
      resolution: null,
      status: 'succeeded',
    })
    expect(
      (await data<Page>({ owner, path: `/v1/creation-sessions/${sessionId}/generations`, payload }))
        .items,
    ).toEqual([history])
    expect(
      (
        await data<{ input: Input }>({
          owner,
          path: `/v1/creation-sessions/${sessionId}/draft`,
          payload,
        })
      ).input.description,
    ).toBe('Draft is not a command')
    expect(JSON.stringify(history)).not.toMatch(
      /executionPlan|systemPrompt|tokenHash|requestHash|storageBackend|createdBy/,
    )
  })

  test('should publish an effect, upload ordered references over HTTP, run Native jobs and regenerate original input after draft edits', async ({
    payload,
  }) => {
    const owner = await seedChain({ config, gate, payload })
    const effect = await publishEffect({ adminId: owner.adminId, payload })
    const mediaIds: number[] = []
    for (const color of ['red', 'blue']) {
      const body = new FormData()
      body.append('file', new File([await png({ color })], `${color}.png`, { type: 'image/png' }))
      mediaIds.push(
        (
          await data<{ id: number }>({
            body,
            method: 'post',
            owner,
            path: '/v1/media',
            payload,
            status: 201,
          })
        ).id,
      )
    }
    const sessionId = await session({ owner: { ...owner, ...effect }, payload })
    const input: Input = {
      description: '',
      inputMediaIds: [...mediaIds].reverse(),
      userNotes: '  Keep original notes\n',
    }
    await data({
      body: input,
      method: 'put',
      owner,
      path: `/v1/creation-sessions/${sessionId}/draft`,
      payload,
    })
    const beforeQuote = await snapshot({ payload })
    const calls = network()
    const quote = await quoteGenerate({ input, owner, payload, sessionId })
    expect(await snapshot({ payload })).toEqual(beforeQuote)
    expect(network()).toEqual(calls)
    const task = await submit({ input, key: 'effect-original', owner, payload, quote, sessionId })
    expect(task.input).toEqual(input)
    expect(network()).toEqual(calls)
    await payload.jobs.run({ limit: 5, overrideAccess: true, queue: 'creation' })
    await payload.jobs.run({ limit: 5, overrideAccess: true, queue: 'creation-naming' })
    const history = await data<TaskHistoryDTO>({
      owner,
      path: `/v1/generations/${task.id}`,
      payload,
    })
    expect(history.inputAvailability).toEqual(
      input.inputMediaIds.map((mediaId, index) => ({
        mediaId,
        position: index + 1,
        status: 'active',
      })),
    )
    const artifactId = history.artifactIds[0]!
    const artifact = await data<{ mediaId: number }>({
      owner,
      path: `/v1/artifacts/${artifactId}`,
      payload,
    })
    const image = await native({ owner, path: `/v1/media/${artifact.mediaId}/content`, payload })
    expect(image.status).toBe(200)
    const client = getCreationSQLiteAdapter({ payload }).client
    const storageName = (
      await client.execute({
        args: [artifact.mediaId],
        sql: 'SELECT storage_name FROM media WHERE id = ?',
      })
    ).rows[0]!.storage_name as string
    expect(Buffer.from(await image.arrayBuffer())).toEqual(http.objects.get(storageName)!.bytes)
    expect(
      await data({ method: 'put', owner, path: `/v1/artifacts/${artifactId}/favorite`, payload }),
    ).toMatchObject({ isFavorite: true, savedAt: now })
    const edited = {
      description: '',
      inputMediaIds: mediaIds,
      userNotes: 'New draft, not regeneration input',
    }
    await data({
      body: edited,
      method: 'put',
      owner,
      path: `/v1/creation-sessions/${sessionId}/draft`,
      payload,
    })
    const beforeRegeneration = await snapshot({ payload })
    const regenQuote = await data<Quote>({
      body: { sourceArtifactId: artifactId },
      method: 'post',
      owner,
      path: '/v1/generation-quotes',
      payload,
    })
    expect(await snapshot({ payload })).toEqual(beforeRegeneration)
    const body = { clientRequestId: 'regenerate-original', quoteToken: regenQuote.quoteToken }
    const path = `/v1/artifacts/${artifactId}/regenerations`
    const regeneration = await data<TaskDTO>({
      body,
      method: 'post',
      owner,
      path,
      payload,
      status: 201,
    })
    expect(Object.keys(regeneration).sort()).toEqual([...taskFields].sort())
    expect(regeneration).toMatchObject({ input, roundNo: 2, sessionId, sourceTaskId: task.id })
    state.now = '2026-11-12T12:01:01.000Z'
    expect(await data({ body, method: 'post', owner, path, payload })).toEqual(regeneration)
    state.now = now
    await payload.jobs.run({ limit: 5, overrideAccess: true, queue: 'creation' })
    await payload.jobs.run({ limit: 5, overrideAccess: true, queue: 'creation-naming' })
    const page = await data<Page>({
      owner,
      path: `/v1/creation-sessions/${sessionId}/generations`,
      payload,
    })
    expect(page.items.map(({ roundNo }) => roundNo)).toEqual([2, 1])
    expect(page.items[0]!.input).toEqual(input)
    expect(
      (
        await data<{ input: Input }>({
          owner,
          path: `/v1/creation-sessions/${sessionId}/draft`,
          payload,
        })
      ).input,
    ).toEqual(edited)
    expect(await data({ owner, path: '/v1/creation-account', payload })).toMatchObject({
      available: 3,
      reserved: 0,
    })
    expect(
      (
        await data<{ items: { ledgerDelta: number; operation: string }[] }>({
          owner,
          path: '/v1/credits/ledger',
          payload,
        })
      ).items.map(({ ledgerDelta, operation }) => [operation, ledgerDelta]),
    ).toEqual([
      ['capture', -2],
      ['reserve', 0],
      ['capture', -2],
      ['reserve', 0],
      ['grant', 7],
    ])
    expect(state.imageCalls - calls.image).toBe(2)
    await client.execute({
      args: [mediaIds[0]!],
      sql: 'UPDATE media SET is_deleted = 1, deleted_at = created_at, deleted_by = created_by WHERE id = ?',
    })
    const unavailable = await data<TaskHistoryDTO>({
      owner,
      path: `/v1/generations/${task.id}`,
      payload,
    })
    expect(unavailable.input).toEqual(input)
    expect(unavailable.inputAvailability).toContainEqual({
      mediaId: mediaIds[0],
      position: 2,
      status: 'unavailable',
    })
    await client.execute({
      args: [artifactId],
      sql: 'UPDATE artifacts SET is_deleted = 1, deleted_at = created_at, deleted_by = created_by WHERE id = ?',
    })
    expect(
      (await data<TaskHistoryDTO>({ owner, path: `/v1/generations/${task.id}`, payload }))
        .artifactIds,
    ).toEqual([])
  })

  test('should return successful admission without post-commit artifact/history reads', async ({
    payload,
  }) => {
    const owner = await seedChain({ config, gate, payload })
    const sessionId = await session({ owner, payload })
    const quote = await quoteGenerate({ input: originalInput, owner, payload, sessionId })
    const find = payload.find.bind(payload)
    const spy = vi.spyOn(payload, 'find').mockImplementation((args) => {
      if ((args.collection as string) === 'artifacts') {
        return Promise.reject(new Error('private artifact projection offline'))
      }
      return find(args)
    })
    try {
      const task = await submit({
        input: originalInput,
        key: 'no-history-after-admit',
        owner,
        payload,
        quote,
        sessionId,
      })
      expect(task.status).toBe('queued')
      await failure({
        code: 'INTERNAL_ERROR',
        owner,
        path: `/v1/generations/${task.id}`,
        payload,
        status: 500,
      })
      expect(spy.mock.calls.some(([args]) => (args.collection as string) === 'artifacts')).toBe(
        true,
      )
    } finally {
      spy.mockRestore()
    }
  })

  test('should preserve insufficient credit and foreign-owner semantics without accepting injected owners', async ({
    payload,
  }) => {
    const fixture = await seedChain({ config, gate, payload })
    expect(fixture.userId).toBeGreaterThan(0)
    const owner = await seedIdentity({ gate, payload })
    const sessionId = await session({ owner: { ...fixture, ...owner }, payload })
    const quote = await quoteGenerate({ input: originalInput, owner, payload, sessionId })
    await failure({
      body: {
        clientRequestId: 'no-credits',
        input: originalInput,
        quoteToken: quote.quoteToken,
        sessionId,
      },
      code: 'CREDITS_INSUFFICIENT',
      method: 'post',
      owner,
      path: '/v1/generations',
      payload,
      status: 402,
    })
    const mainSession = await session({ owner: fixture, payload })
    const mainQuote = await quoteGenerate({
      input: originalInput,
      owner: fixture,
      payload,
      sessionId: mainSession,
    })
    const task = await submit({
      input: originalInput,
      key: 'private-task',
      owner: fixture,
      payload,
      quote: mainQuote,
      sessionId: mainSession,
    })
    for (const path of [
      `/v1/generations/${task.id}`,
      `/v1/creation-sessions/${mainSession}/generations`,
      '/v1/generations/999999',
    ]) {
      await failure({ code: 'NOT_FOUND', owner, path, payload, status: 404 })
    }
    await failure({
      body: { input: originalInput, sessionId: mainSession },
      code: 'NOT_FOUND',
      method: 'post',
      owner,
      path: '/v1/generation-quotes',
      payload,
      status: 404,
    })
    await failure({
      body: {
        clientRequestId: 'foreign',
        input: originalInput,
        quoteToken: mainQuote.quoteToken,
        sessionId: mainSession,
      },
      code: 'NOT_FOUND',
      method: 'post',
      owner,
      path: '/v1/generations',
      payload,
      status: 404,
    })
    await payload.jobs.run({ limit: 5, overrideAccess: true, queue: 'creation' })
    const artifactId = (
      await data<TaskHistoryDTO>({ owner: fixture, path: `/v1/generations/${task.id}`, payload })
    ).artifactIds[0]!
    await failure({
      body: { sourceArtifactId: artifactId },
      code: 'NOT_FOUND',
      method: 'post',
      owner,
      path: '/v1/generation-quotes',
      payload,
      status: 404,
    })
    await failure({
      body: { clientRequestId: 'foreign-regen', quoteToken: mainQuote.quoteToken },
      code: 'NOT_FOUND',
      method: 'post',
      owner,
      path: `/v1/artifacts/${artifactId}/regenerations`,
      payload,
      status: 404,
    })
    await getCreationSQLiteAdapter({ payload }).client.execute({
      args: [fixture.templateId],
      sql: "UPDATE creation_templates SET status = 'offline' WHERE id = ?",
    })
    await failure({
      body: { input: originalInput, sessionId: mainSession },
      code: 'TEMPLATE_UNAVAILABLE',
      method: 'post',
      owner: fixture,
      path: '/v1/generation-quotes',
      payload,
      status: 409,
    })
  })

  test('should enforce authentication first, strict command/query/path/body and actual 128KiB budgets', async ({
    payload,
  }) => {
    const owner = await seedChain({ config, gate, payload })
    const sessionId = await session({ owner, payload })
    for (const endpoint of generationEndpoints) {
      let reads = 0
      const response = await endpoint.handler({
        get body() {
          reads++
          throw new Error('body must not be consumed')
        },
        headers: new Headers(),
        payload,
        routeParams: { artifactId: '01', sessionId: '01', taskId: '01' },
        url: 'http://fixture' + endpoint.path + '?owner=999',
        user: { id: owner.userId },
      } as unknown as PayloadRequest)
      expect(response.status).toBe(401)
      expect((await envelope({ response })).error.code).toBe('UNAUTHENTICATED')
      expect(reads).toBe(0)
    }
    const quoteBody = { input: originalInput, sessionId }
    for (const body of [
      { sessionId },
      { input: null, sessionId },
      { ...quoteBody, userId: 1 },
      { ...quoteBody, operation: 'generate' },
      { ...quoteBody, purpose: 'quote' },
      { ...quoteBody, sourceArtifactId: 1 },
      { input: {}, sourceArtifactId: 1 },
      { sessionId, sourceArtifactId: 1 },
    ]) {
      await failure({
        body,
        code: 'INPUT_INVALID',
        method: 'post',
        owner,
        path: '/v1/generation-quotes',
        payload,
        status: 400,
      })
    }
    for (const [method, path] of [
      ['post', '/v1/generation-quotes?operation=generate'],
      ['post', '/v1/generations?owner=1'],
      ['post', '/v1/artifacts/01/regenerations'],
      ['post', '/v1/artifacts/1/regenerations?input=x'],
      ['get', '/v1/generations/01'],
      ['get', '/v1/generations/1?'],
      ['get', '/v1/generations/9007199254740992'],
      ['get', `/v1/creation-sessions/${sessionId}/generations?owner=1`],
      ['get', `/v1/creation-sessions/${sessionId}/generations?cursor=x&%63ursor=y`],
      ['get', `/v1/creation-sessions/${sessionId}/generations?cursor=`],
    ] as const) {
      await failure({
        body: method === 'post' ? quoteBody : undefined,
        code: 'INPUT_INVALID',
        method,
        owner,
        path,
        payload,
        status: 400,
      })
    }
    for (const endpoint of generationEndpoints.filter(({ method }) => method === 'get')) {
      const req = Object.assign(
        new Request('http://fixture' + endpoint.path, {
          body: 'x',
          headers: { authorization: `Bearer ${owner.token}` },
          method: 'POST',
        }),
        { payload, routeParams: { sessionId: String(sessionId), taskId: '1' } },
      ) as unknown as PayloadRequest
      expect((await endpoint.handler(req)).status).toBe(400)
    }
    const quote = await data<Quote>({
      body: padded({ value: quoteBody }),
      method: 'post',
      owner,
      path: '/v1/generation-quotes',
      payload,
    })
    await failure({
      body: padded({ extra: 1, value: quoteBody }),
      code: 'HTTP_BODY_TOO_LARGE',
      method: 'post',
      owner,
      path: '/v1/generation-quotes',
      payload,
      status: 413,
    })
    const command = {
      clientRequestId: 'budget-task',
      input: originalInput,
      quoteToken: quote.quoteToken,
      sessionId,
    }
    await failure({
      body: padded({ extra: 1, value: command }),
      code: 'HTTP_BODY_TOO_LARGE',
      method: 'post',
      owner,
      path: '/v1/generations',
      payload,
      status: 413,
    })
    for (const body of [
      { ...command, input: null },
      { ...command, input: undefined },
      { ...command, quoteToken: 1 },
      { ...command, clientRequestId: ' ' },
      { ...command, userId: 1 },
    ]) {
      await failure({
        body,
        code: 'INPUT_INVALID',
        method: 'post',
        owner,
        path: '/v1/generations',
        payload,
        status: 400,
      })
    }
    const task = await data<TaskDTO>({
      body: padded({ value: command }),
      method: 'post',
      owner,
      path: '/v1/generations',
      payload,
      status: 201,
    })
    await payload.jobs.run({ limit: 5, overrideAccess: true, queue: 'creation' })
    const artifactId = (
      await data<TaskHistoryDTO>({ owner, path: `/v1/generations/${task.id}`, payload })
    ).artifactIds[0]!
    const regenQuote = await data<Quote>({
      body: { sourceArtifactId: artifactId },
      method: 'post',
      owner,
      path: '/v1/generation-quotes',
      payload,
    })
    const regen = { clientRequestId: 'budget-regeneration', quoteToken: regenQuote.quoteToken }
    const path = `/v1/artifacts/${artifactId}/regenerations`
    for (const body of [
      { ...regen, input: {} },
      { ...regen, sessionId },
      { ...regen, sourceArtifactId: artifactId },
    ]) {
      await failure({
        body,
        code: 'INPUT_INVALID',
        method: 'post',
        owner,
        path,
        payload,
        status: 400,
      })
    }
    await failure({
      body: padded({ extra: 1, value: regen }),
      code: 'HTTP_BODY_TOO_LARGE',
      method: 'post',
      owner,
      path,
      payload,
      status: 413,
    })
    expect(
      (
        await data<TaskDTO>({
          body: padded({ value: regen }),
          method: 'post',
          owner,
          path,
          payload,
          status: 201,
        })
      ).sourceTaskId,
    ).toBe(task.id)
  })

  test('should page 21 real rounds with HTTP owner/session/endpoint scoped cursors and skip ordinary tombstones read-only', async ({
    payload,
  }) => {
    const owner = await seedChain({ config, gate, payload })
    const sessionId = await session({ owner, payload })
    await createPayloadCreditsService({
      actor: 'system:runtime-fixture',
      clock: () => now,
      coordinate: async ({ work }) => work({ assertLease: () => {} }),
      gate,
      payload,
      retry: { backoffMs: 0, maxAttempts: 1 },
    }).issueGrant({
      command: {
        expiresAt: null,
        grantKey: 'history-pages',
        issuedCredits: 50,
        sourceId: 'generation-http-only',
        sourceType: 'compensation',
        validFrom: now,
      },
      userId: owner.userId,
    })
    for (let sequence = 0; sequence < 21; sequence++) {
      const quote = await quoteGenerate({ input: originalInput, owner, payload, sessionId })
      await submit({
        input: originalInput,
        key: `round-${sequence}`,
        owner,
        payload,
        quote,
        sessionId,
      })
      await payload.jobs.run({ limit: 5, overrideAccess: true, queue: 'creation' })
    }
    const before = await snapshot({ payload })
    const calls = network()
    const first = await data<Page>({
      owner,
      path: `/v1/creation-sessions/${sessionId}/generations`,
      payload,
    })
    expect(first.items.map(({ roundNo }) => roundNo)).toEqual(
      Array.from({ length: 20 }, (_, index) => 21 - index),
    )
    expect(first.hasMore).toBe(true)
    const cursor = encodeURIComponent(first.nextCursor!)
    const second = await data<Page>({
      owner,
      path: `/v1/creation-sessions/${sessionId}/generations?cursor=${cursor}`,
      payload,
    })
    expect(second).toMatchObject({ hasMore: false, items: [{ roundNo: 1 }], nextCursor: null })
    expect(await snapshot({ payload })).toEqual(before)
    expect(network()).toEqual(calls)
    const other = await seedIdentity({ gate, payload })
    const otherSession = await session({ key: 'cursor-other-session', owner, payload })
    for (const [actor, path] of [
      [other, `/v1/creation-sessions/${sessionId}/generations?cursor=${cursor}`],
      [owner, `/v1/creation-sessions/${otherSession}/generations?cursor=${cursor}`],
      [owner, `/v1/artifacts?cursor=${cursor}`],
      [owner, `/v1/credits/ledger?cursor=${cursor}`],
    ] as const) {
      await failure({ code: 'INPUT_INVALID', owner: actor, path, payload, status: 400 })
    }
    const client = getCreationSQLiteAdapter({ payload }).client
    await client.execute({
      args: [first.items[0]!.id],
      sql: 'UPDATE generation_tasks SET is_deleted = 1, deleted_at = created_at, deleted_by = created_by WHERE id = ?',
    })
    const tombstones = await snapshot({ payload })
    const visible = await data<Page>({
      owner,
      path: `/v1/creation-sessions/${sessionId}/generations`,
      payload,
    })
    expect(visible.items.map(({ roundNo }) => roundNo)).toEqual(
      Array.from({ length: 20 }, (_, index) => 20 - index),
    )
    expect(visible.hasMore).toBe(false)
    expect(await snapshot({ payload })).toEqual(tombstones)
  })
})

function reset() {
  state.now = now
  state.kind = 'output'
  state.redisDown = false
  state.beforeWechat = null
  http.setFault('none')
  http.setConflict(412)
  http.observe(() => {})
}
function network() {
  return { image: state.imageCalls, naming: state.namingCalls, storage: http.requests.length }
}
function png({ color }: { color: string }) {
  return sharp({ create: { background: color, channels: 3, height: 2, width: 3 } })
    .png()
    .toBuffer()
}
function padded({ extra = 0, value }: { extra?: number; value: unknown }) {
  const json = JSON.stringify(value)
  return json + ' '.repeat(CREATION_JSON_MAX_BYTES - Buffer.byteLength(json) + extra)
}
async function snapshot({ payload }: { payload: Payload }) {
  const client = getCreationSQLiteAdapter({ payload }).client
  return Promise.all(
    [
      'generation_tasks',
      'credit_accounts',
      'credit_reservations',
      'credit_allocations',
      'credit_ledger',
      'creation_drafts',
    ].map(async (table) => (await client.execute(`SELECT * FROM ${table} ORDER BY id`)).rows),
  )
}
async function session({
  key = 'http-generation-session',
  owner,
  payload,
}: {
  key?: string
  owner: { templateId: number } & Owner
  payload: Payload
}) {
  return (
    await data<{ id: number }>({
      body: {
        clientRequestId: key,
        templateId: owner.templateId,
      },
      method: 'post',
      owner,
      path: '/v1/creation-sessions',
      payload,
      status: 201,
    })
  ).id
}
function quoteGenerate({
  input,
  owner,
  payload,
  sessionId,
}: {
  input: Input
  owner: Owner
  payload: Payload
  sessionId: number
}) {
  return data<Quote>({
    body: { input, sessionId },
    method: 'post',
    owner,
    path: '/v1/generation-quotes',
    payload,
  })
}
function submit({
  input,
  key,
  owner,
  payload,
  quote,
  sessionId,
}: {
  input: Input
  key: string
  owner: Owner
  payload: Payload
  quote: Quote
  sessionId: number
}) {
  return data<TaskDTO>({
    body: { clientRequestId: key, input, quoteToken: quote.quoteToken, sessionId },
    method: 'post',
    owner,
    path: '/v1/generations',
    payload,
    status: 201,
  })
}
async function publishEffect({ adminId, payload }: { adminId: number; payload: Payload }) {
  const storage = createS3ObjectStorage({
    backends: config.s3.backends,
    image: config.imageLimits,
    limits: config.s3.limits,
  })
  try {
    await storage.verifyBackend(config.s3.input)
    const register = createPayloadVerifiedMediaRegistration({ gate, payload, storage })
    const mediaIds: number[] = []
    for (const color of ['red', 'blue']) {
      const bytes = await png({ color })
      const digest = createHash('sha256').update(bytes).digest('hex')
      const facts = await storage.putImmutable({
        bytes,
        contentType: 'image/png',
        ref: { ...config.s3.input, key: `references/1/${randomUUID()}/${digest}` },
      })
      const media = await controlledWrite({
        gate,
        payload,
        work: ({ req }) =>
          register({
            actor: `admin:${adminId}`,
            facts,
            now,
            originalName: 'official.png',
            owner: null,
            purpose: 'example',
            req,
            visibility: 'official_public',
          }),
      })
      mediaIds.push(media.id)
    }
    const { templates } = getCoreRuntime({ payload })
    const template = await templates.create({
      adminId,
      code: 'http-effect',
      configuration: {
        costCredits: 2,
        displayConfigJson: JSON.stringify({
          name: 'HTTP effect',
          coverMediaId: mediaIds[1],
          examples: [{ inputMediaIds: [mediaIds[0]], outputMediaId: mediaIds[1] }],
        }),
        generationConfigJson: JSON.stringify({
          executorId: 'fixture-v1',
          parameters: { size: '1024x1024' },
          systemPrompt: 'PRIVATE effect HTTP fixture',
        }),
        inputSchemaJson: JSON.stringify({
          ...config.hostCaps,
          maxDescriptionLength: 0,
          minImages: 1,
        }),
        minClientCapability: 'v1',
        schemaVersion: 1,
        shareConfigJson: '{}',
      },
      kind: 'effect',
    })
    await templates.setStatus({ adminId, status: 'published', templateId: template.id })
    return { templateId: template.id }
  } finally {
    storage.close()
  }
}
async function data<T = unknown>({
  status = 200,
  ...args
}: { status?: number } & Parameters<typeof native>[0]): Promise<T> {
  const response = await native(args)
  expect(response.status).toBe(status)
  return (await envelope<T>({ response })).data
}
async function failure({
  code,
  status,
  ...args
}: { code: string; status: number } & Parameters<typeof native>[0]) {
  const response = await native(args)
  expect(response.status).toBe(status)
  expect((await envelope({ response })).error).toMatchObject({ code, retryable: false })
}
async function envelope<T = unknown>({ response }: { response: Response }): Promise<Envelope<T>> {
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/)
  const body = (await response.json()) as Envelope<T>
  expect(body.requestId).toBe(response.headers.get('x-request-id'))
  return body
}
function native({
  body,
  method = 'get',
  owner,
  path,
  payload,
}: {
  body?: BodyInit | Record<string, unknown>
  method?: 'get' | 'post' | 'put'
  owner?: Pick<Owner, 'token'>
  path: string
  payload: Payload
}) {
  const headers = new Headers(owner ? { authorization: `Bearer ${owner.token}` } : {})
  headers.set('x-request-id', 'caller-request-id-is-not-trusted')
  if (body !== undefined && !(body instanceof FormData)) {
    headers.set('content-type', 'application/json')
  }
  const handler =
    method === 'get'
      ? REST_GET(payload.config)
      : method === 'post'
        ? REST_POST(payload.config)
        : REST_PUT(payload.config)
  return wrapProductREST({ handler })(
    new Request(`${payload.config.serverURL}/api${path}`, {
      body:
        body instanceof FormData || typeof body === 'string'
          ? body
          : body === undefined
            ? undefined
            : JSON.stringify(body),
      headers,
      method: method.toUpperCase(),
    }),
    {
      params: Promise.resolve({
        slug: path.slice(1).split('?')[0]!.split('/').map(decodeURIComponent),
      }),
    },
  )
}
