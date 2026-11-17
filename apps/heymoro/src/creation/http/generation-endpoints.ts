import type { Endpoint } from 'payload'

import { getCoreRuntime } from '../runtime/services.js'
import { httpEndpoint, requireUserId } from './endpoint.js'
import { parseGenerationQuote, parseGenerationSubmission } from './generation-command.js'
import { parsePathId, readQuery } from './query.js'
import { assertEmptyBody, assertNoQuery, CREATION_JSON_MAX_BYTES, readJSONBody } from './request.js'
import { httpResponse } from './response.js'

export const generationEndpoints: Endpoint[] = [
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        const userId = await requireUserId({ req })
        assertNoQuery({ request: req })
        const command = parseGenerationQuote({
          value: await readJSONBody({ maxBytes: CREATION_JSON_MAX_BYTES, request: req }),
        })
        const { admission } = getCoreRuntime({ payload: req.payload })
        const data =
          command.operation === 'generate'
            ? await admission.quoteGenerate({
                input: command.input,
                sessionId: command.sessionId,
                userId,
              })
            : await admission.quoteRegeneration({
                sourceArtifactId: command.sourceArtifactId,
                userId,
              })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'post',
    path: '/v1/generation-quotes',
  },
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        const userId = await requireUserId({ req })
        assertNoQuery({ request: req })
        const command = parseGenerationSubmission({
          operation: 'generate',
          value: await readJSONBody({ maxBytes: CREATION_JSON_MAX_BYTES, request: req }),
        })
        const { isNew, task } = await getCoreRuntime({
          payload: req.payload,
        }).admission.submitGenerate({ ...command, userId })
        return httpResponse({ data: task, requestId, status: isNew ? 201 : 200 })
      },
    }),
    method: 'post',
    path: '/v1/generations',
  },
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        const userId = await requireUserId({ req })
        assertNoQuery({ request: req })
        const sourceArtifactId = parsePathId({ value: req.routeParams?.artifactId })
        const command = parseGenerationSubmission({
          operation: 'regenerate',
          value: await readJSONBody({ maxBytes: CREATION_JSON_MAX_BYTES, request: req }),
        })
        const { isNew, task } = await getCoreRuntime({
          payload: req.payload,
        }).admission.submitRegeneration({ ...command, sourceArtifactId, userId })
        return httpResponse({ data: task, requestId, status: isNew ? 201 : 200 })
      },
    }),
    method: 'post',
    path: '/v1/artifacts/:artifactId/regenerations',
  },
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        const userId = await requireUserId({ req })
        assertNoQuery({ request: req })
        const taskId = parsePathId({ value: req.routeParams?.taskId })
        await assertEmptyBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).tasks.get({ taskId, userId })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: '/v1/generations/:taskId',
  },
  {
    handler: httpEndpoint({
      work: async ({ req, requestId }) => {
        const userId = await requireUserId({ req })
        const sessionId = parsePathId({ value: req.routeParams?.sessionId })
        const query = readQuery({ allowedKeys: ['cursor'], request: req })
        await assertEmptyBody({ request: req })
        const data = await getCoreRuntime({ payload: req.payload }).tasks.list({
          query,
          sessionId,
          userId,
        })
        return httpResponse({ data, requestId })
      },
    }),
    method: 'get',
    path: '/v1/creation-sessions/:sessionId/generations',
  },
]
