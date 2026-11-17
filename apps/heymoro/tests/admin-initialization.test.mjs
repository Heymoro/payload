import assert from 'node:assert/strict'
import test from 'node:test'

import { createAdministration } from '../src/creation/application/admin.ts'
import { AdminCommandError } from '../src/creation/domain/admin.ts'

async function initializer() {
  return (await import('../src/creation/runtime/admin-initialization.ts')).initializeAdmins
}
function fixture({ mode = 'production', failure } = {}) {
  const rows = [],
    audits = [],
    logs = [],
    inserts = []
  let calls = 0
  const administration = createAdministration({
    mode,
    clock: () => '2026-11-16T00:00:00.000Z',
    write: async ({ resource, work }) => {
      calls++
      assert.equal(resource, 'admin-management')
      if (failure) throw failure
      return work({
        repository: {
          countAll: async () => rows.length,
          findEmail: async () => [],
          insert: async (args) => {
            inserts.push(args)
            const row = { id: 1, ...args }
            rows.push(row)
            return { id: row.id, role: row.role, status: row.status }
          },
          appendAudit: async (args) => {
            audits.push(args)
          },
        },
      })
    },
  })
  return {
    rows,
    audits,
    logs,
    inserts,
    administration,
    logger: {
      info: (entry) => {
        logs.push(entry)
      },
    },
    get calls() {
      return calls
    },
  }
}

test('production first initialization generates strong random credentials and logs only a confirmed creation once', async () => {
  const initializeAdmins = await initializer()
  const f = fixture()
  assert.deepEqual(await initializeAdmins({ ...f, mode: 'production' }), {
    status: 'created',
    adminId: 1,
  })
  assert.equal(f.inserts[0].username, 'admin')
  assert.equal(f.inserts[0].email, 'admin@local.invalid')
  assert.match(f.inserts[0].password, /^[\w-]{32}$/)
  assert.notEqual(f.inserts[0].password, '123456')
  assert.equal(f.logs.length, 1)
  assert.equal(f.logs[0].username, 'admin')
  assert.equal(f.logs[0].password, f.inserts[0].password)
  assert.doesNotMatch(JSON.stringify(f.audits), new RegExp(f.inserts[0].password))
  f.rows[0].status = 'disabled'
  assert.deepEqual(await initializeAdmins({ ...f, mode: 'production' }), { status: 'skipped' })
  assert.equal(f.rows[0].status, 'disabled')
  assert.equal(f.inserts.length, 1)
  assert.equal(f.logs.length, 1)
  const second = fixture()
  await initializeAdmins({ ...second, mode: 'production' })
  assert.notEqual(second.inserts[0].password, f.inserts[0].password)
})

test('development uses the fixed private preset without production credential logging or resetting an existing account', async () => {
  const initializeAdmins = await initializer()
  const f = fixture({ mode: 'development' })
  assert.deepEqual(await initializeAdmins({ ...f, mode: 'development' }), {
    status: 'created',
    adminId: 1,
  })
  assert.equal(f.inserts[0].password, '123456')
  f.rows[0].password = 'DUMMY-changed-password'
  assert.deepEqual(await initializeAdmins({ ...f, mode: 'development' }), { status: 'skipped' })
  assert.equal(f.rows[0].password, 'DUMMY-changed-password')
  assert.equal(f.logs.length, 0)
})

test('rollback and unknown outcomes never log credentials or automatically replay', async () => {
  const initializeAdmins = await initializer()
  for (const failure of [
    new Error('DUMMY-PRIVATE-PASSWORD'),
    new AdminCommandError({ code: 'ADMIN_OUTCOME_UNKNOWN', outcome: 'unknown' }),
  ]) {
    const f = fixture({ failure })
    await assert.rejects(initializeAdmins({ ...f, mode: 'production' }), (error) => {
      assert.equal(
        error.code,
        failure instanceof AdminCommandError ? 'ADMIN_OUTCOME_UNKNOWN' : 'ADMIN_FAILED',
      )
      assert.doesNotMatch(String(error), /DUMMY/)
      return true
    })
    assert.equal(f.calls, 1)
    assert.equal(f.logs.length, 0)
  }
})

test('production rejects the development default at the Native login boundary while email and username remain enabled', async () => {
  const { createIdentityCollections } =
    await import('../src/creation/runtime/identity-collections.ts')
  const { createCreationWriteGate } =
    await import('../src/creation/infrastructure/payload/write-gate.ts')
  const collections = createIdentityCollections({
    clock: () => '',
    gate: createCreationWriteGate(),
    mode: 'production',
  })
  const admins = collections.find(({ slug }) => slug === 'admins')
  assert.deepEqual(admins.auth.loginWithUsername, {
    allowEmailLogin: true,
    requireEmail: true,
    requireUsername: false,
  })
  const hook = admins.hooks.beforeOperation[0]
  assert.throws(
    () => hook({ operation: 'login', args: { data: { username: 'admin', password: '123456' } } }),
    (error) => {
      assert.equal(error.status, 401)
      assert.equal(error.name, 'AuthenticationError')
      assert.equal(error.isPublic, true)
      return true
    },
  )
  assert.throws(
    () =>
      hook({
        operation: 'login',
        args: { data: { email: 'admin@local.invalid', password: '123456' } },
      }),
    { name: 'AuthenticationError', status: 401 },
  )
  const strong = { data: { username: 'admin', password: 'DUMMY-strong-password' } }
  assert.equal(hook({ operation: 'login', args: strong }), strong)
  const development = createIdentityCollections({
    clock: () => '',
    gate: createCreationWriteGate(),
    mode: 'development',
  }).find(({ slug }) => slug === 'admins').hooks.beforeOperation[0]
  const preset = { data: { username: 'admin', password: '123456' } }
  assert.equal(development({ operation: 'login', args: preset }), preset)
})

test('startup initialization is explicitly enabled only by the production application entry', async () => {
  const fs = await import('node:fs/promises')
  const builder = await fs.readFile(
    new URL('../src/creation/runtime/payload-config.ts', import.meta.url),
    'utf8',
  )
  const entry = await fs.readFile(new URL('../src/payload.config.ts', import.meta.url), 'utf8')
  assert.match(builder, /adminInitialization\?: 'development' \| 'production'/)
  assert.match(builder, /if \(adminInitialization\)/)
  assert.ok(
    builder.indexOf('await registerCoreRuntime(') < builder.indexOf('await initializeAdmins('),
  )
  assert.match(entry, /adminInitialization:/)
  assert.match(entry, /process\.env\.NODE_ENV/)
})

test('credential logger failure is redacted after confirmation without replaying or undoing the administrator', async () => {
  const initializeAdmins = await initializer()
  const f = fixture()
  let attempted = 0
  const logger = {
    info: ({ password }) => {
      attempted++
      throw new Error(`DUMMY-LOGGER-${password}`)
    },
  }
  await assert.rejects(initializeAdmins({ ...f, logger, mode: 'production' }), (error) => {
    assert.equal(
      error.message === 'Administrator created, but initial credential logging failed.',
      true,
    )
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(String(error), /DUMMY/)
    assert.ok(!String(error).includes(f.inserts[0].password))
    return true
  })
  assert.equal(f.rows.length, 1)
  assert.equal(f.calls, 1)
  assert.equal(attempted, 1)
  assert.deepEqual(await initializeAdmins({ ...f, logger, mode: 'production' }), {
    status: 'skipped',
  })
  assert.equal(attempted, 1)
})
