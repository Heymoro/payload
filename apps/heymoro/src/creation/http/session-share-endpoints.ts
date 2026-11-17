import type { Endpoint, PayloadRequest } from 'payload'

import { AdminCommandError } from '../domain/admin.js'
import { libraryInput } from '../domain/library.js'
import { getCoreRuntime } from '../runtime/services.js'
import { binaryResponse } from './binary-response.js'
import { businessErrorResponse } from './business-errors.js'
import { httpEndpoint } from './endpoint.js'
import { requireNativeAdmin } from './native-admin-auth.js'
import { parsePathId, readQuery } from './query.js'
import { assertEmptyBody, assertNoQuery, readJSONBody } from './request.js'
import { httpErrorResponse, httpResponse } from './response.js'

const admin = async ({ req }: { req: PayloadRequest }) => {
  const principal = await requireNativeAdmin({ headers: req.headers, payload: req.payload })
  if (principal.role !== 'admin') {
    throw new AdminCommandError({ code: 'ADMIN_FORBIDDEN' })
  }
  return principal.id
}
const endpoint = (work: Parameters<typeof httpEndpoint>[0]['work']) =>
  httpEndpoint({
    onError: ({ error, requestId }) =>
      error instanceof AdminCommandError
        ? httpErrorResponse({
            error: {
              code: error.code,
              message: 'Administrator permission is required.',
              retryable: false,
              status: error.status,
            },
            requestId,
          })
        : businessErrorResponse({ error, requestId }),
    work,
  })
export const sessionShareEndpoints: Endpoint[] = [
  {
    handler: endpoint(async ({ req, requestId }) => {
      assertNoQuery({ request: req })
      await assertEmptyBody({ request: req })
      const data = await getCoreRuntime({ payload: req.payload }).sessionShares.get({
        key: typeof req.routeParams?.key === 'string' ? req.routeParams.key : '',
      })
      return httpResponse({ data, requestId })
    }),
    method: 'get',
    path: '/v1/session-shares/:key',
  },
  {
    handler: endpoint(async ({ req, requestId }) => {
      assertNoQuery({ request: req })
      await assertEmptyBody({ request: req })
      const image = await getCoreRuntime({ payload: req.payload }).sessionShares.image({
        artifactId: parsePathId({ value: req.routeParams?.artifactId }),
        key: typeof req.routeParams?.key === 'string' ? req.routeParams.key : '',
      })
      return binaryResponse({ ...image, requestId })
    }),
    method: 'get',
    path: '/v1/session-shares/:key/images/:artifactId',
  },
  {
    handler: endpoint(async ({ req, requestId }) => {
      assertNoQuery({ request: req })
      await assertEmptyBody({ request: req })
      const service = getCoreRuntime({ payload: req.payload }).sessionShares
      const key = typeof req.routeParams?.key === 'string' ? req.routeParams.key : ''
      const view = await service.get({ key })
      const image = await service.image({ artifactId: view.images[0]!.id, key })
      return binaryResponse({ ...image, requestId })
    }),
    method: 'get',
    path: '/v1/session-shares/:key/cover',
  },
  {
    handler: endpoint(async ({ req, requestId }) => {
      const adminId = await admin({ req })
      await assertEmptyBody({ request: req })
      const query = readQuery({ allowedKeys: ['afterId'], integerKeys: ['afterId'], request: req })
      const data = await getCoreRuntime({ payload: req.payload }).sessionShares.list({
        adminId,
        ...(query.afterId === undefined ? {} : { afterId: Number(query.afterId) }),
      })
      return httpResponse({ data, requestId })
    }),
    method: 'get',
    path: '/v1/admin/session-shares',
  },
  {
    handler: endpoint(async ({ req, requestId }) => {
      const adminId = await admin({ req })
      assertNoQuery({ request: req })
      await assertEmptyBody({ request: req })
      const data = await getCoreRuntime({ payload: req.payload }).sessionShares.inspect({
        adminId,
        sessionId: parsePathId({ value: req.routeParams?.sessionId }),
      })
      return httpResponse({ data, requestId })
    }),
    method: 'get',
    path: '/v1/admin/session-shares/:sessionId',
  },
  {
    handler: endpoint(async ({ req, requestId }) => {
      const adminId = await admin({ req })
      assertNoQuery({ request: req })
      const input = libraryInput({
        fields: ['artifactIds', 'title', 'confirmed'],
        value: await readJSONBody({ request: req }),
      })
      const data = await getCoreRuntime({ payload: req.payload }).sessionShares.publish({
        adminId,
        input: { ...input, sessionId: parsePathId({ value: req.routeParams?.sessionId }) },
      })
      return httpResponse({ data, requestId })
    }),
    method: 'post',
    path: '/v1/admin/session-shares/:sessionId',
  },
  {
    handler: endpoint(async ({ req, requestId }) => {
      const adminId = await admin({ req })
      assertNoQuery({ request: req })
      libraryInput({ fields: [], value: await readJSONBody({ request: req }) })
      const data = await getCoreRuntime({ payload: req.payload }).sessionShares.revoke({
        adminId,
        sessionId: parsePathId({ value: req.routeParams?.sessionId }),
      })
      return httpResponse({ data, requestId })
    }),
    method: 'post',
    path: '/v1/admin/session-shares/:sessionId/revoke',
  },
  {
    handler: endpoint(async ({ req, requestId }) => {
      const adminId = await admin({ req })
      assertNoQuery({ request: req })
      await assertEmptyBody({ request: req })
      const image = await getCoreRuntime({ payload: req.payload }).sessionShares.previewImage({
        adminId,
        artifactId: parsePathId({ value: req.routeParams?.artifactId }),
        sessionId: parsePathId({ value: req.routeParams?.sessionId }),
      })
      if ((await admin({ req })) !== adminId) {
        throw new AdminCommandError({ code: 'ADMIN_FORBIDDEN' })
      }
      return binaryResponse({ ...image, requestId })
    }),
    method: 'get',
    path: '/v1/admin/session-shares/:sessionId/images/:artifactId',
  },
]
