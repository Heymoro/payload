import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const directory = mkdtempSync(path.join(tmpdir(), 'heymoro-runtime-config-'))
test.after(() => rmSync(directory, { recursive: true, force: true }))
test('default product root requires an explicit external core config before database IO', async () => {
  delete process.env.HEYMORO_CORE_CONFIG_FILE
  await assert.rejects(import('../src/payload.config.ts'), /HEYMORO_CORE_CONFIG_FILE/)
})
test('bounded external config rejects secret-bearing syntax errors without echo', async () => {
  const { readCoreConfig } = await import('../src/creation/runtime/config.ts')
  const filename = path.join(directory, 'core.json')
  writeFileSync(filename, '{"payloadSecret":"DO_NOT_ECHO",')
  assert.throws(
    () => readCoreConfig({ filename }),
    (error) => {
      assert.doesNotMatch(error.message, /DO_NOT_ECHO/)
      return /configuration/.test(error.message)
    },
  )
})

test('host config is strict, copied, frozen and requires explicit provider/null decisions', async () => {
  const { hostConfig } = await import('./creation/runtime-seed.ts')
  const { parseCoreConfig } = await import('../src/creation/runtime/config.ts')
  const source = structuredClone(hostConfig({ dataDir: path.join(directory, 'host-target') }))
  const snapshot = parseCoreConfig({ value: source })
  source.hostCaps.maxImages = 99
  assert.equal(snapshot.hostCaps.maxImages, 4)
  assert.ok(Object.isFrozen(snapshot.s3.backends[0].credentials))
  for (const mutate of [
    (config) => {
      config.fixture = true
    },
    (config) => {
      delete config.quote
    },
    (config) => {
      config.hostCaps.maxImageBytes = 5000001
    },
    (config) => {
      config.hostCaps.maxTotalImageBytes = 20000001
    },
    (config) => {
      config.image.engineBudgetMs = config.worker.engineTimeoutMs + 1
    },
    (config) => {
      config.s3.output.bucket = 'unregistered'
    },
    (config) => {
      config.execution.storageOutput.bucket = 'mismatch'
    },
    (config) => {
      config.cursorKey = 'demo'
    },
    (config) => {
      config.redis.url = 'redis://127.0.0.1'
    },
  ]) {
    const input = structuredClone(snapshot)
    mutate(input)
    assert.throws(() => parseCoreConfig({ value: input }), /configuration/)
  }
  const unavailable = structuredClone(snapshot)
  for (const field of ['execution', 'quote', 'image', 'naming']) unavailable[field] = null
  assert.equal(parseCoreConfig({ value: unavailable }).image, null)
})

test('config path rejects leaf links, in-project files, oversized and nonabsolute files', async () => {
  const { readCoreConfig } = await import('../src/creation/runtime/config.ts')
  const { symlinkSync } = await import('node:fs')
  const filename = path.join(directory, 'oversize.json')
  writeFileSync(filename, ' '.repeat(65537))
  symlinkSync(filename, path.join(directory, 'linked.json'))
  for (const name of [
    filename,
    path.join(directory, 'linked.json'),
    'relative.json',
    new URL('../package.json', import.meta.url).pathname,
  ])
    assert.throws(
      () => readCoreConfig({ filename: name }),
      /configuration|HEYMORO_CORE_CONFIG_FILE/,
    )
})

test('explicit CLI initializes only a fresh target, closes, and actual default root reopens in production', async (t) => {
  const { hostConfig } = await import('./creation/runtime-seed.ts')
  const { realpathSync, readFileSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const canonical = realpathSync(directory)
  const filename = path.join(canonical, 'core.json')
  const { startRedisFixture } = await import('./creation/redis-fixture.ts')
  const redis = await startRedisFixture()
  t.after(() => redis.stop())
  const config = hostConfig({ dataDir: path.join(canonical, 'cli-target'), redisURL: redis.url })
  writeFileSync(filename, JSON.stringify(config))
  const cwd = fileURLToPath(new URL('../', import.meta.url))
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    HEYMORO_CORE_CONFIG_FILE: filename,
  }
  const init = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/init-target.mjs', '--config', filename],
    { cwd, env: { ...env, NODE_ENV: 'development' }, encoding: 'utf8', timeout: 30000 },
  )
  assert.equal(init.error, undefined, String(init.error))
  assert.equal(init.status, 0, init.stderr)
  assert.equal(JSON.parse(readFileSync(path.join(config.dataDir, 'profile.json'))).state, 'ready')
  const { DatabaseSync: InitialDatabase } = await import('node:sqlite')
  const initialDatabase = new InitialDatabase(path.join(config.dataDir, 'core.sqlite'), {
    readOnly: true,
  })
  try {
    assert.equal(initialDatabase.prepare('SELECT count(*) AS total FROM admins').get().total, 0)
  } finally {
    initialDatabase.close()
  }
  const reopenSource = `
    import configPromise from './src/payload.config.ts';
    import { getPayload } from 'payload';
    import { getCoreRuntime } from './src/creation/runtime/services.ts';
    import { getCreationSQLiteAdapter } from './src/creation/infrastructure/payload/sqlite-unit-of-work.ts';
    const config = await configPromise;
    config.logger = { options: { level: 'silent' } };
    const original = config.onInit;
    const credentials = [];
    config.onInit = async (payload) => {
      const info = payload.logger.info;
      payload.logger.info = (entry) => { if (entry && typeof entry === 'object' && 'password' in entry) credentials.push(entry); };
      try { await original?.(payload); } finally { payload.logger.info = info; }
    };
    const p = await getPayload({ config });
    try {
      if (p.config.collections.some(c => ['records', 'generations'].includes(c.slug))) throw Error('legacy');
      const changedPassword = 'DUMMY-preserved-after-initialization';
      const first = credentials[0];
      const login = await p.login({ collection: 'admins', data: { username: 'admin', password: first?.password ?? changedPassword } });
      if (!login.token || credentials.length > 1) throw Error('Initialization verification failed.');
      if (first) {
        if (!/^[\\w-]{32}$/.test(first.password) || first.username !== 'admin') throw Error('Initialization verification failed.');
        await getCoreRuntime({ payload: p }).administration.execute({ input: { action: 'update', authorization: 'JWT ' + login.token, id: login.user.id, changes: { password: changedPassword } } });
      }
      if ((await p.count({ collection: 'admins', overrideAccess: true })).totalDocs !== 1) throw Error('Initialization verification failed.');
      process.stdout.write(JSON.stringify({ initialized: Boolean(first), passwordPreserved: true }));
    } finally {
      credentials.length = 0;
      await getCoreRuntime({ payload: p }).close();
      const client = getCreationSQLiteAdapter({ payload: p }).client;
      await p.destroy();
      client.close();
    }
  `
  const reopen = () =>
    spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', reopenSource], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 30000,
    })
  const firstOpen = reopen()
  assert.equal(firstOpen.status, 0, 'First production startup failed.')
  assert.deepEqual(JSON.parse(firstOpen.stdout), { initialized: true, passwordPreserved: true })
  const secondOpen = reopen()
  assert.equal(secondOpen.status, 0, 'Repeated production startup failed.')
  assert.deepEqual(JSON.parse(secondOpen.stdout), { initialized: false, passwordPreserved: true })
  const startupFailureSource = `
    import { getPayload } from 'payload';
    import { readCoreConfig } from './src/creation/runtime/config.ts';
    import { buildCorePayloadConfig } from './src/creation/runtime/payload-config.ts';
    let closes = 0, logs = 0, hasFailed = false;
    const config = await buildCorePayloadConfig({
      config: readCoreConfig(), adminInitialization: 'production',
      ports: { connectRedis: async () => ({
        client: { set: async () => { throw Error('DUMMY_PRIVATE_STARTUP_FAILURE'); }, eval: async () => 1 },
        close: async () => { closes++; },
      }) },
    });
    config.logger = { options: { level: 'silent' } };
    const original = config.onInit;
    config.onInit = async (payload) => {
      payload.logger.info = () => { logs++; };
      await original(payload);
    };
    try { await getPayload({ config }); } catch (error) { hasFailed = error.code === 'ADMIN_FAILED'; }
    process.stdout.write(JSON.stringify({ hasFailed, closes, logs }));
  `
  const startupFailure = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', startupFailureSource],
    { cwd, env, encoding: 'utf8', timeout: 30000 },
  )
  assert.equal(startupFailure.status, 0, 'Startup failure verification process failed.')
  assert.deepEqual(JSON.parse(startupFailure.stdout), { hasFailed: true, closes: 1, logs: 0 })
  const failedFilename = path.join(canonical, 'constructor-failure.json')
  const failedConfig = { ...config, dataDir: path.join(canonical, 'constructor-failure-target') }
  writeFileSync(failedFilename, JSON.stringify(failedConfig))
  const failureSource = `import{getPayload}from'payload';import{readCoreConfig}from'./src/creation/runtime/config.ts';import{buildCorePayloadConfig}from'./src/creation/runtime/payload-config.ts';import{prepareTarget}from'./src/creation/runtime/target-profile.ts';const config=readCoreConfig();await getPayload({config:buildCorePayloadConfig({config,initialization:prepareTarget({dataDir:config.dataDir}),ports:{get image(){throw Error('fixture constructor failure')}}})});`
  const failure = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', failureSource],
    {
      cwd,
      env: { ...env, NODE_ENV: 'development', HEYMORO_CORE_CONFIG_FILE: failedFilename },
      encoding: 'utf8',
      timeout: 30000,
    },
  )
  assert.notEqual(failure.status, 0)
  assert.match(failure.stderr, /fixture constructor failure/)
  assert.equal(
    JSON.parse(readFileSync(path.join(failedConfig.dataDir, 'profile.json'))).state,
    'ready',
  )
  const recovered = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', reopenSource],
    {
      cwd,
      env: { ...env, HEYMORO_CORE_CONFIG_FILE: failedFilename },
      encoding: 'utf8',
      timeout: 30000,
    },
  )
  assert.equal(recovered.status, 0, recovered.stderr)
  const again = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/init-target.mjs', '--config', filename],
    { cwd, env: { ...env, NODE_ENV: 'development' }, encoding: 'utf8', timeout: 30000 },
  )
  assert.notEqual(again.status, 0)
  const databaseFile = path.join(config.dataDir, 'core.sqlite')
  const manifestFile = path.join(config.dataDir, 'profile.json')
  const { DatabaseSync } = await import('node:sqlite')
  const { createHash } = await import('node:crypto')
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
  // Each refusal runs in a new process; no Native writable connection may repair drift.
  const pristine = readFileSync(databaseFile)
  for (const mutation of [
    'CREATE TABLE legacy_records (id INTEGER)',
    'ALTER TABLE users DROP COLUMN deleted_by',
    function legacyAdminsWithoutUsername(db) {
      db.exec('DROP INDEX admins_username_idx; ALTER TABLE admins DROP COLUMN username')
    },
    'DROP INDEX user_sessions_token_hash_idx',
    'CREATE TRIGGER unexpected_profile_write BEFORE UPDATE ON users BEGIN SELECT 1; END',
    function commentedAutoincrement(db) {
      db.exec('PRAGMA writable_schema=ON')
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='users'").get()
      assert.match(row.sql, /\bAUTOINCREMENT\b/)
      db.prepare("UPDATE sqlite_master SET sql=? WHERE name='users'").run(
        row.sql.replace(/\bAUTOINCREMENT\b/, '/* AUTOINCREMENT */'),
      )
      db.exec('PRAGMA writable_schema=OFF')
    },

    (db) => {
      db.exec('PRAGMA writable_schema=ON')
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='users'").get()
      db.prepare("UPDATE sqlite_master SET sql=? WHERE name='users'").run(
        row.sql.replace(/\)\s*;?$/, ', CHECK (1))'),
      )
      db.exec('PRAGMA writable_schema=OFF')
    },
    (db) => {
      db.exec('PRAGMA writable_schema=ON')
      db.prepare("UPDATE sqlite_master SET sql=replace(sql, ?, ?) WHERE name='users'").run(
        "DEFAULT 'active'",
        "DEFAULT 'disabled'",
      )
      db.exec('PRAGMA writable_schema=OFF')
    },
    (db) => {
      const index = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='user_sessions' AND sql LIKE 'CREATE UNIQUE%'",
        )
        .get()
      assert.ok(index)
      db.exec(`DROP INDEX "${index.name}"`)
      db.exec(
        `CREATE UNIQUE INDEX "${index.name}" ON user_sessions (token_hash) WHERE is_deleted = false`,
      )
    },
  ]) {
    await t.test(
      typeof mutation === 'string' ? mutation : mutation.toString().slice(0, 100),
      async () => {
        writeFileSync(databaseFile, pristine)
        const db = new DatabaseSync(databaseFile, { defensive: false })
        try {
          if (typeof mutation === 'function') mutation(db)
          else db.exec(mutation)
        } catch (error) {
          if (typeof mutation !== 'string' || !mutation.startsWith('DROP INDEX')) throw error
          const index = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='user_sessions' AND sql LIKE 'CREATE UNIQUE%'",
            )
            .get()
          assert.ok(index)
          db.exec(`DROP INDEX "${index.name}"`)
        } finally {
          db.close()
        }
        const before = [hash(databaseFile), hash(manifestFile)]
        const rejected = reopen()
        assert.notEqual(rejected.status, 0)
        assert.deepEqual([hash(databaseFile), hash(manifestFile)], before)
      },
    )
  }
  writeFileSync(databaseFile, pristine)
  const before = [hash(databaseFile), hash(manifestFile)]
  const dangerous = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', reopenSource],
    { cwd, env: { ...env, PAYLOAD_DROP_DATABASE: 'true' }, encoding: 'utf8', timeout: 30000 },
  )
  assert.notEqual(dangerous.status, 0)
  assert.deepEqual([hash(databaseFile), hash(manifestFile)], before)
})

test('prepared, unknown and symlink targets are refused before any writable open', async (t) => {
  const previousMode = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  t.after(() => {
    if (previousMode === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousMode
  })
  const { prepareTarget, createTargetProfile } =
    await import('../src/creation/runtime/target-profile.ts')
  const { realpathSync, readFileSync, mkdirSync, symlinkSync } = await import('node:fs')
  const canonical = realpathSync(directory)
  const prepared = path.join(canonical, 'prepared-target')
  prepareTarget({ dataDir: prepared })
  const before = readFileSync(path.join(prepared, 'core.sqlite'))
  assert.throws(() => createTargetProfile({ dataDir: prepared }), /ready/)
  assert.throws(() => prepareTarget({ dataDir: prepared }))
  assert.deepEqual(readFileSync(path.join(prepared, 'core.sqlite')), before)
  const unknown = path.join(canonical, 'unknown-target')
  mkdirSync(unknown)
  writeFileSync(path.join(unknown, 'core.sqlite'), 'legacy fixture bytes')
  assert.throws(() => createTargetProfile({ dataDir: unknown }))
  assert.equal(readFileSync(path.join(unknown, 'core.sqlite'), 'utf8'), 'legacy fixture bytes')
  const linked = path.join(canonical, 'target-link')
  symlinkSync(prepared, linked)
  assert.throws(() => createTargetProfile({ dataDir: linked }), /symlink/)
  const { readCoreConfig, projectRoot } = await import('../src/creation/runtime/config.ts')
  const alias = path.join(canonical, 'project-alias')
  symlinkSync(projectRoot, alias)
  assert.throws(
    () => readCoreConfig({ filename: path.join(alias, 'payload/apps/heymoro/package.json') }),
    /configuration/,
  )
})

test('S3 bucket registrations reject numeric identifiers even when destinations share the same value', async () => {
  const { hostConfig } = await import('./creation/runtime-seed.ts')
  const { parseCoreConfig } = await import('../src/creation/runtime/config.ts')
  const config = structuredClone(
    hostConfig({ dataDir: path.join(directory, 'numeric-bucket-target') }),
  )
  config.s3.backends[0].buckets[0] = 123
  config.s3.input.bucket = 123
  assert.throws(() => parseCoreConfig({ value: config }), /configuration/)
})

test('initialization permits only explicit development or test at prepare, builder and schema init', async (t) => {
  const { prepareTarget, createTargetProfile } =
    await import('../src/creation/runtime/target-profile.ts')
  const { buildCorePayloadConfig } = await import('../src/creation/runtime/payload-config.ts')
  const { hostConfig } = await import('./creation/runtime-seed.ts')
  const { realpathSync, existsSync, readFileSync } = await import('node:fs')
  const canonical = realpathSync(directory)
  const previousMode = process.env.NODE_ENV
  const setMode = (value) => {
    if (value === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = value
  }
  try {
    for (const [index, value] of [undefined, '', 'staging', 'production'].entries()) {
      await t.test(`rejects ${value ?? 'unset'} before creating a directory`, () => {
        setMode(value)
        const dataDir = path.join(canonical, `rejected-mode-${index}`)
        assert.throws(() => prepareTarget({ dataDir }), /development or test/)
        assert.equal(existsSync(dataDir), false)
      })
    }
    for (const stage of ['builder', 'schema']) {
      await t.test(`rejects a changed mode after issuing the ticket: ${stage}`, () => {
        setMode('development')
        const dataDir = path.join(canonical, `changed-mode-${stage}`)
        const initialization = prepareTarget({ dataDir })
        const profile = createTargetProfile({ dataDir, initialization })
        const before = [
          readFileSync(path.join(dataDir, 'core.sqlite')),
          readFileSync(path.join(dataDir, 'profile.json')),
        ]
        setMode('staging')
        if (stage === 'builder')
          assert.throws(
            () => buildCorePayloadConfig({ config: hostConfig({ dataDir }), initialization }),
            /development or test/,
          )
        else
          assert.throws(
            () => profile.afterSchemaInit({ schema: { tables: {}, relations: {} } }),
            /development or test/,
          )
        assert.deepEqual(
          [
            readFileSync(path.join(dataDir, 'core.sqlite')),
            readFileSync(path.join(dataDir, 'profile.json')),
          ],
          before,
        )
      })
    }
  } finally {
    setMode(previousMode)
  }
})
