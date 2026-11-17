// Target-model policy used by the isolated spike. Existing runtime remains unchanged.
type Candidate = {
  _sessionAudience?: string
  _strategy?: string
  collection?: string
  managementCredentialsEnabled?: boolean
  managementRole?: string
  status?: string
}

function bearer(headers: Headers): boolean {
  return /^Bearer(?:\s|$)/i.test(headers.get('authorization') || '')
}
function managementCookie(headers: Headers, cookieName: string): boolean {
  return (headers.get('cookie') || '')
    .split(';')
    .some((cookie) => cookie.trim().split('=')[0] === cookieName)
}
export function unifiedContext({
  cookieName = 'unified-spike-token',
  headers,
  user,
}: {
  cookieName?: string
  headers: Headers
  user: Candidate | null | undefined
}): 'client' | 'management' | null {
  if (user?.collection !== 'users' || user.status !== 'active') {
    return null
  }
  if (bearer(headers) && managementCookie(headers, cookieName)) {
    return null
  }
  if (user._strategy === 'user-session' && user._sessionAudience === 'client' && bearer(headers)) {
    return 'client'
  }
  if (
    !bearer(headers) &&
    user._strategy === 'local-jwt' &&
    user.managementCredentialsEnabled &&
    ['admin', 'operator'].includes(user.managementRole || '')
  ) {
    return 'management'
  }
  return null
}

export function unifiedIngressError({
  cookieName = 'unified-spike-token',
  headers,
  pathname,
}: {
  cookieName?: string
  headers: Headers
  pathname: string
}): null | string {
  let path: string
  try {
    path = decodeURIComponent(pathname).replace(/\/+$/, '') || '/'
  } catch {
    return 'INVALID_PATH'
  }
  if (path === '/api/users/first-register') {
    return 'BOOTSTRAP_CLOSED'
  }
  if (bearer(headers) && managementCookie(headers, cookieName)) {
    return 'AMBIGUOUS_CREDENTIALS'
  }
  const publicEndpoint = [
    '/api/users/login',
    '/api/v1/auth/wechat',
    '/api/v1/health/ready',
  ].includes(path)
  const clientEndpoint =
    /^\/api\/v1\/(?:me|records|media|auth\/logout)(?:\/|$)/.test(path) &&
    path !== '/api/v1/media/cleanup'
  const protectedEntry = path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/')
  if (protectedEntry && !publicEndpoint && !clientEndpoint && bearer(headers)) {
    return 'CLIENT_SESSION_FORBIDDEN'
  }
  if (clientEndpoint && !bearer(headers)) {
    return 'CLIENT_SESSION_REQUIRED'
  }
  return null
}
