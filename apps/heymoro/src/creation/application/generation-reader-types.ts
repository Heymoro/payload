export type ArtifactFact = Readonly<{
  id: unknown
  isDeleted: unknown
  mediaId: unknown
  outputIndex: unknown
  sessionId: unknown
  taskId: unknown
  userId: unknown
}>
export type SessionFact = Readonly<{
  autoNamedAt: unknown
  autoNameStartedAt: unknown
  autoNameStatus: unknown
  coverArtifactId: unknown
  id: unknown
  isDeleted: unknown
  lastActivityAt: unknown
  mode: unknown
  nextRoundNo: unknown
  templateId: unknown
  title: unknown
  titleSource: unknown
  userId: unknown
}>
export type TemplateFact = Readonly<{
  costCredits: unknown
  displayConfigJson: unknown
  generationConfigJson: unknown
  id: unknown
  inputSchemaJson: unknown
  isDeleted: unknown
  kind: unknown
  minClientCapability: unknown
  schemaVersion: unknown
  status: unknown
}>
export type AccountFact = Readonly<{
  availableCredits: unknown
  id: unknown
  isDeleted: unknown
  reservedCredits: unknown
  userId: unknown
}>
export type AllocationFact = Readonly<{
  amountCredits: unknown
  grantId: unknown
  id: unknown
  isDeleted: unknown
  reservationId: unknown
  status: unknown
}>
export type GrantFact = Readonly<{
  accountId: unknown
  availableCredits: unknown
  consumedCredits: unknown
  expiredCredits: unknown
  expiresAt: unknown
  grantKey: unknown
  id: unknown
  isDeleted: unknown
  issuedCredits: unknown
  reservedCredits: unknown
  revokedCredits: unknown
  sourceId: unknown
  sourceType: unknown
  userId: unknown
  validFrom: unknown
}>
export type FinancialEventFact = Readonly<{
  accountId: unknown
  amountCredits: unknown
  availableDelta: unknown
  consumedDelta: unknown
  eventKey: unknown
  expiredDelta: unknown
  grantId: unknown
  id: unknown
  isDeleted: unknown
  operation: unknown
  reasonCode: unknown
  reservationId: unknown
  reservedDelta: unknown
  revokedDelta: unknown
  userId: unknown
}>
export type ReservationFact = Readonly<{
  accountId: unknown
  amountCredits: unknown
  id: unknown
  isDeleted: unknown
  reservationKey: unknown
  status: unknown
  taskId: unknown
  userId: unknown
}>
export type AttemptFact = Readonly<{
  attemptNo: unknown
  errorCode: unknown
  finishedAt: unknown
  id: unknown
  isDeleted: unknown
  leaseUntil: unknown
  model: unknown
  provider: unknown
  providerRequestId: unknown
  resultSha256: unknown
  resultStorageBackend: unknown
  resultStorageBucket: unknown
  resultStorageKey: unknown
  startedAt: unknown
  status: unknown
  taskId: unknown
}>
export type CloseAuditFact = Readonly<{
  action: unknown
  actorId: unknown
  actorType: unknown
  afterState: unknown
  beforeState: unknown
  correlationId: unknown
  id: unknown
  isDeleted: unknown
  requestId: unknown
  resourceId: unknown
  resourceType: unknown
  summary: unknown
}>
export type TaskInputFact = Readonly<{
  contentSha256: unknown
  id: unknown
  isDeleted: unknown
  mediaId: unknown
  position: unknown
  taskId: unknown
  userId: unknown
}>
export type TaskFact = Readonly<{
  clientRequestId: unknown
  costCredits: unknown
  description: unknown
  errorCode: unknown
  executionSnapshotJson: unknown
  finishedAt: unknown
  id: unknown
  isDeleted: unknown
  requestHash: unknown
  roundNo: unknown
  sessionId: unknown
  sourceTaskId: unknown
  startedAt: unknown
  status: unknown
  templateId: unknown
  userId: unknown
  userNotes: unknown
}>
export type MediaFact = Readonly<{
  filesize: unknown
  height: unknown
  id: unknown
  isDeleted: unknown
  lifecycle: unknown
  mimeType: unknown
  owner: unknown
  purpose: unknown
  sha256: unknown
  storageBackend: unknown
  storageBucket: unknown
  storageName: unknown
  visibility: unknown
  width: unknown
}>
export type UserFact = Readonly<{
  id: unknown
  isDeleted: unknown
  status: unknown
}>
type ReaderOperations = Readonly<{
  findAllocationCandidates: (args: {
    grantId: number
    reservationId: number
  }) => Promise<readonly AllocationFact[]>
  findArtifactCandidates: (args: { artifactId: number }) => Promise<readonly ArtifactFact[]>
  findBlockingTaskCandidates: (args: { sessionId: number }) => Promise<readonly TaskFact[]>
  findCloseOperationConflicts: (args: {
    operationId: string
    taskId: number
  }) => Promise<readonly CloseAuditFact[]>
  findFinancialEventCandidates: (args: {
    eventKey: string
  }) => Promise<readonly FinancialEventFact[]>
  findGenerationReservationCandidates: (args: {
    taskId: number
  }) => Promise<readonly ReservationFact[]>
  findGrantCandidates: (args: { grantId: number }) => Promise<readonly GrantFact[]>
  findGrantKeyCandidates: (args: { grantKey: string }) => Promise<readonly GrantFact[]>
  findGrantKeysCandidates: (args: { grantKeys: readonly string[] }) => Promise<readonly GrantFact[]>
  findMediaCandidates: (args: { mediaId: number }) => Promise<readonly MediaFact[]>
  findMediaLocationCandidates: (args: {
    ref: Readonly<{ backend: string; bucket: string; key: string }>
  }) => Promise<readonly MediaFact[]>
  findOutputIdentityCandidates: (args: {
    outputIndex: number
    taskId: number
  }) => Promise<readonly ArtifactFact[]>
  findOwnerAccountCandidates: (args: { userId: number }) => Promise<readonly AccountFact[]>
  findRequestCandidates: (args: {
    clientRequestId: string
    userId: number
  }) => Promise<readonly TaskFact[]>
  findReservationAccountCandidates: (args: {
    accountId: number
    userId: number
  }) => Promise<readonly AccountFact[]>
  findRoundCandidates: (args: {
    roundNo: number
    sessionId: number
  }) => Promise<readonly TaskFact[]>
  findSessionCandidates: (args: { sessionId: number }) => Promise<readonly SessionFact[]>
  findTaskArtifactCandidates: (args: { taskId: number }) => Promise<readonly ArtifactFact[]>
  findTaskCandidates: (args: { taskId: number }) => Promise<readonly TaskFact[]>
  findTaskCloseAuditCandidates: (args: { taskId: number }) => Promise<readonly CloseAuditFact[]>
  findTaskReservationCandidates: (args: { taskId: number }) => Promise<readonly ReservationFact[]>
  findTemplateCandidates: (args: { templateId: number }) => Promise<readonly TemplateFact[]>
  findUserCandidates: (args: { userId: number }) => Promise<readonly UserFact[]>
  readFirstSessionArtifact: (args: { sessionId: number }) => Promise<readonly ArtifactFact[]>
  readGenerationFinancialEvidence: (args: {
    reservationId: number
    taskId: number
  }) => Promise<readonly FinancialEventFact[]>
  readRelatedGrants: (args: { accountId: number; userId: number }) => Promise<readonly GrantFact[]>
  readReservationAllocations: (args: {
    reservationId: number
  }) => Promise<readonly AllocationFact[]>
  readTaskArtifacts: (args: { taskId: number }) => Promise<readonly ArtifactFact[]>
  readTaskAttempts: (args: { taskId: number }) => Promise<readonly AttemptFact[]>
  readTaskInputs: (args: { taskId: number }) => Promise<readonly TaskInputFact[]>
}>
export type UserAuthorizationReader = Pick<ReaderOperations, 'findUserCandidates'>
export type SessionContextReader = Pick<ReaderOperations, 'findSessionCandidates'>
export type TaskEvidenceReader = Pick<
  ReaderOperations,
  | 'findFinancialEventCandidates'
  | 'findGenerationReservationCandidates'
  | 'findGrantCandidates'
  | 'findGrantKeyCandidates'
  | 'findReservationAccountCandidates'
  | 'findSessionCandidates'
  | 'readGenerationFinancialEvidence'
  | 'readReservationAllocations'
  | 'readTaskInputs'
>
export type AcceptedGenerationReader = Pick<
  ReaderOperations,
  | 'findGrantKeysCandidates'
  | 'findOwnerAccountCandidates'
  | 'findTaskCandidates'
  | 'readRelatedGrants'
  | 'readTaskAttempts'
> &
  TaskEvidenceReader
export type DeliveryEvidenceReader = Pick<
  ReaderOperations,
  | 'findMediaCandidates'
  | 'findMediaLocationCandidates'
  | 'findTaskArtifactCandidates'
  | 'findTaskCloseAuditCandidates'
  | 'readTaskArtifacts'
>
export type SubmissionContextReader = Pick<
  ReaderOperations,
  | 'findArtifactCandidates'
  | 'findBlockingTaskCandidates'
  | 'findMediaCandidates'
  | 'findOutputIdentityCandidates'
  | 'findRequestCandidates'
  | 'findRoundCandidates'
  | 'findTaskCandidates'
  | 'findTemplateCandidates'
> &
  TaskEvidenceReader
export type NamingReader = AcceptedGenerationReader &
  DeliveryEvidenceReader &
  Pick<ReaderOperations, 'readFirstSessionArtifact'> &
  SessionContextReader
export type RenameReader = SessionContextReader & UserAuthorizationReader
export type GenerationReader = ReaderOperations
