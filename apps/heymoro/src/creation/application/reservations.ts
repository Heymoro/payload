import type { CreditRepository } from './credits.js'
import type { GenerationReader } from './generation-reader-types.js'

import { creditBalance } from '../domain/credits.js'
import { GenerationError, integer } from '../domain/generation.js'
import { prepareCreditAccount } from './credits.js'

export type GenerationReservationRepository = Pick<
  GenerationReader,
  'findAllocationCandidates' | 'findGenerationReservationCandidates'
> &
  Readonly<{
    credits: CreditRepository
    insertGenerationAllocation: (
      args: Readonly<{
        amountCredits: number
        grantId: number
        now: string
        reservationId: number
      }>,
    ) => Promise<void>
    insertGenerationReservation: (
      args: Readonly<{
        accountId: number
        amountCredits: number
        now: string
        reservationKey: string
        taskId: number
        userId: number
      }>,
    ) => Promise<Readonly<{ id: unknown }>>
  }>

/** One transaction, one already-held wallet lease. Capture/release belong to the subsequent settlement slice. */
export async function reserveGenerationCredits({
  costCredits,
  now,
  repository,
  taskId,
  userId,
}: {
  costCredits: number
  now: string
  repository: GenerationReservationRepository
  taskId: number
  userId: number
}) {
  const actor = 'system:generation'
  const state = await prepareCreditAccount({ actor, now, repository: repository.credits, userId })
  if (state.balance.available < costCredits) {
    throw new GenerationError({ code: 'CREDITS_INSUFFICIENT' })
  }
  const account = state.account ?? (await repository.credits.insertAccount({ actor, now, userId }))
  const reservationKey = `generation:${taskId}`
  const previous = await repository.findGenerationReservationCandidates({ taskId })
  if (previous.length !== 0) {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
  const reservation = await repository.insertGenerationReservation({
    accountId: account.id,
    amountCredits: costCredits,
    now,
    reservationKey,
    taskId,
    userId,
  })
  const reservationId = integer({ value: reservation.id })
  let remaining = costCredits
  const grants = [...state.grants].sort((left, right) => {
    if (left.expiresAt === right.expiresAt) {
      return left.id - right.id
    }
    if (left.expiresAt === null) {
      return 1
    }
    if (right.expiresAt === null) {
      return -1
    }
    return left.expiresAt < right.expiresAt ? -1 : 1
  })
  for (let index = 0; index < grants.length && remaining > 0; index++) {
    const grant = grants[index]!
    if (
      grant.validFrom > now ||
      (grant.expiresAt !== null && grant.expiresAt <= now) ||
      grant.availableCredits === 0
    ) {
      continue
    }
    const amountCredits = Math.min(grant.availableCredits, remaining)
    const prior = await repository.findAllocationCandidates({ grantId: grant.id, reservationId })
    const eventKey = `reserve:${reservationKey}:${grant.id}`
    if (
      prior.length !== 0 ||
      (await repository.credits.findLedgerByEvent({ eventKey })).length !== 0
    ) {
      throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
    }
    await repository.insertGenerationAllocation({
      amountCredits,
      grantId: grant.id,
      now,
      reservationId,
    })
    const reserved = {
      ...grant,
      availableCredits: grant.availableCredits - amountCredits,
      reservedCredits: grant.reservedCredits + amountCredits,
    }
    await repository.credits.updateGrantBalances({ actor, grant: reserved, now })
    await repository.credits.appendLedger({
      actor,
      entry: {
        accountId: account.id,
        amountCredits,
        availableDelta: -amountCredits,
        consumedDelta: 0,
        eventKey,
        expiredDelta: 0,
        grantId: grant.id,
        operation: 'reserve',
        reasonCode: 'GENERATION_RESERVED',
        reservationId,
        reservedDelta: amountCredits,
        revokedDelta: 0,
        userId,
      },
      now,
    })
    grants[index] = reserved
    remaining -= amountCredits
  }
  if (remaining !== 0) {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
  await repository.credits.updateProjection({
    accountId: account.id,
    actor,
    balance: creditBalance({ grants, now }),
    now,
  })
  return reservationId
}
