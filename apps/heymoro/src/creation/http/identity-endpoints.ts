import type { Endpoint, PayloadRequest } from 'payload'

import { IdentityError, parseBearer } from '../domain/identity.js'
import { getCoreRuntime } from '../runtime/services.js'
import { httpEndpoint } from './endpoint.js'
import { assertEmptyBody, assertNoQuery, readJSONBody } from './request.js'
import { httpResponse, identityErrorResponse } from './response.js'

export const identityEndpoints: Endpoint[] = [
  {
    handler: endpoint({
      work: async ({ req, requestId }) => {
        const input = await readJSONBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).identity.login({
          input,
          requestId,
        })
        return httpResponse({ data, requestId, status: 201 })
      },
    }),
    method: 'post',
    path: '/v1/auth/wechat',
  },
  {
    handler: endpoint({
      work: async ({ req, requestId }) => {
        await assertEmptyBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).identity.getMe({
          authorization: req.headers.get('authorization'),
        })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: '/v1/me',
  },
  {
    handler: endpoint({
      work: async ({ req, requestId }) => {
        const input = await readJSONBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).identity.updateProfile({
          authorization: req.headers.get('authorization'),
          input,
          requestId,
        })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'patch',
    path: '/v1/me',
  },
  {
    handler: endpoint({
      work: async ({ req, requestId }) => {
        await assertEmptyBody({ request: req })
        const authorization = req.headers.get('authorization')
        if (authorization !== null && !parseBearer({ authorization })) {
          throw new IdentityError({ code: 'AUTH_INPUT_INVALID' })
        }
        await getCoreRuntime({ payload: req.payload }).identity.logout({ authorization, requestId })
        return httpResponse({ requestId, status: 204 })
      },
    }),
    method: 'post',
    path: '/v1/auth/logout',
  },
]

function endpoint({
  work,
}: {
  work: (args: { req: PayloadRequest; requestId: string }) => Promise<Response>
}): Endpoint['handler'] {
  return httpEndpoint({
    onError: identityErrorResponse,
    work: (args) => {
      assertNoQuery({ request: args.req })
      return work(args)
    },
  })
}
