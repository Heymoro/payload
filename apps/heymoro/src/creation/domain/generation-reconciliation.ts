export type GenerationReconciliationCommand =
  | Readonly<{
      action: 'close-undelivered'
      attemptId: number
      authorization: string
      confirmedUndelivered: true
      operationId: string
      taskId: number
    }>
  | Readonly<{ action: 'inspect'; authorization: string; operationId?: string; taskId: number }>
  | Readonly<{ action: 'recover'; attemptId: number; authorization: string; taskId: number }>
export type ReconciliationOutcome = 'not_started' | 'rolled_back' | 'unknown'
export type ReconciliationResult = Readonly<{
  action: GenerationReconciliationCommand['action']
  attemptId: null | number
  expiredCredits?: number
  originalOperationId?: string
  outcome: 'confirmed'
  releasedCredits?: number
  requestId: string
  result: 'cancelled' | 'closed' | 'failed' | 'pending' | 'succeeded'
  taskId: number
  taskStatus: string
}>
export type ReconciliationErrorCode =
  | 'RECONCILIATION_DATA_INTEGRITY'
  | 'RECONCILIATION_FAILED'
  | 'RECONCILIATION_FORBIDDEN'
  | 'RECONCILIATION_INVALID_INPUT'
  | 'RECONCILIATION_OUTCOME_UNKNOWN'
  | 'RECONCILIATION_UNAUTHORIZED'

const messages: Record<ReconciliationErrorCode, string> = {
  RECONCILIATION_DATA_INTEGRITY: 'Generation reconciliation evidence is inconsistent.',
  RECONCILIATION_FAILED: 'Generation reconciliation failed.',
  RECONCILIATION_FORBIDDEN: 'An active administrator is required.',
  RECONCILIATION_INVALID_INPUT: 'Invalid generation reconciliation command.',
  RECONCILIATION_OUTCOME_UNKNOWN:
    'Reconciliation outcome is unknown. Verify evidence before further action.',
  RECONCILIATION_UNAUTHORIZED: 'Native administrator authentication is required.',
}
export class GenerationReconciliationError extends Error {
  readonly code: ReconciliationErrorCode
  readonly outcome: ReconciliationOutcome
  readonly requestId?: string
  constructor({
    code,
    outcome = 'not_started',
    requestId,
  }: {
    code: ReconciliationErrorCode
    outcome?: ReconciliationOutcome
    requestId?: string
  }) {
    super(messages[code])
    this.name = 'GenerationReconciliationError'
    this.code = code
    this.outcome = outcome
    this.requestId = requestId
  }
}

/** Never evaluate accessors or retain a caller-owned command across an await. */
export function parseGenerationReconciliationCommand({
  input,
}: {
  input: unknown
}): GenerationReconciliationCommand {
  try {
    if (
      !input ||
      typeof input !== 'object' ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(input)) ||
      Object.getOwnPropertySymbols(input).length
    ) {
      throw new Error()
    }
    const data: Record<string, unknown> = {}
    for (const key of Object.getOwnPropertyNames(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new Error()
      }
      Object.defineProperty(data, key, { enumerable: true, value: descriptor.value })
    }
    const required =
      data.action === 'inspect'
        ? ['action', 'authorization', 'taskId']
        : data.action === 'recover'
          ? ['action', 'authorization', 'taskId', 'attemptId']
          : data.action === 'close-undelivered'
            ? [
                'action',
                'authorization',
                'taskId',
                'attemptId',
                'operationId',
                'confirmedUndelivered',
              ]
            : null
    if (
      !required ||
      required.some((key) => !Object.hasOwn(data, key)) ||
      Object.keys(data).some(
        (key) => !required.includes(key) && !(data.action === 'inspect' && key === 'operationId'),
      )
    ) {
      throw new Error()
    }
    if (
      typeof data.authorization !== 'string' ||
      data.authorization.length > 8192 ||
      !/^JWT [\w-]+\.[\w-]+\.[\w-]+$/.test(data.authorization)
    ) {
      throw new Error()
    }
    for (const key of ['taskId', ...(data.action !== 'inspect' ? ['attemptId'] : [])]) {
      if (typeof data[key] !== 'number' || !Number.isSafeInteger(data[key]) || data[key] < 1) {
        throw new Error()
      }
    }
    if (
      Object.hasOwn(data, 'operationId') &&
      !isReconciliationOperationId({ value: data.operationId })
    ) {
      throw new Error()
    }
    if (data.action === 'close-undelivered' && data.confirmedUndelivered !== true) {
      throw new Error()
    }
    return Object.freeze(data) as GenerationReconciliationCommand
  } catch {
    throw new GenerationReconciliationError({ code: 'RECONCILIATION_INVALID_INPUT' })
  }
}
export function isReconciliationOperationId({ value }: { value: unknown }): boolean {
  return typeof value === 'string' && /^[A-Z0-9][\w.-]{0,127}$/i.test(value)
}
