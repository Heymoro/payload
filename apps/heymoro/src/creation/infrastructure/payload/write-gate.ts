import type { CollectionBeforeOperationHook, PayloadRequest } from 'payload'

export type CreationTransactionBinding = Readonly<{
  abort: () => void
  assert: () => void
  assertCommit: () => void
  assertIdle: () => void
  close: () => void
  run: <T>(args: { work: () => Promise<T> }) => Promise<T>
  seal: () => void
  settle: () => Promise<void>
}>

export type CreationWriteGate = Readonly<{
  abort: (args: { req: PayloadRequest }) => void
  assert: (args: { req: PayloadRequest }) => void
  beforeOperation: CollectionBeforeOperationHook
  bind: (args: {
    assertLease: () => void
    req: PayloadRequest
    sessions: Record<string, { db: object }>
    transaction: object
    transactionID: string
  }) => CreationTransactionBinding
  run: <T>(args: { req: PayloadRequest; work: () => Promise<T> }) => Promise<T>
}>

/** The capability is request identity in a private registry, never a context flag. */
export function createCreationWriteGate(): CreationWriteGate {
  const capabilities = new WeakMap<PayloadRequest, CreationTransactionBinding>()
  const assert = ({ req }: { req: PayloadRequest }) => {
    const capability = capabilities.get(req)
    if (!capability) {
      throw new Error('Creation write capability is required.')
    }
    capability.assert()
  }
  const beforeOperation: CollectionBeforeOperationHook = ({ args, operation, req }) => {
    if (operation === 'delete') {
      throw new Error('Physical creation deletion is forbidden.')
    }
    if (operation === 'create' || operation === 'update') {
      assert({ req })
    }
    return args
  }

  return Object.freeze({
    abort: ({ req }) => capabilities.get(req)?.abort(),
    assert,
    beforeOperation,
    bind: ({ assertLease, req, sessions, transaction, transactionID }) => {
      if (capabilities.has(req)) {
        throw new Error('Request already owns a creation capability.')
      }
      let isAborted = false
      let isSealed = false
      let pending: Promise<unknown> | undefined
      const abort = () => {
        isAborted = true
      }
      const assertTransaction = () => {
        try {
          if (
            isAborted ||
            req.transactionID !== transactionID ||
            sessions[transactionID]?.db !== transaction
          ) {
            throw new Error('Creation transaction is permanently aborted or detached.')
          }
          assertLease()
        } catch (error) {
          abort()
          throw error
        }
      }
      const binding: CreationTransactionBinding = Object.freeze({
        abort,
        assert: () => {
          // A rejected late operation must not change an already-started commit's outcome.
          if (isSealed) {
            throw new Error('Creation transaction is sealed to new operations.')
          }
          assertTransaction()
        },
        assertCommit: () => {
          if (!isSealed) {
            abort()
            throw new Error('Creation commit requires a sealed transaction.')
          }
          binding.assertIdle()
        },
        assertIdle: () => {
          if (pending) {
            abort()
            throw new Error('Creation transaction has unawaited operations.')
          }
          assertTransaction()
        },
        close: () => {
          abort()
          capabilities.delete(req)
        },
        run: async ({ work }) => {
          binding.assert()
          if (pending) {
            abort()
            await pending.catch(() => undefined)
            throw new Error('Concurrent creation Local API operations are forbidden.')
          }
          const operation = Promise.resolve().then(async () => {
            try {
              binding.assert()
              const result = await work()
              binding.assert()
              return result
            } catch (error) {
              abort()
              throw error
            }
          })
          pending = operation
          try {
            return await operation
          } finally {
            pending = undefined
          }
        },
        seal: () => {
          binding.assert()
          binding.assertIdle()
          isSealed = true
        },
        settle: async () => {
          if (pending) {
            await pending.catch(() => undefined)
          }
        },
      })
      capabilities.set(req, binding)
      return binding
    },
    run: ({ req, work }) => {
      const capability = capabilities.get(req)
      if (!capability) {
        return Promise.reject(new Error('Creation write capability is required.'))
      }
      return capability.run({ work })
    },
  })
}
