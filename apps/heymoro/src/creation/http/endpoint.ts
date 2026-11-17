import type { Endpoint, PayloadRequest } from 'payload'

import { GenerationError } from '../domain/generation.js'
import { IdentityError } from '../domain/identity.js'
import { createRequestId } from '../domain/request-id.js'
import { getCoreRuntime } from '../runtime/services.js'
import { businessErrorResponse } from './business-errors.js'

export function httpEndpoint({
  onError = businessErrorResponse,
  work,
}: {
  onError?: (args: { error: unknown; requestId: string }) => Response
  work: (args: { req: PayloadRequest; requestId: string }) => Promise<Response>
}): Endpoint['handler'] {
  return async (req) => {
    const requestId = createRequestId()
    try {
      return await work({ req, requestId })
    } catch (error) {
      return onError({ error, requestId })
    }
  }
}

export async function requireUserId({ req }: { req: PayloadRequest }): Promise<number> {
  let identity
  try {
    identity = await getCoreRuntime({ payload: req.payload }).identity.authenticate({
      authorization: req.headers.get('authorization'),
    })
  } catch (error) {
    if (error instanceof IdentityError && error.code === 'AUTH_DATA_INTEGRITY_CONFLICT') {
      throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
    }
    throw error
  }
  if (!identity) {
    throw new GenerationError({ code: 'UNAUTHENTICATED' })
  }
  return identity.id
}
