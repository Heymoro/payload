import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

import type { CreationCoordinator } from '../payload/sqlite-unit-of-work.js'

export type RedisCoordinationClient = {
  eval: (script: string, keyCount: number, ...arguments_: (number | string)[]) => Promise<unknown>
  set: (
    key: string,
    owner: string,
    expiry: 'PX',
    leaseMs: number,
    condition: 'NX',
  ) => Promise<'OK' | null>
}
export type RedisCoordinationConfig = Readonly<{
  acquireTimeoutMs: number
  commandTimeoutMs: number
  leaseMs: number
  maxHoldMs: number
  namespace: string
  renewEveryMs: number
  retryDelayMs: number
}>
export type RedisCoordinationEvent = Readonly<{
  errorName: 'RedisError'
  event: 'client_error' | 'connect_failed' | 'release_failed' | 'renew_failed'
}>
type Work<T> = (args: { assertLease: () => void }) => Promise<T>
type HeldKey = { deadline: number; key: string }

export class RedisCoordinationError extends Error {
  readonly code: 'COORDINATION_UNAVAILABLE' | 'RESOURCE_BUSY'
  readonly status: 409 | 503

  constructor({ code }: { code: 'COORDINATION_UNAVAILABLE' | 'RESOURCE_BUSY' }) {
    super(
      code === 'RESOURCE_BUSY'
        ? 'Creation resource is busy.'
        : 'Creation coordination is unavailable.',
    )
    this.name = 'RedisCoordinationError'
    this.code = code
    this.status = code === 'RESOURCE_BUSY' ? 409 : 503
  }
}

/** A holder lease is a write guard, not fencing, HA isolation, or an exactly-once guarantee. */
export function createRedisCreationCoordinator({
  client,
  config,
  onEvent,
}: {
  client: RedisCoordinationClient
  config: RedisCoordinationConfig
  onEvent?: (event: RedisCoordinationEvent) => void
}) {
  const policy = snapshotPolicy({ config })
  const report = ({ event }: { event: RedisCoordinationEvent['event'] }) => {
    try {
      onEvent?.({ errorName: 'RedisError', event })
    } catch {
      /* Observers must not change transaction outcomes. */
    }
  }
  const run = async <T>({
    resources,
    work,
  }: {
    resources: string[]
    work: Work<T>
  }): Promise<T> => {
    const owner = randomUUID()
    const startedAt = performance.now()
    const acquireDeadline = startedAt + policy.acquireTimeoutMs
    const holdDeadline = startedAt + policy.maxHoldMs
    const attemptedKeys: string[] = []
    const heldKeys: HeldKey[] = []
    let isLost = false
    let isFinished = false
    let isStopping = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let renewal: Promise<void> | undefined
    const assertLease = () => {
      const now = performance.now()
      if (isFinished || now >= holdDeadline || heldKeys.some(({ deadline }) => now >= deadline)) {
        isLost = true
      }
      if (isLost) {
        throw unavailable()
      }
    }
    const rpc = <V>({
      command,
      timeoutCode = 'COORDINATION_UNAVAILABLE',
      timeoutMs = policy.commandTimeoutMs,
    }: {
      command: () => Promise<V>
      timeoutCode?: RedisCoordinationError['code']
      timeoutMs?: number
    }) => boundedCommand({ command, timeoutCode, timeoutMs })
    const renew = async () => {
      try {
        for (const held of heldKeys) {
          assertLease()
          if (isStopping) {
            return
          }
          const sentAt = performance.now()
          const result = await rpc({
            command: () => client.eval(renewScript, 1, held.key, owner, policy.leaseMs),
          })
          // Never revive an expired local capability, even if a late server reply says success.
          assertLease()
          if (result !== 1) {
            throw unavailable()
          }
          held.deadline = sentAt + policy.leaseMs
          assertLease()
        }
      } catch {
        isLost = true
        report({ event: 'renew_failed' })
      }
    }
    const scheduleRenewal = () => {
      if (isStopping || isLost) {
        return
      }
      timer = setTimeout(() => {
        renewal = renew().then(() => {
          if (!isStopping) {
            scheduleRenewal()
          }
        })
      }, policy.renewEveryMs)
    }
    try {
      for (const resource of resources) {
        const key = `${policy.namespace}:${createHash('sha256').update(resource).digest('hex')}`
        // Include uncertain SET outcomes: owner comparison makes cleanup safe for foreign holders.
        attemptedKeys.push(key)
        while (true) {
          assertLease()
          const sentAt = performance.now()
          if (sentAt >= acquireDeadline) {
            throw busy()
          }
          const acquireRemaining = acquireDeadline - sentAt
          const holdRemaining = holdDeadline - sentAt
          const isAcquireLimited =
            acquireRemaining < policy.commandTimeoutMs && acquireRemaining < holdRemaining
          let result: 'OK' | null
          try {
            result = await rpc({
              command: () => client.set(key, owner, 'PX', policy.leaseMs, 'NX'),
              timeoutCode: isAcquireLimited ? 'RESOURCE_BUSY' : 'COORDINATION_UNAVAILABLE',
              timeoutMs: Math.min(policy.commandTimeoutMs, acquireRemaining, holdRemaining),
            })
          } catch (error) {
            // Lease/hold loss wins over a coincident acquire-budget timer; actual Redis errors remain 503.
            assertLease()
            throw error
          }
          assertLease()
          if (result === 'OK') {
            heldKeys.push({ deadline: sentAt + policy.leaseMs, key })
            assertLease()
            if (performance.now() >= acquireDeadline) {
              throw busy()
            }
            break
          }
          if (result !== null) {
            throw unavailable()
          }
          const now = performance.now()
          const remaining = acquireDeadline - now
          if (remaining <= 0) {
            throw busy()
          }
          await delay(
            Math.max(
              1,
              Math.min(
                policy.retryDelayMs,
                remaining,
                holdDeadline - now,
                ...heldKeys.map(({ deadline }) => deadline - now),
              ),
            ),
          )
        }
      }
      assertLease()
      scheduleRenewal()
      // The caller checks this same capability at every write and immediately before commit.
      // Do not assert after work: it may already represent a known durable commit.
      return await work({ assertLease })
    } finally {
      isStopping = true
      clearTimeout(timer)
      await renewal
      isFinished = true
      // Reverse global acquisition order. Release failures cannot mask work errors or known results.
      for (const key of attemptedKeys.reverse()) {
        try {
          await rpc({ command: () => client.eval(releaseScript, 1, key, owner) })
        } catch {
          report({ event: 'release_failed' })
        }
      }
    }
  }
  const coordinate: CreationCoordinator = async ({ resource, work }) =>
    run({ resources: [singleResource({ resource })], work })
  const coordinateMany = async <T>({
    resources,
    work,
  }: {
    resources: readonly string[]
    work: Work<T>
  }): Promise<T> => run({ resources: orderedResources({ resources }), work })
  return Object.freeze({ coordinate, coordinateMany })
}

const renewScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const releaseScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

function snapshotPolicy({ config }: { config: RedisCoordinationConfig }): RedisCoordinationConfig {
  const {
    acquireTimeoutMs,
    commandTimeoutMs,
    leaseMs,
    maxHoldMs,
    namespace,
    renewEveryMs,
    retryDelayMs,
  } = config
  if (typeof namespace !== 'string' || !/^[a-z0-9][\w:-]{0,127}$/i.test(namespace)) {
    throw new RangeError('Redis coordination requires a bounded internal namespace.')
  }
  for (const value of [
    leaseMs,
    renewEveryMs,
    maxHoldMs,
    acquireTimeoutMs,
    retryDelayMs,
    commandTimeoutMs,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new RangeError('Redis coordination requires finite positive millisecond budgets.')
    }
  }
  if (renewEveryMs * 3 > leaseMs || renewEveryMs + commandTimeoutMs >= leaseMs) {
    throw new RangeError('Redis renewal and command budgets must fit safely within the lease.')
  }
  return Object.freeze({
    acquireTimeoutMs,
    commandTimeoutMs,
    leaseMs,
    maxHoldMs,
    namespace,
    renewEveryMs,
    retryDelayMs,
  })
}

function singleResource({ resource }: { resource: string }): string {
  if (
    typeof resource !== 'string' ||
    resource.length === 0 ||
    resource.length > 1024 ||
    resource.trim() !== resource ||
    // eslint-disable-next-line no-control-regex -- Intentionally reject or strip control characters.
    /[\u0000-\u001f\u007f]/.test(resource)
  ) {
    throw new RangeError('Redis coordination requires a bounded internal resource.')
  }
  if (/^(?:session|task|wallet):/.test(resource)) {
    return orderedResources({ resources: [resource] })[0]!
  }
  return resource
}

function orderedResources({ resources }: { resources: readonly string[] }): string[] {
  if (
    !Array.isArray(resources) ||
    resources.length < 1 ||
    resources.length > 64 ||
    new Set(resources).size !== resources.length
  ) {
    throw new RangeError('Redis coordination requires 1–64 unique canonical resources.')
  }
  const ranks: Record<string, number> = { session: 0, task: 1, wallet: 2 }
  const parsed = resources.map((resource) => {
    if (
      typeof resource !== 'string' ||
      !/^(?:session:[1-9]\d*:[1-9]\d*|task:[1-9]\d*|wallet:[1-9]\d*)$/.test(resource)
    ) {
      throw new RangeError('Redis resource chain requires canonical session, task, or wallet IDs.')
    }
    const [type, ...ids] = resource.split(':')
    const numbers = ids.map(Number)
    if (numbers.some((value) => !Number.isSafeInteger(value) || value < 1)) {
      throw new RangeError('Redis resource IDs must be positive safe integers.')
    }
    return {
      businessId: numbers.at(-1)!,
      rank: ranks[type!]!,
      resource,
      userId: type === 'session' ? numbers[0]! : 0,
    }
  })
  parsed.sort((a, b) => a.rank - b.rank || a.businessId - b.businessId || a.userId - b.userId)
  return parsed.map(({ resource }) => resource)
}

async function boundedCommand<T>({
  command,
  timeoutCode,
  timeoutMs,
}: {
  command: () => Promise<T>
  timeoutCode: RedisCoordinationError['code']
  timeoutMs: number
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (timeoutMs <= 0) {
      throw new RedisCoordinationError({ code: timeoutCode })
    }
    return await Promise.race([
      Promise.resolve()
        .then(command)
        .catch(() => {
          throw unavailable()
        }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RedisCoordinationError({ code: timeoutCode })),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function unavailable() {
  return new RedisCoordinationError({ code: 'COORDINATION_UNAVAILABLE' })
}
function busy() {
  return new RedisCoordinationError({ code: 'RESOURCE_BUSY' })
}
