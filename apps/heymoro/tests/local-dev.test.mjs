import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const secrets = {
  payloadSecret: 'p'.repeat(48),
  cursorKey: Buffer.alloc(32, 2).toString('base64url'),
  quoteKey: Buffer.alloc(32, 3).toString('base64url'),
  storageUser: 'local-test-access',
  storageSecret: 'local-test-secret-not-a-real-credential',
}

test('local development config uses owned persistent paths and real loopback dependencies without AI keys', async () => {
  const { createLocalCoreConfig } = await import('../src/creation/runtime/local-config.ts')
  const config = createLocalCoreConfig({ root: '/tmp/heymoro-local-config-test', secrets })
  assert.equal(config.dataDir, '/tmp/heymoro-local-config-test/data')
  assert.equal(config.publicApiUrl, 'http://127.0.0.1:3001')
  assert.equal(config.redis.url, 'redis://127.0.0.1:16379/0')
  assert.equal(config.s3.backends[0].endpoint, 'http://127.0.0.1:19000')
  assert.equal(config.image, null)
  assert.equal(config.naming, null)
  assert.equal(config.identity.wechat, null)
  assert.equal(config.execution.registry['openai-image-v1'].model, 'gpt-image-1.5')
  assert.equal(Object.isFrozen(config.s3.backends[0].credentials), true)
})

test('local config rejects relative roots and application workspace paths', async () => {
  const { createLocalCoreConfig } = await import('../src/creation/runtime/local-config.ts')
  for (const root of ['relative', fileURLToPath(new URL('../', import.meta.url))]) {
    assert.throws(() => createLocalCoreConfig({ root, secrets }), /external absolute/)
  }
})

test('local Next child receives only explicit development profile and dangerous legacy modes disabled', async () => {
  const { localChildEnvironment } = await import('../scripts/local-dev.mjs')
  const env = localChildEnvironment({ configFile: '/tmp/private-heymoro/core.json' })
  assert.equal(env.NODE_ENV, 'development')
  assert.equal(env.HEYMORO_CORE_CONFIG_FILE, '/tmp/private-heymoro/core.json')
  assert.equal(env.PAYLOAD_DROP_DATABASE, 'false')
  assert.equal(env.PAYLOAD_MIGRATING, 'false')
  assert.equal(env.HEYMORO_DIST_DIR, '.next-local')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.DATABASE_URL, undefined)
})
