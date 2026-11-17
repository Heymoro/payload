import type { CreditGrant, GrantCommand } from '../domain/credits.js'
import type { TrialPolicy } from '../domain/identity.js'
import type { TrialIdentity } from './identity-types.js'

import { assertCreditGrant, CreditsError, isUTCMilliseconds } from '../domain/credits.js'
import { addIdentitySeconds, identityIntegrity, parseIdentityPolicy } from '../domain/identity.js'

export function createTrialEntitlement({
  clock,
  findGrantsByKey,
  issueGrant,
  policy: rawPolicy,
}: {
  clock: () => string
  findGrantsByKey: (args: { grantKey: string }) => Promise<readonly CreditGrant[]>
  issueGrant: (args: { command: GrantCommand; userId: number }) => Promise<unknown>
  policy: TrialPolicy
}) {
  const policy = parseIdentityPolicy({
    value: { sessionTtlSeconds: 60, trial: rawPolicy, wechat: null },
  }).trial
  return async ({ identityCreatedAt, isEligible, userId }: TrialIdentity): Promise<void> => {
    if (!isEligible) {
      return
    }
    const grantKey = `trial:${userId}`
    const sourceId = `wechat-signup:${userId}:${identityCreatedAt}`
    if (!Number.isSafeInteger(userId) || userId < 1 || sourceId.length > 128) {
      throw identityIntegrity()
    }
    const previous = await findGrantsByKey({ grantKey })
    const command = priorCommand({ grantKey, grants: previous, sourceId, userId })
    if (policy === null) {
      return
    }
    const now = command ? null : clock()
    const input: GrantCommand =
      command ??
      Object.freeze({
        expiresAt:
          policy.validForSeconds === null
            ? null
            : addIdentitySeconds({ now: now!, seconds: policy.validForSeconds }),
        grantKey,
        issuedCredits: policy.issuedCredits,
        sourceId,
        sourceType: 'trial',
        validFrom: now!,
      })
    // Even a non-expiring grant must have a strict four-digit new issuance clock.
    if (!command && !isUTCMilliseconds({ value: now })) {
      throw identityIntegrity()
    }
    try {
      await issueGrant({ command: input, userId })
    } catch (error) {
      if (!(error instanceof CreditsError) || error.code !== 'IDEMPOTENCY_CONFLICT') {
        throw error
      }
      const winner = priorCommand({
        grantKey,
        grants: await findGrantsByKey({ grantKey }),
        sourceId,
        userId,
      })
      if (!winner) {
        throw identityIntegrity()
      }
      // Replaying the winner invokes the existing issuance/ledger/expiry/projection checks, not a pure read.
      await issueGrant({ command: winner, userId })
    }
  }
}
function priorCommand({
  grantKey,
  grants,
  sourceId,
  userId,
}: {
  grantKey: string
  grants: readonly CreditGrant[]
  sourceId: string
  userId: number
}): GrantCommand | null {
  if (grants.length > 1) {
    throw identityIntegrity()
  }
  const grant = grants[0]
  if (!grant) {
    return null
  }
  if (
    grant.isDeleted ||
    grant.grantKey !== grantKey ||
    grant.userId !== userId ||
    grant.sourceType !== 'trial' ||
    grant.sourceId !== sourceId
  ) {
    throw identityIntegrity()
  }
  try {
    assertCreditGrant({ grant })
  } catch {
    throw identityIntegrity()
  }
  return Object.freeze({
    expiresAt: grant.expiresAt,
    grantKey,
    issuedCredits: grant.issuedCredits,
    sourceId,
    sourceType: 'trial',
    validFrom: grant.validFrom,
  })
}
