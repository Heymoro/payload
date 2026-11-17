import { createHash } from 'node:crypto'

export type SessionCommand = Readonly<{
  /** Preserved verbatim; length uses JavaScript UTF-16 code units. */
  clientRequestId: string
  templateId: number
}>

export type SessionErrorCode =
  | 'DATA_INTEGRITY_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INPUT_INVALID'
  | 'SESSION_UNAVAILABLE'
  | 'TEMPLATE_UNAVAILABLE'
  | 'UNAUTHENTICATED'

export class SessionError extends Error {
  readonly code: SessionErrorCode
  readonly status: 400 | 401 | 409 | 503

  constructor({
    code,
    message,
    status,
  }: {
    code: SessionErrorCode
    message: string
    status: 400 | 401 | 409 | 503
  }) {
    super(message)
    this.name = 'SessionError'
    this.code = code
    this.status = status
  }
}

export function normalizeSessionCommand({ value }: { value: unknown }): SessionCommand {
  if (!hasCommandFields({ value })) {
    throw new SessionError({
      code: 'INPUT_INVALID',
      message: 'Session creation requires only templateId and clientRequestId.',
      status: 400,
    })
  }
  const record = value as Record<string, unknown>
  const templateId = readTemplateId({ value: record.templateId })
  const clientRequestId = record.clientRequestId

  if (
    typeof clientRequestId !== 'string' ||
    clientRequestId.trim() === '' ||
    clientRequestId.length > 128
  ) {
    throw new SessionError({
      code: 'INPUT_INVALID',
      message: 'clientRequestId must be a nonblank string of at most 128 code units.',
      status: 400,
    })
  }

  return Object.freeze({ clientRequestId, templateId })
}

export function hashSessionCommand({ command }: { command: unknown }): string {
  const { templateId } = normalizeSessionCommand({ value: command })

  return createHash('sha256').update(JSON.stringify({ templateId }), 'utf8').digest('hex')
}

function hasCommandFields({ value }: { value: unknown }): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)

  if (prototype !== Object.prototype && prototype !== null) {
    return false
  }
  const keys = Reflect.ownKeys(value)
  const allowedKeys = ['templateId', 'clientRequestId']

  return (
    keys.length === allowedKeys.length &&
    keys.every((key) => {
      if (typeof key !== 'string' || !allowedKeys.includes(key)) {
        return false
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)

      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
    })
  )
}

function readTemplateId({ value }: { value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new SessionError({
      code: 'INPUT_INVALID',
      message: 'Template IDs must be positive safe integers.',
      status: 400,
    })
  }

  return value
}
