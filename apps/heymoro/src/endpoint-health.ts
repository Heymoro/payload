import type { Endpoint } from 'payload'

import { createRequestId } from './creation/domain/request-id.js'
import { httpResponse, notReadyResponse } from './creation/http/response.js'

export const healthEndpoints: Endpoint[] = [
  {
    handler: async (req) => {
      const requestId = createRequestId()
      try {
        await req.payload.find({
          collection: 'admins',
          depth: 0,
          limit: 1,
          overrideAccess: true,
          req,
        })
        return httpResponse({ data: { database: 'ok', status: 'ready' }, requestId })
      } catch {
        return notReadyResponse({ requestId })
      }
    },
    method: 'get',
    path: '/v1/health/ready',
  },
]
