import type { CreditRepository } from '../src/creation/application/credits.js'
import type {
  AcceptedGenerationReader,
  DeliveryEvidenceReader,
  GenerationReader,
  NamingReader,
  RenameReader,
  SessionContextReader,
  UserAuthorizationReader,
} from '../src/creation/application/generation-reader-types.js'
import type {
  GenerationDependencies,
  GenerationRepository,
  GenerationSubmissionWriter,
} from '../src/creation/application/generation-types.js'
import type {
  AttemptLifecycleWriter,
  GenerationSettlementWriter,
  WorkerPersistence,
  WorkerRepository,
} from '../src/creation/application/generation-worker-types.js'
import type { GenerationReservationRepository } from '../src/creation/application/reservations.js'
import type {
  TitlePersistence,
  TitleRepository,
} from '../src/creation/application/session-naming-types.js'
import type { StoredImage } from '../src/creation/domain/media.js'
import type { createPayloadTitlePersistence } from '../src/creation/infrastructure/payload/session-naming-repository.js'

type Assert<Value extends true> = Value
type Absent<Value, Key extends PropertyKey> = Key extends keyof Value ? false : true
type Assignable<From, To> = [From] extends [To] ? true : false
type Fact = Awaited<ReturnType<GenerationReader['findTaskCandidates']>>[number]
type AllFacts = {
  [Key in keyof GenerationReader]: Awaited<ReturnType<GenerationReader[Key]>>[number]
}[keyof GenerationReader]
type NoIndex<Value> = Value extends unknown ? (string extends keyof Value ? false : true) : never

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false
type ReadonlyFacts<Value> = Value extends unknown ? Equal<Value, Readonly<Value>> : never
type UnknownFields<Value> = Value extends unknown
  ? {
      [Key in keyof Value]: Equal<Value[Key], unknown>
    }[keyof Value]
  : never
type ReadonlyResults = {
  [Key in keyof GenerationReader]: Awaited<ReturnType<GenerationReader[Key]>> extends unknown[]
    ? false
    : true
}[keyof GenerationReader]

type WorkerRead = Parameters<Parameters<WorkerPersistence['read']>[0]['work']>[0]['reader']
type SubmissionRead = Parameters<Parameters<GenerationDependencies['read']>[0]['work']>[0]['reader']

export type ReadCapabilities = [
  Assert<Absent<WorkerRead, 'findUserCandidates'>>,
  Assert<Assignable<WorkerRead, AcceptedGenerationReader & DeliveryEvidenceReader>>,
  Assert<Absent<SubmissionRead, 'findTaskCloseAuditCandidates'>>,
  Assert<Assignable<SubmissionRead, UserAuthorizationReader>>,
  Assert<ReadonlyFacts<AllFacts>>,
  Assert<UnknownFields<AllFacts>>,
  Assert<ReadonlyResults>,
  Assert<Absent<GenerationReader, 'find'>>,
  Assert<Absent<GenerationReader, 'create'>>,
  Assert<Absent<GenerationReader, 'update'>>,
  Assert<Absent<GenerationReader, 'updateExpected'>>,
  Assert<Absent<GenerationReader, 'queue'>>,
  Assert<NoIndex<AllFacts>>,
  Assert<Assignable<Fact['id'], unknown>>,
  Assert<Assignable<unknown, Fact['id']>>,
  Assert<Absent<Fact, 'unexpected'>>,
  Assert<Absent<NamingReader, 'findUserCandidates'>>,
  Assert<Absent<NamingReader, 'findTemplateCandidates'>>,
  Assert<Absent<RenameReader, 'findOwnerAccountCandidates'>>,
  Assert<Absent<RenameReader, 'readRelatedGrants'>>,
  Assert<Absent<RenameReader, 'readGenerationFinancialEvidence'>>,
  Assert<Assignable<RenameReader, SessionContextReader & UserAuthorizationReader>>,
  Assert<Assignable<NamingReader, AcceptedGenerationReader & DeliveryEvidenceReader>>,
  Assert<
    Assignable<ReturnType<typeof createPayloadTitlePersistence>, TitlePersistence<RenameReader>>
  >,
  Assert<
    Assignable<ReturnType<typeof createPayloadTitlePersistence>, TitlePersistence<NamingReader>>
  >,
  Assert<Assignable<TitleRepository<NamingReader & RenameReader>, TitleRepository<RenameReader>>>,
  Assert<Assignable<TitleRepository<NamingReader & RenameReader>, TitleRepository<NamingReader>>>,
  Assert<Assignable<TitlePersistence, TitlePersistence<RenameReader>>>,
]

type SubmissionArguments = {
  [Key in keyof GenerationSubmissionWriter]: Parameters<GenerationSubmissionWriter[Key]>[0]
}[keyof GenerationSubmissionWriter]
type ReservationArguments =
  | Parameters<GenerationReservationRepository['insertGenerationAllocation']>[0]
  | Parameters<GenerationReservationRepository['insertGenerationReservation']>[0]
type QueuedTask = Awaited<ReturnType<GenerationSubmissionWriter['insertQueuedTask']>>
type OrderedInput = Parameters<GenerationSubmissionWriter['insertOrderedTaskInputs']>[0]['inputs']
type WorkerWriter = AttemptLifecycleWriter & GenerationSettlementWriter
type WorkerArguments = {
  [Key in keyof WorkerWriter]: Parameters<WorkerWriter[Key]>[0]
}[keyof WorkerWriter]

export type SubmissionCapabilities = [
  Assert<Absent<GenerationRepository, 'create'>>,
  Assert<Absent<GenerationRepository, 'update'>>,
  Assert<Absent<GenerationRepository, 'updateExpected'>>,
  Assert<Absent<GenerationRepository, 'queue'>>,
  Assert<Absent<GenerationRepository, 'findTaskCloseAuditCandidates'>>,
  Assert<Absent<GenerationRepository, 'findCloseOperationConflicts'>>,
  Assert<Absent<GenerationRepository, 'readTaskAttempts'>>,
  Assert<NoIndex<GenerationRepository>>,
  Assert<NoIndex<SubmissionArguments>>,
  Assert<NoIndex<ReservationArguments>>,
  Assert<Absent<SubmissionArguments, 'where'>>,
  Assert<Absent<SubmissionArguments, 'data'>>,
  Assert<ReadonlyFacts<SubmissionArguments>>,
  Assert<ReadonlyFacts<ReservationArguments>>,
  Assert<Equal<OrderedInput extends unknown[] ? false : true, true>>,
  Assert<ReadonlyFacts<OrderedInput[number]>>,
  Assert<NoIndex<OrderedInput[number]>>,
  Assert<Equal<keyof OrderedInput[number], 'contentSha256' | 'mediaId' | 'position'>>,
  Assert<ReadonlyFacts<QueuedTask>>,
  Assert<UnknownFields<QueuedTask>>,
  Assert<
    Equal<
      keyof QueuedTask,
      | 'clientRequestId'
      | 'costCredits'
      | 'errorCode'
      | 'id'
      | 'roundNo'
      | 'sessionId'
      | 'sourceTaskId'
      | 'status'
      | 'templateId'
    >
  >,
  Assert<
    Equal<
      keyof GenerationReservationRepository,
      | 'credits'
      | 'findAllocationCandidates'
      | 'findGenerationReservationCandidates'
      | 'insertGenerationAllocation'
      | 'insertGenerationReservation'
    >
  >,
  Assert<
    Equal<
      keyof GenerationSubmissionWriter,
      'advanceSessionRound' | 'enqueueGeneration' | 'insertOrderedTaskInputs' | 'insertQueuedTask'
    >
  >,
  Assert<
    Equal<
      Parameters<GenerationSubmissionWriter['insertQueuedTask']>[0],
      Readonly<{
        clientRequestId: string
        costCredits: number
        description: string
        executionSnapshotJson: string
        now: string
        requestHash: string
        roundNo: number
        sessionId: number
        sourceTaskId: null | number
        templateId: number
        userId: number
        userNotes: string
      }>
    >
  >,
  Assert<
    Equal<
      Parameters<GenerationSubmissionWriter['insertOrderedTaskInputs']>[0],
      Readonly<{
        inputs: readonly Readonly<{ contentSha256: string; mediaId: number; position: number }>[]
        now: string
        taskId: number
        userId: number
      }>
    >
  >,
  Assert<
    Equal<
      Parameters<GenerationSubmissionWriter['advanceSessionRound']>[0],
      Readonly<{
        nextRoundNo: number
        now: string
        sessionId: number
        userId: number
      }>
    >
  >,
  Assert<
    Equal<
      Parameters<GenerationSubmissionWriter['enqueueGeneration']>[0],
      Readonly<{ taskId: number }>
    >
  >,
  Assert<
    Equal<
      Parameters<GenerationReservationRepository['insertGenerationReservation']>[0],
      Readonly<{
        accountId: number
        amountCredits: number
        now: string
        reservationKey: string
        taskId: number
        userId: number
      }>
    >
  >,
  Assert<
    Equal<
      Parameters<GenerationReservationRepository['insertGenerationAllocation']>[0],
      Readonly<{
        amountCredits: number
        grantId: number
        now: string
        reservationId: number
      }>
    >
  >,
  Assert<
    Equal<
      Awaited<ReturnType<GenerationReservationRepository['insertGenerationReservation']>>,
      Readonly<{ id: unknown }>
    >
  >,
  Assert<Equal<GenerationReservationRepository['credits'], CreditRepository>>,
  Assert<Absent<WorkerRepository, 'create'>>,
  Assert<Absent<WorkerRepository, 'updateExpected'>>,
  Assert<NoIndex<WorkerRepository>>,
  Assert<NoIndex<WorkerArguments>>,
  Assert<ReadonlyFacts<WorkerArguments>>,
  Assert<Absent<WorkerArguments, 'data'>>,
  Assert<Absent<WorkerArguments, 'where'>>,
  Assert<Absent<WorkerArguments, 'expected'>>,
  Assert<Absent<WorkerArguments, 'collection'>>,
  Assert<Absent<WorkerArguments, 'patch'>>,
  Assert<Absent<WorkerRepository, 'update'>>,
  Assert<Absent<WorkerRepository, 'queue'>>,
  Assert<Absent<WorkerRepository, 'insertQueuedTask'>>,
  Assert<Absent<WorkerRepository, 'insertOrderedTaskInputs'>>,
  Assert<Absent<WorkerRepository, 'insertGenerationReservation'>>,
  Assert<Absent<WorkerRepository, 'insertGenerationAllocation'>>,
  Assert<Absent<WorkerRepository, 'advanceSessionRound'>>,
  Assert<Absent<WorkerRepository, 'enqueueGeneration'>>,
  Assert<Absent<WorkerRepository, 'findUserCandidates'>>,
  Assert<Absent<WorkerRepository, 'findTemplateCandidates'>>,
  Assert<Absent<WorkerRepository, 'findRequestCandidates'>>,
  Assert<Absent<WorkerRepository, 'findBlockingTaskCandidates'>>,
  Assert<
    Equal<
      keyof WorkerRepository,
      | 'credits'
      | 'queueName'
      | 'registerMedia'
      | keyof (AcceptedGenerationReader &
          DeliveryEvidenceReader &
          Pick<GenerationReader, 'findCloseOperationConflicts' | 'findTaskReservationCandidates'>)
      | keyof WorkerWriter
    >
  >,
  Assert<
    Assignable<
      WorkerRepository,
      AcceptedGenerationReader &
        DeliveryEvidenceReader &
        Pick<GenerationReader, 'findCloseOperationConflicts' | 'findTaskReservationCandidates'>
    >
  >,
]

export type WorkerWriterCapabilities = [
  Assert<
    Equal<
      keyof AttemptLifecycleWriter,
      | 'expirePreparedAttempt'
      | 'insertPreparedAttempt'
      | 'recordAttemptOutput'
      | 'recordAttemptProviderUnknown'
      | 'recordAttemptSending'
      | 'recordTaskProviderUnknown'
      | 'recordTaskRunning'
    >
  >,
  Assert<
    Equal<
      keyof GenerationSettlementWriter,
      | 'appendUnknownCloseAudit'
      | 'closeUnknownTask'
      | 'insertDeliveredArtifact'
      | 'recordAttemptFailed'
      | 'recordAttemptSucceeded'
      | 'recordSessionDelivery'
      | 'recordTaskFailed'
      | 'recordTaskSucceeded'
      | 'settleGenerationAllocation'
      | 'settleGenerationReservation'
    >
  >,
  Assert<
    Equal<
      Parameters<WorkerWriter['recordAttemptProviderUnknown']>[0],
      Readonly<{
        attemptId: number
        now: string
        previousAttemptStatus: unknown
        providerRequestId: unknown
      }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['recordAttemptProviderUnknown']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['recordTaskProviderUnknown']>[0],
      Readonly<{ now: string; previousTaskStatus: unknown; taskId: number }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['recordTaskProviderUnknown']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['recordAttemptOutput']>[0],
      Readonly<{
        attemptId: number
        facts: StoredImage
        isClosed: boolean
        now: string
        previousAttemptStatus: unknown
        providerRequestId: unknown
      }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['recordAttemptOutput']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['expirePreparedAttempt']>[0],
      Readonly<{ attemptId: number; now: string }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['expirePreparedAttempt']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['insertPreparedAttempt']>[0],
      Readonly<{
        attemptNo: number
        leaseUntil: string
        model: string
        now: string
        provider: string
        taskId: number
      }>
    >
  >,
  Assert<
    Equal<Awaited<ReturnType<WorkerWriter['insertPreparedAttempt']>>, Readonly<{ id: unknown }>>
  >,
  Assert<
    Equal<
      Parameters<WorkerWriter['recordTaskRunning']>[0],
      Readonly<{ now: string; previousTaskStatus: unknown; startedAt: unknown; taskId: number }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['recordTaskRunning']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['recordAttemptSending']>[0],
      Readonly<{ attemptId: number; now: string }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['recordAttemptSending']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['closeUnknownTask']>[0],
      Readonly<{ actor: string; now: string; taskId: number }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['closeUnknownTask']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['appendUnknownCloseAudit']>[0],
      Readonly<{
        actor: string
        attemptId: unknown
        now: string
        operationId: string
        reason: string
        taskId: number
      }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['appendUnknownCloseAudit']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['insertDeliveredArtifact']>[0],
      Readonly<{
        mediaId: number
        now: string
        sessionId: unknown
        taskId: number
        userId: unknown
      }>
    >
  >,
  Assert<
    Equal<Awaited<ReturnType<WorkerWriter['insertDeliveredArtifact']>>, Readonly<{ id: unknown }>>
  >,
  Assert<
    Equal<
      Parameters<WorkerWriter['recordAttemptSucceeded']>[0],
      Readonly<{ attemptId: number; now: string }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['recordAttemptSucceeded']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['recordTaskSucceeded']>[0],
      Readonly<{ now: string; previousTaskStatus: unknown; taskId: number }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['recordTaskSucceeded']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['recordSessionDelivery']>[0],
      Readonly<{
        artifactId: unknown
        expectedAutoNameStatus: unknown
        expectedTitleSource: unknown
        namingStatus: unknown
        now: string
        sessionId: number
      }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['recordSessionDelivery']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['recordAttemptFailed']>[0],
      Readonly<{
        attemptId: number
        now: string
        previousAttemptStatus: unknown
        providerRequestId: unknown
        reason: 'NOT_SENT' | 'PROVIDER_REJECTED'
      }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['recordAttemptFailed']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['recordTaskFailed']>[0],
      Readonly<{ now: string; reason: 'NOT_SENT' | 'PROVIDER_REJECTED'; taskId: number }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['recordTaskFailed']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['settleGenerationAllocation']>[0],
      Readonly<{
        allocationId: number
        isExpired: boolean
        now: string
        operation: 'capture' | 'release'
      }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['settleGenerationAllocation']>>, void>>,
  Assert<
    Equal<
      Parameters<WorkerWriter['settleGenerationReservation']>[0],
      Readonly<{
        now: string
        operation: 'capture' | 'release'
        previousReservationStatus: unknown
        reservationId: number
      }>
    >
  >,
  Assert<Equal<Awaited<ReturnType<WorkerWriter['settleGenerationReservation']>>, void>>,
]
