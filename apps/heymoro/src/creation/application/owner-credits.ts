import type { CreditHistoryPurpose } from '../domain/credit-history.js'
import type {
  CreditLedgerDTO,
  CreditReservationDTO,
  OwnerCreditAccountDTO,
  OwnerCreditPage,
  OwnerCreditsOptions,
} from './owner-credits-types.js'

import {
  createCreditHistoryCursor,
  creditIntegrity,
  normalizeCreditHistoryQuery,
} from '../domain/credit-history.js'
import { assertCreditTime } from '../domain/credits.js'
import { integer } from '../domain/generation.js'
import { libraryInput, requestId } from '../domain/library.js'
import { historyTime } from '../domain/task-history.js'
import { projectCreditLedger } from './credit-ledger.js'
import { projectCreditReservations, readCreditPageAccount } from './credit-reservations.js'
import { readCreditAccount } from './credits.js'

export function createOwnerCredits({
  clock,
  cursorKey,
  pageSize = 20,
  read,
  readiness,
}: OwnerCreditsOptions) {
  if (
    typeof readiness !== 'function' ||
    typeof clock !== 'function' ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50
  ) {
    throw new Error(
      'Owner credits require synchronous host readiness, clock and bounded page size.',
    )
  }
  const reservationsCodec = createCreditHistoryCursor({ cursorKey, purpose: 'credit-reservations' })
  const ledgerCodec = createCreditHistoryCursor({ cursorKey, purpose: 'credit-ledger' })
  function list(input: {
    args: { query: unknown; userId: number }
    purpose: 'credit-reservations'
  }): Promise<OwnerCreditPage<CreditReservationDTO>>
  function list(input: {
    args: { query: unknown; userId: number }
    purpose: 'credit-ledger'
  }): Promise<OwnerCreditPage<CreditLedgerDTO>>
  async function list({
    args,
    purpose,
  }: {
    args: { query: unknown; userId: number }
    purpose: CreditHistoryPurpose
  }): Promise<OwnerCreditPage<CreditLedgerDTO | CreditReservationDTO>> {
    const input = libraryInput({ fields: ['query', 'userId'], value: args })
    const userId = requestId({ value: input.userId })
    const query = normalizeCreditHistoryQuery({ value: input.query })
    const codec = purpose === 'credit-reservations' ? reservationsCodec : ledgerCodec
    const scope = { pageSize, userId }
    const after = query.cursor ? codec.decode({ ...scope, token: query.cursor }) : null
    return read({
      work: async ({ reader }) => {
        const now = assertCreditTime({ now: clock() })
        const account = await readCreditPageAccount({ reader, userId })
        const candidates = await (
          purpose === 'credit-reservations' ? reader.scanReservations : reader.scanLedger
        )({
          accountId: account ? integer({ value: account.id }) : null,
          after,
          limit: pageSize + 1,
          userId,
        })
        if (candidates.length > pageSize + 1) {
          creditIntegrity()
        }
        const rows = candidates.slice(0, pageSize)
        let last = after
        for (const row of rows) {
          const id = integer({ value: row.id })
          const time =
            purpose === 'credit-ledger' ? historyTime({ value: row.createdAt }) : undefined
          if (
            last &&
            (purpose === 'credit-ledger'
              ? time! > last.time! || (time === last.time && id >= last.id)
              : id >= last.id)
          ) {
            creditIntegrity()
          }
          last = Object.freeze({ id, ...(time ? { time } : {}) })
        }
        const items =
          purpose === 'credit-reservations'
            ? await projectCreditReservations({ account, now, reader, reservations: rows, userId })
            : await projectCreditLedger({ account, entries: rows, reader, userId })
        const hasMore = candidates.length > pageSize
        return Object.freeze({
          hasMore,
          items,
          nextCursor: hasMore && last ? codec.encode({ ...scope, after: last }) : null,
        })
      },
    })
  }
  return Object.freeze({
    account: async (args: { userId: number }): Promise<OwnerCreditAccountDTO> => {
      const input = libraryInput({ fields: ['userId'], value: args })
      const userId = requestId({ value: input.userId })
      return read({
        work: async ({ reader }) => {
          const now = assertCreditTime({ now: clock() })
          const configured = readiness()
          if (typeof configured !== 'boolean') {
            throw new Error('Host readiness must synchronously return a boolean.')
          }
          const { balance } = await readCreditAccount({
            now,
            repository: reader.creditReader,
            userId,
          })
          return Object.freeze({ ...balance, configured })
        },
      })
    },
    ledger: (args: { query: unknown; userId: number }) => list({ args, purpose: 'credit-ledger' }),
    reservations: (args: { query: unknown; userId: number }) =>
      list({ args, purpose: 'credit-reservations' }),
  })
}
