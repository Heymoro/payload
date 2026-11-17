import assert from 'node:assert/strict'
import test from 'node:test'
import { readRuntimeConfig } from '../src/runtime.ts'

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: 'file:./isolated-test.sqlite',
  PAYLOAD_SECRET: 'unit-test-only-secret-not-for-runtime',
  UPLOAD_DIR: '/tmp/heymoro-unit-uploads',
  PUBLIC_API_URL: 'http://localhost:3001/',
  WECHAT_AUTH_PROVIDER: 'mock',
}

test('dev mock needs no WeChat account and normalizes the API URL', () => {
  const config = readRuntimeConfig(env)
  assert.equal(config.wechatAuthProvider, 'mock')
  assert.equal(config.publicApiUrl, 'http://localhost:3001')
})
test('production rejects mock identity', () => {
  assert.throws(() => readRuntimeConfig({ ...env, NODE_ENV: 'production' }), /mock is not allowed/)
})
test('database and secret are required', () => {
  for (const name of ['DATABASE_URL', 'PAYLOAD_SECRET']) {
    assert.throws(
      () => readRuntimeConfig({ ...env, [name]: '' }),
      new RegExp(`${name} is required`),
    )
  }
})
