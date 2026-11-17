import type { Endpoint, PayloadRequest } from 'payload'

import { randomUUID } from 'node:crypto'
import { ValidationError } from 'payload'

import { isStaffPrincipal, isUserPrincipal } from './auth-principals.js'
import { parsePagination } from './pagination.js'
import { findVisibleRecord, parseRecordInput, recordDto } from './service-records.js'
import { withWriteTransaction } from './service-transaction.js'

function requestId(req: PayloadRequest): string {
  return req.headers.get('x-request-id') || randomUUID()
}

function errorResponse(
  req: PayloadRequest,
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json({ error: { code, message }, requestId: requestId(req) }, { status })
}

function parseId(req: PayloadRequest): null | number {
  const raw = req.routeParams?.id
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

function canUseRecords(req: PayloadRequest): boolean {
  return isUserPrincipal(req.user) || isStaffPrincipal(req.user)
}

function requireAuth(req: PayloadRequest): null | Response {
  return canUseRecords(req) ? null : errorResponse(req, 401, 'AUTH_REQUIRED', '请先登录')
}

function mapRecordError(req: PayloadRequest, error: unknown): Response {
  if (error instanceof ValidationError) {
    return errorResponse(
      req,
      400,
      'VALIDATION_FAILED',
      error.data?.errors[0]?.message || '记录字段校验失败',
    )
  }
  if (error instanceof Error && error.message === 'MEDIA_NOT_ATTACHABLE') {
    return errorResponse(req, 400, 'FILE_NOT_ATTACHABLE', '附件不存在、已删除或无权使用')
  }
  req.payload.logger.error({ err: error }, 'Record operation failed')
  return errorResponse(req, 500, 'RECORD_OPERATION_FAILED', '记录操作失败')
}

export const recordsEndpoints: Endpoint[] = [
  {
    handler: async (req) => {
      const authError = requireAuth(req)
      if (authError) {
        return authError
      }

      const url = new URL(req.url || 'http://localhost')
      let page: number
      let limit: number
      try {
        ;({ limit, page } = parsePagination(url))
      } catch {
        return errorResponse(req, 400, 'INVALID_PAGINATION', '分页参数必须为正整数')
      }
      const result = await req.payload.find({
        collection: 'records',
        depth: 0,
        limit,
        overrideAccess: false,
        page,
        req,
        sort: '-createdAt,-id',
        user: req.user,
      })
      return Response.json({
        data: {
          items: result.docs.map(recordDto),
          limit,
          page: result.page,
          totalDocs: result.totalDocs,
          totalPages: result.totalPages,
        },
        requestId: requestId(req),
      })
    },
    method: 'get',
    path: '/v1/records',
  },
  {
    handler: async (req) => {
      if (!isUserPrincipal(req.user)) {
        return errorResponse(req, 401, 'AUTH_REQUIRED', '请先登录')
      }
      let body: unknown
      try {
        body = await req.json?.()
      } catch {
        return errorResponse(req, 400, 'INVALID_JSON', '请求格式无效')
      }
      const parsed = parseRecordInput(body)
      if (parsed.error || !parsed.data) {
        return errorResponse(req, 400, 'VALIDATION_FAILED', parsed.error || '参数无效')
      }

      try {
        const record = await withWriteTransaction({
          req,
          work: () =>
            req.payload.create({
              collection: 'records',
              data: parsed.data as never,
              depth: 0,
              overrideAccess: false,
              req,
              user: req.user,
            }),
        })
        return Response.json(
          { data: recordDto(record), requestId: requestId(req) },
          { status: 201 },
        )
      } catch (error) {
        return mapRecordError(req, error)
      }
    },
    method: 'post',
    path: '/v1/records',
  },
  {
    handler: async (req) => {
      const authError = requireAuth(req)
      if (authError) {
        return authError
      }
      const id = parseId(req)
      if (!id) {
        return errorResponse(req, 404, 'RECORD_NOT_FOUND', '记录不存在')
      }
      const record = await findVisibleRecord(req, id)
      if (!record) {
        return errorResponse(req, 404, 'RECORD_NOT_FOUND', '记录不存在')
      }
      return Response.json({ data: recordDto(record), requestId: requestId(req) })
    },
    method: 'get',
    path: '/v1/records/:id',
  },
  {
    handler: async (req) => {
      if (!isUserPrincipal(req.user)) {
        return errorResponse(req, 401, 'AUTH_REQUIRED', '请先登录')
      }
      const id = parseId(req)
      if (!id) {
        return errorResponse(req, 404, 'RECORD_NOT_FOUND', '记录不存在')
      }
      if (!(await findVisibleRecord(req, id))) {
        return errorResponse(req, 404, 'RECORD_NOT_FOUND', '记录不存在')
      }
      let body: unknown
      try {
        body = await req.json?.()
      } catch {
        return errorResponse(req, 400, 'INVALID_JSON', '请求格式无效')
      }
      const { data, error } = parseRecordInput(body, true)
      if (error || !data) {
        return errorResponse(req, 400, 'VALIDATION_FAILED', error || '参数无效')
      }
      try {
        const record = await withWriteTransaction({
          req,
          work: () =>
            req.payload.update({
              id,
              collection: 'records',
              data,
              depth: 0,
              overrideAccess: false,
              req,
              user: req.user,
            }),
        })
        return Response.json({ data: recordDto(record), requestId: requestId(req) })
      } catch (error) {
        return mapRecordError(req, error)
      }
    },
    method: 'patch',
    path: '/v1/records/:id',
  },
  {
    handler: async (req) => {
      if (!isUserPrincipal(req.user)) {
        return errorResponse(req, 401, 'AUTH_REQUIRED', '请先登录')
      }
      const id = parseId(req)
      if (!id || !(await findVisibleRecord(req, id))) {
        return errorResponse(req, 404, 'RECORD_NOT_FOUND', '记录不存在')
      }
      await req.payload.delete({
        id,
        collection: 'records',
        overrideAccess: false,
        req,
        user: req.user,
      })
      return new Response(null, { status: 204 })
    },
    method: 'delete',
    path: '/v1/records/:id',
  },
]
