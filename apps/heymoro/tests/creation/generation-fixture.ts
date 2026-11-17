import type { Payload, PayloadRequest } from 'payload'

import { createQuoteCodec } from '../../src/creation/domain/quote.js'
import { createPayloadCreditsService } from '../../src/creation/infrastructure/payload/credits-repository.js'
import { createPayloadGenerationService } from '../../src/creation/infrastructure/payload/generation-repository.js'
import { createCreationRuntime } from '../../src/creation/infrastructure/payload/session-repository.js'
import {
  createSQLiteUnitOfWork,
  getCreationSQLiteAdapter,
} from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { gate } from './sqlite.config.js'

export const NOW = '2026-11-12T12:00:00.000Z'
export const caps = {
  allowedMimeTypes: ['image/png', 'image/jpeg'],
  maxDescriptionLength: 200,
  maxImageBytes: 1000,
  maxImages: 4,
  maxNotesLength: 100,
  maxTotalImageBytes: 1500,
  minImages: 0,
}
export const codecConfig = {
  audience: 'fixture:admission',
  issuer: 'fixture:heymoro',
  keys: { 'fixture-key-1': new Uint8Array(32).fill(17) },
  signingKid: 'fixture-key-1',
  ttlSeconds: 60,
}
export const execution = {
  registry: {
    'fixture-v1': {
      allowedParameters: ['size'],
      model: 'fixture-image-v1',
      parameterRules: {
        size: { type: 'string' as const, isRequired: true, values: ['1024x1024'] },
      },
      provider: 'fixture-local',
      storageBackends: ['fixture-metadata'],
    },
  },
  storageOutput: {
    backend: 'fixture-metadata',
    bucket: 'fixture-output',
    keyRule: 'task-attempt-result-v1' as const,
  },
}
export const audit = {
  createdBy: 'system:generation-fixture',
  deletedAt: null,
  deletedBy: null,
  isDeleted: false,
  updatedBy: 'system:generation-fixture',
}
export function service({
  payload,
  ...options
}: { payload: Payload } & Partial<Parameters<typeof createPayloadGenerationService>[0]>) {
  return createPayloadGenerationService({
    clock: () => NOW,
    coordinateMany: async ({ work }) => work({ assertLease: () => {} }),
    execution,
    gate,
    hostCaps: caps,
    isCompatible: ({ minClientCapability, schemaVersion }) =>
      schemaVersion === 1 && minClientCapability === 'v1',
    payload,
    quoteCodec: createQuoteCodec(codecConfig),
    retry: { backoffMs: 1, maxAttempts: 3 },
    ...options,
  })
}
export function write<T>({
  payload,
  work,
}: {
  payload: Payload
  work: (args: {
    req: PayloadRequest
    runtime: ReturnType<typeof createCreationRuntime>
  }) => Promise<T>
}) {
  const runtime = createCreationRuntime({ gate, payload })
  return createSQLiteUnitOfWork({
    coordinate: async ({ work }) => work({ assertLease: () => {} }),
    gate,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  })({ resource: 'generation-fixture', work: ({ req }) => work({ req, runtime }) })
}
export function update({
  id,
  collection,
  data,
  payload,
}: {
  collection: Parameters<ReturnType<typeof createCreationRuntime>['update']>[0]['collection']
  data: Record<string, unknown>
  id: number
  payload: Payload
}) {
  return write({
    payload,
    work: ({ req, runtime }) =>
      runtime.update({ id, collection, data: { updatedBy: audit.updatedBy, ...data }, req }),
  })
}
export async function rows({ payload, table }: { payload: Payload; table: string }) {
  return (
    await getCreationSQLiteAdapter({ payload }).client.execute(`SELECT * FROM ${table} ORDER BY id`)
  ).rows
}
export async function seed({
  cost = 2,
  mode = 'effect',
  payload,
  userId: existingUserId,
}: {
  cost?: number
  mode?: 'effect' | 'free'
  payload: Payload
  userId?: number
}) {
  const userId =
    existingUserId ??
    Number(
      (
        await payload.create({
          collection: 'users',
          data: { status: 'active' } as never,
          overrideAccess: true,
        })
      ).id,
    )
  return write({
    payload,
    work: async ({ req, runtime }) => {
      const template = await runtime.create({
        collection: 'creation-templates',
        data: {
          ...audit,
          name: 'Fixture',
          code: `fixture-${userId}`,
          costCredits: cost,
          displayConfigJson: JSON.stringify({
            name: 'Fixture',
            coverMediaId: 1,
            examples: [{ inputMediaIds: [], outputMediaId: 1 }],
          }),
          generationConfigJson: JSON.stringify({
            executorId: 'fixture-v1',
            parameters: { size: '1024x1024' },
            systemPrompt: 'PRIVATE SYSTEM INSTRUCTION',
          }),
          inputSchemaJson: JSON.stringify({
            ...caps,
            ...(mode === 'effect'
              ? { maxDescriptionLength: 0, minImages: 1 }
              : { maxNotesLength: 0 }),
          }),
          kind: mode,
          minClientCapability: 'v1',
          schemaVersion: 1,
          shareConfigJson: '{}',
          status: 'published',
        },
        req,
      })
      const session = await runtime.create({
        collection: 'creation-sessions',
        data: {
          ...audit,
          clientRequestId: `session-${template.id}`,
          lastActivityAt: NOW,
          mode,
          requestHash: 'f'.repeat(64),
          templateId: template.id,
          title: 'Fixture',
          titleSource: 'template',
          userId,
        },
        req,
      })
      const mediaIds: number[] = []
      for (let index = 0; index < 2; index++) {
        const media = await runtime.create({
          collection: 'media',
          data: {
            ...audit,
            alt: 'Fixture',
            filename: `fixtures/${session.id}/${index}.png`,
            filesize: 500,
            mimeType: 'image/png',
            originalName: `photo-${index}.png`,
            owner: userId,
            purpose: 'reference',
            sha256: String(index + 1).repeat(64),
            storageBackend: 'fixture-metadata',
            storageBucket: 'fixture-input',
            storageName: `fixtures/${session.id}/${index}.png`,
            visibility: 'private',
          },
          req,
        })
        mediaIds.push(Number(media.id))
      }
      return {
        input: {
          description: mode === 'free' ? '  literal\nuser description  ' : '',
          inputMediaIds: mediaIds,
          userNotes: mode === 'effect' ? '  literal\nnotes  ' : '',
        },
        mediaIds,
        sessionId: Number(session.id),
        templateId: Number(template.id),
        userId,
      }
    },
  })
}
export async function grant({
  amount = 7,
  expiresAt = null,
  key = 'grant-fixture',
  payload,
  userId,
}: {
  amount?: number
  expiresAt?: null | string
  key?: string
  payload: Payload
  userId: number
}) {
  return createPayloadCreditsService({
    actor: 'system:generation-fixture',
    clock: () => NOW,
    coordinate: async ({ work }) => work({ assertLease: () => {} }),
    gate,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  }).issueGrant({
    command: {
      expiresAt,
      grantKey: key,
      issuedCredits: amount,
      sourceType: 'trial',
      validFrom: '2026-11-12T11:00:00.000Z',
    },
    userId,
  })
}

/** Explicit fixture-only T2 evidence; no worker execution or real upstream/storage call. */
export function finishSource({
  isCaptured = true,
  payload,
  sessionId,
  taskId,
  userId,
}: {
  isCaptured?: boolean
  payload: Payload
  sessionId: number
  taskId: number
  userId: number
}) {
  return write({
    payload,
    work: async ({ req, runtime }) => {
      await runtime.update({
        id: taskId,
        collection: 'generation-tasks',
        data: { status: 'succeeded', updatedBy: audit.updatedBy },
        req,
      })
      if (isCaptured) {
        const { docs: reservations } = await runtime.find({
          collection: 'credit-reservations',
          limit: 2,
          req,
          where: { taskId: { equals: taskId } },
        })
        const reservation = reservations[0]!
        const { docs: allocations } = await runtime.find({
          collection: 'credit-allocations',
          limit: 0,
          req,
          where: { reservationId: { equals: reservation.id } },
        })
        for (const allocation of allocations) {
          const { docs: grants } = await runtime.find({
            collection: 'credit-grants',
            limit: 2,
            req,
            where: { id: { equals: allocation.grantId } },
          })
          const grant = grants[0]!
          const amount = Number(allocation.amountCredits)
          await runtime.update({
            id: Number(grant.id),
            collection: 'credit-grants',
            data: {
              consumedCredits: Number(grant.consumedCredits) + amount,
              reservedCredits: Number(grant.reservedCredits) - amount,
              updatedBy: audit.updatedBy,
            },
            req,
          })
          await runtime.update({
            id: Number(allocation.id),
            collection: 'credit-allocations',
            data: { status: 'captured', updatedBy: audit.updatedBy },
            req,
          })
          await runtime.create({
            collection: 'credit-ledger',
            data: {
              ...audit,
              accountId: reservation.accountId,
              amountCredits: amount,
              availableDelta: 0,
              consumedDelta: amount,
              eventKey: `capture:generation:${taskId}:${grant.id}`,
              expiredDelta: 0,
              grantId: grant.id,
              operation: 'capture',
              reasonCode: 'GENERATION_CAPTURED',
              reservationId: reservation.id,
              reservedDelta: -amount,
              revokedDelta: 0,
              userId,
            },
            req,
          })
        }
        const { docs: accounts } = await runtime.find({
          collection: 'credit-accounts',
          limit: 2,
          req,
          where: { id: { equals: reservation.accountId } },
        })
        await runtime.update({
          id: Number(reservation.accountId),
          collection: 'credit-accounts',
          data: {
            reservedCredits:
              Number(accounts[0]!.reservedCredits) - Number(reservation.amountCredits),
            updatedBy: audit.updatedBy,
          },
          req,
        })
        await runtime.update({
          id: Number(reservation.id),
          collection: 'credit-reservations',
          data: { settledAt: NOW, status: 'captured', updatedBy: audit.updatedBy },
          req,
        })
      }
      const output = await runtime.create({
        collection: 'media',
        data: {
          ...audit,
          alt: 'Fixture output',
          filename: `tasks/${taskId}/attempts/1/result-${'c'.repeat(64)}`,
          filesize: 500,
          mimeType: 'image/png',
          originalName: 'result.png',
          owner: userId,
          purpose: 'artifact',
          sha256: 'c'.repeat(64),
          storageBackend: 'fixture-metadata',
          storageBucket: 'fixture-output',
          storageName: `tasks/${taskId}/attempts/1/result-${'c'.repeat(64)}`,
          visibility: 'private',
        },
        req,
      })
      const artifact = await runtime.create({
        collection: 'artifacts',
        data: { ...audit, mediaId: output.id, outputIndex: 1, sessionId, taskId, userId },
        req,
      })
      return Number(artifact.id)
    },
  })
}
