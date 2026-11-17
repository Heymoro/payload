import type { ExecutionConfiguration, ExecutionPlan } from '../domain/generation.js'
import type { ImageLimits, ImageValidator, VerifiedImage } from '../domain/image.js'
import type { ObjectStorage, StorageRef, StoredImage } from '../domain/media.js'
import type { TrustedClose } from './generation-settlement.js'
import type {
  AcceptedGeneration,
  WorkerPersistence,
  WorkerRepository,
} from './generation-worker-types.js'

import {
  assertExecutionSupported,
  generationResultKey,
  generationTime,
  integer,
} from '../domain/generation.js'
import { validateImageLimits } from '../domain/image.js'
import { MediaStorageError } from '../domain/media.js'
import { deleted, singleCandidate } from './generation-evidence.js'
import { createGenerationSettlement } from './generation-settlement.js'
import {
  assertClosed,
  assertDelivered,
  assertFailed,
  assertOutput,
} from './generation-settlement-evidence.js'
import { conflict, readAcceptedGeneration, workerResources } from './generation-worker-types.js'

export type GenerationEngineResult = Readonly<
  { requestId: null | string } & (
    | { bytes: Uint8Array; contentType: string; kind: 'output' }
    | { kind: 'not_sent' | 'rejected' | 'unknown' }
  )
>
/** No SQL, Redis, object keys, URLs, host credentials or caller request crosses this boundary. */
export type GenerationEngine = (args: {
  executionPlan: ExecutionPlan
  images: readonly Readonly<{ bytes: Uint8Array; mimeType: string }>[]
  input: Readonly<{ description: string; userNotes: string }>
  signal: AbortSignal
}) => Promise<GenerationEngineResult>
export type GenerationWorkerOptions = Readonly<{
  clock: () => string
  engine: GenerationEngine | null
  engineTimeoutMs: number
  execution: ExecutionConfiguration | null
  imageLimits: ImageLimits
  leaseMs: number
  persistence: WorkerPersistence
  storage: ObjectStorage
  trustedClose: null | TrustedClose
  validateImage: ImageValidator
}>

export function createGenerationWorker({
  clock,
  engine,
  engineTimeoutMs,
  execution: configured,
  imageLimits,
  leaseMs,
  persistence,
  storage,
  trustedClose,
  validateImage,
}: GenerationWorkerOptions) {
  if (typeof validateImage !== 'function') {
    throw new Error('Explicit image validator required.')
  }
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <= 0 ||
    leaseMs > 600_000 ||
    !Number.isSafeInteger(engineTimeoutMs) ||
    engineTimeoutMs <= 0 ||
    engineTimeoutMs > 300_000 ||
    engineTimeoutMs > leaseMs
  ) {
    throw new Error('Explicit bounded execution budget required.')
  }
  validateImageLimits({ limits: imageLimits })
  imageLimits = Object.freeze({
    ...imageLimits,
    allowedMimeTypes: Object.freeze([...imageLimits.allowedMimeTypes]),
  })
  const execution = configured ? structuredClone(configured) : null
  const settlement = createGenerationSettlement({ clock, persistence, trustedClose })
  const read = ({ taskId }: { taskId: number }) =>
    persistence.read({ work: ({ reader }) => readAcceptedGeneration({ reader, taskId }) })
  async function mutate<T>({
    state,
    work,
  }: {
    state: AcceptedGeneration
    work: (args: {
      now: string
      repository: WorkerRepository
      state: AcceptedGeneration
    }) => Promise<T>
  }) {
    return persistence.write({
      resources: workerResources({ task: state.task }),
      work: async ({ repository }) =>
        work({
          now: generationTime({ now: clock() }),
          repository,
          state: await readAcceptedGeneration({
            reader: repository,
            taskId: integer({ value: state.task.id }),
          }),
        }),
    })
  }
  async function unknown({
    requestId = null,
    state,
  }: {
    requestId?: null | string
    state: AcceptedGeneration
  }) {
    return mutate({
      state,
      work: async ({ now, repository, state: current }) => {
        if (current.attempt?.id !== state.attempt?.id) {
          conflict()
        }
        if (
          current.task.status === 'closed' ||
          current.task.status === 'succeeded' ||
          current.attempt?.status === 'output_ready'
        ) {
          return
        }
        if (!current.attempt || !['sending', 'unknown'].includes(String(current.attempt.status))) {
          conflict()
        }
        await repository.recordAttemptProviderUnknown({
          attemptId: integer({ value: current.attempt.id }),
          now,
          previousAttemptStatus: current.attempt.status,
          providerRequestId: requestId ?? current.attempt.providerRequestId,
        })
        await repository.recordTaskProviderUnknown({
          now,
          previousTaskStatus: current.task.status,
          taskId: integer({ value: current.task.id }),
        })
      },
    })
  }
  async function outputReady({
    facts,
    requestId = null,
    state,
  }: {
    facts: StoredImage
    requestId?: null | string
    state: AcceptedGeneration
  }) {
    storage.assertVerified({ facts })
    const taskId = integer({ value: state.task.id })
    const attemptId = integer({ value: state.attempt?.id })
    try {
      return await mutate({
        state,
        work: async ({ now, repository, state: current }) => {
          if (current.attempt?.id !== attemptId) {
            conflict()
          }
          const attempt = current.attempt
          if (
            !['output_ready', 'sending', 'succeeded', 'unknown'].includes(String(attempt.status))
          ) {
            conflict()
          }
          const expected = {
            ...attempt,
            resultSha256: facts.sha256,
            resultStorageBackend: facts.ref.backend,
            resultStorageBucket: facts.ref.bucket,
            resultStorageKey: facts.ref.key,
          }
          assertOutput({ facts, state: { ...current, attempt: expected } })
          if (attempt.resultSha256 != null) {
            assertOutput({ facts, state: current })
          }
          if (current.task.status === 'succeeded') {
            return
          }
          if (current.task.status === 'closed') {
            await assertClosed({ reader: repository, state: current })
          }
          await repository.recordAttemptOutput({
            attemptId,
            facts,
            isClosed: current.task.status === 'closed',
            now,
            previousAttemptStatus: attempt.status,
            providerRequestId: requestId ?? attempt.providerRequestId,
          })
        },
      })
    } catch (error) {
      if (!persistence.isCommitUnknown({ error })) {
        throw error
      }
      const current = await read({ taskId })
      if (
        current.attempt?.id !== attemptId ||
        !['output_ready', 'succeeded', 'unknown'].includes(String(current.attempt.status))
      ) {
        throw error
      }
      assertOutput({ facts, state: current })
    }
  }
  async function recover({ state }: { state: AcceptedGeneration }) {
    if (!state.attempt) {
      conflict()
    }
    const taskId = integer({ value: state.task.id })
    const attemptId = integer({ value: state.attempt.id })
    const result = await storage.findAttemptCandidates({
      attemptId,
      maxBytes: imageLimits.maxBytes,
      maxCandidates: 2,
      maxPages: 4,
      storageOutput: state.snapshot.storageOutput,
      taskId,
    })
    if (result.status === 'complete' && result.candidates.length === 1) {
      const facts = result.candidates[0]!
      await outputReady({ facts, state })
      return settlement.deliver({ attemptId, facts, taskId })
    }
    if (state.attempt.status === 'sending' && String(state.attempt.leaseUntil) <= clock()) {
      await unknown({ state })
    }
    return 'pending' as const
  }
  return Object.freeze({
    closeUnknown: settlement.closeUnknown,
    recoverOnly: async ({ attemptId, taskId }: { attemptId: number; taskId: number }) => {
      integer({ value: attemptId })
      const state = await read({ taskId })
      if (state.attempt?.id !== attemptId) {
        conflict()
      }
      if (state.task.status === 'succeeded') {
        await persistence.read({
          work: async ({ reader }) => {
            const current = await readAcceptedGeneration({ reader, taskId })
            if (current.attempt?.id !== attemptId) {
              conflict()
            }
            await assertDelivered({ reader, state: current })
          },
        })
        return 'succeeded' as const
      }
      if (state.task.status === 'closed') {
        await persistence.read({
          work: async ({ reader }) => {
            const current = await readAcceptedGeneration({ reader, taskId })
            if (current.attempt?.id !== attemptId) {
              conflict()
            }
            await assertClosed({ reader, state: current })
          },
        })
        return 'closed' as const
      }
      if (
        !['running', 'unknown'].includes(String(state.task.status)) ||
        !['output_ready', 'sending', 'unknown'].includes(String(state.attempt?.status))
      ) {
        conflict()
      }
      return recover({ state })
    },
    run: async ({ taskId }: { taskId: number }) => {
      let state = await read({ taskId })
      if (state.task.status === 'succeeded') {
        return persistence.read({
          work: async ({ reader }) => {
            const current = await readAcceptedGeneration({ reader, taskId })
            await assertDelivered({ reader, state: current })
            return 'succeeded' as const
          },
        })
      }
      if (state.task.status === 'closed') {
        return persistence.read({
          work: async ({ reader }) => {
            const current = await readAcceptedGeneration({ reader, taskId })
            await assertClosed({ reader, state: current })
            return 'closed' as const
          },
        })
      }
      if (state.task.status === 'failed') {
        return persistence.read({
          work: async ({ reader }) => {
            const current = await readAcceptedGeneration({ reader, taskId })
            await assertFailed({ reader, state: current })
            return 'failed' as const
          },
        })
      }
      if (state.task.status === 'cancelled') {
        return 'cancelled' as const
      }
      if (
        state.attempt &&
        ['output_ready', 'sending', 'unknown'].includes(String(state.attempt.status))
      ) {
        return recover({ state })
      }
      // Only the invocation receiving this confirmed prepared commit is a potential sender.
      const attemptId = await mutate({
        state,
        work: async ({ now, repository, state: current }) => {
          if (!['queued', 'running'].includes(String(current.task.status))) {
            return null
          }
          const previous = current.attempt
          if (previous) {
            if (
              previous.status !== 'prepared' ||
              typeof previous.leaseUntil !== 'string' ||
              previous.leaseUntil > now
            ) {
              return null
            }
            await repository.expirePreparedAttempt({
              attemptId: integer({ value: previous.id }),
              now,
            })
          }
          const created = await repository.insertPreparedAttempt({
            attemptNo: current.attempts.length + 1,
            leaseUntil: new Date(Date.parse(now) + leaseMs).toISOString(),
            model: current.snapshot.executionPlan.model,
            now,
            provider: current.snapshot.executionPlan.provider,
            taskId,
          })
          await repository.recordTaskRunning({
            now,
            previousTaskStatus: current.task.status,
            startedAt: current.task.startedAt ?? now,
            taskId,
          })
          return integer({ value: created.id })
        },
      })
      if (attemptId === null) {
        return 'pending' as const
      }
      state = await read({ taskId })
      let images: VerifiedImage[]
      try {
        if (!engine) {
          throw new Error('No engine configured.')
        }
        assertExecutionSupported({
          execution,
          executionPlan: state.snapshot.executionPlan,
          storageOutput: state.snapshot.storageOutput,
        })
        const sources = await persistence.read({
          work: async ({ reader }) => {
            const current = await readAcceptedGeneration({ reader, taskId })
            if (current.attempt?.id !== attemptId || current.attempt.status !== 'prepared') {
              conflict()
            }
            const sources: {
              expected: VerifiedImage
              ref: StorageRef
            }[] = []
            for (const fact of current.snapshot.media) {
              const doc = singleCandidate({
                candidates: await reader.findMediaCandidates({ mediaId: fact.mediaId }),
              })
              if (
                !doc ||
                deleted({ doc }) ||
                doc.owner !== current.task.userId ||
                doc.lifecycle !== 'active' ||
                doc.visibility !== 'private' ||
                !['artifact', 'reference'].includes(String(doc.purpose)) ||
                doc.storageBackend !== fact.storageRef.backend ||
                doc.storageBucket !== fact.storageRef.bucket ||
                doc.storageName !== fact.storageRef.key ||
                doc.sha256 !== fact.sha256 ||
                doc.filesize !== fact.sizeBytes ||
                doc.mimeType !== fact.mimeType
              ) {
                conflict()
              }
              sources.push({
                expected: {
                  bytes: Buffer.alloc(0),
                  filesize: fact.sizeBytes,
                  height: integer({ value: doc.height }),
                  mimeType: fact.mimeType,
                  sha256: fact.sha256,
                  width: integer({ value: doc.width }),
                },
                ref: fact.storageRef,
              })
            }
            return sources
          },
        })
        images = []
        for (const source of sources) {
          images.push(await storage.getVerified(source))
        }
      } catch (error) {
        if (error instanceof MediaStorageError && error.code === 'NOT_FOUND') {
          return settlement.fail({ attemptId, reason: 'NOT_SENT', taskId })
        }
        // Only deterministic local configuration/input failures mean definitely not sent.
        if (
          error instanceof Error &&
          (error.message === 'No engine configured.' ||
            ('code' in error && error.code === 'GENERATION_NOT_CONFIGURED'))
        ) {
          return settlement.fail({ attemptId, reason: 'NOT_SENT', taskId })
        }
        throw error
      }
      const sent = await mutate({
        state,
        work: async ({ now, repository, state: current }) => {
          if (
            current.task.status !== 'running' ||
            current.attempt?.id !== attemptId ||
            current.attempt.status !== 'prepared' ||
            String(current.attempt.leaseUntil) <= now
          ) {
            return false
          }
          await repository.recordAttemptSending({ attemptId, now })
          return true
        },
      })
      if (!sent) {
        return 'pending' as const
      }
      state = await read({ taskId })
      if (state.attempt?.id !== attemptId || state.attempt.status !== 'sending') {
        return 'pending' as const
      }
      if (Date.parse(clock()) + engineTimeoutMs > Date.parse(String(state.attempt.leaseUntil))) {
        await unknown({ state })
        return 'unknown' as const
      }
      let result: GenerationEngineResult
      try {
        result = await callEngine({
          args: {
            executionPlan: structuredClone(state.snapshot.executionPlan),
            images: images.map(({ bytes, mimeType }) => ({ bytes, mimeType })),
            input: {
              description: state.snapshot.input.description,
              userNotes: state.snapshot.input.userNotes,
            },
          },
          engine: engine!,
          engineTimeoutMs,
        })
      } catch {
        await unknown({ state })
        return 'unknown' as const
      }
      if (result.kind === 'unknown') {
        await unknown({ requestId: result.requestId, state })
        return 'unknown' as const
      }
      if (result.kind === 'not_sent' || result.kind === 'rejected') {
        return settlement.fail({
          attemptId,
          reason: result.kind === 'not_sent' ? 'NOT_SENT' : 'PROVIDER_REJECTED',
          requestId: result.requestId,
          taskId,
        })
      }
      if (result.kind !== 'output') {
        conflict()
      }
      let facts: StoredImage
      try {
        const image = await validateImage({
          declaredMimeType: result.contentType,
          input: result.bytes,
          limits: imageLimits,
        })
        facts = await storage.putImmutable({
          bytes: image.bytes,
          contentType: image.mimeType,
          ref: {
            backend: state.snapshot.storageOutput.backend,
            bucket: state.snapshot.storageOutput.bucket,
            key: generationResultKey({
              attemptId,
              keyRule: state.snapshot.storageOutput.keyRule,
              sha256: image.sha256,
              taskId,
            }),
          },
        })
      } catch {
        await unknown({ requestId: result.requestId, state })
        return 'unknown' as const
      }
      await outputReady({ facts, requestId: result.requestId, state })
      return settlement.deliver({ attemptId, facts, taskId })
    },
  })
}
async function callEngine({
  args,
  engine,
  engineTimeoutMs,
}: {
  args: Omit<Parameters<GenerationEngine>[0], 'signal'>
  engine: GenerationEngine
  engineTimeoutMs: number
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  try {
    const result: unknown = await Promise.race([
      engine({ ...args, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Execution deadline exceeded.'))
        }, engineTimeoutMs)
      }),
    ])
    if (
      !result ||
      typeof result !== 'object' ||
      !('kind' in result) ||
      !['not_sent', 'output', 'rejected', 'unknown'].includes(String(result.kind)) ||
      !('requestId' in result) ||
      (result.requestId !== null &&
        (typeof result.requestId !== 'string' || result.requestId.length > 128)) ||
      (result.kind === 'output' &&
        (!('bytes' in result) ||
          !(result.bytes instanceof Uint8Array) ||
          !('contentType' in result) ||
          typeof result.contentType !== 'string'))
    ) {
      throw new Error('Invalid engine response.')
    }
    return result as GenerationEngineResult
  } finally {
    clearTimeout(timer)
  }
}
