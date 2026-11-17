export type CreditSource = 'compensation' | 'subscription' | 'topup' | 'trial'
export type GrantCommand = Readonly<{
  expiresAt: null | string
  grantKey: string
  issuedCredits: number
  sourceId: null | string
  sourceType: 'compensation' | 'trial'
  validFrom: string
}>
export type CreditAccount = Readonly<{ id: number; isDeleted: boolean; userId: number }>
export type CreditGrant = Readonly<{
  accountId: number
  availableCredits: number
  consumedCredits: number
  expiredCredits: number
  expiresAt: null | string
  grantKey: string
  id: number
  isDeleted: boolean
  issuedCredits: number
  reservedCredits: number
  revokedCredits: number
  sourceId: null | string
  sourceType: CreditSource
  userId: number
  validFrom: string
}>
export type CreditBalance = Readonly<{
  available: number
  reserved: number
  sources: readonly Readonly<{ available: number; sourceType: CreditSource }>[]
}>
export class CreditsError extends Error {
  readonly code:
    | 'DATA_INTEGRITY_CONFLICT'
    | 'IDEMPOTENCY_CONFLICT'
    | 'INPUT_INVALID'
    | 'UNAUTHENTICATED'
  readonly status: 400 | 401 | 409 | 503
  constructor({ code }: { code: CreditsError['code'] }) {
    super(
      code === 'INPUT_INVALID'
        ? 'Invalid credit grant command.'
        : code === 'UNAUTHENTICATED'
          ? 'An active authenticated account is required.'
          : code === 'IDEMPOTENCY_CONFLICT'
            ? 'Credit grant idempotency conflict.'
            : 'Credit data integrity conflict.',
    )
    this.name = 'CreditsError'
    this.code = code
    this.status =
      code === 'INPUT_INVALID'
        ? 400
        : code === 'UNAUTHENTICATED'
          ? 401
          : code === 'IDEMPOTENCY_CONFLICT'
            ? 409
            : 503
  }
}

export function parseGrantCommand({ command }: { command: unknown }): GrantCommand {
  if (
    !command ||
    typeof command !== 'object' ||
    Array.isArray(command) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(command)) ||
    Object.getOwnPropertySymbols(command).length > 0
  ) {
    throw invalid()
  }
  const fields = ['grantKey', 'sourceType', 'sourceId', 'issuedCredits', 'validFrom', 'expiresAt']
  const values: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(command)) {
    const descriptor = Object.getOwnPropertyDescriptor(command, key)!
    if (!fields.includes(key) || !('value' in descriptor)) {
      throw invalid()
    }
    values[key] = descriptor.value
  }
  if (values.sourceType !== 'trial' && values.sourceType !== 'compensation') {
    throw invalid()
  }
  if (
    typeof values.issuedCredits !== 'number' ||
    !Number.isSafeInteger(values.issuedCredits) ||
    values.issuedCredits < 1
  ) {
    throw invalid()
  }
  const optionalText = Object.hasOwn(values, 'sourceId') ? values.sourceId : null
  const optionalExpiry = Object.hasOwn(values, 'expiresAt') ? values.expiresAt : null
  if (optionalText !== null && (typeof optionalText !== 'string' || optionalText.length > 128)) {
    throw invalid()
  }
  const validFrom = values.validFrom
  if (
    typeof validFrom !== 'string' ||
    !isUTCMilliseconds({ value: validFrom }) ||
    (optionalExpiry !== null &&
      (typeof optionalExpiry !== 'string' || !isUTCMilliseconds({ value: optionalExpiry })))
  ) {
    throw invalid()
  }
  if (
    typeof values.grantKey !== 'string' ||
    !values.grantKey.trim() ||
    values.grantKey.length > 160
  ) {
    throw invalid()
  }
  return Object.freeze({
    expiresAt: optionalExpiry,
    grantKey: values.grantKey,
    issuedCredits: values.issuedCredits,
    sourceId: optionalText,
    sourceType: values.sourceType,
    validFrom,
  })
}

export function assertNewGrantTime({ command, now }: { command: GrantCommand; now: string }) {
  if (
    command.validFrom > now ||
    (command.expiresAt !== null &&
      (command.expiresAt <= now || command.expiresAt <= command.validFrom))
  ) {
    throw invalid()
  }
}

export function assertCreditActor({ actor }: { actor: string }): string {
  if (
    typeof actor !== 'string' ||
    actor.length > 64 ||
    !/^(?:system:[A-Za-z0-9][\w.-]*|admin:[1-9]\d*)$/.test(actor) ||
    (actor.startsWith('admin:') && !Number.isSafeInteger(Number(actor.slice(6))))
  ) {
    throw new Error('Credits require a trusted system or admin actor.')
  }
  return actor
}

export function assertCreditTime({ now }: { now: string }): string {
  if (!isUTCMilliseconds({ value: now })) {
    throw new Error('Credits require a UTC millisecond host clock.')
  }
  return now
}

export function assertCreditGrant({ grant }: { grant: CreditGrant }) {
  if (
    grant.isDeleted ||
    !isUTCMilliseconds({ value: grant.validFrom }) ||
    (grant.expiresAt !== null &&
      (!isUTCMilliseconds({ value: grant.expiresAt }) || grant.expiresAt <= grant.validFrom))
  ) {
    throw integrity()
  }
  if (
    !Number.isSafeInteger(grant.issuedCredits) ||
    grant.issuedCredits < 1 ||
    !grant.grantKey.trim() ||
    grant.grantKey.length > 160
  ) {
    throw integrity()
  }
  let total = 0
  for (const amount of [
    grant.availableCredits,
    grant.reservedCredits,
    grant.consumedCredits,
    grant.expiredCredits,
    grant.revokedCredits,
  ]) {
    total = addCredits({ left: total, right: amount })
  }
  if (total !== grant.issuedCredits) {
    throw integrity()
  }
}

export function creditBalance({
  grants,
  now,
}: {
  grants: readonly CreditGrant[]
  now: string
}): CreditBalance {
  let available = 0
  let reserved = 0
  const sources = new Map<CreditSource, number>()
  for (const grant of grants) {
    assertCreditGrant({ grant })
    reserved = addCredits({ left: reserved, right: grant.reservedCredits })
    if (grant.validFrom <= now && (grant.expiresAt === null || now < grant.expiresAt)) {
      available = addCredits({ left: available, right: grant.availableCredits })
      if (grant.availableCredits > 0) {
        sources.set(
          grant.sourceType,
          addCredits({ left: sources.get(grant.sourceType) ?? 0, right: grant.availableCredits }),
        )
      }
    }
  }
  return Object.freeze({
    available,
    reserved,
    sources: Object.freeze(
      [...sources]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sourceType, amount]) => Object.freeze({ available: amount, sourceType })),
    ),
  })
}

export function addCredits({ left, right }: { left: number; right: number }): number {
  if (
    ![left, right].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !Number.isSafeInteger(left + right)
  ) {
    throw integrity()
  }
  return left + right
}

export function isUTCMilliseconds({ value }: { value: unknown }): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}
function invalid() {
  return new CreditsError({ code: 'INPUT_INVALID' })
}
function integrity() {
  return new CreditsError({ code: 'DATA_INTEGRITY_CONFLICT' })
}
