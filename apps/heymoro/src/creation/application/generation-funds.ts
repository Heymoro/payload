import type { GenerationDocument } from './generation-types.js'
import type { WorkerRepository } from './generation-worker-types.js'

import { creditBalance } from '../domain/credits.js'
import { integer } from '../domain/generation.js'
import { readCreditAccountFacts } from './credits.js'
import { conflict, workerActor } from './generation-worker-types.js'

/** Caller owns session→task→wallet, one req. No expiry job, wallet creation or missing-fact repair. */
export async function settleGenerationFunds({
  now,
  operation,
  repository,
  task,
}: {
  now: string
  operation: 'capture' | 'release'
  repository: WorkerRepository
  task: GenerationDocument
}) {
  const taskId = integer({ value: task.id })
  const userId = integer({ value: task.userId })
  const state = await readCreditAccountFacts({ now, repository: repository.credits, userId })
  if (!state.account) {
    conflict()
  }
  const reservations = await repository.findTaskReservationCandidates({ taskId })
  const reservation = reservations[0]!
  if (
    reservations.length !== 1 ||
    reservation.accountId !== state.account.id ||
    !['reconciliation', 'reserved'].includes(String(reservation.status))
  ) {
    conflict()
  }
  const allocations = await repository.readReservationAllocations({
    reservationId: integer({ value: reservation.id }),
  })
  const grants = [...state.grants]
  for (const allocation of allocations) {
    const index = grants.findIndex((grant) => grant.id === allocation.grantId)
    const grant = grants[index]
    const amount = integer({ value: allocation.amountCredits })
    if (!grant || allocation.status !== 'reserved' || grant.reservedCredits < amount) {
      conflict()
    }
    const isExpired = operation === 'release' && grant.expiresAt !== null && grant.expiresAt <= now
    const eventKey = `${operation}:generation:${taskId}:${grant.id}`
    if ((await repository.credits.findLedgerByEvent({ eventKey })).length) {
      conflict()
    }
    const next = {
      ...grant,
      availableCredits:
        grant.availableCredits + (operation === 'release' && !isExpired ? amount : 0),
      consumedCredits: grant.consumedCredits + (operation === 'capture' ? amount : 0),
      expiredCredits: grant.expiredCredits + (isExpired ? amount : 0),
      reservedCredits: grant.reservedCredits - amount,
    }
    await repository.credits.updateGrantBalances({ actor: workerActor, grant: next, now })
    await repository.credits.appendLedger({
      actor: workerActor,
      entry: {
        accountId: state.account.id,
        amountCredits: amount,
        availableDelta: operation === 'release' && !isExpired ? amount : 0,
        consumedDelta: operation === 'capture' ? amount : 0,
        eventKey,
        expiredDelta: isExpired ? amount : 0,
        grantId: grant.id,
        operation,
        reasonCode: operation === 'capture' ? 'GENERATION_CAPTURED' : 'GENERATION_RELEASED',
        reservationId: integer({ value: reservation.id }),
        reservedDelta: -amount,
        revokedDelta: 0,
        userId,
      },
      now,
    })
    await repository.settleGenerationAllocation({
      allocationId: integer({ value: allocation.id }),
      isExpired,
      now,
      operation,
    })
    grants[index] = next
  }
  await repository.credits.updateProjection({
    accountId: state.account.id,
    actor: workerActor,
    balance: creditBalance({ grants, now }),
    now,
  })
  await repository.settleGenerationReservation({
    now,
    operation,
    previousReservationStatus: reservation.status,
    reservationId: integer({ value: reservation.id }),
  })
}
