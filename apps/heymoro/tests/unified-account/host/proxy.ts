import { type NextRequest, NextResponse } from 'next/server'

import { unifiedIngressError } from '../../../src/auth-unified-context'

export function proxy(request: NextRequest) {
  const error = unifiedIngressError({
    headers: request.headers,
    pathname: request.nextUrl.pathname,
  })
  return error
    ? NextResponse.json({ error }, { status: error === 'BOOTSTRAP_CLOSED' ? 403 : 401 })
    : NextResponse.next()
}
export const config = { matcher: ['/admin/:path*', '/api/:path*'] }
