import type { PayloadRequest } from 'payload'

import { randomBytes } from 'node:crypto'

// Called only after the identity provider has verified the identity.
// The existing custom-only configuration deliberately follows the old input shape.
export async function createAccountForIdentity({
  identity,
  payload,
  req,
}: {
  identity: { avatarUrl?: null | string; displayName?: string }
  payload: PayloadRequest['payload']
  req?: PayloadRequest
}) {
  const nativeEnabled = !payload.collections.users.config.auth.disableLocalStrategy
  const data = {
    avatarUrl: identity.avatarUrl,
    displayName: identity.displayName || '微信用户',
    status: 'active' as const,
    ...(nativeEnabled
      ? {
          managementCredentialsEnabled: false,
          managementRole: 'none',
          password: randomBytes(48).toString('base64url'),
          username: `uid_${randomBytes(16).toString('hex')}`,
        }
      : {}),
  }
  return payload.create({ collection: 'users', data, overrideAccess: true, req })
}
