import type { Endpoint } from 'payload'

import { getCoreRuntime } from '../runtime/services.js'
import { httpEndpoint, requireUserId } from './endpoint.js'
import { parsePathId, readQuery } from './query.js'
import { assertEmptyBody, assertNoQuery } from './request.js'
import { httpResponse } from './response.js'

export const libraryEndpoints: Endpoint[] = [
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        const userId = await requireUserId({ req })
        const query = readQuery({ allowedKeys: ['saved', 'cursor'], request: req })
        await assertEmptyBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).library.list({ query, userId })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: '/v1/artifacts',
  },
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        const userId = await requireUserId({ req })
        assertNoQuery({ request: req })
        const artifactId = parsePathId({ value: req.routeParams?.artifactId })
        await assertEmptyBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).library.get({
          artifactId,
          userId,
        })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: '/v1/artifacts/:artifactId',
  },
  ...(['put', 'delete'] as const).map((method): Endpoint => ({
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        const userId = await requireUserId({ req })
        assertNoQuery({ request: req })
        const artifactId = parsePathId({ value: req.routeParams?.artifactId })
        await assertEmptyBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).favorite.set({
          artifactId,
          isFavorite: method === 'put',
          userId,
        })
        return httpResponse({ data, requestId })
      },
    }),
    method,
    path: '/v1/artifacts/:artifactId/favorite',
  })),
]
