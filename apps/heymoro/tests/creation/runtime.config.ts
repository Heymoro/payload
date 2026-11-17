import type { Payload } from 'payload'

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

import { testDataConfigSymbol } from '../../../../test/__helpers/shared/clearAndSeed/testDataConfig.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createCreationWriteGate } from '../../src/creation/infrastructure/payload/write-gate.js'
import { createCreationRedisClient } from '../../src/creation/infrastructure/redis/client.js'
import { RedisCoordinationError } from '../../src/creation/infrastructure/redis/coordinator.js'
import { buildCorePayloadConfig } from '../../src/creation/runtime/payload-config.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'
import { prepareTarget } from '../../src/creation/runtime/target-profile.js'
import { startRedisFixture } from './redis-fixture.js'
import { hostConfig, now } from './runtime-seed.js'
import { startS3HTTPFixture } from './s3-http-fixture.js'

export const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'heymoro-core-runtime-')))
export const gate = createCreationWriteGate()
export const redis = await startRedisFixture()
export const http = await startS3HTTPFixture()
export const config = hostConfig({
  dataDir: path.join(directory, 'target'),
  endpoint: http.endpoint,
  redisURL: redis.url,
})
export const state = {
  beforeWechat: null as (() => Promise<void>) | null,
  imageCalls: 0,
  imagePlans: [] as string[],
  kind: 'output' as 'not_sent' | 'output' | 'rejected' | 'unknown',
  namingCalls: 0,
  now,
  redisConnections: 0,
  redisDown: false,
  wechatCalls: 0,
  wechatResult: { openId: 'fixture-open', unionId: null as null | string },
}
let instance: Payload | undefined
export async function cleanupRuntime() {
  if (instance) {
    await getCoreRuntime({ payload: instance }).close()
    getCreationSQLiteAdapter({ payload: instance }).client.close()
  }
  await redis.stop()
  await http.close()
  rmSync(directory, { force: true, recursive: true })
}
const built = buildCorePayloadConfig({
  clock: () => state.now,
  config,
  gate,
  initialization: prepareTarget({ dataDir: config.dataDir }),
  ports: {
    connectRedis: async () => {
      state.redisConnections++
      if (state.redisDown) {
        throw new RedisCoordinationError({ code: 'COORDINATION_UNAVAILABLE' })
      }
      return createCreationRedisClient(config.redis)
    },
    image: async ({ executionPlan }) => {
      state.imageCalls++
      state.imagePlans.push(executionPlan.systemPrompt)
      return state.kind !== 'output'
        ? { kind: state.kind, requestId: `fixture-${state.kind}` }
        : {
            bytes: await sharp({
              create: { background: 'green', channels: 3, height: 2, width: 3 },
            })
              .png()
              .toBuffer(),
            contentType: 'image/png',
            kind: 'output',
            requestId: 'fixture-output',
          }
    },
    naming: () => {
      state.namingCalls++
      return Promise.resolve({ name: 'Runtime named', kind: 'name', requestId: 'fixture-name' })
    },
    wechat: async () => {
      state.wechatCalls++
      await state.beforeWechat?.()
      return { ...state.wechatResult }
    },
  },
})
export default built.then((sanitized) => {
  const original = sanitized.onInit
  sanitized.onInit = async (payload) => {
    await original?.(payload)
    instance = payload
  }
  return Object.assign(sanitized, { [testDataConfigSymbol]: { suite: 'heymoro-core-runtime' } })
})
