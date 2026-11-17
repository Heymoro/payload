import type { Payload } from 'payload'

import { REST_GET } from '@payloadcms/next/routes'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { wrapProductREST } from '../../src/creation/http/rest-route.js'
import { createCreationRuntime } from '../../src/creation/infrastructure/payload/session-repository.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'
import { cleanupRuntime, config, gate, http, state } from './runtime.config.js'
import { audit, controlledWrite, now } from './runtime-seed.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const callerId = 'be5f54a2-e88a-4a15-993e-25bb4e16560a'
const sessionFields = ['id', 'lastActivityAt', 'mode', 'templateId', 'title', 'titleSource']
type Input = { description: string; inputMediaIds: number[]; userNotes: string }
type Body = {
  data: {
    draft: { input: Input }
    hasMore: boolean
    id: number
    input: Input
    items: { id: number; templateId: number; title: string }[]
    nextCursor: null | string
    templateId: number
    title: string
    token: string
    updatedAt: string
    user: { id: number }
  }
  error: { code: string; message: string; retryable: boolean }
  requestId: string
}

test.suite(
  'Heymoro catalog and session Native HTTP',
  { config: './runtime.config.ts', cron: false },
  () => {
    test.afterAll(cleanupRuntime)
    test.beforeEach(() => {
      state.wechatResult = { openId: 'http-owner', unionId: null }
    })
    test.afterEach(() => vi.restoreAllMocks())

    test('should expose anonymous public catalog and free preset through Native routes', async ({
      restClient,
    }) => {
      const response = await restClient.GET('/v1/templates', { auth: false })
      expect(response.status).toBe(200)
      expect((await envelope({ response })).data).toEqual({
        hasMore: false,
        items: [],
        nextCursor: null,
      })
      const preset = await restClient.GET('/v1/creation-presets/free', { auth: false })
      expect(preset.status).toBe(409)
      expect((await envelope({ response: preset })).error.code).toBe('TEMPLATE_UNAVAILABLE')
    })

    test('should preserve current public configuration taxonomy and anonymous filtered reads with no business writes or network', async ({
      payload,
      restClient,
    }) => {
      const effect = await seedCatalog({ mode: 'effect', payload })
      const free = await seedCatalog({ mode: 'free', payload })
      const client = getCreationSQLiteAdapter({ payload }).client
      const create = vi.spyOn(payload, 'create')
      const update = vi.spyOn(payload, 'update')
      const remove = vi.spyOn(payload, 'delete')
      const before = network()
      const results: Body[] = []
      for (const path of [
        `/v1/templates?categoryId=${effect.categoryId}&keyword=+VELVET+`,
        '/v1/template-taxonomies',
        `/v1/templates/${effect.templateId}`,
        '/v1/creation-presets/free',
      ]) {
        const response = await nativeGet({ path, payload })
        expect(response.status).toBe(200)
        const body = await envelope({ response })
        expect(JSON.stringify(body)).not.toMatch(
          /generationConfig|shareConfig|storage|createdBy|updatedBy|system:|SECRET|requestHash|tokenHash/,
        )
        results.push(body)
      }
      expect(results[0]!.data.items.map(({ templateId }) => templateId)).toEqual([
        effect.templateId,
      ])
      expect(results[1]!.data).toEqual({
        categories: [{ id: effect.categoryId, name: 'Category' }],
        labels: [{ id: effect.tagId, name: 'Velvet' }],
      })
      expect(results[2]!.data).toMatchObject({
        displayConfig: {
          categoryId: effect.categoryId,
          showcaseShareKeys: [],
          tags: [{ id: effect.tagId, name: 'Velvet' }],
        },
        inputSchema: { maxDescriptionLength: 0, minImages: 1 },
      })
      expect(results[3]!.data.templateId).toBe(free.templateId)
      expect(create).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
      expect(network()).toEqual(before)
      await client.execute({
        args: [effect.templateId],
        sql: "UPDATE creation_templates SET status = 'offline' WHERE id = ?",
      })
      const offline = await nativeGet({ path: `/v1/templates/${effect.templateId}`, payload })
      expect(offline.status).toBe(409)
      expect((await envelope({ response: offline })).error.code).toBe('TEMPLATE_UNAVAILABLE')
    })

    test('should retain an empty page continuation when the scan budget consumes only invisible templates', async ({
      payload,
      restClient,
    }) => {
      const runtime = createCreationRuntime({ gate, payload })
      await controlledWrite({
        gate,
        payload,
        work: async ({ req }) => {
          for (let index = 0; index < 501; index++) {
            await runtime.create({
              collection: 'creation-templates',
              data: {
                ...audit,
                ...catalogBody({ mode: 'effect' }),
                name: 'Hidden',
                code: `hidden-${index}`,
                kind: 'effect',
                sortOrder: index,
                status: 'published',
              },
              req,
            })
          }
        },
      })
      const first = await restClient.GET('/v1/templates?keyword=missing', { auth: false })
      expect(first.status).toBe(200)
      const page = (await envelope({ response: first })).data
      expect(page).toEqual({ hasMore: true, items: [], nextCursor: expect.any(String) })
      const next = await restClient.GET(
        `/v1/templates?keyword=missing&cursor=${encodeURIComponent(page.nextCursor!)}`,
        { auth: false },
      )
      expect(next.status).toBe(200)
      expect((await envelope({ response: next })).data).toEqual({
        hasMore: false,
        items: [],
        nextCursor: null,
      })
    })

    test('should reject malformed raw queries canonical IDs unknown owners and unbounded original keyword before public work', async ({
      payload,
      restClient,
    }) => {
      const effect = await seedCatalog({ mode: 'effect', payload })
      const find = vi.spyOn(payload, 'find')
      for (const path of [
        '/v1/templates?keyword=%',
        '/v1/templates?keyword=%FF',
        '/v1/templates?keyword=%C3%28',
        '/v1/templates?keyword=a&%6Beyword=b',
        '/v1/templates?keyword%5B%5D=a',
        '/v1/templates?owner=1',
        '/v1/templates?categoryId=01',
        '/v1/templates?categoryId=%2B1',
        '/v1/templates?categoryId=1e0',
        '/v1/templates?categoryId=9007199254740992',
        '/v1/templates?categoryId=',
        '/v1/template-taxonomies?',
        '/v1/creation-presets/free?x=1',
        `/v1/templates/${effect.templateId}?versionId=`,
        `/v1/templates/${effect.templateId}?versionId=01`,
        `/v1/templates/${effect.templateId}?versionId=9007199254740992`,
        '/v1/templates/01',
        '/v1/templates?keyword=' + '+'.repeat(201),
      ]) {
        const response = await nativeGet({ path, payload })
        expect(response.status).toBe(400)
        expect((await envelope({ response })).error.code).toBe('INPUT_INVALID')
      }
      expect(find).not.toHaveBeenCalled()
      const once = await restClient.GET('/v1/templates?keyword=%2520', { auth: false })
      expect(once.status).toBe(200)
      expect((await envelope({ response: once })).data.items).toEqual([])
    })

    test('should login create replay conflict save whole incomplete draft restore rename list and detail without generation', async ({
      payload,
      restClient,
    }) => {
      await seedCatalog({ mode: 'free', payload })
      const login = await restClient.POST('/v1/auth/wechat', {
        auth: false,
        body: JSON.stringify({ code: 'login' }),
      })
      expect(login.status).toBe(201)
      const identity = (await envelope({ response: login })).data
      const headers = { authorization: `Bearer ${identity.token}`, 'x-request-id': callerId }
      const presetResponse = await restClient.GET('/v1/creation-presets/free', { auth: false })
      const preset = (await envelope({ response: presetResponse })).data
      const command = {
        clientRequestId: ' ordered request ',
        templateId: preset.templateId,
      }
      const before = network()
      const created = await restClient.POST('/v1/creation-sessions', {
        auth: false,
        body: JSON.stringify(command),
        headers,
      })
      expect(created.status).toBe(201)
      const session = (await envelope({ response: created })).data
      expect(Object.keys(session).sort()).toEqual(sessionFields)
      const path = `/v1/creation-sessions/${session.id}` as const
      const empty = await restClient.GET(`${path}/draft`, { auth: false, headers })
      expect((await envelope({ response: empty })).data).toEqual({
        input: { description: '', inputMediaIds: [], userNotes: '' },
        updatedAt: now,
      })
      const padded = await restClient.PUT(`${path}/draft`, {
        auth: false,
        body:
          JSON.stringify({ description: ' incomplete ', inputMediaIds: [], userNotes: '' }) +
          ' '.repeat(17000),
        headers,
      })
      expect(padded.status).toBe(200)
      const mediaIds = await seedMedia({ payload, userId: identity.user.id })
      const input = {
        description: '  literal\n文字  ',
        inputMediaIds: [...mediaIds].reverse(),
        userNotes: '',
      }
      const saved = await restClient.PUT(`${path}/draft`, {
        auth: false,
        body: JSON.stringify(input),
        headers,
      })
      expect(saved.status).toBe(200)
      expect((await envelope({ response: saved })).data).toEqual({
        input,
        updatedAt: expect.any(String),
      })
      const renamed = await restClient.PATCH(path, {
        auth: false,
        body: JSON.stringify({ title: '  My draft  ' }),
        headers,
      })
      expect(renamed.status).toBe(200)
      expect((await envelope({ response: renamed })).data).toEqual({
        sessionId: session.id,
        title: 'My draft',
        titleSource: 'user',
      })
      const replay = await restClient.POST('/v1/creation-sessions', {
        auth: false,
        body: JSON.stringify(command),
        headers,
      })
      expect(replay.status).toBe(200)
      const replayed = (await envelope({ response: replay })).data
      expect(replayed).toEqual({ ...session, title: 'My draft', titleSource: 'user' })
      expect(Object.keys(replayed).sort()).toEqual(sessionFields)
      const conflict = await restClient.POST('/v1/creation-sessions', {
        auth: false,
        body: JSON.stringify({ ...command, templateId: command.templateId + 999 }),
        headers,
      })
      expect(conflict.status).toBe(409)
      expect((await envelope({ response: conflict })).error.code).toBe('IDEMPOTENCY_CONFLICT')
      await getCreationSQLiteAdapter({ payload }).client.execute({
        args: [mediaIds[0]!],
        sql: "UPDATE media SET lifecycle = 'pendingDelete' WHERE id = ?",
      })
      const create = vi.spyOn(payload, 'create')
      const update = vi.spyOn(payload, 'update')
      for (const suffix of ['', '/draft']) {
        const restored = await restClient.GET(`${path}${suffix}`, { auth: false, headers })
        expect(restored.status).toBe(200)
        const data = (await envelope({ response: restored })).data
        expect(suffix ? data.input : data.draft.input).toEqual(input)
        expect(JSON.stringify(data)).not.toMatch(
          /requestHash|clientRequestId|userId|autoName|coverArtifact|nextRoundNo|createdBy|storage|tokenHash/,
        )
      }
      const listed = await restClient.GET('/v1/creation-sessions', { auth: false, headers })
      expect(listed.status).toBe(200)
      expect((await envelope({ response: listed })).data.items).toMatchObject([
        { id: session.id, title: 'My draft' },
      ])
      expect(create).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
      expect(network()).toEqual(before)
      const client = getCreationSQLiteAdapter({ payload }).client
      expect((await client.execute('SELECT * FROM generation_tasks')).rows).toHaveLength(0)
      expect((await client.execute('SELECT * FROM creation_drafts')).rows).toHaveLength(1)
    })

    test('should enforce owner isolation missing parity credential validity strict bodies and no query on private paths', async ({
      payload,
      restClient,
    }) => {
      const preset = await seedCatalog({ mode: 'free', payload })
      const first = await getCoreRuntime({ payload }).identity.login({ input: { code: 'first' } })
      state.wechatResult = { openId: 'other-owner', unionId: null }
      const second = await getCoreRuntime({ payload }).identity.login({ input: { code: 'second' } })
      const headers = { authorization: `Bearer ${first.token}` }
      const other = { authorization: `Bearer ${second.token}` }
      const command = {
        clientRequestId: 'owner',
        templateId: preset.templateId,
      }
      const created = await restClient.POST('/v1/creation-sessions', {
        auth: false,
        body: JSON.stringify(command),
        headers,
      })
      expect(created.status).toBe(201)
      const sessionId = (await envelope({ response: created })).data.id
      for (const id of [sessionId, 999999]) {
        for (const suffix of ['', '/draft']) {
          const response = await restClient.GET(`/v1/creation-sessions/${id}${suffix}`, {
            auth: false,
            headers: other,
          })
          expect(response.status).toBe(404)
          expect((await envelope({ response })).error.code).toBe('NOT_FOUND')
        }
        const rename = await restClient.PATCH(`/v1/creation-sessions/${id}`, {
          auth: false,
          body: '{"title":"X"}',
          headers: other,
        })
        expect(rename.status).toBe(404)
        const save = await restClient.PUT(`/v1/creation-sessions/${id}/draft`, {
          auth: false,
          body: '{}',
          headers: other,
        })
        expect(save.status).toBe(404)
      }
      for (const body of [
        { ...command, userId: second.user.id },
        { ...command, templateId: String(command.templateId) },
        { ...command, title: 'system' },
        { ...command, requestHash: 'spoof' },
      ]) {
        const response = await restClient.POST('/v1/creation-sessions', {
          auth: false,
          body: JSON.stringify(body),
          headers,
        })
        expect(response.status).toBe(400)
        expect((await envelope({ response })).error.code).toBe('INPUT_INVALID')
      }
      for (const body of [
        { title: 'X', userId: second.user.id },
        { title: 'X', titleSource: 'ai' },
        { autoNameStatus: 'succeeded', title: 'X' },
      ]) {
        const response = await restClient.PATCH(`/v1/creation-sessions/${sessionId}`, {
          auth: false,
          body: JSON.stringify(body),
          headers,
        })
        expect(response.status).toBe(400)
      }
      for (const input of [
        { userId: first.user.id },
        { inputMediaIds: ['wxfile://tmp/photo'] },
        { description: 'x'.repeat(201) },
        { userNotes: 'not permitted in free' },
      ]) {
        const response = await restClient.PUT(`/v1/creation-sessions/${sessionId}/draft`, {
          auth: false,
          body: JSON.stringify(input),
          headers,
        })
        expect(response.status).toBe(400)
      }
      for (const path of [
        '/v1/creation-sessions?userId=1',
        `/v1/creation-sessions/${sessionId}?x=1`,
        `/v1/creation-sessions/${sessionId}/draft?owner=1`,
        '/v1/creation-sessions/01',
        '/v1/creation-sessions/9007199254740992',
      ]) {
        const response = await restClient.GET(path as `/${string}`, { auth: false, headers })
        expect(response.status).toBe(400)
      }
      for (const authorization of [undefined, 'Bearer invalid', `Bearer ${'A'.repeat(43)}`]) {
        const response = await restClient.GET('/v1/creation-sessions', {
          auth: false,
          headers: authorization ? { authorization } : undefined,
        })
        expect(response.status).toBe(401)
        expect((await envelope({ response })).error.code).toBe('UNAUTHENTICATED')
      }
      const client = getCreationSQLiteAdapter({ payload }).client
      const mediaIds = await seedMedia({ payload, userId: first.user.id })
      await client.execute({
        args: [second.user.id, mediaIds[0]!],
        sql: 'UPDATE media SET owner = ? WHERE id = ?',
      })
      await client.execute({
        args: [mediaIds[1]!],
        sql: "UPDATE media SET lifecycle = 'uploading' WHERE id = ?",
      })
      for (const mediaId of mediaIds) {
        const response = await restClient.PUT(`/v1/creation-sessions/${sessionId}/draft`, {
          auth: false,
          body: JSON.stringify({ inputMediaIds: [mediaId] }),
          headers,
        })
        expect(response.status).toBe(400)
        expect((await envelope({ response })).error.code).toBe('INPUT_INVALID')
      }
      for (const [bytes, status] of [
        [17000, 413],
        [131073, 413],
      ] as const) {
        const response =
          bytes === 17000
            ? await restClient.POST('/v1/creation-sessions', {
                auth: false,
                body: ' '.repeat(bytes),
                headers,
              })
            : await restClient.PUT(`/v1/creation-sessions/${sessionId}/draft`, {
                auth: false,
                body: ' '.repeat(bytes),
                headers,
              })
        expect(response.status).toBe(status)
        expect((await envelope({ response })).error.code).toBe('HTTP_BODY_TOO_LARGE')
      }
      const badIdentity = await restClient.POST('/v1/auth/wechat', { auth: false, body: '{' })
      expect(badIdentity.status).toBe(400)
      expect((await envelope({ response: badIdentity })).error.code).toBe('AUTH_INPUT_INVALID')
      const postQuery = await restClient.POST('/v1/creation-sessions?owner=1', {
        auth: false,
        body: JSON.stringify(command),
        headers,
      })
      expect(postQuery.status).toBe(400)
      const patchQuery = await restClient.PATCH(`/v1/creation-sessions/${sessionId}?x=1`, {
        auth: false,
        body: '{"title":"X"}',
        headers,
      })
      expect(patchQuery.status).toBe(400)
      const putQuery = await restClient.PUT(`/v1/creation-sessions/${sessionId}/draft?x=1`, {
        auth: false,
        body: '{}',
        headers,
      })
      expect(putQuery.status).toBe(400)
      expect((await client.execute('SELECT * FROM creation_sessions')).rows).toHaveLength(1)
      expect((await client.execute('SELECT * FROM generation_tasks')).rows).toHaveLength(0)
      await client.execute({
        args: [now, first.user.id],
        sql: 'UPDATE user_sessions SET expires_at = ? WHERE user_id = ?',
      })
      expect((await restClient.GET('/v1/creation-sessions', { auth: false, headers })).status).toBe(
        401,
      )
      await client.execute({
        args: [second.user.id],
        sql: "UPDATE users SET status = 'disabled' WHERE id = ?",
      })
      expect(
        (await restClient.GET('/v1/creation-sessions', { auth: false, headers: other })).status,
      ).toBe(401)
    })

    test('should map real duplicate identity session evidence to 503 before business mutation and preserve unknown errors as 500', async ({
      payload,
      restClient,
    }) => {
      const preset = await seedCatalog({ mode: 'free', payload })
      const login = await getCoreRuntime({ payload }).identity.login({
        input: { code: 'duplicate' },
      })
      const client = getCreationSQLiteAdapter({ payload }).client
      const index = (
        await client.execute(
          "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='user_sessions' AND sql LIKE '%UNIQUE%' AND sql LIKE '%token_hash%'",
        )
      ).rows[0]!
      const columns = (await client.execute("PRAGMA table_info('user_sessions')")).rows
        .filter((row) => row.name !== 'id')
        .map((row) => quote({ value: row.name as string }))
        .join(',')
      await client.execute(`DROP INDEX ${quote({ value: index.name as string })}`)
      let duplicateId: number | undefined
      try {
        duplicateId = Number(
          (
            await client.execute(
              `INSERT INTO user_sessions (${columns}) SELECT ${columns} FROM user_sessions LIMIT 1`,
            )
          ).lastInsertRowid,
        )
        const create = vi.spyOn(payload, 'create')
        const update = vi.spyOn(payload, 'update')
        const response = await restClient.POST('/v1/creation-sessions', {
          auth: false,
          body: JSON.stringify({
            clientRequestId: 'duplicate',
            templateId: preset.templateId,
          }),
          headers: { authorization: `Bearer ${login.token}` },
        })
        expect(response.status).toBe(503)
        expect((await envelope({ response })).error.code).toBe('DATA_INTEGRITY_CONFLICT')
        expect(create).not.toHaveBeenCalled()
        expect(update).not.toHaveBeenCalled()
        const find = vi
          .spyOn(payload, 'find')
          .mockRejectedValue(
            Object.assign(new Error('SECRET'), { code: 'AUTH_UNAUTHENTICATED', status: 401 }),
          )
        const unknown = await restClient.GET('/v1/creation-sessions', {
          auth: false,
          headers: { authorization: `Bearer ${login.token}` },
        })
        expect(unknown.status).toBe(500)
        expect((await envelope({ response: unknown })).error).toEqual({
          code: 'INTERNAL_ERROR',
          message: 'Internal server error.',
          retryable: false,
        })
        find.mockRestore()
      } finally {
        if (duplicateId !== undefined) {
          await client.execute({
            args: [duplicateId],
            sql: 'DELETE FROM user_sessions WHERE id = ?',
          })
        }
        await client.execute(index.sql as string)
      }
    })
  },
)

async function envelope({ response }: { response: Response }): Promise<Body> {
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const requestId = response.headers.get('x-request-id')
  expect(requestId).toMatch(uuid)
  expect(requestId).not.toBe(callerId)
  const body = (await response.json()) as Body
  expect(body.requestId).toBe(requestId)
  return body
}
function network() {
  return { image: state.imageCalls, naming: state.namingCalls, storage: http.requests.length }
}
async function seedCatalog({ mode, payload }: { mode: 'effect' | 'free'; payload: Payload }) {
  const runtime = createCreationRuntime({ gate, payload })
  const fixture = await controlledWrite({
    gate,
    payload,
    work: async ({ req }) => {
      let categoryId: null | number = null
      let tagId: null | number = null
      if (mode === 'effect') {
        const category = await runtime.create({
          collection: 'taxonomy-terms',
          data: {
            ...audit,
            name: 'Category',
            code: 'category',
            kind: 'category',
            sortOrder: 0,
            status: 'active',
          },
          req,
        })
        const tag = await runtime.create({
          collection: 'taxonomy-terms',
          data: {
            ...audit,
            name: 'Velvet',
            code: 'label',
            kind: 'label',
            sortOrder: 0,
            status: 'active',
          },
          req,
        })
        categoryId = Number(category.id)
        tagId = Number(tag.id)
      }
      const doc = await runtime.create({
        collection: 'creation-templates',
        data: {
          ...audit,
          ...catalogBody({ categoryId, mode, tagId }),
          name: 'Mutable',
          code: mode,
          kind: mode,
          primaryCategoryId: categoryId,
          sortOrder: 0,
          status: 'published',
        },
        req,
      })
      return { categoryId, tagId, templateId: Number(doc.id) }
    },
  })
  return fixture
}

function catalogBody({
  categoryId = null,
  mode,
  tagId = null,
}: {
  categoryId?: null | number
  mode: 'effect' | 'free'
  tagId?: null | number
}) {
  return {
    costCredits: 2,
    displayConfigJson: JSON.stringify({
      name: 'Velvet public',
      coverMediaId: mode === 'effect' ? 21 : null,
      showcaseShareKeys: [],
      ...(mode === 'effect' && categoryId !== null && tagId !== null
        ? {
            categoryId,
            categoryName: 'Category',
            primaryTagId: tagId,
            searchAliases: ['Portrait'],
            tagIds: [tagId],
            tags: [{ id: tagId, name: 'Velvet' }],
          }
        : {}),
    }),
    generationConfigJson: '{"prompt":"SECRET"}',
    inputSchemaJson: JSON.stringify({
      ...config.hostCaps,
      ...(mode === 'effect' && categoryId !== null && tagId !== null
        ? { maxDescriptionLength: 0, minImages: 1 }
        : { maxNotesLength: 0 }),
    }),
    minClientCapability: 'v1',
    schemaVersion: 1,
    shareConfigJson: '{"internal":"SECRET"}',
  }
}
/** Completed owned-media metadata only: this fixture performs no multipart upload or object I/O. */
async function seedMedia({ payload, userId }: { payload: Payload; userId: number }) {
  const runtime = createCreationRuntime({ gate, payload })
  return controlledWrite({
    gate,
    payload,
    work: async ({ req }) => {
      const ids: number[] = []
      for (let index = 0; index < 2; index++) {
        const doc = await runtime.create({
          collection: 'media',
          data: {
            ...audit,
            alt: 'Fixture',
            filename: `http-${index}.png`,
            filesize: 500,
            mimeType: 'image/png',
            originalName: `http-${index}.png`,
            owner: userId,
            purpose: 'reference',
            sha256: 'a'.repeat(64),
            storageBackend: 'fixture-metadata',
            storageBucket: 'fixture-input',
            storageName: `http-${index}.png`,
            visibility: 'private',
          },
          req,
        })
        ids.push(Number(doc.id))
      }
      return ids
    },
  })
}

function quote({ value }: { value: string }) {
  return `"${value.replaceAll('"', '""')}"`
}

function nativeGet({ path, payload }: { path: string; payload: Payload }) {
  return wrapProductREST({ handler: REST_GET(payload.config) })(
    new Request(`${payload.config.serverURL}/api${path}`),
    {
      params: Promise.resolve({
        slug: path
          .slice(1)
          .split('?')[0]!
          .split('/')
          .map((segment) => decodeURIComponent(segment)),
      }),
    },
  )
}
