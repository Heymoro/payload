import type { PayloadRequest } from 'payload'

export type AuditLogInput = {
  action: string
  afterState?: Record<string, unknown>
  beforeState?: Record<string, unknown>
  req: PayloadRequest
  resourceId?: string
  resourceType: string
  result?: 'success'
  summary?: Record<string, unknown>
}

function boundedHeader(req: PayloadRequest, name: string, limit: number): string | undefined {
  const value = req.headers.get(name)?.trim()
  return value ? value.slice(0, limit) : undefined
}

export async function writeAuditLog(input: AuditLogInput): Promise<void> {
  const principal = input.req.user
  const actorType =
    principal?.collection === 'admins'
      ? 'admin'
      : principal?.collection === 'users'
        ? 'user'
        : 'system'
  const actorId = principal ? String(principal.id) : undefined
  const requestId = input.req.headers.get('x-request-id') || 'internal'
  const forwardedFor = boundedHeader(input.req, 'x-forwarded-for', 128)
  const ipAddress = (
    forwardedFor?.split(',')[0]?.trim() || boundedHeader(input.req, 'x-real-ip', 128)
  )?.slice(0, 128)
  const actorIssuer = boundedHeader(input.req, 'x-platform-admin-issuer', 128)
  const actorSubject = boundedHeader(input.req, 'x-platform-admin-subject', 512)

  await input.req.payload.create({
    collection: 'auditLogs',
    data: {
      action: input.action,
      actorId,
      actorIssuer,
      actorSubject,
      actorType,
      afterState: input.afterState,
      beforeState: input.beforeState,
      correlationId: requestId,
      ipAddress,
      requestId,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      result: input.result || 'success',
      summary: input.summary,
      userAgent: boundedHeader(input.req, 'user-agent', 512),
    },
    overrideAccess: true,
    req: input.req,
  })
}
