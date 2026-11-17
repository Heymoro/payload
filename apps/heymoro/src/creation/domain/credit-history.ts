import { GenerationError, integer } from './generation.js'
import { libraryInput, libraryTime, requestId } from './library.js'
import { createSignedCursor } from './signed-cursor.js'
import { historyTime } from './task-history.js'

export type CreditHistoryPurpose = 'credit-ledger' | 'credit-reservations'
export type CreditHistoryAfter = Readonly<{ id: number; time?: string }>
export type CreditHistoryScope = Readonly<{ pageSize: number; userId: number }>
export type CreditHistoryOperation =
  | 'capture'
  | 'compensate'
  | 'expire'
  | 'grant'
  | 'release'
  | 'reserve'

export function normalizeCreditHistoryQuery({ value }: { value: unknown }) {
  const query = libraryInput({ fields: ['cursor'], value })
  if (
    query.cursor !== undefined &&
    (typeof query.cursor !== 'string' || !query.cursor || query.cursor.length > 2048)
  ) {
    throw new GenerationError({ code: 'INPUT_INVALID' })
  }
  return Object.freeze({ cursor: query.cursor as string | undefined })
}
export function createCreditHistoryCursor({
  cursorKey,
  purpose,
}: {
  cursorKey: Uint8Array
  purpose: CreditHistoryPurpose
}) {
  const envelope = createSignedCursor({ cursorKey })
  const canonical = ({
    after,
    pageSize,
    userId,
  }: { after: CreditHistoryAfter } & CreditHistoryScope) => ({
    after:
      purpose === 'credit-ledger'
        ? { id: requestId({ value: after.id }), time: libraryTime({ value: after.time }) }
        : { id: requestId({ value: after.id }) },
    endpoint: purpose,
    order: purpose === 'credit-ledger' ? 'createdAt,id:desc' : 'id:desc',
    pageSize: requestId({ value: pageSize }),
    userId: requestId({ value: userId }),
    v: 1,
  })
  return Object.freeze({
    decode: ({ token, ...scope }: { token: string } & CreditHistoryScope): CreditHistoryAfter =>
      Object.freeze(
        envelope.decode({
          normalize: (value) =>
            canonical({ ...scope, after: (value as { after: CreditHistoryAfter }).after }),
          token,
        }).after,
      ),
    encode: (args: { after: CreditHistoryAfter } & CreditHistoryScope) =>
      envelope.encode({ value: canonical(args) }),
  })
}
/** Validates one original writer event; no today's expiry reinterpretation or balance projection. */
export function assertCreditHistoryEntry({
  entry,
  grant,
  taskId,
}: {
  entry: Readonly<Record<string, unknown>>
  grant: Readonly<Record<string, unknown>>
  taskId: null | number
}) {
  const amount = integer({ value: entry.amountCredits })
  const available = signed({ value: entry.availableDelta })
  const reserved = signed({ value: entry.reservedDelta })
  const consumed = signed({ value: entry.consumedDelta })
  const expired = signed({ value: entry.expiredDelta })
  const revoked = signed({ value: entry.revokedDelta })
  const createdAt = historyTime({ value: entry.createdAt })
  const validFrom = historyTime({ value: grant.validFrom })
  let key: string
  let reason: string
  let expected: readonly number[]
  switch (entry.operation) {
    case 'capture':
    case 'release':
    case 'reserve':
      if (taskId === null) {
        creditIntegrity()
      }
      integer({ value: entry.reservationId })
      key = `${entry.operation}:generation:${integer({ value: taskId })}:${integer({ value: grant.id })}`
      reason =
        entry.operation === 'reserve'
          ? 'GENERATION_RESERVED'
          : entry.operation === 'capture'
            ? 'GENERATION_CAPTURED'
            : 'GENERATION_RELEASED'
      if (
        entry.operation === 'release' &&
        (available < 0 ||
          expired < 0 ||
          !Number.isSafeInteger(available + expired) ||
          available + expired !== amount)
      ) {
        creditIntegrity()
      }
      expected =
        entry.operation === 'reserve'
          ? [-amount, amount, 0, 0, 0]
          : entry.operation === 'capture'
            ? [0, -amount, amount, 0, 0]
            : [available, -amount, 0, expired, 0]
      break
    case 'compensate':
    case 'grant':
      if (
        taskId !== null ||
        entry.reservationId != null ||
        amount !== grant.issuedCredits ||
        (entry.operation === 'compensate') !== (grant.sourceType === 'compensation')
      ) {
        creditIntegrity()
      }
      key = `grant:${String(grant.grantKey)}:${integer({ value: grant.id })}`
      reason = entry.operation === 'compensate' ? 'COMPENSATION_GRANT' : 'TRIAL_GRANT'
      expected = [amount, 0, 0, 0, 0]
      break
    case 'expire': {
      const expiry = historyTime({ value: grant.expiresAt })
      if (
        taskId !== null ||
        entry.reservationId != null ||
        amount > integer({ value: grant.issuedCredits }) ||
        createdAt < expiry
      ) {
        creditIntegrity()
      }
      key = `expire:${integer({ value: grant.id })}:${expiry}`
      reason = 'CREDIT_EXPIRED'
      expected = [-amount, 0, 0, amount, 0]
      break
    }
    default:
      return creditIntegrity()
  }
  if (
    entry.isDeleted !== false ||
    createdAt < validFrom ||
    entry.eventKey !== key ||
    entry.reasonCode !== reason ||
    [available, reserved, consumed, expired, revoked].some(
      (value, index) => value !== expected[index],
    )
  ) {
    creditIntegrity()
  }
  const ledgerDelta = signed({ value: available + reserved })
  return Object.freeze({
    ledgerDelta,
    statusCredits: entry.operation === 'reserve' || entry.operation === 'release' ? amount : null,
  })
}
export function creditIntegrity(): never {
  throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
}
function signed({ value }: { value: unknown }) {
  return integer({ minimum: Number.MIN_SAFE_INTEGER, value })
}
