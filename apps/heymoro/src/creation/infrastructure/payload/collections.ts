import type { CollectionConfig, Field } from 'payload'

import type { CreationWriteGate } from './write-gate.js'

import { validateFavoriteDocument } from '../../domain/library.js'
import { auditFields, validateAudit } from './collection-audit.js'
import { createCurrentTemplateCollection } from './current-template-collection.js'

export const creationCollectionSlugs = [
  'taxonomy-terms',
  'creation-templates',
  'creation-sessions',
  'creation-drafts',
  'draft-inputs',
  'credit-accounts',
  'credit-grants',
  'credit-ledger',
  'generation-tasks',
  'generation-inputs',
  'generation-attempts',
  'artifacts',
  'saved-artifacts',
  'session-shares',
  'credit-reservations',
  'credit-allocations',
] as const
export type CreationCollectionSlug = (typeof creationCollectionSlugs)[number]

export function createCreationCollections({
  gate,
}: {
  gate: CreationWriteGate
}): CollectionConfig[] {
  const collection = ({
    slug,
    dbName,
    fields,
    indexes,
  }: {
    dbName: string
    fields: Field[]
    indexes: CollectionConfig['indexes']
    slug: CreationCollectionSlug
  }): CollectionConfig => ({
    slug,
    access: {
      admin: () => false,
      create: () => false,
      delete: () => false,
      read: () => false,
      update: () => false,
    },
    admin: { hidden: true },
    dbName,
    fields: [...auditFields(), ...fields],
    hooks: {
      afterChange: [
        ({ doc, req }) => {
          gate.assert({ req })
          return doc
        },
      ],
      beforeChange: [
        ({ data, operation, originalDoc, req }) => {
          gate.assert({ req })
          validateAudit({ data, isUpdate: operation === 'update', originalDoc })
          validateCreditDocument({ slug, data, isUpdate: operation === 'update', originalDoc })
          validateGenerationDocument({ slug, data, isUpdate: operation === 'update', originalDoc })
          if (slug === 'saved-artifacts') {
            validateFavoriteDocument({
              data,
              originalDoc: operation === 'update' ? originalDoc : undefined,
            })
          }
          return data
        },
      ],
      beforeDelete: [
        () => {
          throw new Error('Physical creation deletion is forbidden.')
        },
      ],
      beforeOperation: [gate.beforeOperation],
    },
    lockDocuments: false,
    timestamps: true,
    versions: false,
    // SQLite ordinary indexes already carry the INTEGER PK rowid as an implicit suffix.
    indexes,
  })

  return [
    collection({
      slug: 'session-shares',
      dbName: 'session_shares',
      fields: [
        number({ name: 'sessionId' }),
        number({ name: 'templateId' }),
        text({ name: 'publicKey', maxLength: 32 }),
        text({ name: 'title', maxLength: 100 }),
        select({ name: 'status', options: ['published', 'revoked'] }),
        { name: 'artifactIdsJson', type: 'textarea', required: true },
      ],
      indexes: [{ fields: ['sessionId'] }, { fields: ['publicKey'] }],
    }),
    collection({
      slug: 'saved-artifacts',
      dbName: 'saved_artifacts',
      fields: [
        number({ name: 'userId' }),
        number({ name: 'artifactId' }),
        { name: 'savedAt', type: 'date', required: true },
      ],
      indexes: [
        { fields: ['userId', 'artifactId'] },
        { fields: ['userId', 'isDeleted', 'savedAt'] },
      ],
    }),
    collection({
      slug: 'generation-tasks',
      dbName: 'generation_tasks',
      fields: [
        ...['userId', 'sessionId', 'roundNo', 'templateId'].map((name) => number({ name })),
        number({ name: 'sourceTaskId', required: false }),
        text({ name: 'clientRequestId', maxLength: 128 }),
        text({ name: 'requestHash', maxLength: 64 }),
        select({
          name: 'status',
          options: ['queued', 'running', 'succeeded', 'failed', 'unknown', 'closed', 'cancelled'],
        }),
        ...['description', 'userNotes', 'executionSnapshotJson'].map((name): Field => ({
          name,
          type: 'textarea',
          defaultValue: name === 'executionSnapshotJson' ? '{}' : '',
          required: true,
          validate: () => true,
          ...(name === 'executionSnapshotJson'
            ? { access: { read: () => false }, hidden: true }
            : {}),
        })),
        number({ name: 'costCredits', minimum: 0 }),
        { name: 'startedAt', type: 'date' },
        { name: 'finishedAt', type: 'date' },
        { name: 'errorCode', type: 'text', maxLength: 80 },
      ],
      indexes: [
        { fields: ['userId', 'clientRequestId'] },
        { fields: ['sessionId', 'roundNo'] },
        { fields: ['userId', 'status', 'isDeleted'] },
        { fields: ['sessionId', 'isDeleted'] },
      ],
    }),
    collection({
      slug: 'generation-attempts',
      dbName: 'generation_attempts',
      fields: [
        number({ name: 'taskId' }),
        number({ name: 'attemptNo' }),
        text({ name: 'provider', maxLength: 32 }),
        text({ name: 'model', maxLength: 100 }),
        select({
          name: 'status',
          options: ['prepared', 'sending', 'output_ready', 'succeeded', 'failed', 'unknown'],
        }),
        { name: 'providerRequestId', type: 'text', maxLength: 128 },
        ...['leaseUntil', 'startedAt', 'finishedAt'].map((name): Field => ({ name, type: 'date' })),
        { name: 'errorCode', type: 'text', maxLength: 80 },
        ...['resultStorageBackend', 'resultStorageBucket', 'resultStorageKey', 'resultSha256'].map(
          (name): Field => ({
            name,
            type: 'text',
            access: { read: () => false },
            hidden: true,
            maxLength: name === 'resultStorageKey' ? 512 : 128,
          }),
        ),
      ],
      indexes: [
        { fields: ['taskId', 'attemptNo'] },
        { fields: ['status', 'leaseUntil', 'isDeleted'] },
      ],
    }),
    collection({
      slug: 'generation-inputs',
      dbName: 'generation_inputs',
      fields: [
        ...['taskId', 'userId', 'mediaId', 'position'].map((name) => number({ name })),
        text({ name: 'contentSha256', maxLength: 64 }),
      ],
      indexes: [
        { fields: ['taskId', 'position'] },
        { fields: ['taskId', 'mediaId'] },
        { fields: ['mediaId', 'isDeleted'] },
      ],
    }),
    collection({
      slug: 'artifacts',
      dbName: 'artifacts',
      fields: ['userId', 'sessionId', 'taskId', 'mediaId', 'outputIndex'].map((name) =>
        number({ name }),
      ),
      indexes: [
        { fields: ['taskId', 'outputIndex'] },
        { fields: ['userId', 'isDeleted', 'createdAt'] },
        { fields: ['mediaId'] },
      ],
    }),
    collection({
      slug: 'credit-reservations',
      dbName: 'credit_reservations',
      fields: [
        ...['accountId', 'userId', 'taskId'].map((name) => number({ name })),
        text({ name: 'reservationKey', maxLength: 160 }),
        number({ name: 'amountCredits', minimum: 0 }),
        select({ name: 'status', options: ['reserved', 'captured', 'released', 'reconciliation'] }),
        { name: 'settledAt', type: 'date' },
        { name: 'reviewAfter', type: 'date' },
      ],
      indexes: [
        { fields: ['taskId'] },
        { fields: ['reservationKey'] },
        { fields: ['accountId', 'status', 'isDeleted'] },
        { fields: ['userId', 'status'] },
      ],
    }),
    collection({
      slug: 'credit-allocations',
      dbName: 'credit_allocations',
      fields: [
        ...['reservationId', 'grantId', 'amountCredits'].map((name) => number({ name })),
        select({ name: 'status', options: ['reserved', 'captured', 'released', 'expired'] }),
      ],
      indexes: [
        { fields: ['reservationId', 'grantId'] },
        { fields: ['grantId', 'status', 'isDeleted'] },
      ],
    }),
    collection({
      slug: 'credit-accounts',
      dbName: 'credit_accounts',
      fields: [
        number({ name: 'userId' }),
        number({ name: 'availableCredits', defaultValue: 0, minimum: 0 }),
        number({ name: 'reservedCredits', defaultValue: 0, minimum: 0 }),
      ],
      indexes: [{ fields: ['userId'] }],
    }),
    collection({
      slug: 'credit-grants',
      dbName: 'credit_grants',
      fields: [
        number({ name: 'accountId' }),
        number({ name: 'userId' }),
        text({ name: 'grantKey', maxLength: 160 }),
        select({ name: 'sourceType', options: ['trial', 'subscription', 'topup', 'compensation'] }),
        { name: 'sourceId', type: 'text', maxLength: 128 },
        number({ name: 'issuedCredits' }),
        ...[
          'availableCredits',
          'reservedCredits',
          'consumedCredits',
          'expiredCredits',
          'revokedCredits',
        ].map((name) => number({ name, defaultValue: 0, minimum: 0 })),
        { name: 'validFrom', type: 'date', required: true },
        { name: 'expiresAt', type: 'date' },
      ],
      indexes: [
        { fields: ['grantKey'] },
        { fields: ['userId'] },
        { fields: ['accountId', 'isDeleted', 'expiresAt'] },
      ],
    }),
    collection({
      slug: 'credit-ledger',
      dbName: 'credit_ledger',
      fields: [
        number({ name: 'accountId' }),
        number({ name: 'userId' }),
        number({ name: 'grantId' }),
        number({ name: 'reservationId', required: false }),
        text({ name: 'eventKey', maxLength: 200 }),
        select({
          name: 'operation',
          options: ['grant', 'reserve', 'capture', 'release', 'expire', 'revoke', 'compensate'],
        }),
        number({ name: 'amountCredits' }),
        ...['availableDelta', 'reservedDelta', 'consumedDelta', 'expiredDelta', 'revokedDelta'].map(
          (name) => number({ name, defaultValue: 0, minimum: Number.MIN_SAFE_INTEGER }),
        ),
        text({ name: 'reasonCode', maxLength: 80 }),
      ],
      indexes: [
        { fields: ['eventKey'] },
        { fields: ['userId', 'createdAt'] },
        { fields: ['accountId', 'createdAt'] },
        { fields: ['reservationId'] },
        { fields: ['grantId'] },
      ],
    }),
    collection({
      slug: 'taxonomy-terms',
      dbName: 'taxonomy_terms',
      fields: [
        select({ name: 'kind', options: ['category', 'label'] }),
        text({ name: 'code', maxLength: 64 }),
        text({ name: 'name', maxLength: 80 }),
        select({ name: 'status', options: ['active', 'hidden'] }),
        number({ name: 'sortOrder', defaultValue: 0, minimum: Number.MIN_SAFE_INTEGER }),
      ],
      indexes: [
        { fields: ['kind', 'code'] },
        { fields: ['kind', 'status', 'isDeleted', 'sortOrder'] },
      ],
    }),
    createCurrentTemplateCollection({ gate }),
    collection({
      slug: 'creation-sessions',
      dbName: 'creation_sessions',
      fields: [
        number({ name: 'userId' }),
        text({ name: 'clientRequestId', maxLength: 128 }),
        text({ name: 'requestHash', maxLength: 64 }),
        number({ name: 'templateId' }),
        select({ name: 'mode', options: ['effect', 'free'] }),
        text({ name: 'title', maxLength: 100 }),
        select({ name: 'titleSource', options: ['template', 'ai', 'user'] }),
        select({
          name: 'autoNameStatus',
          defaultValue: 'idle',
          options: ['idle', 'pending', 'sending', 'succeeded', 'failed', 'unknown', 'skipped'],
        }),
        { name: 'autoNameStartedAt', type: 'date' },
        { name: 'autoNamedAt', type: 'date' },
        number({ name: 'coverArtifactId', required: false }),
        { name: 'lastActivityAt', type: 'date', required: true },
        number({ name: 'nextRoundNo', defaultValue: 1 }),
      ],
      indexes: [
        { fields: ['userId', 'clientRequestId'] },
        { fields: ['userId', 'isDeleted', 'lastActivityAt'] },
      ],
    }),
    collection({
      slug: 'draft-inputs',
      dbName: 'draft_inputs',
      fields: [
        number({ name: 'draftId' }),
        number({ name: 'userId' }),
        number({ name: 'mediaId' }),
        number({ name: 'position' }),
      ],
      indexes: [
        { fields: ['draftId', 'position'] },
        { fields: ['mediaId'] },
        { fields: ['userId', 'isDeleted'] },
      ],
    }),
    collection({
      slug: 'creation-drafts',
      dbName: 'creation_drafts',
      fields: [
        number({ name: 'userId' }),
        number({ name: 'sessionId' }),
        ...['description', 'userNotes'].map((name): Field => ({
          name,
          type: 'textarea',
          defaultValue: '',
          required: true,
          validate: () => true,
        })),
      ],
      indexes: [{ fields: ['sessionId'] }, { fields: ['userId', 'isDeleted', 'updatedAt'] }],
    }),
  ]
}

function text({ name, maxLength }: { maxLength: number; name: string }): Field {
  return { name, type: 'text', maxLength, required: true }
}

function number({
  name,
  defaultValue,
  minimum = 1,
  required = true,
}: {
  defaultValue?: number
  minimum?: number
  name: string
  required?: boolean
}): Field {
  return {
    name,
    type: 'number',
    required,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    validate: (value: unknown) => {
      if (value == null) {
        return !required || 'Expected a required integer.'
      }
      return (
        (typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum) ||
        `Expected an integer of at least ${minimum}.`
      )
    },
  }
}

function select({
  name,
  defaultValue,
  options,
}: {
  defaultValue?: string
  name: string
  options: string[]
}): Field {
  return {
    name,
    type: 'select',
    options,
    required: true,
    ...(defaultValue === undefined ? {} : { defaultValue }),
  }
}

function validateCreditDocument({
  slug,
  data,
  isUpdate,
  originalDoc,
}: {
  data: Record<string, unknown>
  isUpdate: boolean
  originalDoc?: Record<string, unknown>
  slug: CreationCollectionSlug
}) {
  if (!slug.startsWith('credit-')) {
    return
  }
  if (slug === 'credit-ledger' && (isUpdate || data.isDeleted === true)) {
    throw new Error('Credit ledger is append-only.')
  }
  if (isUpdate && originalDoc) {
    const fields =
      slug === 'credit-accounts'
        ? ['userId']
        : slug === 'credit-grants'
          ? [
              'accountId',
              'userId',
              'grantKey',
              'sourceType',
              'sourceId',
              'issuedCredits',
              'validFrom',
              'expiresAt',
            ]
          : []
    for (const field of fields) {
      if (Object.hasOwn(data, field) && (data[field] ?? null) !== (originalDoc[field] ?? null)) {
        throw new Error(`Credit ${field} is immutable.`)
      }
    }
  }
  if (slug === 'credit-grants') {
    const merged = { ...originalDoc, ...data }
    let total = 0
    for (const field of [
      'availableCredits',
      'reservedCredits',
      'consumedCredits',
      'expiredCredits',
      'revokedCredits',
    ]) {
      const value = merged[field] ?? 0
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        !Number.isSafeInteger(total + value)
      ) {
        throw new Error('Credit grant requires nonnegative safe integer balances.')
      }
      total += value
    }
    if (total !== merged.issuedCredits) {
      throw new Error('Credit grant conservation conflict.')
    }
  }
}

function validateGenerationDocument({
  slug,
  data,
  isUpdate,
  originalDoc,
}: {
  data: Record<string, unknown>
  isUpdate: boolean
  originalDoc?: Record<string, unknown>
  slug: CreationCollectionSlug
}) {
  const immutable: Partial<Record<CreationCollectionSlug, string[]>> = {
    artifacts: ['userId', 'sessionId', 'taskId', 'mediaId', 'outputIndex'],
    'credit-allocations': ['reservationId', 'grantId', 'amountCredits'],
    'credit-reservations': ['accountId', 'userId', 'taskId', 'reservationKey', 'amountCredits'],
    'generation-attempts': ['taskId', 'attemptNo', 'provider', 'model'],
    'generation-inputs': ['taskId', 'userId', 'mediaId', 'position', 'contentSha256'],
    'generation-tasks': [
      'userId',
      'sessionId',
      'roundNo',
      'templateId',
      'sourceTaskId',
      'clientRequestId',
      'requestHash',
      'description',
      'userNotes',
      'executionSnapshotJson',
      'costCredits',
    ],
  }
  if (slug === 'generation-attempts') {
    const merged = { ...originalDoc, ...data }
    const results = [
      'resultStorageBackend',
      'resultStorageBucket',
      'resultStorageKey',
      'resultSha256',
    ]
    const present = results.filter((field) => merged[field] != null)
    if (merged.isDeleted === true || (present.length !== 0 && present.length !== results.length)) {
      throw new Error('Attempt evidence must be complete and cannot be hidden.')
    }
    if (
      present.length &&
      (typeof merged.resultSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(merged.resultSha256))
    ) {
      throw new Error('Attempt fingerprint is invalid.')
    }
    if (
      ['output_ready', 'succeeded'].includes(String(merged.status)) &&
      present.length !== results.length
    ) {
      throw new Error('Output attempt requires complete evidence.')
    }
    const transitions: Record<string, string[]> = {
      failed: ['failed'],
      output_ready: ['output_ready', 'succeeded'],
      prepared: ['prepared', 'sending', 'failed'],
      sending: ['sending', 'unknown', 'output_ready', 'failed'],
      succeeded: ['succeeded'],
      unknown: ['unknown', 'output_ready'],
    }
    if (
      isUpdate &&
      originalDoc &&
      !transitions[String(originalDoc.status)]?.includes(String(merged.status))
    ) {
      throw new Error('Illegal attempt transition.')
    }
    if (
      isUpdate &&
      originalDoc &&
      originalDoc.resultSha256 != null &&
      results.some((field) => merged[field] !== originalDoc[field])
    ) {
      throw new Error('Attempt output evidence is immutable.')
    }
  }
  const fields = immutable[slug]
  if (!fields) {
    return
  }
  const merged = { ...originalDoc, ...data }
  if (
    merged.isDeleted === true &&
    (slug === 'generation-inputs' ||
      slug === 'credit-allocations' ||
      (slug === 'generation-tasks' &&
        ['queued', 'running', 'unknown'].includes(String(merged.status))) ||
      (slug === 'credit-reservations' &&
        ['reconciliation', 'reserved'].includes(String(merged.status))))
  ) {
    throw new Error('Active generation evidence may not be hidden.')
  }
  if (isUpdate && originalDoc) {
    for (const field of fields) {
      if (Object.hasOwn(data, field) && (data[field] ?? null) !== (originalDoc[field] ?? null)) {
        throw new Error(`Generation ${field} is immutable.`)
      }
    }
  }
}
