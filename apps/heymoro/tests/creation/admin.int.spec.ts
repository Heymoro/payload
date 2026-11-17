import type { Payload } from 'payload'

import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createPayloadAdministration } from '../../src/creation/infrastructure/payload/admin-repository.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { initializeAdmins } from '../../src/creation/runtime/admin-initialization.js'
import { createIdentityCollections } from '../../src/creation/runtime/identity-collections.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'
import { cleanupRuntime, config, directory, gate, redis, state } from './runtime.config.js'
import { controlledWrite, now } from './runtime-seed.js'

const password = '  DUMMY-Native-password-123  '
const email = 'bootstrap@example.test'
const trace = 'be5f54a2-e88a-4a15-993e-25bb4e16560a'
const admin = (payload: Payload) => getCoreRuntime({ payload }).administration
async function login({
  email: address = email,
  password: secret = password,
  payload,
}: {
  email?: string
  password?: string
  payload: Payload
}) {
  const result = await payload.login({
    collection: 'admins',
    data: { email: address, password: secret },
  })
  expect(result.token).toBeTypeOf('string')
  return `JWT ${result.token!}`
}
async function bootstrap({ payload }: { payload: Payload }) {
  const result = await admin(payload).execute({
    input: { action: 'bootstrap', email, password },
    requestId: trace,
  })
  return { authorization: await login({ payload }), result }
}
function localService({
  assertLease = () => {},
  mode,
  payload,
}: {
  assertLease?: () => void
  mode?: string
  payload: Payload
}) {
  return createPayloadAdministration({
    clock: () => now,
    coordinate: async ({ work }) => work({ assertLease }),
    gate,
    mode,
    payload,
    retry: { backoffMs: 0, maxAttempts: 3 },
  })
}
async function auditRows({ payload }: { payload: Payload }) {
  return (await payload.find({ collection: 'auditLogs', overrideAccess: true, pagination: false }))
    .docs
}

test.suite(
  'Heymoro host administrator commands',
  { config: './runtime.config.ts', cron: false },
  () => {
    test.afterAll(cleanupRuntime)
    test.afterEach(() => {
      vi.restoreAllMocks()
      vi.useRealTimers()
    })
    test('initialization development preset persists Native username and permits both username and email login without resetting password', async ({
      payload,
    }) => {
      const administration = localService({ mode: 'development', payload })
      const logger = { info: vi.fn() }
      await expect(
        initializeAdmins({ administration, logger, mode: 'development' }),
      ).resolves.toEqual({ adminId: expect.any(Number), status: 'created' })
      const usernameLogin = await payload.login({
        collection: 'admins',
        data: { password: '123456', username: 'admin' },
      })
      expect(usernameLogin.token).toBeTypeOf('string')
      await expect(
        login({ email: 'admin@local.invalid', password: '123456', payload }),
      ).resolves.toMatch(/^JWT /)
      const id = Number(usernameLogin.user?.id)
      await administration.execute({
        input: {
          id,
          action: 'update',
          authorization: `JWT ${usernameLogin.token!}`,
          changes: { password },
        },
      })
      await expect(
        initializeAdmins({ administration, logger, mode: 'development' }),
      ).resolves.toEqual({ status: 'skipped' })
      await expect(
        payload.login({ collection: 'admins', data: { password, username: 'admin' } }),
      ).resolves.toMatchObject({ token: expect.any(String) })
      expect(logger.info).not.toHaveBeenCalled()
      expect(await auditRows({ payload })).toHaveLength(2)
    })

    test('initialization production generates one password outside confirmed rollback retries and logs once after commit', async ({
      payload,
    }) => {
      const administration = localService({ mode: 'production', payload })
      const logger = { info: vi.fn() }
      const create = payload.create.bind(payload)
      const passwords: unknown[] = []
      let auditAttempts = 0
      vi.spyOn(payload, 'create').mockImplementation(async (args) => {
        expect(logger.info).not.toHaveBeenCalled()
        if (args.collection === 'admins') {
          passwords.push(args.data.password)
        }
        if (args.collection === 'auditLogs' && auditAttempts++ === 0) {
          throw Object.assign(new Error('DUMMY_BUSY'), { code: 'SQLITE_BUSY' })
        }
        return create(args)
      })
      await expect(
        initializeAdmins({ administration, logger, mode: 'production' }),
      ).resolves.toEqual({ adminId: expect.any(Number), status: 'created' })
      expect(passwords).toHaveLength(2)
      expect(passwords[0]).toBe(passwords[1])
      expect(passwords[0]).toMatch(/^[\w-]{32}$/)
      expect(logger.info).toHaveBeenCalledTimes(1)
      expect(logger.info.mock.calls[0]?.[0]).toMatchObject({
        password: passwords[0],
        username: 'admin',
      })
      await expect(
        payload.login({
          collection: 'admins',
          data: { password: String(passwords[0]), username: 'admin' },
        }),
      ).resolves.toMatchObject({ token: expect.any(String) })
      await expect(
        login({ email: 'admin@local.invalid', password: String(passwords[0]), payload }),
      ).resolves.toMatch(/^JWT /)
      const audits = await auditRows({ payload })
      expect(audits).toHaveLength(1)
      expect(JSON.stringify(audits)).not.toContain(String(passwords[0]))
      await expect(
        initializeAdmins({ administration, logger, mode: 'production' }),
      ).resolves.toEqual({ status: 'skipped' })
      expect(logger.info).toHaveBeenCalledTimes(1)
    })

    test('initialization concurrent production starts share the real Redis gate and only the creator logs credentials', async ({
      payload,
    }) => {
      const logger = { info: vi.fn() }
      const results = await Promise.all(
        [1, 2].map(() =>
          initializeAdmins({ administration: admin(payload), logger, mode: 'production' }),
        ),
      )
      expect(results.map(({ status }) => status).sort()).toEqual(['created', 'skipped'])
      expect(logger.info).toHaveBeenCalledTimes(1)
      expect((await payload.count({ collection: 'admins', overrideAccess: true })).totalDocs).toBe(
        1,
      )
      expect(await auditRows({ payload })).toHaveLength(1)
    })

    test('initialization production Native boundary rejects the development default for username and email', async ({
      payload,
    }) => {
      await localService({ mode: 'development', payload }).initializeDevelopmentPreset()
      const admins = payload.collections.admins!.config
      const original = admins.hooks.beforeOperation
      const production = createIdentityCollections({
        clock: () => now,
        gate,
        mode: 'production',
      }).find(({ slug }) => slug === 'admins')!
      admins.hooks.beforeOperation = [production.hooks!.beforeOperation![0]!, ...original]
      try {
        for (const identity of [{ username: 'admin' }, { email: 'admin@local.invalid' }]) {
          await expect(
            payload.login({ collection: 'admins', data: { ...identity, password: '123456' } }),
          ).rejects.toMatchObject({
            name: 'AuthenticationError',
            isPublic: true,
            status: 401,
          })
        }
      } finally {
        admins.hooks.beforeOperation = original
      }
      await expect(
        payload.login({ collection: 'admins', data: { password: '123456', username: 'admin' } }),
      ).resolves.toMatchObject({ token: expect.any(String) })
    })

    test('composes a bounded host command entry without exposing arbitrary Native writes', async ({
      payload,
    }) => {
      expect(getCoreRuntime({ payload })).toHaveProperty('administration.execute')
    })

    test('bootstrap Native password, real JWT create/update, immutable inputs, no-op and minimal audit/DTO', async ({
      payload,
    }) => {
      const { authorization, result } = await bootstrap({ payload })
      expect(result).toEqual({
        data: { id: expect.any(Number), changed: true, role: 'admin', status: 'active' },
        outcome: 'confirmed',
        requestId: trace,
      })
      await expect(
        admin(payload).execute({
          input: { action: 'bootstrap', email: 'other@example.test', password },
        }),
      ).rejects.toMatchObject({ code: 'ADMIN_ALREADY_INITIALIZED' })
      const created = await admin(payload).execute({
        input: {
          action: 'create',
          authorization,
          email: ' Operator@Example.test ',
          password,
          role: 'operator',
        },
      })
      expect(created.data).toEqual({
        id: expect.any(Number),
        changed: true,
        role: 'operator',
        status: 'active',
      })
      const before = await payload.findByID({
        id: created.data.id,
        collection: 'admins',
        overrideAccess: true,
        showHiddenFields: true,
      })
      const audits = await auditRows({ payload })
      expect(
        (
          await admin(payload).execute({
            input: {
              id: created.data.id,
              action: 'update',
              authorization,
              changes: { role: 'operator', status: 'active' },
            },
          })
        ).data.changed,
      ).toBe(false)
      expect(
        await payload.findByID({
          id: created.data.id,
          collection: 'admins',
          overrideAccess: true,
          showHiddenFields: true,
        }),
      ).toEqual(before)
      expect(await auditRows({ payload })).toEqual(audits)
      const input = {
        id: created.data.id,
        action: 'update',
        authorization,
        changes: { password: 'DUMMY-new-password-123', role: 'admin' },
      }
      const pending = admin(payload).execute({ input, requestId: trace })
      input.changes.password = 'DUMMY-mutated-password'
      await pending
      await expect(
        login({ email: 'operator@example.test', password: 'DUMMY-new-password-123', payload }),
      ).resolves.toMatch(/^JWT /)
      await expect(
        payload.login({ collection: 'admins', data: { email: 'operator@example.test', password } }),
      ).rejects.toBeDefined()
      const saved = await payload.findByID({
        id: created.data.id,
        collection: 'admins',
        overrideAccess: true,
        showHiddenFields: true,
      })
      expect(saved.hash).not.toBe(before.hash)
      expect(saved.salt).not.toBe(before.salt)
      const records = await auditRows({ payload })
      expect(records).toHaveLength(3)
      expect(records.find((row) => row.action === 'admin.update')).toMatchObject({
        afterState: { role: 'admin', status: 'active' },
        beforeState: { role: 'operator', status: 'active' },
        createdBy: `admin:${result.data.id}`,
        requestId: trace,
        resourceType: 'admin',
      })
      expect(JSON.stringify(records)).not.toMatch(/DUMMY|example.test|JWT |hash|salt|sessions/)
      expect(state.wechatCalls + state.imageCalls + state.namingCalls).toBe(0)
    })

    test('two real Redis bootstraps produce one account and one audit', async ({ payload }) => {
      const results = await Promise.allSettled(
        [0, 1].map((i) =>
          admin(payload).execute({
            input: { action: 'bootstrap', email: `admin${i}@example.test`, password },
          }),
        ),
      )
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code)).toEqual([
        'ADMIN_ALREADY_INITIALIZED',
      ])
      expect((await payload.count({ collection: 'admins', overrideAccess: true })).totalDocs).toBe(
        1,
      )
      expect(await auditRows({ payload })).toHaveLength(1)
    })

    test('bootstrap counts disabled Native accounts, never active-only accounts', async ({
      payload,
    }) => {
      const f = await bootstrap({ payload })
      const adapter = getCreationSQLiteAdapter({ payload })
      await adapter.client.execute({
        args: ['disabled', f.result.data.id],
        sql: 'UPDATE admins SET status = ? WHERE id = ?',
      })
      await expect(
        admin(payload).execute({
          input: { action: 'bootstrap', email: 'again@example.test', password },
        }),
      ).rejects.toMatchObject({ code: 'ADMIN_ALREADY_INITIALIZED' })
    })

    test('real active operator, disabled/demoted administrators, opaque and caller-context impersonation are rejected', async ({
      payload,
    }) => {
      const f = await bootstrap({ payload })
      const created = await admin(payload).execute({
        input: {
          action: 'create',
          authorization: f.authorization,
          email: 'staff@example.test',
          password,
          role: 'operator',
        },
      })
      const staff = await login({ email: 'staff@example.test', payload })
      const command = {
        action: 'create',
        authorization: staff,
        email: 'blocked@example.test',
        password,
        role: 'admin',
      }
      await expect(admin(payload).execute({ input: command })).rejects.toMatchObject({
        code: 'ADMIN_FORBIDDEN',
      })
      await admin(payload).execute({
        input: {
          id: created.data.id,
          action: 'update',
          authorization: f.authorization,
          changes: { role: 'admin' },
        },
      })
      const authorization = await login({ email: 'staff@example.test', payload })
      for (const changes of [{ status: 'disabled' }, { role: 'operator', status: 'active' }]) {
        await admin(payload).execute({
          input: { id: created.data.id, action: 'update', authorization: f.authorization, changes },
        })
        await expect(
          admin(payload).execute({ input: { ...command, authorization } }),
        ).rejects.toMatchObject({ code: 'ADMIN_FORBIDDEN' })
      }
      for (const authorization of ['Bearer opaque-session', 'JWT opaque-session']) {
        await expect(
          admin(payload).execute({ input: { ...command, authorization } }),
        ).rejects.toMatchObject({ code: 'ADMIN_INVALID_INPUT', outcome: 'not_started' })
      }
      await expect(
        admin(payload).execute({
          input: {
            ...command,
            authorization: f.authorization,
            context: { actorId: f.result.data.id },
            user: { id: f.result.data.id, collection: 'admins' },
          },
        }),
      ).rejects.toMatchObject({ code: 'ADMIN_INVALID_INPUT' })
      await expect(
        admin(payload).execute({
          input: { ...command, authorization: 'JWT eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.c2ln' },
        }),
      ).rejects.toMatchObject({ code: 'ADMIN_UNAUTHORIZED' })
    })

    test('expired Native JWT is checked using Native clock, independently of fixed business clock', async ({
      payload,
    }) => {
      const f = await bootstrap({ payload })
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 9 * 60 * 60 * 1000)
      try {
        await expect(
          admin(payload).execute({
            input: {
              action: 'create',
              authorization: f.authorization,
              email: 'expired@example.test',
              password,
              role: 'admin',
            },
          }),
        ).rejects.toMatchObject({ code: 'ADMIN_UNAUTHORIZED' })
      } finally {
        vi.useRealTimers()
      }
    })

    test('Native self-password update retains current sid only; other-password change revokes target sessions', async ({
      payload,
    }) => {
      const f = await bootstrap({ payload })
      const older = f.authorization
      const current = await login({ payload })
      await admin(payload).execute({
        input: {
          id: f.result.data.id,
          action: 'update',
          authorization: current,
          changes: { password: 'DUMMY-self-new-password-123' },
        },
      })
      const authenticate = (authorization: string) =>
        payload.auth({
          headers: new Headers({ Authorization: authorization, DisableAutologin: 'true' }),
        })
      expect((await authenticate(older)).user).toBeNull()
      expect((await authenticate(current)).user).toMatchObject({ id: f.result.data.id })
      const other = await admin(payload).execute({
        input: {
          action: 'create',
          authorization: current,
          email: 'other@example.test',
          password,
          role: 'admin',
        },
      })
      const targetJWT = await login({ email: 'other@example.test', payload })
      await admin(payload).execute({
        input: {
          id: other.data.id,
          action: 'update',
          authorization: current,
          changes: { password: 'DUMMY-other-new-password-123' },
        },
      })
      expect((await authenticate(targetJWT)).user).toBeNull()
      await expect(
        admin(payload).execute({
          input: {
            id: other.data.id,
            action: 'update',
            authorization: targetJWT,
            changes: { status: 'disabled' },
          },
        }),
      ).rejects.toMatchObject({ code: 'ADMIN_UNAUTHORIZED' })
      await expect(
        login({ email: 'other@example.test', password: 'DUMMY-other-new-password-123', payload }),
      ).resolves.toMatch(/^JWT /)
    })

    for (const mode of ['demote', 'disable'] as const) {
      test(`real global resource prevents two administrators concurrent ${mode}`, async ({
        payload,
      }) => {
        const f = await bootstrap({ payload })
        const other = await admin(payload).execute({
          input: {
            action: 'create',
            authorization: f.authorization,
            email: 'second@example.test',
            password,
            role: 'admin',
          },
        })
        const second = await login({ email: 'second@example.test', payload })
        const results = await Promise.allSettled(
          [
            { id: f.result.data.id, authorization: f.authorization },
            { id: other.data.id, authorization: second },
          ].map(({ id, authorization }) =>
            admin(payload).execute({
              input: {
                id,
                action: 'update',
                authorization,
                changes: mode === 'demote' ? { role: 'operator' } : { status: 'disabled' },
              },
            }),
          ),
        )
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code)).toEqual([
          'ADMIN_LAST_ACTIVE_ADMIN',
        ])
        expect(
          (
            await payload.count({
              collection: 'admins',
              overrideAccess: true,
              where: { and: [{ role: { equals: 'admin' } }, { status: { equals: 'active' } }] },
            })
          ).totalDocs,
        ).toBe(1)
      })
    }

    test('duplicate email includes disabled account, target missing, invalid enum integrity and Native unique remain', async ({
      payload,
    }) => {
      const f = await bootstrap({ payload })
      const other = await admin(payload).execute({
        input: {
          action: 'create',
          authorization: f.authorization,
          email: 'dup@example.test',
          password,
          role: 'operator',
        },
      })
      await admin(payload).execute({
        input: {
          id: other.data.id,
          action: 'update',
          authorization: f.authorization,
          changes: { status: 'disabled' },
        },
      })
      await expect(
        admin(payload).execute({
          input: {
            action: 'create',
            authorization: f.authorization,
            email: 'DUP@example.test',
            password,
            role: 'admin',
          },
        }),
      ).rejects.toMatchObject({ code: 'ADMIN_CONFLICT' })
      await expect(
        admin(payload).execute({
          input: {
            id: 999999,
            action: 'update',
            authorization: f.authorization,
            changes: { role: 'admin' },
          },
        }),
      ).rejects.toMatchObject({ code: 'ADMIN_NOT_FOUND' })
      const adapter = getCreationSQLiteAdapter({ payload })
      await adapter.client.execute({
        args: ['broken', other.data.id],
        sql: 'UPDATE admins SET role = ? WHERE id = ?',
      })
      try {
        await expect(
          admin(payload).execute({
            input: {
              id: other.data.id,
              action: 'update',
              authorization: f.authorization,
              changes: { status: 'active' },
            },
          }),
        ).rejects.toMatchObject({ code: 'ADMIN_DATA_INTEGRITY' })
      } finally {
        await adapter.client.execute({
          args: ['operator', other.data.id],
          sql: 'UPDATE admins SET role = ? WHERE id = ?',
        })
      }
      await expect(
        controlledWrite({
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
        }),
      ).rejects.toBeDefined()
      expect((await payload.count({ collection: 'admins', overrideAccess: true })).totalDocs).toBe(
        2,
      )
    })

    for (const phase of ['admin', 'audit'] as const) {
      test(`Native ${phase} failure rolls back account, password and audit atomically`, async ({
        payload,
      }) => {
        const f = await bootstrap({ payload })
        const before = await payload.findByID({
          id: f.result.data.id,
          collection: 'admins',
          overrideAccess: true,
          showHiddenFields: true,
        })
        const original = payload.create.bind(payload)
        const hook = vi.spyOn(payload, 'create').mockImplementation(async (args) => {
          if (args.collection === (phase === 'admin' ? 'admins' : 'auditLogs')) {
            await original(args)
            throw new Error('DUMMY_NATIVE_SECRET')
          }
          return original(args)
        })
        await expect(
          admin(payload).execute({
            input: {
              action: 'create',
              authorization: f.authorization,
              email: 'rollback@example.test',
              password,
              role: 'operator',
            },
            requestId: trace,
          }),
        ).rejects.toMatchObject({ code: 'ADMIN_FAILED', outcome: 'rolled_back', requestId: trace })
        expect(
          (await payload.count({ collection: 'admins', overrideAccess: true })).totalDocs,
        ).toBe(1)
        if (phase === 'audit') {
          await expect(
            admin(payload).execute({
              input: {
                id: f.result.data.id,
                action: 'update',
                authorization: f.authorization,
                changes: { password: 'DUMMY-rolled-back-password' },
              },
            }),
          ).rejects.toMatchObject({ code: 'ADMIN_FAILED' })
        }
        hook.mockRestore()
        expect(
          await payload.findByID({
            id: f.result.data.id,
            collection: 'admins',
            overrideAccess: true,
            showHiddenFields: true,
          }),
        ).toEqual(before)
        expect(await auditRows({ payload })).toHaveLength(1)
        await expect(login({ payload })).resolves.toMatch(/^JWT /)
      })
    }

    test('confirmed SQLite rollback retries under same trace without duplicate Native writes', async ({
      payload,
    }) => {
      const original = payload.create.bind(payload)
      let attempts = 0
      vi.spyOn(payload, 'create').mockImplementation(async (args) => {
        if (args.collection === 'auditLogs' && attempts++ === 0) {
          throw Object.assign(new Error('DUMMY_BUSY'), { code: 'SQLITE_BUSY' })
        }
        return original(args)
      })
      const result = await localService({ payload }).execute({
        input: { action: 'bootstrap', email, password },
        requestId: trace,
      })
      expect(result.requestId).toBe(trace)
      expect(attempts).toBe(2)
      expect((await payload.count({ collection: 'admins', overrideAccess: true })).totalDocs).toBe(
        1,
      )
      expect(await auditRows({ payload })).toHaveLength(1)
    })

    test('lost lease after a Native write rolls back, not a false confirmed result', async ({
      payload,
    }) => {
      let isLost = false
      const original = payload.create.bind(payload)
      vi.spyOn(payload, 'create').mockImplementation(async (args) => {
        const result = await original(args)
        if (args.collection === 'admins') {
          isLost = true
        }
        return result
      })
      const service = localService({
        assertLease: () => {
          if (isLost) {
            throw new Error('DUMMY_LOST_LEASE')
          }
        },
        payload,
      })
      await expect(
        service.execute({ input: { action: 'bootstrap', email, password }, requestId: trace }),
      ).rejects.toMatchObject({ code: 'ADMIN_FAILED', outcome: 'rolled_back', requestId: trace })
      expect((await payload.count({ collection: 'admins', overrideAccess: true })).totalDocs).toBe(
        0,
      )
      expect(await auditRows({ payload })).toHaveLength(0)
    })

    for (const hasCommitted of [false, true]) {
      test(`commit acknowledgement unknown (${hasCommitted}) is never retried or compensated`, async ({
        payload,
      }) => {
        const adapter = getCreationSQLiteAdapter({ payload })
        const original = adapter.client.transaction.bind(adapter.client)
        let begins = 0
        vi.spyOn(adapter.client, 'transaction').mockImplementation(async (...args) => {
          begins++
          const transaction = await original(...args)
          return new Proxy(transaction, {
            get: (target, key) => {
              if (key === 'commit') {
                return async () => {
                  if (hasCommitted) {
                    await target.commit()
                  }
                  throw Object.assign(new Error('DUMMY_COMMIT_SECRET'), { code: 'SQLITE_BUSY' })
                }
              }
              const value: unknown = Reflect.get(target, key, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        })
        await expect(
          localService({ payload }).execute({
            input: { action: 'bootstrap', email, password },
            requestId: trace,
          }),
        ).rejects.toMatchObject({
          code: 'ADMIN_OUTCOME_UNKNOWN',
          outcome: 'unknown',
          requestId: trace,
        })
        expect(begins).toBe(1)
        vi.restoreAllMocks()
        expect(
          (await payload.count({ collection: 'admins', overrideAccess: true })).totalDocs,
        ).toBe(hasCommitted ? 1 : 0)
        expect(await auditRows({ payload })).toHaveLength(hasCommitted ? 1 : 0)
      })
    }

    test('Native first-register/create/update/bulk/delete have no capability outside host commands', async ({
      payload,
    }) => {
      await expect(
        payload.create({
          collection: 'admins',
          context: { capability: true },
          data: { email, password, role: 'admin', status: 'active' },
          overrideAccess: true,
        }),
      ).rejects.toThrow(/capability/)
      const f = await bootstrap({ payload })
      await expect(
        payload.update({
          id: f.result.data.id,
          collection: 'admins',
          data: { role: 'operator' },
          overrideAccess: true,
        }),
      ).rejects.toThrow(/capability/)
      await expect(
        payload.update({
          collection: 'admins',
          data: { status: 'disabled' },
          overrideAccess: true,
          where: {},
        }),
      ).rejects.toThrow(/capability/)
      await expect(
        payload.delete({ id: f.result.data.id, collection: 'admins', overrideAccess: true }),
      ).rejects.toThrow(/deletion/)
    })

    test('real CLI process opens the same ready target, uses caller JWT without owning its session, emits only JSON', async ({
      payload,
    }) => {
      const f = await bootstrap({ payload })
      const commandFile = path.join(directory, 'cli-command.json'),
        configFile = path.join(directory, 'cli-config.json')
      writeFileSync(configFile, JSON.stringify(config))
      writeFileSync(
        commandFile,
        JSON.stringify({
          action: 'create',
          authorization: f.authorization,
          email: 'cli@example.test',
          password,
          role: 'operator',
        }),
      )
      const run = promisify(execFile)
      const child = await run(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/admin-commands.mjs',
          '--config',
          configFile,
          '--command',
          commandFile,
        ],
        {
          cwd: path.resolve(import.meta.dirname, '../..'),
          env: { HOME: directory, NODE_ENV: 'test', PATH: process.env.PATH },
          timeout: 20000,
        },
      )
      expect(child.stderr).toBe('')
      const result: unknown = JSON.parse(child.stdout)
      expect(result).toMatchObject({
        data: { changed: true, role: 'operator', status: 'active' },
        outcome: 'confirmed',
      })
      expect(child.stdout).not.toMatch(/DUMMY|JWT |example.test|fixture-secret|INFO|WARN|hash|salt/)
      expect(
        (
          await payload.auth({
            headers: new Headers({ Authorization: f.authorization, DisableAutologin: 'true' }),
          })
        ).user,
      ).not.toBeNull()
      expect((await payload.count({ collection: 'admins', overrideAccess: true })).totalDocs).toBe(
        2,
      )
    })
    test('mutual disabling serializes authentication and retains an active administrator', async ({
      payload,
    }) => {
      const f = await bootstrap({ payload })
      const other = await admin(payload).execute({
        input: {
          action: 'create',
          authorization: f.authorization,
          email: 'mutual@example.test',
          password,
          role: 'admin',
        },
      })
      const second = await login({ email: 'mutual@example.test', payload })
      const results = await Promise.allSettled(
        [
          { id: other.data.id, authorization: f.authorization },
          { id: f.result.data.id, authorization: second },
        ].map(({ id, authorization }) =>
          admin(payload).execute({
            input: { id, action: 'update', authorization, changes: { status: 'disabled' } },
          }),
        ),
      )
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code)).toEqual([
        'ADMIN_FORBIDDEN',
      ])
      expect(
        (
          await payload.count({
            collection: 'admins',
            overrideAccess: true,
            where: { and: [{ role: { equals: 'admin' } }, { status: { equals: 'active' } }] },
          })
        ).totalDocs,
      ).toBe(1)
    })

    test('Native update failure after actual password mutation is rolled back without an audit', async ({
      payload,
    }) => {
      const f = await bootstrap({ payload })
      const before = await payload.findByID({
        id: f.result.data.id,
        collection: 'admins',
        overrideAccess: true,
        showHiddenFields: true,
      })
      const original = payload.update.bind(payload)
      vi.spyOn(payload, 'update').mockImplementation(async (args) => {
        const result = await original(args)
        if (args.collection === 'admins') {
          throw Error('DUMMY_NATIVE_UPDATE_SECRET')
        }
        return result
      })
      await expect(
        admin(payload).execute({
          input: {
            id: f.result.data.id,
            action: 'update',
            authorization: f.authorization,
            changes: { password: 'DUMMY-failed-new-password' },
          },
        }),
      ).rejects.toMatchObject({ code: 'ADMIN_FAILED', outcome: 'rolled_back' })
      vi.restoreAllMocks()
      expect(
        await payload.findByID({
          id: f.result.data.id,
          collection: 'admins',
          overrideAccess: true,
          showHiddenFields: true,
        }),
      ).toEqual(before)
      expect(await auditRows({ payload })).toHaveLength(1)
      await expect(login({ payload })).resolves.toMatch(/^JWT /)
    })

    test('rollback failure is unknown even if local transaction close eventually rolls back', async ({
      payload,
    }) => {
      const adapter = getCreationSQLiteAdapter({ payload })
      const original = adapter.client.transaction.bind(adapter.client)
      let begins = 0
      vi.spyOn(adapter.client, 'transaction').mockImplementation(async (...args) => {
        begins++
        const transaction = await original(...args)
        return new Proxy(transaction, {
          get: (target, key) => {
            if (key === 'rollback') {
              return async () => {
                throw Error('DUMMY_ROLLBACK_SECRET')
              }
            }
            const value: unknown = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      })
      const create = payload.create.bind(payload)
      vi.spyOn(payload, 'create').mockImplementation(async (args) => {
        if (args.collection === 'auditLogs') {
          throw Error('DUMMY_AUDIT_SECRET')
        }
        return create(args)
      })
      await expect(
        localService({ payload }).execute({
          input: { action: 'bootstrap', email, password },
          requestId: trace,
        }),
      ).rejects.toMatchObject({
        code: 'ADMIN_OUTCOME_UNKNOWN',
        outcome: 'unknown',
        requestId: trace,
      })
      expect(begins).toBe(1)
      vi.restoreAllMocks()
      expect((await payload.count({ collection: 'admins', overrideAccess: true })).totalDocs).toBe(
        0,
      )
    })

    test('real Redis lease loss rolls back pending Native administration writes', async ({
      payload,
    }) => {
      const client = await redis.connect()
      const create = payload.create.bind(payload)
      let hasLostLease = false
      vi.spyOn(payload, 'create').mockImplementation(async (args) => {
        const result = await create(args)
        if (args.collection === 'admins') {
          const keys = await client.keys('*')
          expect(keys).toHaveLength(1)
          await client.del(...keys)
          hasLostLease = true
          await new Promise((resolve) => setTimeout(resolve, 650))
        }
        return result
      })
      await expect(
        admin(payload).execute({
          input: { action: 'bootstrap', email, password },
          requestId: trace,
        }),
      ).rejects.toMatchObject({ code: 'ADMIN_FAILED', outcome: 'rolled_back', requestId: trace })
      expect(hasLostLease).toBe(true)
      expect((await payload.count({ collection: 'admins', overrideAccess: true })).totalDocs).toBe(
        0,
      )
      expect(await auditRows({ payload })).toHaveLength(0)
    })

    for (const mode of ['onInit', 'cleanup'] as const) {
      test(`actual Native CLI ${mode} failure remains sanitized with a single classified output`, async ({
        payload,
      }) => {
        const f = await bootstrap({ payload })
        const commandFile = path.join(directory, `${mode}-command.json`),
          configFile = path.join(directory, `${mode}-config.json`)
        // Isolate faulted process lifecycle from the long-lived fixture's libsql connection.
        // Normal CLI/parent same-target coverage above remains unchanged.
        const snapshot = path.join(directory, `${mode}-ready-snapshot`)
        mkdirSync(snapshot, { mode: 0o700 })
        await getCreationSQLiteAdapter({ payload }).client.execute({
          args: [path.join(snapshot, 'core.sqlite')],
          sql: 'VACUUM INTO ?',
        })
        copyFileSync(path.join(config.dataDir, 'profile.json'), path.join(snapshot, 'profile.json'))
        writeFileSync(configFile, JSON.stringify({ ...config, dataDir: snapshot }))
        writeFileSync(
          commandFile,
          JSON.stringify({
            action: 'create',
            authorization: f.authorization,
            email: `${mode.toLowerCase()}@example.test`,
            password,
            role: 'operator',
          }),
        )
        const code = `
      import { runAdminCommand } from './scripts/admin-commands.mjs';
      import { buildCorePayloadConfig } from './src/creation/runtime/payload-config.ts';
      const mode = ${JSON.stringify(mode)};
      const ports = mode === 'onInit' ? { build: async (args) => {
        const config = await buildCorePayloadConfig(args); const original = config.onInit;
        // Explicit duplicate-registration fault: the second original onInit hits the builder's own catch,
        // exercising builder destroy/client.close followed by the CLI's idempotent finally cleanup.
        config.onInit = async (p) => { await original?.(p); p.logger.error({ msg: 'DUMMY_PRIVATE_MESSAGE', err: new Error('DUMMY_PASSWORD_HASH_SALT_PATH') }); await original?.(p); };
        return config;
      }} : { destroy: async (p) => { await p.destroy(); throw Error('DUMMY_CLEANUP_SECRET'); }};
      const { exitCode, ...result } = await runAdminCommand({ argv: ['--config', ${JSON.stringify(configFile)}, '--command', ${JSON.stringify(commandFile)}], ports });
      process.stdout.write(JSON.stringify(result));process.exitCode=exitCode;
    `
        let hasFailed = false
        try {
          await promisify(execFile)(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '-e', code],
            {
              cwd: path.resolve(import.meta.dirname, '../..'),
              env: { HOME: directory, NODE_ENV: 'test', PATH: process.env.PATH },
              timeout: 20000,
            },
          )
        } catch (error) {
          hasFailed = true
          if (
            !error ||
            typeof error !== 'object' ||
            !('stdout' in error) ||
            !('stderr' in error) ||
            typeof error.stdout !== 'string' ||
            typeof error.stderr !== 'string'
          ) {
            throw error
          }
          expect(error.stderr).toBe('')
          expect(error.stdout).not.toMatch(
            /DUMMY|JWT |example.test|fixture-secret|INFO|WARN|hash|salt/,
          )
          const result: unknown = JSON.parse(error.stdout)
          expect(result).toMatchObject(
            mode === 'cleanup'
              ? { code: 'ADMIN_CLEANUP_FAILED', data: { changed: true }, outcome: 'confirmed' }
              : { code: 'ADMIN_STARTUP_FAILED', outcome: 'not_started' },
          )
        }
        expect(hasFailed).toBe(true)
        expect(
          (await payload.count({ collection: 'admins', overrideAccess: true })).totalDocs,
        ).toBe(1)
        const observed = new DatabaseSync(path.join(snapshot, 'core.sqlite'), { readOnly: true })
        try {
          expect(observed.prepare('SELECT count(*) AS total FROM admins').get()?.total).toBe(
            mode === 'cleanup' ? 2 : 1,
          )
        } finally {
          observed.close()
        }
      })
    }
    test('wrong-row Native reads do not become no-op success', async ({ payload }) => {
      const f = await bootstrap({ payload })
      const find = payload.find.bind(payload)
      vi.spyOn(payload, 'find').mockImplementation(async (args) => {
        const result = await find(args)
        if (args.collection === 'admins') {
          return {
            ...result,
            docs: result.docs.map((doc) => ({ ...doc, id: Number(doc.id) + 1000 })),
          }
        }
        return result
      })
      await expect(
        admin(payload).execute({
          input: {
            id: f.result.data.id,
            action: 'update',
            authorization: f.authorization,
            changes: { status: 'active' },
          },
        }),
      ).rejects.toMatchObject({ code: 'ADMIN_DATA_INTEGRITY' })
    })
  },
)
