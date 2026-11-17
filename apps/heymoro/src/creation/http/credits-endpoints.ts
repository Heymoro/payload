import type { Endpoint } from 'payload'

import { getCoreRuntime } from '../runtime/services.js'
import { httpEndpoint, requireUserId } from './endpoint.js'
import { readQuery } from './query.js'
import { assertEmptyBody, assertNoQuery } from './request.js'
import { httpResponse } from './response.js'

export const creditsEndpoints: Endpoint[] = [
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        const userId = await requireUserId({ req })
        assertNoQuery({ request: req })
        await assertEmptyBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).credits.account({ userId })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: '/v1/creation-account',
  },
  ...(['reservations', 'ledger'] as const).map((purpose): Endpoint => ({
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        const userId = await requireUserId({ req })
        const query = readQuery({ allowedKeys: ['cursor'], request: req })
        await assertEmptyBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).credits[purpose]({
          query,
          userId,
        })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: `/v1/credits/${purpose}`,
  })),
]
