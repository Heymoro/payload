import type { Endpoint, PayloadRequest, Where } from 'payload'

import { randomUUID } from 'node:crypto'

import { isUserPrincipal } from './auth-principals.js'
import { TEMPLATE_IDS } from './collections/CreationSessions.js'
import { parsePagination } from './pagination.js'
import {
  creationAccount,
  CreationError,
  findOwnedSession,
  generationDto,
  parseGenerationInput,
  relationId,
  sessionDto,
  submitGeneration,
} from './service-creation.js'
import { withWriteTransaction } from './service-transaction.js'

const idFromRequest = (req: PayloadRequest) => {
  const id = Number(req.routeParams?.id)
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new CreationError('RESOURCE_NOT_FOUND', 404)
  }
  return id
}
const objectBody = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  let body: unknown
  try {
    body = await req.json?.()
  } catch {
    throw new CreationError('INVALID_JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CreationError('VALIDATION_FAILED')
  }
  return body as Record<string, unknown>
}
function endpoint(
  path: string,
  method: Endpoint['method'],
  action: (req: PayloadRequest, userId: number) => Promise<{ data: unknown; status?: number }>,
): Endpoint {
  return {
    handler: async (req) => {
      const requestId = req.headers.get('x-request-id') || randomUUID()
      const respond = (body: object, status = 200) =>
        Response.json(
          { ...body, requestId },
          { headers: { 'Cache-Control': 'private,no-store' }, status },
        )
      if (!isUserPrincipal(req.user) || !req.user) {
        return respond({ error: { code: 'AUTH_REQUIRED', message: '请先登录' } }, 401)
      }
      try {
        const result = await action(req, req.user.id)
        return respond({ data: result.data }, result.status)
      } catch (error) {
        if (error instanceof CreationError) {
          return respond({ error: { code: error.code, message: error.code } }, error.status)
        }
        // No provider response, prompt, credentials or uploaded bytes enter logs.
        req.payload.logger.error({
          errorName: error instanceof Error ? error.name : 'unknown',
          msg: 'Creation operation failed',
        })
        return respond(
          { error: { code: 'CREATION_OPERATION_FAILED', message: '创作操作失败' } },
          500,
        )
      }
    },
    method,
    path: `/v1${path}`,
  }
}
function pagination(req: PayloadRequest) {
  try {
    return parsePagination(new URL(req.url || 'http://localhost'))
  } catch {
    throw new CreationError('INVALID_PAGINATION')
  }
}
async function findGeneration(req: PayloadRequest, userId: number) {
  const generation = await req.payload.findByID({
    id: idFromRequest(req),
    collection: 'generations',
    depth: 0,
    disableErrors: true,
    overrideAccess: false,
    req,
    showHiddenFields: true,
    user: req.user,
  })
  if (!generation || relationId(generation.owner) !== userId) {
    throw new CreationError('GENERATION_NOT_FOUND', 404)
  }
  // An expired lease is an ambiguous outcome, not permission to resubmit an expensive request.
  if (
    generation.status === 'running' &&
    (!generation.leaseUntil || Date.parse(generation.leaseUntil) < Date.now())
  ) {
    return withWriteTransaction({
      req,
      work: async () => {
        const current = await req.payload.findByID({
          id: generation.id,
          collection: 'generations',
          depth: 0,
          overrideAccess: false,
          req,
          user: req.user,
        })
        if (current.status !== 'running') {
          return current
        }
        return req.payload.update({
          id: current.id,
          collection: 'generations',
          data: { errorCode: 'GENERATION_OUTCOME_UNKNOWN', status: 'unknown' },
          depth: 0,
          overrideAccess: true,
          req,
        })
      },
    })
  }
  return generation
}

export const creationEndpoints: Endpoint[] = [
  endpoint('/creation-sessions', 'post', async (req, userId) => {
    const body = await objectBody(req)
    if (
      Object.keys(body).some((key) => key !== 'templateId') ||
      !TEMPLATE_IDS.includes(body.templateId as (typeof TEMPLATE_IDS)[number])
    ) {
      throw new CreationError('INVALID_TEMPLATE')
    }
    const session = await req.payload.create({
      collection: 'creation-sessions',
      data: {
        owner: userId,
        templateId: body.templateId as (typeof TEMPLATE_IDS)[number],
        title: '新的创作',
      },
      depth: 0,
      overrideAccess: true,
      req,
    })
    return { data: sessionDto(session), status: 201 }
  }),
  endpoint('/creation-sessions', 'get', async (req) => {
    const { limit, page } = pagination(req)
    const result = await req.payload.find({
      collection: 'creation-sessions',
      depth: 0,
      limit,
      overrideAccess: false,
      page,
      req,
      sort: '-updatedAt,-id',
      user: req.user,
    })
    return {
      data: {
        items: result.docs.map(sessionDto),
        page: result.page,
        totalDocs: result.totalDocs,
        totalPages: result.totalPages,
      },
    }
  }),
  endpoint('/creation-sessions/:id', 'get', async (req, userId) => {
    const session = await findOwnedSession({ id: idFromRequest(req), req, userId })
    const generations = await req.payload.find({
      collection: 'generations',
      depth: 0,
      overrideAccess: false,
      pagination: false,
      req,
      sort: 'createdAt,id',
      user: req.user,
      where: { session: { equals: session.id } },
    })
    return {
      data: { generations: generations.docs.map(generationDto), session: sessionDto(session) },
    }
  }),
  endpoint('/creation-sessions/:id', 'patch', async (req, userId) => {
    const body = await objectBody(req)
    if (
      Object.keys(body).length !== 1 ||
      typeof body.title !== 'string' ||
      !body.title.trim() ||
      body.title.trim().length > 100
    ) {
      throw new CreationError('VALIDATION_FAILED')
    }
    const title = body.title.trim()
    const session = await withWriteTransaction({
      req,
      work: async () => {
        const current = await findOwnedSession({ id: idFromRequest(req), req, userId })
        return req.payload.update({
          id: current.id,
          collection: 'creation-sessions',
          data: { title },
          depth: 0,
          overrideAccess: true,
          req,
        })
      },
    })
    return { data: sessionDto(session) }
  }),
  endpoint('/generations', 'post', async (req, userId) => {
    const input = parseGenerationInput(await objectBody(req))
    const result = await submitGeneration({ input, req, userId })
    return { data: generationDto(result.generation), status: result.isNew ? 201 : 200 }
  }),
  endpoint('/generations/:id', 'get', async (req, userId) => ({
    data: generationDto(await findGeneration(req, userId)),
  })),
  endpoint('/generations/:id', 'patch', async (req, userId) => {
    const body = await objectBody(req)
    if (Object.keys(body).length !== 1 || typeof body.saved !== 'boolean') {
      throw new CreationError('VALIDATION_FAILED')
    }
    const saved = body.saved
    const generation = await withWriteTransaction({
      req,
      work: async () => {
        const current = await findGeneration(req, userId)
        if (current.status !== 'succeeded' || !current.outputMedia) {
          throw new CreationError('ARTIFACT_NOT_READY', 409)
        }
        return req.payload.update({
          id: current.id,
          collection: 'generations',
          data: { saved },
          depth: 0,
          overrideAccess: true,
          req,
        })
      },
    })
    return { data: generationDto(generation) }
  }),
  endpoint('/artifacts', 'get', async (req) => {
    const { limit, page } = pagination(req)
    const url = new URL(req.url || 'http://localhost')
    if (
      url.searchParams.has('saved') &&
      !['false', 'true'].includes(url.searchParams.get('saved') || '')
    ) {
      throw new CreationError('VALIDATION_FAILED')
    }
    const conditions: Where[] = [
      { status: { equals: 'succeeded' } },
      { outputMedia: { exists: true } },
    ]
    if (url.searchParams.has('saved')) {
      conditions.push({ saved: { equals: url.searchParams.get('saved') === 'true' } })
    }
    const result = await req.payload.find({
      collection: 'generations',
      depth: 0,
      limit,
      overrideAccess: false,
      page,
      req,
      sort: '-createdAt,-id',
      user: req.user,
      where: { and: conditions },
    })
    return {
      data: {
        items: result.docs.map(generationDto),
        page: result.page,
        totalDocs: result.totalDocs,
        totalPages: result.totalPages,
      },
    }
  }),
  endpoint('/creation-account', 'get', async (req, userId) => ({
    data: await creationAccount({ req, userId }),
  })),
]
