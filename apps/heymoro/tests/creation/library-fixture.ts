import type { Payload } from 'payload'

import { randomUUID } from 'node:crypto'

import { createPayloadArtifactFavorite } from '../../src/creation/infrastructure/payload/artifact-favorite-repository.js'
import { createPayloadOwnerLibrary } from '../../src/creation/infrastructure/payload/owner-library-repository.js'
import { createRedisCreationCoordinator } from '../../src/creation/infrastructure/redis/coordinator.js'
import { close, sqlRows, workerFixture } from './generation-worker-fixture.js'
import { gate } from './sqlite.config.js'

export const cursorKey = new Uint8Array(32).fill(37)
export async function libraryFixture({ count = 1, payload }: { count?: number; payload: Payload }) {
  const f = await workerFixture({ cost: 0, payload })
  await f.running.run({ taskId: f.taskId })
  for (let index = 1; index < count; index++) {
    const input = { ...f.input, inputMediaIds: f.mediaIds }
    const args = { input, sessionId: f.sessionId, userId: f.userId }
    const quote = await f.admission.quoteGenerate(args)
    const accepted = await f.admission.submitGenerate({
      ...args,
      clientRequestId: `library-${index}`,
      quoteToken: quote.quoteToken,
    })
    await f.running.run({ taskId: accepted.task.id })
  }
  const coordinator = createRedisCreationCoordinator({
    client: f.redis.client,
    config: {
      acquireTimeoutMs: 5000,
      commandTimeoutMs: 500,
      leaseMs: 3000,
      maxHoldMs: 15000,
      namespace: `favorite-${randomUUID()}`,
      renewEveryMs: 500,
      retryDelayMs: 5,
    },
  })
  const options = {
    gate,
    payload,
    ...coordinator,
    clock: () => f.state.now,
    retry: { backoffMs: 0, maxAttempts: 1 },
  }
  const artifacts = await sqlRows(f, 'artifacts')
  return {
    ...f,
    artifacts,
    favorite: createPayloadArtifactFavorite(options),
    library: createPayloadOwnerLibrary({ cursorKey, payload }),
    options,
  }
}
export async function cleanupLibrary() {
  while (close.length) {
    await close.pop()!()
  }
}
export async function favorites(f: Awaited<ReturnType<typeof libraryFixture>>) {
  return sqlRows(f, 'saved_artifacts')
}
