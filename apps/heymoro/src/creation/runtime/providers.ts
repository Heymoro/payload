import type { GenerationEngine } from '../application/generation-worker.js'
import type { WechatCodeExchange } from '../application/identity-types.js'
import type { NamingEngine } from '../application/session-naming-types.js'
import type { ObjectStorage } from '../domain/media.js'
import type { RedisCoordinationClient } from '../infrastructure/redis/coordinator.js'
import type { CoreConfig } from './config.js'

import { MediaStorageError } from '../domain/media.js'
import { createImageEngine } from '../infrastructure/ai/image-engine.js'
import { createNamingEngine } from '../infrastructure/ai/naming-engine.js'
import { createCreationRedisClient } from '../infrastructure/redis/client.js'
import {
  createRedisCreationCoordinator,
  RedisCoordinationError,
} from '../infrastructure/redis/coordinator.js'
import { createS3ObjectStorage } from '../infrastructure/s3/object-storage.js'
import { createWechatCodeExchange } from '../infrastructure/wechat/code-exchange.js'

type RedisOwner = { client: RedisCoordinationClient; close: () => Promise<void> }
type StorageOwner = {
  close: () => Promise<void> | void
  verifyBackend: (args: { backend: string; bucket: string }) => Promise<void>
} & ObjectStorage
export type RuntimePorts = Readonly<{
  connectRedis?: () => Promise<RedisOwner>
  image?: GenerationEngine
  naming?: NamingEngine
  storage?: StorageOwner
  wechat?: WechatCodeExchange
}>

export function createRuntimeProviders({
  config,
  ports = {},
}: {
  config: CoreConfig
  ports?: RuntimePorts
}) {
  const wechat = config.identity.wechat
    ? (ports.wechat ?? createWechatCodeExchange({ config: config.identity.wechat }))
    : null
  const image = config.image ? (ports.image ?? createImageEngine(config.image)) : null
  const naming = config.naming ? (ports.naming ?? createNamingEngine(config.naming)) : null
  const redis = createLazyRedis({
    connect: ports.connectRedis ?? (() => createCreationRedisClient(config.redis)),
  })
  const coordinator = createRedisCreationCoordinator({ client: redis.client, config: config.redis })
  const storage = createVerifiedStorage({
    inner:
      ports.storage ??
      createS3ObjectStorage({
        backends: config.s3.backends,
        image: config.imageLimits,
        limits: config.s3.limits,
      }),
  })
  let closing: Promise<void> | undefined
  return Object.freeze({
    ...coordinator,
    close: () =>
      (closing ??= Promise.allSettled([redis.close(), storage.close()]).then((results) => {
        const rejected = results.find((result) => result.status === 'rejected')
        if (rejected?.status === 'rejected') {
          throw rejected.reason
        }
      })),
    image,
    naming,
    storage,
    wechat,
  })
}

export function createLazyRedis({ connect }: { connect: () => Promise<RedisOwner> }) {
  const operations = new Set<Promise<unknown>>()
  let pending: Promise<RedisOwner> | undefined
  let owner: RedisOwner | undefined
  let isClosed = false
  let closing: Promise<void> | undefined
  const get = async () => {
    if (isClosed) {
      throw new RedisCoordinationError({ code: 'COORDINATION_UNAVAILABLE' })
    }
    pending ??= Promise.resolve()
      .then(connect)
      .then(async (value) => {
        if (isClosed) {
          await value.close()
          throw new RedisCoordinationError({ code: 'COORDINATION_UNAVAILABLE' })
        }
        owner = value
        return value
      })
      .catch((error: unknown) => {
        pending = undefined
        throw error
      })
    return pending
  }
  const run = async <T>({ work }: { work: (owner: RedisOwner) => Promise<T> }) => {
    if (isClosed) {
      throw new RedisCoordinationError({ code: 'COORDINATION_UNAVAILABLE' })
    }
    const operation = (async () => {
      const current = await get()
      if (isClosed) {
        throw new RedisCoordinationError({ code: 'COORDINATION_UNAVAILABLE' })
      }
      return work(current)
    })()
    operations.add(operation)
    try {
      return await operation
    } finally {
      operations.delete(operation)
    }
  }
  const client: RedisCoordinationClient = Object.freeze({
    eval: (...args) => run({ work: ({ client }) => client.eval(...args) }),
    set: (...args) => run({ work: ({ client }) => client.set(...args) }),
  })
  return Object.freeze({
    client,
    close: () => {
      isClosed = true
      return (closing ??= (async () => {
        await Promise.allSettled([...operations])
        await pending?.catch(() => undefined)
        if (owner) {
          const value = owner
          owner = undefined
          await value.close()
        }
      })())
    },
  })
}

/** Probes remain at existing storage call sites outside business UOWs; issued evidence is never copied. */
export function createVerifiedStorage({ inner }: { inner: StorageOwner }) {
  const verified = new Set<string>()
  const probes = new Map<string, Promise<void>>()
  const operations = new Set<Promise<unknown>>()
  let isClosed = false
  let closing: Promise<void> | undefined
  const ensure = async (destination: { backend: string; bucket: string }) => {
    if (isClosed) {
      throw new MediaStorageError('UNKNOWN')
    }
    const key = JSON.stringify([destination.backend, destination.bucket])
    if (verified.has(key)) {
      return
    }
    let probe = probes.get(key)
    if (!probe) {
      probe = Promise.resolve()
        .then(() => inner.verifyBackend(destination))
        .then(() => {
          if (isClosed) {
            throw new MediaStorageError('UNKNOWN')
          }
          verified.add(key)
        })
        .finally(() => probes.delete(key))
      probes.set(key, probe)
    }
    await probe
  }
  const run = async <T>({
    destination,
    work,
  }: {
    destination: { backend: string; bucket: string }
    work: () => Promise<T>
  }) => {
    if (isClosed) {
      throw new MediaStorageError('UNKNOWN')
    }
    const operation = (async () => {
      await ensure(destination)
      if (isClosed) {
        throw new MediaStorageError('UNKNOWN')
      }
      return work()
    })()
    operations.add(operation)
    try {
      return await operation
    } finally {
      operations.delete(operation)
    }
  }
  const storage: ObjectStorage = Object.freeze({
    assertVerified: (args) => inner.assertVerified(args),
    findAttemptCandidates: (args) =>
      run({ destination: args.storageOutput, work: () => inner.findAttemptCandidates(args) }),
    getVerified: (args) => run({ destination: args.ref, work: () => inner.getVerified(args) }),
    putImmutable: (args) => run({ destination: args.ref, work: () => inner.putImmutable(args) }),
  })
  return Object.freeze({
    ...storage,
    close: () => {
      isClosed = true
      return (closing ??= (async () => {
        await Promise.allSettled([...operations, ...probes.values()])
        await inner.close()
      })())
    },
  })
}
