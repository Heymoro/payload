import { isUTCMilliseconds } from './credits.js'

export type WechatConfiguration = Readonly<{
  appId: string
  appSecret: string
  maxResponseBytes: number
  timeoutMs: number
}>
export type TrialPolicy = null | Readonly<{ issuedCredits: number; validForSeconds: null | number }>
export type IdentityPolicy = Readonly<{
  sessionTtlSeconds: number
  trial: TrialPolicy
  wechat: null | WechatConfiguration
}>
export type VerifiedWechatIdentity = Readonly<{ openId: string; unionId: null | string }>
export type IdentityAudit = Readonly<{
  createdAt: string
  createdBy: string
  deletedAt: null | string
  deletedBy: null | string
  id: number
  isDeleted: boolean
  updatedAt: string
  updatedBy: string
}>
export type IdentityUser = IdentityAudit &
  Readonly<{
    avatarUrl: null | string
    displayName: string
    status: 'active' | 'disabled'
  }>
export type WechatIdentity = IdentityAudit &
  Readonly<{
    appId: string
    openId: string
    unionId: null | string
    user: number
  }>
export type IdentitySession = IdentityAudit &
  Readonly<{
    expiresAt: string
    revokedAt: null | string
    tokenHash: string
    user: number
  }>
export type IdentityPrincipal = Readonly<{
  avatarUrl?: string
  collection: 'users'
  createdAt: string
  displayName: string
  id: number
  status: 'active'
  updatedAt: string
}>
export type IdentityDTO = Readonly<{
  avatarUrl: null | string
  displayName: string
  id: number
  status: 'active' | 'disabled'
}>
export const wechatAuthActor = 'system:wechat-auth'

class LocalIdentityError extends Error {
  readonly code:
    | 'AUTH_DATA_INTEGRITY_CONFLICT'
    | 'AUTH_INPUT_INVALID'
    | 'AUTH_LOGIN_INCOMPLETE'
    | 'AUTH_PROVIDER_UNAVAILABLE'
    | 'AUTH_UNAUTHENTICATED'
    | 'AUTH_UNCONFIGURED'
  readonly retryable: boolean
  readonly status: 400 | 401 | 503
  constructor({ code }: { code: IdentityError['code'] }) {
    super(
      code === 'AUTH_INPUT_INVALID'
        ? 'Invalid identity command.'
        : code === 'AUTH_UNAUTHENTICATED'
          ? 'A valid active session is required.'
          : code === 'AUTH_LOGIN_INCOMPLETE'
            ? 'Login is incomplete. Retry with a new WeChat code.'
            : code === 'AUTH_PROVIDER_UNAVAILABLE'
              ? 'Identity provider is unavailable. Retry with a new WeChat code.'
              : code === 'AUTH_UNCONFIGURED'
                ? 'WeChat login is not configured.'
                : 'Identity data integrity conflict.',
    )
    this.name = 'IdentityError'
    this.code = code
    this.status = code === 'AUTH_INPUT_INVALID' ? 400 : code === 'AUTH_UNAUTHENTICATED' ? 401 : 503
    this.retryable = code === 'AUTH_LOGIN_INCOMPLETE' || code === 'AUTH_PROVIDER_UNAVAILABLE'
  }
}

// RSC and REST bundles must agree on class identity without accepting arbitrary error-shaped objects.
const identityErrorKey = Symbol.for('heymoro.error.identity.v1')
const errorRegistry = globalThis as {
  [identityErrorKey]?: typeof LocalIdentityError
} & typeof globalThis
export const IdentityError = errorRegistry[identityErrorKey] ?? LocalIdentityError
export type IdentityError = LocalIdentityError
if (!Object.hasOwn(errorRegistry, identityErrorKey)) {
  Object.defineProperty(errorRegistry, identityErrorKey, { value: IdentityError })
}

export function parseLoginCommand({ input }: { input: unknown }): Readonly<{ code: string }> {
  const value = strictRecord({ fields: ['code'], value: input })
  if (!isBoundedText({ max: 512, value: value.code }) || /\s/u.test(value.code as string)) {
    throw invalid()
  }
  return Object.freeze({ code: value.code as string })
}
export function parseProfileCommand({
  input,
}: {
  input: unknown
}): Readonly<{ displayName: string }> {
  const value = strictRecord({ fields: ['displayName'], value: input })
  if (typeof value.displayName !== 'string') {
    throw invalid()
  }
  const displayName = value.displayName.trim()
  if (!isBoundedText({ max: 80, value: displayName })) {
    throw invalid()
  }
  return Object.freeze({ displayName })
}
export function parseIdentityPolicy({ value }: { value: unknown }): IdentityPolicy {
  const policy = strictRecord({ fields: ['sessionTtlSeconds', 'trial', 'wechat'], value })
  integer({ max: 2592000, min: 60, value: policy.sessionTtlSeconds })
  let trial: TrialPolicy = null
  if (policy.trial !== null) {
    const data = strictRecord({ fields: ['issuedCredits', 'validForSeconds'], value: policy.trial })
    integer({ max: Number.MAX_SAFE_INTEGER, min: 1, value: data.issuedCredits })
    if (data.validForSeconds !== null) {
      // Even the entire four-digit UTC calendar cannot represent a longer new entitlement.
      integer({ max: 315569519999, min: 1, value: data.validForSeconds })
    }
    trial = Object.freeze({
      issuedCredits: data.issuedCredits as number,
      validForSeconds: data.validForSeconds as null | number,
    })
  }
  const wechat = policy.wechat === null ? null : parseWechatConfiguration({ value: policy.wechat })
  return Object.freeze({ sessionTtlSeconds: policy.sessionTtlSeconds as number, trial, wechat })
}
export function parseWechatConfiguration({ value }: { value: unknown }): WechatConfiguration {
  const data = strictRecord({
    fields: ['appId', 'appSecret', 'timeoutMs', 'maxResponseBytes'],
    value,
  })
  if (
    !isBoundedText({ max: 128, value: data.appId }) ||
    !isBoundedText({ max: 512, value: data.appSecret })
  ) {
    throw invalid()
  }
  integer({ max: 10000, min: 1, value: data.timeoutMs })
  integer({ max: 65536, min: 256, value: data.maxResponseBytes })
  return Object.freeze({
    appId: data.appId as string,
    appSecret: data.appSecret as string,
    maxResponseBytes: data.maxResponseBytes as number,
    timeoutMs: data.timeoutMs as number,
  })
}
export function parseVerifiedWechat({ value }: { value: unknown }): VerifiedWechatIdentity {
  const data = strictRecord({ fields: ['openId', 'unionId'], value })
  if (
    !isBoundedText({ max: 256, value: data.openId }) ||
    (data.unionId !== null && !isBoundedText({ max: 256, value: data.unionId }))
  ) {
    throw new IdentityError({ code: 'AUTH_PROVIDER_UNAVAILABLE' })
  }
  return Object.freeze({ openId: data.openId as string, unionId: data.unionId as null | string })
}
export function parseBearer({ authorization }: { authorization: unknown }): null | string {
  if (typeof authorization !== 'string' || !/^Bearer [\w-]{43}$/.test(authorization)) {
    return null
  }
  const token = authorization.slice(7)
  return Buffer.from(token, 'base64url').length === 32 &&
    Buffer.from(token, 'base64url').toString('base64url') === token
    ? token
    : null
}
export function addIdentitySeconds({ now, seconds }: { now: string; seconds: number }): string {
  if (
    !isUTCMilliseconds({ value: now }) ||
    !Number.isSafeInteger(seconds) ||
    seconds < 1 ||
    !Number.isSafeInteger(seconds * 1000) ||
    !Number.isSafeInteger(Date.parse(now) + seconds * 1000)
  ) {
    throw invalid()
  }
  const millis = Date.parse(now) + seconds * 1000
  if (millis > 253402300799999 || millis < -62167219200000) {
    throw invalid()
  }
  const result = new Date(millis).toISOString()
  if (!isUTCMilliseconds({ value: result })) {
    throw invalid()
  }
  return result
}
/** Historical read dates keep their existing canonical ISO rule, independent of new issuance limits. */
export function isIdentityDate({ value }: { value: unknown }): boolean {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}
export function assertIdentityAudit({ value }: { value: IdentityAudit }) {
  if (
    !isId(value.id) ||
    typeof value.isDeleted !== 'boolean' ||
    !isIdentityDate({ value: value.createdAt }) ||
    !isIdentityDate({ value: value.updatedAt })
  ) {
    throw integrity()
  }
  for (const actor of [
    value.createdBy,
    value.updatedBy,
    ...(value.isDeleted ? [value.deletedBy] : []),
  ]) {
    if (
      typeof actor !== 'string' ||
      !/^(?:(?:user|admin):[1-9]\d*|system:[A-Za-z0-9][\w.-]*)$/.test(actor)
    ) {
      throw integrity()
    }
  }
  if (
    value.isDeleted
      ? !isIdentityDate({ value: value.deletedAt })
      : value.deletedAt !== null || value.deletedBy !== null
  ) {
    throw integrity()
  }
}
export function assertIdentityUser({ user }: { user: IdentityUser }) {
  assertIdentityAudit({ value: user })
  if (
    !isBoundedText({ max: 80, value: user.displayName }) ||
    !['active', 'disabled'].includes(user.status) ||
    (user.avatarUrl !== null && typeof user.avatarUrl !== 'string')
  ) {
    throw integrity()
  }
}
export function assertIdentitySession({
  session,
  tokenHash,
}: {
  session: IdentitySession
  tokenHash: string
}) {
  assertIdentityAudit({ value: session })
  if (
    !isId(session.user) ||
    session.tokenHash !== tokenHash ||
    !/^[a-f0-9]{64}$/.test(session.tokenHash) ||
    !isIdentityDate({ value: session.expiresAt }) ||
    (session.revokedAt !== null && !isIdentityDate({ value: session.revokedAt }))
  ) {
    throw integrity()
  }
}
export function assertWechatIdentity({
  appId,
  identity,
  openId,
}: {
  appId: string
  identity: WechatIdentity
  openId: string
}) {
  assertIdentityAudit({ value: identity })
  if (
    !isId(identity.user) ||
    identity.appId !== appId ||
    identity.openId !== openId ||
    (identity.unionId !== null && !isBoundedText({ max: 256, value: identity.unionId }))
  ) {
    throw integrity()
  }
}
export function credentialIsValid({
  now,
  session,
  user,
}: {
  now: string
  session: IdentitySession
  user: IdentityUser
}): boolean {
  if (!isIdentityDate({ value: now })) {
    throw new Error('Invalid host authentication clock.')
  }
  return (
    !session.isDeleted &&
    session.revokedAt === null &&
    Date.parse(session.expiresAt) > Date.parse(now) &&
    !user.isDeleted &&
    user.status === 'active'
  )
}
export function identityDTO({ user }: { user: IdentityUser }): IdentityDTO {
  return Object.freeze({
    id: user.id,
    avatarUrl: user.avatarUrl,
    displayName: user.displayName,
    status: user.status,
  })
}
export function identityPrincipal({ user }: { user: IdentityUser }): IdentityPrincipal {
  return Object.freeze({
    id: user.id,
    collection: 'users',
    createdAt: user.createdAt,
    displayName: user.displayName,
    status: 'active',
    updatedAt: user.updatedAt,
    ...(user.avatarUrl === null ? {} : { avatarUrl: user.avatarUrl }),
  })
}
export function isTrialEligible({
  identity,
  user,
}: {
  identity: WechatIdentity
  user: IdentityUser
}) {
  return (
    !identity.isDeleted &&
    !user.isDeleted &&
    user.status === 'active' &&
    identity.user === user.id &&
    identity.createdBy === wechatAuthActor &&
    user.createdBy === wechatAuthActor &&
    identity.createdAt === user.createdAt
  )
}
export function identityIntegrity() {
  return integrity()
}

function strictRecord({
  fields,
  value,
}: {
  fields: readonly string[]
  value: unknown
}): Record<string, unknown> {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
      Object.getOwnPropertySymbols(value).length
    ) {
      throw invalid()
    }
    const names = Object.getOwnPropertyNames(value)
    if (names.length !== fields.length || names.some((name) => !fields.includes(name))) {
      throw invalid()
    }
    const result: Record<string, unknown> = {}
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !('value' in descriptor)) {
        throw invalid()
      }
      result[name] = descriptor.value
    }
    return result
  } catch {
    throw invalid()
  }
}
function integer({ max, min, value }: { max: number; min: number; value: unknown }) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid()
  }
}
function isId(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function isBoundedText({ max, value }: { max: number; value: unknown }): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    ![...value].some(
      (character) =>
        character.charCodeAt(0) <= 31 ||
        (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
    )
  )
}
function invalid() {
  return new IdentityError({ code: 'AUTH_INPUT_INVALID' })
}
function integrity() {
  return new IdentityError({ code: 'AUTH_DATA_INTEGRITY_CONFLICT' })
}
