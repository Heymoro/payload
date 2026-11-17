import type { Payload } from 'payload'

import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createGenerationReader } from '../../src/creation/infrastructure/payload/generation-reader.js'
import { createSQLiteReadSnapshot } from '../../src/creation/infrastructure/payload/read-snapshot.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'
import { cleanupRuntime, config, gate, state } from './runtime.config.js'
import { seedChain } from './runtime-seed.js'

/** Source-only addition: execution requires a separately approved new Native target. */
async function unknownTask({ payload }: { payload: Payload }) {
  state.kind = 'unknown'
  state.imageCalls = 0
  const seeded = await seedChain({ config, gate, payload })
  const runtime = getCoreRuntime({ payload })
  const created = await runtime.session({
    command: {
      clientRequestId: 'reconciliation-session',
      templateId: seeded.templateId,
    },
    userId: seeded.userId,
  })
  const sessionId = created.session.id
  const input = { description: 'Unresolved delivery', inputMediaIds: [], userNotes: '' }
  const quote = await runtime.admission.quoteGenerate({ input, sessionId, userId: seeded.userId })
  const accepted = await runtime.admission.submitGenerate({
    clientRequestId: 'reconciliation-task',
    input,
    quoteToken: quote.quoteToken,
    sessionId,
    userId: seeded.userId,
  })
  const taskId = accepted.task.id
  await runtime.worker.run({ taskId })
  const attempts = await createSQLiteReadSnapshot({ payload })({
    work: ({ find }) => createGenerationReader({ find }).readTaskAttempts({ taskId }),
  })
  expect(attempts).toHaveLength(1)
  const attemptId = Number(attempts[0]!.id)
  const login = await payload.login({
    collection: 'admins',
    data: {
      email: `fixture-${seeded.userId}@local.invalid`,
      password: 'fixture-local-password-137',
    },
  })
  expect(login.token).toBeTypeOf('string')
  return { ...seeded, attemptId, authorization: `JWT ${login.token!}`, runtime, taskId }
}

test.suite(
  'Heymoro Native generation reconciliation',
  { config: './runtime.config.ts', cron: false },
  () => {
    test.afterEach(() => vi.restoreAllMocks())
    test.afterAll(cleanupRuntime)
    test('formal runtime inspects without writes, keeps recover pending, closes once with original op and no model resend', async ({
      payload,
    }) => {
      const f = await unknownTask({ payload })
      const base = { authorization: f.authorization, taskId: f.taskId }
      const execute = (input: unknown) =>
        f.runtime.reconciliation.execute({ input, requestId: randomUUID() })
      expect(await execute({ ...base, action: 'inspect' })).toMatchObject({
        outcome: 'confirmed',
        result: 'pending',
        taskStatus: 'unknown',
      })
      expect(await execute({ ...base, action: 'recover', attemptId: f.attemptId })).toMatchObject({
        result: 'pending',
      })
      const close = {
        ...base,
        action: 'close-undelivered',
        attemptId: f.attemptId,
        confirmedUndelivered: true,
        operationId: 'native.close.1',
      }
      expect(await execute(close)).toMatchObject({
        expiredCredits: 0,
        originalOperationId: close.operationId,
        outcome: 'confirmed',
        releasedCredits: 2,
        result: 'closed',
      })
      expect(await execute({ ...close, operationId: 'native.close.2' })).toMatchObject({
        originalOperationId: close.operationId,
      })
      expect(state.imageCalls).toBe(1)
      const audits = await payload.find({
        collection: 'auditLogs',
        overrideAccess: true,
        pagination: false,
        where: { correlationId: { equals: close.operationId } },
      })
      expect(audits.docs).toHaveLength(1)
      expect(audits.docs[0]).toMatchObject({
        actorId: String(f.adminId),
        actorType: 'admin',
        requestId: close.operationId,
        summary: { reason: 'PROVIDER_UNRESOLVED', taskId: f.taskId },
      })
      expect((await f.runtime.credits.account({ userId: f.userId })).reserved).toBe(0)
    })
    test('Native read after independent preauth rejects an administrator demoted before the snapshot', async ({
      payload,
    }) => {
      const f = await unknownTask({ payload })
      const authenticate = payload.auth.bind(payload)
      vi.spyOn(payload, 'auth').mockImplementation(async (args) => {
        const principal = await authenticate(args)
        if (!args.req) {
          await getCreationSQLiteAdapter({ payload }).client.execute({
            args: ['operator', f.adminId],
            sql: 'UPDATE admins SET role = ? WHERE id = ?',
          })
        }
        return principal
      })
      await expect(
        f.runtime.reconciliation.execute({
          input: { action: 'inspect', authorization: f.authorization, taskId: f.taskId },
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'RECONCILIATION_FORBIDDEN', outcome: 'not_started' })
      expect((await f.runtime.credits.account({ userId: f.userId })).reserved).toBe(2)
      expect(state.imageCalls).toBe(1)
    })
    test('rejects a former current attempt, opaque token and Native operator without releasing', async ({
      payload,
    }) => {
      const f = await unknownTask({ payload })
      const base = {
        action: 'close-undelivered',
        attemptId: f.attemptId,
        authorization: f.authorization,
        confirmedUndelivered: true,
        operationId: 'native.reject.1',
        taskId: f.taskId,
      }
      await expect(
        f.runtime.reconciliation.execute({
          input: { ...base, attemptId: f.attemptId + 1 },
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'RECONCILIATION_DATA_INTEGRITY' })
      await expect(
        f.runtime.reconciliation.execute({
          input: { ...base, authorization: 'JWT invalid.token.signature' },
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'RECONCILIATION_UNAUTHORIZED' })
      await getCreationSQLiteAdapter({ payload }).client.execute({
        args: ['operator', f.adminId],
        sql: 'UPDATE admins SET role = ? WHERE id = ?',
      })
      await expect(
        f.runtime.reconciliation.execute({ input: base, requestId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'RECONCILIATION_FORBIDDEN' })
      expect((await f.runtime.credits.account({ userId: f.userId })).reserved).toBe(2)
      expect(state.imageCalls).toBe(1)
    })
  },
)
