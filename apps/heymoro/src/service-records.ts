import type { PayloadRequest } from 'payload'

import type { RecordDto } from './contracts.js'

export const RECORD_LIMITS = {
  attachments: { max: 20 },
  body: { max: 10000 },
  title: { max: 100, min: 1 },
} as const

export type RecordInput = {
  attachments?: number[]
  body?: null | string
  title?: string
}

export function parseRecordInput(
  value: unknown,
  partial = false,
): { data?: RecordInput; error?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '请求格式无效' }
  }
  const body = value as Record<string, unknown>
  const data: RecordInput = {}

  if ('title' in body) {
    if (typeof body.title !== 'string') {
      return { error: '标题格式无效' }
    }
    data.title = body.title
  } else if (!partial) {
    return { error: '标题不能为空' }
  }

  if ('body' in body) {
    if (body.body !== null && typeof body.body !== 'string') {
      return { error: '正文格式无效' }
    }
    data.body = body.body as null | string
  }

  if ('attachments' in body) {
    if (
      !Array.isArray(body.attachments) ||
      body.attachments.some((id) => typeof id !== 'number' || !Number.isInteger(id) || id < 1)
    ) {
      return { error: '附件参数无效' }
    }
    data.attachments = body.attachments as number[]
  }

  if (partial && Object.keys(data).length === 0) {
    return { error: '没有可更新的字段' }
  }
  return { data }
}

export function recordDto(record: {
  attachments?: ({ id: number } | number)[] | null
  body?: null | string
  createdAt: string
  id: number
  lifecycle: 'active' | 'archived'
  title: string
  updatedAt: string
}): RecordDto {
  return {
    id: record.id,
    attachments:
      record.attachments?.map((attachment) =>
        typeof attachment === 'object' ? attachment.id : attachment,
      ) || [],
    body: record.body || null,
    createdAt: record.createdAt,
    lifecycle: record.lifecycle,
    title: record.title,
    updatedAt: record.updatedAt,
  }
}

export async function findVisibleRecord(req: PayloadRequest, id: number) {
  try {
    return await req.payload.findByID({
      id,
      collection: 'records',
      depth: 0,
      overrideAccess: false,
      req,
      user: req.user,
    })
  } catch {
    return null
  }
}
