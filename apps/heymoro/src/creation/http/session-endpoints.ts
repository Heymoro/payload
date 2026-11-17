import type { Endpoint } from 'payload'

import { getCoreRuntime } from '../runtime/services.js'
import { httpEndpoint, requireUserId } from './endpoint.js'
import { parsePathId, readQuery } from './query.js'
import { assertEmptyBody, assertNoQuery, CREATION_JSON_MAX_BYTES, readJSONBody } from './request.js'
import { httpResponse } from './response.js'
import { sessionDTO } from './session-dto.js'

export const sessionEndpoints: Endpoint[] = [
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        assertNoQuery({ request: req })
        const command = await readJSONBody({ request: req })
        const userId = await requireUserId({ req })
        const { isNew, session } = await getCoreRuntime({ payload: req.payload }).session({
          command,
          userId,
        })
        return httpResponse({ data: sessionDTO({ session }), requestId, status: isNew ? 201 : 200 })
      },
    }),
    method: 'post',
    path: '/v1/creation-sessions',
  },
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        const query = readQuery({ allowedKeys: ['cursor'], request: req })
        await assertEmptyBody({ request: req })
        const userId = await requireUserId({ req })
        const data = await getCoreRuntime({ payload: req.payload }).sessions.list({ query, userId })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: '/v1/creation-sessions',
  },
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        assertNoQuery({ request: req })
        const sessionId = parsePathId({ value: req.routeParams?.sessionId })
        await assertEmptyBody({ request: req })
        const userId = await requireUserId({ req })
        const data = await getCoreRuntime({ payload: req.payload }).sessions.get({
          sessionId,
          userId,
        })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: '/v1/creation-sessions/:sessionId',
  },
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        assertNoQuery({ request: req })
        const sessionId = parsePathId({ value: req.routeParams?.sessionId })
        const command = await readJSONBody({ request: req })
        const userId = await requireUserId({ req })
        const data = await getCoreRuntime({ payload: req.payload }).title({
          command,
          sessionId,
          userId,
        })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'patch',
    path: '/v1/creation-sessions/:sessionId',
  },
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        assertNoQuery({ request: req })
        const sessionId = parsePathId({ value: req.routeParams?.sessionId })
        await assertEmptyBody({ request: req })
        const userId = await requireUserId({ req })
        const data = await getCoreRuntime({ payload: req.payload }).draft.get({ sessionId, userId })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: '/v1/creation-sessions/:sessionId/draft',
  },
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        assertNoQuery({ request: req })
        const sessionId = parsePathId({ value: req.routeParams?.sessionId })
        const input = await readJSONBody({ maxBytes: CREATION_JSON_MAX_BYTES, request: req })
        const userId = await requireUserId({ req })
        const data = await getCoreRuntime({ payload: req.payload }).draft.save({
          input,
          sessionId,
          userId,
        })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'put',
    path: '/v1/creation-sessions/:sessionId/draft',
  },
]
