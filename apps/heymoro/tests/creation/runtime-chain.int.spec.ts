import { setTimeout as sleep } from 'node:timers/promises'
import { expect } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { consumeGenerationJobs } from '../../src/creation/infrastructure/payload/generation-consumer.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'
import { cleanupRuntime, config, gate, state } from './runtime.config.js'
import { seedChain } from './runtime-seed.js'

test.suite(
  'Heymoro actual core runtime chain',
  { config: './runtime.config.ts', cron: false },
  () => {
    test.afterAll(cleanupRuntime)
    test('continuously consumes newly admitted native jobs and replays without another charge or name', async ({
      payload,
    }) => {
      state.kind = 'output'
      state.imageCalls = 0
      state.namingCalls = 0
      const fixture = await seedChain({ config, gate, payload })
      const runtime = getCoreRuntime({ payload })
      const created = await runtime.session({
        command: {
          clientRequestId: 'runtime-session',
          templateId: fixture.templateId,
        },
        userId: fixture.userId,
      })
      const sessionId = created.session.id
      const input = { description: '  Draw a tree\n', inputMediaIds: [], userNotes: '' }
      await runtime.draft.save({ input, sessionId, userId: fixture.userId })
      const quote = await runtime.admission.quoteGenerate({
        input,
        sessionId,
        userId: fixture.userId,
      })
      const command = {
        clientRequestId: 'runtime-generation',
        input,
        quoteToken: quote.quoteToken,
        sessionId,
        userId: fixture.userId,
      }
      const controller = new AbortController()
      let consumerError: Error | undefined
      const consumer = consumeGenerationJobs({
        intervalMs: 20,
        isContinuous: true,
        queues: ['creation', 'creation-naming'],
        run: (args) => payload.jobs.run(args),
        signal: controller.signal,
      }).catch((error: unknown) => {
        consumerError = error instanceof Error ? error : new Error('Consumer stopped unexpectedly.')
      })
      let accepted: Awaited<ReturnType<typeof runtime.admission.submitGenerate>>
      try {
        accepted = await runtime.admission.submitGenerate(command)
        const deadline = Date.now() + 10_000
        while (true) {
          if (consumerError) {
            throw consumerError
          }
          const task = await runtime.tasks.get({ taskId: accepted.task.id, userId: fixture.userId })
          const session = await payload.findByID({
            id: sessionId,
            collection: 'creation-sessions' as never,
            overrideAccess: true,
          })
          if (task.status === 'succeeded' && session.autoNameStatus === 'succeeded') {
            break
          }
          if (Date.now() >= deadline) {
            throw new Error('Continuous jobs did not deliver in time.')
          }
          await sleep(20)
        }
      } finally {
        controller.abort()
        await consumer
      }
      expect(consumerError).toBeUndefined()
      expect(state.imageCalls).toBe(1)
      expect(state.namingCalls).toBe(1)
      const replay = await runtime.admission.submitGenerate(command)
      expect(replay.task.id).toBe(accepted.task.id)
      expect(replay.isNew).toBe(false)
      await runtime.worker.run({ taskId: accepted.task.id })
      await runtime.naming.run({ sessionId })
      expect(state.imageCalls).toBe(1)
      expect(state.namingCalls).toBe(1)
      const artifacts = await payload.find({
        collection: 'artifacts' as never,
        limit: 10,
        overrideAccess: true,
      })
      expect(artifacts.docs).toHaveLength(1)
      const account = await payload.find({
        collection: 'credit-accounts' as never,
        overrideAccess: true,
      })
      expect(account.docs[0]).toMatchObject({ availableCredits: 5, reservedCredits: 0 })
      const session = await payload.findByID({
        id: sessionId,
        collection: 'creation-sessions' as never,
        overrideAccess: true,
      })
      expect(session).toMatchObject({ autoNameStatus: 'succeeded', title: 'Runtime named' })
      const userId = fixture.userId
      expect((await runtime.catalog.getFreePreset())?.templateId).toBe(fixture.templateId)
      expect((await runtime.sessions.list({ query: {}, userId })).items).toHaveLength(1)
      expect((await runtime.sessions.get({ sessionId, userId })).id).toBe(sessionId)
      expect((await runtime.tasks.list({ query: {}, sessionId, userId })).items).toHaveLength(1)
      expect((await runtime.tasks.get({ taskId: accepted.task.id, userId })).id).toBe(
        accepted.task.id,
      )
      const library = await runtime.library.list({ query: {}, userId })
      expect(library.items).toHaveLength(1)
      const artifactId = library.items[0]!.id
      await runtime.favorite.set({ artifactId, isFavorite: true, userId })
      expect((await runtime.library.get({ artifactId, userId })).isFavorite).toBe(true)
      expect((await runtime.credits.account({ userId })).available).toBe(5)
      expect((await runtime.credits.ledger({ query: {}, userId })).items).toHaveLength(3)
      expect((await runtime.credits.reservations({ query: {}, userId })).items).toHaveLength(0)
      await runtime.title({ command: { title: 'User kept' }, sessionId, userId })
      expect(Object.keys(runtime)).not.toContain('gate')
      expect(Object.keys(runtime)).not.toContain('write')
    })
    test('native unknown job does not resend; explicit recovery reads evidence and retains reservation', async ({
      payload,
    }) => {
      state.kind = 'unknown'
      state.imageCalls = 0
      const f = await seedChain({ config, gate, payload })
      const runtime = getCoreRuntime({ payload })
      const created = await runtime.session({
        command: {
          clientRequestId: 'unknown-session',
          templateId: f.templateId,
        },
        userId: f.userId,
      })
      const sessionId = created.session.id
      const input = { description: 'Unknown delivery', inputMediaIds: [], userNotes: '' }
      const quote = await runtime.admission.quoteGenerate({ input, sessionId, userId: f.userId })
      const accepted = await runtime.admission.submitGenerate({
        clientRequestId: 'unknown-task',
        input,
        quoteToken: quote.quoteToken,
        sessionId,
        userId: f.userId,
      })
      await payload.jobs.run({ limit: 5, overrideAccess: true, queue: 'creation' })
      await runtime.worker.run({ taskId: accepted.task.id })
      expect(state.imageCalls).toBe(1)
      const task = await payload.findByID({
        id: accepted.task.id,
        collection: 'generation-tasks' as never,
        overrideAccess: true,
      })
      expect(task).toMatchObject({ status: 'unknown' })
      const account = await payload.find({
        collection: 'credit-accounts' as never,
        overrideAccess: true,
      })
      expect(account.docs[0]).toMatchObject({ availableCredits: 5, reservedCredits: 2 })
    })
    test('current template edits affect new tasks while queued snapshots survive changes and offline status', async ({
      payload,
    }) => {
      state.kind = 'output'
      state.imageCalls = 0
      state.imagePlans = []
      const f = await seedChain({ config, gate, payload })
      const runtime = getCoreRuntime({ payload })
      const created = await runtime.session({
        command: {
          clientRequestId: 'configuration-change-session',
          templateId: f.templateId,
        },
        userId: f.userId,
      })
      const sessionId = created.session.id
      const input = { description: 'Original requested image', inputMediaIds: [], userNotes: '' }
      const quote = await runtime.admission.quoteGenerate({ input, sessionId, userId: f.userId })
      const command = {
        clientRequestId: 'before-configuration-change',
        input,
        quoteToken: quote.quoteToken,
        sessionId,
        userId: f.userId,
      }
      const first = await runtime.admission.submitGenerate(command)
      const before = await payload.findByID({
        id: first.task.id,
        collection: 'generation-tasks' as never,
        overrideAccess: true,
        showHiddenFields: true,
      })
      const originalJSON = before.executionSnapshotJson
      const originalPrompt = JSON.parse(String(originalJSON)).executionPlan.systemPrompt
      const current = await runtime.templates.get({ adminId: f.adminId, templateId: f.templateId })
      const {
        id: _id,
        name: _name,
        code: _code,
        isDeleted: _deleted,
        kind: _kind,
        status: _status,
        ...configuration
      } = current
      const nextPrompt = 'Next current template instruction'
      await runtime.templates.save({
        adminId: f.adminId,
        configuration: {
          ...configuration,
          costCredits: 3,
          generationConfigJson: JSON.stringify({
            executorId: 'fixture-v1',
            parameters: { size: '1024x1024' },
            systemPrompt: nextPrompt,
          }),
        },
        templateId: f.templateId,
      })
      const replay = await runtime.admission.submitGenerate(command)
      expect(replay.isNew).toBe(false)
      expect(replay.task.id).toBe(first.task.id)
      await payload.jobs.run({
        limit: 5,
        overrideAccess: true,
        queue: 'creation',
        showHiddenFields: true,
      })
      expect(state.imagePlans).toEqual([originalPrompt])
      expect((await runtime.tasks.get({ taskId: first.task.id, userId: f.userId })).status).toBe(
        'succeeded',
      )

      const nextInput = { ...input, description: 'New requested image' }
      const nextQuote = await runtime.admission.quoteGenerate({
        input: nextInput,
        sessionId,
        userId: f.userId,
      })
      expect(nextQuote.costCredits).toBe(3)
      const second = await runtime.admission.submitGenerate({
        clientRequestId: 'after-configuration-change',
        input: nextInput,
        quoteToken: nextQuote.quoteToken,
        sessionId,
        userId: f.userId,
      })
      const accepted = await payload.findByID({
        id: second.task.id,
        collection: 'generation-tasks' as never,
        overrideAccess: true,
        showHiddenFields: true,
      })
      const nextJSON = accepted.executionSnapshotJson
      expect(JSON.parse(String(nextJSON)).executionPlan.systemPrompt).toBe(nextPrompt)
      expect(Object.hasOwn(JSON.parse(String(nextJSON)), 'templateVersionId')).toBe(false)
      await runtime.templates.setStatus({
        adminId: f.adminId,
        status: 'offline',
        templateId: f.templateId,
      })
      await expect(
        runtime.admission.quoteGenerate({ input: nextInput, sessionId, userId: f.userId }),
      ).rejects.toMatchObject({ code: 'TEMPLATE_UNAVAILABLE' })
      await payload.jobs.run({
        limit: 5,
        overrideAccess: true,
        queue: 'creation',
        showHiddenFields: true,
      })
      expect(state.imagePlans).toEqual([originalPrompt, nextPrompt])
      expect(state.imageCalls).toBe(2)
      for (const [taskId, json] of [
        [first.task.id, originalJSON],
        [second.task.id, nextJSON],
      ]) {
        const row = await payload.findByID({
          id: taskId as number,
          collection: 'generation-tasks' as never,
          overrideAccess: true,
          showHiddenFields: true,
        })
        expect(row.status).toBe('succeeded')
        expect(row.executionSnapshotJson).toBe(json)
      }
      const library = await runtime.library.list({ query: {}, userId: f.userId })
      expect(library.items).toHaveLength(2)
      await runtime.favorite.set({
        artifactId: library.items[0]!.id,
        isFavorite: true,
        userId: f.userId,
      })
      expect(
        (await runtime.library.get({ artifactId: library.items[0]!.id, userId: f.userId }))
          .isFavorite,
      ).toBe(true)
      expect(await runtime.credits.account({ userId: f.userId })).toMatchObject({
        available: 2,
        reserved: 0,
      })
    })
  },
)
