import type { Client, Transaction } from '@libsql/client'
import type { Payload } from 'payload'

import { createClient } from '@libsql/client'
import { setImmediate } from 'node:timers/promises'
import { createPayloadRequest } from 'payload'
import { expect, vi } from 'vitest'

import type { CreationCoordinator } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import type {
  CreationTransactionBinding,
  CreationWriteGate,
} from '../../src/creation/infrastructure/payload/write-gate.js'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createPayloadCatalog } from '../../src/creation/infrastructure/payload/catalog-repository.js'
import {
  createCreationRuntime,
  createPayloadSessionCreator,
  createPayloadSessionRepository,
} from '../../src/creation/infrastructure/payload/session-repository.js'
import {
  createSQLiteUnitOfWork,
  getCreationSQLiteAdapter,
} from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { cleanupSQLiteFixture, gate, sqliteURL } from './sqlite.config.js'
import fixtureVitestConfig from './vitest.config.js'

test.suite(
  'Heymoro isolated SQLite session adapter',
  { config: './sqlite.config.ts', cron: false },
  () => {
    test.afterAll(() => cleanupSQLiteFixture())
    test.afterEach(() => {
      vi.restoreAllMocks()
      for (const client of competingClients) {
        client.close()
      }
      competingClients.clear()
    })

    test('disables env-file discovery and selects only this isolated suite without root setup', () => {
      expect(fixtureVitestConfig.envDir).toBe(false)
      expect(fixtureVitestConfig.test?.include).toEqual([
        'apps/heymoro/tests/creation/admin.int.spec.ts',
        'apps/heymoro/tests/creation/identity.int.spec.ts',
        'apps/heymoro/tests/creation/identity-http.int.spec.ts',
        'apps/heymoro/tests/creation/catalog-session-http.int.spec.ts',
        'apps/heymoro/tests/creation/media-http.int.spec.ts',
        'apps/heymoro/tests/creation/library-credits-http.int.spec.ts',
        'apps/heymoro/tests/creation/generation-http.int.spec.ts',
        'apps/heymoro/tests/creation/runtime-root.int.spec.ts',
        'apps/heymoro/tests/creation/runtime-chain.int.spec.ts',
        'apps/heymoro/tests/creation/owner-credits.int.spec.ts',
        'apps/heymoro/tests/creation/owner-task-history.int.spec.ts',
        'apps/heymoro/tests/creation/owner-sessions.int.spec.ts',
        'apps/heymoro/tests/creation/owner-library.int.spec.ts',
        'apps/heymoro/tests/creation/artifact-favorite.int.spec.ts',
        'apps/heymoro/tests/creation/current-template.int.spec.ts',
        'apps/heymoro/tests/creation/session-share.int.spec.ts',
        'apps/heymoro/tests/creation/session-share-http.int.spec.ts',
        'apps/heymoro/tests/creation/template-taxonomy.int.spec.ts',
        'apps/heymoro/tests/creation/session-template.int.spec.ts',
        'apps/heymoro/tests/creation/session-naming.int.spec.ts',
        'apps/heymoro/tests/creation/ai-engine.int.spec.ts',
        'apps/heymoro/tests/creation/generation-worker.int.spec.ts',
        'apps/heymoro/tests/creation/generation-reconciliation.int.spec.ts',
        'apps/heymoro/tests/creation/generation-settlement.int.spec.ts',
        'apps/heymoro/tests/creation/s3.int.spec.ts',
        'apps/heymoro/tests/creation/media.int.spec.ts',
        'apps/heymoro/tests/creation/sqlite.int.spec.ts',
        'apps/heymoro/tests/creation/redis.int.spec.ts',
        'apps/heymoro/tests/creation/catalog.int.spec.ts',
        'apps/heymoro/tests/creation/draft.int.spec.ts',
        'apps/heymoro/tests/creation/credits.int.spec.ts',
        'apps/heymoro/tests/creation/generation.int.spec.ts',
      ])
      expect(fixtureVitestConfig.test?.setupFiles).toBeUndefined()
      expect(fixtureVitestConfig.test?.projects).toBeUndefined()
      expect(fixtureVitestConfig.test?.fileParallelism).toBe(false)
    })

    test('registers three private target collections with ordinary numeric references', async ({
      payload,
    }) => {
      const expected = ['creation-templates', 'creation-sessions', 'creation-drafts']
      for (const slug of expected) {
        const collection = payload.config.collections.find((collection) => collection.slug === slug)
        expect(collection).toBeDefined()
        expect(
          await collection!.access.read({ slug, req: await createPayloadRequest({ payload }) }),
        ).toBe(false)
      }
    })

    test('creates a committed session and empty audited draft on one real deferred request', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const transactionSpy = vi.spyOn(getCreationSQLiteAdapter({ payload }).client, 'transaction')
      const findSpy = vi.spyOn(payload, 'find')
      const createSpy = vi.spyOn(payload, 'create')
      const result = await creator({ payload })({
        command: fixture.command,
        userId: fixture.userId,
      })
      expect(result.isNew).toBe(true)
      expect(result.session).toMatchObject({
        createdBy: `user:${fixture.userId}`,
        deletedAt: null,
        deletedBy: null,
        isDeleted: false,
        mode: 'effect',
        nextRoundNo: 1,
        title: 'Portrait',
        updatedBy: `user:${fixture.userId}`,
      })
      const requests = [...findSpy.mock.calls, ...createSpy.mock.calls].map(([args]) => args.req)
      expect(requests.length).toBe(5)
      expect(new Set(requests).size).toBe(1)
      expect(requests[0]?.transactionID).toBeUndefined()
      expect(transactionSpy).toHaveBeenCalledExactlyOnceWith('deferred')
      expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
      expect(result.session.createdAt).toBe(result.session.updatedAt)
      const drafts = await inspect({ collection: 'creation-drafts', payload })
      expect(drafts.docs).toHaveLength(1)
      expect(drafts.docs[0]?.createdAt).toBe(result.session.createdAt)
      expect(drafts.docs[0]?.updatedAt).toBe(result.session.updatedAt)
      expect(drafts.docs[0]).toMatchObject({
        createdBy: `user:${fixture.userId}`,
        description: '',
        isDeleted: false,
        sessionId: result.session.id,
        updatedBy: `user:${fixture.userId}`,
        userId: fixture.userId,
        userNotes: '',
      })
    })

    test('replays the original session without changing a draft after publication switches', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const create = creator({ payload })
      const first = await create({ command: fixture.command, userId: fixture.userId })
      await trusted({
        payload,
        work: async ({ req }) => {
          const drafts = await api({ payload }).find({
            collection: 'creation-drafts',
            limit: 2,
            req,
          })
          await api({ payload }).update({
            id: id({ value: drafts.docs[0]?.id }),
            collection: 'creation-drafts',
            data: { updatedBy: 'system:fixture', userNotes: 'do not overwrite' },
            req,
          })
          await api({ payload }).update({
            id: fixture.command.templateId,
            collection: 'creation-templates',
            data: { costCredits: 5, status: 'offline', updatedBy: 'system:fixture' },
            req,
          })
        },
      })
      const before = await inspect({ collection: 'creation-drafts', payload })
      expect(await create({ command: fixture.command, userId: fixture.userId })).toEqual({
        isNew: false,
        session: first.session,
      })
      expect(await inspect({ collection: 'creation-drafts', payload })).toEqual(before)
      await expect(
        create({
          command: { ...fixture.command, clientRequestId: 'new-key' },
          userId: fixture.userId,
        }),
      ).rejects.toMatchObject({ code: 'TEMPLATE_UNAVAILABLE' })
    })

    test('scopes a request key to its account and rejects changed commands without replacing rows', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const create = creator({ payload })
      const original = await create({ command: fixture.command, userId: fixture.userId })
      const other = await payload.create({
        collection: 'users',
        data: { status: 'active' } as never,
        overrideAccess: true,
      })
      const separate = await create({ command: fixture.command, userId: id({ value: other.id }) })
      expect(separate.isNew).toBe(true)
      expect(separate.session.id).not.toBe(original.session.id)
      await expect(
        create({
          command: {
            ...fixture.command,
            templateId: fixture.command.templateId + 1000,
          },
          userId: fixture.userId,
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
      expect((await inspect({ collection: 'creation-drafts', payload })).docs).toHaveLength(2)
      expect((await inspect({ collection: 'creation-sessions', payload })).docs).toHaveLength(2)
    })

    test('reserves a soft-deleted key and rejects multiple rows rather than choosing one', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const create = creator({ payload })
      const first = await create({ command: fixture.command, userId: fixture.userId })
      await trusted({
        payload,
        work: async ({ req }) => {
          await api({ payload }).update({
            id: first.session.id,
            collection: 'creation-sessions',
            data: {
              deletedAt: new Date().toISOString(),
              deletedBy: 'system:fixture',
              isDeleted: true,
              updatedBy: 'system:fixture',
            },
            req,
          })
        },
      })
      await expect(
        create({ command: fixture.command, userId: fixture.userId }),
      ).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' })
      await trusted({
        payload,
        work: async ({ req }) => {
          const { id: ignored, ...duplicate } = first.session
          void ignored
          await api({ payload }).create({ collection: 'creation-sessions', data: duplicate, req })
        },
      })
      await expect(
        create({ command: fixture.command, userId: fixture.userId }),
      ).rejects.toMatchObject({ code: 'DATA_INTEGRITY_CONFLICT' })
    })

    test('checks active account state even on replay and respects soft deletion', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const create = creator({ payload })
      await create({ command: fixture.command, userId: fixture.userId })
      await payload.update({
        id: fixture.userId,
        collection: 'users',
        data: { status: 'disabled' } as never,
        overrideAccess: true,
      })
      await expect(
        create({ command: fixture.command, userId: fixture.userId }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
      await payload.update({
        id: fixture.userId,
        collection: 'users',
        data: { isDeleted: true, status: 'active' } as never,
        overrideAccess: true,
      })
      await expect(
        create({ command: fixture.command, userId: fixture.userId }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    })

    test('rolls back both writes when a real SQLite trigger rejects the draft insert', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      await getCreationSQLiteAdapter({ payload }).client.execute(
        "CREATE TRIGGER fixture_reject_draft BEFORE INSERT ON creation_drafts BEGIN SELECT RAISE(ABORT, 'fixture draft denied'); END",
      )
      try {
        await expect(
          creator({ payload })({ command: fixture.command, userId: fixture.userId }),
        ).rejects.toBeDefined()
        expect((await inspect({ collection: 'creation-sessions', payload })).docs).toHaveLength(0)
        expect((await inspect({ collection: 'creation-drafts', payload })).docs).toHaveLength(0)
        expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
      } finally {
        await getCreationSQLiteAdapter({ payload }).client.execute(
          'DROP TRIGGER fixture_reject_draft',
        )
      }
    })

    test('permanently blocks subsequent writes after Local API validation kills the transaction', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      let capturedRequest: unknown
      await expect(
        trusted({
          payload,
          work: async ({ req }) => {
            capturedRequest = req
            await expect(
              api({ payload }).create({
                collection: 'creation-drafts',
                data: { sessionId: 'invalid', userId: fixture.userId },
                req,
              }),
            ).rejects.toBeDefined()
            expect(req.transactionID).toBeUndefined()
            await expect(
              api({ payload }).create({
                collection: 'creation-drafts',
                data: { ...audit, sessionId: 999, userId: fixture.userId },
                req,
              }),
            ).rejects.toThrow(/aborted|capability/)
          },
        }),
      ).rejects.toThrow(/aborted|detached/)
      expect(capturedRequest).toBeDefined()
      expect((await inspect({ collection: 'creation-drafts', payload })).docs).toHaveLength(0)
      expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
    })

    test('denies native and overrideAccess writes, forged flags, updates, and physical deletion', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      for (const overrideAccess of [false, true]) {
        await expect(
          payload.create({
            collection: 'creation-drafts' as never,
            context: { creationWrite: true, trusted: true },
            data: { ...audit, sessionId: 999, userId: fixture.userId } as never,
            overrideAccess,
          }),
        ).rejects.toThrow(/capability/)
      }
      const created = await creator({ payload })({
        command: fixture.command,
        userId: fixture.userId,
      })
      await expect(
        payload.update({
          id: created.session.id,
          collection: 'creation-sessions' as never,
          data: { title: 'forged' } as never,
          overrideAccess: true,
        }),
      ).rejects.toThrow(/capability/)
      await expect(
        trusted({
          payload,
          work: async ({ req }) => {
            await payload.delete({
              id: created.session.id,
              collection: 'creation-sessions' as never,
              overrideAccess: true,
              req,
            })
          },
        }),
      ).rejects.toThrow(/deletion/)
    })

    test('exposes real commit failure instead of swallowing it or retrying an unknown outcome', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      let attempts = 0
      await expect(
        trusted({
          maxAttempts: 3,
          payload,
          work: async ({ req }) => {
            attempts++
            await api({ payload }).create({
              collection: 'creation-drafts',
              data: { ...audit, sessionId: 999, userId: fixture.userId },
              req,
            })
            const tx = getCreationSQLiteAdapter({ payload }).sessions[String(req.transactionID)]!.db
            await tx.run('ROLLBACK')
          },
        }),
      ).rejects.toThrow(/commit|transaction/i)
      expect(attempts).toBe(1)
      expect((await inspect({ collection: 'creation-drafts', payload })).docs).toHaveLength(0)
      expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
    })

    test('rejects detached registration, manual resolve, lease loss, and parallel repository calls', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      await expect(
        trusted({
          payload,
          work: async ({ req }) => {
            delete getCreationSQLiteAdapter({ payload }).sessions[String(req.transactionID)]
          },
        }),
      ).rejects.toThrow(/aborted|detached/)
      await expect(
        trusted({
          payload,
          work: async ({ req }) => {
            await getCreationSQLiteAdapter({ payload }).sessions[
              String(req.transactionID)
            ]!.resolve()
          },
        }),
      ).rejects.toThrow(/manual|commit/i)
      let isLeaseValid = true
      const coordinate: CreationCoordinator = async ({ work }) =>
        work({
          assertLease: () => {
            if (!isLeaseValid) {
              throw new Error('fixture lease lost')
            }
          },
        })
      await expect(
        trusted({
          coordinate,
          payload,
          work: async ({ req }) => {
            await api({ payload }).create({
              collection: 'creation-drafts',
              data: { ...audit, sessionId: 999, userId: fixture.userId },
              req,
            })
            isLeaseValid = false
          },
        }),
      ).rejects.toThrow(/lease lost/)
      await expect(
        trusted({
          payload,
          work: async ({ req }) => {
            const repository = createPayloadSessionRepository({ gate, payload, req })
            await Promise.all([
              repository.isAccountActive({ userId: fixture.userId }),
              repository.readTemplate({ templateId: fixture.command.templateId }),
            ])
          },
        }),
      ).rejects.toThrow(/parallel|concurrent|aborted/i)
      expect((await inspect({ collection: 'creation-drafts', payload })).docs).toHaveLength(0)
      expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
    })

    test('drains an already-started delayed write before rolling back a concurrent repository rejection', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const collection = payload.config.collections.find(
        ({ slug }) => String(slug) === 'creation-drafts',
      )!
      const hooks = collection.hooks.beforeChange!
      let enter = () => {}
      let release = () => {}
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const hookIndex = hooks.length
      hooks.push(async ({ data }) => {
        enter()
        await released
        return data
      })
      let first: Promise<unknown> | undefined
      try {
        const transaction = trusted({
          payload,
          work: async ({ req }) => {
            const repository = createPayloadSessionRepository({ gate, payload, req })
            const timestamp = new Date().toISOString()
            first = repository.insertEmptyDraft({
              draft: {
                ...audit,
                createdAt: timestamp,
                description: '',
                sessionId: 999,
                updatedAt: timestamp,
                userId: fixture.userId,
                userNotes: '',
              },
            })
            await entered
            return Promise.all([first, repository.isAccountActive({ userId: fixture.userId })])
          },
        })
        // Attach immediately: the unfixed unit of work rejects before the delayed operation settles.
        // eslint-disable-next-line @vitest/valid-expect -- Attach now, await after releasing the delayed fixture below.
        const rejected = expect(transaction).rejects.toThrow(/concurrent|aborted/i)
        await entered
        await setImmediate()
        release()
        await rejected
        await Promise.allSettled([first])
        await setImmediate()
        expect((await inspect({ collection: 'creation-drafts', payload })).docs).toHaveLength(0)
        expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
      } finally {
        release()
        hooks.splice(hookIndex, 1)
      }
    })

    test('seals new writes before the real commit call resumes', async ({ payload }) => {
      await verifySealedCommitWindow({ payload, window: 'before' })
    })

    test('seals new writes while a real committed transaction awaits its acknowledgement', async ({
      payload,
    }) => {
      await verifySealedCommitWindow({ payload, window: 'ack' })
    })

    test('keeps commit capability valid while closing new writes at the actual commit boundary', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      let binding: CreationTransactionBinding | undefined
      const scopedGate: CreationWriteGate = {
        ...gate,
        bind: (args) => {
          binding = gate.bind(args)
          return binding
        },
      }
      const run = createSQLiteUnitOfWork({
        coordinate: fakeCoordinator,
        gate: scopedGate,
        payload,
        retry: { backoffMs: 0, maxAttempts: 1 },
      })
      let currentRequest: import('payload').PayloadRequest | undefined
      const original = getCreationSQLiteAdapter({ payload }).client.transaction.bind(
        getCreationSQLiteAdapter({ payload }).client,
      )
      vi.spyOn(getCreationSQLiteAdapter({ payload }).client, 'transaction').mockImplementation(
        async (...args: unknown[]) => {
          const [mode] = args
          if (mode !== undefined && mode !== 'read' && mode !== 'write' && mode !== 'deferred') {
            throw new Error('Invalid fixture transaction mode')
          }
          const transaction = await (mode === undefined ? original() : original(mode))
          return new Proxy(transaction, {
            get: (target, property) => {
              if (property === 'commit') {
                return async () => {
                  expect(currentRequest).toBeDefined()
                  expect(() => gate.assert({ req: currentRequest! })).toThrow(/sealed/i)
                  expect(binding).toBeDefined()
                  binding!.assertCommit()
                  await target.commit()
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        },
      )
      await expect(
        run({
          resource: 'fixture-commit-boundary',
          work: async ({ req }) => {
            currentRequest = req
            await api({ payload }).create({
              collection: 'creation-drafts',
              data: { ...audit, sessionId: 999, userId: fixture.userId },
              req,
            })
          },
        }),
      ).resolves.toBeUndefined()
      expect(currentRequest?.transactionID).toBeUndefined()
    })

    test('reopens a whole real busy transaction with a fresh request and account read after confirmed rollback', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const requests: import('payload').PayloadRequest[] = []
      const activeStates: boolean[] = []
      const competing = competingClient()
      await expect(
        trusted({
          maxAttempts: 3,
          payload,
          work: async ({ req }) => {
            requests.push(req)
            expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toHaveLength(1)
            const repository = createPayloadSessionRepository({ gate, payload, req })
            const isActive = await repository.isAccountActive({ userId: fixture.userId })
            activeStates.push(isActive)
            if (!isActive) {
              throw new Error('fixture account changed on fresh read')
            }
            await competing.execute({
              args: [fixture.userId],
              sql: "UPDATE users SET status = 'disabled' WHERE id = ?",
            })
            await api({ payload }).create({
              collection: 'creation-drafts',
              data: { ...audit, sessionId: 999, userId: fixture.userId },
              req,
            })
          },
        }),
      ).rejects.toThrow('fixture account changed on fresh read')
      expect(activeStates).toEqual([true, false])
      expect(new Set(requests).size).toBe(2)
      expect(requests.every((req) => req.transactionID === undefined)).toBe(true)
      expect((await inspect({ collection: 'creation-drafts', payload })).docs).toHaveLength(0)
      expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
    })

    test('bounds retries of real SQLite busy snapshots and leaves no inserted rows', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const competing = competingClient()
      let attempts = 0
      await expect(
        trusted({
          maxAttempts: 2,
          payload,
          work: async ({ req }) => {
            attempts++
            await api({ payload }).find({ collection: 'users', limit: 2, req })
            await competing.execute({
              args: [attempts % 2 ? 'disabled' : 'active', fixture.userId],
              sql: 'UPDATE users SET status = ? WHERE id = ?',
            })
            await api({ payload }).create({
              collection: 'creation-drafts',
              data: { ...audit, sessionId: 999, userId: fixture.userId },
              req,
            })
          },
        }),
      ).rejects.toBeDefined()
      expect(attempts).toBe(2)
      expect((await inspect({ collection: 'creation-drafts', payload })).docs).toHaveLength(0)
    })

    test('does not retry busy work when rollback acknowledgement is an injected failure', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const competing = competingClient()
      const original = getCreationSQLiteAdapter({ payload }).client.transaction.bind(
        getCreationSQLiteAdapter({ payload }).client,
      )
      vi.spyOn(getCreationSQLiteAdapter({ payload }).client, 'transaction').mockImplementation(
        async (...args: unknown[]) => {
          const [mode] = args
          if (mode !== undefined && mode !== 'read' && mode !== 'write' && mode !== 'deferred') {
            throw new Error('Invalid fixture transaction mode')
          }
          const transaction = await (mode === undefined ? original() : original(mode))
          return new Proxy(transaction, {
            get: (target, property) => {
              if (property === 'rollback') {
                return async () => {
                  await target.rollback()
                  throw new Error('fixture rollback acknowledgement lost')
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        },
      )
      let attempts = 0
      let failure: unknown
      try {
        await trusted({
          maxAttempts: 3,
          payload,
          work: async ({ req }) => {
            attempts++
            await api({ payload }).find({ collection: 'users', limit: 2, req })
            await competing.execute({
              args: [fixture.userId],
              sql: "UPDATE users SET status = 'disabled' WHERE id = ?",
            })
            await api({ payload }).create({
              collection: 'creation-drafts',
              data: { ...audit, sessionId: 999, userId: fixture.userId },
              req,
            })
          },
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({
        name: 'CreationTransactionError',
        commitStarted: false,
        rollbackConfirmed: false,
      })
      expect(failure).toHaveProperty('cause.errors')
      expect(attempts).toBe(1)
      expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
    })

    test('closes only its owned transaction when rollback fails before any real rollback', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const client = getCreationSQLiteAdapter({ payload }).client
      const original = client.transaction.bind(client)
      let owned: Transaction | undefined
      let closeCalls = 0
      vi.spyOn(client, 'transaction').mockImplementation(async (...args: unknown[]) => {
        const [mode] = args
        if (mode !== undefined && mode !== 'read' && mode !== 'write' && mode !== 'deferred') {
          throw new Error('Invalid fixture transaction mode')
        }
        owned = await (mode === undefined ? original() : original(mode))
        return new Proxy(owned, {
          get: (target, property) => {
            if (property === 'rollback') {
              return async () => {
                throw new Error('fixture rollback failed before driver rollback')
              }
            }
            if (property === 'close') {
              return () => {
                closeCalls++
                target.close()
              }
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      })
      let attempts = 0
      try {
        await expect(
          trusted({
            maxAttempts: 3,
            payload,
            work: async ({ req }) => {
              attempts++
              await api({ payload }).create({
                collection: 'creation-drafts',
                data: { ...audit, sessionId: 999, userId: fixture.userId },
                req,
              })
              throw Object.assign(new Error('fixture busy after insert'), { code: 'SQLITE_BUSY' })
            },
          }),
        ).rejects.toMatchObject({
          name: 'CreationTransactionError',
          commitStarted: false,
          rollbackConfirmed: false,
        })
        expect(attempts).toBe(1)
        expect(closeCalls).toBe(1)
        expect(owned?.closed).toBe(true)
        vi.restoreAllMocks()
        expect((await inspect({ collection: 'creation-drafts', payload })).docs).toHaveLength(0)
        await expect(
          trusted({
            payload,
            work: ({ req }) =>
              api({ payload }).create({
                collection: 'creation-drafts',
                data: { ...audit, sessionId: 1000, userId: fixture.userId },
                req,
              }),
          }),
        ).resolves.toBeDefined()
      } finally {
        owned?.close()
      }
    })

    test('does not retry when a real committed transaction loses its acknowledgement through an injected busy error', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const original = getCreationSQLiteAdapter({ payload }).client.transaction.bind(
        getCreationSQLiteAdapter({ payload }).client,
      )
      vi.spyOn(getCreationSQLiteAdapter({ payload }).client, 'transaction').mockImplementation(
        async (...args: unknown[]) => {
          const [mode] = args
          if (mode !== undefined && mode !== 'read' && mode !== 'write' && mode !== 'deferred') {
            throw new Error('Invalid fixture transaction mode')
          }
          const transaction = await (mode === undefined ? original() : original(mode))
          return new Proxy(transaction, {
            get: (target, property) => {
              if (property === 'commit') {
                return async () => {
                  await target.commit()
                  throw Object.assign(new Error('fixture commit acknowledgement lost'), {
                    code: 'SQLITE_BUSY',
                  })
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        },
      )
      let attempts = 0
      await expect(
        trusted({
          maxAttempts: 3,
          payload,
          work: async ({ req }) => {
            attempts++
            await api({ payload }).create({
              collection: 'creation-drafts',
              data: { ...audit, sessionId: 999, userId: fixture.userId },
              req,
            })
          },
        }),
      ).rejects.toMatchObject({ name: 'CreationTransactionError', commitStarted: true })
      expect(attempts).toBe(1)
      vi.restoreAllMocks()
      expect((await inspect({ collection: 'creation-drafts', payload })).docs).toHaveLength(1)
      expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
    })

    test('rejects changes to immutable creation audit fields and incomplete soft-deletion states', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      for (const data of [
        { createdAt: '2000-01-01T00:00:00.000Z' },
        { createdBy: 'system:replacement' },
        { isDeleted: true },
        { deletedAt: new Date().toISOString(), deletedBy: 'system:fixture', isDeleted: false },
      ]) {
        await expect(
          trusted({
            payload,
            work: ({ req }) =>
              api({ payload }).update({
                id: fixture.command.templateId,
                collection: 'creation-templates',
                data,
                req,
              }),
          }),
        ).rejects.toThrow(/audit|immutable|delet/i)
      }
    })

    test('rejects invalid identifier, schema, round, and credit integer ranges', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      for (const userId of [0, -1, 1.5]) {
        await expect(
          trusted({
            payload,
            work: ({ req }) =>
              api({ payload }).create({
                collection: 'creation-drafts',
                data: { ...audit, sessionId: 999, userId },
                req,
              }),
          }),
        ).rejects.toBeDefined()
      }
      for (const data of [
        { schemaVersion: 0 },
        { schemaVersion: -1 },
        { costCredits: -1 },
        { sortOrder: 0.5 },
        { primaryCategoryId: 0 },
      ]) {
        await expect(
          trusted({
            payload,
            work: ({ req }) =>
              api({ payload }).update({
                id: fixture.command.templateId,
                collection: 'creation-templates',
                data,
                req,
              }),
          }),
        ).rejects.toBeDefined()
      }
      const session = await creator({ payload })({
        command: fixture.command,
        userId: fixture.userId,
      })
      await expect(
        trusted({
          payload,
          work: ({ req }) =>
            api({ payload }).update({
              id: session.session.id,
              collection: 'creation-sessions',
              data: { nextRoundNo: 0 },
              req,
            }),
        }),
      ).rejects.toBeDefined()
      await expect(
        trusted({
          payload,
          work: ({ req }) =>
            api({ payload }).update({
              id: fixture.command.templateId,
              collection: 'creation-templates',
              data: { sortOrder: -1 },
              req,
            }),
        }),
      ).resolves.toMatchObject({ sortOrder: -1 })
    })

    test('snapshots a validated bounded retry policy rather than accepting later mutation', async ({
      payload,
    }) => {
      const retry = { backoffMs: 0, maxAttempts: 1 }
      const run = createSQLiteUnitOfWork({ coordinate: fakeCoordinator, gate, payload, retry })
      retry.maxAttempts = 3
      let attempts = 0
      await expect(
        run({
          resource: 'fixture-policy',
          work: async () => {
            attempts++
            throw Object.assign(new Error('fixture busy policy probe'), { code: 'SQLITE_BUSY' })
          },
        }),
      ).rejects.toThrow('fixture busy policy probe')
      expect(attempts).toBe(1)
      for (const policy of [
        { backoffMs: 0, maxAttempts: 0 },
        { backoffMs: 0, maxAttempts: 11 },
        { backoffMs: 1001, maxAttempts: 1 },
      ]) {
        expect(() =>
          createSQLiteUnitOfWork({ coordinate: fakeCoordinator, gate, payload, retry: policy }),
        ).toThrow(RangeError)
      }
    })

    test('maps target tables to INTEGER AUTOINCREMENT, ordinary indexes and no business foreign keys', async ({
      payload,
    }) => {
      const expectedIndexes: Record<string, string[][]> = {
        creation_drafts: [['session_id'], ['user_id', 'is_deleted', 'updated_at']],
        creation_sessions: [
          ['user_id', 'client_request_id'],
          ['user_id', 'is_deleted', 'last_activity_at'],
        ],
        creation_templates: [
          ['code'],
          ['kind', 'status', 'is_deleted'],
          ['is_deleted', 'status', 'sort_order'],
          ['primary_category_id', 'is_deleted', 'status'],
        ],
      }
      for (const [table, expected] of Object.entries(expectedIndexes)) {
        const ddl = await getCreationSQLiteAdapter({ payload }).client.execute({
          args: [table],
          sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        })
        expect(String(ddl.rows[0]?.sql)).toMatch(/integer PRIMARY KEY AUTOINCREMENT/i)
        expect(
          (
            await getCreationSQLiteAdapter({ payload }).client.execute(
              `PRAGMA foreign_key_list('${table}')`,
            )
          ).rows,
        ).toHaveLength(0)
        const indexes = await getCreationSQLiteAdapter({ payload }).client.execute(
          `PRAGMA index_list('${table}')`,
        )
        expect(indexes.rows).toHaveLength(expected.length)
        const indexedColumns: string[][] = []
        for (const index of indexes.rows) {
          expect(Number(index.unique)).toBe(0)
          const columns = await getCreationSQLiteAdapter({ payload }).client.execute(
            `PRAGMA index_xinfo('${String(index.name)}')`,
          )
          expect(columns.rows.at(-1)).toMatchObject({ cid: -1, key: 0 })
          indexedColumns.push(
            columns.rows.filter((row) => Number(row.key) === 1).map((row) => String(row.name)),
          )
        }
        expect(indexedColumns.map((columns) => JSON.stringify(columns)).sort()).toEqual(
          expected.map((columns) => JSON.stringify(columns)).sort(),
        )
      }
      const fixture = await seed({ payload })
      const find = vi.spyOn(payload, 'find')
      const publicTemplate = await createPayloadCatalog({
        capabilityPolicy: { id: 'fixture-v1', isCompatible: () => true },
        cursorKey: Buffer.alloc(32, 7),
        hostCaps,
        payload,
      }).get({ templateId: fixture.command.templateId })
      expect(JSON.stringify(publicTemplate)).not.toMatch(/generationConfig|internal|do not expose/)
      expect(find).toHaveBeenCalledTimes(1)
      expect(find.mock.calls[0][0].select).not.toHaveProperty('generationConfigJson')
      const alias = await getCreationSQLiteAdapter({ payload }).client.execute({
        args: [fixture.command.templateId],
        sql: 'SELECT id, rowid AS fixture_rowid FROM creation_templates WHERE id = ? ORDER BY sort_order, id',
      })
      expect(alias.rows[0]?.fixture_rowid).toBe(fixture.command.templateId)
    })
  },
)

const competingClients = new Set<Client>()
function competingClient() {
  const client = createClient({ url: sqliteURL })
  competingClients.add(client)
  return client
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
// This explicit in-process test port proves SQLite only; Redis is not exercised.
const fakeCoordinator: CreationCoordinator = async ({ work }) => work({ assertLease: () => {} })

async function inspect({
  collection,
  payload,
}: {
  collection: 'creation-drafts' | 'creation-sessions' | 'creation-templates'
  payload: Payload
}) {
  return trusted({
    payload,
    work: ({ req }) => api({ payload }).find({ collection, limit: 2, req }),
  })
}
function api({ payload }: { payload: Payload }) {
  return createCreationRuntime({ gate, payload })
}
function creator({ payload }: { payload: Payload }) {
  return createPayloadSessionCreator({
    clock: () => new Date().toISOString(),
    coordinate: fakeCoordinator,
    gate,
    hostCaps,
    isCompatible: ({ schemaVersion }) => schemaVersion === 1,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  })
}
function trusted<T>({
  coordinate = fakeCoordinator,
  maxAttempts = 1,
  payload,
  work,
}: {
  coordinate?: CreationCoordinator
  maxAttempts?: number
  payload: Payload
  work: (args: { req: import('payload').PayloadRequest }) => Promise<T>
}) {
  return createSQLiteUnitOfWork({
    coordinate,
    gate,
    payload,
    retry: { backoffMs: 0, maxAttempts },
  })({ resource: 'fixture-only', work })
}
function id({ value }: { value: unknown }): number {
  if (typeof value !== 'number') {
    throw new Error('Expected numeric fixture ID')
  }
  return value
}
async function seed({ payload }: { payload: Payload }) {
  const user = await payload.create({
    collection: 'users',
    data: { status: 'active' } as never,
    overrideAccess: true,
  })
  return trusted({
    payload,
    work: async ({ req }) => {
      const template = await api({ payload }).create({
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
          generationConfigJson: '{"internal":"do not expose"}',
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
      const templateId = id({ value: template.id })
      return {
        command: { clientRequestId: 'key-1', templateId },
        userId: id({ value: user.id }),
      }
    },
  })
}

async function verifySealedCommitWindow({
  payload,
  window,
}: {
  payload: Payload
  window: 'ack' | 'before'
}) {
  const fixture = await seed({ payload })
  const client = getCreationSQLiteAdapter({ payload }).client
  const original = client.transaction.bind(client)
  let binding: CreationTransactionBinding | undefined
  const scopedGate: CreationWriteGate = {
    ...gate,
    bind: (args) => {
      binding = gate.bind(args)
      return binding
    },
  }
  const run = createSQLiteUnitOfWork({
    coordinate: fakeCoordinator,
    gate: scopedGate,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  })
  let req: import('payload').PayloadRequest | undefined
  let enter = () => {}
  let release = () => {}
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(client, 'transaction').mockImplementation(async (...args: unknown[]) => {
    const [mode] = args
    if (mode !== undefined && mode !== 'read' && mode !== 'write' && mode !== 'deferred') {
      throw new Error('Invalid fixture transaction mode')
    }
    const transaction = await (mode === undefined ? original() : original(mode))
    return new Proxy(transaction, {
      get: (target, property) => {
        if (property === 'commit') {
          return async () => {
            if (window === 'ack') {
              await target.commit()
            }
            enter()
            await released
            if (window === 'before') {
              await target.commit()
            }
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  })
  const completed = run({
    resource: 'fixture-sealed-window',
    work: async ({ req: transactionRequest }) => {
      req = transactionRequest
      await api({ payload }).create({
        collection: 'creation-drafts',
        data: { ...audit, sessionId: 999, userId: fixture.userId },
        req,
      })
      return 'known successful result'
    },
  })
  try {
    await entered
    const writes = vi.spyOn(payload, 'create')
    let lateFailure: unknown
    let hookFailure: unknown
    try {
      gate.assert({ req: req! })
    } catch (error) {
      hookFailure = error
    }
    try {
      await api({ payload }).create({
        collection: 'creation-drafts',
        data: { ...audit, sessionId: 1000, userId: fixture.userId },
        req: req!,
      })
    } catch (error) {
      lateFailure = error
    }
    let lateRepositoryFailure: unknown
    let commitGuardFailure: unknown
    try {
      const timestamp = new Date().toISOString()
      await createPayloadSessionRepository({ gate, payload, req: req! }).insertEmptyDraft({
        draft: {
          ...audit,
          createdAt: timestamp,
          description: '',
          sessionId: 1001,
          updatedAt: timestamp,
          userId: fixture.userId,
          userNotes: '',
        },
      })
    } catch (error) {
      lateRepositoryFailure = error
    }
    try {
      binding!.assertCommit()
    } catch (error) {
      commitGuardFailure = error
    }
    const lateLocalAPICalls = writes.mock.calls.length
    release()
    const result = await completed
    vi.restoreAllMocks()
    await setImmediate()
    const drafts = await inspect({ collection: 'creation-drafts', payload })
    expect(drafts.docs).toHaveLength(1)
    expect(drafts.docs[0]?.sessionId).toBe(999)
    expect(lateFailure).toMatchObject({ message: expect.stringMatching(/sealed/i) })
    expect(hookFailure).toMatchObject({ message: expect.stringMatching(/sealed/i) })
    expect(lateRepositoryFailure).toMatchObject({ message: expect.stringMatching(/sealed/i) })
    expect(commitGuardFailure).toBeUndefined()
    expect(lateLocalAPICalls).toBe(0)
    expect(result).toBe('known successful result')
    expect(Object.keys(getCreationSQLiteAdapter({ payload }).sessions)).toEqual([])
  } finally {
    release()
    await completed.catch(() => undefined)
  }
}
