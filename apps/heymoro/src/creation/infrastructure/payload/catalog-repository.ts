import type { Payload, Where } from 'payload'

import type {
  CatalogOptions,
  CatalogPosition,
  CatalogRepository,
  CatalogTemplate,
  CatalogTerm,
} from '../../application/catalog.js'

import { createCatalog } from '../../application/catalog.js'
import { CatalogError } from '../../domain/template-config.js'

type Document = Record<string, unknown>
type ReadArguments = {
  collection: 'creation-templates' | 'session-shares' | 'taxonomy-terms'
  depth: 0
  limit: number
  overrideAccess: true
  pagination: false
  select: Record<string, true>
  sort?: string[]
  where: Where
}
type PublicReadAPI = { find: (args: ReadArguments) => Promise<unknown> }

export function createPayloadCatalog({
  payload,
  ...options
}: { payload: Payload } & CatalogOptions) {
  return createCatalog({ repository: createPayloadCatalogRepository({ payload }), ...options })
}

/** This adapter intentionally owns only find, not the private transactional write runtime. */
export function createPayloadCatalogRepository({
  payload,
}: {
  payload: Payload
}): CatalogRepository {
  const api = payload as unknown as PublicReadAPI
  const find = async (
    args: Omit<ReadArguments, 'depth' | 'overrideAccess' | 'pagination'>,
  ): Promise<Document[]> => {
    const result = await api.find({ ...args, depth: 0, overrideAccess: true, pagination: false })
    if (
      !result ||
      typeof result !== 'object' ||
      !('docs' in result) ||
      !Array.isArray(result.docs)
    ) {
      throw new CatalogError({ code: 'DATA_INTEGRITY_CONFLICT' })
    }
    return result.docs.map((doc: unknown) => {
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new CatalogError({ code: 'DATA_INTEGRITY_CONFLICT' })
      }
      return doc as Document
    })
  }
  const hydrate = async ({ docs }: { docs: Document[] }) => {
    const displays = docs.map((doc) => {
      try {
        const value = JSON.parse(string({ value: doc.displayConfigJson }))
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null
      } catch {
        return null
      }
    })
    const keys = [
      ...new Set(
        displays.flatMap((display) =>
          Array.isArray(display?.showcaseShareKeys) &&
          new Set(display.showcaseShareKeys).size === display.showcaseShareKeys.length
            ? display.showcaseShareKeys
            : [],
        ),
      ),
    ]
    if (!keys.length) {
      return docs
    }
    if (
      keys.length > docs.length * 8 ||
      keys.some((key) => typeof key !== 'string' || !/^[\w-]{32}$/.test(key))
    ) {
      throw new CatalogError({ code: 'DATA_INTEGRITY_CONFLICT' })
    }
    const shares = await find({
      collection: 'session-shares',
      limit: keys.length + 1,
      select: { id: true, isDeleted: true, publicKey: true, status: true, templateId: true },
      where: { publicKey: { in: keys } },
    })
    if (new Set(shares.map((row) => row.publicKey)).size !== shares.length) {
      throw new CatalogError({ code: 'DATA_INTEGRITY_CONFLICT' })
    }
    return docs.map((doc, index) => {
      const display = displays[index]
      if (
        !Array.isArray(display?.showcaseShareKeys) ||
        new Set(display.showcaseShareKeys).size !== display.showcaseShareKeys.length
      ) {
        return doc
      }
      return {
        ...doc,
        displayConfigJson: JSON.stringify({
          ...display,
          showcaseShareKeys: display.showcaseShareKeys.filter((key: string) =>
            shares.some(
              (share) =>
                share.publicKey === key &&
                share.templateId === doc.id &&
                share.status === 'published' &&
                share.isDeleted === false,
            ),
          ),
        }),
      }
    })
  }
  const templateSelect = {
    id: true,
    code: true,
    costCredits: true,
    displayConfigJson: true,
    inputSchemaJson: true,
    isDeleted: true,
    kind: true,
    minClientCapability: true,
    schemaVersion: true,
    sortOrder: true,
    status: true,
  } as const
  return Object.freeze({
    findFree: async () =>
      (
        await hydrate({
          docs: await find({
            collection: 'creation-templates',
            limit: 2,
            select: templateSelect,
            where: { code: { equals: 'free' } },
          }),
        })
      ).map((doc) => template({ doc })),
    readTemplate: async ({ templateId }) => {
      const docs = await find({
        collection: 'creation-templates',
        limit: 2,
        select: templateSelect,
        where: { id: { equals: templateId } },
      })
      if (docs.length > 1) {
        throw new CatalogError({ code: 'DATA_INTEGRITY_CONFLICT' })
      }
      return docs[0] ? template({ doc: (await hydrate({ docs }))[0]! }) : null
    },
    scanEffects: async ({ after, categoryId, limit }) => {
      const and: Where[] = [
        { kind: { equals: 'effect' } },
        { status: { equals: 'published' } },
        { isDeleted: { equals: false } },
      ]
      if (categoryId !== null) {
        and.push({ primaryCategoryId: { equals: categoryId } })
      }
      if (after) {
        and.push(keyset({ after }))
      }
      return (
        await hydrate({
          docs: await find({
            collection: 'creation-templates',
            limit,
            select: templateSelect,
            sort: ['sortOrder', 'id'],
            where: { and },
          }),
        })
      ).map((doc) => template({ doc }))
    },
    scanTerms: async ({ after, limit }) => {
      const and: Where[] = [
        { status: { equals: 'active' } },
        { isDeleted: { equals: false } },
        { kind: { in: ['category', 'label'] } },
      ]
      if (after) {
        and.push(keyset({ after }))
      }
      return (
        await find({
          collection: 'taxonomy-terms',
          limit,
          select: { id: true, name: true, kind: true, sortOrder: true },
          sort: ['sortOrder', 'id'],
          where: { and },
        })
      ).map((doc): CatalogTerm => ({
        id: integer({ value: doc.id }),
        name: string({ value: doc.name }),
        kind: string({ value: doc.kind }),
        sortOrder: integer({ minimum: Number.MIN_SAFE_INTEGER, value: doc.sortOrder }),
      }))
    },
  })
}

function keyset({ after }: { after: CatalogPosition }): Where {
  return {
    or: [
      { sortOrder: { greater_than: after.sortOrder } },
      { and: [{ sortOrder: { equals: after.sortOrder } }, { id: { greater_than: after.id } }] },
    ],
  }
}
function template({ doc }: { doc: Document }): CatalogTemplate {
  return {
    id: integer({ value: doc.id }),
    code: string({ value: doc.code }),
    costCredits: integer({ minimum: 0, value: doc.costCredits }),
    displayConfigJson: string({ value: doc.displayConfigJson }),
    inputSchemaJson: string({ value: doc.inputSchemaJson }),
    isDeleted: boolean({ value: doc.isDeleted }),
    kind: string({ value: doc.kind }),
    minClientCapability: string({ value: doc.minClientCapability }),
    schemaVersion: integer({ value: doc.schemaVersion }),
    sortOrder: integer({ minimum: Number.MIN_SAFE_INTEGER, value: doc.sortOrder }),
    status: string({ value: doc.status }),
  }
}
function integer({ minimum = 1, value }: { minimum?: number; value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new CatalogError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
  return value
}
function string({ value }: { value: unknown }): string {
  if (typeof value !== 'string') {
    throw new CatalogError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
  return value
}
function boolean({ value }: { value: unknown }): boolean {
  if (typeof value !== 'boolean') {
    throw new CatalogError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
  return value
}
