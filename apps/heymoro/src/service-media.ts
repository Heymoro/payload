import type { PayloadRequest } from 'payload'

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { MEDIA_LIFECYCLES } from './media/schema.js'

import { ALLOWED_MEDIA_MIME_TYPES, MEDIA_MAX_BYTES } from './media/schema.js'
import { withWriteTransaction } from './service-transaction.js'

export const MEDIA_ROOT = path.resolve(process.env.UPLOAD_DIR || './media')

type MediaMimeType = (typeof ALLOWED_MEDIA_MIME_TYPES)[number]

export type UploadInput = {
  arrayBuffer: () => Promise<ArrayBuffer>
  name: string
  size: number
  type: string
}

export type MediaDocument = {
  createdAt: string
  deleteAttempts?: null | number
  filesize?: null | number
  id: number
  lastDeleteError?: null | string
  lifecycle: (typeof MEDIA_LIFECYCLES)[number]
  mimeType?: null | string
  originalName: string
  owner: { id: number } | number
  pendingDeleteAt?: null | string
  storageName: string
  updatedAt: string
}

export function validateMediaBytes(buffer: Buffer, declaredMimeType: string): MediaMimeType {
  if (buffer.length > MEDIA_MAX_BYTES) {
    throw new Error('FILE_TOO_LARGE')
  }
  if (!ALLOWED_MEDIA_MIME_TYPES.includes(declaredMimeType as MediaMimeType)) {
    throw new Error('FILE_TYPE_NOT_ALLOWED')
  }

  const isJpeg = buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
  const isPng = buffer
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const isPdf = buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  if (
    (declaredMimeType === 'image/jpeg' && !isJpeg) ||
    (declaredMimeType === 'image/png' && !isPng) ||
    (declaredMimeType === 'application/pdf' && !isPdf)
  ) {
    throw new Error('FILE_SIGNATURE_INVALID')
  }
  return declaredMimeType as MediaMimeType
}

function extensionForMimeType(mimeType: MediaMimeType): string {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/png' ? 'png' : 'pdf'
}

function safeOriginalName(name: string): string {
  // eslint-disable-next-line no-control-regex -- Intentionally reject or strip control characters.
  const normalized = name.replace(/[\\/\u0000-\u001f]/g, '_').trim()
  return normalized.slice(0, 255) || 'upload'
}

export function mediaPath(media: Pick<MediaDocument, 'storageName'>): string {
  if (!/^[\w-]+\.(?:jpg|png|pdf)$/.test(media.storageName)) {
    throw new Error('INVALID_STORAGE_NAME')
  }
  const resolved = path.resolve(MEDIA_ROOT, media.storageName)
  if (!resolved.startsWith(`${MEDIA_ROOT}${path.sep}`)) {
    throw new Error('INVALID_STORAGE_NAME')
  }
  return resolved
}

export function mediaDto(media: MediaDocument) {
  const ownerId = typeof media.owner === 'object' ? media.owner.id : media.owner
  return {
    id: media.id,
    createdAt: media.createdAt,
    filesize: media.filesize || 0,
    lifecycle: media.lifecycle,
    mimeType: media.mimeType || null,
    originalName: media.originalName,
    ownerId,
    updatedAt: media.updatedAt,
  }
}

export async function createMediaFromUpload(args: {
  alt?: string
  file: UploadInput
  req: PayloadRequest
  userId: number
}) {
  const buffer = Buffer.from(await args.file.arrayBuffer())
  const mimeType = validateMediaBytes(buffer, args.file.type)
  await mkdir(MEDIA_ROOT, { recursive: true })
  const storageName = `${randomBytes(24).toString('base64url')}.${extensionForMimeType(mimeType)}`
  const storagePath = mediaPath({ storageName })
  await writeFile(storagePath, buffer, { flag: 'wx' })

  try {
    return await args.req.payload.create({
      collection: 'media',
      data: {
        alt: safeOriginalName(args.alt || args.file.name),
        deleteAttempts: 0,
        filename: storageName,
        filesize: buffer.length,
        lifecycle: 'active',
        mimeType,
        originalName: safeOriginalName(args.file.name),
        owner: args.userId,
        storageName,
      },
      overrideAccess: true,
      req: args.req,
    })
  } catch (error) {
    try {
      await unlink(storagePath)
    } catch {
      // The file may not have been materialized before metadata validation failed.
    }
    throw error
  }
}

export async function findMediaByID(
  req: PayloadRequest,
  id: number,
): Promise<MediaDocument | null> {
  return (await req.payload.findByID({
    id,
    collection: 'media',
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
    showHiddenFields: true,
  })) as unknown as MediaDocument | null
}

export function ownerId(media: Pick<MediaDocument, 'owner'>): number {
  return typeof media.owner === 'object' ? media.owner.id : media.owner
}

export function attachmentIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map((item) =>
    typeof item === 'object' && item !== null && 'id' in item ? Number(item.id) : Number(item),
  )
}

export async function assertAttachableMedia(args: {
  allowAnyOwner?: boolean
  ids: number[]
  req: PayloadRequest
  userId?: number
}): Promise<void> {
  for (const id of [...new Set(args.ids)].sort((a, b) => a - b)) {
    const media = await findMediaByID(args.req, id)
    if (
      !media ||
      media.lifecycle !== 'active' ||
      (!args.allowAnyOwner && args.userId !== undefined && ownerId(media) !== args.userId)
    ) {
      throw new Error('MEDIA_NOT_ATTACHABLE')
    }
  }
}

export async function hasMediaReferences(req: PayloadRequest, id: number): Promise<boolean> {
  const references = await req.payload.find({
    collection: 'records',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { attachments: { contains: id } },
  })
  if (references.totalDocs > 0) {
    return true
  }
  const generations = await req.payload.find({
    collection: 'generations',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { or: [{ inputMediaIds: { contains: id } }, { outputMedia: { equals: id } }] },
  })
  return generations.totalDocs > 0
}

export async function readMediaBytes(media: MediaDocument): Promise<Buffer> {
  return readFile(mediaPath(media))
}

export async function removeMediaFile(media: MediaDocument): Promise<'missing' | 'removed'> {
  try {
    await unlink(mediaPath(media))
    return 'removed'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing'
    }
    throw error
  }
}

export async function cleanupPendingMedia(args: {
  limit?: number
  now?: Date
  payload: PayloadRequest['payload']
  req: PayloadRequest
}) {
  const { payload, req } = args
  const now = args.now || new Date()
  return withWriteTransaction({
    req,
    work: async () => {
      const pending = await payload.find({
        collection: 'media',
        depth: 0,
        limit: args.limit || 50,
        overrideAccess: true,
        req,
        showHiddenFields: true,
        where: {
          and: [
            { lifecycle: { equals: 'pendingDelete' } },
            { pendingDeleteAt: { less_than_equal: now.toISOString() } },
          ],
        },
      })
      const result = { blocked: 0, removed: 0, retried: 0 }
      for (const media of pending.docs) {
        const { id } = media
        if (await hasMediaReferences(req, id)) {
          await payload.update({
            id,
            collection: 'media',
            data: { lastDeleteError: 'FILE_IN_USE' },
            overrideAccess: true,
            req,
          })
          result.blocked += 1
          continue
        }

        try {
          await removeMediaFile(media)
        } catch (error) {
          await payload.update({
            id,
            collection: 'media',
            data: {
              deleteAttempts: Number(media.deleteAttempts || 0) + 1,
              lastDeleteError:
                error instanceof Error ? error.message.slice(0, 500) : 'MEDIA_DELETE_FAILED',
            },
            overrideAccess: true,
            req,
          })
          result.retried += 1
          continue
        }
        // If the DB write fails after unlink, the pending row can be retried (ENOENT is OK).
        await payload.delete({ id, collection: 'media', overrideAccess: true, req })
        result.removed += 1
      }
      return result
    },
  })
}

export async function cleanupOrphanMedia(args: {
  limit?: number
  now?: Date
  olderThanMs?: number
  payload: PayloadRequest['payload']
  req: PayloadRequest
}) {
  // An unreferenced active file is still a user's saved file, not an orphan.
  // Only an explicit delete request can place a file into the cleanup queue.
  const cleaned = await cleanupPendingMedia(args)
  return { queued: 0, ...cleaned }
}
