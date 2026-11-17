import type { HttpErrorDescriptor } from './response.js'

import { DraftError } from '../application/draft.js'
import { MediaError } from '../application/media.js'
import { CreditsError } from '../domain/credits.js'
import { GenerationError } from '../domain/generation.js'
import { CreationInputError } from '../domain/input.js'
import { MediaStorageError } from '../domain/media.js'
import { SessionError } from '../domain/session.js'
import { CatalogError } from '../domain/template-config.js'
import { CreationTransactionError } from '../infrastructure/payload/sqlite-unit-of-work.js'
import { RedisCoordinationError } from '../infrastructure/redis/coordinator.js'
import { HttpRequestError } from './request.js'
import { httpErrorResponse } from './response.js'

export function businessErrorResponse({
  error,
  requestId,
}: {
  error: unknown
  requestId: string
}): Response {
  let descriptor: HttpErrorDescriptor | undefined
  if (error instanceof CreationTransactionError) {
    descriptor = errors.get('OPERATION_OUTCOME_UNKNOWN')
  } else if (error instanceof MediaStorageError) {
    const code = storageCodes.get(error.code)
    descriptor = code ? errors.get(code) : undefined
  } else if (
    (error instanceof MediaError && mediaCodes.has(error.code)) ||
    (error instanceof CreditsError && creditCodes.has(error.code)) ||
    (error instanceof CatalogError && catalogCodes.has(error.code)) ||
    (error instanceof SessionError && sessionCodes.has(error.code)) ||
    (error instanceof DraftError && draftCodes.has(error.code)) ||
    (error instanceof CreationInputError && inputCodes.has(error.code)) ||
    (error instanceof GenerationError && generationCodes.has(error.code)) ||
    (error instanceof RedisCoordinationError && coordinationCodes.has(error.code)) ||
    (error instanceof HttpRequestError && transportCodes.has(error.code))
  ) {
    descriptor = errors.get(error.code)
  }
  return httpErrorResponse({ error: descriptor ?? internalError, requestId })
}

const mediaCodes = new Set([
  'DATA_INTEGRITY_CONFLICT',
  'INVALID_MEDIA',
  'NOT_FOUND',
  'UNAUTHENTICATED',
])
const creditCodes = new Set(['DATA_INTEGRITY_CONFLICT', 'INPUT_INVALID', 'UNAUTHENTICATED'])
const storageCodes = new Map<string, string>([
  ['CONTENT_CONFLICT', 'DATA_INTEGRITY_CONFLICT'],
  ['FORBIDDEN', 'MEDIA_STORAGE_UNAVAILABLE'],
  ['INVALID_REF', 'DATA_INTEGRITY_CONFLICT'],
  ['NOT_FOUND', 'NOT_FOUND'],
  ['UNKNOWN', 'MEDIA_STORAGE_UNAVAILABLE'],
  ['UNSAFE_BACKEND', 'DATA_INTEGRITY_CONFLICT'],
  ['UNVERIFIED_BACKEND', 'DATA_INTEGRITY_CONFLICT'],
])
const catalogCodes = new Set(['DATA_INTEGRITY_CONFLICT', 'INPUT_INVALID', 'TEMPLATE_UNAVAILABLE'])
const sessionCodes = new Set([
  'IDEMPOTENCY_CONFLICT',
  'SESSION_UNAVAILABLE',
  'UNAUTHENTICATED',
  ...catalogCodes,
])
const draftCodes = new Set([
  'DATA_INTEGRITY_CONFLICT',
  'NOT_FOUND',
  'TEMPLATE_UNAVAILABLE',
  'UNAUTHENTICATED',
])
const inputCodes = new Set(['DESCRIPTION_REQUIRED', 'INPUT_INVALID'])
const generationCodes = new Set([
  'CREDITS_INSUFFICIENT',
  'DATA_INTEGRITY_CONFLICT',
  'GENERATION_IN_PROGRESS',
  'GENERATION_NOT_CONFIGURED',
  'IDEMPOTENCY_CONFLICT',
  'INPUT_INVALID',
  'NOT_FOUND',
  'QUOTE_CHANGED',
  'QUOTE_EXPIRED',
  'TEMPLATE_UNAVAILABLE',
  'UNAUTHENTICATED',
])
const coordinationCodes = new Set(['COORDINATION_UNAVAILABLE', 'RESOURCE_BUSY'])
const transportCodes = new Set([
  'HTTP_BODY_TOO_LARGE',
  'HTTP_REQUEST_TIMEOUT',
  'HTTP_UNSUPPORTED_MEDIA_TYPE',
  'INPUT_INVALID',
])
const internalError: HttpErrorDescriptor = {
  code: 'INTERNAL_ERROR',
  message: 'Internal server error.',
  retryable: false,
  status: 500,
}
const errors = new Map<string, HttpErrorDescriptor>([
  [
    'COORDINATION_UNAVAILABLE',
    {
      code: 'COORDINATION_UNAVAILABLE',
      message: 'Creation coordination is unavailable.',
      retryable: false,
      status: 503,
    },
  ],
  [
    'CREDITS_INSUFFICIENT',
    {
      code: 'CREDITS_INSUFFICIENT',
      message: 'Insufficient creation credits.',
      retryable: false,
      status: 402,
    },
  ],
  [
    'DATA_INTEGRITY_CONFLICT',
    {
      code: 'DATA_INTEGRITY_CONFLICT',
      message: 'Data integrity conflict.',
      retryable: false,
      status: 503,
    },
  ],
  [
    'DESCRIPTION_REQUIRED',
    {
      code: 'DESCRIPTION_REQUIRED',
      message: 'A description is required.',
      retryable: false,
      status: 400,
    },
  ],
  [
    'GENERATION_IN_PROGRESS',
    {
      code: 'GENERATION_IN_PROGRESS',
      message: 'A generation is already in progress.',
      retryable: false,
      status: 409,
    },
  ],
  [
    'GENERATION_NOT_CONFIGURED',
    {
      code: 'GENERATION_NOT_CONFIGURED',
      message: 'Generation is not configured.',
      retryable: false,
      status: 503,
    },
  ],
  [
    'HTTP_BODY_TOO_LARGE',
    {
      code: 'HTTP_BODY_TOO_LARGE',
      message: 'Request body is too large.',
      retryable: false,
      status: 413,
    },
  ],
  [
    'HTTP_REQUEST_TIMEOUT',
    {
      code: 'HTTP_REQUEST_TIMEOUT',
      message: 'Request body deadline exceeded.',
      retryable: false,
      status: 408,
    },
  ],
  [
    'HTTP_UNSUPPORTED_MEDIA_TYPE',
    {
      code: 'HTTP_UNSUPPORTED_MEDIA_TYPE',
      message: 'Unsupported request media type.',
      retryable: false,
      status: 415,
    },
  ],
  [
    'IDEMPOTENCY_CONFLICT',
    {
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Request identity conflicts with the existing command.',
      retryable: false,
      status: 409,
    },
  ],
  [
    'INPUT_INVALID',
    { code: 'INPUT_INVALID', message: 'Invalid request input.', retryable: false, status: 400 },
  ],
  [
    'INVALID_MEDIA',
    { code: 'INVALID_MEDIA', message: 'Invalid image upload.', retryable: false, status: 400 },
  ],
  [
    'MEDIA_STORAGE_UNAVAILABLE',
    {
      code: 'MEDIA_STORAGE_UNAVAILABLE',
      message: 'Media storage is unavailable.',
      retryable: false,
      status: 503,
    },
  ],
  [
    'NOT_FOUND',
    { code: 'NOT_FOUND', message: 'Resource not found.', retryable: false, status: 404 },
  ],
  [
    'OPERATION_OUTCOME_UNKNOWN',
    {
      code: 'OPERATION_OUTCOME_UNKNOWN',
      message: 'Operation outcome is unknown. Do not automatically retry.',
      retryable: false,
      status: 503,
    },
  ],
  [
    'QUOTE_CHANGED',
    {
      code: 'QUOTE_CHANGED',
      message: 'Generation quote has changed.',
      retryable: false,
      status: 409,
    },
  ],
  [
    'QUOTE_EXPIRED',
    {
      code: 'QUOTE_EXPIRED',
      message: 'Generation quote has expired.',
      retryable: false,
      status: 409,
    },
  ],
  [
    'RESOURCE_BUSY',
    { code: 'RESOURCE_BUSY', message: 'Creation resource is busy.', retryable: false, status: 409 },
  ],
  [
    'SESSION_UNAVAILABLE',
    {
      code: 'SESSION_UNAVAILABLE',
      message: 'Session is unavailable.',
      retryable: false,
      status: 409,
    },
  ],
  [
    'TEMPLATE_UNAVAILABLE',
    {
      code: 'TEMPLATE_UNAVAILABLE',
      message: 'Template is unavailable.',
      retryable: false,
      status: 409,
    },
  ],
  [
    'UNAUTHENTICATED',
    {
      code: 'UNAUTHENTICATED',
      message: 'An active authenticated account is required.',
      retryable: false,
      status: 401,
    },
  ],
])
