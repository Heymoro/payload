import { createHash } from 'node:crypto'

import type { CreationMode } from '../domain/input.js'
import type { InputSchema } from '../domain/template-config.js'

import { normalizeCreationInput } from '../domain/input.js'
import { hashSessionCommand, normalizeSessionCommand, SessionError } from '../domain/session.js'
import {
  CatalogError,
  parsePublicTemplateConfig,
  validateHostCaps,
} from '../domain/template-config.js'

export type SessionAudit = Readonly<{
  createdAt: string
  createdBy: string
  deletedAt: null | string
  deletedBy: null | string
  isDeleted: boolean
  updatedAt: string
  updatedBy: string
}>

export type SessionRecord = Readonly<{
  autoNamedAt: null | string
  autoNameStartedAt: null | string
  autoNameStatus: 'failed' | 'idle' | 'pending' | 'sending' | 'skipped' | 'succeeded' | 'unknown'
  clientRequestId: string
  coverArtifactId: null | number
  id: number
  lastActivityAt: string
  mode: CreationMode
  nextRoundNo: number
  requestHash: string
  templateId: number
  title: string
  titleSource: 'ai' | 'template' | 'user'
  userId: number
}> &
  SessionAudit

export type EmptyDraftRecord = Readonly<{
  description: string
  id: number
  sessionId: number
  userId: number
  userNotes: string
}> &
  SessionAudit

export type SessionTemplate = Readonly<{
  displayConfigJson: string
  id: number
  inputSchemaJson: string
  isDeleted: boolean
  kind: CreationMode
  minClientCapability: string
  schemaVersion: number
  status: string
}>

export type CreateSessionResult = Readonly<{ isNew: boolean; session: SessionRecord }>

/** All methods are bound to the same short transaction by the host adapter. */
export type SessionCreationRepository = Readonly<{
  findSessionsByRequest: (args: {
    clientRequestId: string
    includeDeleted: true
    userId: number
  }) => Promise<readonly SessionRecord[]>
  insertEmptyDraft: (args: { draft: Omit<EmptyDraftRecord, 'id'> }) => Promise<EmptyDraftRecord>
  insertSession: (args: { session: Omit<SessionRecord, 'id'> }) => Promise<SessionRecord>
  isAccountActive: (args: { userId: number }) => Promise<boolean>
  readTemplate: (args: { templateId: number }) => Promise<null | SessionTemplate>
}>

export type SessionCreationDependencies = Readonly<{
  /** A synchronous local clock returning UTC YYYY-MM-DDTHH:mm:ss.SSSZ. */
  clock: () => string
  hostCaps: InputSchema
  /** A pure, synchronous host policy; this use case does not interpret capability versions. */
  isCompatible: (args: { minClientCapability: string; schemaVersion: number }) => boolean
  /** The host owns coordination, transaction begin/commit/rollback, and failure propagation. */
  runCoordinatedTransaction: (args: {
    resource: string
    work: (args: { repository: SessionCreationRepository }) => Promise<CreateSessionResult>
  }) => Promise<CreateSessionResult>
}>

export function createSessionCreator({
  clock,
  hostCaps,
  isCompatible,
  runCoordinatedTransaction,
}: SessionCreationDependencies) {
  const caps = validateHostCaps({ hostCaps })
  return async function createSession({
    command,
    userId,
  }: {
    command: unknown
    userId: number
  }): Promise<CreateSessionResult> {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new SessionError({
        code: 'UNAUTHENTICATED',
        message: 'An active authenticated account is required.',
        status: 401,
      })
    }
    const normalized = normalizeSessionCommand({ value: command })
    const requestHash = hashSessionCommand({ command: normalized })
    // Hash the tuple, not delimiters containing the arbitrary client-supplied key.
    const resource = `creation-session:${createHash('sha256')
      .update(JSON.stringify({ clientRequestId: normalized.clientRequestId, userId }), 'utf8')
      .digest('hex')}`

    return runCoordinatedTransaction({
      resource,
      work: async ({ repository }) => {
        if (!(await repository.isAccountActive({ userId }))) {
          throw new SessionError({
            code: 'UNAUTHENTICATED',
            message: 'An active authenticated account is required.',
            status: 401,
          })
        }
        const matches = await repository.findSessionsByRequest({
          clientRequestId: normalized.clientRequestId,
          includeDeleted: true,
          userId,
        })

        if (matches.length > 1) {
          throw new SessionError({
            code: 'DATA_INTEGRITY_CONFLICT',
            message: 'Multiple sessions occupy the same account request key.',
            status: 503,
          })
        }
        if (matches.length === 1) {
          const session = matches[0]!

          if (session.isDeleted) {
            throw new SessionError({
              code: 'SESSION_UNAVAILABLE',
              message: 'The original session is unavailable; its request key remains reserved.',
              status: 409,
            })
          }
          if (session.templateId !== normalized.templateId || session.requestHash !== requestHash) {
            throw new SessionError({
              code: 'IDEMPOTENCY_CONFLICT',
              message: 'The request key belongs to a different session creation request.',
              status: 409,
            })
          }

          return { isNew: false, session }
        }

        const template = await repository.readTemplate({ templateId: normalized.templateId })
        if (
          !template ||
          template.isDeleted ||
          template.status !== 'published' ||
          template.id !== normalized.templateId ||
          !['effect', 'free'].includes(template.kind) ||
          !isCompatible({
            minClientCapability: template.minClientCapability,
            schemaVersion: template.schemaVersion,
          })
        ) {
          throw new SessionError({
            code: 'TEMPLATE_UNAVAILABLE',
            message: 'The current template is unavailable or unsupported.',
            status: 409,
          })
        }

        let title: string
        try {
          if (template.displayConfigJson === null || template.inputSchemaJson === null) {
            throw new CatalogError({ code: 'TEMPLATE_UNAVAILABLE' })
          }
          const config = parsePublicTemplateConfig({
            displayConfigJson: template.displayConfigJson,
            hostCaps: caps,
            inputSchemaJson: template.inputSchemaJson,
            kind: template.kind,
            schemaVersion: template.schemaVersion,
          })
          title = config.displayConfig.name
        } catch (error) {
          if (!(error instanceof CatalogError)) {
            throw error
          }
          throw new SessionError({
            code: 'TEMPLATE_UNAVAILABLE',
            message:
              'The specified published template configuration is unavailable or unsupported.',
            status: 409,
          })
        }

        const timestamp = clock()
        const actor = `user:${userId}`
        const audit: SessionAudit = {
          createdAt: timestamp,
          createdBy: actor,
          deletedAt: null,
          deletedBy: null,
          isDeleted: false,
          updatedAt: timestamp,
          updatedBy: actor,
        }
        const session = await repository.insertSession({
          session: {
            ...audit,
            userId,
            ...normalized,
            autoNamedAt: null,
            autoNameStartedAt: null,
            autoNameStatus: 'idle',
            coverArtifactId: null,
            lastActivityAt: timestamp,
            mode: template.kind,
            nextRoundNo: 1,
            requestHash,
            title,
            titleSource: 'template',
          },
        })
        const input = normalizeCreationInput({ value: {} })

        await repository.insertEmptyDraft({
          draft: {
            ...audit,
            description: input.description,
            sessionId: session.id,
            userId,
            userNotes: input.userNotes,
          },
        })

        return { isNew: true, session }
      },
    })
  }
}
