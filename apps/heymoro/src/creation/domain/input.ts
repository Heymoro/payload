/* eslint-disable perfectionist/sort-objects -- Insertion order is part of the persisted input and task hash contract. */
import { createHash } from 'node:crypto'

export type CreationInput = Readonly<{
  description: string
  inputMediaIds: readonly number[]
  userNotes: string
}>

export type CreationMode = 'effect' | 'free'
export type CreationStage = 'draft' | 'quote' | 'submit'
export type CreationInputLimits = Readonly<{
  /** String lengths use JavaScript UTF-16 code units; text is never rewritten. */
  maxDescriptionLength: number
  maxImages: number
  maxNotesLength: number
  minImages: number
}>

export type TaskClientInput =
  | Readonly<{ input: CreationInput; operation: 'generate'; sessionId: number }>
  | Readonly<{ operation: 'regenerate'; sessionId: number; sourceArtifactId: number }>

export class CreationInputError extends Error {
  readonly code: 'DESCRIPTION_REQUIRED' | 'INPUT_INVALID'

  constructor({
    code = 'INPUT_INVALID',
    message,
  }: {
    code?: 'DESCRIPTION_REQUIRED' | 'INPUT_INVALID'
    message: string
  }) {
    super(message)
    this.name = 'CreationInputError'
    this.code = code
  }
}

export function normalizeCreationInput({ value }: { value: unknown }): CreationInput {
  if (!hasPlainFields({ value, allowedKeys: ['inputMediaIds', 'description', 'userNotes'] })) {
    throw new CreationInputError({
      message: 'Input must be a JSON object containing only creation fields.',
    })
  }
  const record = value as Record<string, unknown>
  const inputMediaIds = normalizeMediaIds({
    value: Object.hasOwn(record, 'inputMediaIds') ? record.inputMediaIds : [],
  })
  const description = Object.hasOwn(record, 'description') ? record.description : ''
  const userNotes = Object.hasOwn(record, 'userNotes') ? record.userNotes : ''

  if (typeof description !== 'string' || typeof userNotes !== 'string') {
    throw new CreationInputError({ message: 'Description and user notes must be strings.' })
  }

  return Object.freeze({ inputMediaIds, description, userNotes })
}

export function validateCreationInput({
  input,
  mode,
  stage,
  limits,
}: {
  input: unknown
  limits: CreationInputLimits
  mode: CreationMode
  stage: CreationStage
}): CreationInput {
  if (mode !== 'effect' && mode !== 'free') {
    throw new CreationInputError({ message: 'Unknown creation mode.' })
  }
  if (stage !== 'draft' && stage !== 'quote' && stage !== 'submit') {
    throw new CreationInputError({ message: 'Unknown creation stage.' })
  }
  const strategy = modeStrategies[mode]

  validateLimits({ limits, mode })
  const normalized = normalizeCreationInput({ value: input })

  if (normalized[strategy.emptyField] !== '') {
    throw new CreationInputError({
      message: `${strategy.emptyField} must be empty in ${mode} mode.`,
    })
  }
  if (
    normalized.inputMediaIds.length > limits.maxImages ||
    normalized.description.length > limits.maxDescriptionLength ||
    normalized.userNotes.length > limits.maxNotesLength
  ) {
    throw new CreationInputError({ message: 'Input exceeds the configured limits.' })
  }
  if (stage !== 'draft') {
    if (normalized.inputMediaIds.length < limits.minImages) {
      throw new CreationInputError({ message: 'Input does not meet the configured image minimum.' })
    }
    if (strategy.isDescriptionRequired && normalized.description.trim() === '') {
      throw new CreationInputError({
        code: 'DESCRIPTION_REQUIRED',
        message: 'A description is required.',
      })
    }
  }

  return normalized
}

export function hashCreationInput({ input }: { input: unknown }): string {
  return hashCanonicalValue({ value: normalizeCreationInput({ value: input }) })
}

export function normalizeTaskClientInput({ value }: { value: unknown }): TaskClientInput {
  if (
    !hasPlainFields({ value, allowedKeys: ['operation', 'sessionId', 'input', 'sourceArtifactId'] })
  ) {
    throw new CreationInputError({
      message: 'Client input must be a JSON object containing only task fields.',
    })
  }
  const record = value as Record<string, unknown>
  const sessionId = readPositiveId({ value: record.sessionId })

  if (record.operation === 'generate' && !Object.hasOwn(record, 'sourceArtifactId')) {
    return Object.freeze({
      operation: 'generate',
      sessionId,
      input: normalizeCreationInput({ value: record.input }),
    })
  }
  if (record.operation === 'regenerate' && !Object.hasOwn(record, 'input')) {
    const sourceArtifactId = readPositiveId({ value: record.sourceArtifactId })

    return Object.freeze({ operation: 'regenerate', sessionId, sourceArtifactId })
  }

  throw new CreationInputError({ message: 'Invalid task operation or operation-specific fields.' })
}

export function hashTaskClientInput({ clientInput }: { clientInput: unknown }): string {
  return hashCanonicalValue({ value: normalizeTaskClientInput({ value: clientInput }) })
}

const modeStrategies = Object.freeze({
  effect: Object.freeze({ emptyField: 'description', isDescriptionRequired: false } as const),
  free: Object.freeze({ emptyField: 'userNotes', isDescriptionRequired: true } as const),
})

function hasPlainFields({
  value,
  allowedKeys,
}: {
  allowedKeys: readonly string[]
  value: unknown
}): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)

  if (prototype !== Object.prototype && prototype !== null) {
    return false
  }

  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) {
      return false
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
  })
}

function readPositiveId({ value }: { value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new CreationInputError({ message: 'IDs must be positive safe integers.' })
  }

  return value
}

function normalizeMediaIds({ value }: { value: unknown }): readonly number[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new CreationInputError({ message: 'Media IDs must be a dense array.' })
  }
  const ids: number[] = []
  const seen = new Set<number>()

  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)

    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new CreationInputError({ message: 'Media IDs must be a dense JSON array.' })
    }
    const id = readPositiveId({ value: descriptor.value })

    if (seen.has(id)) {
      throw new CreationInputError({ message: 'Media IDs must be unique positive safe integers.' })
    }
    seen.add(id)
    ids.push(id)
  }

  return Object.freeze(ids)
}

function validateLimits({
  limits,
  mode,
}: {
  limits: CreationInputLimits
  mode: CreationMode
}): void {
  const fields = ['minImages', 'maxImages', 'maxDescriptionLength', 'maxNotesLength'] as const

  if (!hasPlainFields({ value: limits, allowedKeys: fields })) {
    throw new RangeError('Creation limits must be a JSON object containing only limit fields.')
  }
  for (const field of fields) {
    const value = limits[field]

    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Creation limit ${field} must be a nonnegative safe integer.`)
    }
  }
  if (
    limits.minImages > limits.maxImages ||
    (mode === 'free' && limits.minImages !== 0) ||
    (mode === 'effect' && limits.minImages < 1)
  ) {
    throw new RangeError('Creation image limits are inconsistent with the mode.')
  }
}

function hashCanonicalValue({ value }: { value: CreationInput | TaskClientInput }): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}
