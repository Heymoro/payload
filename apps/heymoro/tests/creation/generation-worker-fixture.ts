import type { Payload } from 'payload'

import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { expect } from 'vitest'

import type { GenerationEngine } from '../../src/creation/application/generation-worker.js'

import { createPayloadGenerationWorker } from '../../src/creation/infrastructure/payload/generation-worker-repository.js'
import { createPayloadMediaService } from '../../src/creation/infrastructure/payload/media-repository.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createRedisCreationCoordinator } from '../../src/creation/infrastructure/redis/coordinator.js'
import { createS3ObjectStorage } from '../../src/creation/infrastructure/s3/object-storage.js'
import { execution, grant, NOW, seed, service } from './generation-fixture.js'
import { startRedisFixture } from './redis-fixture.js'
import { startS3HTTPFixture } from './s3-http-fixture.js'
import { gate, registerGenerationFixture } from './sqlite.config.js'

export const imageLimits = {
  allowedMimeTypes: ['image/png'],
  maxBytes: 100_000,
  maxPixels: 100_000,
  timeoutMs: 1000,
}
export const close: (() => Promise<void>)[] = []
export const image = (background = 'blue') =>
  sharp({ create: { background, channels: 3, height: 2, width: 3 } })
    .png()
    .toBuffer()

export async function workerFixture({
  cost = 2,
  execution: configuredExecution = execution,
  grantAmount = 7,
  grants,
  payload,
}: {
  cost?: number
  execution?: typeof execution
  grantAmount?: number
  grants?: { amount: number; expiresAt: null | string }[]
  payload: Payload
}) {
  const redis = await startRedisFixture()
  close.push(redis.stop)
  const namespace = `worker-${randomUUID()}`
  const coordinator = createRedisCreationCoordinator({
    client: redis.client,
    config: {
      acquireTimeoutMs: 5000,
      commandTimeoutMs: 500,
      leaseMs: 3000,
      maxHoldMs: 15000,
      namespace,
      renewEveryMs: 500,
      retryDelayMs: 5,
    },
  })
  const http = await startS3HTTPFixture()
  close.push(http.close)
  const storage = createS3ObjectStorage({
    backends: [
      {
        backend: 'fixture-metadata',
        buckets: ['fixture-output', 'fixture-input'],
        credentials: http.credentials,
        endpoint: http.endpoint,
        forcePathStyle: true,
        region: 'fixture',
      },
    ],
    image: imageLimits,
    limits: {
      connectionTimeoutMs: 100,
      maxBytes: 100_000,
      operationTimeoutMs: 1000,
      requestTimeoutMs: 250,
    },
  })
  close.push(async () => storage.close())
  await storage.verifyBackend({ backend: 'fixture-metadata', bucket: 'fixture-output' })
  await storage.verifyBackend({ backend: 'fixture-metadata', bucket: 'fixture-input' })
  const adapter = getCreationSQLiteAdapter({ payload })
  const assertOutside = async () => {
    expect(Object.keys(adapter.sessions)).toHaveLength(0)
    expect(await redis.client.keys(`${namespace}:*`)).toHaveLength(0)
  }
  http.observe(assertOutside)
  const state = {
    calls: 0,
    engine: (async () => ({
      bytes: await image('green'),
      contentType: 'image/png',
      kind: 'output',
      requestId: 'fixture-request',
    })) as GenerationEngine,
    now: NOW,
  }
  const options = {
    gate,
    payload,
    ...coordinator,
    clock: () => state.now,
    retry: { backoffMs: 1, maxAttempts: 3 },
  }
  const media = createPayloadMediaService({
    ...options,
    destination: { backend: 'fixture-metadata', bucket: 'fixture-input' },
    imageLimits,
    storage,
  })
  const fixture = await seed({ cost, payload })
  const bytes = [await image('red'), await image('blue')]
  const mediaIds: number[] = []
  for (const input of bytes) {
    mediaIds.push(
      (await media.uploadForUser({ input, originalName: 'input.png', userId: fixture.userId })).id,
    )
  }
  for (const [index, batch] of (
    grants ?? (cost ? [{ amount: grantAmount, expiresAt: null }] : [])
  ).entries()) {
    await grant({ payload, userId: fixture.userId, ...batch, key: `worker-grant-${index}` })
  }
  const admission = service({ ...options, execution: configuredExecution })
  const quote = await admission.quoteGenerate({
    input: { ...fixture.input, inputMediaIds: mediaIds },
    sessionId: fixture.sessionId,
    userId: fixture.userId,
  })
  const accepted = await admission.submitGenerate({
    clientRequestId: 'worker-request',
    input: { ...fixture.input, inputMediaIds: mediaIds },
    quoteToken: quote.quoteToken,
    sessionId: fixture.sessionId,
    userId: fixture.userId,
  })
  const worker = (overrides: Partial<Parameters<typeof createPayloadGenerationWorker>[0]> = {}) =>
    createPayloadGenerationWorker({
      ...options,
      engine: async (args) => {
        await assertOutside()
        state.calls++
        expect(args.images.map((item) => Buffer.from(item.bytes))).toEqual(bytes)
        expect(JSON.stringify(args)).not.toMatch(/storage|bucket|references\/|secret|credential/)
        return state.engine(args)
      },
      engineTimeoutMs: 1000,
      execution: configuredExecution,
      imageLimits,
      leaseMs: 10_000,
      storage,
      trustedClose: { actor: 'system:fixture-reconciler', reasons: ['PROVIDER_UNRESOLVED'] },
      ...overrides,
    })
  const running = worker()
  const unregister = registerGenerationFixture({ payload, run: running.run })
  close.push(async () => {
    unregister()
  })
  return {
    ...fixture,
    adapter,
    admission,
    assertOutside,
    bytes,
    http,
    mediaIds,
    redis,
    running,
    state,
    storage,
    taskId: accepted.task.id,
    worker,
  }
}

export function barrier() {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return { enter, entered, release, released }
}
export async function sqlRows(fixture: Awaited<ReturnType<typeof workerFixture>>, table: string) {
  return (await fixture.adapter.client.execute(`SELECT * FROM ${table} ORDER BY id`)).rows
}
