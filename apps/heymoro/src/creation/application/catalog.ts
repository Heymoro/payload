import { createHmac, timingSafeEqual } from 'node:crypto'

import type { InputSchema, PublicTemplateConfig, TemplateKind } from '../domain/template-config.js'

import {
  CatalogError,
  freezeCatalogValue,
  parsePublicTemplateConfig,
  validateHostCaps,
} from '../domain/template-config.js'

export type CatalogPosition = Readonly<{ id: number; sortOrder: number }>
export type CatalogTemplate = CatalogPosition &
  Readonly<{
    code: string
    costCredits: number
    displayConfigJson: string
    inputSchemaJson: string
    isDeleted: boolean
    kind: string
    minClientCapability: string
    schemaVersion: number
    status: string
  }>
export type CatalogTerm = CatalogPosition & Readonly<{ kind: string; name: string }>
export type CatalogRepository = Readonly<{
  findFree: () => Promise<readonly CatalogTemplate[]>
  readTemplate: (args: { templateId: number }) => Promise<CatalogTemplate | null>
  scanEffects: (args: {
    after: CatalogPosition | null
    categoryId: null | number
    limit: number
  }) => Promise<readonly CatalogTemplate[]>
  scanTerms: (args: {
    after: CatalogPosition | null
    limit: number
  }) => Promise<readonly CatalogTerm[]>
}>
export type CapabilityPolicy = Readonly<{
  id: string
  isCompatible: (args: { minClientCapability: string; schemaVersion: number }) => boolean
}>
export type CatalogOptions = Readonly<{
  batchSize?: number
  capabilityPolicy: CapabilityPolicy
  cursorKey: Uint8Array
  hostCaps: InputSchema
  pageSize?: number
  scanBudget?: number
}>
export type PublicTemplate = PublicTemplateConfig &
  Readonly<{
    costCredits: number
    minClientCapability: string
    mode: TemplateKind
    schemaVersion: number
    templateId: number
  }>
export type CatalogPage = Readonly<{
  hasMore: boolean
  items: readonly PublicTemplate[]
  nextCursor: null | string
}>
type Filters = Readonly<{ categoryId: null | number; keyword: string }>

/** Public reads have no account context, write lease or execution configuration capability. */
export function createCatalog({
  batchSize = 50,
  capabilityPolicy,
  cursorKey,
  hostCaps,
  pageSize = 20,
  repository,
  scanBudget = 500,
}: { repository: CatalogRepository } & CatalogOptions) {
  const caps = validateHostCaps({ hostCaps })
  if (
    !(cursorKey instanceof Uint8Array) ||
    cursorKey.byteLength < 32 ||
    !capabilityPolicy ||
    typeof capabilityPolicy.id !== 'string' ||
    !capabilityPolicy.id.trim() ||
    capabilityPolicy.id.length > 128 ||
    typeof capabilityPolicy.isCompatible !== 'function'
  ) {
    throw new Error('Explicit catalog key and capability policy are required.')
  }
  assertInteger({ maximum: 50, minimum: 1, value: pageSize })
  assertInteger({ maximum: 100, minimum: 1, value: batchSize })
  assertInteger({ maximum: 10000, minimum: 1, value: scanBudget })
  const key = Buffer.from(cursorKey)
  const policyId = capabilityPolicy.id
  const isCompatible = capabilityPolicy.isCompatible
  const project = ({
    kind,
    template,
  }: {
    kind: TemplateKind
    template: CatalogTemplate
  }): null | PublicTemplate => {
    if (template.kind !== kind || template.status !== 'published' || template.isDeleted !== false) {
      return null
    }
    try {
      if (
        !Number.isSafeInteger(template.costCredits) ||
        template.costCredits < 0 ||
        !isCompatible({
          minClientCapability: template.minClientCapability,
          schemaVersion: template.schemaVersion,
        })
      ) {
        return null
      }
      const config = parsePublicTemplateConfig({ ...template, hostCaps: caps, kind })
      return freezeCatalogValue({
        value: {
          costCredits: template.costCredits,
          minClientCapability: template.minClientCapability,
          mode: kind,
          schemaVersion: template.schemaVersion,
          templateId: template.id,
          ...config,
        },
      })
    } catch {
      return null
    }
  }
  const detail = ({
    kind,
    template,
  }: {
    kind: TemplateKind
    template: CatalogTemplate | null
  }): PublicTemplate => {
    const result = template && project({ kind, template })
    if (!result) {
      throw new CatalogError({ code: 'TEMPLATE_UNAVAILABLE' })
    }
    return result
  }
  return Object.freeze({
    get: async (args: { templateId: unknown }): Promise<PublicTemplate> => {
      const fields = record({ keys: ['templateId'], value: args })
      const templateId = assertInteger({ minimum: 1, value: fields.templateId })
      return detail({ kind: 'effect', template: await repository.readTemplate({ templateId }) })
    },
    getFreePreset: async (): Promise<PublicTemplate> => {
      const templates = await repository.findFree()
      if (templates.length > 1) {
        throw new CatalogError({ code: 'DATA_INTEGRITY_CONFLICT' })
      }
      return detail({ kind: 'free', template: templates[0] ?? null })
    },
    getTaxonomy: async () => {
      const categories: { id: number; name: string }[] = []
      const labels: { id: number; name: string }[] = []
      let after: CatalogPosition | null = null
      for (;;) {
        const batch = await repository.scanTerms({ after, limit: 100 })
        for (const term of batch) {
          const items = term.kind === 'category' ? categories : labels
          items.push({ id: term.id, name: term.name })
          after = { id: term.id, sortOrder: term.sortOrder }
        }
        if (batch.length < 100) {
          return freezeCatalogValue({ value: { categories, labels } })
        }
      }
    },
    list: async ({ query }: { query: unknown }): Promise<CatalogPage> => {
      const fields = record({ keys: ['categoryId', 'keyword', 'cursor'], value: query })
      const filters: Filters = {
        categoryId:
          fields.categoryId === undefined
            ? null
            : assertInteger({ minimum: 1, value: fields.categoryId }),
        keyword: fields.keyword === undefined ? '' : keyword({ value: fields.keyword }),
      }
      let after =
        fields.cursor === undefined
          ? null
          : decodeCursor({ filters, key, policyId, value: fields.cursor })
      let scanned = 0
      const items: PublicTemplate[] = []
      const finish = ({ hasMore }: { hasMore: boolean }): CatalogPage =>
        freezeCatalogValue({
          value: {
            hasMore,
            items,
            nextCursor: hasMore && after ? encodeCursor({ after, filters, key, policyId }) : null,
          },
        })
      while (scanned < scanBudget) {
        const count = Math.min(batchSize, scanBudget - scanned)
        const batch = await repository.scanEffects({
          after,
          categoryId: filters.categoryId,
          limit: count + 1,
        })
        const candidates = batch.slice(0, count)
        if (!candidates.length) {
          return finish({ hasMore: false })
        }
        for (let index = 0; index < candidates.length; index++) {
          const template = candidates[index]!
          after = { id: template.id, sortOrder: template.sortOrder }
          scanned++
          const item = project({
            kind: 'effect',
            template,
          })
          if (item && matches({ item, keyword: filters.keyword })) {
            items.push(item)
          }
          // Advance only through consumed rows: an overfetched matching card must remain for the next page.
          if (items.length === pageSize || scanned === scanBudget) {
            return finish({ hasMore: index + 1 < batch.length })
          }
        }
        if (batch.length <= count) {
          return finish({ hasMore: false })
        }
      }
      return finish({ hasMore: true })
    },
  })
}

function matches({ item, keyword }: { item: PublicTemplate; keyword: string }) {
  return (
    !keyword ||
    [
      item.displayConfig.name,
      ...item.displayConfig.tags.map(({ name }) => name),
      ...item.displayConfig.searchAliases,
    ].some((text) => text.toLowerCase().includes(keyword))
  )
}
function record({
  keys,
  value,
}: {
  keys: readonly string[]
  value: unknown
}): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new CatalogError({ code: 'INPUT_INVALID' })
  }
  return value as Record<string, unknown>
}
function assertInteger({
  maximum = Number.MAX_SAFE_INTEGER,
  minimum,
  value,
}: {
  maximum?: number
  minimum: number
  value: unknown
}): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new CatalogError({ code: 'INPUT_INVALID' })
  }
  return value
}
function keyword({ value }: { value: unknown }): string {
  if (typeof value !== 'string' || value.length > 200) {
    throw new CatalogError({ code: 'INPUT_INVALID' })
  }
  return value.trim().toLowerCase()
}
function encodeCursor({
  after,
  filters,
  key,
  policyId,
}: {
  after: CatalogPosition
  filters: Filters
  key: Buffer
  policyId: string
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      id: after.id,
      categoryId: filters.categoryId,
      keyword: filters.keyword,
      policyId,
      purpose: 'effect-catalog-v1',
      sortOrder: after.sortOrder,
    }),
  ).toString('base64url')
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`
}
function decodeCursor({
  filters,
  key,
  policyId,
  value,
}: {
  filters: Filters
  key: Buffer
  policyId: string
  value: unknown
}): CatalogPosition {
  try {
    if (typeof value !== 'string' || value.length > 4096 || !/^[\w-]+\.[\w-]{43}$/.test(value)) {
      throw new Error()
    }
    const [payload, signature] = value.split('.') as [string, string]
    const bytes = Buffer.from(payload, 'base64url')
    const mac = Buffer.from(signature, 'base64url')
    if (
      bytes.length > 2048 ||
      bytes.toString('base64url') !== payload ||
      mac.toString('base64url') !== signature ||
      !timingSafeEqual(mac, createHmac('sha256', key).update(payload).digest())
    ) {
      throw new Error()
    }
    const doc = record({
      keys: ['purpose', 'categoryId', 'keyword', 'policyId', 'sortOrder', 'id'],
      value: JSON.parse(bytes.toString('utf8')),
    })
    if (Buffer.from(JSON.stringify(doc)).toString('base64url') !== payload) {
      throw new Error()
    }
    if (
      Object.keys(doc).length !== 6 ||
      doc.purpose !== 'effect-catalog-v1' ||
      doc.categoryId !== filters.categoryId ||
      doc.keyword !== filters.keyword ||
      doc.policyId !== policyId
    ) {
      throw new Error()
    }
    return {
      id: assertInteger({ minimum: 1, value: doc.id }),
      sortOrder: assertInteger({ minimum: Number.MIN_SAFE_INTEGER, value: doc.sortOrder }),
    }
  } catch {
    throw new CatalogError({ code: 'INPUT_INVALID' })
  }
}
