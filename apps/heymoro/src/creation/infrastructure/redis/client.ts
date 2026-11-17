import { Redis } from 'ioredis'

import type { RedisCoordinationEvent } from './coordinator.js'

import { RedisCoordinationError } from './coordinator.js'

/** The host owns this client; no environment lookup, offline replay, or implicit connection target. */
export async function createCreationRedisClient({
  commandTimeoutMs,
  connectTimeoutMs,
  onEvent,
  url,
}: {
  commandTimeoutMs: number
  connectTimeoutMs: number
  onEvent?: (event: RedisCoordinationEvent) => void
  url: string
}) {
  for (const value of [connectTimeoutMs, commandTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new RangeError('Redis client requires finite positive connection and command budgets.')
    }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
    decodeURIComponent(parsed.username)
    decodeURIComponent(parsed.password)
  } catch {
    throw new RangeError('Redis client requires an explicit Redis URL with a host and port.')
  }
  if (
    !['redis:', 'rediss:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new RangeError('Redis client requires an explicit Redis URL with a host and port.')
  }
  if (
    parsed.pathname !== '' &&
    parsed.pathname !== '/' &&
    (!/^\/(?:0|[1-9]\d*)$/.test(parsed.pathname) ||
      !Number.isSafeInteger(Number(parsed.pathname.slice(1))) ||
      Number(parsed.pathname.slice(1)) > 2_147_483_647)
  ) {
    throw new RangeError('Redis client requires a finite nonnegative database number.')
  }
  const report = ({ event }: { event: RedisCoordinationEvent['event'] }) => {
    try {
      onEvent?.({ errorName: 'RedisError', event })
    } catch {
      /* Diagnostics are not coordination outcomes. */
    }
  }
  const client = new Redis(parsed.toString(), {
    autoResendUnfulfilledCommands: false,
    commandTimeout: commandTimeoutMs,
    connectTimeout: connectTimeoutMs,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    reconnectOnError: null,
    retryStrategy: null,
  })
  client.on('error', () => report({ event: 'client_error' }))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Connection deadline.')), connectTimeoutMs)
      }),
    ])
  } catch {
    client.disconnect(false)
    report({ event: 'connect_failed' })
    throw new RedisCoordinationError({ code: 'COORDINATION_UNAVAILABLE' })
  } finally {
    clearTimeout(timer)
  }
  const close = async () => {
    if (client.status === 'end') {
      return
    }
    await new Promise<void>((resolve, reject) => {
      const finished = () => {
        clearTimeout(deadline)
        resolve()
      }
      const deadline = setTimeout(() => {
        client.off('end', finished)
        reject(new RedisCoordinationError({ code: 'COORDINATION_UNAVAILABLE' }))
      }, connectTimeoutMs)
      client.once('end', finished)
      client.disconnect(false)
    })
  }
  return Object.freeze({ client, close })
}
