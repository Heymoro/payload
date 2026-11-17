import type { PayloadRequest } from 'payload'

import { createHash } from 'node:crypto'
import sharp from 'sharp'

import { TEMPLATE_IDS } from './collections/CreationSessions.js'
import { generateImage, ImageProviderError, readImageProviderConfig } from './image-provider.js'
import {
  attachmentIds,
  createMediaFromUpload,
  findMediaByID,
  ownerId,
  readMediaBytes,
  removeMediaFile,
  validateMediaBytes,
} from './service-media.js'
import { withWriteTransaction } from './service-transaction.js'

export type GenerationStatus = 'failed' | 'queued' | 'running' | 'succeeded' | 'unknown'
export type GenerationInput = {
  clientRequestId: string
  inputMediaIds: number[]
  prompt: string
  sessionId: number
}
export class CreationError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code)
  }
}

const TEMPLATE_PROMPTS = {
  duel: 'Compose a playful cinematic face-off featuring the subjects from the supplied references. Keep each subject recognizable and avoid graphic violence.',
  free: 'Create one polished original image following the user description and any supplied references.',
  garden:
    'Create a whimsical miniature garden scene inspired by the supplied references, with lush plants and delicate natural light.',
  plush:
    'Reimagine the subjects in the references as charming plush toys, with soft fabric, visible stitching and a playful studio composition.',
  portrait:
    'Create a refined editorial portrait based on the supplied references. Preserve identity, with thoughtful soft lighting and a clean composition.',
  retro:
    'Create a nostalgic analog film photograph from the supplied references, with authentic grain, warm colors and a natural composition. Preserve the recognizable subjects.',
} as const
export const PROMPT_VERSION = 'heymoro-2026-11-v1'
export const IN_FLIGHT = ['queued', 'running', 'unknown']

export function parseGenerationInput(value: unknown): GenerationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CreationError('VALIDATION_FAILED')
  }
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some(
      (key) => !['clientRequestId', 'inputMediaIds', 'prompt', 'sessionId'].includes(key),
    )
  ) {
    throw new CreationError('VALIDATION_FAILED')
  }
  if (
    !Number.isSafeInteger(input.sessionId) ||
    Number(input.sessionId) < 1 ||
    typeof input.prompt !== 'string' ||
    input.prompt.length > 2000 ||
    !Array.isArray(input.inputMediaIds) ||
    input.inputMediaIds.length > 8 ||
    input.inputMediaIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    new Set(input.inputMediaIds).size !== input.inputMediaIds.length ||
    typeof input.clientRequestId !== 'string' ||
    !/^[\w-]{1,128}$/.test(input.clientRequestId)
  ) {
    throw new CreationError('VALIDATION_FAILED')
  }
  return {
    clientRequestId: input.clientRequestId,
    inputMediaIds: input.inputMediaIds,
    prompt: input.prompt.trim(),
    sessionId: Number(input.sessionId),
  }
}

export function validateTemplateInputs({
  inputMediaIds,
  templateId,
}: {
  inputMediaIds: number[]
  templateId: string
}) {
  if (!TEMPLATE_IDS.includes(templateId as (typeof TEMPLATE_IDS)[number])) {
    throw new CreationError('INVALID_TEMPLATE')
  }
  if (templateId !== 'free' && inputMediaIds.length === 0) {
    throw new CreationError('INPUT_IMAGE_REQUIRED')
  }
}

export function snapshotHash(input: GenerationInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        inputMediaIds: input.inputMediaIds,
        prompt: input.prompt,
        sessionId: input.sessionId,
      }),
    )
    .digest('hex')
}

export function calculateCreationAccount({
  configured,
  statuses,
}: {
  configured: boolean
  statuses: string[]
}) {
  const reserved = statuses.filter((status) => IN_FLIGHT.includes(status)).length
  const consumed = statuses.filter((status) => status === 'succeeded').length
  return { available: Math.max(0, 2 - reserved - consumed), configured, consumed, reserved }
}

export const relationId = (value: { id: number } | number) =>
  typeof value === 'object' ? value.id : value

export function sessionDto(doc: {
  createdAt: string
  id: number
  templateId: string
  title: string
  updatedAt: string
}) {
  return {
    id: doc.id,
    createdAt: doc.createdAt,
    templateId: doc.templateId,
    title: doc.title,
    updatedAt: doc.updatedAt,
  }
}

export function generationDto(doc: {
  createdAt: string
  errorCode?: null | string
  id: number
  inputMediaIds?: ({ id: number } | number)[] | null
  outputMedia?: { id: number } | null | number
  prompt?: null | string
  provider: 'fixture' | 'openai'
  saved?: boolean | null
  session: { id: number } | number
  status: GenerationStatus
}) {
  return {
    id: doc.id,
    createdAt: doc.createdAt,
    errorCode: doc.errorCode || null,
    inputMediaIds: attachmentIds(doc.inputMediaIds),
    outputMediaId: doc.outputMedia ? relationId(doc.outputMedia) : null,
    prompt: doc.prompt || '',
    provider: doc.provider,
    saved: Boolean(doc.saved),
    sessionId: relationId(doc.session),
    status: doc.status,
  }
}

export async function findOwnedSession({
  id,
  req,
  userId,
}: {
  id: number
  req: PayloadRequest
  userId: number
}) {
  const doc = await req.payload.findByID({
    id,
    collection: 'creation-sessions',
    depth: 0,
    disableErrors: true,
    overrideAccess: false,
    req,
    user: req.user,
  })
  if (!doc || relationId(doc.owner) !== userId) {
    throw new CreationError('SESSION_NOT_FOUND', 404)
  }
  return doc
}

export async function creationAccount({ req, userId }: { req: PayloadRequest; userId: number }) {
  // Only two successful rows can exist, but failures are unbounded; use counts rather than a truncated list.
  const [reserved, consumed] = await Promise.all([
    req.payload.count({
      collection: 'generations',
      overrideAccess: false,
      req,
      user: req.user,
      where: { and: [{ owner: { equals: userId } }, { status: { in: IN_FLIGHT } }] },
    }),
    req.payload.count({
      collection: 'generations',
      overrideAccess: false,
      req,
      user: req.user,
      where: { and: [{ owner: { equals: userId } }, { status: { equals: 'succeeded' } }] },
    }),
  ])
  return {
    available: Math.max(0, 2 - reserved.totalDocs - consumed.totalDocs),
    configured: readImageProviderConfig().configured,
    consumed: consumed.totalDocs,
    reserved: reserved.totalDocs,
  }
}

async function assertImageInputs({
  ids,
  req,
  userId,
}: {
  ids: number[]
  req: PayloadRequest
  userId: number
}) {
  let bytes = 0
  for (const id of ids) {
    const media = await findMediaByID(req, id)
    if (!media || media.lifecycle !== 'active' || ownerId(media) !== userId) {
      throw new CreationError('INPUT_MEDIA_INVALID')
    }
    if (!['image/jpeg', 'image/png'].includes(media.mimeType || '')) {
      throw new CreationError('INPUT_IMAGE_TYPE_INVALID')
    }
    if (!media.filesize || media.filesize > 10 * 1024 * 1024) {
      throw new CreationError('INPUT_IMAGE_TOO_LARGE')
    }
    bytes += media.filesize
  }
  if (bytes > 32 * 1024 * 1024) {
    throw new CreationError('INPUT_IMAGES_TOO_LARGE')
  }
}

export async function submitGeneration({
  input,
  req,
  userId,
}: {
  input: GenerationInput
  req: PayloadRequest
  userId: number
}) {
  return withWriteTransaction({
    req,
    work: async () => {
      const key = `${userId}:${input.clientRequestId}`
      const hash = snapshotHash(input)
      // The private unique index is intentionally hidden from native query paths. Scope this internal metadata lookup explicitly.
      const existing = await req.payload.find({
        collection: 'generations',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        req,
        showHiddenFields: true,
        where: { and: [{ owner: { equals: userId } }, { requestKey: { equals: key } }] },
      })
      if (existing.docs[0]) {
        if (existing.docs[0].snapshotHash !== hash) {
          throw new CreationError('IDEMPOTENCY_CONFLICT', 409)
        }
        return { generation: existing.docs[0], isNew: false }
      }
      const session = await findOwnedSession({ id: input.sessionId, req, userId })
      validateTemplateInputs({ inputMediaIds: input.inputMediaIds, templateId: session.templateId })
      if (session.templateId === 'free' && !input.prompt && !input.inputMediaIds.length) {
        throw new CreationError('PROMPT_REQUIRED')
      }
      const providerConfig = readImageProviderConfig()
      if (!providerConfig.configured) {
        throw new CreationError('GENERATION_NOT_CONFIGURED', 503)
      }
      await assertImageInputs({ ids: input.inputMediaIds, req, userId })
      const account = await creationAccount({ req, userId })
      if (account.reserved > 0) {
        throw new CreationError('GENERATION_IN_PROGRESS', 409)
      }
      if (account.available < 1) {
        throw new CreationError('CREATION_CREDITS_EXHAUSTED', 402)
      }
      // Internal mutation follows explicit ownership and input checks. Native writes remain denied.
      const generation = await req.payload.create({
        collection: 'generations',
        data: {
          inputMediaIds: input.inputMediaIds,
          model: providerConfig.model,
          owner: userId,
          prompt: input.prompt,
          promptVersion: PROMPT_VERSION,
          provider: providerConfig.provider as 'fixture' | 'openai',
          requestKey: key,
          saved: false,
          session: session.id,
          snapshotHash: hash,
          status: 'queued',
          systemPrompt: TEMPLATE_PROMPTS[session.templateId],
        },
        depth: 0,
        overrideAccess: true,
        req,
      })
      await req.payload.jobs.queue({
        input: { generationId: generation.id },
        overrideAccess: true,
        queue: 'creation',
        req,
        task: 'create-image',
      })
      await req.payload.update({
        id: session.id,
        collection: 'creation-sessions',
        data: { updatedAt: new Date().toISOString() },
        overrideAccess: true,
        req,
      })
      return { generation, isNew: true }
    },
  })
}

/** A claimed generation is never submitted twice, including jobs recovered after a worker crash. */
export async function runGeneration({
  generationId,
  req,
}: {
  generationId: number
  req: PayloadRequest
}) {
  const generation = await withWriteTransaction({
    req,
    work: async () => {
      const doc = await req.payload.findByID({
        id: generationId,
        collection: 'generations',
        depth: 0,
        disableErrors: true,
        overrideAccess: true,
        req,
        showHiddenFields: true,
      })
      if (!doc) {
        return null
      }
      if (
        doc.status === 'running' &&
        (!doc.leaseUntil || Date.parse(doc.leaseUntil) < Date.now())
      ) {
        await req.payload.update({
          id: doc.id,
          collection: 'generations',
          data: { errorCode: 'GENERATION_OUTCOME_UNKNOWN', status: 'unknown' },
          overrideAccess: true,
          req,
        })
      }
      if (doc.status !== 'queued') {
        return null
      }
      return req.payload.update({
        id: doc.id,
        collection: 'generations',
        data: { leaseUntil: new Date(Date.now() + 5 * 60_000).toISOString(), status: 'running' },
        depth: 0,
        overrideAccess: true,
        req,
        showHiddenFields: true,
      })
    },
  })
  if (!generation) {
    return
  }
  let hasSubmitted = false
  let outputMedia: Awaited<ReturnType<typeof createMediaFromUpload>> | undefined
  try {
    const images = []
    for (const id of attachmentIds(generation.inputMediaIds)) {
      const media = await findMediaByID(req, id)
      if (
        !media ||
        media.lifecycle !== 'active' ||
        ownerId(media) !== relationId(generation.owner) ||
        !['image/jpeg', 'image/png'].includes(media.mimeType || '')
      ) {
        throw new ImageProviderError('INPUT_MEDIA_INVALID', true)
      }
      images.push({ bytes: await readMediaBytes(media), mimeType: media.mimeType! })
    }
    if (readImageProviderConfig().provider !== generation.provider) {
      throw new ImageProviderError('GENERATION_PROVIDER_CHANGED', true)
    }
    hasSubmitted = true
    const bytes = await generateImage({
      env: { ...process.env, OPENAI_IMAGE_MODEL: generation.model },
      images,
      prompt: `${generation.systemPrompt}\n\nUser description:\n${generation.prompt || ''}`,
    })
    validateMediaBytes(bytes, 'image/png')
    // Decode pixels, not just the signature, before persisting a billable artifact.
    await sharp(bytes, { limitInputPixels: 16_777_216 }).stats()
    await withWriteTransaction({
      req,
      work: async () => {
        const current = await req.payload.findByID({
          id: generation.id,
          collection: 'generations',
          depth: 0,
          overrideAccess: true,
          req,
        })
        if (current.status === 'succeeded') {
          return
        }
        if (current.status !== 'running' && current.status !== 'unknown') {
          throw new Error('GENERATION_STATE_CONFLICT')
        }
        outputMedia = await createMediaFromUpload({
          file: {
            name: `creation-${generation.id}.png`,
            type: 'image/png',
            arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer),
            size: bytes.length,
          },
          req,
          userId: relationId(generation.owner),
        })
        // Output relation and consumed credit (succeeded state) commit atomically.
        await req.payload.update({
          id: generation.id,
          collection: 'generations',
          data: {
            errorCode: null,
            leaseUntil: null,
            outputMedia: outputMedia.id,
            status: 'succeeded',
          },
          overrideAccess: true,
          req,
        })
      },
    })
  } catch (error) {
    let shouldRemoveRolledBackOutput = false
    const isDefinite = error instanceof ImageProviderError ? error.isDefinite : !hasSubmitted
    await withWriteTransaction({
      req,
      work: async () => {
        const current = await req.payload.findByID({
          id: generation.id,
          collection: 'generations',
          depth: 0,
          overrideAccess: true,
          req,
        })
        if (current.status === 'succeeded') {
          return
        }
        shouldRemoveRolledBackOutput = true
        await req.payload.update({
          id: generation.id,
          collection: 'generations',
          data: {
            errorCode:
              error instanceof ImageProviderError
                ? error.code
                : isDefinite
                  ? 'GENERATION_INPUT_FAILED'
                  : 'GENERATION_OUTCOME_UNKNOWN',
            leaseUntil: null,
            status: isDefinite ? 'failed' : 'unknown',
          },
          overrideAccess: true,
          req,
        })
      },
    })
    // Never remove a file before ruling out a committed success with a lost commit acknowledgement.
    if (outputMedia && shouldRemoveRolledBackOutput) {
      try {
        await removeMediaFile(outputMedia)
      } catch {
        /* An uncommitted file may be cleaned manually. */
      }
    }
  }
}
