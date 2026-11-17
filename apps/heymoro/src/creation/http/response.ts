import { IdentityError } from '../domain/identity.js'
import { HttpRequestError } from './request.js'

export function httpResponse({
  data,
  requestId,
  status = 200,
}: {
  data?: unknown
  requestId: string
  status?: number
}): Response {
  const headers = { 'cache-control': 'private, no-store', 'x-request-id': requestId }
  return status === 204
    ? new Response(null, { headers, status })
    : Response.json({ data, requestId }, { headers, status })
}

export function identityErrorResponse({
  error,
  requestId,
}: {
  error: unknown
  requestId: string
}): Response {
  let code = 'INTERNAL_ERROR'
  let message = 'Internal server error.'
  let retryable = false
  let status = 500
  // Class identity and closed code lists both matter. No mutable error status/message is serialized.
  if (error instanceof IdentityError || error instanceof HttpRequestError) {
    const entry =
      error instanceof IdentityError
        ? identityErrors.get(error.code)
        : transportErrors.get(error.code)
    if (entry) {
      code =
        error instanceof HttpRequestError && error.code === 'INPUT_INVALID'
          ? 'AUTH_INPUT_INVALID'
          : error.code
      ;({ message, retryable, status } = entry)
    }
  }
  return httpErrorResponse({ error: { code, message, retryable, status }, requestId })
}

export function notReadyResponse({ requestId }: { requestId: string }): Response {
  return httpErrorResponse({
    error: { code: 'NOT_READY', message: 'Service is not ready.', retryable: false, status: 503 },
    requestId,
  })
}

export type HttpErrorDescriptor = Readonly<{
  code: string
  message: string
  retryable: boolean
  status: number
}>

export function httpErrorResponse({
  error: { code, message, retryable, status },
  requestId,
}: {
  error: HttpErrorDescriptor
  requestId: string
}): Response {
  return Response.json(
    { error: { code, message, retryable }, requestId },
    { headers: { 'cache-control': 'private, no-store', 'x-request-id': requestId }, status },
  )
}

type ErrorEntry = { message: string; retryable: boolean; status: number }
const identityErrors = new Map<string, ErrorEntry>([
  [
    'AUTH_DATA_INTEGRITY_CONFLICT',
    { message: 'Identity data integrity conflict.', retryable: false, status: 503 },
  ],
  ['AUTH_INPUT_INVALID', { message: 'Invalid identity command.', retryable: false, status: 400 }],
  [
    'AUTH_LOGIN_INCOMPLETE',
    { message: 'Login is incomplete. Retry with a new WeChat code.', retryable: true, status: 503 },
  ],
  [
    'AUTH_PROVIDER_UNAVAILABLE',
    {
      message: 'Identity provider is unavailable. Retry with a new WeChat code.',
      retryable: true,
      status: 503,
    },
  ],
  [
    'AUTH_UNAUTHENTICATED',
    { message: 'A valid active session is required.', retryable: false, status: 401 },
  ],
  [
    'AUTH_UNCONFIGURED',
    { message: 'WeChat login is not configured.', retryable: false, status: 503 },
  ],
])
const transportErrors = new Map<string, ErrorEntry>([
  ['HTTP_BODY_TOO_LARGE', { message: 'Request body is too large.', retryable: false, status: 413 }],
  [
    'HTTP_REQUEST_TIMEOUT',
    { message: 'Request body deadline exceeded.', retryable: false, status: 408 },
  ],
  [
    'HTTP_UNSUPPORTED_MEDIA_TYPE',
    { message: 'JSON with UTF-8 encoding is required.', retryable: false, status: 415 },
  ],
  ['INPUT_INVALID', { message: 'Invalid identity command.', retryable: false, status: 400 }],
])
