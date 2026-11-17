import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseCoreConfig, readCoreConfig } from '../src/creation/runtime/config.ts'
import { hostConfig } from './creation/runtime-seed.ts'

const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(tmpdir(), 'heymoro-development-identity-')),
)
test.after(() => fs.rmSync(directory, { recursive: true, force: true }))
let sequence = 0
function fixture() {
  const root = path.join(directory, `profile-${sequence++}`)
  fs.mkdirSync(root, { mode: 0o700 })
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { mode: 0o700 })
  const marker = path.join(root, 'local-profile.json')
  fs.writeFileSync(
    marker,
    JSON.stringify({ purpose: 'heymoro-local-development', createdAt: '2026-11-16T00:00:00.000Z' }),
    { mode: 0o600 },
  )
  const original = hostConfig({ dataDir })
  const config = parseCoreConfig({
    value: { ...original, identity: { ...original.identity, wechat: null, trial: null } },
  })
  const filename = path.join(root, 'core.json')
  fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 })
  return { root, dataDir, marker, config, filename }
}
async function helper() {
  return (await import('../src/creation/runtime/development-identity.ts'))
    .prepareDevelopmentIdentity
}

test('development identity uses a stable namespaced provider and immutable in-memory policy without changing private JSON', async () => {
  const prepareDevelopmentIdentity = await helper()
  const f = fixture()
  const before = fs.readFileSync(f.filename)
  const prepared = prepareDevelopmentIdentity({ config: f.config, mode: 'development' })
  assert.notEqual(prepared.config, f.config)
  assert.match(prepared.config.identity.wechat.appId, /^heymoro-local-development/)
  assert.deepEqual(prepared.config.identity.trial, { issuedCredits: 100, validForSeconds: null })
  assert.ok(Object.isFrozen(prepared.config) && Object.isFrozen(prepared.config.identity))
  const first = await prepared.ports.wechat({ code: 'code-one' })
  const second = await prepared.ports.wechat({ code: 'code-two' })
  assert.deepEqual(first, second)
  assert.match(first.openId, /^local-development:[a-f0-9]{64}$/)
  assert.equal(first.unionId, null)
  assert.equal(f.config.identity.wechat, null)
  assert.equal(f.config.identity.trial, null)
  assert.deepEqual(fs.readFileSync(f.filename), before)
  assert.deepEqual(
    await prepareDevelopmentIdentity({ config: f.config, mode: 'development' }).ports.wechat({
      code: 'after-restart',
    }),
    first,
  )
  const another = fixture()
  assert.notEqual(
    (
      await prepareDevelopmentIdentity({
        config: another.config,
        mode: 'development',
      }).ports.wechat({ code: 'same-code' })
    ).openId,
    first.openId,
  )
})

test('development identity stays off without every trusted local prerequisite and never overrides real WeChat configuration', async () => {
  const prepareDevelopmentIdentity = await helper()
  for (const mode of [undefined, 'test', 'staging']) {
    const f = fixture()
    assert.deepEqual(prepareDevelopmentIdentity({ config: f.config, mode }), { config: f.config })
  }
  for (const mutate of [
    (f) => {
      fs.unlinkSync(f.marker)
    },
    (f) => {
      fs.writeFileSync(f.marker, JSON.stringify({ purpose: 'unrecognized' }))
    },
    (f) => {
      fs.writeFileSync(f.marker, 'DUMMY_PRIVATE_INVALID_JSON')
    },
    (f) => {
      fs.writeFileSync(f.marker, 'x'.repeat(4097))
    },
    (f) => {
      fs.chmodSync(f.marker, 0o644)
    },
    (f) => {
      fs.chmodSync(f.root, 0o755)
    },
    (f) => {
      const file = path.join(f.root, 'other.json')
      fs.renameSync(f.marker, file)
      fs.symlinkSync(file, f.marker)
    },
    (f) => {
      fs.renameSync(f.dataDir, path.join(f.root, 'other-data'))
      fs.symlinkSync(path.join(f.root, 'other-data'), f.dataDir)
    },
  ]) {
    const f = fixture()
    mutate(f)
    assert.deepEqual(prepareDevelopmentIdentity({ config: f.config, mode: 'development' }), {
      config: f.config,
    })
  }
  for (const publicApiUrl of ['https://example.test', 'http://192.0.2.1:3001']) {
    const f = fixture()
    const config = parseCoreConfig({ value: { ...f.config, publicApiUrl } })
    assert.deepEqual(prepareDevelopmentIdentity({ config, mode: 'development' }), { config })
  }
  const f = fixture()
  const configured = hostConfig({ dataDir: f.dataDir })
  assert.deepEqual(prepareDevelopmentIdentity({ config: configured, mode: 'development' }), {
    config: configured,
  })
})

test('production host reads reject marked development data before database IO even if WeChat remains unconfigured', async () => {
  const f = fixture()
  const previous = process.env.NODE_ENV
  try {
    process.env.NODE_ENV = 'production'
    assert.throws(
      () => readCoreConfig({ filename: f.filename }),
      /Local development data is forbidden in production/,
    )
    const prepareDevelopmentIdentity = await helper()
    assert.throws(
      () => prepareDevelopmentIdentity({ config: f.config, mode: 'production' }),
      /Local development data is forbidden in production/,
    )
    assert.deepEqual(fs.readdirSync(f.dataDir), [])
    fs.unlinkSync(f.marker)
    const config = readCoreConfig({ filename: f.filename })
    assert.equal(config.identity.wechat, null)
    assert.deepEqual(prepareDevelopmentIdentity({ config, mode: 'production' }), { config })
    const { createIdentityService } = await import('../src/creation/application/identity.ts')
    const noIO = () =>
      assert.fail('Unconfigured production identity must not touch providers or persistence')
    const identity = createIdentityService({
      clock: noIO,
      exchange: null,
      persistence: { read: noIO, write: noIO },
      policy: config.identity,
      trial: noIO,
    })
    await assert.rejects(identity.login({ input: { code: 'valid-production-code' } }), {
      code: 'AUTH_UNCONFIGURED',
    })
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})

test('production local-profile isolation follows aliases and ancestors and fails closed for malformed or linked markers', async () => {
  const prepareDevelopmentIdentity = await helper()
  const f = fixture()
  const alias = path.join(directory, 'profile-alias')
  fs.symlinkSync(f.root, alias)
  const nested = path.join(f.dataDir, 'nested')
  fs.mkdirSync(nested)
  for (const dataDir of [path.join(alias, 'data'), nested]) {
    const config = parseCoreConfig({ value: { ...f.config, dataDir } })
    assert.throws(
      () => prepareDevelopmentIdentity({ config, mode: 'production' }),
      /Local development data is forbidden in production/,
    )
  }
  fs.writeFileSync(f.marker, 'DUMMY_PRIVATE_MALFORMED_PROFILE')
  assert.throws(
    () => prepareDevelopmentIdentity({ config: f.config, mode: 'production' }),
    /Local development data is forbidden in production/,
  )
  fs.unlinkSync(f.marker)
  fs.symlinkSync(path.join(f.root, 'missing.json'), f.marker)
  assert.throws(
    () => prepareDevelopmentIdentity({ config: f.config, mode: 'production' }),
    /Local development data is forbidden in production/,
  )
})

test('development adaptation preserves an explicit trial policy and real upstream configuration without network requests', async () => {
  const prepareDevelopmentIdentity = await helper()
  const f = fixture()
  const config = parseCoreConfig({
    value: {
      ...f.config,
      identity: { ...f.config.identity, trial: { issuedCredits: 17, validForSeconds: 3600 } },
    },
  })
  const prepared = prepareDevelopmentIdentity({ config, mode: 'development' })
  assert.deepEqual(prepared.config.identity.trial, config.identity.trial)
  const source = await fs.promises.readFile(
    new URL('../src/payload.config.ts', import.meta.url),
    'utf8',
  )
  assert.match(source, /prepareDevelopmentIdentity\(\{ config: readCoreConfig\(\) \}\)/)
  assert.match(source, /config: prepared\.config/)
  assert.match(source, /ports: prepared\.ports/)
})
