import { createClient } from '@libsql/client'
import { decodeJwt, SignJWT } from 'jose'
import { createPayloadRequest } from 'payload'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { generationResultKey } from '../../src/creation/domain/generation.js'
import { createQuoteCodec } from '../../src/creation/domain/quote.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createRedisCreationCoordinator } from '../../src/creation/infrastructure/redis/coordinator.js'
import {
  audit,
  codecConfig,
  execution,
  finishSource,
  grant,
  NOW,
  rows,
  seed,
  service,
  update,
  write,
} from './generation-fixture.js'
import { startRedisFixture } from './redis-fixture.js'
import { cleanupSQLiteFixture, sqliteURL } from './sqlite.config.js'
import { corruptCurrentTemplate } from './template-corruption-fixture.js'

test.suite(
  'Heymoro atomic generation admission',
  { config: './sqlite.config.ts', cron: false },
  () => {
    test.afterAll(() => cleanupSQLiteFixture())
    test.afterEach(() => vi.restoreAllMocks())
    test('registers all T1 evidence as audited private tables without business FK or UNIQUE', async ({
      payload,
    }) => {
      const client = getCreationSQLiteAdapter({ payload }).client
      for (const slug of [
        'generation-tasks',
        'generation-inputs',
        'artifacts',
        'credit-reservations',
        'credit-allocations',
      ]) {
        expect(
          payload.config.collections.find((item) => item.slug === slug),
          slug,
        ).toBeDefined()
        const table = slug.replaceAll('-', '_')
        const fields = (await client.execute(`PRAGMA table_info(${table})`)).rows
        expect(fields.map((field) => field.name)).toEqual(
          expect.arrayContaining([
            'id',
            'created_by',
            'updated_by',
            'is_deleted',
            'deleted_at',
            'deleted_by',
          ]),
        )
        expect((await client.execute(`PRAGMA foreign_key_list(${table})`)).rows).toEqual([])
        expect(
          (await client.execute(`PRAGMA index_list(${table})`)).rows.every(
            (row) => row.unique === 0,
          ),
        ).toBe(true)
      }
    })
    test('quotes through a read-only real SQLite snapshot and official signed JWT without Redis or wallet approval', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const coordinateMany = vi.fn()
      const actualQueue = payload.jobs.queue.bind(payload.jobs)
      const transactionIds: unknown[] = []
      const queue = vi.spyOn(payload.jobs, 'queue').mockImplementation((args) => {
        transactionIds.push(args.req?.transactionID)
        return actualQueue(args)
      })
      const result = await service({ coordinateMany, payload }).quoteGenerate(fixture)
      expect(result).toEqual({
        costCredits: 2,
        quoteToken: expect.any(String),
        templateId: fixture.templateId,
        validUntil: '2026-11-12T12:01:00.000Z',
      })
      const claims = decodeJwt(result.quoteToken)
      expect(claims).toMatchObject({
        aud: codecConfig.audience,
        costCredits: 2,
        iss: codecConfig.issuer,
        purpose: 'generate',
        sessionId: fixture.sessionId,
        templateId: fixture.templateId,
        userId: fixture.userId,
      })
      expect(claims.inputHash).toMatch(/^[a-f0-9]{64}$/)
      expect(claims.configurationHash).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|provider|storage|execution/)
      expect(coordinateMany).not.toHaveBeenCalled()
      expect(queue).not.toHaveBeenCalled()
      for (const table of ['generation_tasks', 'credit_accounts', 'credit_reservations']) {
        expect(await rows({ payload, table })).toEqual([])
      }
    })
    test('quote codec copies keys and rejects algorithm, kid, issuer, audience, purpose, expiry and incomplete claims', async () => {
      const keys = { key: new Uint8Array(32).fill(42) }
      const codec = createQuoteCodec({ ...codecConfig, keys, signingKid: 'key' })
      keys.key.fill(0)
      const binding = {
        configurationHash: 'b'.repeat(64),
        costCredits: 0,
        inputHash: 'a'.repeat(64),
        purpose: 'generate' as const,
        sessionId: 2,
        templateId: 3,
        userId: 1,
      }
      const signed = await codec.issue({ binding, now: NOW })
      expect(await codec.verify({ now: NOW, token: signed.quoteToken })).toMatchObject(binding)
      await expect(
        codec.verify({ now: '2026-11-12T12:01:00.000Z', token: signed.quoteToken }),
      ).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
      for (const mutation of [
        { purpose: 'other' },
        { iss: 'other' },
        { aud: 'other' },
        { costCredits: -1 },
        { inputHash: null },
        { configurationHash: null },
        { templateVersionId: 3 },
        { exp: 9999999999 },
      ]) {
        const token = await new SignJWT({
          ...decodeJwt<Record<string, unknown>>(signed.quoteToken),
          ...mutation,
        })
          .setProtectedHeader({ alg: 'HS256', kid: 'key', typ: 'JWT' })
          .sign(new Uint8Array(32).fill(42))
        await expect(codec.verify({ now: NOW, token })).rejects.toMatchObject({
          code: 'QUOTE_CHANGED',
        })
      }
      for (const header of [
        { alg: 'HS384', kid: 'key' },
        { alg: 'HS256', kid: 'unknown' },
      ]) {
        const token = await new SignJWT(decodeJwt(signed.quoteToken))
          .setProtectedHeader(header)
          .sign(new Uint8Array(48).fill(42))
        await expect(codec.verify({ now: NOW, token })).rejects.toMatchObject({
          code: 'QUOTE_CHANGED',
        })
      }
      expect(() => createQuoteCodec({ ...codecConfig, ttlSeconds: 0 })).toThrow()
      expect(() => createQuoteCodec({ ...codecConfig, keys: {} })).toThrow()
    })
    test('quote validates fixed published template, account, ownership, exact mode and media metadata without execution defaults', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      await expect(
        service({ execution: null, payload }).quoteGenerate(fixture),
      ).rejects.toMatchObject({ code: 'GENERATION_NOT_CONFIGURED', status: 503 })
      await expect(
        service({ payload, quoteCodec: null }).quoteGenerate(fixture),
      ).rejects.toMatchObject({ code: 'GENERATION_NOT_CONFIGURED' })
      await expect(
        service({ payload }).quoteGenerate({ ...fixture, userId: fixture.userId + 999 }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
      await expect(
        service({ payload }).quoteGenerate({
          ...fixture,
          input: { ...fixture.input, description: 'not effect' },
        }),
      ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
      // Simulate persisted damage; native service updates now reject storage identity mutation.
      await getCreationSQLiteAdapter({ payload }).client.execute({
        args: ['not-supported', fixture.mediaIds[0]!],
        sql: 'UPDATE media SET storage_backend = ? WHERE id = ?',
      })
      await expect(service({ payload }).quoteGenerate(fixture)).rejects.toMatchObject({
        code: 'INPUT_INVALID',
      })
    })

    test('atomically creates a real Payload task, ordered inputs, multi-grant reservation, balanced ledger, round and real job on the same request', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 5, payload })
      await grant({ amount: 4, key: 'permanent', payload, userId: fixture.userId })
      await grant({
        amount: 2,
        expiresAt: '2026-11-12T13:00:00.000Z',
        key: 'earlier',
        payload,
        userId: fixture.userId,
      })
      const coordinateMany = vi.fn(async ({ work }) => work({ assertLease: () => {} }))
      const generation = service({ coordinateMany, payload })
      const quote = await generation.quoteGenerate(fixture)
      const actualQueue = payload.jobs.queue.bind(payload.jobs)
      const transactionIds: unknown[] = []
      const queue = vi.spyOn(payload.jobs, 'queue').mockImplementation((args) => {
        transactionIds.push(args.req?.transactionID)
        return actualQueue(args)
      })
      const result = await generation.submitGenerate({
        ...fixture,
        clientRequestId: 'paid-1',
        quoteToken: quote.quoteToken,
      })
      expect(result).toMatchObject({
        isNew: true,
        task: {
          costCredits: 5,
          input: fixture.input,
          roundNo: 1,
          sessionId: fixture.sessionId,
          sourceTaskId: null,
          status: 'queued',
          templateId: fixture.templateId,
        },
      })
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|execution|provider|storage|sha256/)
      expect(coordinateMany.mock.calls[0]![0].resources).toEqual([
        `session:${fixture.userId}:${fixture.sessionId}`,
        `wallet:${fixture.userId}`,
      ])
      expect(queue).toHaveBeenCalledTimes(1)
      expect(queue.mock.calls[0]![0]).toMatchObject({
        input: { taskId: result.task.id },
        overrideAccess: true,
        queue: 'creation',
        task: 'heymoro-generate-v1',
      })
      expect(transactionIds).toEqual([expect.any(String)])
      const tasks = await rows({ payload, table: 'generation_tasks' })
      expect(tasks).toHaveLength(1)
      expect(JSON.parse(String(tasks[0]!.execution_snapshot_json))).toMatchObject({
        clientInput: { input: fixture.input, operation: 'generate', sessionId: fixture.sessionId },
        executionPlan: {
          model: 'fixture-image-v1',
          provider: 'fixture-local',
          systemPrompt: 'PRIVATE SYSTEM INSTRUCTION',
        },
        input: fixture.input,
        schemaVersion: 1,
        storageOutput: execution.storageOutput,
      })
      expect(
        (await rows({ payload, table: 'generation_inputs' })).map((row) => [
          row.position,
          row.media_id,
        ]),
      ).toEqual(fixture.mediaIds.map((id, index) => [index + 1, id]))
      expect(await rows({ payload, table: 'credit_reservations' })).toMatchObject([
        { amount_credits: 5, status: 'reserved', task_id: result.task.id },
      ])
      expect(
        (await rows({ payload, table: 'credit_allocations' })).map((row) => row.amount_credits),
      ).toEqual([2, 3])
      expect(await rows({ payload, table: 'credit_accounts' })).toMatchObject([
        { available_credits: 1, reserved_credits: 5 },
      ])
      expect(
        (await rows({ payload, table: 'credit_ledger' }))
          .filter((row) => row.operation === 'reserve')
          .map((row) => [row.amount_credits, row.available_delta, row.reserved_delta]),
      ).toEqual([
        [2, -2, 2],
        [3, -3, 3],
      ])
      expect(await rows({ payload, table: 'creation_sessions' })).toMatchObject([
        { next_round_no: 2 },
      ])
      expect(await rows({ payload, table: 'payload_jobs' })).toMatchObject([
        {
          input: JSON.stringify({ taskId: result.task.id }),
          queue: 'creation',
          task_slug: 'heymoro-generate-v1',
        },
      ])
    })
    test('zero-cost admission creates zero reservation and empty allocations without fake zero ledger or prior wallet', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 0, payload })
      const generation = service({ payload })
      const quote = await generation.quoteGenerate(fixture)
      const result = await generation.submitGenerate({
        ...fixture,
        clientRequestId: 'zero',
        quoteToken: quote.quoteToken,
      })
      expect(result.task.costCredits).toBe(0)
      expect(await rows({ payload, table: 'credit_reservations' })).toMatchObject([
        { amount_credits: 0 },
      ])
      expect(await rows({ payload, table: 'credit_allocations' })).toEqual([])
      expect(await rows({ payload, table: 'credit_ledger' })).toEqual([])
    })
    test('same canonical request replays after expiry, template withdrawal and missing host config; different content conflicts and inactive user never replays', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 0, payload })
      const generation = service({ payload })
      const quote = await generation.quoteGenerate(fixture)
      const args = { ...fixture, clientRequestId: 'replay', quoteToken: quote.quoteToken }
      const created = await generation.submitGenerate(args)
      await update({
        id: fixture.templateId,
        collection: 'creation-templates',
        data: { status: 'offline' },
        payload,
      })
      const unavailable = service({
        clock: () => '2026-11-12T13:00:00.000Z',
        execution: null,
        payload,
        quoteCodec: null,
      })
      expect(
        await unavailable.submitGenerate({ ...args, quoteToken: 'revoked-or-corrupt' }),
      ).toEqual({ ...created, isNew: false })
      await expect(
        unavailable.submitGenerate({ ...args, input: { ...fixture.input, userNotes: 'changed' } }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 })
      await payload.update({
        id: fixture.userId,
        collection: 'users',
        data: { status: 'disabled' } as never,
        overrideAccess: true,
      })
      await expect(unavailable.submitGenerate(args)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
        status: 401,
      })
      expect(await rows({ payload, table: 'generation_tasks' })).toHaveLength(1)
      expect(await rows({ payload, table: 'payload_jobs' })).toHaveLength(1)
    })
    test('first admission rechecks quote expiry after waiting for coordination and rolls back insufficient funding', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      let now = NOW
      const generation = service({
        clock: () => now,
        coordinateMany: async ({ work }) => {
          now = '2026-11-12T12:01:00.000Z'
          return work({ assertLease: () => {} })
        },
        payload,
      })
      const quote = await generation.quoteGenerate(fixture)
      await expect(
        generation.submitGenerate({
          ...fixture,
          clientRequestId: 'expired',
          quoteToken: quote.quoteToken,
        }),
      ).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
      await expect(
        service({ payload }).submitGenerate({
          ...fixture,
          clientRequestId: 'poor',
          quoteToken: quote.quoteToken,
        }),
      ).rejects.toMatchObject({ code: 'CREDITS_INSUFFICIENT', status: 402 })
      for (const table of [
        'generation_tasks',
        'credit_accounts',
        'credit_reservations',
        'payload_jobs',
      ]) {
        expect(await rows({ payload, table })).toEqual([])
      }
      expect(await rows({ payload, table: 'creation_sessions' })).toMatchObject([
        { next_round_no: 1 },
      ])
    })
    for (const target of ['payload_jobs', 'credit_allocations']) {
      test(`real SQL ${target} failure rolls back task, expiry, projection, reservations, ledger, round and job`, async ({
        payload,
      }) => {
        const fixture = await seed({ payload })
        await grant({ amount: 5, key: 'live', payload, userId: fixture.userId })
        await grant({
          amount: 3,
          expiresAt: '2026-11-12T12:00:01.000Z',
          key: 'expire',
          payload,
          userId: fixture.userId,
        })
        const generation = service({ clock: () => '2026-11-12T12:00:02.000Z', payload })
        const quote = await generation.quoteGenerate(fixture)
        const tables = [
          'generation_tasks',
          'generation_inputs',
          'credit_reservations',
          'credit_allocations',
          'credit_grants',
          'credit_accounts',
          'credit_ledger',
          'creation_sessions',
          'payload_jobs',
        ]
        const before = await Promise.all(tables.map((table) => rows({ payload, table })))
        const client = getCreationSQLiteAdapter({ payload }).client
        await client.execute(
          `CREATE TRIGGER fixture_fail BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT, 'fixture admission failure'); END`,
        )
        try {
          await expect(
            generation.submitGenerate({
              ...fixture,
              clientRequestId: 'failure',
              quoteToken: quote.quoteToken,
            }),
          ).rejects.toThrow()
        } finally {
          await client.execute('DROP TRIGGER fixture_fail')
        }
        expect(await Promise.all(tables.map((table) => rows({ payload, table })))).toEqual(before)
      })
    }

    test('executor readiness validates registered parameter values, not just names and primitive types', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      await corruptCurrentTemplate({
        data: {
          generationConfigJson: JSON.stringify({
            executorId: 'fixture-v1',
            parameters: { size: 'arbitrary' },
            systemPrompt: 'secret',
          }),
        },
        payload,
        templateId: fixture.templateId,
      })
      await expect(service({ payload }).quoteGenerate(fixture)).rejects.toMatchObject({
        code: 'GENERATION_NOT_CONFIGURED',
      })
    })
    test('regeneration freezes source inputs and execution, quotes current cost, ignores draft/config upgrades and authenticates replay without source', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 0, payload })
      const generation = service({ payload })
      const originalQuote = await generation.quoteGenerate(fixture)
      const original = await generation.submitGenerate({
        ...fixture,
        clientRequestId: 'source',
        quoteToken: originalQuote.quoteToken,
      })
      const artifactId = await finishSource({ payload, ...fixture, taskId: original.task.id })
      await write({
        payload,
        work: ({ req, runtime }) =>
          runtime.create({
            collection: 'creation-drafts',
            data: {
              ...audit,
              description: '',
              sessionId: fixture.sessionId,
              userId: fixture.userId,
              userNotes: 'NEW DRAFT IGNORED',
            },
            req,
          }),
      })
      await corruptCurrentTemplate({
        data: {
          costCredits: 1,
          generationConfigJson: JSON.stringify({
            executorId: 'fixture-v1',
            parameters: { size: '1024x1024' },
            systemPrompt: 'UPGRADED PROMPT IGNORED',
          }),
        },
        payload,
        templateId: fixture.templateId,
      })
      await grant({ payload, userId: fixture.userId })
      const args = { sourceArtifactId: artifactId, userId: fixture.userId }
      const quote = await generation.quoteRegeneration(args)
      expect(decodeJwt(quote.quoteToken)).toMatchObject({
        costCredits: 1,
        purpose: 'regenerate',
        sourceArtifactId: artifactId,
      })
      const accepted = await generation.submitRegeneration({
        ...args,
        clientRequestId: 'regenerate',
        quoteToken: quote.quoteToken,
      })
      expect(accepted).toMatchObject({
        isNew: true,
        task: { costCredits: 1, input: fixture.input, roundNo: 2, sourceTaskId: original.task.id },
      })
      const snapshots = (await rows({ payload, table: 'generation_tasks' })).map((row) =>
        JSON.parse(String(row.execution_snapshot_json)),
      )
      expect(snapshots[1].executionPlan).toEqual(snapshots[0].executionPlan)
      expect(snapshots[1].media).toEqual(snapshots[0].media)
      expect(snapshots[1].clientInput).toEqual({
        operation: 'regenerate',
        sessionId: fixture.sessionId,
        sourceArtifactId: artifactId,
      })
      expect(snapshots[1].quote.costCredits).toBe(1)
      await update({
        id: artifactId,
        collection: 'artifacts',
        data: { deletedAt: NOW, deletedBy: audit.updatedBy, isDeleted: true },
        payload,
      })
      expect(
        await service({ execution: null, payload, quoteCodec: null }).submitRegeneration({
          ...args,
          clientRequestId: 'regenerate',
          quoteToken: 'ignored',
        }),
      ).toEqual({ ...accepted, isNew: false })
      await expect(generation.quoteRegeneration(args)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    test('derives new immutable result keys from real task and attempt identities without URL or credentials', () => {
      expect(
        generationResultKey({
          attemptId: 34,
          keyRule: 'task-attempt-result-v1',
          sha256: 'a'.repeat(64),
          taskId: 12,
        }),
      ).toBe(`tasks/12/attempts/34/result-${'a'.repeat(64)}`)
      expect(() =>
        generationResultKey({
          attemptId: 34,
          keyRule: 'task-attempt-result-v1',
          sha256: 'a'.repeat(64),
          taskId: 0,
        }),
      ).toThrow()
    })
    test('same-session Redis double click accepts one task and returns one idempotent replay without nested lock acquisition', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 0, payload })
      const redis = await startRedisFixture()
      try {
        const coordinateMany = createRedisCreationCoordinator({
          client: redis.client,
          config: {
            acquireTimeoutMs: 3000,
            commandTimeoutMs: 200,
            leaseMs: 800,
            maxHoldMs: 5000,
            namespace: 'generation-double',
            renewEveryMs: 100,
            retryDelayMs: 10,
          },
        }).coordinateMany
        const generation = service({ coordinateMany, payload })
        const quote = await generation.quoteGenerate(fixture)
        const args = { ...fixture, clientRequestId: 'double', quoteToken: quote.quoteToken }
        const accepted = await Promise.all([
          generation.submitGenerate(args),
          generation.submitGenerate(args),
        ])
        expect(accepted.map((item) => item.isNew).sort()).toEqual([false, true])
        expect(accepted[0]!.task.id).toBe(accepted[1]!.task.id)
        expect(await rows({ payload, table: 'payload_jobs' })).toHaveLength(1)
        expect(await rows({ payload, table: 'credit_reservations' })).toHaveLength(1)
      } finally {
        await redis.stop()
      }
    })
    test('different sessions coordinate one real Redis wallet and do not over-reserve the shared funds', async ({
      payload,
    }) => {
      const first = await seed({ cost: 4, payload })
      const second = await seed({ cost: 4, payload, userId: first.userId })
      await grant({ amount: 5, payload, userId: first.userId })
      const redis = await startRedisFixture()
      try {
        const coordinateMany = createRedisCreationCoordinator({
          client: redis.client,
          config: {
            acquireTimeoutMs: 3000,
            commandTimeoutMs: 200,
            leaseMs: 800,
            maxHoldMs: 5000,
            namespace: 'generation-wallet',
            renewEveryMs: 100,
            retryDelayMs: 10,
          },
        }).coordinateMany
        const generation = service({ coordinateMany, payload })
        const quotes = await Promise.all([
          generation.quoteGenerate(first),
          generation.quoteGenerate(second),
        ])
        const results = await Promise.allSettled([
          generation.submitGenerate({
            ...first,
            clientRequestId: 'first',
            quoteToken: quotes[0]!.quoteToken,
          }),
          generation.submitGenerate({
            ...second,
            clientRequestId: 'second',
            quoteToken: quotes[1]!.quoteToken,
          }),
        ])
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({
          reason: { code: 'CREDITS_INSUFFICIENT' },
        })
        expect(await rows({ payload, table: 'credit_accounts' })).toMatchObject([
          { available_credits: 1, reserved_credits: 4 },
        ])
        expect(await rows({ payload, table: 'payload_jobs' })).toHaveLength(1)
      } finally {
        await redis.stop()
      }
    })
    test('losing a real Redis lease after native queue insert rolls back the job and every T1 write', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      await grant({ payload, userId: fixture.userId })
      const redis = await startRedisFixture()
      try {
        const coordinateMany = createRedisCreationCoordinator({
          client: redis.client,
          config: {
            acquireTimeoutMs: 3000,
            commandTimeoutMs: 200,
            leaseMs: 800,
            maxHoldMs: 5000,
            namespace: 'generation-loss',
            renewEveryMs: 100,
            retryDelayMs: 10,
          },
        }).coordinateMany
        const generation = service({ coordinateMany, payload })
        const quote = await generation.quoteGenerate(fixture)
        const actualQueue = payload.jobs.queue.bind(payload.jobs)
        vi.spyOn(payload.jobs, 'queue').mockImplementation(async (args) => {
          const job = await actualQueue(args)
          const [key] = await redis.client.keys('generation-loss:*')
          expect(key).toBeDefined()
          await redis.client.set(key!, 'replacement-owner', 'PX', 3000)
          await new Promise((resolve) => setTimeout(resolve, 150))
          return job
        })
        const tables = [
          'generation_tasks',
          'generation_inputs',
          'credit_reservations',
          'credit_allocations',
          'credit_ledger',
          'credit_accounts',
          'credit_grants',
          'payload_jobs',
          'creation_sessions',
        ]
        const before = await Promise.all(tables.map((table) => rows({ payload, table })))
        await expect(
          generation.submitGenerate({
            ...fixture,
            clientRequestId: 'lease-loss',
            quoteToken: quote.quoteToken,
          }),
        ).rejects.toMatchObject({ code: 'COORDINATION_UNAVAILABLE' })
        expect(await Promise.all(tables.map((table) => rows({ payload, table })))).toEqual(before)
      } finally {
        await redis.stop()
      }
    })
    test('binds current configuration, rejects quote input/cost mismatch, blocks active round and never accepts an offline parent', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 0, payload })
      const generation = service({ payload })
      const quote = await generation.quoteGenerate(fixture)
      await expect(
        generation.submitGenerate({
          ...fixture,
          clientRequestId: 'mismatch',
          input: { ...fixture.input, inputMediaIds: [...fixture.mediaIds].reverse() },
          quoteToken: quote.quoteToken,
        }),
      ).rejects.toMatchObject({ code: 'QUOTE_CHANGED' })
      await corruptCurrentTemplate({
        data: { costCredits: 1 },
        payload,
        templateId: fixture.templateId,
      })
      await expect(
        generation.submitGenerate({
          ...fixture,
          clientRequestId: 'price',
          quoteToken: quote.quoteToken,
        }),
      ).rejects.toMatchObject({ code: 'QUOTE_CHANGED' })
      await corruptCurrentTemplate({
        data: { costCredits: 0 },
        payload,
        templateId: fixture.templateId,
      })
      await update({
        id: fixture.templateId,
        collection: 'creation-templates',
        data: { name: 'Internal metadata changed' },
        payload,
      })
      const accepted = await generation.submitGenerate({
        ...fixture,
        clientRequestId: 'first',
        quoteToken: quote.quoteToken,
      })
      expect(accepted.task.templateId).toBe(fixture.templateId)
      expect(Object.hasOwn(accepted.task, 'templateVersionId')).toBe(false)
      await expect(
        generation.submitGenerate({
          ...fixture,
          clientRequestId: 'second',
          quoteToken: quote.quoteToken,
        }),
      ).rejects.toMatchObject({ code: 'GENERATION_IN_PROGRESS' })
      await update({
        id: accepted.task.id,
        collection: 'generation-tasks',
        data: { status: 'failed' },
        payload,
      })
      await update({
        id: fixture.templateId,
        collection: 'creation-templates',
        data: { status: 'offline' },
        payload,
      })
      await expect(
        generation.submitGenerate({
          ...fixture,
          clientRequestId: 'third',
          quoteToken: quote.quoteToken,
        }),
      ).rejects.toMatchObject({ code: 'TEMPLATE_UNAVAILABLE' })
      expect(await rows({ payload, table: 'generation_tasks' })).toHaveLength(1)
    })
    test('free mode requires description and forbids notes while preserving original text at quote and admission', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 0, mode: 'free', payload })
      const generation = service({ payload })
      await expect(generation.quoteGenerate({ ...fixture, input: {} })).rejects.toMatchObject({
        code: 'DESCRIPTION_REQUIRED',
      })
      await expect(
        generation.quoteGenerate({
          ...fixture,
          input: { description: 'okay', userNotes: 'forbidden' },
        }),
      ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
      const quote = await generation.quoteGenerate(fixture)
      expect(
        (
          await generation.submitGenerate({
            ...fixture,
            clientRequestId: 'free',
            quoteToken: quote.quoteToken,
          })
        ).task.input,
      ).toEqual(fixture.input)
    })

    test('rechecks media after quote and rejects owner, inactive source, or invalid StorageRef without partial billing', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 0, payload })
      const generation = service({ payload })
      const quote = await generation.quoteGenerate(fixture)
      // Explicit SQL damage after quote preserves the submit-time integrity test.
      await getCreationSQLiteAdapter({ payload }).client.execute({
        args: ['../invalid.png', '../invalid.png', fixture.mediaIds[0]!],
        sql: 'UPDATE media SET storage_name = ?, filename = ? WHERE id = ?',
      })
      await expect(
        generation.submitGenerate({
          ...fixture,
          clientRequestId: 'invalid-media',
          quoteToken: quote.quoteToken,
        }),
      ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
      const other = await seed({ cost: 0, payload })
      await expect(
        generation.quoteGenerate({ ...fixture, userId: other.userId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(await rows({ payload, table: 'generation_tasks' })).toEqual([])
      expect(await rows({ payload, table: 'payload_jobs' })).toEqual([])
    })
    test('native generation jobs are private, do not auto-run, have zero retries and do not execute handlers during admission', async ({
      payload,
    }) => {
      expect(payload.config.jobs.autoRun).toEqual([])
      const task = payload.config.jobs.tasks?.find((task) => task.slug === 'heymoro-generate-v1')
      expect(task?.retries).toBe(0)
      const config = payload.config.collections.find(
        (collection) => collection.slug === 'payload-jobs',
      )!
      const args = { slug: 'payload-jobs', req: await createPayloadRequest({ payload }) }
      for (const access of [
        config.access.read,
        config.access.create,
        config.access.update,
        config.access.delete,
        payload.config.jobs.access?.queue,
        payload.config.jobs.access?.run,
      ]) {
        expect(await access!(args)).toBe(false)
      }
    })
    test('requires immutable task snapshot and input identities even inside the legal write gate', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 0, payload })
      const generation = service({ payload })
      const quote = await generation.quoteGenerate(fixture)
      const accepted = await generation.submitGenerate({
        ...fixture,
        clientRequestId: 'immutable',
        quoteToken: quote.quoteToken,
      })
      for (const data of [
        { executionSnapshotJson: '{}' },
        { description: 'changed' },
        { userId: fixture.userId + 1 },
        { deletedAt: NOW, deletedBy: audit.updatedBy, isDeleted: true },
      ]) {
        await expect(
          update({ id: accepted.task.id, collection: 'generation-tasks', data, payload }),
        ).rejects.toThrow()
      }
      const input = (await rows({ payload, table: 'generation_inputs' }))[0]!
      await expect(
        update({
          id: Number(input.id),
          collection: 'generation-inputs',
          data: { mediaId: fixture.mediaIds[1] },
          payload,
        }),
      ).rejects.toThrow()
    })

    test('rejects replay whose queued reservation has already been released instead of returning a contradictory accepted task', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 0, payload })
      const generation = service({ payload })
      const quote = await generation.quoteGenerate(fixture)
      const args = { ...fixture, clientRequestId: 'contradictory', quoteToken: quote.quoteToken }
      await generation.submitGenerate(args)
      const [reservation] = await rows({ payload, table: 'credit_reservations' })
      await update({
        id: Number(reservation!.id),
        collection: 'credit-reservations',
        data: { status: 'released' },
        payload,
      })
      await expect(generation.submitGenerate(args)).rejects.toMatchObject({
        code: 'DATA_INTEGRITY_CONFLICT',
        status: 503,
      })
    })
    test('rejects regeneration from a succeeded source whose funds remain reserved', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 0, payload })
      const generation = service({ payload })
      const quote = await generation.quoteGenerate(fixture)
      const accepted = await generation.submitGenerate({
        ...fixture,
        clientRequestId: 'unsettled-source',
        quoteToken: quote.quoteToken,
      })
      const artifactId = await finishSource({
        payload,
        ...fixture,
        isCaptured: false,
        taskId: accepted.task.id,
      })
      await expect(
        generation.quoteRegeneration({ sourceArtifactId: artifactId, userId: fixture.userId }),
      ).rejects.toMatchObject({ code: 'DATA_INTEGRITY_CONFLICT', status: 503 })
    })

    test('requires captured source allocations to belong to the same wallet and owner, with real fixture capture evidence', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 2, payload })
      await grant({ key: 'source-funds', payload, userId: fixture.userId })
      const generation = service({ payload })
      const quote = await generation.quoteGenerate(fixture)
      const original = await generation.submitGenerate({
        ...fixture,
        clientRequestId: 'paid-source',
        quoteToken: quote.quoteToken,
      })
      const sourceArtifactId = await finishSource({ payload, ...fixture, taskId: original.task.id })
      expect(
        await generation.quoteRegeneration({ sourceArtifactId, userId: fixture.userId }),
      ).toMatchObject({ costCredits: 2 })
      const other = await seed({ cost: 0, payload })
      const otherGrant = await grant({ key: 'other-funds', payload, userId: other.userId })
      await getCreationSQLiteAdapter({ payload }).client.execute({
        args: [otherGrant.grantId, original.task.id],
        sql: 'UPDATE credit_allocations SET grant_id = ? WHERE reservation_id = (SELECT id FROM credit_reservations WHERE task_id = ?)',
      })
      await expect(
        generation.quoteRegeneration({ sourceArtifactId, userId: fixture.userId }),
      ).rejects.toMatchObject({ code: 'DATA_INTEGRITY_CONFLICT' })
    })
    test('retries the entire T1 callback after a real SQLite busy snapshot and re-reads clock and round', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 0, payload })
      const other = createClient({ url: sqliteURL })
      const clock = vi.fn(() => NOW)
      const generation = service({ clock, payload })
      const quote = await generation.quoteGenerate(fixture)
      const actualFind = payload.find.bind(payload)
      let hasInjected = false
      const transactionIds = new Set<unknown>()
      vi.spyOn(payload, 'find').mockImplementation(async (args) => {
        const result = await actualFind(args)
        if (
          String(args.collection) === 'generation-tasks' &&
          JSON.stringify(args.where).includes('roundNo')
        ) {
          transactionIds.add(args.req?.transactionID)
          if (!hasInjected) {
            hasInjected = true
            await other.execute({
              args: [fixture.sessionId],
              sql: "UPDATE creation_sessions SET title = 'fixture-busy-write' WHERE id = ?",
            })
          }
        }
        return result
      })
      try {
        const accepted = await generation.submitGenerate({
          ...fixture,
          clientRequestId: 'busy',
          quoteToken: quote.quoteToken,
        })
        expect(accepted.task.roundNo).toBe(1)
        expect(transactionIds.size).toBe(2)
        expect(clock.mock.calls.length).toBeGreaterThanOrEqual(3)
        expect(await rows({ payload, table: 'generation_tasks' })).toHaveLength(1)
        expect(await rows({ payload, table: 'payload_jobs' })).toHaveLength(1)
      } finally {
        other.close()
      }
    })
    test('new regeneration uses the current host output destination while source evidence and accepted replay retain the old destination', async ({
      payload,
    }) => {
      const fixture = await seed({ cost: 0, payload })
      const originalService = service({ payload })
      const originalQuote = await originalService.quoteGenerate(fixture)
      const originalArgs = {
        ...fixture,
        clientRequestId: 'destination-source',
        quoteToken: originalQuote.quoteToken,
      }
      const original = await originalService.submitGenerate(originalArgs)
      const sourceArtifactId = await finishSource({ payload, ...fixture, taskId: original.task.id })
      await expect(
        service({ execution: null, payload }).quoteRegeneration({
          sourceArtifactId,
          userId: fixture.userId,
        }),
      ).rejects.toMatchObject({ code: 'GENERATION_NOT_CONFIGURED' })
      await expect(
        service({
          execution: {
            ...execution,
            storageOutput: { ...execution.storageOutput, backend: 'unsupported-current-backend' },
          },
          payload,
        }).quoteRegeneration({ sourceArtifactId, userId: fixture.userId }),
      ).rejects.toMatchObject({ code: 'GENERATION_NOT_CONFIGURED' })
      const nextDestination = { ...execution.storageOutput, bucket: 'fixture-output-b' }
      const generation = service({
        execution: { ...execution, storageOutput: nextDestination },
        payload,
      })
      const quote = await generation.quoteRegeneration({ sourceArtifactId, userId: fixture.userId })
      const regenerated = await generation.submitRegeneration({
        clientRequestId: 'destination-new',
        quoteToken: quote.quoteToken,
        sourceArtifactId,
        userId: fixture.userId,
      })
      const tasks = await rows({ payload, table: 'generation_tasks' })
      const sourceSnapshot = JSON.parse(String(tasks[0]!.execution_snapshot_json))
      const snapshot = JSON.parse(String(tasks[1]!.execution_snapshot_json))
      expect(sourceSnapshot.storageOutput).toEqual(execution.storageOutput)
      expect(snapshot.storageOutput).toEqual(nextDestination)
      expect(snapshot.executionPlan).toEqual(sourceSnapshot.executionPlan)
      expect(snapshot.media).toEqual(sourceSnapshot.media)
      expect(
        generationResultKey({
          attemptId: 99,
          keyRule: snapshot.storageOutput.keyRule,
          sha256: 'd'.repeat(64),
          taskId: regenerated.task.id,
        }),
      ).toBe(`tasks/${regenerated.task.id}/attempts/99/result-${'d'.repeat(64)}`)
      expect(
        (await service({ execution: null, payload, quoteCodec: null }).submitGenerate(originalArgs))
          .isNew,
      ).toBe(false)
      expect(
        JSON.parse(
          String((await rows({ payload, table: 'generation_tasks' }))[0]!.execution_snapshot_json),
        ).storageOutput,
      ).toEqual(execution.storageOutput)
    })
  },
)
