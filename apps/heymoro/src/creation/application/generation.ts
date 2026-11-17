import type {
  ExecutionConfiguration,
  ExecutionSnapshot,
  MediaFact,
  SubmissionResult,
} from '../domain/generation.js'
import type { CreationMode, TaskClientInput } from '../domain/input.js'
import type { QuoteBinding } from '../domain/quote.js'
import type { DraftMedia } from './draft.js'
import type { SubmissionContextReader } from './generation-reader-types.js'
import type {
  GenerateArgs,
  GenerationDependencies,
  GenerationDocument,
  RegenerateArgs,
  Scope,
  Submission,
} from './generation-types.js'

import { hashEffectiveTemplate } from '../domain/current-template.js'
import {
  assertExecutionSupported,
  compileExecution,
  GenerationError,
  generationTime,
  integer,
  text,
  validStorageKey,
  validStoragePart,
} from '../domain/generation.js'
import {
  hashCreationInput,
  hashTaskClientInput,
  normalizeTaskClientInput,
  validateCreationInput,
} from '../domain/input.js'
import { parsePublicTemplateConfig, validateHostCaps } from '../domain/template-config.js'
import {
  active,
  assertTaskEvidence,
  deleted,
  findRequest,
  ownedSession,
  resolveScope,
  singleCandidate,
  taskDTO,
  validateTaskSnapshot,
} from './generation-evidence.js'
import { validateReferenceMedia } from './input-validation.js'
import { reserveGenerationCredits } from './reservations.js'

export function createGenerationService({
  clock,
  execution: configured,
  hostCaps,
  isCompatible,
  quoteCodec,
  read,
  write,
}: GenerationDependencies) {
  const caps = validateHostCaps({ hostCaps })
  const execution: ExecutionConfiguration | null =
    configured === null ? null : structuredClone(configured)
  const quote = async ({
    args,
    operation,
  }: {
    args: GenerateArgs | RegenerateArgs
    operation: 'generate' | 'regenerate'
  }) => {
    assertUser({ userId: args.userId })
    if (!execution || !quoteCodec) {
      throw new GenerationError({ code: 'GENERATION_NOT_CONFIGURED' })
    }
    const result = await read({
      work: async ({ reader }) => {
        const now = generationTime({ now: clock() })
        await active({ reader, userId: args.userId })
        const scope = await resolveScope({ args, operation, reader })
        return prepare({ args, now, operation, reader, scope })
      },
    })
    const signed = await quoteCodec.issue({ binding: result.binding, now: result.now })
    return Object.freeze({
      costCredits: result.binding.costCredits,
      templateId: result.binding.templateId,
      ...signed,
    })
  }
  const prepare = async ({
    args,
    now,
    operation,
    reader,
    scope,
  }: {
    args: GenerateArgs | RegenerateArgs
    now: string
    operation: 'generate' | 'regenerate'
    reader: SubmissionContextReader
    scope: Scope
  }) => {
    const session = await ownedSession({ reader, sessionId: scope.sessionId, userId: args.userId })
    const templateId = integer({ value: session.templateId })
    const template = singleCandidate({
      candidates: await reader.findTemplateCandidates({ templateId }),
    })
    if (!template || deleted({ doc: template }) || template.status !== 'published') {
      throw new GenerationError({ code: 'TEMPLATE_UNAVAILABLE' })
    }
    if (template.kind !== session.mode || (session.mode !== 'effect' && session.mode !== 'free')) {
      throw integrity()
    }
    if (
      !isCompatible({
        minClientCapability: text({ value: template.minClientCapability }),
        schemaVersion: integer({ value: template.schemaVersion }),
      })
    ) {
      throw new GenerationError({ code: 'TEMPLATE_UNAVAILABLE' })
    }
    const mode: CreationMode = session.mode
    const source = scope.source
    // Current template rules govern new creation; historical variation retains its accepted input.
    const limits = source
      ? { ...caps, minImages: mode === 'effect' ? 1 : 0 }
      : parsePublicTemplateConfig({
          displayConfigJson: text({ value: template.displayConfigJson }),
          hostCaps: caps,
          inputSchemaJson: text({ value: template.inputSchemaJson }),
          kind: mode,
          schemaVersion: integer({ value: template.schemaVersion }),
        }).inputSchema
    const input = validateCreationInput({
      input: source?.input ?? (args as GenerateArgs).input,
      limits: {
        maxDescriptionLength: limits.maxDescriptionLength,
        maxImages: limits.maxImages,
        maxNotesLength: limits.maxNotesLength,
        minImages: limits.minImages,
      },
      mode,
      stage: 'submit',
    })
    let plan: Pick<ExecutionSnapshot, 'executionPlan' | 'storageOutput'>
    if (source) {
      if (source.templateId !== templateId || source.mode !== mode) {
        throw integrity()
      }
      if (!execution?.storageOutput) {
        throw new GenerationError({ code: 'GENERATION_NOT_CONFIGURED' })
      }
      assertExecutionSupported({
        execution,
        executionPlan: source.executionPlan,
        storageOutput: execution.storageOutput,
      })
      plan = { executionPlan: source.executionPlan, storageOutput: { ...execution.storageOutput } }
    } else {
      plan = compileExecution({
        execution,
        generationConfigJson: text({ value: template.generationConfigJson }),
      })
    }
    const costCredits = integer({ minimum: 0, value: template.costCredits })
    const configurationHash = hashEffectiveTemplate({
      costCredits,
      ...plan,
      inputSchema: limits,
      mode,
      templateId,
    })
    const executor = execution!.registry[plan.executionPlan.executorId]!
    const media = await validateReferenceMedia({
      input,
      limits,
      readMedia: async ({ mediaId }) => {
        const doc = singleCandidate({
          candidates: await reader.findMediaCandidates({ mediaId }),
        })
        if (!doc) {
          return null
        }
        return {
          id: integer({ value: doc.id }),
          doc,
          filesize: typeof doc.filesize === 'number' ? doc.filesize : null,
          isDeleted: deleted({ doc }),
          lifecycle: text({ value: doc.lifecycle }),
          mimeType: doc.mimeType == null ? null : text({ value: doc.mimeType }),
          owner: doc.owner == null ? null : integer({ value: doc.owner }),
          purpose: text({ value: doc.purpose }),
          visibility: text({ value: doc.visibility }),
        } satisfies { doc: GenerationDocument } & DraftMedia
      },
      userId: args.userId,
    })
    const facts = media.map(({ id, doc, filesize, mimeType }, index): MediaFact => {
      if (
        !executor.storageBackends.includes(String(doc.storageBackend)) ||
        !validStoragePart({ value: doc.storageBackend }) ||
        !validStoragePart({ value: doc.storageBucket }) ||
        !validStorageKey({ value: doc.storageName }) ||
        typeof doc.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(doc.sha256)
      ) {
        throw new GenerationError({ code: 'INPUT_INVALID' })
      }
      return {
        mediaId: id,
        mimeType: mimeType!,
        position: index + 1,
        sha256: doc.sha256,
        sizeBytes: filesize!,
        storageRef: {
          backend: text({ value: doc.storageBackend }),
          bucket: text({ value: doc.storageBucket }),
          key: text({ value: doc.storageName }),
        },
      }
    })
    if (
      source &&
      facts.some((fact, index) => !sameMediaFact({ left: fact, right: source.media[index]! }))
    ) {
      throw new GenerationError({ code: 'INPUT_INVALID' })
    }
    const clientInput = normalizeTaskClientInput({
      value:
        operation === 'generate'
          ? { input, operation, sessionId: scope.sessionId }
          : {
              operation,
              sessionId: scope.sessionId,
              sourceArtifactId: (args as RegenerateArgs).sourceArtifactId,
            },
    })
    const binding: QuoteBinding = {
      configurationHash,
      costCredits,
      purpose: operation,
      sessionId: scope.sessionId,
      templateId,
      userId: args.userId,
      ...(operation === 'generate'
        ? { inputHash: hashCreationInput({ input }) }
        : { sourceArtifactId: (args as RegenerateArgs).sourceArtifactId }),
    }
    return {
      binding,
      clientInput,
      input,
      now,
      scope,
      session,
      snapshot: {
        clientInput,
        input,
        mode,
        schemaVersion: 1 as const,
        templateId,
        ...plan,
        media: facts,
      },
    }
  }
  const submit = async ({
    args,
    operation,
  }: {
    args: (GenerateArgs | RegenerateArgs) & Submission
    operation: 'generate' | 'regenerate'
  }): Promise<SubmissionResult> => {
    assertUser({ userId: args.userId })
    if (
      typeof args.clientRequestId !== 'string' ||
      !args.clientRequestId.trim() ||
      args.clientRequestId.length > 128
    ) {
      throw new GenerationError({ code: 'INPUT_INVALID' })
    }
    // An existing task supplies trusted lock scope even when a source artifact or current config has since disappeared.
    const initial = await read({
      work: async ({ reader }) => {
        await active({ reader, userId: args.userId })
        const prior = await findRequest({
          clientRequestId: args.clientRequestId,
          reader,
          userId: args.userId,
        })
        if (prior) {
          const snapshot = validateTaskSnapshot({ task: prior })
          return {
            sessionId: snapshot.clientInput.sessionId,
            sourceTaskId:
              prior.sourceTaskId == null ? null : integer({ value: prior.sourceTaskId }),
          }
        }
        const scope = await resolveScope({ args, operation, reader })
        await ownedSession({ reader, sessionId: scope.sessionId, userId: args.userId })
        return scope
      },
    })
    const resources = [
      `session:${args.userId}:${initial.sessionId}`,
      ...(initial.sourceTaskId === null ? [] : [`task:${initial.sourceTaskId}`]),
      `wallet:${args.userId}`,
    ]
    return write({
      resources,
      work: async ({ repository }) => {
        const now = generationTime({ now: clock() })
        await active({ reader: repository, userId: args.userId })
        const prior = await findRequest({
          clientRequestId: args.clientRequestId,
          reader: repository,
          userId: args.userId,
        })
        if (prior) {
          const snapshot = validateTaskSnapshot({ task: prior })
          const expected = clientRequest({
            args,
            operation,
            sessionId: snapshot.clientInput.sessionId,
          })
          if (
            JSON.stringify(expected) !== JSON.stringify(snapshot.clientInput) ||
            hashTaskClientInput({ clientInput: expected }) !== prior.requestHash
          ) {
            throw new GenerationError({ code: 'IDEMPOTENCY_CONFLICT' })
          }
          await assertTaskEvidence({ reader: repository, snapshot, task: prior })
          return Object.freeze({ isNew: false, task: taskDTO({ snapshot, task: prior }) })
        }
        const scope = await resolveScope({ args, operation, reader: repository })
        if (scope.sessionId !== initial.sessionId || scope.sourceTaskId !== initial.sourceTaskId) {
          throw integrity()
        }
        const prepared = await prepare({ args, now, operation, reader: repository, scope })
        if (!quoteCodec) {
          throw new GenerationError({ code: 'GENERATION_NOT_CONFIGURED' })
        }
        const claims = await quoteCodec.verify({ now, token: args.quoteToken })
        if (
          Object.entries(prepared.binding).some(
            ([key, value]) => claims[key as keyof typeof claims] !== value,
          )
        ) {
          throw new GenerationError({ code: 'QUOTE_CHANGED' })
        }
        const blocked = await repository.findBlockingTaskCandidates({ sessionId: scope.sessionId })
        if (blocked.some((doc) => deleted({ doc }))) {
          throw integrity()
        }
        if (blocked.length) {
          throw new GenerationError({ code: 'GENERATION_IN_PROGRESS' })
        }
        const roundNo = integer({ value: prepared.session.nextRoundNo })
        if (!Number.isSafeInteger(roundNo + 1)) {
          throw integrity()
        }
        if (
          (await repository.findRoundCandidates({ roundNo, sessionId: scope.sessionId })).length !==
          0
        ) {
          throw integrity()
        }
        const snapshot: ExecutionSnapshot = {
          ...prepared.snapshot,
          quote: {
            costCredits: claims.costCredits,
            issuedAt: new Date(claims.iat * 1000).toISOString(),
            validUntil: new Date(claims.exp * 1000).toISOString(),
          },
        }
        const task = await repository.insertQueuedTask({
          clientRequestId: args.clientRequestId,
          costCredits: claims.costCredits,
          description: prepared.input.description,
          executionSnapshotJson: JSON.stringify(snapshot),
          now,
          requestHash: hashTaskClientInput({ clientInput: prepared.clientInput }),
          roundNo,
          sessionId: scope.sessionId,
          sourceTaskId: scope.sourceTaskId,
          templateId: prepared.binding.templateId,
          userId: args.userId,
          userNotes: prepared.input.userNotes,
        })
        const taskId = integer({ value: task.id })
        await repository.insertOrderedTaskInputs({
          inputs: snapshot.media.map((fact) => ({
            contentSha256: fact.sha256,
            mediaId: fact.mediaId,
            position: fact.position,
          })),
          now,
          taskId,
          userId: args.userId,
        })
        await reserveGenerationCredits({
          costCredits: claims.costCredits,
          now,
          repository,
          taskId,
          userId: args.userId,
        })
        await repository.advanceSessionRound({
          nextRoundNo: roundNo + 1,
          now,
          sessionId: scope.sessionId,
          userId: args.userId,
        })
        await repository.enqueueGeneration({ taskId })
        return Object.freeze({ isNew: true, task: taskDTO({ snapshot, task }) })
      },
    })
  }
  return Object.freeze({
    quoteGenerate: (args: GenerateArgs) => quote({ args, operation: 'generate' }),
    quoteRegeneration: (args: RegenerateArgs) => quote({ args, operation: 'regenerate' }),
    submitGenerate: (args: GenerateArgs & Submission) => submit({ args, operation: 'generate' }),
    submitRegeneration: (args: RegenerateArgs & Submission) =>
      submit({ args, operation: 'regenerate' }),
  })
}
function assertUser({ userId }: { userId: number }) {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new GenerationError({ code: 'UNAUTHENTICATED' })
  }
}
function integrity() {
  return new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
}

function clientRequest({
  args,
  operation,
  sessionId,
}: {
  args: GenerateArgs | RegenerateArgs
  operation: 'generate' | 'regenerate'
  sessionId: number
}): TaskClientInput {
  return normalizeTaskClientInput({
    value:
      operation === 'generate'
        ? {
            input: (args as GenerateArgs).input,
            operation,
            sessionId: (args as GenerateArgs).sessionId,
          }
        : { operation, sessionId, sourceArtifactId: (args as RegenerateArgs).sourceArtifactId },
  })
}
function sameMediaFact({ left, right }: { left: MediaFact; right: MediaFact }) {
  return (
    left.mediaId === right.mediaId &&
    left.position === right.position &&
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes &&
    left.mimeType === right.mimeType &&
    left.storageRef.backend === right.storageRef.backend &&
    left.storageRef.bucket === right.storageRef.bucket &&
    left.storageRef.key === right.storageRef.key
  )
}
