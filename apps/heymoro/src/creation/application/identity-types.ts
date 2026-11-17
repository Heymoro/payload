import type {
  IdentityDTO,
  IdentityPolicy,
  IdentitySession,
  IdentityUser,
  VerifiedWechatIdentity,
  WechatIdentity,
} from '../domain/identity.js'

export type WechatCodeExchange = (
  args: Readonly<{ code: string }>,
) => Promise<VerifiedWechatIdentity>
export type IdentityReader = Readonly<{
  findSessionsByHash: (args: { tokenHash: string }) => Promise<readonly IdentitySession[]>
  findUsersById: (args: { userId: number }) => Promise<readonly IdentityUser[]>
  findWechatIdentities: (args: {
    appId: string
    openId: string
  }) => Promise<readonly WechatIdentity[]>
}>
export type IdentityRepository = IdentityReader &
  Readonly<{
    appendAudit: (args: {
      action: 'auth.session.revoke' | 'auth.wechat.session.create' | 'user.profile.update'
      createdUser?: boolean
      now: string
      requestId: string
      resourceId: number
      userId: number
    }) => Promise<void>
    insertSession: (args: {
      expiresAt: string
      now: string
      tokenHash: string
      userId: number
    }) => Promise<IdentitySession>
    insertUser: (args: { now: string }) => Promise<IdentityUser>
    insertWechatIdentity: (args: {
      appId: string
      now: string
      userId: number
      verified: VerifiedWechatIdentity
    }) => Promise<WechatIdentity>
    revokeSession: (args: { now: string; sessionId: number; userId: number }) => Promise<void>
    updateProfile: (args: {
      displayName: string
      now: string
      userId: number
    }) => Promise<IdentityUser>
  }>
export type IdentityRead = <T>(args: {
  work: (args: { reader: IdentityReader }) => Promise<T>
}) => Promise<T>
export type IdentityPersistence = Readonly<{
  read: IdentityRead
  write: <T>(args: {
    resource: string
    work: (args: { repository: IdentityRepository }) => Promise<T>
  }) => Promise<T>
}>
export type TrialIdentity = Readonly<{
  identityCreatedAt: string
  isEligible: boolean
  userId: number
}>
export type IdentityOptions = Readonly<{
  clock: () => string
  entropy?: () => Uint8Array
  exchange: null | WechatCodeExchange
  persistence: IdentityPersistence
  policy: IdentityPolicy
  trial: (args: TrialIdentity) => Promise<void>
}>
export type LoginResult = Readonly<{ expiresAt: string; token: string; user: IdentityDTO }>
