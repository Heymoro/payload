import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'heymoro-admin-unit-')))
test.after(() => fs.rmSync(directory, { recursive: true, force: true }))
const password = '  DUMMY-password-123  '
const authorization = 'JWT eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.c2lnbmF0dXJl'
const requestId = 'a4fc34ee-82dd-4fd7-b311-22de786384c1'
const bootstrap = () => ({ action: 'bootstrap', email: ' Admin@Example.test ', password })

test('core private reader sanitizes descriptor close failures too', async () => {
  const { readCoreConfig } = await import('../src/creation/runtime/config.ts')
  const filename = path.join(directory, 'close.json')
  fs.writeFileSync(filename, '{}')
  const close = fs.closeSync
  fs.closeSync = (fd) => {
    close(fd)
    throw new Error('DUMMY_SECRET_CLOSE_PATH')
  }
  syncBuiltinESMExports()
  try {
    assert.throws(
      () => readCoreConfig({ filename }),
      (error) => {
        assert.equal(error.message, 'Invalid external core configuration file.')
        assert.equal(error.cause, undefined)
        return true
      },
    )
  } finally {
    fs.closeSync = close
    syncBuiltinESMExports()
  }
})

test('commands copy and freeze nested inputs without changing password bytes', async () => {
  const { parseAdminCommand } = await import('../src/creation/domain/admin.ts')
  const source = { action: 'update', authorization, id: 1, changes: { password, role: 'admin' } }
  const parsed = parseAdminCommand({ input: source })
  source.changes.password = 'mutated'
  assert.equal(parsed.changes.password, password)
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.changes))
  assert.equal(parseAdminCommand({ input: bootstrap() }).email, 'admin@example.test')
})

test('strict commands reject unexpected descriptors and every privilege expansion', async () => {
  const { parseAdminCommand } = await import('../src/creation/domain/admin.ts')
  const bad = [
    null,
    [],
    new Date(),
    Object.assign(Object.create({}), bootstrap()),
    { ...bootstrap(), role: 'admin' },
    { ...bootstrap(), actor: 'admin:1' },
    { ...bootstrap(), [Symbol('x')]: 1 },
    ...['hash', 'salt', 'sessions', 'audit', 'isDeleted', 'requestId'].map((key) => ({
      ...bootstrap(),
      [key]: 'x',
    })),
    ...['delete', 'bulk'].map((action) => ({ ...bootstrap(), action })),
    ...['', ' '.repeat(12), 'x'.repeat(11), 'x'.repeat(1025)].map((password) => ({
      ...bootstrap(),
      password,
    })),
    ...['bad', 'a@b', 'a'.repeat(300) + '@example.test'].map((email) => ({
      ...bootstrap(),
      email,
    })),
    ...[
      'Bearer a.b.c',
      'JWT opaque',
      'JWT a.b.c extra',
      'JWT a..c',
      'JWT ' + 'a'.repeat(9000) + '.b.c',
    ].map((authorization) => ({
      action: 'create',
      authorization,
      email: 'a@example.test',
      password,
      role: 'operator',
    })),
    { action: 'create', authorization, email: 'a@example.test', password },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map((id) => ({
      action: 'update',
      authorization,
      id,
      changes: { role: 'admin' },
    })),
    ...[
      {},
      { email: 'b@example.test' },
      { role: 'owner' },
      { status: 'deleted' },
      { password: undefined },
    ].map((changes) => ({ action: 'update', authorization, id: 1, changes })),
  ]
  const accessor = { ...bootstrap() }
  Object.defineProperty(accessor, 'password', {
    get() {
      throw Error('getter must not run')
    },
    enumerable: true,
  })
  bad.push(accessor)
  for (const input of bad)
    assert.throws(() => parseAdminCommand({ input }), { code: 'ADMIN_INVALID_INPUT' })
})

function memoryPersistence() {
  const rows = []
  const audits = []
  let calls = 0
  const repository = {
    authenticate: async () => ({ id: 1, role: 'admin', status: 'active' }),
    countAll: async () => rows.length,
    countOtherActive: async ({ id }) =>
      rows.filter((r) => r.id !== id && r.role === 'admin' && r.status === 'active').length,
    findEmail: async ({ email }) => rows.filter((r) => r.email === email),
    findId: async ({ id }) => rows.find((r) => r.id === id) ?? null,
    insert: async (args) => {
      const row = { id: rows.length + 1, ...args }
      rows.push(row)
      return row
    },
    update: async ({ id, changes }) => {
      const row = rows.find((r) => r.id === id)
      Object.assign(row, changes)
      return row
    },
    appendAudit: async (args) => {
      audits.push(args)
    },
  }
  return {
    rows,
    audits,
    repository,
    write: async ({ resource, work }) => {
      assert.equal(resource, 'admin-management')
      calls++
      return work({ repository })
    },
    get calls() {
      return calls
    },
  }
}

test('host commands bootstrap once, enforce roles, preserve no-op and private audit contract', async () => {
  const { createAdministration } = await import('../src/creation/application/admin.ts')
  const p = memoryPersistence()
  const service = createAdministration({ clock: () => '2026-01-01T00:00:00.000Z', write: p.write })
  const result = await service.execute({ input: bootstrap(), requestId })
  assert.deepEqual(result, {
    requestId,
    outcome: 'confirmed',
    data: { id: 1, role: 'admin', status: 'active', changed: true },
  })
  await assert.rejects(service.execute({ input: bootstrap(), requestId }), {
    code: 'ADMIN_ALREADY_INITIALIZED',
    requestId,
    outcome: 'rolled_back',
  })
  await assert.rejects(
    service.execute({
      input: { action: 'update', authorization, id: 1, changes: { role: 'operator' } },
      requestId,
    }),
    { code: 'ADMIN_LAST_ACTIVE_ADMIN' },
  )
  const before = p.audits.length
  assert.equal(
    (
      await service.execute({
        input: {
          action: 'update',
          authorization,
          id: 1,
          changes: { role: 'admin', status: 'active' },
        },
        requestId,
      })
    ).data.changed,
    false,
  )
  assert.equal(p.audits.length, before)
  await service.execute({
    input: {
      action: 'create',
      authorization,
      email: 'other@example.test',
      password,
      role: 'operator',
    },
    requestId,
  })
  await service.execute({
    input: { action: 'update', authorization, id: 2, changes: { password } },
    requestId,
  })
  assert.deepEqual(p.audits[0].beforeState, null)
  assert.equal(p.audits[0].actor, 'system:bootstrap')
  assert.equal(p.audits.at(-1).actor, 'admin:1')
  assert.equal(p.audits.at(-1).summary.passwordChanged, true)
  assert.doesNotMatch(
    JSON.stringify(p.audits),
    /DUMMY|JWT|example.test|authorization|salt|sessions/,
  )
})

test('host parse happens before first await and bad inputs never reach transaction', async () => {
  const { createAdministration } = await import('../src/creation/application/admin.ts')
  const p = memoryPersistence()
  const service = createAdministration({ clock: () => '2026-01-01T00:00:00.000Z', write: p.write })
  const input = bootstrap()
  const pending = service.execute({ input, requestId })
  input.password = 'mutated'
  input.email = 'mutated'
  await pending
  assert.equal(p.rows[0].password, password)
  const before = p.calls
  await assert.rejects(service.execute({ input: { ...bootstrap(), hash: 'x' }, requestId }), {
    code: 'ADMIN_INVALID_INPUT',
    requestId,
  })
  await assert.rejects(service.execute({ input: bootstrap(), requestId: 'bad' }), {
    code: 'ADMIN_INVALID_INPUT',
  })
  assert.equal(p.calls, before)
})

test('authorization/integrity/conflict/not-found errors are controlled and raw causes never escape', async () => {
  const { createAdministration } = await import('../src/creation/application/admin.ts')
  const p = memoryPersistence()
  const service = createAdministration({ clock: () => '2026-01-01T00:00:00.000Z', write: p.write })
  await service.execute({ input: bootstrap() })
  const command = {
    action: 'create',
    authorization,
    email: 'admin@example.test',
    password,
    role: 'admin',
  }
  await assert.rejects(service.execute({ input: command }), { code: 'ADMIN_CONFLICT' })
  await assert.rejects(
    service.execute({
      input: { action: 'update', authorization, id: 999, changes: { status: 'active' } },
    }),
    { code: 'ADMIN_NOT_FOUND' },
  )
  for (const actor of [
    null,
    { id: 1, role: 'operator', status: 'active' },
    { id: 1, role: 'admin', status: 'disabled' },
  ]) {
    p.repository.authenticate = async () => actor
    await assert.rejects(service.execute({ input: command }), {
      code: actor ? 'ADMIN_FORBIDDEN' : 'ADMIN_UNAUTHORIZED',
    })
  }
  const failing = createAdministration({
    clock: () => '',
    write: async () => {
      throw new Error('DUMMY_NATIVE_SECRET')
    },
  })
  await assert.rejects(failing.execute({ input: bootstrap(), requestId }), (error) => {
    assert.equal(error.code, 'ADMIN_FAILED')
    assert.equal(error.requestId, requestId)
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(String(error), /DUMMY/)
    return true
  })
})

test('private command reader is bounded, external, regular, change-aware and redacts errors', async () => {
  const { readPrivateJSON } = await import('../src/creation/runtime/private-json.ts')
  const { projectRoot } = await import('../src/creation/runtime/config.ts')
  const file = path.join(directory, 'command.json')
  const read = (filename = file) =>
    readPrivateJSON({
      filename,
      maxBytes: 16384,
      projectRoot,
      pathMessage: 'Invalid private path.',
      fileMessage: 'Invalid private JSON.',
    })
  fs.writeFileSync(file, JSON.stringify(bootstrap()))
  assert.deepEqual(read(), bootstrap())
  for (const content of ['{"DUMMY_SECRET":', 'x'.repeat(16385)]) {
    fs.writeFileSync(file, content)
    assert.throws(read, /Invalid private JSON/)
  }
  const link = path.join(directory, 'link.json')
  fs.symlinkSync(file, link)
  for (const filename of [
    link,
    directory,
    path.join(projectRoot, 'package.json'),
    path.join(directory, '.env.json'),
    'relative.json',
  ])
    assert.throws(() => read(filename))
  const back = path.join(directory, 'back')
  fs.symlinkSync(projectRoot, back)
  assert.throws(() => read(path.join(back, 'package.json')))
  fs.writeFileSync(file, '{}')
  const original = fs.readSync
  fs.readSync = (...args) => {
    const n = original(...args)
    fs.appendFileSync(file, ' ')
    return n
  }
  syncBuiltinESMExports()
  try {
    assert.throws(read, /Invalid private JSON/)
  } finally {
    fs.readSync = original
    syncBuiltinESMExports()
  }
})

test('CLI rejects malformed private files before building or opening providers', async () => {
  const { runAdminCommand } = await import('../scripts/admin-commands.mjs')
  let builds = 0
  const commandFile = path.join(directory, 'bad-command.json')
  const configFile = path.join(directory, 'bad-config.json')
  fs.writeFileSync(commandFile, '{"password":"DUMMY_SECRET",')
  fs.writeFileSync(configFile, '{}')
  const result = await runAdminCommand({
    argv: ['--config', configFile, '--command', commandFile],
    ports: {
      build: () => {
        builds++
        throw Error('DUMMY_SECRET')
      },
    },
  })
  assert.equal(builds, 0)
  assert.equal(result.exitCode, 1)
  assert.doesNotMatch(JSON.stringify(result), /DUMMY_SECRET|bad-command.json/)
  assert.match(result.requestId, /^[a-f0-9-]{36}$/)
})

test('CLI preserves confirmed execution on cleanup failure and silences Native startup logger', async () => {
  const { runAdminCommand } = await import('../scripts/admin-commands.mjs')
  const { hostConfig } = await import('./creation/runtime-seed.ts')
  const configFile = path.join(directory, 'valid-config.json'),
    commandFile = path.join(directory, 'valid-command.json')
  fs.writeFileSync(
    configFile,
    JSON.stringify(hostConfig({ dataDir: path.join(directory, 'target') })),
  )
  fs.writeFileSync(commandFile, JSON.stringify(bootstrap()))
  let closes = 0,
    destroys = 0,
    clients = 0
  const result = await runAdminCommand({
    argv: ['--config', configFile, '--command', commandFile],
    ports: {
      build: async () => ({ logger: false }),
      open: async ({ config }) => {
        assert.deepEqual(config.logger, { options: { level: 'silent' } })
        return {}
      },
      runtime: () => ({
        administration: {
          execute: async ({ requestId }) => ({
            requestId,
            outcome: 'confirmed',
            data: { id: 1, role: 'admin', status: 'active', changed: true },
          }),
        },
        close: async () => {
          closes++
          throw Error('DUMMY_CLOSE_SECRET')
        },
      }),
      client: () => ({
        close: () => {
          clients++
        },
      }),
      destroy: async () => {
        destroys++
      },
    },
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.code, 'ADMIN_CLEANUP_FAILED')
  assert.equal(result.outcome, 'confirmed')
  assert.equal(result.data.id, 1)
  assert.deepEqual([closes, destroys, clients], [1, 1, 1])
  assert.doesNotMatch(JSON.stringify(result), /DUMMY_CLOSE/)
  const failed = await runAdminCommand({
    argv: ['--config', configFile, '--command', commandFile],
    ports: {
      build: async () => ({}),
      open: async ({ config }) => {
        assert.equal(config.logger.options.level, 'silent')
        throw Error('DUMMY_INIT_SECRET')
      },
    },
  })
  assert.equal(failed.code, 'ADMIN_STARTUP_FAILED')
  assert.doesNotMatch(JSON.stringify(failed), /DUMMY_INIT/)
})

test('CLI subprocess emits exactly one controlled JSON with allowlisted env', () => {
  const commandFile = path.join(directory, 'process.json')
  fs.writeFileSync(commandFile, '{"password":"DUMMY_CHILD_SECRET",')
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/admin-commands.mjs',
      '--config',
      path.join(directory, 'bad-config.json'),
      '--command',
      commandFile,
    ],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { PATH: process.env.PATH, HOME: directory, NODE_ENV: 'test' },
      encoding: 'utf8',
    },
  )
  assert.equal(result.status, 1)
  const output = JSON.parse(result.stdout)
  assert.ok(output.requestId)
  assert.equal(output.outcome, 'not_started')
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /DUMMY_CHILD_SECRET|process.json|Error:|\bat .*\(/,
  )
})

test('no-op DTO never copies extra persistence fields', async () => {
  const { createAdministration } = await import('../src/creation/application/admin.ts')
  const p = memoryPersistence()
  p.rows.push({
    id: 1,
    email: 'DUMMY_PRIVATE_EMAIL',
    password: 'DUMMY_PRIVATE_PASSWORD',
    role: 'admin',
    status: 'active',
  })
  const result = await createAdministration({ clock: () => '', write: p.write }).execute({
    input: { action: 'update', authorization, id: 1, changes: { role: 'admin' } },
  })
  assert.deepEqual(Object.keys(result.data).sort(), ['changed', 'id', 'role', 'status'])
})

test('CLI owns partially initialized Native resources even when onInit throws', async () => {
  const { runAdminCommand } = await import('../scripts/admin-commands.mjs')
  const { hostConfig } = await import('./creation/runtime-seed.ts')
  const configFile = path.join(directory, 'partial-config.json'),
    commandFile = path.join(directory, 'partial-command.json')
  fs.writeFileSync(
    configFile,
    JSON.stringify(hostConfig({ dataDir: path.join(directory, 'partial') })),
  )
  fs.writeFileSync(commandFile, JSON.stringify(bootstrap()))
  let closed = 0,
    destroyed = 0
  const result = await runAdminCommand({
    argv: ['--config', configFile, '--command', commandFile],
    ports: {
      build: async () => ({
        onInit: async () => {
          throw Error('DUMMY_ONINIT_SECRET')
        },
      }),
      open: async ({ config }) => {
        await config.onInit({})
        throw Error('unexpected')
      },
      client: () => ({
        close: () => {
          closed++
        },
      }),
      destroy: async () => {
        destroyed++
      },
    },
  })
  assert.equal(result.code, 'ADMIN_STARTUP_FAILED')
  assert.deepEqual([closed, destroyed], [1, 1])
  assert.doesNotMatch(JSON.stringify(result), /DUMMY_ONINIT/)
})

test('CLI retains unknown transaction trace and performs no automatic replay', async () => {
  const { runAdminCommand } = await import('../scripts/admin-commands.mjs')
  const { AdminCommandError } = await import('../src/creation/domain/admin.ts')
  const { hostConfig } = await import('./creation/runtime-seed.ts')
  const configFile = path.join(directory, 'unknown-config.json'),
    commandFile = path.join(directory, 'unknown-command.json')
  fs.writeFileSync(
    configFile,
    JSON.stringify(hostConfig({ dataDir: path.join(directory, 'unknown') })),
  )
  fs.writeFileSync(commandFile, JSON.stringify(bootstrap()))
  let attempts = 0
  const result = await runAdminCommand({
    argv: ['--config', configFile, '--command', commandFile],
    ports: {
      build: async () => ({}),
      open: async () => ({}),
      client: () => ({ close: () => {} }),
      destroy: async () => {},
      runtime: () => ({
        close: async () => {},
        administration: {
          execute: async ({ requestId }) => {
            attempts++
            throw new AdminCommandError({
              code: 'ADMIN_OUTCOME_UNKNOWN',
              outcome: 'unknown',
              requestId,
            })
          },
        },
      }),
    },
  })
  assert.equal(result.code, 'ADMIN_OUTCOME_UNKNOWN')
  assert.equal(result.outcome, 'unknown')
  assert.equal(attempts, 1)
  assert.equal(result.exitCode, 1)
  assert.match(result.requestId, /^[a-f0-9-]{36}$/)
})

test('CLI closes an existing Native client when connect fails before onInit', async () => {
  const { runAdminCommand } = await import('../scripts/admin-commands.mjs')
  const { hostConfig } = await import('./creation/runtime-seed.ts')
  const configFile = path.join(directory, 'connect-config.json')
  const commandFile = path.join(directory, 'connect-command.json')
  fs.writeFileSync(
    configFile,
    JSON.stringify(hostConfig({ dataDir: path.join(directory, 'connect') })),
  )
  fs.writeFileSync(commandFile, JSON.stringify(bootstrap()))
  let destroyed = 0,
    closed = 0
  const adapter = { client: undefined }
  const instance = { db: undefined }
  const args = { payload: instance }
  const result = await runAdminCommand({
    argv: ['--config', configFile, '--command', commandFile],
    ports: {
      build: async () => ({
        db: {
          init: (received) => {
            assert.equal(received, args)
            return adapter
          },
        },
      }),
      open: async ({ config }) => {
        assert.equal(config.db.init(args), adapter)
        instance.db = adapter
        adapter.client = {
          close: () => {
            closed++
          },
        }
        throw new Error('DUMMY_PRE_ONINIT_CONNECT_SECRET_PATH')
      },
      client: (payload) => payload.db.client,
      destroy: async (payload) => {
        assert.equal(payload, instance)
        destroyed++
        payload.db = undefined
      },
    },
  })
  assert.deepEqual([destroyed, closed], [1, 1])
  assert.equal(result.code, 'ADMIN_STARTUP_FAILED')
  assert.equal(result.outcome, 'not_started')
  assert.equal(result.exitCode, 1)
  assert.doesNotMatch(
    JSON.stringify(result),
    /DUMMY_PRE_ONINIT_CONNECT_SECRET_PATH|connect-config.json|connect-command.json/,
  )
})

test('public commands keep strong password validation with no caller weak-password switch', async () => {
  const { createAdministration } = await import('../src/creation/application/admin.ts')
  const { parseAdminCommand } = await import('../src/creation/domain/admin.ts')
  const p = memoryPersistence()
  const service = createAdministration({ clock: () => '', mode: 'development', write: p.write })
  for (const input of [
    { ...bootstrap(), password: '123456' },
    {
      action: 'create',
      authorization,
      email: 'other@example.test',
      password: '123456',
      role: 'admin',
    },
    { action: 'update', authorization, id: 1, changes: { password: '123456' } },
    { ...bootstrap(), allowWeak: true },
    { ...bootstrap(), development: true },
  ]) {
    assert.throws(() => parseAdminCommand({ input }), { code: 'ADMIN_INVALID_INPUT' })
    await assert.rejects(service.execute({ input }), { code: 'ADMIN_INVALID_INPUT' })
  }
  assert.equal(p.calls, 0)
})

test('development preset is a no-argument factory capability using the same transaction and audit', async () => {
  const { createAdministration } = await import('../src/creation/application/admin.ts')
  const p = memoryPersistence()
  const service = createAdministration({
    clock: () => '2026-11-16T00:00:00.000Z',
    mode: 'development',
    write: p.write,
  })
  const result = await service.initializeDevelopmentPreset()
  assert.equal(result.outcome, 'confirmed')
  assert.equal(result.data.changed, true)
  assert.deepEqual(p.rows, [
    {
      id: 1,
      email: 'admin@local.invalid',
      username: 'admin',
      password: '123456',
      role: 'admin',
      status: 'active',
    },
  ])
  assert.equal(p.calls, 1)
  assert.equal(p.audits.length, 1)
  assert.doesNotMatch(JSON.stringify(p.audits), /123456|local.invalid|username/)
  p.rows[0].status = 'disabled'
  await assert.rejects(service.initializeDevelopmentPreset(), { code: 'ADMIN_ALREADY_INITIALIZED' })
  assert.equal(p.rows[0].status, 'disabled')
  assert.equal(p.audits.length, 1)
  for (const mode of [undefined, 'test', 'production']) {
    const blocked = memoryPersistence()
    await assert.rejects(
      createAdministration({
        clock: () => '',
        mode,
        write: blocked.write,
      }).initializeDevelopmentPreset(),
      { code: 'ADMIN_FORBIDDEN', outcome: 'not_started' },
    )
    assert.equal(blocked.calls, 0)
  }
})

test('only bootstrap and create accept normalized optional usernames', async () => {
  const { parseAdminCommand } = await import('../src/creation/domain/admin.ts')
  const { createAdministration } = await import('../src/creation/application/admin.ts')
  const input = { ...bootstrap(), username: ' Admin ' }
  assert.equal(parseAdminCommand({ input }).username, 'admin')
  const p = memoryPersistence()
  await createAdministration({ clock: () => '', write: p.write }).execute({ input })
  assert.equal(p.rows[0].username, 'admin')
  for (const username of ['', 'a b', 'a@b', 'a'.repeat(65), undefined])
    assert.throws(() => parseAdminCommand({ input: { ...bootstrap(), username } }), {
      code: 'ADMIN_INVALID_INPUT',
    })
  assert.throws(
    () =>
      parseAdminCommand({
        input: { action: 'update', authorization, id: 1, changes: { username: 'admin' } },
      }),
    { code: 'ADMIN_INVALID_INPUT' },
  )
})
