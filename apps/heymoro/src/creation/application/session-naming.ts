import type { ObjectStorage } from '../domain/media.js'
import type { NamingReader } from './generation-reader-types.js'
import type {
  NamingEngine,
  NamingEngineResult,
  NamingSession,
  NamingStatus,
  TitlePersistence,
  TitleRepository,
} from './session-naming-types.js'

import { GenerationError, generationTime, integer } from '../domain/generation.js'
import { MediaStorageError } from '../domain/media.js'
import { normalizeSessionTitle } from '../domain/session-title.js'
import { conflict } from './generation-worker-types.js'
import { readFirstNamingContext, readNamingSession } from './session-naming-context.js'

export type SessionNamingOptions = Readonly<{
  clock: () => string
  engine: NamingEngine | null
  engineTimeoutMs: number
  leaseMs: number
  persistence: TitlePersistence<NamingReader>
  storage: Pick<ObjectStorage, 'getVerified'>
}>

export function createSessionNaming({
  clock,
  engine,
  engineTimeoutMs,
  leaseMs,
  persistence,
  storage,
}: SessionNamingOptions) {
  if (
    !Number.isSafeInteger(engineTimeoutMs) ||
    engineTimeoutMs <= 0 ||
    engineTimeoutMs > 300_000 ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < engineTimeoutMs ||
    leaseMs > 600_000
  ) {
    throw new Error('Explicit bounded naming budget required.')
  }
  const read = ({ sessionId }: { sessionId: number }) =>
    persistence.read({ work: ({ reader }) => readNamingSession({ reader, sessionId }) })
  const mutate = <T>({
    session,
    work,
  }: {
    session: NamingSession
    work: (args: {
      now: string
      repository: TitleRepository<NamingReader>
      session: NamingSession
    }) => Promise<T>
  }) =>
    persistence.write({
      session,
      work: async ({ repository }) => {
        const current = await readNamingSession({ reader: repository, sessionId: session.id })
        if (current.userId !== session.userId) {
          conflict()
        }
        return work({ now: generationTime({ now: clock() }), repository, session: current })
      },
    })
  async function finish({
    result,
    session,
  }: {
    result: NamingEngineResult
    session: NamingSession
  }): Promise<NamingStatus> {
    return mutate({
      session,
      work: async ({ now, repository, session: current }) => {
        if (current.status !== 'sending' || current.startedAt !== session.startedAt) {
          return current.status
        }
        let title: string | undefined
        let status: NamingStatus
        if (current.titleSource === 'user') {
          status = 'skipped'
        } else if (Date.parse(now) >= Date.parse(session.startedAt!) + leaseMs) {
          status = 'unknown'
        } else if (result.kind === 'name') {
          try {
            title = normalizeSessionTitle({ value: result.name })
            status = 'succeeded'
          } catch {
            status = 'unknown'
          }
        } else {
          status = result.kind === 'not_sent' || result.kind === 'rejected' ? 'failed' : 'unknown'
        }
        await repository.updateSession({
          data: {
            autoNameStatus: status,
            ...(status === 'succeeded'
              ? ({ autoNamedAt: now, title, titleSource: 'ai' } as const)
              : {}),
            updatedAt: now,
            updatedBy: 'system:naming',
          },
          session: current,
        })
        return status
      },
    })
  }
  async function stopPending({ session }: { session: NamingSession }): Promise<NamingStatus> {
    return mutate({
      session,
      work: async ({ now, repository, session: current }) => {
        if (current.status !== 'pending') {
          return current.status
        }
        const status = current.titleSource === 'user' ? 'skipped' : 'failed'
        await repository.updateSession({
          data: { autoNameStatus: status, updatedAt: now, updatedBy: 'system:naming' },
          session: current,
        })
        return status
      },
    })
  }
  return Object.freeze({
    run: async ({ sessionId }: { sessionId: number }): Promise<NamingStatus> => {
      integer({ value: sessionId })
      const session = await read({ sessionId })
      if (session.status === 'sending') {
        if (
          Date.parse(generationTime({ now: clock() })) <
          Date.parse(session.startedAt!) + leaseMs
        ) {
          return 'sending'
        }
        return finish({ result: { kind: 'unknown', requestId: null }, session })
      }
      if (session.status !== 'pending') {
        return session.status
      }
      if (session.titleSource === 'user' || !engine) {
        return stopPending({ session })
      }
      let context: Awaited<ReturnType<typeof readFirstNamingContext>>
      let image: Awaited<ReturnType<ObjectStorage['getVerified']>>
      try {
        context = await persistence.read({
          work: ({ reader }) => readFirstNamingContext({ reader, session }),
        })
        // Both source fetch and provider request deliberately own no transaction or Redis resource.
        image = await storage.getVerified(context.source)
      } catch (error) {
        if (
          (error instanceof MediaStorageError && error.code === 'NOT_FOUND') ||
          (error instanceof GenerationError && error.code === 'NOT_FOUND')
        ) {
          return stopPending({ session })
        }
        throw error
      }
      let sender: NamingSession | null
      try {
        sender = await mutate({
          session,
          work: async ({ now, repository, session: current }) => {
            if (current.status !== 'pending') {
              return null
            }
            if (current.titleSource === 'user') {
              await repository.updateSession({
                data: { autoNameStatus: 'skipped', updatedAt: now, updatedBy: 'system:naming' },
                session: current,
              })
              return null
            }
            const checked = await readFirstNamingContext({ reader: repository, session: current })
            if (checked.fingerprint !== context.fingerprint) {
              conflict()
            }
            await repository.updateSession({
              data: {
                autoNameStartedAt: now,
                autoNameStatus: 'sending',
                updatedAt: now,
                updatedBy: 'system:naming',
              },
              session: current,
            })
            return { ...current, startedAt: now, status: 'sending' as const }
          },
        })
      } catch (error) {
        if (!persistence.isCommitUnknown({ error })) {
          throw error
        }
        // A read may establish committed sending, never permission to send after lost ACK.
        return (await read({ sessionId })).status
      }
      if (!sender) {
        return (await read({ sessionId })).status
      }
      if (
        Date.parse(generationTime({ now: clock() })) + engineTimeoutMs >
        Date.parse(sender.startedAt!) + leaseMs
      ) {
        return finish({ result: { kind: 'unknown', requestId: null }, session: sender })
      }
      let result: NamingEngineResult
      try {
        result = await callNamingEngine({
          args: { image: { bytes: image.bytes, mimeType: image.mimeType }, input: context.input },
          engine,
          engineTimeoutMs,
        })
      } catch {
        result = { kind: 'unknown', requestId: null }
      }
      return finish({ result, session: sender })
    },
  })
}

async function callNamingEngine({
  args,
  engine,
  engineTimeoutMs,
}: {
  args: Omit<Parameters<NamingEngine>[0], 'signal'>
  engine: NamingEngine
  engineTimeoutMs: number
}): Promise<NamingEngineResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result: unknown = await Promise.race([
      engine({ ...args, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Naming deadline exceeded.'))
        }, engineTimeoutMs)
      }),
    ])
    if (
      !result ||
      typeof result !== 'object' ||
      !('kind' in result) ||
      !['name', 'not_sent', 'rejected', 'unknown'].includes(String(result.kind)) ||
      !('requestId' in result) ||
      (result.requestId !== null &&
        (typeof result.requestId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(result.requestId))) ||
      (result.kind === 'name' && (!('name' in result) || typeof result.name !== 'string'))
    ) {
      throw new Error('Invalid naming response.')
    }
    return result as NamingEngineResult
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
