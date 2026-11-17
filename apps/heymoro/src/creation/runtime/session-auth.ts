import type { AuthStrategyFunction } from 'payload'

import { createPayloadIdentityAuthentication } from '../infrastructure/payload/identity-repository.js'

/** Native auth delegates to the same read-only credential path as formal identity.authenticate. */
export function createSessionAuthentication({
  clock,
}: {
  clock: () => string
}): AuthStrategyFunction {
  return createPayloadIdentityAuthentication({ clock })
}
