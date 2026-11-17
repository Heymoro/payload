import type { CreationInput, CreationMode } from '../domain/input.js'
import type { InputSchema } from '../domain/template-config.js'

import {
  CreationInputError,
  normalizeCreationInput,
  validateCreationInput,
} from '../domain/input.js'
import { validateHostCaps } from '../domain/template-config.js'
import { validateReferenceMedia } from './input-validation.js'

export class DraftError extends Error {
  readonly code:
    | 'DATA_INTEGRITY_CONFLICT'
    | 'NOT_FOUND'
    | 'TEMPLATE_UNAVAILABLE'
    | 'UNAUTHENTICATED'
  readonly status: 401 | 404 | 409 | 503
  constructor({ code }: { code: DraftError['code'] }) {
    super(
      code === 'UNAUTHENTICATED'
        ? 'An active authenticated account is required.'
        : code === 'NOT_FOUND'
          ? 'Session not found.'
          : code === 'TEMPLATE_UNAVAILABLE'
            ? 'Template is unavailable.'
            : 'Draft data integrity conflict.',
    )
    this.name = 'DraftError'
    this.code = code
    this.status =
      code === 'UNAUTHENTICATED'
        ? 401
        : code === 'NOT_FOUND'
          ? 404
          : code === 'TEMPLATE_UNAVAILABLE'
            ? 409
            : 503
  }
}
export type DraftSession = {
  id: number
  isDeleted: boolean
  mode: CreationMode
  templateId: number
  userId: number
}
export type DraftRecord = {
  description: string
  id: number
  isDeleted: boolean
  sessionId: number
  updatedAt: string
  userId: number
  userNotes: string
}
export type DraftSlot = {
  draftId: number
  id: number
  isDeleted: boolean
  mediaId: number
  position: number
  userId: number
}
export type DraftMedia = {
  filesize: null | number
  id: number
  isDeleted: boolean
  lifecycle: string
  mimeType: null | string
  owner: null | number
  purpose: string
  visibility: string
}
export type DraftResult = Readonly<{ input: CreationInput; updatedAt: string }>
export type DraftReader = Readonly<{
  findDrafts: (args: { sessionId: number }) => Promise<readonly DraftRecord[]>
  findSlots: (args: { draftId: number }) => Promise<readonly DraftSlot[]>
  isAccountActive: (args: { userId: number }) => Promise<boolean>
  readSession: (args: { sessionId: number }) => Promise<DraftSession | null>
}>
export type DraftRepository = DraftReader &
  Readonly<{
    readMedia: (args: { mediaId: number }) => Promise<DraftMedia | null>
    replace: (args: {
      actor: string
      draft: DraftRecord
      input: CreationInput
      now: string
      session: DraftSession
      slots: readonly DraftSlot[]
    }) => Promise<string>
  }>
export type DraftDependencies = {
  clock: () => string
  hostCaps: InputSchema
  read: (args: {
    work: (args: { repository: DraftReader }) => Promise<DraftResult>
  }) => Promise<DraftResult>
  write: (args: {
    resource: string
    work: (args: { repository: DraftRepository }) => Promise<DraftResult>
  }) => Promise<DraftResult>
}

export function createDraftService({ clock, hostCaps, read, write }: DraftDependencies) {
  const caps = validateHostCaps({ hostCaps })
  return Object.freeze({
    get: async ({
      sessionId,
      userId,
    }: {
      sessionId: number
      userId: number
    }): Promise<DraftResult> => {
      validateIdentity({ sessionId, userId })
      return read({
        work: async ({ repository }) => {
          const { draft, slots } = await readDraftState({ repository, sessionId, userId })
          return draftResult({ draft, slots })
        },
      })
    },
    save: async ({
      input,
      sessionId,
      userId,
    }: {
      input: unknown
      sessionId: number
      userId: number
    }): Promise<DraftResult> => {
      validateIdentity({ sessionId, userId })
      return write({
        resource: `session:${userId}:${sessionId}`,
        work: async ({ repository }) => {
          const { draft, session, slots } = await readDraftState({ repository, sessionId, userId })
          // Draft storage follows host safety limits; mutable template rules apply only to new admission.
          const limits = { ...caps, minImages: session.mode === 'effect' ? 1 : 0 }
          const normalized = validateCreationInput({
            input,
            limits: {
              maxDescriptionLength: limits.maxDescriptionLength,
              maxImages: limits.maxImages,
              maxNotesLength: limits.maxNotesLength,
              minImages: limits.minImages,
            },
            mode: session.mode,
            stage: 'draft',
          })
          await validateReferenceMedia({
            input: normalized,
            limits,
            readMedia: repository.readMedia,
            userId,
          })
          const now = clock()
          if (
            typeof now !== 'string' ||
            !Number.isFinite(Date.parse(now)) ||
            new Date(now).toISOString() !== now
          ) {
            throw new Error('Draft clock must return UTC milliseconds.')
          }
          const updatedAt = await repository.replace({
            actor: `user:${userId}`,
            draft,
            input: normalized,
            now,
            session,
            slots,
          })
          return Object.freeze({ input: normalized, updatedAt })
        },
      })
    },
  })
}

export async function readDraftState({
  repository,
  sessionId,
  userId,
}: {
  repository: DraftReader
  sessionId: number
  userId: number
}) {
  if (!(await repository.isAccountActive({ userId }))) {
    throw new DraftError({ code: 'UNAUTHENTICATED' })
  }
  const session = await repository.readSession({ sessionId })
  if (!session || session.isDeleted || session.userId !== userId) {
    throw new DraftError({ code: 'NOT_FOUND' })
  }
  const drafts = await repository.findDrafts({ sessionId })
  const draft = drafts[0]
  if (
    drafts.length !== 1 ||
    !draft ||
    draft.isDeleted ||
    draft.userId !== userId ||
    draft.sessionId !== sessionId
  ) {
    throw new DraftError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
  const slots = [...(await repository.findSlots({ draftId: draft.id }))].sort(
    (a, b) => a.position - b.position,
  )
  const positions = new Set<number>()
  const mediaIds = new Set<number>()
  let activePosition = 1
  for (const slot of slots) {
    if (
      slot.userId !== userId ||
      slot.draftId !== draft.id ||
      positions.has(slot.position) ||
      (!slot.isDeleted && (mediaIds.has(slot.mediaId) || slot.position !== activePosition++))
    ) {
      throw new DraftError({ code: 'DATA_INTEGRITY_CONFLICT' })
    }
    positions.add(slot.position)
    if (!slot.isDeleted) {
      mediaIds.add(slot.mediaId)
    }
  }
  return { draft, session, slots }
}
/** Restoration retains inactive media IDs and literal text; it is not save eligibility. */
export function draftResult({
  draft,
  slots,
}: {
  draft: DraftRecord
  slots: readonly DraftSlot[]
}): DraftResult {
  const input = normalizeCreationInput({
    value: {
      description: draft.description,
      inputMediaIds: slots.filter((slot) => !slot.isDeleted).map((slot) => slot.mediaId),
      userNotes: draft.userNotes,
    },
  })
  return Object.freeze({ input, updatedAt: draft.updatedAt })
}
function validateIdentity({ sessionId, userId }: { sessionId: number; userId: number }) {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new DraftError({ code: 'UNAUTHENTICATED' })
  }
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
    throw new CreationInputError({ message: 'Session ID must be a positive safe integer.' })
  }
}
