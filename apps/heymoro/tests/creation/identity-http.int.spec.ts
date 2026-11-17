import type { Payload } from 'payload'

import { REST_POST } from '@payloadcms/next/routes'
import assert from 'node:assert/strict'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { blankBody } from '../../src/admin/template-management-form.js'
import { requireNativeAdmin } from '../../src/creation/http/native-admin-auth.js'
import { wrapProductREST } from '../../src/creation/http/rest-route.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'
import { cleanupRuntime, gate, state } from './runtime.config.js'
import { controlledWrite, now } from './runtime-seed.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const callerId = 'be5f54a2-e88a-4a15-993e-25bb4e16560a'

test.suite(
  'Heymoro identity thin HTTP with official Native route fixtures',
  { config: './runtime.config.ts', cron: false },
  () => {
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

    test('should authenticate Native cookie for management and recheck disabled accounts before every runtime write', async ({
      payload,
    }) => {
      const runtime = getCoreRuntime({ payload })
      const admin = await controlledWrite({
        gate,
        payload,
        work: ({ req }) =>
          gate.run({
            req,
            work: () =>
              payload.create({
                collection: 'admins',
                data: {
                  email: 'template-form@fixture.invalid',
                  password: 'fixture-template-form-password-137',
                  role: 'operator',
                  status: 'active',
                } as never,
                overrideAccess: true,
                req,
              }),
          }),
      })
      const login = await payload.login({
        collection: 'admins',
        data: {
          email: 'template-form@fixture.invalid',
          password: 'fixture-template-form-password-137',
        },
      })
      const nativeHeaders = new Headers({
        cookie: `payload-token=${login.token}`,
        origin: 'http://127.0.0.1:3001',
      })
      const principal = await requireNativeAdmin({ headers: nativeHeaders, payload })
      expect(principal.id).toBe(admin.id)
      expect((await runtime.templates.list({ adminId: principal.id, input: {} })).items).toEqual([])
      for (const headers of [
        new Headers(),
        new Headers({ authorization: `Bearer ${login.token}` }),
        new Headers({ cookie: 'payload-token=opaque', origin: 'http://127.0.0.1:3001' }),
      ]) {
        await expect(requireNativeAdmin({ headers, payload })).rejects.toMatchObject({
          code: expect.stringMatching(/^ADMIN_/),
        })
      }
      const options = await runtime.templates.getOptions({ adminId: principal.id })
      const body = blankBody({ kind: 'free', options })
      const template = await runtime.templates.create({
        adminId: principal.id,
        code: 'free',
        configuration: {
          ...body,
          displayConfigJson: JSON.stringify({
            ...JSON.parse(body.displayConfigJson),
            name: 'Native public',
          }),
          generationConfigJson: JSON.stringify({
            executorId: 'fixture-v1',
            parameters: { size: '1024x1024' },
            systemPrompt: 'Native clock',
          }),
        },
        kind: 'free',
      })
      await runtime.templates.setStatus({
        adminId: principal.id,
        status: 'published',
        templateId: template.id,
      })
      const clockAudit = (
        await getCreationSQLiteAdapter({ payload }).client.execute(
          "SELECT summary, created_at FROM audit_logs WHERE action = 'template.publish'",
        )
      ).rows[0]!
      expect(JSON.parse(clockAudit.summary as string)).toMatchObject({ status: 'published' })
      expect(new Date(String(clockAudit.created_at)).toISOString()).toBe(state.now)
      await controlledWrite({
        gate,
        payload,
        work: ({ req }) =>
          gate.run({
            req,
            work: () =>
              payload.create({
                collection: 'admins',
                data: {
                  email: 'template-guardian@fixture.invalid',
                  password: 'fixture-guardian-password-137',
                  role: 'admin',
                  status: 'active',
                } as never,
                overrideAccess: true,
                req,
              }),
          }),
      })
      await controlledWrite({
        gate,
        payload,
        work: ({ req }) =>
          gate.run({
            req,
            work: () =>
              payload.update({
                id: admin.id,
                collection: 'admins',
                data: { status: 'disabled' } as never,
                overrideAccess: true,
                req,
              }),
          }),
      })
      await expect(requireNativeAdmin({ headers: nativeHeaders, payload })).rejects.toMatchObject({
        code: 'ADMIN_FORBIDDEN',
      })
      const adapter = getCreationSQLiteAdapter({ payload })
      const before = (await adapter.client.execute('SELECT * FROM audit_logs ORDER BY id')).rows
      await expect(
        runtime.templates.setStatus({
          adminId: principal.id,
          status: 'offline',
          templateId: template.id,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
      await expect(runtime.templates.getOptions({ adminId: principal.id })).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      })
      expect((await adapter.client.execute('SELECT * FROM audit_logs ORDER BY id')).rows).toEqual(
        before,
      )
      expect(state.imageCalls).toBe(0)
    })

    test('should deliver login me profile no-op and idempotent logout with one server UUID per identity mutation', async ({
      payload,
      restClient,
    }) => {
      const loginResponse = await restClient.POST('/v1/auth/wechat', {
        auth: false,
        body: JSON.stringify({ code: 'fixture-A' }),
        headers: { 'x-request-id': callerId },
      })
      expect(loginResponse.status).toBe(201)
      const login = await envelope({ response: loginResponse })
      expect(login.requestId).not.toBe(callerId)
      expect(Object.keys(login.data).sort()).toEqual(['expiresAt', 'token', 'user'])
      const user = login.data.user
      expect(user).toEqual({
        id: expect.any(Number),
        avatarUrl: null,
        displayName: '微信用户',
        status: 'active',
      })
      const authorization = `Bearer ${login.data.token}`
      expect((await audits({ payload }))[0]).toMatchObject({
        correlationId: login.requestId,
        requestId: login.requestId,
      })
      const me = await restClient.GET('/v1/me', { auth: false, headers: { authorization } })
      expect(me.status).toBe(200)
      expect((await envelope({ response: me })).data).toEqual(user)
      const patch = await restClient.PATCH('/v1/me', {
        auth: false,
        body: JSON.stringify({ displayName: 'New name' }),
        headers: { authorization },
      })
      expect(patch.status).toBe(200)
      const changed = await envelope({ response: patch })
      expect(changed.data).toEqual({ ...user, displayName: 'New name' })
      expect((await audits({ payload }))[1]).toMatchObject({
        action: 'user.profile.update',
        correlationId: changed.requestId,
        requestId: changed.requestId,
      })
      const before = await audits({ payload })
      const noop = await restClient.PATCH('/v1/me', {
        auth: false,
        body: JSON.stringify({ displayName: 'New name' }),
        headers: { authorization },
      })
      expect(noop.status).toBe(200)
      expect((await envelope({ response: noop })).data).toEqual(changed.data)
      expect(await audits({ payload })).toEqual(before)
      const logout = await restClient.POST('/v1/auth/logout', {
        auth: false,
        headers: { authorization },
      })
      expect(logout.status).toBe(204)
      expect(await logout.text()).toBe('')
      expect(logout.headers.get('cache-control')).toBe('private, no-store')
      expect(logout.headers.get('x-request-id')).toMatch(uuid)
      expect((await audits({ payload }))[2]).toMatchObject({
        action: 'auth.session.revoke',
        correlationId: logout.headers.get('x-request-id'),
        requestId: logout.headers.get('x-request-id'),
      })
      const all = await audits({ payload })
      expect(new Set(all.map((row) => row.requestId)).size).toBe(3)
      const again = await restClient.POST('/v1/auth/logout', {
        auth: false,
        headers: { authorization },
      })
      expect(again.status).toBe(204)
      expect(await audits({ payload })).toEqual(all)
      expect(
        (await restClient.GET('/v1/me', { auth: false, headers: { authorization } })).status,
      ).toBe(401)
    })

    test('should reject bad bodies queries and media types before provider work', async ({
      restClient,
    }) => {
      for (const entry of [
        { body: '{', path: '/v1/auth/wechat', status: 400 },
        { body: '{}', path: '/v1/auth/wechat', status: 400 },
        { body: '{"code":"A","userId":1}', path: '/v1/auth/wechat', status: 400 },
        { body: '{"code":"A"}', path: '/v1/auth/wechat?userId=1', status: 400 },
        { body: '{"code":"A"}', contentType: 'text/plain', path: '/v1/auth/wechat', status: 415 },
        { body: '"' + 'x'.repeat(16384) + '"', path: '/v1/auth/wechat', status: 413 },
        { body: '{}', path: '/v1/auth/logout', status: 400 },
        { path: '/v1/auth/logout?a=1', status: 400 },
      ] as const) {
        const response = await restClient.POST(entry.path, {
          auth: false,
          body: entry.body,
          headers: {
            'content-type':
              ('contentType' in entry ? entry.contentType : undefined) ?? 'application/json',
          },
        })
        expect(response.status).toBe(entry.status)
        await envelope({ response })
      }
      expect((await restClient.GET('/v1/me?userId=1', { auth: false })).status).toBe(400)
      expect(state.wechatCalls).toBe(0)
    })

    test('should reject malformed logout headers but retain missing and valid unknown idempotence', async ({
      restClient,
    }) => {
      for (const authorization of [
        '',
        'Bearer invalid',
        'JWT fixture',
        `Bearer ${'A'.repeat(43)} extra`,
      ]) {
        const response = await restClient.POST('/v1/auth/logout', {
          auth: false,
          headers: { authorization },
        })
        expect(response.status).toBe(400)
        expect((await envelope({ response })).error.code).toBe('AUTH_INPUT_INVALID')
      }
      expect((await restClient.POST('/v1/auth/logout', { auth: false })).status).toBe(204)
      expect(
        (
          await restClient.POST('/v1/auth/logout', {
            auth: false,
            headers: { authorization: `Bearer ${Buffer.alloc(32, 77).toString('base64url')}` },
          })
        ).status,
      ).toBe(204)
    })

    for (const condition of ['expired', 'disabled'] as const) {
      test(`should revoke ${condition} sessions over HTTP without applying the active-auth guard`, async ({
        payload,
        restClient,
      }) => {
        const login = await getCoreRuntime({ payload }).identity.login({ input: { code: 'A' } })
        const client = getCreationSQLiteAdapter({ payload }).client
        if (condition === 'expired') {
          await client.execute({ args: [now], sql: 'UPDATE user_sessions SET expires_at = ?' })
        } else {
          await client.execute("UPDATE users SET status = 'disabled'")
        }
        const authorization = `Bearer ${login.token}`
        expect(
          (await restClient.GET('/v1/me', { auth: false, headers: { authorization } })).status,
        ).toBe(401)
        const result = await restClient.POST('/v1/auth/logout', {
          auth: false,
          headers: { authorization },
        })
        expect(result.status).toBe(204)
        expect((await audits({ payload })).at(-1)).toMatchObject({
          action: 'auth.session.revoke',
          requestId: result.headers.get('x-request-id'),
        })
        expect(
          (await client.execute('SELECT revoked_at FROM user_sessions')).rows[0]!.revoked_at,
        ).not.toBeNull()
      })
    }

    test('should ignore body owner fields and Native staff credentials for business ownership', async ({
      payload,
      restClient,
    }) => {
      const first = await getCoreRuntime({ payload }).identity.login({ input: { code: 'A' } })
      state.wechatResult = { openId: 'other-owner', unionId: null }
      const second = await getCoreRuntime({ payload }).identity.login({ input: { code: 'B' } })
      const response = await restClient.PATCH('/v1/me', {
        auth: false,
        body: JSON.stringify({ displayName: 'Spoof', userId: second.user.id }),
        headers: { authorization: `Bearer ${first.token}` },
      })
      expect(response.status).toBe(400)
      expect(
        await getCoreRuntime({ payload }).identity.getMe({
          authorization: `Bearer ${second.token}`,
        }),
      ).toEqual(second.user)
      const staff = await staffAuthorization({ payload })
      expect(
        (await restClient.GET('/v1/me', { auth: false, headers: { authorization: staff } })).status,
      ).toBe(401)
    })

    test('should deny raw Native list byID me and GraphQL records for anonymous opaque and staff principals', async ({
      payload,
      restClient,
    }) => {
      const login = await getCoreRuntime({ payload }).identity.login({ input: { code: 'A' } })
      const staff = await staffAuthorization({ payload })
      for (const authorization of [undefined, `Bearer ${login.token}`, staff]) {
        const headers = authorization ? { authorization } : undefined
        for (const path of ['/users', `/users/${login.user.id}`] as const) {
          const response = await restClient.GET(path, { auth: false, headers })
          expect([401, 403, 404]).toContain(response.status)
          expect(JSON.stringify(await response.json())).not.toMatch(
            /createdBy|deletedBy|fixture-open|tokenHash|微信用户/,
          )
        }
        const me = await restClient.GET('/users/me', { auth: false, headers })
        const meBody = await me.json()
        const isOpaque = authorization?.startsWith('Bearer ') === true
        expect(me.status).toBe(isOpaque ? 403 : 200)
        expect(meBody.user).toBe(isOpaque ? undefined : null)
        expect(JSON.stringify(meBody)).not.toMatch(
          /createdBy|updatedBy|deletedBy|isDeleted|tokenHash|openId/,
        )
        const gql = await restClient.GRAPHQL_POST({
          auth: false,
          body: JSON.stringify({
            query: `query { Users { docs { id displayName createdBy } } User(id: ${login.user.id}) { id displayName createdBy } }`,
          }),
          headers,
        })
        const graph = await gql.json()
        expect(graph.errors).toBeDefined()
        expect(JSON.stringify(graph.data)).not.toMatch(/微信用户|system:wechat-auth|createdBy/)
      }
      const nativeStaff = await restClient.GET('/admins', {
        auth: false,
        headers: { authorization: staff },
      })
      expect(nativeStaff.status).toBe(200)
      expect((await nativeStaff.json()).docs).toHaveLength(2)
    })

    for (const header of ['X-Payload-HTTP-Method-Override', 'X-HTTP-Method-Override']) {
      test(`should wrap the actual Native REST_POST before override body parsing for decoded v1: ${header}`, async ({
        payload,
      }) => {
        const handler = wrapProductREST({ handler: REST_POST(payload.config) })
        let pulls = 0
        const request = new Request(`${payload.config.serverURL}/api/%76%31/auth/wechat`, {
          body: new ReadableStream(
            {
              pull() {
                pulls++
              },
            },
            { highWaterMark: 0 },
          ),
          duplex: 'half',
          headers: { 'content-type': 'application/json', [header]: 'GET' },
          method: 'POST',
        } as RequestInit)
        const response = await handler(request, {
          params: Promise.resolve({ slug: ['v1', 'auth', 'wechat'] }),
        })
        expect(response.status).toBe(400)
        expect(pulls).toBe(0)
        expect(request.bodyUsed).toBe(false)
        expect(state.wechatCalls).toBe(0)
        await envelope({ response })
        const pass = await handler(
          new Request(`${payload.config.serverURL}/api/v1/auth/logout`, { method: 'POST' }),
          { params: Promise.resolve({ slug: ['v1', 'auth', 'logout'] }) },
        )
        expect(pass.status).toBe(204)
      })
    }

    test('should bound actual Native streams by bytes fatal UTF8 and one deadline before exchange', async ({
      payload,
    }) => {
      const handler = wrapProductREST({ handler: REST_POST(payload.config) })
      const params = { params: Promise.resolve({ slug: ['v1', 'auth', 'wechat'] }) }
      for (const [bytes, status] of [
        [new Uint8Array([0xc3, 0x28]), 400],
        [new Uint8Array(16385), 413],
      ] as const) {
        const request = new Request(`${payload.config.serverURL}/api/v1/auth/wechat`, {
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(bytes)
              controller.close()
            },
          }),
          duplex: 'half',
          headers: { 'content-length': '1', 'content-type': 'application/json' },
          method: 'POST',
        } as RequestInit)
        const response = await handler(request, params)
        expect(response.status).toBe(status)
        await envelope({ response })
      }
      let cancelled = false
      const body = new ReadableStream({
        cancel() {
          cancelled = true
          return new Promise(() => {})
        },
      })
      const request = new Request(`${payload.config.serverURL}/api/v1/auth/wechat`, {
        body,
        duplex: 'half',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      } as RequestInit)
      const response = await handler(request, params)
      expect(response.status).toBe(408)
      expect((await envelope({ response })).error.code).toBe('HTTP_REQUEST_TIMEOUT')
      expect(cancelled).toBe(true)
      expect(body.locked).toBe(false)
      expect(state.wechatCalls).toBe(0)
    })

    test('should serialize only trusted fixed errors and readiness with the same body/header UUID and no raw logging', async ({
      payload,
      restClient,
    }) => {
      const login = await getCoreRuntime({ payload }).identity.login({ input: { code: 'A' } })
      const find = vi
        .spyOn(payload, 'find')
        .mockRejectedValue(
          Object.assign(new Error('SECRET'), { code: 'AUTH_INPUT_INVALID', status: 400 }),
        )
      const logger = vi.spyOn(payload.logger, 'error')
      const response = await restClient.GET('/v1/me', {
        auth: false,
        headers: { authorization: `Bearer ${login.token}`, 'x-request-id': callerId },
      })
      expect(response.status).toBe(500)
      expect((await envelope({ response })).error).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        retryable: false,
      })
      const unhealthy = await restClient.GET('/v1/health/ready', {
        auth: false,
        headers: { 'x-request-id': callerId },
      })
      expect(unhealthy.status).toBe(503)
      expect((await envelope({ response: unhealthy })).error.code).toBe('NOT_READY')
      expect(logger).not.toHaveBeenCalled()
      find.mockRestore()
      const healthy = await restClient.GET('/v1/health/ready', {
        auth: false,
        headers: { 'x-request-id': callerId },
      })
      expect(healthy.status).toBe(200)
      const body = await envelope({ response: healthy })
      expect(body.requestId).not.toBe(callerId)
      expect(body.data).toEqual({ database: 'ok', status: 'ready' })
    })
  },
)

async function envelope({ response }: { response: Response }) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const id = response.headers.get('x-request-id')
  assert.match(id ?? '', uuid)
  const body = await response.json()
  assert.equal(body.requestId, id)
  return body
}

async function audits({ payload }: { payload: Payload }) {
  return (
    await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      pagination: false,
      sort: 'id',
    })
  ).docs
}

async function staffAuthorization({ payload }: { payload: Payload }): Promise<string> {
  const email = 'fixture-staff@local.invalid'
  const password = 'fixture-password-137'
  await controlledWrite({
    gate,
    payload,
    work: ({ req }) =>
      gate.run({
        req,
        work: () =>
          payload.create({
            collection: 'admins',
            data: {
              email: 'fixture-admin@local.invalid',
              password,
              role: 'admin',
              status: 'active',
            },
            overrideAccess: true,
            req,
          }),
      }),
  })
  await controlledWrite({
    gate,
    payload,
    work: ({ req }) =>
      gate.run({
        req,
        work: () =>
          payload.create({
            collection: 'admins',
            data: { email, password, role: 'operator', status: 'active' },
            overrideAccess: true,
            req,
          }),
      }),
  })
  const result = await payload.login({ collection: 'admins', data: { email, password } })
  assert.equal(result.user?.role, 'operator')
  return `JWT ${result.token!}`
}
