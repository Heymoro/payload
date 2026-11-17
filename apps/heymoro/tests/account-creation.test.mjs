import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountForIdentity } from '../src/service-accounts.ts'
function fixture(disableLocalStrategy) {
  return {
    collections: { users: { config: { auth: { disableLocalStrategy } } } },
    create: async (args) => args,
  }
}
test('legacy custom-only account creation remains unchanged', async () => {
  const result = await createAccountForIdentity({
    payload: fixture(true),
    identity: { displayName: 'Existing path', avatarUrl: null },
  })
  assert.deepEqual(result.data, { displayName: 'Existing path', avatarUrl: null, status: 'active' })
  assert.equal(result.overrideAccess, true)
})
test('native-compatible verified creation uses unique internal credentials without management grant', async () => {
  const payload = fixture(false)
  const first = await createAccountForIdentity({ payload, identity: {} })
  const second = await createAccountForIdentity({ payload, identity: {} })
  assert.ok(first.data.username.startsWith('uid_'))
  assert.ok(first.data.password.length >= 64)
  assert.notEqual(first.data.username, second.data.username)
  assert.notEqual(first.data.password, second.data.password)
  assert.equal(first.data.managementRole, 'none')
  assert.equal(first.data.managementCredentialsEnabled, false)
  assert.equal(first.data.email, undefined)
})
