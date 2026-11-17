import type { Payload } from 'payload'

import { AdminCommandError } from '../domain/admin.js'

/** Cookie-only Native auth shared by binary endpoints and server actions. Never forwards caller authority. */
export async function requireNativeAdmin({
  headers,
  payload,
}: {
  headers: Pick<Headers, 'get'>
  payload: Pick<Payload, 'auth'>
}) {
  if (headers.get('authorization') !== null) {
    throw new AdminCommandError({ code: 'ADMIN_FORBIDDEN', outcome: 'not_started' })
  }
  const nativeHeaders = new Headers({ DisableAutologin: 'true' })
  for (const name of ['cookie', 'origin', 'sec-fetch-site']) {
    const value = headers.get(name)
    if (value !== null) {
      nativeHeaders.set(name, value)
    }
  }
  const { permissions, user } = await payload.auth({ headers: nativeHeaders })
  if (!user) {
    throw new AdminCommandError({ code: 'ADMIN_UNAUTHORIZED', outcome: 'not_started' })
  }
  if (
    user.collection !== 'admins' ||
    typeof user.id !== 'number' ||
    !Number.isSafeInteger(user.id) ||
    user.id < 1 ||
    user.status !== 'active' ||
    (user.role !== 'admin' && user.role !== 'operator') ||
    permissions?.canAccessAdmin !== true
  ) {
    throw new AdminCommandError({ code: 'ADMIN_FORBIDDEN', outcome: 'not_started' })
  }
  return Object.freeze({ id: user.id, role: user.role, status: 'active' as const })
}
