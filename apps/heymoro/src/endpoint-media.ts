import type { Endpoint, PayloadRequest } from 'payload'

import { randomUUID } from 'node:crypto'

import { isAdministratorPrincipal, isStaffPrincipal, isUserPrincipal } from './auth-principals.js'
import { contentDisposition } from './content-disposition.js'
import { parsePagination } from './pagination.js'
import {
  cleanupOrphanMedia,
  createMediaFromUpload,
  findMediaByID,
  hasMediaReferences,
  mediaDto,
  ownerId,
  readMediaBytes,
} from './service-media.js'
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
  const id = Number(req.routeParams?.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

function canReadMedia(req: PayloadRequest): boolean {
  return isUserPrincipal(req.user) || isStaffPrincipal(req.user)
}

async function findReadableMedia({ id, req }: { id: number; req: PayloadRequest }) {
  const media = await req.payload.findByID({
    id,
    collection: 'media',
    depth: 0,
    disableErrors: true,
    overrideAccess: false,
    req,
    showHiddenFields: true,
    user: req.user,
  })
  // Web management may inspect pending items; v1 retains its active-only contract.
  return media?.lifecycle === 'active' ? media : null
}

function canManageMedia(req: PayloadRequest, media: { owner: { id: number } | number }): boolean {
  const user = req.user
  return (
    isAdministratorPrincipal(user) ||
    Boolean(user && isUserPrincipal(user) && ownerId(media) === user.id)
  )
}

type ParsedUpload =
  | {
      alt?: string
      file: { arrayBuffer: () => Promise<ArrayBuffer>; name: string; size: number; type: string }
    }
  | { error: 'FILE_REQUIRED' | 'MULTIPART_REQUIRED' }

async function parseUpload(req: PayloadRequest): Promise<ParsedUpload> {
  if (req.file) {
    const requestFile = req.file
    return {
      file: {
        name: requestFile.name,
        type: requestFile.mimetype,
        size: requestFile.size,
        // eslint-disable-next-line @typescript-eslint/require-await -- Promise adapter preserves asynchronous error delivery.
        arrayBuffer: async () => Uint8Array.from(requestFile.data).buffer,
      },
    }
  }
  if (!req.formData) {
    return { error: 'MULTIPART_REQUIRED' }
  }
  const form = await req.formData()
  const entry = form.get('file')
  if (
    !entry ||
    typeof entry !== 'object' ||
    !('arrayBuffer' in entry) ||
    typeof entry.arrayBuffer !== 'function'
  ) {
    return { error: 'FILE_REQUIRED' }
  }
  const file = entry as unknown as {
    arrayBuffer: () => Promise<ArrayBuffer>
    name: string
    size: number
    type: string
  }
  const alt = form.get('alt')
  return {
    alt: typeof alt === 'string' ? alt : undefined,
    file: {
      name: file.name,
      type: file.type,
      arrayBuffer: () => file.arrayBuffer(),
      size: file.size,
    },
  }
}

export const mediaEndpoints: Endpoint[] = [
  {
    handler: async (req) => {
      const user = req.user
      if (!user || (!isUserPrincipal(user) && !isStaffPrincipal(user))) {
        return errorResponse(req, 401, 'AUTH_REQUIRED', '请先登录')
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
        collection: 'media',
        depth: 0,
        limit,
        overrideAccess: false,
        page,
        req,
        sort: '-createdAt,-id',
        user,
        where: { lifecycle: { equals: 'active' } },
      })
      return Response.json({
        data: {
          items: result.docs.map((media) => mediaDto(media as never)),
          limit,
          page: result.page,
          totalDocs: result.totalDocs,
          totalPages: result.totalPages,
        },
        requestId: requestId(req),
      })
    },
    method: 'get',
    path: '/v1/media',
  },
  {
    handler: async (req) => {
      const user = req.user
      if (!user || !isUserPrincipal(user)) {
        return errorResponse(req, 401, 'AUTH_REQUIRED', '请先登录')
      }
      let upload: Awaited<ReturnType<typeof parseUpload>>
      try {
        upload = await parseUpload(req)
      } catch {
        return errorResponse(req, 400, 'INVALID_MULTIPART', '上传格式无效')
      }
      if ('error' in upload) {
        const code = upload.error
        return errorResponse(
          req,
          400,
          code,
          code === 'FILE_REQUIRED' ? '请选择文件' : '必须使用 multipart/form-data',
        )
      }
      try {
        const media = await createMediaFromUpload({
          alt: upload.alt,
          file: upload.file,
          req,
          userId: user.id,
        })
        return Response.json(
          { data: mediaDto(media as never), requestId: requestId(req) },
          { status: 201 },
        )
      } catch (error) {
        const code = error instanceof Error ? error.message : 'MEDIA_UPLOAD_FAILED'
        if (code === 'FILE_TOO_LARGE') {
          return errorResponse(req, 413, code, '文件不能超过 10 MiB')
        }
        if (code === 'FILE_TYPE_NOT_ALLOWED' || code === 'FILE_SIGNATURE_INVALID') {
          return errorResponse(req, 400, code, '文件类型或内容无效')
        }
        req.payload.logger.error({ err: error }, 'Media upload failed')
        return errorResponse(req, 500, 'MEDIA_UPLOAD_FAILED', '文件上传失败')
      }
    },
    method: 'post',
    path: '/v1/media',
  },
  {
    handler: async (req) => {
      if (!canReadMedia(req)) {
        return errorResponse(req, 401, 'AUTH_REQUIRED', '请先登录')
      }
      const id = parseId(req)
      if (!id) {
        return errorResponse(req, 404, 'FILE_NOT_FOUND', '文件不存在')
      }
      const media = await findReadableMedia({ id, req })
      if (!media) {
        return errorResponse(req, 404, 'FILE_NOT_FOUND', '文件不存在')
      }
      return Response.json(
        { data: mediaDto(media), requestId: requestId(req) },
        {
          headers: { 'Cache-Control': 'private,no-store' },
        },
      )
    },
    method: 'get',
    path: '/v1/media/:id',
  },
  {
    handler: async (req) => {
      if (!canReadMedia(req)) {
        return errorResponse(req, 401, 'AUTH_REQUIRED', '请先登录')
      }
      const id = parseId(req)
      if (!id) {
        return errorResponse(req, 404, 'FILE_NOT_FOUND', '文件不存在')
      }
      const media = await findReadableMedia({ id, req })
      if (!media) {
        return errorResponse(req, 404, 'FILE_NOT_FOUND', '文件不存在')
      }
      try {
        const body = await readMediaBytes(media)
        return new Response(new Uint8Array(body), {
          headers: {
            'Cache-Control': 'private,no-store',
            'Content-Disposition': contentDisposition({ filename: media.originalName }),
            'Content-Length': String(body.length),
            'Content-Type': media.mimeType || 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
          },
          status: 200,
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return errorResponse(req, 404, 'FILE_NOT_FOUND', '文件不存在')
        }
        req.payload.logger.error({ err: error }, 'Media download failed')
        return errorResponse(req, 500, 'MEDIA_READ_FAILED', '文件读取失败')
      }
    },
    method: 'get',
    path: '/v1/media/:id/content',
  },
  {
    handler: async (req) => {
      if (!canReadMedia(req)) {
        return errorResponse(req, 401, 'AUTH_REQUIRED', '请先登录')
      }
      const id = parseId(req)
      if (!id) {
        return errorResponse(req, 404, 'FILE_NOT_FOUND', '文件不存在')
      }
      return withWriteTransaction({
        req,
        work: async () => {
          // Record attachment validation runs inside Payload's write transaction.
          const media = await findMediaByID(req, id)
          if (!media || !canManageMedia(req, media) || media.lifecycle === 'physicalDeleted') {
            return errorResponse(req, 404, 'FILE_NOT_FOUND', '文件不存在')
          }
          if (media.lifecycle === 'pendingDelete') {
            return Response.json(
              { data: mediaDto(media), requestId: requestId(req) },
              { status: 202 },
            )
          }
          if (await hasMediaReferences(req, id)) {
            return errorResponse(req, 409, 'FILE_IN_USE', '文件仍被业务记录引用')
          }

          const queued = await req.payload.update({
            id,
            collection: 'media',
            data: {
              lastDeleteError: null,
              lifecycle: 'pendingDelete',
              pendingDeleteAt: new Date().toISOString(),
            },
            overrideAccess: true,
            req,
          })
          return Response.json(
            { data: mediaDto(queued as never), requestId: requestId(req) },
            { status: 202 },
          )
        },
      })
    },
    method: 'delete',
    path: '/v1/media/:id',
  },
  {
    handler: async (req) => {
      if (!isAdministratorPrincipal(req.user)) {
        return errorResponse(req, 403, 'FORBIDDEN', '仅管理员可执行清理')
      }
      const result = await cleanupOrphanMedia({ payload: req.payload, req })
      return Response.json({ data: result, requestId: requestId(req) })
    },
    method: 'post',
    path: '/v1/media/cleanup',
  },
]
