import { normalizeSessionTitle } from './session-title.js'

export type TemplateKind = 'effect' | 'free'
export type InputSchema = Readonly<{
  allowedMimeTypes: readonly string[]
  maxDescriptionLength: number
  maxImageBytes: number
  maxImages: number
  maxNotesLength: number
  maxTotalImageBytes: number
  minImages: number
}>
export type DisplayConfig = Readonly<{
  categoryId: null | number
  categoryName: null | string
  coverMediaId: null | number
  description: string
  name: string
  photoHint: string
  primaryTagId: null | number
  searchAliases: readonly string[]
  showcaseShareKeys: readonly string[]
  tagIds: readonly number[]
  tags: readonly Readonly<{ id: number; name: string }>[]
}>
export type PublicTemplateConfig = Readonly<{
  displayConfig: DisplayConfig
  inputSchema: InputSchema
}>

export class CatalogError extends Error {
  readonly code: 'DATA_INTEGRITY_CONFLICT' | 'INPUT_INVALID' | 'TEMPLATE_UNAVAILABLE'
  readonly status: 400 | 409 | 503

  constructor({ code }: { code: CatalogError['code'] }) {
    super(
      code === 'INPUT_INVALID'
        ? 'Invalid catalog input.'
        : code === 'TEMPLATE_UNAVAILABLE'
          ? 'Template is unavailable.'
          : 'Catalog data integrity conflict.',
    )
    this.name = 'CatalogError'
    this.code = code
    this.status = code === 'INPUT_INVALID' ? 400 : code === 'TEMPLATE_UNAVAILABLE' ? 409 : 503
  }
}

/** Published presentation is data, never instructions; copy every public field before freezing. */
export function parsePublicTemplateConfig({
  displayConfigJson,
  hostCaps,
  inputSchemaJson,
  kind,
  schemaVersion,
}: {
  displayConfigJson: string
  hostCaps: InputSchema
  inputSchemaJson: string
  kind: TemplateKind
  schemaVersion: number
}): PublicTemplateConfig {
  try {
    if (schemaVersion !== 1) {
      throw new Error()
    }
    const caps = validateHostCaps({ hostCaps })
    const displayConfig = readDisplay({ kind, value: parseJSON({ value: displayConfigJson }) })
    const configured = readInput({ value: parseJSON({ value: inputSchemaJson }) })
    assertMode({ input: configured, kind })
    const inputSchema = {
      allowedMimeTypes: configured.allowedMimeTypes.filter((mime) =>
        caps.allowedMimeTypes.includes(mime),
      ),
      maxDescriptionLength: Math.min(configured.maxDescriptionLength, caps.maxDescriptionLength),
      maxImageBytes: Math.min(configured.maxImageBytes, caps.maxImageBytes),
      maxImages: Math.min(configured.maxImages, caps.maxImages),
      maxNotesLength: Math.min(configured.maxNotesLength, caps.maxNotesLength),
      maxTotalImageBytes: Math.min(configured.maxTotalImageBytes, caps.maxTotalImageBytes),
      minImages: Math.max(configured.minImages, caps.minImages),
    }
    readInput({ value: inputSchema })
    assertMode({ input: inputSchema, kind })
    return freezeCatalogValue({ value: { displayConfig, inputSchema } })
  } catch {
    throw new CatalogError({ code: 'TEMPLATE_UNAVAILABLE' })
  }
}

export function validateHostCaps({ hostCaps }: { hostCaps: unknown }): InputSchema {
  return freezeCatalogValue({ value: readInput({ value: hostCaps }) })
}

export function freezeCatalogValue<T>({ value }: { value: T }): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freezeCatalogValue({ value: child })
    }
    Object.freeze(value)
  }
  return value
}

function readDisplay({
  kind: _kind,
  value,
}: {
  kind: TemplateKind
  value: unknown
}): DisplayConfig {
  const doc = object({
    keys: [
      'name',
      'description',
      'photoHint',
      'coverMediaId',
      'examples', // Retained data may contain the retired gallery; never project it publicly.
      'showcaseShareKeys',
      'categoryId',
      'categoryName',
      'tagIds',
      'tags',
      'primaryTagId',
      'searchAliases',
    ],
    value,
  })
  const categoryId =
    doc.categoryId === undefined || doc.categoryId === null
      ? null
      : integer({ minimum: 1, value: doc.categoryId })
  const categoryName =
    doc.categoryName === undefined || doc.categoryName === null
      ? null
      : nonblank({ value: doc.categoryName })
  if ((categoryId === null) !== (categoryName === null)) {
    throw new Error()
  }
  const tagIds = idList({ value: doc.tagIds === undefined ? [] : doc.tagIds })
  const tags = array({ value: doc.tags === undefined ? [] : doc.tags }).map((value) => {
    const tag = object({ keys: ['id', 'name'], value })
    return { id: integer({ minimum: 1, value: tag.id }), name: nonblank({ value: tag.name }) }
  })
  if (tags.length !== tagIds.length || tags.some((tag, index) => tag.id !== tagIds[index])) {
    throw new Error()
  }
  const primaryTagId =
    doc.primaryTagId === undefined || doc.primaryTagId === null
      ? null
      : integer({ minimum: 1, value: doc.primaryTagId })
  if (primaryTagId !== null && !tagIds.includes(primaryTagId)) {
    throw new Error()
  }
  const showcaseShareKeys = array({ value: doc.showcaseShareKeys ?? [] }).map((value) => {
    if (typeof value !== 'string' || !/^[\w-]{32}$/.test(value)) {
      throw new Error()
    }
    return value
  })
  if (
    showcaseShareKeys.length > 8 ||
    new Set(showcaseShareKeys).size !== showcaseShareKeys.length
  ) {
    throw new Error()
  }
  const coverMediaId =
    doc.coverMediaId === undefined || doc.coverMediaId === null
      ? null
      : integer({ minimum: 1, value: doc.coverMediaId })
  return {
    name: normalizeSessionTitle({ value: doc.name }),
    categoryId,
    categoryName,
    coverMediaId,
    description: string({ value: doc.description === undefined ? '' : doc.description }),
    photoHint: string({ value: doc.photoHint === undefined ? '' : doc.photoHint }),
    primaryTagId,
    searchAliases: array({ value: doc.searchAliases === undefined ? [] : doc.searchAliases }).map(
      (value) => string({ value }),
    ),
    showcaseShareKeys,
    tagIds,
    tags,
  }
}

function readInput({ value }: { value: unknown }): InputSchema {
  const doc = object({
    keys: [
      'minImages',
      'maxImages',
      'allowedMimeTypes',
      'maxImageBytes',
      'maxTotalImageBytes',
      'maxDescriptionLength',
      'maxNotesLength',
    ],
    value,
  })
  const minImages = integer({ minimum: 0, value: doc.minImages })
  const maxImages = integer({ minimum: 0, value: doc.maxImages })
  if (minImages > maxImages) {
    throw new Error()
  }
  const allowedMimeTypes = array({ value: doc.allowedMimeTypes }).map((value) => {
    const mime = string({ value })
    if (!/^image\/[a-z0-9][a-z0-9.+-]*$/.test(mime)) {
      throw new Error()
    }
    return mime
  })
  if (!allowedMimeTypes.length || new Set(allowedMimeTypes).size !== allowedMimeTypes.length) {
    throw new Error()
  }
  return {
    allowedMimeTypes,
    maxDescriptionLength: integer({ minimum: 0, value: doc.maxDescriptionLength }),
    maxImageBytes: integer({ minimum: 1, value: doc.maxImageBytes }),
    maxImages,
    maxNotesLength: integer({ minimum: 0, value: doc.maxNotesLength }),
    maxTotalImageBytes: integer({ minimum: 1, value: doc.maxTotalImageBytes }),
    minImages,
  }
}

function assertMode({ input, kind }: { input: InputSchema; kind: TemplateKind }) {
  if (
    kind === 'effect'
      ? input.minImages < 1 || input.maxDescriptionLength !== 0
      : input.minImages !== 0 || input.maxNotesLength !== 0 || input.maxDescriptionLength <= 0
  ) {
    throw new Error()
  }
}
function object({
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
    throw new Error()
  }
  return value as Record<string, unknown>
}
function array({ value }: { value: unknown }): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error()
  }
  return value
}
function idList({ value }: { value: unknown }): number[] {
  const ids = array({ value }).map((value) => integer({ minimum: 1, value }))
  if (new Set(ids).size !== ids.length) {
    throw new Error()
  }
  return ids
}
function integer({ minimum, value }: { minimum: number; value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error()
  }
  return value
}
function string({ value }: { value: unknown }): string {
  if (typeof value !== 'string') {
    throw new Error()
  }
  return value
}
function nonblank({ value }: { value: unknown }): string {
  const text = string({ value })
  if (!text.trim()) {
    throw new Error()
  }
  return text
}
function parseJSON({ value }: { value: string }): unknown {
  if (typeof value !== 'string' || value.length > 131072) {
    throw new Error()
  }
  return JSON.parse(value)
}
