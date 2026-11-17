import type { CreationInput, CreationMode, TaskClientInput } from './input.js'
import type { LegacyOutputComposition } from './legacy-output-composition.js'

import { normalizeCreationInput, normalizeTaskClientInput } from './input.js'
import { parseLegacyOutputComposition } from './legacy-output-composition.js'

export type GenerationCode =
  | 'CREDITS_INSUFFICIENT'
  | 'DATA_INTEGRITY_CONFLICT'
  | 'GENERATION_IN_PROGRESS'
  | 'GENERATION_NOT_CONFIGURED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INPUT_INVALID'
  | 'NOT_FOUND'
  | 'QUOTE_CHANGED'
  | 'QUOTE_EXPIRED'
  | 'TEMPLATE_UNAVAILABLE'
  | 'UNAUTHENTICATED'
class LocalGenerationError extends Error {
  readonly code: GenerationCode
  readonly status: number
  constructor({ code }: { code: GenerationCode }) {
    super(`Generation operation failed: ${code}.`)
    this.name = 'GenerationError'
    this.code = code
    this.status =
      code === 'INPUT_INVALID'
        ? 400
        : code === 'UNAUTHENTICATED'
          ? 401
          : code === 'NOT_FOUND'
            ? 404
            : code === 'CREDITS_INSUFFICIENT'
              ? 402
              : ['DATA_INTEGRITY_CONFLICT', 'GENERATION_NOT_CONFIGURED'].includes(code)
                ? 503
                : 409
  }
}
// Share the constructor across Next's independently compiled server entry points.
const generationErrorKey = Symbol.for('heymoro.error.generation.v1')
const errorRegistry = globalThis as {
  [generationErrorKey]?: typeof LocalGenerationError
} & typeof globalThis
export const GenerationError = errorRegistry[generationErrorKey] ?? LocalGenerationError
export type GenerationError = LocalGenerationError
if (!Object.hasOwn(errorRegistry, generationErrorKey)) {
  Object.defineProperty(errorRegistry, generationErrorKey, { value: GenerationError })
}
export type StorageOutput = Readonly<{
  backend: string
  bucket: string
  keyRule: 'task-attempt-result-v1'
}>
export type ParameterRule = Readonly<
  { isRequired?: boolean } & (
    | { isInteger?: boolean; maximum: number; minimum: number; type: 'number' }
    | { type: 'boolean' }
    | { type: 'string'; values: readonly string[] }
  )
>
export type Executor = Readonly<{
  allowedParameters: readonly string[]
  model: string
  parameterRules: Readonly<Record<string, ParameterRule>>
  provider: string
  storageBackends: readonly string[]
}>
export type ExecutionConfiguration = Readonly<{
  registry: Readonly<Record<string, Executor>>
  storageOutput: StorageOutput
}>
export type ExecutionPlan = Readonly<{
  executorId: string
  model: string
  parameters: Readonly<Record<string, boolean | number | string>>
  provider: string
  systemPrompt: string
}>
export type MediaFact = Readonly<{
  mediaId: number
  mimeType: string
  position: number
  sha256: string
  sizeBytes: number
  storageRef: Readonly<{ backend: string; bucket: string; key: string }>
}>
export type ExecutionSnapshot = Readonly<{
  clientInput: TaskClientInput
  executionPlan: ExecutionPlan & Readonly<{ outputComposition?: LegacyOutputComposition }>
  input: CreationInput
  media: readonly MediaFact[]
  mode: CreationMode
  quote: Readonly<{ costCredits: number; issuedAt: string; validUntil: string }>
  schemaVersion: 1
  storageOutput: StorageOutput
  templateId: number
  /** Read-only legacy evidence; never added to newly accepted task snapshots. */
  templateVersionId?: number
}>
export type TaskDTO = Readonly<{
  clientRequestId: string
  costCredits: number
  errorCode: null | string
  id: number
  input: CreationInput
  roundNo: number
  sessionId: number
  sourceTaskId: null | number
  status: string
  templateId: number
}>
export type SubmissionResult = Readonly<{ isNew: boolean; task: TaskDTO }>

export function compileExecution({
  execution,
  generationConfigJson,
}: {
  execution: ExecutionConfiguration | null
  generationConfigJson: string
}): { executionPlan: ExecutionPlan; storageOutput: StorageOutput } {
  if (!execution) {
    throw new GenerationError({ code: 'GENERATION_NOT_CONFIGURED' })
  }
  try {
    const config = object({ value: JSON.parse(generationConfigJson) })
    closed({ fields: ['executorId', 'systemPrompt', 'parameters'], value: config })
    const executorId = nonblank({ value: config.executorId })
    const executor = execution.registry[executorId]
    if (!executor) {
      throw new Error()
    }
    const parameters = object({ value: config.parameters })
    for (const [key, value] of Object.entries(parameters)) {
      if (!executor.allowedParameters.includes(key) || !isParameter({ value })) {
        throw new Error()
      }
    }
    const systemPrompt = text({ value: config.systemPrompt })
    if (!systemPrompt.trim()) {
      throw new Error()
    }
    const executionPlan = {
      executorId,
      model: nonblank({ value: executor.model }),
      parameters: { ...parameters } as ExecutionPlan['parameters'],
      provider: nonblank({ value: executor.provider }),
      systemPrompt,
    }
    assertExecutionSupported({ execution, executionPlan, storageOutput: execution.storageOutput })
    return { executionPlan, storageOutput: { ...execution.storageOutput } }
  } catch {
    throw new GenerationError({ code: 'GENERATION_NOT_CONFIGURED' })
  }
}
export function assertExecutionSupported({
  execution,
  executionPlan,
  storageOutput,
}: {
  execution: ExecutionConfiguration | null
  executionPlan: ExecutionPlan
  storageOutput: StorageOutput
}) {
  try {
    const plan = object({ value: executionPlan })
    closed({
      fields: ['executorId', 'provider', 'model', 'systemPrompt', 'parameters'],
      value: plan,
    })
    object({ value: plan.parameters })
    const executor = execution?.registry[executionPlan.executorId]
    if (
      !executor ||
      executor.provider !== executionPlan.provider ||
      executor.model !== executionPlan.model ||
      !executor.storageBackends.includes(storageOutput.backend) ||
      !validStoragePart({ value: storageOutput.backend }) ||
      !validStoragePart({ value: storageOutput.bucket }) ||
      storageOutput.keyRule !== 'task-attempt-result-v1' ||
      typeof executionPlan.systemPrompt !== 'string' ||
      !executionPlan.systemPrompt.trim() ||
      !validParameters({ executor, parameters: executionPlan.parameters })
    ) {
      throw new Error()
    }
  } catch {
    // Live unsupported plans are provably not sent; malformed persisted JSON remains an integrity error.
    throw new GenerationError({ code: 'GENERATION_NOT_CONFIGURED' })
  }
}

export function parseSnapshot({ json }: { json: unknown }): ExecutionSnapshot {
  try {
    const doc = object({ value: JSON.parse(text({ value: json })) })
    closed({
      fields: [
        'schemaVersion',
        'clientInput',
        'input',
        'mode',
        'templateId',
        ...(Object.hasOwn(doc, 'templateVersionId') ? ['templateVersionId'] : []),
        'executionPlan',
        'media',
        'storageOutput',
        'quote',
      ],
      value: doc,
    })
    if (
      doc.schemaVersion !== 1 ||
      (doc.mode !== 'effect' && doc.mode !== 'free') ||
      !Array.isArray(doc.media)
    ) {
      throw new Error()
    }
    if (Object.hasOwn(doc, 'templateVersionId')) {
      integer({ value: doc.templateVersionId })
    }
    const clientInput = normalizeTaskClientInput({ value: doc.clientInput })
    const input = normalizeCreationInput({ value: doc.input })
    const plan = object({ value: doc.executionPlan })
    const hasComposition = Object.hasOwn(plan, 'outputComposition')
    closed({
      fields: [
        'executorId',
        'provider',
        'model',
        'systemPrompt',
        'parameters',
        ...(hasComposition ? ['outputComposition'] : []),
      ],
      value: plan,
    })
    const parameters = object({ value: plan.parameters })
    if (Object.values(parameters).some((value) => !isParameter({ value }))) {
      throw new Error()
    }
    const output = object({ value: doc.storageOutput })
    closed({ fields: ['backend', 'bucket', 'keyRule'], value: output })
    if (
      output.keyRule !== 'task-attempt-result-v1' ||
      !validStoragePart({ value: output.backend }) ||
      !validStoragePart({ value: output.bucket })
    ) {
      throw new Error()
    }
    const media = doc.media.map((value, index): MediaFact => {
      const fact = object({ value })
      closed({
        fields: ['mediaId', 'position', 'sha256', 'mimeType', 'sizeBytes', 'storageRef'],
        value: fact,
      })
      const storage = object({ value: fact.storageRef })
      closed({ fields: ['backend', 'bucket', 'key'], value: storage })
      if (
        !validStoragePart({ value: storage.backend }) ||
        !validStoragePart({ value: storage.bucket }) ||
        !validStorageKey({ value: storage.key }) ||
        !/^[a-f0-9]{64}$/.test(text({ value: fact.sha256 })) ||
        fact.position !== index + 1 ||
        fact.mediaId !== input.inputMediaIds[index]
      ) {
        throw new Error()
      }
      return {
        mediaId: integer({ value: fact.mediaId }),
        mimeType: nonblank({ value: fact.mimeType }),
        position: index + 1,
        sha256: text({ value: fact.sha256 }),
        sizeBytes: integer({ value: fact.sizeBytes }),
        storageRef: {
          backend: text({ value: storage.backend }),
          bucket: text({ value: storage.bucket }),
          key: text({ value: storage.key }),
        },
      }
    })
    if (
      media.length !== input.inputMediaIds.length ||
      (clientInput.operation === 'generate' &&
        JSON.stringify(clientInput.input) !== JSON.stringify(input))
    ) {
      throw new Error()
    }
    const quote = object({ value: doc.quote })
    closed({ fields: ['costCredits', 'issuedAt', 'validUntil'], value: quote })
    const issuedAt = generationTime({ now: text({ value: quote.issuedAt }) })
    const validUntil = generationTime({ now: text({ value: quote.validUntil }) })
    if (issuedAt >= validUntil) {
      throw new Error()
    }
    return {
      clientInput,
      executionPlan: {
        executorId: nonblank({ value: plan.executorId }),
        model: nonblank({ value: plan.model }),
        parameters: parameters as ExecutionPlan['parameters'],
        provider: nonblank({ value: plan.provider }),
        systemPrompt: nonblank({ value: plan.systemPrompt }),
        ...(hasComposition
          ? { outputComposition: parseLegacyOutputComposition({ value: plan.outputComposition }) }
          : {}),
      },
      input,
      media,
      mode: doc.mode,
      quote: {
        costCredits: integer({ minimum: 0, value: quote.costCredits }),
        issuedAt,
        validUntil,
      },
      schemaVersion: 1,
      storageOutput: {
        backend: text({ value: output.backend }),
        bucket: text({ value: output.bucket }),
        keyRule: output.keyRule,
      },
      templateId: integer({ value: doc.templateId }),
      ...(Object.hasOwn(doc, 'templateVersionId')
        ? { templateVersionId: integer({ value: doc.templateVersionId }) }
        : {}),
    }
  } catch {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
}
export function integer({ minimum = 1, value }: { minimum?: number; value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
  return value
}
export function text({ value }: { value: unknown }): string {
  if (typeof value !== 'string') {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
  return value
}
export function nonblank({ value }: { value: unknown }): string {
  const result = text({ value })
  if (!result.trim()) {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
  return result
}
export function object({ value }: { value: unknown }): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  ) {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
  return value as Record<string, unknown>
}
export function closed({
  fields,
  value,
}: {
  fields: readonly string[]
  value: Record<string, unknown>
}) {
  if (
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key))
  ) {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
}
export function generationTime({ now }: { now: string }) {
  if (
    typeof now !== 'string' ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  ) {
    throw new Error('Generation clock must return UTC milliseconds.')
  }
  return now
}
export function validStoragePart({ value }: { value: unknown }): boolean {
  return (
    typeof value === 'string' && /^[a-z0-9][\w.-]{0,127}$/i.test(value) && !value.includes('..')
  )
}
export function validStorageKey({ value }: { value: unknown }): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\\?#:]/.test(value) &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
    ) &&
    !value.startsWith('/') &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
}
function isParameter({ value }: { value: unknown }): boolean {
  return (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= 1000)
  )
}

function validParameters({
  executor,
  parameters,
}: {
  executor: Executor
  parameters: ExecutionPlan['parameters']
}) {
  if (
    !executor.parameterRules ||
    Object.entries(executor.parameterRules).some(
      ([key, rule]) => rule.isRequired && !Object.hasOwn(parameters, key),
    )
  ) {
    return false
  }
  return Object.entries(parameters).every(([key, value]) => {
    if (!executor.allowedParameters.includes(key)) {
      return false
    }
    const rule = executor.parameterRules[key]
    if (!rule) {
      return false
    }
    if (rule.type === 'boolean') {
      return typeof value === 'boolean'
    }
    if (rule.type === 'string') {
      return typeof value === 'string' && rule.values.includes(value)
    }
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      Number.isFinite(rule.minimum) &&
      Number.isFinite(rule.maximum) &&
      rule.minimum <= rule.maximum &&
      value >= rule.minimum &&
      value <= rule.maximum &&
      (!rule.isInteger || Number.isSafeInteger(value))
    )
  })
}

/** Concrete immutable result paths are derived only when both task and attempt IDs exist. */
export function generationResultKey({
  attemptId,
  keyRule,
  sha256,
  taskId,
}: {
  attemptId: number
  keyRule: StorageOutput['keyRule']
  sha256: string
  taskId: number
}) {
  integer({ value: taskId })
  integer({ value: attemptId })
  if (keyRule !== 'task-attempt-result-v1' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
  return `tasks/${taskId}/attempts/${attemptId}/result-${sha256}`
}
