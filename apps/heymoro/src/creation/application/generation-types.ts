import type { ExecutionConfiguration, ExecutionSnapshot } from '../domain/generation.js'
import type { QuoteCodec } from '../domain/quote.js'
import type { InputSchema } from '../domain/template-config.js'
import type { SubmissionContextReader, UserAuthorizationReader } from './generation-reader-types.js'
import type { GenerationReservationRepository } from './reservations.js'

export type GenerationDocument = Record<string, unknown>
export type GenerationSubmissionWriter = Readonly<{
  advanceSessionRound: (
    args: Readonly<{
      nextRoundNo: number
      now: string
      sessionId: number
      userId: number
    }>,
  ) => Promise<void>
  enqueueGeneration: (args: Readonly<{ taskId: number }>) => Promise<void>
  insertOrderedTaskInputs: (
    args: Readonly<{
      inputs: readonly Readonly<{ contentSha256: string; mediaId: number; position: number }>[]
      now: string
      taskId: number
      userId: number
    }>,
  ) => Promise<void>
  insertQueuedTask: (
    args: Readonly<{
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
    }>,
  ) => Promise<
    Readonly<{
      clientRequestId: unknown
      costCredits: unknown
      errorCode: unknown
      id: unknown
      roundNo: unknown
      sessionId: unknown
      sourceTaskId: unknown
      status: unknown
      templateId: unknown
    }>
  >
}>
export type GenerationRepository = GenerationReservationRepository &
  GenerationSubmissionWriter &
  SubmissionContextReader &
  UserAuthorizationReader
export type GenerateArgs = { input: unknown; sessionId: number; userId: number }
export type RegenerateArgs = { sourceArtifactId: number; userId: number }
export type Submission = { clientRequestId: string; quoteToken: string }
export type GenerationDependencies = Readonly<{
  clock: () => string
  execution: ExecutionConfiguration | null
  hostCaps: InputSchema
  isCompatible: (args: { minClientCapability: string; schemaVersion: number }) => boolean
  quoteCodec: null | QuoteCodec
  read: <T>(args: {
    work: (args: { reader: SubmissionContextReader & UserAuthorizationReader }) => Promise<T>
  }) => Promise<T>
  write: <T>(args: {
    resources: readonly string[]
    work: (args: { repository: GenerationRepository }) => Promise<T>
  }) => Promise<T>
}>
export type Scope = { sessionId: number; source?: ExecutionSnapshot; sourceTaskId: null | number }
