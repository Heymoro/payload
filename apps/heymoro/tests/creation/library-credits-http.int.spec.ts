import type { Payload, PayloadRequest } from 'payload'

import { REST_DELETE, REST_GET, REST_PUT } from '@payloadcms/next/routes'
import { expect, vi } from 'vitest'

import type {
  CreditLedgerDTO,
  CreditReservationDTO,
  OwnerCreditAccountDTO,
  OwnerCreditPage,
} from '../../src/creation/application/owner-credits-types.js'
import type { ArtifactDTO } from '../../src/creation/application/owner-library-types.js'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { wrapProductREST } from '../../src/creation/http/rest-route.js'
import { createPayloadCreditsService } from '../../src/creation/infrastructure/payload/credits-repository.js'
import { createCreationRuntime } from '../../src/creation/infrastructure/payload/session-repository.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createRedisCreationCoordinator } from '../../src/creation/infrastructure/redis/coordinator.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'
import { cleanupRuntime, config, gate, http, redis, state } from './runtime.config.js'
import { audit, controlledWrite, now, seedChain, seedIdentity } from './runtime-seed.js'

type Envelope<T> = {
  data: T
  error: { code: string; message: string; retryable: boolean }
  requestId: string
}
type LibraryPage = { hasMore: boolean; items: ArtifactDTO[]; nextCursor: null | string }
type Owner = { templateId: number; token: string; userId: number }
type Favorite = { isFavorite: boolean; savedAt: null | string }

// Preparation uses internal admission/worker. These are Native routes, not a running Next server.
test.suite(
  'Heymoro Native library and credits HTTP',
  { config: './runtime.config.ts', cron: false },
  () => {
    test.afterAll(cleanupRuntime)
    test.beforeEach(reset)
    test.afterEach(() => {
      vi.restoreAllMocks()
      reset()
    })

    test('should expose actual runtime generation through HTTP library/media and unchanged credit event deltas', async ({
      payload,
    }) => {
      const owner = await setup({ payload })
      const task = await generate({ owner, payload, sequence: 0 })
      const page = await data<LibraryPage>({ owner, path: '/v1/artifacts', payload })
      expect(page.items).toHaveLength(1)
      const artifact = page.items[0]!
      expect(artifact).toMatchObject({
        isFavorite: false,
        mimeType: 'image/png',
        savedAt: null,
        taskId: task.id,
      })
      expect(Object.keys(artifact).sort()).toEqual([
        'createdAt',
        'height',
        'id',
        'isFavorite',
        'mediaId',
        'mimeType',
        'outputIndex',
        'savedAt',
        'sessionId',
        'taskId',
        'width',
      ])
      expect(await data({ owner, path: `/v1/artifacts/${artifact.id}`, payload })).toEqual(artifact)
      const image = await native({ owner, path: `/v1/media/${artifact.mediaId}/content`, payload })
      expect(image.status).toBe(200)
      const key = (
        await getCreationSQLiteAdapter({ payload }).client.execute({
          args: [artifact.mediaId],
          sql: 'SELECT storage_name FROM media WHERE id = ?',
        })
      ).rows[0]!.storage_name as string
      expect(Buffer.from(await image.arrayBuffer())).toEqual(http.objects.get(key)!.bytes)
      const account = await data<OwnerCreditAccountDTO>({
        owner,
        path: '/v1/creation-account',
        payload,
      })
      expect(account).toMatchObject({ available: 5, configured: true, reserved: 0 })
      const ledger = await data<OwnerCreditPage<CreditLedgerDTO>>({
        owner,
        path: '/v1/credits/ledger',
        payload,
      })
      expect(ledger.items.map(({ ledgerDelta, operation }) => [operation, ledgerDelta])).toEqual([
        ['capture', -2],
        ['reserve', 0],
        ['grant', 7],
      ])
      for (const entry of ledger.items) {
        expect(entry.ledgerDelta).toBe(entry.availableDelta + entry.reservedDelta)
      }
      expect(
        (
          await data<OwnerCreditPage<CreditReservationDTO>>({
            owner,
            path: '/v1/credits/reservations',
            payload,
          })
        ).items,
      ).toEqual([])
      expect(JSON.stringify({ account, artifact, ledger })).not.toMatch(
        /backend|bucket|storageName|eventKey|grantKey|requestHash|executionSnapshot|tokenHash|createdBy/,
      )
    })

    test('should set/cancel idempotently restore one relation and cancel tombstones with no no-op timestamp changes', async ({
      payload,
    }) => {
      const owner = await setup({ payload })
      await generate({ owner, payload, sequence: 0 })
      const artifact = (await data<LibraryPage>({ owner, path: '/v1/artifacts', payload }))
        .items[0]!
      const path = `/v1/artifacts/${artifact.id}/favorite`
      const first = await data<Favorite>({ method: 'put', owner, path, payload })
      expect(first).toEqual({ isFavorite: true, savedAt: now })
      const client = getCreationSQLiteAdapter({ payload }).client
      const saved = (await client.execute('SELECT * FROM saved_artifacts')).rows[0]!
      state.now = '2026-11-12T12:00:01.000Z'
      expect(await data({ method: 'put', owner, path, payload })).toEqual(first)
      expect((await client.execute('SELECT * FROM saved_artifacts')).rows).toEqual([saved])
      expect(
        (await data<LibraryPage>({ owner, path: '/v1/artifacts?saved=true', payload })).items[0],
      ).toMatchObject({ id: artifact.id, isFavorite: true, savedAt: now })
      expect(await data({ method: 'delete', owner, path, payload })).toEqual({
        isFavorite: false,
        savedAt: null,
      })
      const deleted = (await client.execute('SELECT * FROM saved_artifacts')).rows[0]!
      state.now = '2026-11-12T12:00:02.000Z'
      expect(await data({ method: 'delete', owner, path, payload })).toEqual({
        isFavorite: false,
        savedAt: null,
      })
      expect((await client.execute('SELECT * FROM saved_artifacts')).rows).toEqual([deleted])
      expect(await data({ method: 'put', owner, path, payload })).toEqual({
        isFavorite: true,
        savedAt: state.now,
      })
      expect((await client.execute('SELECT * FROM saved_artifacts')).rows).toHaveLength(1)
      expect((await client.execute('SELECT * FROM saved_artifacts')).rows[0]!.id).toBe(saved.id)
      await client.execute({
        args: [artifact.id],
        sql: 'UPDATE artifacts SET is_deleted = 1, deleted_at = created_at, deleted_by = created_by WHERE id = ?',
      })
      await failure({ code: 'NOT_FOUND', method: 'put', owner, path, payload, status: 404 })
      expect(await data({ method: 'delete', owner, path, payload })).toEqual({
        isFavorite: false,
        savedAt: null,
      })
      await failure({
        code: 'NOT_FOUND',
        owner,
        path: `/v1/artifacts/${artifact.id}`,
        payload,
        status: 404,
      })
      const other = await seedIdentity({ gate, payload })
      await failure({
        code: 'NOT_FOUND',
        method: 'delete',
        owner: other,
        path,
        payload,
        status: 404,
      })
      await failure({
        code: 'NOT_FOUND',
        method: 'delete',
        owner,
        path: '/v1/artifacts/9007199254740991/favorite',
        payload,
        status: 404,
      })
    })

    test('should reject raw query/body/path forms and inactive credentials before business writes', async ({
      payload,
    }) => {
      const owner = await setup({ payload })
      await generate({ owner, payload, sequence: 0 })
      const artifact = (await data<LibraryPage>({ owner, path: '/v1/artifacts', payload }))
        .items[0]!
      const before = network()
      const writes = [
        vi.spyOn(payload, 'create'),
        vi.spyOn(payload, 'update'),
        vi.spyOn(payload, 'delete'),
      ]
      for (const path of [
        '/v1/artifacts?saved=1',
        '/v1/artifacts?saved=True',
        '/v1/artifacts?saved=+true',
        '/v1/artifacts?saved=false+',
        '/v1/artifacts?saved=true&%73aved=false',
        '/v1/artifacts?saved[]=true',
        '/v1/artifacts?owner=1',
        '/v1/artifacts?cursor=%FF',
        '/v1/artifacts?cursor=',
        '/v1/artifacts?page=1',
        '/v1/artifacts?limit=1',
        '/v1/artifacts/01',
        `/v1/artifacts/${artifact.id}?`,
        '/v1/creation-account?',
        '/v1/creation-account?cursor=x',
        '/v1/credits/reservations?limit=1',
        '/v1/credits/ledger?page=1',
        '/v1/credits/ledger?cursor=x&%63ursor=y',
      ]) {
        await failure({ code: 'INPUT_INVALID', owner, path, payload, status: 400 })
      }
      for (const method of ['put', 'delete'] as const) {
        const path = `/v1/artifacts/${artifact.id}/favorite`
        await failure({
          code: 'INPUT_INVALID',
          method,
          owner,
          path: path + '?saved=true',
          payload,
          status: 400,
        })
        await failure({
          body: '{"saved":true,"owner":999}',
          code: 'INPUT_INVALID',
          method,
          owner,
          path,
          payload,
          status: 400,
        })
      }
      for (const path of [
        '/v1/artifacts',
        '/v1/creation-account',
        '/v1/credits/reservations',
        '/v1/credits/ledger',
      ]) {
        const endpoint = payload.config.endpoints.find(
          (entry) => entry.method === 'get' && entry.path === path,
        )!
        const req = Object.assign(
          new Request('http://fixture' + path, {
            body: 'x',
            headers: { authorization: `Bearer ${owner.token}` },
            method: 'POST',
          }),
          { payload, user: { id: 999 } },
        ) as unknown as PayloadRequest
        expect((await endpoint.handler(req)).status).toBe(400)
      }
      for (const write of writes) {
        expect(write).not.toHaveBeenCalled()
      }
      expect(network()).toEqual(before)
      await failure({ code: 'UNAUTHENTICATED', path: '/v1/artifacts', payload, status: 401 })
      state.now = '2026-11-12T13:00:00.000Z'
      await failure({
        code: 'UNAUTHENTICATED',
        owner,
        path: '/v1/creation-account',
        payload,
        status: 401,
      })
      state.now = now
      await getCreationSQLiteAdapter({ payload }).client.execute({
        args: [owner.userId],
        sql: "UPDATE users SET status = 'disabled' WHERE id = ?",
      })
      await failure({
        code: 'UNAUTHENTICATED',
        owner,
        path: '/v1/credits/ledger',
        payload,
        status: 401,
      })
    })

    test('should keep zero-wallet and reached expiry GETs read-only without leases or network', async ({
      payload,
    }) => {
      const owner = await seedIdentity({ gate, payload })
      const client = getCreationSQLiteAdapter({ payload }).client
      const before = network()
      const writes = [
        vi.spyOn(payload, 'create'),
        vi.spyOn(payload, 'update'),
        vi.spyOn(payload, 'delete'),
      ]
      const lease = vi.spyOn(redis.client, 'set')
      expect(await data({ owner, path: '/v1/creation-account', payload })).toEqual({
        available: 0,
        configured: true,
        reserved: 0,
        sources: [],
      })
      for (const path of ['/v1/credits/ledger', '/v1/credits/reservations']) {
        expect(await data({ owner, path, payload })).toEqual({
          hasMore: false,
          items: [],
          nextCursor: null,
        })
      }
      expect((await client.execute('SELECT * FROM credit_accounts')).rows).toEqual([])
      for (const write of writes) {
        expect(write).not.toHaveBeenCalled()
      }
      expect(lease).not.toHaveBeenCalled()
      expect(network()).toEqual(before)
      vi.restoreAllMocks()
      await issue({
        amount: 3,
        expiresAt: '2026-11-12T12:00:01.000Z',
        key: 'short-no-reserve',
        owner,
        payload,
      })
      state.now = '2026-11-12T12:00:02.000Z'
      const beforeGrant = (await client.execute('SELECT * FROM credit_grants')).rows
      const beforeLedger = (await client.execute('SELECT * FROM credit_ledger')).rows
      const creates = vi.spyOn(payload, 'create')
      const updates = vi.spyOn(payload, 'update')
      expect(
        (await data<OwnerCreditAccountDTO>({ owner, path: '/v1/creation-account', payload }))
          .available,
      ).toBe(0)
      expect(
        (
          await data<OwnerCreditPage<CreditLedgerDTO>>({
            owner,
            path: '/v1/credits/ledger',
            payload,
          })
        ).items[0],
      ).toMatchObject({ ledgerDelta: 3, operation: 'compensate' })
      expect((await client.execute('SELECT * FROM credit_grants')).rows).toEqual(beforeGrant)
      expect((await client.execute('SELECT * FROM credit_ledger')).rows).toEqual(beforeLedger)
      expect(creates).not.toHaveBeenCalled()
      expect(updates).not.toHaveBeenCalled()
    })

    test('should preserve expired occupied allocations on GET then release only expired economic credit on known not_sent', async ({
      payload,
    }) => {
      const owner = await setup({ payload })
      await issue({
        amount: 1,
        expiresAt: '2026-11-12T12:00:01.000Z',
        key: 'short-occupied',
        owner,
        payload,
      })
      const task = await generate({ owner, payload, sequence: 0, shouldRun: false })
      const client = getCreationSQLiteAdapter({ payload }).client
      const reservations = (await client.execute('SELECT * FROM credit_reservations')).rows
      const allocations = (await client.execute('SELECT * FROM credit_allocations ORDER BY id'))
        .rows
      expect(reservations).toHaveLength(1)
      expect(allocations).toHaveLength(2)
      const short = (
        await client.execute("SELECT id FROM credit_grants WHERE grant_key = 'short-occupied'")
      ).rows[0]!.id
      expect(allocations.find((row) => row.grant_id === short)).toMatchObject({
        amount_credits: 1,
        status: 'reserved',
      })
      state.now = '2026-11-12T12:00:02.000Z'
      const before = network()
      const writes = [
        vi.spyOn(payload, 'create'),
        vi.spyOn(payload, 'update'),
        vi.spyOn(payload, 'delete'),
      ]
      expect(await data({ owner, path: '/v1/creation-account', payload })).toMatchObject({
        available: 6,
        reserved: 2,
      })
      const held = await data<OwnerCreditPage<CreditReservationDTO>>({
        owner,
        path: '/v1/credits/reservations',
        payload,
      })
      expect(held.items[0]).toMatchObject({
        reservationId: reservations[0]!.id,
        reservedCredits: 2,
        taskId: task.id,
        taskStatus: 'queued',
      })
      const ledgerBefore = await data<OwnerCreditPage<CreditLedgerDTO>>({
        owner,
        path: '/v1/credits/ledger',
        payload,
      })
      expect(
        ledgerBefore.items
          .filter((row) => row.operation === 'reserve')
          .map((row) => row.ledgerDelta),
      ).toEqual([0, 0])
      expect((await client.execute('SELECT * FROM credit_allocations ORDER BY id')).rows).toEqual(
        allocations,
      )
      expect((await client.execute('SELECT * FROM credit_reservations')).rows).toEqual(reservations)
      for (const write of writes) {
        expect(write).not.toHaveBeenCalled()
      }
      expect(network()).toEqual(before)
      vi.restoreAllMocks()
      state.kind = 'not_sent'
      await getCoreRuntime({ payload }).worker.run({ taskId: task.id })
      const after = (await client.execute('SELECT * FROM credit_allocations ORDER BY id')).rows
      expect(after.map((row) => row.id)).toEqual(allocations.map((row) => row.id))
      expect(after.find((row) => row.grant_id === short)).toMatchObject({
        amount_credits: 1,
        status: 'expired',
      })
      expect(after.find((row) => row.grant_id !== short)).toMatchObject({
        amount_credits: 1,
        status: 'released',
      })
      expect((await client.execute('SELECT * FROM credit_reservations')).rows[0]).toMatchObject({
        id: reservations[0]!.id,
        status: 'released',
      })
      const ledger = await data<OwnerCreditPage<CreditLedgerDTO>>({
        owner,
        path: '/v1/credits/ledger',
        payload,
      })
      const release = ledger.items.filter((entry) => entry.operation === 'release')
      expect(release).toHaveLength(2)
      expect(release.map(({ ledgerDelta }) => ledgerDelta).sort()).toEqual([-1, 0])
      expect(release.find((entry) => entry.expiredDelta === 1)).toMatchObject({
        availableDelta: 0,
        ledgerDelta: -1,
        reservedDelta: -1,
      })
      expect(release.find((entry) => entry.expiredDelta === 0)).toMatchObject({
        availableDelta: 1,
        ledgerDelta: 0,
        reservedDelta: -1,
      })
      for (const entry of ledger.items) {
        expect(entry.ledgerDelta).toBe(entry.availableDelta + entry.reservedDelta)
      }
      expect(await data({ owner, path: '/v1/credits/reservations', payload })).toEqual({
        hasMore: false,
        items: [],
        nextCursor: null,
      })
      expect(await data({ owner, path: '/v1/creation-account', payload })).toMatchObject({
        available: 7,
        reserved: 0,
      })
    })

    test('should page actual generated artifacts and ledger using HTTP-issued owner/filter/endpoint-bound cursors', async ({
      payload,
    }) => {
      const owner = await setup({ payload })
      await issue({ amount: 60, expiresAt: null, key: 'pagination', owner, payload })
      for (let sequence = 0; sequence < 21; sequence++) {
        await generate({ owner, payload, sequence })
      }
      const first = await data<LibraryPage>({ owner, path: '/v1/artifacts', payload })
      expect(first.items).toHaveLength(20)
      expect(first.hasMore).toBe(true)
      const cursor = encodeURIComponent(first.nextCursor!)
      const second = await data<LibraryPage>({
        owner,
        path: '/v1/artifacts?cursor=' + cursor,
        payload,
      })
      expect(second.items).toHaveLength(1)
      expect(second.hasMore).toBe(false)
      expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(21)
      expect(await data({ owner, path: '/v1/artifacts?saved=false', payload })).toEqual(first)
      const other = await seedIdentity({ gate, payload })
      for (const [actor, path] of [
        [other, '/v1/artifacts?cursor=' + cursor],
        [owner, '/v1/artifacts?saved=true&cursor=' + cursor],
        [owner, '/v1/credits/ledger?cursor=' + cursor],
        [owner, '/v1/credits/reservations?cursor=' + cursor],
      ] as const) {
        await failure({ code: 'INPUT_INVALID', owner: actor, path, payload, status: 400 })
      }
      const ledger = await data<OwnerCreditPage<CreditLedgerDTO>>({
        owner,
        path: '/v1/credits/ledger',
        payload,
      })
      expect(ledger.items).toHaveLength(20)
      expect(ledger.hasMore).toBe(true)
      const ledgerCursor = encodeURIComponent(ledger.nextCursor!)
      expect(
        (
          await data<OwnerCreditPage<CreditLedgerDTO>>({
            owner,
            path: '/v1/credits/ledger?cursor=' + ledgerCursor,
            payload,
          })
        ).items,
      ).toHaveLength(20)
      await failure({
        code: 'INPUT_INVALID',
        owner: other,
        path: '/v1/credits/ledger?cursor=' + ledgerCursor,
        payload,
        status: 400,
      })
      await failure({
        code: 'INPUT_INVALID',
        owner,
        path: '/v1/credits/reservations?cursor=' + ledgerCursor,
        payload,
        status: 400,
      })
      await failure({
        code: 'INPUT_INVALID',
        owner,
        path: '/v1/artifacts?cursor=' + ledgerCursor,
        payload,
        status: 400,
      })
      for (const artifact of [...first.items, ...second.items]) {
        await data({ method: 'put', owner, path: `/v1/artifacts/${artifact.id}/favorite`, payload })
      }
      const saved = await data<LibraryPage>({ owner, path: '/v1/artifacts?saved=true', payload })
      expect(saved.items).toHaveLength(20)
      expect(saved.hasMore).toBe(true)
      expect(saved.items.every((row) => row.isFavorite)).toBe(true)
      await failure({
        code: 'INPUT_INVALID',
        owner,
        path: '/v1/artifacts?cursor=' + encodeURIComponent(saved.nextCursor!),
        payload,
        status: 400,
      })
    })

    test('should page 21 real pending reservations with their own HTTP cursor', async ({
      payload,
    }) => {
      const owner = await setup({ payload })
      await issue({ amount: 50, expiresAt: null, key: 'pending-pages', owner, payload })
      for (let sequence = 0; sequence < 21; sequence++) {
        await generate({ owner, payload, sequence, shouldRun: false })
      }
      const page = await data<OwnerCreditPage<CreditReservationDTO>>({
        owner,
        path: '/v1/credits/reservations',
        payload,
      })
      expect(page.items).toHaveLength(20)
      expect(page.hasMore).toBe(true)
      const cursor = encodeURIComponent(page.nextCursor!)
      const second = await data<OwnerCreditPage<CreditReservationDTO>>({
        owner,
        path: '/v1/credits/reservations?cursor=' + cursor,
        payload,
      })
      expect(second.items).toHaveLength(1)
      expect(second.items[0]!.reservationId).toBeLessThan(page.items.at(-1)!.reservationId)
      const other = await seedIdentity({ gate, payload })
      await failure({
        code: 'INPUT_INVALID',
        owner: other,
        path: '/v1/credits/reservations?cursor=' + cursor,
        payload,
        status: 400,
      })
      await failure({
        code: 'INPUT_INVALID',
        owner,
        path: '/v1/credits/ledger?cursor=' + cursor,
        payload,
        status: 400,
      })
    })

    test('should continue an empty saved scan across 501 tombstone identities with its own HTTP cursor', async ({
      payload,
    }) => {
      const owner = await setup({ payload })
      await generate({ owner, payload, sequence: 0 })
      const source = (await data<LibraryPage>({ owner, path: '/v1/artifacts', payload })).items[0]!
      const runtime = createCreationRuntime({ gate, payload })
      // Deleted chains are not projected; every distinct task/output tuple is still checked.
      await controlledWrite({
        gate,
        payload,
        work: async ({ req }) => {
          for (let index = 0; index < 501; index++) {
            const artifact = await runtime.create({
              collection: 'artifacts',
              data: {
                ...audit,
                deletedAt: now,
                deletedBy: 'system:runtime-fixture',
                isDeleted: true,
                mediaId: source.mediaId,
                outputIndex: 1,
                sessionId: source.sessionId,
                taskId: 1000 + index,
                userId: owner.userId,
              },
              req,
            })
            await runtime.create({
              collection: 'saved-artifacts',
              data: { ...audit, artifactId: artifact.id, savedAt: now, userId: owner.userId },
              req,
            })
          }
        },
      })
      const first = await data<LibraryPage>({ owner, path: '/v1/artifacts?saved=true', payload })
      expect(first).toEqual({ hasMore: true, items: [], nextCursor: expect.any(String) })
      expect(
        await data({
          owner,
          path: '/v1/artifacts?saved=true&cursor=' + encodeURIComponent(first.nextCursor!),
          payload,
        }),
      ).toEqual({ hasMore: false, items: [], nextCursor: null })
    })
  },
)
function reset() {
  state.now = now
  state.kind = 'output'
  state.redisDown = false
  state.beforeWechat = null
  state.wechatResult = { openId: 'library-http-owner', unionId: null }
  http.setFault('none')
  http.setConflict(412)
  http.observe(() => {})
}
function network() {
  return { image: state.imageCalls, naming: state.namingCalls, storage: http.requests.length }
}
async function setup({ payload }: { payload: Payload }): Promise<Owner> {
  const fixture = await seedChain({ config, gate, payload })
  const login = await getCoreRuntime({ payload }).identity.login({
    input: { code: 'library-owner' },
  })
  return {
    templateId: fixture.templateId,
    token: login.token,
    userId: login.user.id,
  }
}
function issue({
  amount,
  expiresAt,
  key,
  owner,
  payload,
}: {
  amount: number
  expiresAt: null | string
  key: string
  owner: Pick<Owner, 'userId'>
  payload: Payload
}) {
  return createPayloadCreditsService({
    actor: 'system:runtime-fixture',
    clock: () => state.now,
    coordinate: createRedisCreationCoordinator({ client: redis.client, config: config.redis })
      .coordinate,
    gate,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  }).issueGrant({
    command: {
      expiresAt,
      grantKey: key,
      issuedCredits: amount,
      sourceId: 'http-integration-only',
      sourceType: 'compensation',
      validFrom: state.now,
    },
    userId: owner.userId,
  })
}
async function generate({
  owner,
  payload,
  sequence,
  shouldRun = true,
}: {
  owner: Owner
  payload: Payload
  sequence: number
  shouldRun?: boolean
}) {
  const runtime = getCoreRuntime({ payload })
  const created = await runtime.session({
    command: {
      clientRequestId: `http-session-${sequence}`,
      templateId: owner.templateId,
    },
    userId: owner.userId,
  })
  const sessionId = created.session.id
  const input = { description: 'A green tree', inputMediaIds: [], userNotes: '' }
  const quote = await runtime.admission.quoteGenerate({ input, sessionId, userId: owner.userId })
  const accepted = await runtime.admission.submitGenerate({
    clientRequestId: `http-task-${sequence}`,
    input,
    quoteToken: quote.quoteToken,
    sessionId,
    userId: owner.userId,
  })
  if (shouldRun) {
    await runtime.worker.run({ taskId: accepted.task.id })
  }
  return accepted.task
}
async function data<T = unknown>(args: Parameters<typeof native>[0]): Promise<T> {
  const response = await native(args)
  expect(response.status).toBe(200)
  return (await envelope<T>({ response })).data
}
async function failure({
  code,
  status,
  ...args
}: { code: string; status: number } & Parameters<typeof native>[0]) {
  const response = await native(args)
  expect(response.status).toBe(status)
  expect((await envelope({ response })).error).toMatchObject({ code, retryable: false })
}
async function envelope<T = unknown>({ response }: { response: Response }): Promise<Envelope<T>> {
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/)
  const body = (await response.json()) as Envelope<T>
  expect(body.requestId).toBe(response.headers.get('x-request-id'))
  return body
}
function native({
  body,
  method = 'get',
  owner,
  path,
  payload,
}: {
  body?: string
  method?: 'delete' | 'get' | 'put'
  owner?: Pick<Owner, 'token'>
  path: string
  payload: Payload
}) {
  const handler =
    method === 'get'
      ? REST_GET(payload.config)
      : method === 'put'
        ? REST_PUT(payload.config)
        : REST_DELETE(payload.config)
  return wrapProductREST({ handler })(
    new Request(`${payload.config.serverURL}/api${path}`, {
      body,
      headers: owner ? { authorization: `Bearer ${owner.token}` } : {},
      method: method.toUpperCase(),
    }),
    {
      params: Promise.resolve({
        slug: path.slice(1).split('?')[0]!.split('/').map(decodeURIComponent),
      }),
    },
  )
}
