import type { CreditAccount, CreditBalance, CreditGrant, GrantCommand } from '../domain/credits.js'

import {
  addCredits,
  assertCreditActor,
  assertCreditGrant,
  assertCreditTime,
  assertNewGrantTime,
  creditBalance,
  CreditsError,
  parseGrantCommand,
} from '../domain/credits.js'

export type CreditAudit = Readonly<{ actor: string; now: string }>
export type CreditLedger = Readonly<{
  accountId: number
  amountCredits: number
  availableDelta: number
  consumedDelta: number
  eventKey: string
  expiredDelta: number
  grantId: number
  id: number
  isDeleted: boolean
  operation: string
  reasonCode: string
  reservationId: null | number
  reservedDelta: number
  revokedDelta: number
  userId: number
}>
export type CreditReader = Readonly<{
  findAccounts: (args: { userId: number }) => Promise<readonly CreditAccount[]>
  findGrantIdentities: (args: {
    grantKeys: readonly string[]
  }) => Promise<readonly Pick<CreditGrant, 'grantKey' | 'id' | 'isDeleted'>[]>
  findGrants: (args: {
    accountId: null | number
    userId: number
  }) => Promise<readonly CreditGrant[]>
  findGrantsByKey: (args: { grantKey: string }) => Promise<readonly CreditGrant[]>
  isAccountActive: (args: { userId: number }) => Promise<boolean>
}>
export type CreditRepository = CreditReader &
  Readonly<{
    appendLedger: (
      args: { entry: Omit<CreditLedger, 'id' | 'isDeleted'> } & CreditAudit,
    ) => Promise<void>
    findLedgerByEvent: (args: { eventKey: string }) => Promise<readonly CreditLedger[]>
    insertAccount: (args: { userId: number } & CreditAudit) => Promise<CreditAccount>
    insertGrant: (
      args: { accountId: number; command: GrantCommand; userId: number } & CreditAudit,
    ) => Promise<CreditGrant>
    updateGrantBalances: (args: { grant: CreditGrant } & CreditAudit) => Promise<void>
    updateProjection: (
      args: { accountId: number; balance: CreditBalance } & CreditAudit,
    ) => Promise<void>
  }>
export type CreditDependencies = Readonly<{
  actor: string
  clock: () => string
  read: <T>(args: { work: (args: { repository: CreditReader }) => Promise<T> }) => Promise<T>
  write: <T>(args: {
    resource: string
    work: (args: { repository: CreditRepository }) => Promise<T>
  }) => Promise<T>
}>
export type PreparedCreditAccount = Readonly<{
  account: CreditAccount | null
  balance: CreditBalance
  grants: readonly CreditGrant[]
}>

export function createCreditsService({ actor, clock, read, write }: CreditDependencies) {
  const trustedActor = assertCreditActor({ actor })
  return Object.freeze({
    expire: async ({ userId }: { userId: number }): Promise<CreditBalance> => {
      assertUser({ userId })
      return write({
        resource: `wallet:${userId}`,
        work: async ({ repository }) => {
          const now = assertCreditTime({ now: clock() })
          return (await prepareCreditAccount({ actor: trustedActor, now, repository, userId }))
            .balance
        },
      })
    },
    getBalance: async ({ userId }: { userId: number }): Promise<CreditBalance> => {
      assertUser({ userId })
      return read({
        work: async ({ repository }) => {
          const now = assertCreditTime({ now: clock() })
          return (await readCreditAccount({ now, repository, userId })).balance
        },
      })
    },
    issueGrant: async ({ command, userId }: { command: unknown; userId: number }) => {
      assertUser({ userId })
      const input = parseGrantCommand({ command })
      return write({
        resource: `wallet:${userId}`,
        work: async ({ repository }) => {
          const now = assertCreditTime({ now: clock() })
          await assertActive({ repository, userId })
          const matches = await repository.findGrantsByKey({ grantKey: input.grantKey })
          if (matches.length > 1 || matches.some((grant) => grant.isDeleted)) {
            throw integrity()
          }
          const previous = matches[0]
          if (previous) {
            assertCreditGrant({ grant: previous })
            if (previous.userId !== userId || !sameGrant({ command: input, grant: previous })) {
              throw new CreditsError({ code: 'IDEMPOTENCY_CONFLICT' })
            }
            await assertIssuance({ grant: previous, repository })
            const state = await prepareCreditAccount({
              actor: trustedActor,
              now,
              repository,
              userId,
            })
            if (
              !state.account ||
              !state.grants.some(
                (grant) => grant.id === previous.id && grant.accountId === state.account!.id,
              )
            ) {
              throw integrity()
            }
            return Object.freeze({ balance: state.balance, grantId: previous.id, isNew: false })
          }
          assertNewGrantTime({ command: input, now })
          const state = await prepareCreditAccount({ actor: trustedActor, now, repository, userId })
          const account =
            state.account ?? (await repository.insertAccount({ actor: trustedActor, now, userId }))
          const grant = await repository.insertGrant({
            accountId: account.id,
            actor: trustedActor,
            command: input,
            now,
            userId,
          })
          const eventKey = issuanceKey({ grant })
          if ((await repository.findLedgerByEvent({ eventKey })).length !== 0) {
            throw integrity()
          }
          await repository.appendLedger({
            actor: trustedActor,
            entry: issuanceEntry({ grant }),
            now,
          })
          const balance = creditBalance({ grants: [...state.grants, grant], now })
          await repository.updateProjection({
            accountId: account.id,
            actor: trustedActor,
            balance,
            now,
          })
          return Object.freeze({ balance, grantId: grant.id, isNew: true })
        },
      })
    },
  })
}

/** Transaction-bound primitive for T1: caller owns the wallet coordination and transaction. No network or nested unit of work. */
export async function prepareCreditAccount({
  actor,
  now,
  repository,
  userId,
}: {
  actor: string
  now: string
  repository: CreditRepository
  userId: number
}): Promise<PreparedCreditAccount> {
  assertCreditActor({ actor })
  assertCreditTime({ now })
  const state = await readCreditAccount({ now, repository, userId })
  const grants: CreditGrant[] = []
  for (const grant of state.grants) {
    if (grant.expiresAt !== null && grant.expiresAt <= now && grant.availableCredits > 0) {
      const eventKey = `expire:${grant.id}:${grant.expiresAt}`
      // A prior expiry with live available is corruption, not permission to append or credit twice.
      if ((await repository.findLedgerByEvent({ eventKey })).length !== 0) {
        throw integrity()
      }
      const amount = grant.availableCredits
      const expired = {
        ...grant,
        availableCredits: 0,
        expiredCredits: addCredits({ left: grant.expiredCredits, right: amount }),
      }
      assertCreditGrant({ grant: expired })
      await repository.updateGrantBalances({ actor, grant: expired, now })
      await repository.appendLedger({
        actor,
        entry: {
          ...baseEntry({ eventKey, grant }),
          amountCredits: amount,
          availableDelta: -amount,
          expiredDelta: amount,
          operation: 'expire',
          reasonCode: 'CREDIT_EXPIRED',
        },
        now,
      })
      grants.push(expired)
    } else {
      grants.push(grant)
    }
  }
  const balance = creditBalance({ grants, now })
  if (state.account) {
    await repository.updateProjection({ accountId: state.account.id, actor, balance, now })
  }
  return Object.freeze({ account: state.account, balance, grants: Object.freeze(grants) })
}

/** Validates ownership and all batches inside the caller's consistent snapshot; never reads ledger history. */
export async function readCreditAccount({
  now,
  repository,
  userId,
}: {
  now: string
  repository: CreditReader
  userId: number
}): Promise<PreparedCreditAccount> {
  assertUser({ userId })
  assertCreditTime({ now })
  await assertActive({ repository, userId })
  return readCreditAccountFacts({ now, repository, userId })
}

/** Accepted work settles against immutable ownership and conserved facts, not current login status. */
export async function readCreditAccountFacts({
  now,
  repository,
  userId,
}: {
  now: string
  repository: CreditReader
  userId: number
}): Promise<PreparedCreditAccount> {
  assertUser({ userId })
  assertCreditTime({ now })
  const accounts = await repository.findAccounts({ userId })
  if (
    accounts.length > 1 ||
    accounts.some((account) => account.isDeleted || account.userId !== userId)
  ) {
    throw integrity()
  }
  const account = accounts[0] ?? null
  const grants = await repository.findGrants({ accountId: account?.id ?? null, userId })
  const ids = new Set<number>()
  const keys = new Set<string>()
  for (const grant of grants) {
    assertCreditGrant({ grant })
    if (
      !account ||
      grant.userId !== userId ||
      grant.accountId !== account.id ||
      ids.has(grant.id) ||
      keys.has(grant.grantKey)
    ) {
      throw integrity()
    }
    ids.add(grant.id)
    keys.add(grant.grantKey)
  }
  for (let offset = 0; offset < grants.length; offset += 128) {
    const batch = grants.slice(offset, offset + 128)
    const identities = await repository.findGrantIdentities({
      grantKeys: batch.map((grant) => grant.grantKey),
    })
    const expected = new Map(batch.map((grant) => [grant.grantKey, grant.id]))
    const seen = new Set<string>()
    for (const identity of identities) {
      if (
        identity.isDeleted ||
        expected.get(identity.grantKey) !== identity.id ||
        seen.has(identity.grantKey)
      ) {
        throw integrity()
      }
      seen.add(identity.grantKey)
    }
    if (seen.size !== batch.length) {
      throw integrity()
    }
  }
  return Object.freeze({ account, balance: creditBalance({ grants, now }), grants })
}

function issuanceKey({ grant }: { grant: CreditGrant }) {
  return `grant:${grant.grantKey}:${grant.id}`
}
function issuanceEntry({ grant }: { grant: CreditGrant }): Omit<CreditLedger, 'id' | 'isDeleted'> {
  return {
    ...baseEntry({ eventKey: issuanceKey({ grant }), grant }),
    amountCredits: grant.issuedCredits,
    availableDelta: grant.issuedCredits,
    operation: grant.sourceType === 'compensation' ? 'compensate' : 'grant',
    reasonCode: grant.sourceType === 'compensation' ? 'COMPENSATION_GRANT' : 'TRIAL_GRANT',
  }
}
function baseEntry({ eventKey, grant }: { eventKey: string; grant: CreditGrant }) {
  return {
    accountId: grant.accountId,
    availableDelta: 0,
    consumedDelta: 0,
    eventKey,
    expiredDelta: 0,
    grantId: grant.id,
    reservationId: null,
    reservedDelta: 0,
    revokedDelta: 0,
    userId: grant.userId,
  }
}
async function assertIssuance({
  grant,
  repository,
}: {
  grant: CreditGrant
  repository: CreditRepository
}) {
  const expected = issuanceEntry({ grant })
  const entries = await repository.findLedgerByEvent({ eventKey: expected.eventKey })
  if (
    entries.length !== 1 ||
    entries[0]!.isDeleted ||
    Object.entries(expected).some(
      ([key, value]) => entries[0]![key as keyof CreditLedger] !== value,
    )
  ) {
    throw integrity()
  }
}
function sameGrant({ command, grant }: { command: GrantCommand; grant: CreditGrant }) {
  return (Object.keys(command) as (keyof GrantCommand)[]).every(
    (key) => command[key] === grant[key],
  )
}
async function assertActive({ repository, userId }: { repository: CreditReader; userId: number }) {
  if (!(await repository.isAccountActive({ userId }))) {
    throw new CreditsError({ code: 'UNAUTHENTICATED' })
  }
}
function assertUser({ userId }: { userId: number }) {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new CreditsError({ code: 'UNAUTHENTICATED' })
  }
}
function integrity() {
  return new CreditsError({ code: 'DATA_INTEGRITY_CONFLICT' })
}
