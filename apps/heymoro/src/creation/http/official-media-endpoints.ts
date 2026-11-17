import type { Endpoint } from 'payload'

import { AdminCommandError } from '../domain/admin.js'
import { getCoreRuntime } from '../runtime/services.js'
import { businessErrorResponse } from './business-errors.js'
import { httpEndpoint } from './endpoint.js'
import { readMultipartFile } from './multipart.js'
import { requireNativeAdmin } from './native-admin-auth.js'
import { assertNoQuery, HttpRequestError } from './request.js'
import { httpErrorResponse, httpResponse } from './response.js'

export function createOfficialMediaEndpoints({
  fileMaxBytes,
}: {
  fileMaxBytes: number
}): Endpoint[] {
  if (
    !Number.isSafeInteger(fileMaxBytes) ||
    fileMaxBytes <= 0 ||
    fileMaxBytes > Number.MAX_SAFE_INTEGER - 16384
  ) {
    throw new RangeError('Explicit official file budget required.')
  }
  return [
    {
      handler: httpEndpoint({
        onError: ({ error, requestId }) => {
          if (error instanceof AdminCommandError) {
            const entry = adminErrors.get(error.code)
            if (entry) {
              return httpErrorResponse({
                error: { ...entry, code: error.code, retryable: false },
                requestId,
              })
            }
          }
          return businessErrorResponse({ error, requestId })
        },
        work: async ({ req, requestId }) => {
          const admin = await requireNativeAdmin({ headers: req.headers, payload: req.payload })
          assertNoQuery({ request: req })
          if (
            req.method?.toUpperCase() !== 'POST' ||
            req.headers.get('x-payload-http-method-override') !== null ||
            req.headers.get('x-http-method-override') !== null ||
            req.headers.get('x-method-override') !== null
          ) {
            throw new HttpRequestError({ code: 'INPUT_INVALID' })
          }
          const input = await readMultipartFile({ fileMaxBytes, request: req, timeoutMs: 30000 })
          const data = await getCoreRuntime({ payload: req.payload }).officialMedia.upload({
            ...input,
            adminId: admin.id,
          })
          return httpResponse({ data, requestId, status: 201 })
        },
      }),
      method: 'post',
      path: '/v1/admin/media/examples',
    },
  ]
}
const adminErrors = new Map([
  ['ADMIN_DATA_INTEGRITY', { message: 'Administrator data integrity check failed.', status: 503 }],
  ['ADMIN_FAILED', { message: 'Administrator command failed.', status: 503 }],
  ['ADMIN_FORBIDDEN', { message: 'An active administrator is required.', status: 403 }],
  [
    'ADMIN_OUTCOME_UNKNOWN',
    { message: 'Administrator transaction outcome is unknown.', status: 503 },
  ],
  [
    'ADMIN_UNAUTHORIZED',
    { message: 'Native administrator authentication is required.', status: 401 },
  ],
])
