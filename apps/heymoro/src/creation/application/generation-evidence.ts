import type { CreditGrant } from '../domain/credits.js'
import type { ExecutionSnapshot } from '../domain/generation.js'
import type {
  SessionContextReader,
  SubmissionContextReader,
  TaskEvidenceReader,
  UserAuthorizationReader,
} from './generation-reader-types.js'
import type { GenerateArgs, GenerationDocument, RegenerateArgs, Scope } from './generation-types.js'

import { assertCreditGrant } from '../domain/credits.js'
import {
  GenerationError,
  generationTime,
  integer,
  parseSnapshot,
  text,
  validStorageKey,
  validStoragePart,
} from '../domain/generation.js'
import { hashTaskClientInput } from '../domain/input.js'

export async function active({
  reader,
  userId,
}: {
  reader: UserAuthorizationReader
  userId: number
}) {
  const user = singleCandidate({ candidates: await reader.findUserCandidates({ userId }) })
  if (!user || user.status !== 'active' || deleted({ doc: user })) {
    throw new GenerationError({ code: 'UNAUTHENTICATED' })
  }
}
export function singleCandidate<T>({ candidates }: { candidates: readonly T[] }): null | T {
  if (candidates.length > 1) {
    throw integrity()
  }
  return candidates[0] ?? null
}
export async function ownedSession({
  reader,
  sessionId,
  userId,
}: {
  reader: SessionContextReader
  sessionId: number
  userId: number
}) {
  const doc = singleCandidate({
    candidates: await reader.findSessionCandidates({
      sessionId: positiveRequestId({ value: sessionId }),
    }),
  })
  if (!doc || deleted({ doc }) || doc.userId !== userId) {
    throw new GenerationError({ code: 'NOT_FOUND' })
  }
  integer({ value: doc.nextRoundNo })
  return doc
}
export async function resolveScope({
  args,
  operation,
  reader,
}: {
  args: GenerateArgs | RegenerateArgs
  operation: 'generate' | 'regenerate'
  reader: SubmissionContextReader
}): Promise<Scope> {
  if (operation === 'generate') {
    return {
      sessionId: positiveRequestId({ value: (args as GenerateArgs).sessionId }),
      sourceTaskId: null,
    }
  }
  const artifactId = positiveRequestId({ value: (args as RegenerateArgs).sourceArtifactId })
  const artifact = singleCandidate({
    candidates: await reader.findArtifactCandidates({ artifactId }),
  })
  if (!artifact || deleted({ doc: artifact }) || artifact.userId !== args.userId) {
    throw new GenerationError({ code: 'NOT_FOUND' })
  }
  const task = singleCandidate({
    candidates: await reader.findTaskCandidates({ taskId: integer({ value: artifact.taskId }) }),
  })
  if (
    !task ||
    deleted({ doc: task }) ||
    task.userId !== args.userId ||
    task.status !== 'succeeded'
  ) {
    throw new GenerationError({ code: 'NOT_FOUND' })
  }
  const sessionId = integer({ value: task.sessionId })
  if (artifact.sessionId !== sessionId) {
    throw integrity()
  }
  const duplicates = await reader.findOutputIdentityCandidates({
    outputIndex: integer({ value: artifact.outputIndex }),
    taskId: integer({ value: task.id }),
  })
  if (duplicates.length !== 1 || duplicates[0]!.id !== artifact.id) {
    throw integrity()
  }
  const output = singleCandidate({
    candidates: await reader.findMediaCandidates({ mediaId: integer({ value: artifact.mediaId }) }),
  })
  if (
    !output ||
    deleted({ doc: output }) ||
    output.owner !== args.userId ||
    output.lifecycle !== 'active' ||
    output.purpose !== 'artifact' ||
    output.visibility !== 'private'
  ) {
    throw new GenerationError({ code: 'NOT_FOUND' })
  }
  const source = validateTaskSnapshot({ task })
  await assertTaskEvidence({ reader, snapshot: source, task })
  if (
    !validStoragePart({ value: output.storageBackend }) ||
    !validStoragePart({ value: output.storageBucket }) ||
    !validStorageKey({ value: output.storageName }) ||
    output.storageBackend !== source.storageOutput.backend ||
    output.storageBucket !== source.storageOutput.bucket ||
    typeof output.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(output.sha256) ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(String(output.mimeType)) ||
    typeof output.filesize !== 'number' ||
    !Number.isSafeInteger(output.filesize) ||
    output.filesize <= 0
  ) {
    throw integrity()
  }
  return { sessionId, source, sourceTaskId: integer({ value: task.id }) }
}
export function validateTaskSnapshot({ task }: { task: GenerationDocument }) {
  const snapshot = parseSnapshot({ json: task.executionSnapshotJson })
  if (
    (snapshot.clientInput.operation === 'generate'
      ? task.sourceTaskId != null
      : typeof task.sourceTaskId !== 'number' ||
        !Number.isSafeInteger(task.sourceTaskId) ||
        task.sourceTaskId < 1) ||
    snapshot.clientInput.sessionId !== task.sessionId ||
    snapshot.templateId !== task.templateId ||
    snapshot.quote.costCredits !== task.costCredits ||
    snapshot.input.description !== task.description ||
    snapshot.input.userNotes !== task.userNotes ||
    hashTaskClientInput({ clientInput: snapshot.clientInput }) !== task.requestHash
  ) {
    throw integrity()
  }
  return snapshot
}
export function deleted({ doc }: { doc: GenerationDocument }) {
  if (typeof doc.isDeleted !== 'boolean') {
    throw integrity()
  }
  return doc.isDeleted
}
function positiveRequestId({ value }: { value: unknown }) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new GenerationError({ code: 'INPUT_INVALID' })
  }
  return value
}
export async function findRequest({
  clientRequestId,
  reader,
  userId,
}: {
  clientRequestId: string
  reader: Pick<SubmissionContextReader, 'findRequestCandidates'>
  userId: number
}) {
  const docs = await reader.findRequestCandidates({ clientRequestId, userId })
  if (docs.length > 1 || docs.some((doc) => deleted({ doc }) || doc.userId !== userId)) {
    throw integrity()
  }
  return docs[0] ?? null
}
export function taskDTO({
  snapshot,
  task,
}: {
  snapshot: ExecutionSnapshot
  task: GenerationDocument
}) {
  const status = text({ value: task.status })
  if (
    !['cancelled', 'closed', 'failed', 'queued', 'running', 'succeeded', 'unknown'].includes(status)
  ) {
    throw integrity()
  }
  return Object.freeze({
    id: integer({ value: task.id }),
    clientRequestId: text({ value: task.clientRequestId }),
    costCredits: integer({ minimum: 0, value: task.costCredits }),
    errorCode: task.errorCode == null ? null : text({ value: task.errorCode }),
    input: snapshot.input,
    roundNo: integer({ value: task.roundNo }),
    sessionId: integer({ value: task.sessionId }),
    sourceTaskId: task.sourceTaskId == null ? null : integer({ value: task.sourceTaskId }),
    status,
    templateId: integer({ value: task.templateId }),
  })
}
export async function assertTaskEvidence({
  reader,
  snapshot,
  task,
}: {
  reader: TaskEvidenceReader
  snapshot: ExecutionSnapshot
  task: GenerationDocument
}) {
  const session = singleCandidate({
    candidates: await reader.findSessionCandidates({
      sessionId: integer({ value: task.sessionId }),
    }),
  })
  if (
    !session ||
    session.userId !== task.userId ||
    session.templateId !== task.templateId ||
    session.templateId !== snapshot.templateId ||
    session.mode !== snapshot.mode
  ) {
    throw integrity()
  }
  const inputs = await reader.readTaskInputs({ taskId: integer({ value: task.id }) })
  assertTaskInputRows({ inputs, snapshot, task })
  const reservationKey = `generation:${integer({ value: task.id })}`
  const reservations = await reader.findGenerationReservationCandidates({
    taskId: integer({ value: task.id }),
  })
  const reservation = reservations[0]
  if (
    reservations.length !== 1 ||
    !reservation ||
    deleted({ doc: reservation }) ||
    reservation.userId !== task.userId ||
    reservation.taskId !== task.id ||
    reservation.reservationKey !== reservationKey ||
    reservation.amountCredits !== task.costCredits
  ) {
    throw integrity()
  }
  const state =
    task.status === 'succeeded'
      ? 'captured'
      : ['cancelled', 'closed', 'failed'].includes(String(task.status))
        ? 'released'
        : ['queued', 'running', 'unknown'].includes(String(task.status))
          ? 'reserved'
          : null
  if (
    !state ||
    (reservation.status !== state &&
      !(task.status === 'unknown' && reservation.status === 'reconciliation'))
  ) {
    throw integrity()
  }
  const accounts = await reader.findReservationAccountCandidates({
    accountId: integer({ value: reservation.accountId }),
    userId: integer({ value: task.userId }),
  })
  const account = accounts[0]
  if (
    accounts.length !== 1 ||
    !account ||
    deleted({ doc: account }) ||
    account.userId !== task.userId ||
    account.id !== reservation.accountId
  ) {
    throw integrity()
  }
  integer({ minimum: 0, value: account.availableCredits })
  integer({ minimum: 0, value: account.reservedCredits })
  if (state === 'reserved' && Number(account.reservedCredits) < Number(task.costCredits)) {
    throw integrity()
  }
  const allocations = await reader.readReservationAllocations({
    reservationId: integer({ value: reservation.id }),
  })
  let amount = 0
  const ids = new Set<number>()
  for (const allocation of allocations) {
    const grantId = integer({ value: allocation.grantId })
    if (
      deleted({ doc: allocation }) ||
      ids.has(grantId) ||
      (state === 'released'
        ? !['expired', 'released'].includes(String(allocation.status))
        : allocation.status !== state)
    ) {
      throw integrity()
    }
    ids.add(grantId)
    const allocated = integer({ value: allocation.amountCredits })
    amount += allocated
    if (!Number.isSafeInteger(amount)) {
      throw integrity()
    }
    const grant = singleCandidate({
      candidates: await reader.findGrantCandidates({ grantId }),
    })
    if (
      !grant ||
      deleted({ doc: grant }) ||
      grant.accountId !== account.id ||
      grant.userId !== task.userId
    ) {
      throw integrity()
    }
    assertRelatedGrant({ doc: grant })
    const grantIdentities = await reader.findGrantKeyCandidates({
      grantKey: text({ value: grant.grantKey }),
    })
    if (grantIdentities.length !== 1 || grantIdentities[0]!.id !== grant.id) {
      throw integrity()
    }
    if (
      (state === 'reserved' && Number(grant.reservedCredits) < allocated) ||
      (state === 'captured' && Number(grant.consumedCredits) < allocated)
    ) {
      throw integrity()
    }
    const base = {
      accountId: account.id,
      amountCredits: allocated,
      grantId,
      reservationId: reservation.id,
      userId: task.userId,
    }
    await assertFinancialEvent({
      eventKey: `reserve:${reservationKey}:${grantId}`,
      expected: {
        ...base,
        availableDelta: -allocated,
        consumedDelta: 0,
        expiredDelta: 0,
        operation: 'reserve',
        reservedDelta: allocated,
        revokedDelta: 0,
      },
      reader,
    })
    // Settlement adapters reuse these fixed event templates; recovery validates evidence, never appends it.
    if (state === 'captured') {
      await assertFinancialEvent({
        eventKey: `capture:${reservationKey}:${grantId}`,
        expected: {
          ...base,
          availableDelta: 0,
          consumedDelta: allocated,
          expiredDelta: 0,
          operation: 'capture',
          reservedDelta: -allocated,
          revokedDelta: 0,
        },
        reader,
      })
    }
    if (state === 'released') {
      await assertFinancialEvent({
        eventKey: `release:${reservationKey}:${grantId}`,
        expected: {
          ...base,
          availableDelta: allocation.status === 'released' ? allocated : 0,
          consumedDelta: 0,
          expiredDelta: allocation.status === 'expired' ? allocated : 0,
          operation: 'release',
          reservedDelta: -allocated,
          revokedDelta: 0,
        },
        reader,
      })
    }
  }
  const eventPrefixes = ['reserve', 'capture', 'release'].map(
    (operation) => `${operation}:${reservationKey}:`,
  )
  const candidateEvents = await reader.readGenerationFinancialEvidence({
    reservationId: integer({ value: reservation.id }),
    taskId: integer({ value: task.id }),
  })
  // Fixed ASCII prefixes end in ":"; under SQLite BINARY, the next ";" is their exclusive upper bound.
  // Keep exact filtering as well as true reservation associations, including malformed event keys.
  const events = candidateEvents.filter((event) => {
    const key = event.eventKey
    return (
      event.reservationId === reservation.id ||
      (typeof key === 'string' && eventPrefixes.some((prefix) => key.startsWith(prefix)))
    )
  })
  const expectedKeys = new Set(
    allocations.flatMap((allocation) => [
      `reserve:${reservationKey}:${integer({ value: allocation.grantId })}`,
      ...(state === 'captured'
        ? [`capture:${reservationKey}:${integer({ value: allocation.grantId })}`]
        : state === 'released'
          ? [`release:${reservationKey}:${integer({ value: allocation.grantId })}`]
          : []),
    ]),
  )
  if (
    events.length !== expectedKeys.size ||
    events.some(
      (event) => deleted({ doc: event }) || !expectedKeys.delete(String(event.eventKey)),
    ) ||
    expectedKeys.size !== 0
  ) {
    throw integrity()
  }
  if (amount !== task.costCredits) {
    throw integrity()
  }
}
async function assertFinancialEvent({
  eventKey,
  expected,
  reader,
}: {
  eventKey: string
  expected: GenerationDocument
  reader: TaskEvidenceReader
}) {
  const entries = await reader.findFinancialEventCandidates({ eventKey })
  const entry = entries[0]
  if (
    entries.length !== 1 ||
    !entry ||
    deleted({ doc: entry }) ||
    Object.entries(expected).some(
      ([key, value]) =>
        !Object.entries(entry).some(([field, actual]) => field === key && actual === value),
    )
  ) {
    throw integrity()
  }
}
export function assertRelatedGrant({ doc }: { doc: GenerationDocument }) {
  try {
    if (!['compensation', 'subscription', 'topup', 'trial'].includes(String(doc.sourceType))) {
      throw integrity()
    }
    const grant: CreditGrant = {
      id: integer({ value: doc.id }),
      accountId: integer({ value: doc.accountId }),
      availableCredits: integer({ minimum: 0, value: doc.availableCredits }),
      consumedCredits: integer({ minimum: 0, value: doc.consumedCredits }),
      expiredCredits: integer({ minimum: 0, value: doc.expiredCredits }),
      expiresAt:
        doc.expiresAt == null ? null : generationTime({ now: text({ value: doc.expiresAt }) }),
      grantKey: text({ value: doc.grantKey }),
      isDeleted: deleted({ doc }),
      issuedCredits: integer({ value: doc.issuedCredits }),
      reservedCredits: integer({ minimum: 0, value: doc.reservedCredits }),
      revokedCredits: integer({ minimum: 0, value: doc.revokedCredits }),
      sourceId: doc.sourceId == null ? null : text({ value: doc.sourceId }),
      sourceType: doc.sourceType as CreditGrant['sourceType'],
      userId: integer({ value: doc.userId }),
      validFrom: generationTime({ now: text({ value: doc.validFrom }) }),
    }
    assertCreditGrant({ grant })
  } catch {
    throw integrity()
  }
}

function integrity() {
  return new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
}

export function assertTaskInputRows({
  inputs,
  snapshot,
  task,
}: {
  inputs: readonly GenerationDocument[]
  snapshot: ExecutionSnapshot
  task: GenerationDocument
}) {
  if (
    inputs.length !== snapshot.media.length ||
    inputs.some(
      (doc, index) =>
        deleted({ doc }) ||
        doc.userId !== task.userId ||
        doc.position !== index + 1 ||
        doc.mediaId !== snapshot.media[index]!.mediaId ||
        doc.contentSha256 !== snapshot.media[index]!.sha256,
    )
  ) {
    throw integrity()
  }
}
