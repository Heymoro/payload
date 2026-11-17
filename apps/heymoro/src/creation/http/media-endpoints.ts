import type { Endpoint } from 'payload'

import { GenerationError } from '../domain/generation.js'
import { getCoreRuntime } from '../runtime/services.js'
import { binaryResponse } from './binary-response.js'
import { httpEndpoint, requireUserId } from './endpoint.js'
import { readMultipartFile } from './multipart.js'
import { parsePathId } from './query.js'
import { assertEmptyBody, assertNoQuery, HttpRequestError } from './request.js'
import { httpResponse } from './response.js'

export function createMediaEndpoints({
  canUploadReferences,
  fileMaxBytes,
}: {
  canUploadReferences: boolean
  fileMaxBytes: number
}): Endpoint[] {
  if (!Number.isSafeInteger(fileMaxBytes) || fileMaxBytes <= 0) {
    throw new RangeError('An explicit positive file budget is required.')
  }
  return [
    {
      handler: httpEndpoint({
        work: async ({ req, requestId }) => {
          const userId = await requireUserId({ req })
          if (!canUploadReferences) {
            throw new HttpRequestError({ code: 'INPUT_INVALID' })
          }
          assertNoQuery({ request: req })
          const input = await readMultipartFile({ fileMaxBytes, request: req })
          const data = await getCoreRuntime({ payload: req.payload }).media.uploadForUser({
            ...input,
            userId,
          })
          return httpResponse({ data, requestId, status: 201 })
        },
      }),
      method: 'post',
      path: '/v1/media',
    },
    {
      handler: httpEndpoint({
        work: async ({ req, requestId }) => {
          const userId = await requireUserId({ req })
          assertNoQuery({ request: req })
          const mediaId = parsePathId({ value: req.routeParams?.mediaId })
          await assertEmptyBody({ request: req })
          const image = await getCoreRuntime({ payload: req.payload }).media.readForUser({
            mediaId,
            userId,
          })
          if ((await requireUserId({ req })) !== userId) {
            throw new GenerationError({ code: 'UNAUTHENTICATED' })
          }
          return binaryResponse({ ...image, requestId })
        },
      }),
      method: 'get',
      path: '/v1/media/:mediaId/content',
    },
    {
      handler: httpEndpoint({
        work: async ({ req, requestId }) => {
          assertNoQuery({ request: req })
          const mediaId = parsePathId({ value: req.routeParams?.mediaId })
          await assertEmptyBody({ request: req })
          const image = await getCoreRuntime({ payload: req.payload }).media.readOfficialExample({
            mediaId,
          })
          return binaryResponse({ ...image, requestId })
        },
      }),
      method: 'get',
      path: '/v1/media/examples/:mediaId/content',
    },
  ]
}
