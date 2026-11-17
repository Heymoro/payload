import type { Payload, PayloadRequest } from 'payload'

import { createHash, randomBytes } from 'node:crypto'

import type { CreationWriteGate } from '../../src/creation/infrastructure/payload/write-gate.js'
import type { CoreConfig } from '../../src/creation/runtime/config.js'

import { createPayloadCreditsService } from '../../src/creation/infrastructure/payload/credits-repository.js'
import { createSQLiteUnitOfWork } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { parseCoreConfig } from '../../src/creation/runtime/config.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'

export const now = '2026-11-12T12:00:00.000Z'
export const audit = {
  createdBy: 'system:runtime-fixture',
  deletedAt: null,
  deletedBy: null,
  isDeleted: false,
  updatedBy: 'system:runtime-fixture',
}
export function hostConfig({
  dataDir,
  endpoint = 'http://127.0.0.1:1',
  redisURL = 'redis://127.0.0.1:1/0',
}: {
  dataDir: string
  endpoint?: string
  redisURL?: string
}): CoreConfig {
  return parseCoreConfig({
    value: {
      capabilities: ['v1'],
      cursorKey: Buffer.alloc(32, 11).toString('base64url'),
      dataDir,
      execution: {
        registry: {
          'fixture-v1': {
            allowedParameters: ['size'],
            model: 'gpt-image-1.5',
            parameterRules: { size: { type: 'string', isRequired: true, values: ['1024x1024'] } },
            provider: 'openai',
            storageBackends: ['fixture-metadata'],
          },
        },
        storageOutput: {
          backend: 'fixture-metadata',
          bucket: 'fixture-output',
          keyRule: 'task-attempt-result-v1',
        },
      },
      hostCaps: {
        allowedMimeTypes: ['image/png'],
        maxDescriptionLength: 200,
        maxImageBytes: 1000,
        maxImages: 4,
        maxNotesLength: 100,
        maxTotalImageBytes: 1500,
        minImages: 0,
      },
      identity: {
        sessionTtlSeconds: 3600,
        trial: { issuedCredits: 7, validForSeconds: 86400 },
        wechat: {
          appId: 'fixture-app',
          appSecret: 'explicit-fixture-only-wechat-secret',
          maxResponseBytes: 1024,
          timeoutMs: 100,
        },
      },
      image: {
        apiKey: 'explicit-fixture-only-image-key',
        engineBudgetMs: 1000,
        maxInputBytes: 1000,
        maxOutputBytes: 100000,
        maxResponseBytes: 200000,
        maxTotalInputBytes: 1500,
        registered: [{ executorId: 'fixture-v1', model: 'gpt-image-1.5', provider: 'openai' }],
        timeoutMs: 1000,
      },
      imageLimits: {
        allowedMimeTypes: ['image/png'],
        maxBytes: 100000,
        maxPixels: 100000,
        timeoutMs: 1000,
      },
      naming: {
        apiKey: 'explicit-fixture-only-naming-key',
        engineBudgetMs: 1000,
        maxInputBytes: 100000,
        maxResponseBytes: 64000,
        registered: {
          model: 'explicit-fixture-naming-model',
          parameters: { max_output_tokens: 128 },
          provider: 'openai',
        },
        timeoutMs: 1000,
      },
      namingWorker: { engineTimeoutMs: 1000, leaseMs: 2000 },
      payloadSecret: 'explicit-isolated-runtime-test-secret-only',
      publicApiUrl: 'http://127.0.0.1:3001',
      quote: {
        audience: 'fixture:admission',
        issuer: 'fixture:core',
        keys: { fixture: Buffer.alloc(32, 17).toString('base64url') },
        signingKid: 'fixture',
        ttlSeconds: 60,
      },
      redis: {
        acquireTimeoutMs: 5000,
        commandTimeoutMs: 500,
        connectTimeoutMs: 200,
        leaseMs: 3000,
        maxHoldMs: 15000,
        namespace: 'runtime-fixture',
        renewEveryMs: 500,
        retryDelayMs: 5,
        url: redisURL,
      },
      s3: {
        backends: [
          {
            backend: 'fixture-metadata',
            buckets: ['fixture-input', 'fixture-output'],
            credentials: { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' },
            endpoint,
            forcePathStyle: true,
            region: 'fixture',
          },
        ],
        input: { backend: 'fixture-metadata', bucket: 'fixture-input' },
        limits: {
          connectionTimeoutMs: 100,
          maxBytes: 100000,
          operationTimeoutMs: 2000,
          requestTimeoutMs: 500,
        },
        output: { backend: 'fixture-metadata', bucket: 'fixture-output' },
      },
      worker: { engineTimeoutMs: 1000, leaseMs: 10000 },
    },
  })
}

export function controlledWrite<T>({
  gate,
  payload,
  work,
}: {
  gate: CreationWriteGate
  payload: Payload
  work: (args: { req: PayloadRequest }) => Promise<T>
}) {
  return createSQLiteUnitOfWork({
    coordinate: async ({ work: execute }) => execute({ assertLease: () => {} }),
    gate,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  })({ resource: 'runtime-test-seed', work })
}
export async function seedIdentity({
  gate,
  payload,
}: {
  gate: CreationWriteGate
  payload: Payload
}) {
  const token = randomBytes(32).toString('base64url')
  return controlledWrite({
    gate,
    payload,
    work: async ({ req }) => {
      const user = await gate.run({
        req,
        work: () =>
          payload.create({
            collection: 'users',
            data: { ...audit, displayName: 'Runtime user', status: 'active' } as never,
            overrideAccess: true,
            req,
          }),
      })
      const session = await gate.run({
        req,
        work: () =>
          payload.create({
            collection: 'userSessions',
            data: {
              ...audit,
              expiresAt: '2026-11-13T12:00:00.000Z',
              tokenHash: createHash('sha256').update(token).digest('hex'),
              user: user.id,
            } as never,
            overrideAccess: true,
            req,
          }),
      })
      return { sessionId: Number(session.id), token, userId: Number(user.id) }
    },
  })
}
export async function seedChain({
  config,
  gate,
  payload,
}: {
  config: CoreConfig
  gate: CreationWriteGate
  payload: Payload
}) {
  const identity = await seedIdentity({ gate, payload })
  const admin = await controlledWrite({
    gate,
    payload,
    work: ({ req }) =>
      gate.run({
        req,
        work: () =>
          payload.create({
            collection: 'admins',
            data: {
              email: `fixture-${identity.userId}@local.invalid`,
              password: 'fixture-local-password-137',
              role: 'admin',
              status: 'active',
            },
            overrideAccess: true,
            req,
          }),
      }),
  })
  const services = getCoreRuntime({ payload })
  const template = await services.templates.create({
    adminId: Number(admin.id),
    code: 'free',
    configuration: {
      costCredits: 2,
      displayConfigJson: JSON.stringify({ name: 'Runtime free', coverMediaId: null, examples: [] }),
      generationConfigJson: JSON.stringify({
        executorId: 'fixture-v1',
        parameters: { size: '1024x1024' },
        systemPrompt: 'PRIVATE runtime fixture instruction',
      }),
      inputSchemaJson: JSON.stringify({ ...config.hostCaps, maxNotesLength: 0 }),
      minClientCapability: 'v1',
      schemaVersion: 1,
      shareConfigJson: '{}',
    },
    kind: 'free',
  })
  await services.templates.setStatus({
    adminId: Number(admin.id),
    status: 'published',
    templateId: template.id,
  })
  const credits = createPayloadCreditsService({
    actor: 'system:runtime-fixture',
    clock: () => now,
    coordinate: async ({ work }) => work({ assertLease: () => {} }),
    gate,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  })
  await credits.issueGrant({
    command: {
      expiresAt: null,
      grantKey: `trusted-fixture:${identity.userId}`,
      issuedCredits: 7,
      sourceId: 'trusted-fixture-only',
      sourceType: 'trial',
      validFrom: now,
    },
    userId: identity.userId,
  })
  return {
    ...identity,
    adminId: Number(admin.id),
    templateId: template.id,
  }
}
