import type { Endpoint } from 'payload'

import { getCoreRuntime } from '../runtime/services.js'
import { httpEndpoint } from './endpoint.js'
import { parsePathId, readQuery } from './query.js'
import { assertEmptyBody, assertNoQuery } from './request.js'
import { httpResponse } from './response.js'

export const catalogEndpoints: Endpoint[] = [
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        const query = readQuery({
          allowedKeys: ['categoryId', 'keyword', 'cursor'],
          integerKeys: ['categoryId'],
          request: req,
        })
        await assertEmptyBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).catalog.list({ query })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: '/v1/templates',
  },
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        assertNoQuery({ request: req })
        await assertEmptyBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).catalog.getTaxonomy()
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: '/v1/template-taxonomies',
  },
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        assertNoQuery({ request: req })
        const templateId = parsePathId({ value: req.routeParams?.templateId })
        await assertEmptyBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).catalog.get({
          templateId,
        })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: '/v1/templates/:templateId',
  },
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        assertNoQuery({ request: req })
        await assertEmptyBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).catalog.getFreePreset()
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: '/v1/creation-presets/free',
  },
]
