import type {
  CurrentTemplateBody,
  CurrentTemplateRecord,
} from '../creation/application/current-template.js'
import type { ManagementOptionsDTO } from '../creation/application/template-management.js'
import type { TaxonomyTerm } from '../creation/application/template-taxonomy.js'
import type { ParameterRule } from '../creation/domain/generation.js'
import type { DisplayConfig, InputSchema } from '../creation/domain/template-config.js'
export type { ManagementOptionsDTO, TaxonomyTerm }
export type EditorDTO = { body: CurrentTemplateBody; template: CurrentTemplateRecord }
export type TemplatePage = {
  items: readonly Pick<
    CurrentTemplateRecord,
    'code' | 'costCredits' | 'id' | 'kind' | 'name' | 'status'
  >[]
  nextAfterId: null | number
}
export type TermPage = { items: readonly TaxonomyTerm[]; nextAfterId: null | number }
export type Section<T> =
  | { kind: 'editable'; original: string; raw: string; value: T }
  | { kind: 'repairRequired'; raw: string; reason: string }
export type GenerationFields = {
  executorId: string
  parameters: Record<string, boolean | number | string>
  systemPrompt: string
}
export type DraftInputSchema = {
  [Key in keyof InputSchema]: InputSchema[Key] extends number ? '' | number : InputSchema[Key]
}
export type Form = {
  costCredits: number | string
  display: Section<DisplayConfig>
  generation: Section<GenerationFields>
  input: Section<DraftInputSchema>
  minClientCapability: string
  schemaVersion: number
  share: Section<Record<string, never>>
}
export type Failure = {
  code: string
  message: string
  outcome: 'not_started' | 'unknown'
  retryable: false
  status: number
}
export type ActionResult<T> =
  | {
      confirmed?: { templateId?: number; termId?: number }
      error: Failure
      ok: false
    }
  | { data: T; ok: true; outcome: 'confirmed' | 'read' }

/** A confirmed create receipt can recover its row even if the following read failed. */
export function confirmedTemplateTarget({
  confirmed,
  currentId,
}: {
  confirmed?: { templateId?: number }
  currentId: number
}): null | number {
  if (Number.isSafeInteger(currentId) && currentId > 0) {
    return currentId
  }
  const id = confirmed?.templateId
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null
}

export function templateTagOptions({
  selected,
  terms,
}: {
  selected: readonly { id: number; name: string }[]
  terms: readonly TaxonomyTerm[]
}): readonly TaxonomyTerm[] {
  const options = new Map(
    terms
      .filter((term) => term.kind === 'label' && term.status === 'active')
      .map((term) => [term.id, term]),
  )
  for (const tag of selected) {
    if (!options.has(tag.id)) {
      options.set(tag.id, {
        id: tag.id,
        name: tag.name,
        code: '',
        kind: 'label',
        sortOrder: 0,
        status: 'hidden',
      })
    }
  }
  return [...options.values()]
}

export function decodeBody({
  body,
  options,
}: {
  body: CurrentTemplateBody
  options: ManagementOptionsDTO
}): Form {
  return {
    costCredits: body.costCredits,
    display: section({
      normalize: normalizeDisplayDraft,
      raw: body.displayConfigJson,
      validate: (value) => body.schemaVersion === 1 && displayValid(value),
    }),
    generation: section({
      raw: body.generationConfigJson,
      validate: (value) => body.schemaVersion === 1 && generationValid({ options, value }),
    }),
    input: section({
      raw: body.inputSchemaJson,
      validate: (value) => body.schemaVersion === 1 && inputValid(value),
    }),
    minClientCapability: body.minClientCapability,
    schemaVersion: body.schemaVersion,
    share: section({
      raw: body.shareConfigJson,
      validate: (value) =>
        body.schemaVersion === 1 && isRecord(value) && Object.keys(value).length === 0,
    }),
  }
}
export function encodeBody({ form }: { form: Form }): CurrentTemplateBody {
  if (!Number.isSafeInteger(form.costCredits) || Number(form.costCredits) < 0) {
    throw Error('积分须为非负整数')
  }
  return {
    costCredits: Number(form.costCredits),
    displayConfigJson: serialize({ section: form.display }),
    generationConfigJson: serialize({ section: form.generation }),
    inputSchemaJson: serialize({ section: form.input }),
    minClientCapability: form.minClientCapability,
    schemaVersion: form.schemaVersion,
    shareConfigJson: serialize({ section: form.share }),
  }
}
export function parameterValue({
  rule,
  text,
}: {
  rule: ParameterRule
  text: string
}): boolean | number | string | undefined {
  if (text === '') {
    if (rule.isRequired) {
      throw Error('必填参数尚未设置')
    }
    return undefined
  }
  if (rule.type === 'boolean') {
    if (!['false', 'true'].includes(text)) {
      throw Error('请选择是或否')
    }
    return text === 'true'
  }
  if (rule.type === 'string') {
    if (!rule.values.includes(text)) {
      throw Error('请选择支持的参数值')
    }
    return text
  }
  if (text.trim() === '') {
    throw Error('数值尚未设置')
  }
  const value = Number(text)
  if (
    !Number.isFinite(value) ||
    value < rule.minimum ||
    value > rule.maximum ||
    (rule.isInteger && !Number.isSafeInteger(value))
  ) {
    throw Error('数值超出参数规则')
  }
  return value
}
export function blankBody({
  kind,
  options,
}: {
  kind: 'effect' | 'free'
  options: ManagementOptionsDTO
}): CurrentTemplateBody {
  return {
    costCredits: 0,
    displayConfigJson: JSON.stringify({
      name: '',
      categoryId: null,
      categoryName: null,
      coverMediaId: null,
      description: '',
      photoHint: '',
      primaryTagId: null,
      searchAliases: [],
      showcaseShareKeys: [],
      tagIds: [],
      tags: [],
    }),
    generationConfigJson: JSON.stringify({
      executorId: options.executors[0]?.executorId ?? '',
      parameters: Object.fromEntries(
        Object.entries(options.executors[0]?.parameterRules ?? {}).flatMap(([name, rule]) =>
          rule.isRequired && rule.type === 'string' && rule.values.length
            ? [[name, rule.values[0]!]]
            : [],
        ),
      ),
      systemPrompt: '',
    }),
    inputSchemaJson: JSON.stringify({
      ...options.hostCaps,
      maxDescriptionLength: kind === 'effect' ? 0 : options.hostCaps.maxDescriptionLength,
      maxNotesLength: kind === 'free' ? 0 : options.hostCaps.maxNotesLength,
      minImages: kind === 'free' ? 0 : Math.max(1, options.hostCaps.minImages),
    }),
    minClientCapability: options.acceptedCapabilities[0] ?? '',
    schemaVersion: 1,
    shareConfigJson: '{}',
  }
}
export function rebuildSection({
  form,
  group,
  kind,
  options,
}: {
  form: Form
  group: 'display' | 'generation' | 'input' | 'share'
  kind: 'effect' | 'free'
  options: ManagementOptionsDTO
}): Form {
  const fresh = decodeBody({ body: blankBody({ kind, options }), options })
  // A blank generation group needs editable controls even when its host executor is unavailable.
  if (group === 'generation') {
    fresh.generation = editable({
      raw: blankBody({ kind, options }).generationConfigJson,
      value: {
        executorId: options.executors[0]?.executorId ?? '',
        parameters: {},
        systemPrompt: '',
      },
    })
  }
  return { ...form, [group]: fresh[group], schemaVersion: 1 }
}
export function assertDraftMetadata({
  acceptedCapabilities,
  input,
}: {
  acceptedCapabilities: readonly string[]
  input: Record<string, unknown>
}) {
  if (
    input.schemaVersion !== 1 ||
    typeof input.minClientCapability !== 'string' ||
    !acceptedCapabilities.includes(input.minClientCapability)
  ) {
    throw Error('请选择当前schema1与宿主支持的客户端能力。')
  }
}
export function bodiesEqual({
  left,
  right,
}: {
  left: CurrentTemplateBody | undefined
  right: CurrentTemplateBody
}) {
  return Boolean(
    left &&
    Object.keys(right).every(
      (key) => left[key as keyof CurrentTemplateBody] === right[key as keyof CurrentTemplateBody],
    ),
  )
}
export function serializeCommand({ input }: { input: Record<string, unknown> }): string {
  for (const key of [
    'displayConfigJson',
    'inputSchemaJson',
    'generationConfigJson',
    'shareConfigJson',
  ]) {
    if (typeof input[key] === 'string' && new TextEncoder().encode(input[key]).length > 131072) {
      throw Error(`${key}超过128KiB限制`)
    }
  }
  const serialized = JSON.stringify(input)
  if (
    new TextEncoder().encode(serialized).length > 768 * 1024 ||
    new TextEncoder().encode(JSON.stringify(serialized)).length > 900 * 1024
  ) {
    throw Error('表单命令超过传输预算，请缩短配置文字。')
  }
  return serialized
}
export function safeFailure({ code, family }: { code: string; family: string }): Failure {
  const common: Record<string, number> = {
    DATA_INTEGRITY_CONFLICT: 503,
    INPUT_INVALID: 400,
    NOT_FOUND: 404,
    UNAUTHENTICATED: 401,
  }
  const families: Record<string, Record<string, number>> = {
    admin: { ADMIN_FORBIDDEN: 403, ADMIN_UNAUTHORIZED: 401 },
    catalog: { DATA_INTEGRITY_CONFLICT: 503, INPUT_INVALID: 400, TEMPLATE_UNAVAILABLE: 409 },
    coordination: { COORDINATION_UNAVAILABLE: 503, RESOURCE_BUSY: 409 },
    generation: { ...common, GENERATION_NOT_CONFIGURED: 503, TEMPLATE_UNAVAILABLE: 409 },
    media: { ...common, INVALID_MEDIA: 400 },
    publication: { ...common, PUBLICATION_CONFLICT: 409 },
    storage: {
      CONTENT_CONFLICT: 503,
      FORBIDDEN: 503,
      INVALID_REF: 503,
      NOT_FOUND: 404,
      UNKNOWN: 503,
      UNSAFE_BACKEND: 503,
      UNVERIFIED_BACKEND: 503,
    },
    transaction: { OPERATION_OUTCOME_UNKNOWN: 503 },
  }
  const entries = Object.hasOwn(families, family) ? families[family] : undefined
  const status = entries && Object.hasOwn(entries, code) ? entries[code] : undefined
  const messages: Record<number, string> = {
    400: '输入格式有误，请检查字段。',
    401: '登录已失效，输入仍保留，请重新登录后核对。',
    403: '当前账号没有管理权限，输入仍保留。',
    404: '记录或官方图片不存在，请只读核对。',
    409: '服务器事实已变化，请核对服务器版本；本地输入仍保留。',
    503: '服务暂不可用，输入仍保留，请先只读核对状态。',
  }
  return {
    code: status ? code : 'SERVICE_UNAVAILABLE',
    message:
      family === 'catalog' && code === 'TEMPLATE_UNAVAILABLE'
        ? '已保存配置不满足发布要求，请修复展示或输入组后再检查。'
        : family === 'generation' && code === 'GENERATION_NOT_CONFIGURED'
          ? '当前执行器／生成配置不可用，请检查当前executor和参数或联系宿主配置。'
          : family === 'transaction' && status
            ? '写入结果未知，请先只读核对；不要重复提交。'
            : messages[status ?? 503]!,
    outcome: family === 'transaction' && status ? 'unknown' : 'not_started',
    retryable: false,
    status: status ?? 503,
  }
}
function section<T>({
  normalize,
  raw,
  validate,
}: {
  normalize?: (value: unknown) => unknown
  raw: string
  validate: (value: unknown) => boolean
}): Section<T> {
  try {
    const parsed: unknown = JSON.parse(raw)
    const value = normalize ? normalize(parsed) : parsed
    if (!validate(value)) {
      throw Error()
    }
    return editable({ raw, value: value as T })
  } catch {
    return {
      kind: 'repairRequired',
      raw,
      reason: '空缺、损坏或含当前表单未支持的字段；原文已保留。',
    }
  }
}
function editable<T>({ raw, value }: { raw: string; value: T }): Section<T> {
  return { kind: 'editable', original: JSON.stringify(value), raw, value }
}
function serialize<T>({ section }: { section: Section<T> }) {
  return section.kind === 'repairRequired' || JSON.stringify(section.value) === section.original
    ? section.raw
    : JSON.stringify(section.value)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}
function positive(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
// Published configs may omit optional display fields. Preserve raw bytes and reject unknown keys.
function normalizeDisplayDraft(value: unknown) {
  if (!isRecord(value)) {
    return value
  }
  const { examples: _retiredExamples, ...current } = value
  return {
    categoryId: null,
    categoryName: null,
    coverMediaId: null,
    description: '',
    photoHint: '',
    primaryTagId: null,
    searchAliases: [],
    showcaseShareKeys: [],
    tagIds: [],
    tags: [],
    ...current,
  }
}
function displayValid(value: unknown) {
  if (
    !exact(value, [
      'name',
      'description',
      'photoHint',
      'categoryId',
      'categoryName',
      'coverMediaId',
      'showcaseShareKeys',
      'tagIds',
      'tags',
      'primaryTagId',
      'searchAliases',
    ])
  ) {
    return false
  }
  return (
    ['name', 'description', 'photoHint'].every((key) => typeof value[key] === 'string') &&
    ['categoryId', 'coverMediaId', 'primaryTagId'].every(
      (key) => value[key] === null || positive(value[key]),
    ) &&
    (value.categoryName === null || typeof value.categoryName === 'string') &&
    Array.isArray(value.searchAliases) &&
    value.searchAliases.every((item) => typeof item === 'string') &&
    Array.isArray(value.tagIds) &&
    value.tagIds.every(positive) &&
    Array.isArray(value.tags) &&
    value.tags.every(
      (item) => exact(item, ['id', 'name']) && positive(item.id) && typeof item.name === 'string',
    ) &&
    Array.isArray(value.showcaseShareKeys) &&
    value.showcaseShareKeys.length <= 8 &&
    new Set(value.showcaseShareKeys).size === value.showcaseShareKeys.length &&
    value.showcaseShareKeys.every((key) => typeof key === 'string' && /^[\w-]{32}$/.test(key))
  )
}
// Draft shape checks preserve every numeric input the controls can represent; publication validates its domain constraints.
function inputValid(value: unknown) {
  return (
    exact(value, [
      'minImages',
      'maxImages',
      'allowedMimeTypes',
      'maxImageBytes',
      'maxTotalImageBytes',
      'maxDescriptionLength',
      'maxNotesLength',
    ]) &&
    Object.entries(value).every(([key, item]) =>
      key === 'allowedMimeTypes'
        ? Array.isArray(item) && item.every((mime) => typeof mime === 'string')
        : item === '' || (typeof item === 'number' && Number.isFinite(item)),
    )
  )
}
function generationValid({ options, value }: { options: ManagementOptionsDTO; value: unknown }) {
  if (
    !exact(value, ['executorId', 'parameters', 'systemPrompt']) ||
    typeof value.executorId !== 'string' ||
    typeof value.systemPrompt !== 'string' ||
    !isRecord(value.parameters)
  ) {
    return false
  }
  const executor = options.executors.find((item) => item.executorId === value.executorId)
  return Boolean(
    executor &&
    Object.entries(value.parameters).every(([name, item]) => {
      const rule = executor.parameterRules[name]
      if (!executor.allowedParameters.includes(name) || !rule || typeof item !== rule.type) {
        return false
      }
      try {
        return parameterValue({ rule, text: String(item) }) === item
      } catch {
        return false
      }
    }),
  )
}
