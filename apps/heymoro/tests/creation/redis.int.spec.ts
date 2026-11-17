import type { Redis } from 'ioredis'
import type { Payload, PayloadRequest } from 'payload'

import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, vi } from 'vitest'

import type { CreationCoordinator } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import type {
  RedisCoordinationClient,
  RedisCoordinationConfig,
} from '../../src/creation/infrastructure/redis/coordinator.js'
import type { RedisFixture } from './redis-fixture.js'

import { test } from '../../../../test/__helpers/int/vitest.js'
import {
  createCreationRuntime,
  createPayloadSessionCreator,
} from '../../src/creation/infrastructure/payload/session-repository.js'
import {
  createSQLiteUnitOfWork,
  getCreationSQLiteAdapter,
} from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createCreationRedisClient } from '../../src/creation/infrastructure/redis/client.js'
import { createRedisCreationCoordinator } from '../../src/creation/infrastructure/redis/coordinator.js'
import { bounded, startRedisFixture } from './redis-fixture.js'
import { cleanupSQLiteFixture, gate } from './sqlite.config.js'

test.suite(
  'Heymoro real Redis holder leases and SQLite',
  { config: './sqlite.config.ts', cron: false },
  () => {
    let redis: RedisFixture
    test.beforeAll(async () => {
      redis = await startRedisFixture()
    })
    test.afterAll(async () => {
      await redis?.stop()
      cleanupSQLiteFixture()
    })
    test.afterEach(() => {
      vi.restoreAllMocks()
    })

    const coordinator = (
      args: {
        client?: RedisCoordinationClient
        config?: Partial<RedisCoordinationConfig>
        onEvent?: (event: { errorName: string; event: string }) => void
      } = {},
    ) => {
      const config = { ...policy(), ...args.config }
      return {
        ...createRedisCreationCoordinator({
          client: args.client ?? redis.client,
          config,
          onEvent: args.onEvent,
        }),
        config,
      }
    }

    test('exposes a holder coordinator after the owned Redis really answers PING', async () => {
      expect(await redis.client.ping()).toBe('PONG')
      expect(createRedisCreationCoordinator).toBeTypeOf('function')
      expect(await redis.client.config('GET', 'save')).toEqual(['save', ''])
      expect(await redis.client.config('GET', 'appendonly')).toEqual(['appendonly', 'no'])
      expect(await redis.client.config('GET', 'maxmemory')).toEqual(['maxmemory', '33554432'])
      expect(await redis.client.config('GET', 'maxmemory-policy')).toEqual([
        'maxmemory-policy',
        'noeviction',
      ])
      expect(redis.port).not.toBe(6379)
    })

    test('constructs only explicit, bounded, non-replaying clients and leaves lifecycle to the host', async () => {
      const config = { commandTimeoutMs: 500, connectTimeoutMs: 500, url: redis.url }
      const host = await createCreationRedisClient(config)
      redis.register({ client: host.client })
      config.url = 'redis://127.0.0.1:6379'
      config.commandTimeoutMs = Infinity
      expect(host.client.options).toMatchObject({
        autoResendUnfulfilledCommands: false,
        commandTimeout: 500,
        connectTimeout: 500,
        enableOfflineQueue: false,
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        retryStrategy: null,
      })
      expect(await host.client.ping()).toBe('PONG')
      await coordinator({ client: host.client }).coordinate({
        resource: 'host-lifecycle',
        work: async () => 'done',
      })
      expect(await host.client.ping()).toBe('PONG')
      await host.close()
      expect(host.client.status).toBe('end')
      for (const invalid of [
        { url: '' },
        { url: 'redis://localhost' },
        { url: 'http://127.0.0.1:1234' },
        { commandTimeoutMs: Infinity },
        { connectTimeoutMs: 0 },
      ]) {
        await expect(
          createCreationRedisClient({
            commandTimeoutMs: 500,
            connectTimeoutMs: 500,
            url: redis.url,
            ...invalid,
          }),
        ).rejects.toBeInstanceOf(RangeError)
      }
    })

    test('validates URL database and credential encoding before constructing a client', async () => {
      for (const url of [
        `${redis.url}/not-a-db`,
        `${redis.url}/9007199254740992`,
        redis.url.replace('redis://', 'redis://fixture:%ZZ@'),
      ]) {
        await expect(
          createCreationRedisClient({ commandTimeoutMs: 500, connectTimeoutMs: 500, url }),
        ).rejects.toBeInstanceOf(RangeError)
      }
    })

    test('sanitizes real AUTH connection failure and client error events without leaking fixture credentials', async () => {
      const events: unknown[] = []
      const url = redis.url.replace('redis://', 'redis://fixture:fixture-not-real-secret@')
      let failure: unknown
      try {
        await createCreationRedisClient({
          commandTimeoutMs: 500,
          connectTimeoutMs: 500,
          onEvent: (event) => events.push(event),
          url,
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ code: 'COORDINATION_UNAVAILABLE', status: 503 })
      expect(String(failure)).not.toMatch(/AUTH|fixture-not-real-secret|redis:\/\//)
      expect(events.length).toBeGreaterThan(0)
      expect(JSON.stringify(events)).not.toMatch(/AUTH|fixture-not-real-secret|redis:\/\//)
    })

    test('serializes a real same-resource holder while a different resource proceeds and releases after work', async () => {
      const lock = coordinator()
      const entered = barrier()
      const release = barrier()
      let calls = 0
      const held = lock.coordinate({
        resource: 'mutex',
        work: async ({ assertLease }) => {
          calls++
          entered.open()
          await release.wait
          assertLease()
          return 'first'
        },
      })
      try {
        await entered.wait
        expect(
          await redis.client.pttl(key({ config: lock.config, resource: 'mutex' })),
        ).toBeGreaterThan(0)
        expect(await lock.coordinate({ resource: 'different', work: async () => 'parallel' })).toBe(
          'parallel',
        )
        await expect(
          coordinator({
            config: { acquireTimeoutMs: 80, namespace: lock.config.namespace },
          }).coordinate({
            resource: 'mutex',
            work: async () => {
              calls++
            },
          }),
        ).rejects.toMatchObject({ code: 'RESOURCE_BUSY', status: 409 })
        expect(calls).toBe(1)
      } finally {
        release.open()
      }
      expect(await held).toBe('first')
      expect(await redis.client.get(key({ config: lock.config, resource: 'mutex' }))).toBeNull()
      await expect(lock.coordinate({ resource: 'mutex', work: async () => 'next' })).resolves.toBe(
        'next',
      )
    })

    test('renews a real TTL beyond the original deadline without overlapping RPCs', async () => {
      let active = 0
      let peak = 0
      let renewals = 0
      const client = proxyClient({
        client: redis.client,
        eval: async (...args) => {
          if (String(args[0]).includes('pexpire')) {
            active++
            peak = Math.max(peak, active)
            try {
              const result = await redis.client.eval(...args)
              renewals++
              return result
            } finally {
              active--
            }
          }
          return redis.client.eval(...args)
        },
      })
      const lock = coordinator({
        client,
        config: { commandTimeoutMs: 120, leaseMs: 400, renewEveryMs: 80 },
      })
      await lock.coordinate({
        resource: 'renew',
        work: async ({ assertLease }) => {
          const began = performance.now()
          await poll({ predicate: () => performance.now() - began > 650 && renewals >= 4 })
          assertLease()
          expect(
            await redis.client.pttl(key({ config: lock.config, resource: 'renew' })),
          ).toBeGreaterThan(100)
        },
      })
      expect(peak).toBe(1)
    })

    test('owner replacement permanently invalidates assertions and release never removes a foreign owner', async () => {
      const lock = coordinator({
        config: { commandTimeoutMs: 100, leaseMs: 400, renewEveryMs: 60 },
      })
      const resource = 'foreign-owner'
      let assertAfter: (() => void) | undefined
      await lock.coordinate({
        resource,
        work: async ({ assertLease }) => {
          assertAfter = assertLease
          await redis.client.set(key({ config: lock.config, resource }), 'foreign', 'PX', 5000)
          await poll({ predicate: () => throwsLease({ assertLease }) })
          await redis.client.del(key({ config: lock.config, resource }))
          expect(assertLease).toThrow(
            expect.objectContaining({ code: 'COORDINATION_UNAVAILABLE', status: 503 }),
          )
          await redis.client.set(key({ config: lock.config, resource }), 'foreign', 'PX', 5000)
          return 'known work result'
        },
      })
      expect(assertAfter).toThrow()
      expect(await redis.client.get(key({ config: lock.config, resource }))).toBe('foreign')
    })

    test('a real expiry is permanent even if an injected renew reply claims success after its conservative deadline', async () => {
      const lock = coordinator({
        client: proxyClient({
          client: redis.client,
          eval: async (...args) => {
            if (String(args[0]).includes('pexpire')) {
              await delay(300)
              return 1
            }
            return redis.client.eval(...args)
          },
        }),
        config: { commandTimeoutMs: 80, leaseMs: 240, renewEveryMs: 40 },
      })
      await lock.coordinate({
        resource: 'expired',
        work: async ({ assertLease }) => {
          await poll({
            predicate: async () =>
              (await redis.client.get(key({ config: lock.config, resource: 'expired' }))) === null,
          })
          expect(assertLease).toThrow(expect.objectContaining({ code: 'COORDINATION_UNAVAILABLE' }))
          await delay(100)
          expect(assertLease).toThrow()
        },
      })
    })

    test('enforces a finite max hold even while real renewals continue successfully', async () => {
      const lock = coordinator({
        config: { commandTimeoutMs: 100, leaseMs: 500, maxHoldMs: 180, renewEveryMs: 60 },
      })
      let calls = 0
      await lock.coordinate({
        resource: 'max-hold',
        work: async ({ assertLease }) => {
          calls++
          await poll({ predicate: () => throwsLease({ assertLease }) })
          expect(assertLease).toThrow(expect.objectContaining({ code: 'COORDINATION_UNAVAILABLE' }))
        },
      })
      expect(calls).toBe(1)
    })

    test('bounds acquisition backoff by max hold rather than oversleeping the capability deadline', async () => {
      const lock = coordinator({
        config: { acquireTimeoutMs: 2000, maxHoldMs: 90, retryDelayMs: 1200 },
      })
      const resource = 'acquire-max-hold'
      await redis.client.set(key({ config: lock.config, resource }), 'foreign', 'PX', 5000)
      const work = vi.fn()
      const started = performance.now()
      await expect(
        bounded({ promise: lock.coordinate({ resource, work }), timeoutMs: 400 }),
      ).rejects.toMatchObject({ code: 'COORDINATION_UNAVAILABLE' })
      expect(performance.now() - started).toBeLessThan(400)
      expect(work).not.toHaveBeenCalled()
      expect(await redis.client.get(key({ config: lock.config, resource }))).toBe('foreign')
    })

    test('real client disconnect fails closed with no work replay and no coordinator shutdown of another client', async () => {
      const ownClient = await redis.connect()
      const lock = coordinator({
        client: ownClient,
        config: { commandTimeoutMs: 100, leaseMs: 400, renewEveryMs: 60 },
      })
      let calls = 0
      await lock.coordinate({
        resource: 'disconnect-held',
        work: async ({ assertLease }) => {
          calls++
          ownClient.disconnect(false)
          await poll({ predicate: () => throwsLease({ assertLease }) })
          expect(assertLease).toThrow()
        },
      })
      await expect(
        lock.coordinate({
          resource: 'disconnect-new',
          work: async () => {
            calls++
          },
        }),
      ).rejects.toMatchObject({ code: 'COORDINATION_UNAVAILABLE', status: 503 })
      expect(calls).toBe(1)
      expect(await redis.client.ping()).toBe('PONG')
    })

    test('sorts canonical resource chains numerically, cleans a partial chain in reverse, and shares single/many keys', async () => {
      const sets: string[] = []
      const deletes: string[] = []
      const config = policy()
      const resources = [
        'wallet:10',
        'task:10',
        'session:10:2',
        'wallet:2',
        'task:2',
        'session:2:10',
        'session:2:2',
        'session:1:9',
        'session:2:1',
      ]
      const expected = [
        'session:2:1',
        'session:2:2',
        'session:10:2',
        'session:1:9',
        'session:2:10',
        'task:2',
        'task:10',
        'wallet:2',
        'wallet:10',
      ]
      const client = proxyClient({
        client: redis.client,
        eval: async (...args) => {
          if (String(args[0]).includes("redis.call('del'")) {
            deletes.push(String(args[2]))
          }
          return redis.client.eval(...args)
        },
        set: async (...args) => {
          sets.push(args[0])
          return redis.client.set(...args)
        },
      })
      const lock = createRedisCreationCoordinator({ client, config })
      await lock.coordinateMany({
        resources,
        work: async ({ assertLease }) => {
          assertLease()
          for (const resource of resources) {
            expect(await redis.client.get(key({ config, resource }))).toBeTruthy()
          }
          return 'all-held'
        },
      })
      expect(sets).toEqual(expected.map((resource) => key({ config, resource })))
      expect(deletes).toEqual([...sets].reverse())
      const held = barrier(),
        release = barrier()
      const single = lock.coordinate({
        resource: 'session:2:2',
        work: async () => {
          held.open()
          await release.wait
        },
      })
      try {
        await held.wait
        await expect(
          lock.coordinateMany({
            resources: ['wallet:2', 'session:2:2'],
            work: async () => {
              throw new Error('must not run')
            },
          }),
        ).rejects.toMatchObject({ code: 'RESOURCE_BUSY' })
      } finally {
        release.open()
        await single
      }
      sets.length = 0
      deletes.length = 0
      await redis.client.set(key({ config, resource: 'task:10' }), 'foreign', 'PX', 5000)
      const noWork = vi.fn()
      await expect(
        lock.coordinateMany({ resources: ['task:10', 'session:2:2', 'task:2'], work: noWork }),
      ).rejects.toMatchObject({ code: 'RESOURCE_BUSY' })
      expect(noWork).not.toHaveBeenCalled()
      expect(deletes.slice(-3)).toEqual(
        ['task:10', 'task:2', 'session:2:2'].map((resource) => key({ config, resource })),
      )
      expect(await redis.client.get(key({ config, resource: 'task:10' }))).toBe('foreign')
      expect(await redis.client.get(key({ config, resource: 'task:2' }))).toBeNull()
      expect(await redis.client.get(key({ config, resource: 'session:2:2' }))).toBeNull()
    })

    test('rejects invalid resources and non-finite policy before touching Redis and snapshots configuration', async () => {
      const config = policy()
      const calls = vi.fn()
      const client = proxyClient({ client: redis.client, set: calls })
      const lock = createRedisCreationCoordinator({ client, config })
      for (const resource of [
        '',
        '   ',
        'x'.repeat(1025),
        'session:01:2',
        'session:1',
        'task:01',
        'wallet:0',
        'task:9007199254740992',
      ]) {
        await expect(lock.coordinate({ resource, work: calls })).rejects.toBeInstanceOf(RangeError)
      }
      for (const resources of [
        [],
        ['task:0'],
        ['task:01'],
        ['task:1.5'],
        ['wallet:-1'],
        ['session:1:0'],
        ['task:9007199254740992'],
        ['task:1', 'task:1'],
        ['creation-session:x'],
      ]) {
        await expect(lock.coordinateMany({ resources, work: calls })).rejects.toBeInstanceOf(
          RangeError,
        )
      }
      expect(calls).not.toHaveBeenCalled()
      for (const field of [
        'leaseMs',
        'renewEveryMs',
        'maxHoldMs',
        'acquireTimeoutMs',
        'retryDelayMs',
        'commandTimeoutMs',
      ] as const) {
        for (const value of [0, -1, Infinity, NaN, 1.5, 2 ** 31]) {
          expect(() =>
            createRedisCreationCoordinator({
              client: redis.client,
              config: { ...policy(), [field]: value },
            }),
          ).toThrow(RangeError)
        }
      }
      for (const invalid of [
        { namespace: '' },
        { namespace: 'with space' },
        { renewEveryMs: 400 },
        { commandTimeoutMs: 900 },
      ]) {
        expect(() =>
          createRedisCreationCoordinator({
            client: redis.client,
            config: { ...policy(), ...invalid },
          }),
        ).toThrow(RangeError)
      }
      const original = { ...policy() }
      const stable = createRedisCreationCoordinator({ client: redis.client, config: original })
      const initial = { ...original }
      original.namespace = 'mutated'
      original.leaseMs = Infinity
      original.maxHoldMs = 1
      await stable.coordinate({
        resource: 'snapshot',
        work: async () => {
          expect(
            await redis.client.pttl(key({ config: initial, resource: 'snapshot' })),
          ).toBeGreaterThan(100)
        },
      })
    })

    test('distinguishes acquisition-budget busy from command or hold loss during an injected final SET acknowledgement delay', async () => {
      for (const scenario of [
        {
          acquireTimeoutMs: 120,
          code: 'RESOURCE_BUSY',
          commandTimeoutMs: 500,
          hasForeignOwner: true,
          maxHoldMs: 5000,
          status: 409,
        },
        {
          acquireTimeoutMs: 120,
          code: 'RESOURCE_BUSY',
          commandTimeoutMs: 500,
          hasForeignOwner: false,
          maxHoldMs: 5000,
          status: 409,
        },
        {
          acquireTimeoutMs: 500,
          code: 'COORDINATION_UNAVAILABLE',
          commandTimeoutMs: 80,
          hasForeignOwner: false,
          maxHoldMs: 5000,
          status: 503,
        },
        {
          acquireTimeoutMs: 500,
          code: 'COORDINATION_UNAVAILABLE',
          commandTimeoutMs: 500,
          hasForeignOwner: false,
          maxHoldMs: 90,
          status: 503,
        },
      ]) {
        const { acquireTimeoutMs, code, commandTimeoutMs, hasForeignOwner, maxHoldMs, status } =
          scenario
        const entered = barrier()
        const reply = barrier()
        const settled = barrier()
        const config = { ...policy(), acquireTimeoutMs, commandTimeoutMs, leaseMs: 2000, maxHoldMs }
        const lastKey = key({ config, resource: 'task:2' })
        if (hasForeignOwner) {
          await redis.client.set(lastKey, 'foreign', 'PX', 5000)
        }
        let sets = 0
        const lock = createRedisCreationCoordinator({
          client: proxyClient({
            client: redis.client,
            set: async (...args) => {
              const result = await redis.client.set(...args)
              if (++sets === 2) {
                expect(args[0]).toBe(lastKey)
                expect(result).toBe(hasForeignOwner ? null : 'OK')
                entered.open()
                try {
                  await reply.wait
                } finally {
                  settled.open()
                }
              }
              return result
            },
          }),
          config,
        })
        const work = vi.fn()
        const completed = lock.coordinateMany({ resources: ['task:2', 'task:1'], work })
        try {
          await entered.wait
          await expect(completed).rejects.toMatchObject({ code, status })
          expect(work).not.toHaveBeenCalled()
          expect(await redis.client.get(key({ config, resource: 'task:1' }))).toBeNull()
          expect(await redis.client.get(lastKey)).toBe(hasForeignOwner ? 'foreign' : null)
        } finally {
          reply.open()
          await settled.wait
          await completed.catch(() => undefined)
        }
      }
    })

    test('bounds an injected hung SET without calling work', async () => {
      const work = vi.fn()
      const lock = coordinator({
        client: proxyClient({ client: redis.client, set: () => new Promise(() => {}) }),
      })
      await expect(
        bounded({ promise: lock.coordinate({ resource: 'hung', work }), timeoutMs: 1000 }),
      ).rejects.toMatchObject({ code: 'COORDINATION_UNAVAILABLE' })
      expect(work).not.toHaveBeenCalled()
    })

    test('cleans a real acquired key when injected SET acknowledgement is lost', async () => {
      const lock = coordinator({
        client: proxyClient({
          client: redis.client,
          set: async (...args) => {
            await redis.client.set(...args)
            throw new Error('injected SET ack loss with AUTH secret')
          },
        }),
      })
      const work = vi.fn()
      await expect(lock.coordinate({ resource: 'set-ack-loss', work })).rejects.toMatchObject({
        code: 'COORDINATION_UNAVAILABLE',
        status: 503,
      })
      expect(work).not.toHaveBeenCalled()
      expect(
        await redis.client.get(key({ config: lock.config, resource: 'set-ack-loss' })),
      ).toBeNull()
    })

    test('checks all early deadlines before work after an injected slow later SET acknowledgement', async () => {
      let count = 0
      const work = vi.fn()
      const lock = coordinator({
        client: proxyClient({
          client: redis.client,
          set: async (...args) => {
            const result = await redis.client.set(...args)
            count++
            await delay(75)
            return result
          },
        }),
        config: { acquireTimeoutMs: 1000, commandTimeoutMs: 100, leaseMs: 250, renewEveryMs: 30 },
      })
      await expect(
        lock.coordinateMany({ resources: ['task:1', 'task:2', 'task:3', 'task:4'], work }),
      ).rejects.toMatchObject({ code: 'COORDINATION_UNAVAILABLE' })
      expect(work).not.toHaveBeenCalled()
    })

    test('does not renew an expired local lease after an injected slow SET reply', async () => {
      const lock = coordinator({
        client: proxyClient({
          client: redis.client,
          set: async (...args) => {
            const result = await redis.client.set(...args)
            await delay(150)
            return result
          },
        }),
        config: { maxHoldMs: 500 },
      })
      await expect(
        lock.coordinate({ resource: 'late-acquire', work: async () => 'not called' }),
      ).rejects.toMatchObject({ code: 'COORDINATION_UNAVAILABLE' })
    })

    test('preserves a known result or original error despite injected release failures and reports only sanitized events', async () => {
      const events: unknown[] = []
      const lock = coordinator({
        client: proxyClient({
          client: redis.client,
          eval: async (...args) => {
            if (String(args[0]).includes("redis.call('del'")) {
              throw Object.assign(new Error('AUTH redis://secret-token@host'), {
                name: 'secret-token',
              })
            }
            return redis.client.eval(...args)
          },
        }),
        onEvent: (event) => events.push(event),
      })
      await expect(
        lock.coordinate({ resource: 'cleanup-result', work: async () => 'committed' }),
      ).resolves.toBe('committed')
      const error = new Error('business failure')
      await expect(
        lock.coordinate({
          resource: 'cleanup-error',
          work: async () => {
            throw error
          },
        }),
      ).rejects.toBe(error)
      expect(events).toHaveLength(2)
      expect(JSON.stringify(events)).not.toMatch(/AUTH|secret|redis:\/\/|host/)
      expect(events[0]).toMatchObject({ errorName: 'RedisError', event: 'release_failed' })
    })

    test('settles a bounded in-flight injected renew before returning without rewriting a known result', async () => {
      const entered = barrier(),
        reply = barrier()
      let renewalSettled = false
      const lock = coordinator({
        client: proxyClient({
          client: redis.client,
          eval: async (...args) => {
            if (String(args[0]).includes('pexpire')) {
              const result = await redis.client.eval(...args)
              entered.open()
              await reply.wait
              renewalSettled = true
              throw new Error(`injected renew ack loss: ${result}`)
            }
            return redis.client.eval(...args)
          },
        }),
      })
      const completed = lock.coordinate({
        resource: 'in-flight',
        work: async () => {
          await entered.wait
          reply.open()
          return 'known result'
        },
      })
      await expect(completed).resolves.toBe('known result')
      expect(renewalSettled).toBe(true)
    })

    test('real SQLite plus Redis concurrent same-key requests create one session and one draft', async ({
      payload,
    }) => {
      const lock = coordinator()
      const fixture = await seed({ coordinate: lock.coordinate, payload })
      const create = creator({ coordinate: lock.coordinate, payload })
      const results = await Promise.all([
        create({ command: fixture.command, userId: fixture.userId }),
        create({ command: fixture.command, userId: fixture.userId }),
      ])
      expect(results.map((result) => result.isNew).sort()).toEqual([false, true])
      expect(results[0]!.session.id).toBe(results[1]!.session.id)
      expect(await rows({ payload, table: 'creation_sessions' })).toBe(1)
      expect(await rows({ payload, table: 'creation_drafts' })).toBe(1)
    })

    test('busy or unavailable Redis performs zero real SQLite transaction work', async ({
      payload,
    }) => {
      const lock = coordinator({ config: { acquireTimeoutMs: 60 } })
      const transaction = vi.spyOn(getCreationSQLiteAdapter({ payload }).client, 'transaction')
      const held = barrier(),
        release = barrier()
      const active = lock.coordinate({
        resource: 'db-before-lock',
        work: async () => {
          held.open()
          await release.wait
        },
      })
      const work = vi.fn()
      try {
        await held.wait
        await expect(
          unit({ coordinate: lock.coordinate, payload })({ resource: 'db-before-lock', work }),
        ).rejects.toMatchObject({ code: 'RESOURCE_BUSY' })
      } finally {
        release.open()
        await active
      }
      const disconnected = await redis.connect()
      disconnected.disconnect(false)
      await expect(
        unit({ coordinate: coordinator({ client: disconnected }).coordinate, payload })({
          resource: 'db-unavailable',
          work,
        }),
      ).rejects.toMatchObject({ code: 'COORDINATION_UNAVAILABLE' })
      expect(transaction).not.toHaveBeenCalled()
      expect(work).not.toHaveBeenCalled()
      expect(await rows({ payload, table: 'creation_drafts' })).toBe(0)
    })

    test('real owner loss immediately before SQLite commit rolls back the entire multi-write transaction', async ({
      payload,
    }) => {
      const lock = coordinator({
        config: { commandTimeoutMs: 100, leaseMs: 400, renewEveryMs: 50 },
      })
      const fixture = await seed({ coordinate: lock.coordinate, payload })
      const resource = 'sqlite-before-commit-loss'
      let assertLease: (() => void) | undefined
      const coordinate: CreationCoordinator = ({ resource, work }) =>
        lock.coordinate({
          resource,
          work: (lease) => {
            assertLease = lease.assertLease
            return work(lease)
          },
        })
      const runtime = createCreationRuntime({ gate, payload })
      await expect(
        unit({ coordinate, payload })({
          resource,
          work: async ({ req }) => {
            for (const sessionId of [99, 100]) {
              await runtime.create({
                collection: 'creation-drafts',
                data: { ...audit, sessionId, userId: fixture.userId },
                req,
              })
            }
            await redis.client.set(key({ config: lock.config, resource }), 'foreign', 'PX', 5000)
            await poll({ predicate: () => throwsLease({ assertLease: assertLease! }) })
            return 'must roll back'
          },
        }),
      ).rejects.toMatchObject({ code: 'COORDINATION_UNAVAILABLE' })
      expect(await rows({ payload, table: 'creation_drafts' })).toBe(0)
      expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
    })

    test('real SQLite commit remains reported as committed when Redis release acknowledgement is injected lost', async ({
      payload,
    }) => {
      const events: unknown[] = []
      const lock = coordinator({
        client: proxyClient({
          client: redis.client,
          eval: async (...args) => {
            const result = await redis.client.eval(...args)
            if (String(args[0]).includes("redis.call('del'")) {
              throw new Error('injected release ack loss')
            }
            return result
          },
        }),
        onEvent: (event) => events.push(event),
      })
      const fixture = await seed({ coordinate: lock.coordinate, payload })
      await expect(
        creator({ coordinate: lock.coordinate, payload })({
          command: fixture.command,
          userId: fixture.userId,
        }),
      ).resolves.toMatchObject({ isNew: true })
      expect(await rows({ payload, table: 'creation_sessions' })).toBe(1)
      expect(await rows({ payload, table: 'creation_drafts' })).toBe(1)
      expect(events.length).toBeGreaterThan(0)
    })
  },
)

function policy(): RedisCoordinationConfig {
  return {
    acquireTimeoutMs: 350,
    commandTimeoutMs: 120,
    leaseMs: 1000,
    maxHoldMs: 5000,
    namespace: `heymoro-test-${randomUUID()}`,
    renewEveryMs: 100,
    retryDelayMs: 15,
  }
}
function key({ config, resource }: { config: RedisCoordinationConfig; resource: string }) {
  return `${config.namespace}:${createHash('sha256').update(resource).digest('hex')}`
}
function barrier() {
  let open = () => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, wait: bounded({ promise: wait }) }
}
async function poll({
  predicate,
  timeoutMs = 3000,
}: {
  predicate: () => boolean | Promise<boolean>
  timeoutMs?: number
}) {
  const until = performance.now() + timeoutMs
  while (!(await predicate())) {
    if (performance.now() >= until) {
      throw new Error('Fixture poll expired.')
    }
    await delay(10)
  }
}
function throwsLease({ assertLease }: { assertLease: () => void }) {
  try {
    assertLease()
    return false
  } catch {
    return true
  }
}
function proxyClient({
  client,
  eval: evaluate,
  set,
}: {
  client: Redis
  eval?: RedisCoordinationClient['eval']
  set?: RedisCoordinationClient['set']
}): RedisCoordinationClient {
  return { eval: evaluate ?? client.eval.bind(client), set: set ?? client.set.bind(client) }
}
function unit({ coordinate, payload }: { coordinate: CreationCoordinator; payload: Payload }) {
  return createSQLiteUnitOfWork({
    coordinate,
    gate,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  })
}
function creator({ coordinate, payload }: { coordinate: CreationCoordinator; payload: Payload }) {
  return createPayloadSessionCreator({
    clock: () => new Date().toISOString(),
    coordinate,
    gate,
    hostCaps,
    isCompatible: ({ schemaVersion }) => schemaVersion === 1,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  })
}
async function rows({
  payload,
  table,
}: {
  payload: Payload
  table: 'creation_drafts' | 'creation_sessions'
}) {
  return Number(
    (
      await getCreationSQLiteAdapter({ payload }).client.execute(
        `SELECT count(*) AS count FROM ${table}`,
      )
    ).rows[0]!.count,
  )
}
const hostCaps = {
  allowedMimeTypes: ['image/jpeg', 'image/png'],
  maxDescriptionLength: 200,
  maxImageBytes: 1000,
  maxImages: 4,
  maxNotesLength: 100,
  maxTotalImageBytes: 3000,
  minImages: 0,
}
const audit = {
  createdBy: 'system:fixture',
  deletedAt: null,
  deletedBy: null,
  isDeleted: false,
  updatedBy: 'system:fixture',
}
async function seed({
  coordinate,
  payload,
}: {
  coordinate: CreationCoordinator
  payload: Payload
}) {
  const user = await payload.create({
    collection: 'users',
    data: { status: 'active' } as never,
    overrideAccess: true,
  })
  const runtime = createCreationRuntime({ gate, payload })
  return unit({ coordinate, payload })({
    resource: 'redis-sqlite-seed',
    work: async ({ req }: { req: PayloadRequest }) => {
      const template = await runtime.create({
        collection: 'creation-templates',
        data: {
          ...audit,
          name: 'Portrait',
          code: 'portrait',
          costCredits: 3,
          displayConfigJson: JSON.stringify({
            name: 'Portrait',
            coverMediaId: 21,
            examples: [{ inputMediaIds: [31], outputMediaId: 32 }],
          }),
          generationConfigJson: '{}',
          inputSchemaJson: JSON.stringify({ ...hostCaps, maxDescriptionLength: 0, minImages: 1 }),
          kind: 'effect',
          minClientCapability: '1',
          schemaVersion: 1,
          shareConfigJson: '{}',
          sortOrder: 0,
          status: 'published',
        },
        req,
      })
      const templateId = Number(template.id)
      return {
        command: { clientRequestId: 'redis-key', templateId },
        userId: Number(user.id),
      }
    },
  })
}
