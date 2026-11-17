import test from 'node:test'
import assert from 'node:assert/strict'
import { unifiedContext, unifiedIngressError } from '../src/auth-unified-context.ts'
const account = {
  id: 7,
  collection: 'users',
  status: 'active',
  managementRole: 'admin',
  managementCredentialsEnabled: true,
}
test('one account has client or management capabilities according to its verified session', () => {
  assert.equal(
    unifiedContext({
      user: { ...account, _strategy: 'user-session', _sessionAudience: 'client' },
      headers: new Headers({ Authorization: 'Bearer opaque' }),
    }),
    'client',
  )
  assert.equal(
    unifiedContext({
      user: { ...account, _strategy: 'local-jwt' },
      headers: new Headers({ Authorization: 'JWT signed' }),
    }),
    'management',
  )
  assert.equal(
    unifiedContext({
      user: { ...account, _strategy: 'user-session' },
      headers: new Headers({ Authorization: 'Bearer opaque' }),
    }),
    null,
  )
})
test('mixed or management Bearer credentials fail before authentication fallback', () => {
  for (const bearer of ['opaque', 'expired', 'revoked', 'invalid']) {
    const headers = new Headers({
      Authorization: `Bearer ${bearer}`,
      Cookie: 'unified-spike-token=valid-cookie',
    })
    for (const pathname of ['/admin', '/api/graphql', '/api/users', '/api/v1/me']) {
      assert.equal(unifiedIngressError({ pathname, headers }), 'AMBIGUOUS_CREDENTIALS')
    }
  }
  assert.equal(
    unifiedIngressError({ pathname: '/api/users/first-register', headers: new Headers() }),
    'BOOTSTRAP_CLOSED',
  )
  assert.equal(
    unifiedContext({
      user: { ...account, _strategy: 'local-jwt', status: 'disabled' },
      headers: new Headers(),
    }),
    null,
  )
})
