import type { Payload, PayloadRequest } from 'payload'

import { createHmac } from 'node:crypto'
import { createPayloadRequest } from 'payload'
import { expect, vi } from 'vitest'

import type { CatalogOptions } from '../../src/creation/application/catalog.js'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createPayloadCatalog } from '../../src/creation/infrastructure/payload/catalog-repository.js'
import { createCreationRuntime } from '../../src/creation/infrastructure/payload/session-repository.js'
import {
  createSQLiteUnitOfWork,
  getCreationSQLiteAdapter,
} from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { cleanupSQLiteFixture, gate } from './sqlite.config.js'
import { corruptCurrentTemplate } from './template-corruption-fixture.js'

const hostCaps = {
  allowedMimeTypes: ['image/jpeg', 'image/png'],
  maxDescriptionLength: 200,
  maxImageBytes: 1000,
  maxImages: 4,
  maxNotesLength: 100,
  maxTotalImageBytes: 3000,
  minImages: 0,
}
const effectInput = { ...hostCaps, maxDescriptionLength: 0, minImages: 1 }
const freeInput = { ...hostCaps, maxNotesLength: 0 }
const display = {
  name: 'Published Portrait',
  coverMediaId: 21,
  description: ' literal <text> ',
  examples: [{ inputMediaIds: [31, 30], outputMediaId: 32 }],
  photoHint: 'Choose your photo',
}
const audit = {
  createdBy: 'system:catalog-fixture',
  deletedAt: null,
  deletedBy: null,
  isDeleted: false,
  updatedBy: 'system:catalog-fixture',
}
const key = Buffer.alloc(32, 7)

test.suite(
  'Heymoro isolated public template catalog',
  { config: './sqlite.config.ts', cron: false },
  () => {
    test.afterAll(() => cleanupSQLiteFixture())
    test.afterEach(() => vi.restoreAllMocks())

    test('registers private audited taxonomy with ordinary indexes and no foreign keys', async ({
      payload,
    }) => {
      const collection = payload.config.collections.find(
        ({ slug }) => String(slug) === 'taxonomy-terms',
      )
      expect(collection).toBeDefined()
      expect(
        await collection!.access.read({
          slug: 'taxonomy-terms',
          req: await createPayloadRequest({ payload }),
        }),
      ).toBe(false)
      await expect(
        payload.create({
          collection: 'taxonomy-terms' as never,
          data: {} as never,
          overrideAccess: true,
        }),
      ).rejects.toThrow(/capability/)
      const client = getCreationSQLiteAdapter({ payload }).client
      const indexes = await client.execute("PRAGMA index_list('taxonomy_terms')")
      expect(indexes.rows).toHaveLength(2)
      expect(indexes.rows.every((row) => Number(row.unique) === 0)).toBe(true)
      expect((await client.execute("PRAGMA foreign_key_list('taxonomy_terms')")).rows).toHaveLength(
        0,
      )
    })

    test('reads only published effect configurations and explicitly selects public source fields without transactions', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      await seed({ payload, template: { code: 'draft', status: 'offline' } })
      await seed({ payload, template: { code: 'offline', status: 'offline' } })
      await seed({ payload, template: { code: 'deleted', ...deleted } })
      await seed({
        input: freeInput,
        payload,
        publicDisplay: { name: 'Free', coverMediaId: null, examples: [] },
        template: { code: 'free', kind: 'free' },
      })
      const catalog = await reader({ payload })
      const findSpy = vi.spyOn(payload, 'find')
      const transactionSpy = vi.spyOn(getCreationSQLiteAdapter({ payload }).client, 'transaction')
      const result = await catalog.list({ query: {} })
      expect(result.items.map((item: { templateId: number }) => item.templateId)).toEqual([
        fixture.templateId,
      ])
      expect(result).toMatchObject({ hasMore: false, nextCursor: null })
      expect(result.items[0]).toMatchObject({
        costCredits: 3,
        displayConfig: Object.fromEntries(
          Object.entries({ ...display, showcaseShareKeys: [] }).filter(
            ([key]) => key !== 'examples',
          ),
        ),
        inputSchema: effectInput,
        mode: 'effect',
      })
      expect(result.items[0].displayConfig).toMatchObject({
        categoryId: null,
        categoryName: null,
        primaryTagId: null,
        searchAliases: [],
        tagIds: [],
        tags: [],
      })
      expect(JSON.stringify(result)).not.toMatch(
        /generationConfig|shareConfig|system:|provider-secret|internal-prompt|mutable-name/,
      )
      expect(Object.isFrozen(result.items[0].displayConfig.showcaseShareKeys)).toBe(true)
      expect(transactionSpy).not.toHaveBeenCalled()
      for (const [args] of findSpy.mock.calls) {
        expect(args).toMatchObject({ depth: 0, overrideAccess: true, pagination: false })
        expect(args.select).toBeDefined()
        expect(args.select).not.toHaveProperty('generationConfigJson')
        expect(args.select).not.toHaveProperty('shareConfigJson')
        expect(args.req).toBeUndefined()
      }
    })

    test('intersects category identity with published name tag and alias search, not mutable names', async ({
      payload,
    }) => {
      const first = await seed({
        payload,
        publicDisplay: {
          ...display,
          categoryId: 8,
          categoryName: 'Snapshot category',
          primaryTagId: 3,
          searchAliases: ['plush toy'],
          tagIds: [3],
          tags: [{ id: 3, name: 'Velvet' }],
        },
        template: { primaryCategoryId: 8 },
      })
      await seed({
        payload,
        publicDisplay: { ...display, name: 'Velvet other', categoryId: 9, categoryName: 'Other' },
        template: { code: 'other', primaryCategoryId: 9 },
      })
      const catalog = await reader({ payload })
      for (const keyword of ['portrait', ' VELVET ', 'plush']) {
        expect(
          (await catalog.list({ query: { categoryId: 8, keyword } })).items.map(
            (item: { templateId: number }) => item.templateId,
          ),
        ).toEqual([first.templateId])
      }
      expect((await catalog.list({ query: { categoryId: 8, keyword: 'other' } })).items).toEqual([])
      expect((await catalog.list({ query: { keyword: 'mutable-name' } })).items).toEqual([])
    })

    test('returns only active undeleted category and label metadata in stable order', async ({
      payload,
    }) => {
      await write({
        payload,
        work: async ({ req, runtime }) => {
          for (const term of [
            { name: 'Live category', code: 'c', kind: 'category', sortOrder: 1, status: 'active' },
            { name: 'Live label', code: 'l', kind: 'label', sortOrder: 0, status: 'active' },
            { name: 'Hidden', code: 'h', kind: 'category', sortOrder: 0, status: 'hidden' },
            {
              name: 'Deleted',
              code: 'd',
              kind: 'label',
              sortOrder: 0,
              status: 'active',
              ...deleted,
            },
          ]) {
            await runtime.create({ collection: 'taxonomy-terms', data: { ...audit, ...term }, req })
          }
        },
      })
      const result = await (await reader({ payload })).getTaxonomy()
      expect(result.categories.map((term: { name: string }) => term.name)).toEqual([
        'Live category',
      ])
      expect(result.labels.map((term: { name: string }) => term.name)).toEqual(['Live label'])
      expect(Object.keys(result.categories[0]).sort()).toEqual(['id', 'name'])
    })

    test('uses stable same-sort keysets without losing unreturned matches from a batch', async ({
      payload,
    }) => {
      const fixtures = []
      for (let index = 0; index < 7; index++) {
        fixtures.push(
          await seed({
            payload,
            template: { code: `effect-${index}`, sortOrder: index < 5 ? 0 : 1 },
          }),
        )
      }
      const catalog = await reader({ batchSize: 5, pageSize: 2, payload })
      const ids: number[] = []
      let cursor: string | undefined
      do {
        const result = await catalog.list({ query: cursor ? { cursor } : {} })
        ids.push(...result.items.map((item: { templateId: number }) => item.templateId))
        cursor = result.nextCursor ?? undefined
        expect(result.hasMore).toBe(Boolean(cursor))
      } while (cursor)
      expect(ids).toEqual(fixtures.map(({ templateId }) => templateId))
      expect(new Set(ids).size).toBe(7)
    })

    test('preserves a scan-budget cursor through incompatible and nonmatching rows', async ({
      payload,
    }) => {
      await seed({ configuration: { schemaVersion: 2 }, payload, template: { code: 'bad' } })
      await seed({
        payload,
        publicDisplay: { ...display, name: 'No match' },
        template: { code: 'miss' },
      })
      const target = await seed({ payload, template: { code: 'target' } })
      const catalog = await reader({ batchSize: 2, pageSize: 2, payload, scanBudget: 2 })
      const first = await catalog.list({ query: { keyword: 'portrait' } })
      expect(first.items).toEqual([])
      expect(first.hasMore).toBe(true)
      expect(first.nextCursor).toBeTypeOf('string')
      const second = await catalog.list({
        query: { cursor: first.nextCursor, keyword: 'portrait' },
      })
      expect(second.items.map((item: { templateId: number }) => item.templateId)).toEqual([
        target.templateId,
      ])
      expect(second.hasMore).toBe(false)
    })

    test('reads one current-template batch rather than performing one read per card', async ({
      payload,
    }) => {
      for (let index = 0; index < 8; index++) {
        await seed({ payload, template: { code: `batch-${index}` } })
      }
      const catalog = await reader({ payload })
      const spy = vi.spyOn(payload, 'find')
      expect((await catalog.list({ query: {} })).items).toHaveLength(8)
      expect(
        spy.mock.calls.filter(([args]) => String(args.collection) === 'creation-templates'),
      ).toHaveLength(1)
    })

    test('binds signed cursors to purpose normalized filters and capability policy', async ({
      payload,
    }) => {
      await seed({ payload, template: { code: 'a', primaryCategoryId: 8 } })
      await seed({ payload, template: { code: 'b', primaryCategoryId: 8 } })
      const catalog = await reader({ pageSize: 1, payload })
      const first = await catalog.list({ query: { categoryId: 8, keyword: ' PORTRAIT ' } })
      const cursor = first.nextCursor
      expect(cursor).toBeTypeOf('string')
      if (typeof cursor !== 'string') {
        throw new Error('Expected a continuation cursor for the second published card.')
      }
      expect(
        (await catalog.list({ query: { categoryId: 8, cursor, keyword: 'portrait' } })).items,
      ).toHaveLength(1)
      for (const query of [
        { categoryId: 9, cursor, keyword: 'portrait' },
        { categoryId: 8, cursor, keyword: 'other' },
        { cursor },
        { categoryId: 8, cursor: `${cursor.slice(0, -3)}abc`, keyword: 'portrait' },
      ]) {
        await expect(catalog.list({ query })).rejects.toMatchObject({
          code: 'INPUT_INVALID',
          status: 400,
        })
      }
      const otherPolicy = await reader({ payload, policyId: 'other' })
      await expect(
        otherPolicy.list({ query: { categoryId: 8, cursor, keyword: 'portrait' } }),
      ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
    })

    test('rejects authenticated malformed purpose unknown fields and duplicate JSON keys in cursors', async ({
      payload,
    }) => {
      const catalog = await reader({ payload })
      const cursorData = {
        id: 1,
        categoryId: null,
        keyword: '',
        policyId: 'fixture-capabilities-v1',
        purpose: 'effect-catalog-v1',
        sortOrder: 0,
      }
      const malformed = [
        JSON.stringify({ ...cursorData, purpose: 'other-purpose' }),
        JSON.stringify({ ...cursorData, extra: true }),
        JSON.stringify({ ...cursorData, id: 0 }),
        JSON.stringify(cursorData).replace('"id":1', '"id":0,"id":1'),
      ]
      for (const json of malformed) {
        const encoded = Buffer.from(json).toString('base64url')
        const cursor = `${encoded}.${createHmac('sha256', key).update(encoded).digest('base64url')}`
        await expect(catalog.list({ query: { cursor } })).rejects.toMatchObject({
          code: 'INPUT_INVALID',
        })
      }
    })

    test('rejects unknown query fields malformed identifiers and oversized or noncanonical cursors', async ({
      payload,
    }) => {
      const catalog = await reader({ payload })
      for (const query of [
        null,
        [],
        { userId: 1 },
        { pageSize: 500 },
        { categoryId: '1' },
        { categoryId: 0 },
        { keyword: null },
        { keyword: 'x'.repeat(201) },
        { cursor: null },
        { cursor: '' },
        { cursor: 'a'.repeat(4097) },
        { cursor: 'e30=.abc' },
        { cursor: 'e30.abc' },
      ]) {
        await expect(catalog.list({ query })).rejects.toMatchObject({
          code: 'INPUT_INVALID',
          status: 400,
        })
      }
      for (const templateId of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
        await expect(catalog.get({ templateId })).rejects.toMatchObject({ code: 'INPUT_INVALID' })
      }
      await expect(catalog.get({ templateId: 1, versionId: null })).rejects.toMatchObject({
        code: 'INPUT_INVALID',
      })
    })

    test('reads a single current configuration immediately after a same-row save and rejects retired selectors', async ({
      payload,
    }) => {
      const fixture = await seed({ payload })
      const catalog = await reader({ payload })
      expect(await catalog.get({ templateId: fixture.templateId })).toMatchObject({
        costCredits: 3,
        templateId: fixture.templateId,
      })
      await update({
        id: fixture.templateId,
        collection: 'creation-templates',
        data: { costCredits: 9 },
        payload,
      })
      expect(await catalog.get({ templateId: fixture.templateId })).toMatchObject({
        costCredits: 9,
        templateId: fixture.templateId,
      })
      await expect(
        catalog.get({ templateId: fixture.templateId, versionId: fixture.templateId }),
      ).rejects.toMatchObject({ code: 'INPUT_INVALID', status: 400 })
      await update({
        id: fixture.templateId,
        collection: 'creation-templates',
        data: { status: 'offline' },
        payload,
      })
      await expect(catalog.get({ templateId: fixture.templateId })).rejects.toMatchObject({
        code: 'TEMPLATE_UNAVAILABLE',
        status: 409,
      })
    })

    test('rejects malformed current configuration and incompatible capabilities in details and skips them in the catalog', async ({
      payload,
    }) => {
      const a = await seed({ payload, template: { code: 'a' } })
      const b = await seed({
        configuration: { minClientCapability: 'unsupported' },
        payload,
        template: { code: 'b' },
      })
      await corruptCurrentTemplate({
        data: { inputSchemaJson: '{broken' },
        payload,
        templateId: a.templateId,
      })
      const catalog = await reader({ payload })
      expect((await catalog.list({ query: {} })).items).toEqual([])
      for (const templateId of [a.templateId, b.templateId]) {
        await expect(catalog.get({ templateId })).rejects.toMatchObject({
          code: 'TEMPLATE_UNAVAILABLE',
        })
      }
    })

    test('returns free only through its independent current preset endpoint', async ({
      payload,
    }) => {
      const fixture = await seed({
        input: freeInput,
        payload,
        publicDisplay: { name: 'Free', coverMediaId: null, examples: [] },
        template: { code: 'free', kind: 'free' },
      })
      const catalog = await reader({ payload })
      expect(await catalog.getFreePreset()).toMatchObject({
        costCredits: 3,
        inputSchema: freeInput,
        mode: 'free',
        templateId: fixture.templateId,
      })
      expect((await catalog.list({ query: {} })).items).toEqual([])
      await expect(catalog.get({ templateId: fixture.templateId })).rejects.toMatchObject({
        code: 'TEMPLATE_UNAVAILABLE',
      })
      await update({
        id: fixture.templateId,
        collection: 'creation-templates',
        data: { status: 'offline' },
        payload,
      })
      await expect(catalog.getFreePreset()).rejects.toMatchObject({ code: 'TEMPLATE_UNAVAILABLE' })
    })

    test('fails free logical-key duplicates even when the other row is deleted or offline', async ({
      payload,
    }) => {
      await seed({
        input: freeInput,
        payload,
        publicDisplay: { name: 'Free', coverMediaId: null, examples: [] },
        template: { code: 'free', kind: 'free' },
      })
      await seed({
        input: freeInput,
        payload,
        publicDisplay: { name: 'Free', coverMediaId: null, examples: [] },
        template: { code: 'free', kind: 'free', status: 'offline', ...deleted },
      })
      await expect((await reader({ payload })).getFreePreset()).rejects.toMatchObject({
        code: 'DATA_INTEGRITY_CONFLICT',
        status: 503,
      })
    })

    test('discards retired uploaded examples without republishing private source images', async ({
      payload,
    }) => {
      const fixture = await seed({
        payload,
        publicDisplay: { ...display, examples: [{ outputMediaId: 32 }] },
      })
      const detail = await (await reader({ payload })).get({ templateId: fixture.templateId })
      expect(detail.displayConfig).not.toHaveProperty('examples')
      expect(detail.displayConfig.showcaseShareKeys).toEqual([])
    })

    test('skips offline deleted and damaged current configurations without hiding a healthy card', async ({
      payload,
    }) => {
      await seed({ payload, template: { code: 'offline', status: 'offline' } })
      await seed({ payload, template: { code: 'deleted', ...deleted } })
      const damaged = await seed({ payload, template: { code: 'damaged' } })
      await corruptCurrentTemplate({
        data: { displayConfigJson: '{broken' },
        payload,
        templateId: damaged.templateId,
      })
      const healthy = await seed({ payload, template: { code: 'healthy' } })
      const catalog = await reader({ payload })
      expect((await catalog.list({ query: {} })).items.map(({ templateId }) => templateId)).toEqual(
        [healthy.templateId],
      )
      await expect(catalog.get({ templateId: damaged.templateId })).rejects.toMatchObject({
        code: 'TEMPLATE_UNAVAILABLE',
      })
    })

    test('reads taxonomy metadata beyond one batch without silently truncating it', async ({
      payload,
    }) => {
      await write({
        payload,
        work: async ({ req, runtime }) => {
          for (let index = 0; index < 102; index++) {
            await runtime.create({
              collection: 'taxonomy-terms',
              data: {
                ...audit,
                name: `Category ${index}`,
                code: `category-${index}`,
                kind: 'category',
                sortOrder: 0,
                status: 'active',
              },
              req,
            })
          }
        },
      })
      expect((await (await reader({ payload })).getTaxonomy()).categories).toHaveLength(102)
    })

    test('intersects explicit host caps without changing literal text or input order', async ({
      payload,
    }) => {
      const fixture = await seed({
        input: {
          ...effectInput,
          allowedMimeTypes: ['image/png', 'image/webp'],
          maxImageBytes: 9000,
          maxImages: 9,
          maxNotesLength: 1000,
          maxTotalImageBytes: 9000,
        },
        payload,
      })
      const detail = await (await reader({ payload })).get({ templateId: fixture.templateId })
      expect(detail.inputSchema).toEqual({ ...effectInput, allowedMimeTypes: ['image/png'] })
      expect(detail.displayConfig.description).toBe(' literal <text> ')
      expect(detail.displayConfig).not.toHaveProperty('examples')
    })

    for (const [label, changes] of Object.entries({
      'duplicate share references': {
        publicDisplay: { ...display, showcaseShareKeys: ['a'.repeat(32), 'a'.repeat(32)] },
      },
      'effect with descriptions': { input: { ...effectInput, maxDescriptionLength: 10 } },
      'effect without mandatory image': { input: { ...effectInput, minImages: 0 } },
      'empty MIME intersection': { input: { ...effectInput, allowedMimeTypes: ['image/webp'] } },
      'impossible image count intersection': {
        input: { ...effectInput, maxImages: 6, minImages: 5 },
      },
      'inconsistent category': { publicDisplay: { ...display, categoryId: 8 } },
      'inconsistent tag order': {
        publicDisplay: {
          ...display,
          tagIds: [1, 2],
          tags: [
            { id: 2, name: 'Two' },
            { id: 1, name: 'One' },
          ],
        },
      },
      'invalid alias type': { publicDisplay: { ...display, searchAliases: [8] } },
      'invalid JSON': { configuration: { displayConfigJson: '{broken' } },
      'invalid primary tag': { publicDisplay: { ...display, primaryTagId: 8 } },
      'unknown display field': { publicDisplay: { ...display, prompt: 'internal-prompt' } },
      'unknown input field': { input: { ...effectInput, provider: 'provider-secret' } },
      'unknown schema': { configuration: { schemaVersion: 2 } },
      'wrong input type': { input: { ...effectInput, maxImages: '4' } },
    })) {
      test(`skips ${label} and returns a sanitized unavailable detail error`, async ({
        payload,
      }) => {
        const fixture = await seed({ payload, ...changes })
        const catalog = await reader({ payload })
        expect((await catalog.list({ query: {} })).items).toEqual([])
        await expect(catalog.get({ templateId: fixture.templateId })).rejects.toMatchObject({
          code: 'TEMPLATE_UNAVAILABLE',
          message: 'Template is unavailable.',
          status: 409,
        })
      })
    }

    test('rejects free constraints with required images disabled descriptions or enabled notes', async ({
      payload,
    }) => {
      const fixture = await seed({
        input: freeInput,
        payload,
        publicDisplay: { name: 'Free', coverMediaId: null, examples: [] },
        template: { code: 'free', kind: 'free' },
      })
      const catalog = await reader({ payload })
      for (const input of [
        { ...freeInput, minImages: 1 },
        { ...freeInput, maxDescriptionLength: 0 },
        { ...freeInput, maxNotesLength: 1 },
      ]) {
        await corruptCurrentTemplate({
          data: { inputSchemaJson: JSON.stringify(input) },
          payload,
          templateId: fixture.templateId,
        })
        await expect(catalog.getFreePreset()).rejects.toMatchObject({
          code: 'TEMPLATE_UNAVAILABLE',
        })
      }
    })

    test('requires strong cursor keys explicit policy identity valid caps and bounded pagination', async ({
      payload,
    }) => {
      for (const changes of [
        { cursorKey: Buffer.alloc(31) },
        { policyId: '' },
        { pageSize: 0 },
        { pageSize: 51 },
        { scanBudget: 0 },
        { batchSize: 0 },
        { hostCaps: { ...hostCaps, maxImages: -1 } },
      ]) {
        await expect(reader({ payload, ...changes })).rejects.toThrow()
      }
    })
  },
)

const deleted = {
  deletedAt: '2026-11-12T00:00:00.000Z',
  deletedBy: 'system:catalog-fixture',
  isDeleted: true,
}

function reader({
  payload,
  policyId = 'fixture-capabilities-v1',
  ...options
}: { payload: Payload; policyId?: string } & Partial<CatalogOptions>) {
  return Promise.resolve().then(() =>
    createPayloadCatalog({
      capabilityPolicy: {
        id: policyId,
        isCompatible: ({ minClientCapability, schemaVersion }) =>
          schemaVersion === 1 && minClientCapability === 'fixture-v1',
      },
      cursorKey: key,
      hostCaps,
      payload,
      ...options,
    }),
  )
}

function write<T>({
  payload,
  work,
}: {
  payload: Payload
  work: (args: {
    req: PayloadRequest
    runtime: ReturnType<typeof createCreationRuntime>
  }) => Promise<T>
}) {
  const runtime = createCreationRuntime({ gate, payload })
  return createSQLiteUnitOfWork({
    coordinate: async ({ work }) => work({ assertLease: () => {} }),
    gate,
    payload,
    retry: { backoffMs: 0, maxAttempts: 1 },
  })({ resource: 'catalog-fixture-only', work: ({ req }) => work({ req, runtime }) })
}
async function seed({
  configuration = {},
  input = effectInput,
  payload,
  publicDisplay = display,
  template = {},
}: {
  configuration?: Record<string, unknown>
  input?: Record<string, unknown>
  payload: Payload
  publicDisplay?: Record<string, unknown>
  template?: Record<string, unknown>
}) {
  const templateId = await write({
    payload,
    work: async ({ req, runtime }) => {
      const doc = await runtime.create({
        collection: 'creation-templates',
        data: {
          ...audit,
          name: 'mutable-name',
          code: 'portrait',
          costCredits: 3,
          displayConfigJson: JSON.stringify(publicDisplay),
          generationConfigJson: '{"prompt":"internal-prompt","key":"provider-secret"}',
          inputSchemaJson: JSON.stringify(input),
          kind: 'effect',
          minClientCapability: 'fixture-v1',
          schemaVersion: 1,
          shareConfigJson: '{"internal":true}',
          sortOrder: 0,
          status: 'published',
          ...configuration,
          ...template,
        },
        req,
      })
      return Number(doc.id)
    },
  })
  return { templateId }
}
function update({
  id,
  collection,
  data,
  payload,
}: {
  collection: 'creation-templates'
  data: Record<string, unknown>
  id: number
  payload: Payload
}) {
  return write({
    payload,
    work: ({ req, runtime }) =>
      runtime.update({
        id,
        collection,
        data: { updatedBy: 'system:catalog-fixture', ...data },
        req,
      }),
  })
}
