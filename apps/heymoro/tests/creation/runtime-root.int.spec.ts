import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import {
  createSQLiteUnitOfWork,
  getCreationSQLiteAdapter,
} from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createCreationWriteGate } from '../../src/creation/infrastructure/payload/write-gate.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'
import { cleanupRuntime, config, gate, state } from './runtime.config.js'
import { controlledWrite, now, seedIdentity } from './runtime-seed.js'

test.suite(
  'Heymoro actual core identity root',
  { config: './runtime.config.ts', cron: false },
  () => {
    test.afterAll(cleanupRuntime)
    test('metadata reads require no provider connections and survive unavailable first coordination', async ({
      payload,
    }) => {
      const f = await seedIdentity({ gate, payload })
      const runtime = getCoreRuntime({ payload })
      state.redisDown = true
      expect(state.redisConnections).toBe(0)
      expect((await runtime.catalog.list({ query: {} })).items).toEqual([])
      expect(await runtime.credits.account({ userId: f.userId })).toMatchObject({
        available: 0,
        configured: true,
        reserved: 0,
      })
      expect(state.redisConnections).toBe(0)
      await expect(
        runtime.session({
          command: { clientRequestId: 'offline', templateId: 1 },
          userId: f.userId,
        }),
      ).rejects.toMatchObject({ status: 503 })
      expect(state.redisConnections).toBe(2)
      expect((await runtime.catalog.list({ query: {} })).items).toEqual([])
      state.redisDown = false
    })
    test('registers native identities and core only, keeps native auth constraints, and has exactly the thirty-nine product custom endpoints', async ({
      payload,
    }) => {
      const slugs = payload.config.collections.map(({ slug }) => slug)
      expect(slugs).toContain('wechatIdentities')
      expect(slugs).toContain('userSessions')
      expect(slugs).not.toContain('records')
      expect(slugs).not.toContain('generations')
      expect(
        payload.config.endpoints.map(({ path }) => path).filter((path) => path.startsWith('/v1/')),
      ).toEqual([
        '/v1/health/ready',
        '/v1/auth/wechat',
        '/v1/me',
        '/v1/me',
        '/v1/auth/logout',
        '/v1/templates',
        '/v1/template-taxonomies',
        '/v1/templates/:templateId',
        '/v1/creation-presets/free',
        '/v1/creation-sessions',
        '/v1/creation-sessions',
        '/v1/creation-sessions/:sessionId',
        '/v1/creation-sessions/:sessionId',
        '/v1/creation-sessions/:sessionId/draft',
        '/v1/creation-sessions/:sessionId/draft',
        '/v1/media',
        '/v1/media/:mediaId/content',
        '/v1/media/examples/:mediaId/content',
        '/v1/admin/media/examples',
        '/v1/artifacts',
        '/v1/artifacts/:artifactId',
        '/v1/artifacts/:artifactId/favorite',
        '/v1/artifacts/:artifactId/favorite',
        '/v1/creation-account',
        '/v1/credits/reservations',
        '/v1/credits/ledger',
        '/v1/generation-quotes',
        '/v1/generations',
        '/v1/artifacts/:artifactId/regenerations',
        '/v1/generations/:taskId',
        '/v1/creation-sessions/:sessionId/generations',
        '/v1/session-shares/:key',
        '/v1/session-shares/:key/images/:artifactId',
        '/v1/session-shares/:key/cover',
        '/v1/admin/session-shares',
        '/v1/admin/session-shares/:sessionId',
        '/v1/admin/session-shares/:sessionId',
        '/v1/admin/session-shares/:sessionId/revoke',
        '/v1/admin/session-shares/:sessionId/images/:artifactId',
      ])
      expect(payload.collections.admins.config.auth).toMatchObject({ maxLoginAttempts: 5 })
      expect(payload.collections.userSessions.config.indexes).toContainEqual(
        expect.objectContaining({ fields: ['tokenHash'], unique: true }),
      )
      expect(getCoreRuntime({ payload })).toBe(getCoreRuntime({ payload }))
    })
    test('actual payload.auth authenticates strict opaque bearer and omits private identity fields', async ({
      payload,
    }) => {
      const f = await seedIdentity({ gate, payload })
      const result = await payload.auth({
        headers: new Headers({ authorization: `Bearer ${f.token}` }),
      })
      expect(result.user).toMatchObject({ id: f.userId, collection: 'users' })
      expect(JSON.stringify(result.user)).not.toMatch(/tokenHash|openId|createdBy|deletedBy/)
      for (const header of [
        `Bearer ${f.token} extra`,
        `Bearer ${f.token},${f.token}`,
        `Bearer x.y.z`,
        `Bearer  ${f.token}`,
        `Basic ${f.token}`,
        `Bearer ${'a'.repeat(10000)}`,
      ]) {
        expect(
          (await payload.auth({ headers: new Headers({ authorization: header }) })).user,
        ).toBeNull()
      }
    })
    for (const scenario of [
      'user-disabled',
      'user-deleted',
      'session-deleted',
      'session-revoked',
      'session-expired',
    ]) {
      test(`rejects invalid native identity: ${scenario}`, async ({ payload }) => {
        const f = await seedIdentity({ gate, payload })
        const data = scenario.endsWith('deleted')
          ? { deletedAt: now, deletedBy: 'system:runtime-fixture', isDeleted: true }
          : scenario === 'user-disabled'
            ? { status: 'disabled' }
            : scenario === 'session-revoked'
              ? { revokedAt: now }
              : { expiresAt: now }
        await controlledWrite({
          gate,
          payload,
          work: ({ req }) =>
            gate.run({
              req,
              work: () =>
                payload.update({
                  id: scenario.startsWith('user-') ? f.userId : f.sessionId,
                  collection: scenario.startsWith('user-') ? 'users' : 'userSessions',
                  data: { ...data, updatedBy: 'system:runtime-fixture' } as never,
                  overrideAccess: true,
                  req,
                }),
            }),
        })
        expect(
          (await payload.auth({ headers: new Headers({ authorization: `Bearer ${f.token}` }) }))
            .user,
        ).toBeNull()
      })
    }
    test('native administrator JWT is separate from opaque users and password mutations do no preliminary writes', async ({
      payload,
    }) => {
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
                  email: 'native-admin@local.invalid',
                  password: 'fixture-admin-password-137',
                  role: 'admin',
                  status: 'active',
                },
                overrideAccess: true,
                req,
              }),
          }),
      })
      const login = await payload.login({
        collection: 'admins',
        data: { email: admin.email, password: 'fixture-admin-password-137' },
      })
      expect(login.token).toBeTruthy()
      const result = await payload.auth({
        headers: new Headers({ authorization: `JWT ${login.token}` }),
      })
      expect(result.user).toMatchObject({ id: admin.id, collection: 'admins' })
      const spy = vi.spyOn(payload.db, 'updateOne')
      await expect(
        payload.forgotPassword({ collection: 'admins', data: { email: admin.email } }),
      ).rejects.toThrow(/password mutation/)
      await expect(
        payload.resetPassword({
          collection: 'admins',
          data: { password: 'new-fixture-password-137', token: 'fixture' },
          overrideAccess: true,
        }),
      ).rejects.toThrow(/password mutation/)
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
      expect(
        (await payload.auth({ headers: new Headers({ authorization: `Bearer ${login.token}` }) }))
          .user?.collection,
      ).not.toBe('users')
    })
    test('foreign gate, ended request, forged context and auth DB failure all fail closed', async ({
      payload,
    }) => {
      const f = await seedIdentity({ gate, payload })
      const foreign = createCreationWriteGate()
      await expect(
        createSQLiteUnitOfWork({
          coordinate: async ({ work }) => work({ assertLease: () => {} }),
          gate: foreign,
          payload,
          retry: { backoffMs: 0, maxAttempts: 1 },
        })({
          resource: 'foreign-runtime',
          work: ({ req }) =>
            foreign.run({
              req,
              work: () =>
                payload.update({
                  id: f.userId,
                  collection: 'users',
                  data: { displayName: 'foreign' },
                  overrideAccess: true,
                  req,
                }),
            }),
        }),
      ).rejects.toThrow(/capability/)
      const ended = await controlledWrite({ gate, payload, work: async ({ req }) => req })
      await expect(
        payload.update({
          id: f.userId,
          collection: 'users',
          data: { displayName: 'late' },
          overrideAccess: true,
          req: ended,
        }),
      ).rejects.toThrow(/capability|aborted|detached/)
      const adapter = getCreationSQLiteAdapter({ payload })
      const transaction = vi
        .spyOn(adapter.client, 'transaction')
        .mockRejectedValueOnce(new Error('fixture database offline'))
      expect(
        (await payload.auth({ headers: new Headers({ authorization: `Bearer ${f.token}` }) })).user,
      ).toBeNull()
      expect(transaction).toHaveBeenCalled()
      transaction.mockRestore()
    })
    test('native profile writes cannot bypass gate with overrideAccess or context flags', async ({
      payload,
    }) => {
      const f = await seedIdentity({ gate, payload })
      await expect(
        payload.update({
          id: f.userId,
          collection: 'users',
          context: { creationCapability: true },
          data: { displayName: 'forged' },
          overrideAccess: true,
        }),
      ).rejects.toThrow(/capability/)
      await expect(
        payload.delete({ id: f.userId, collection: 'users', overrideAccess: true }),
      ).rejects.toThrow(/Physical/)
      await expect(
        payload.forgotPassword({ collection: 'admins', data: { email: 'none@local.invalid' } }),
      ).rejects.toThrow(/password mutation/)
      expect(config.dataDir).toContain('heymoro-core-runtime-')
    })
  },
)
