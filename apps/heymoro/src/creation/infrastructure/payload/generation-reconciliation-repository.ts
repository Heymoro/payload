import type { GenerationWorkerOptions } from '../../application/generation-worker.js'
import type { GenerationCoordinator } from './generation-repository.js'
import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'

import { createGenerationReconciliation } from '../../application/generation-reconciliation.js'
import { AdminCommandError } from '../../domain/admin.js'
import {
  GenerationReconciliationError,
  parseGenerationReconciliationCommand,
} from '../../domain/generation-reconciliation.js'
import { validateImage } from '../image/sharp-image-validator.js'
import { authenticateNativeAdminPrincipal } from './admin-repository.js'
import { createPayloadGenerationPersistence } from './generation-worker-repository.js'
import { CreationTransactionError } from './sqlite-unit-of-work.js'

type Options = Omit<GenerationWorkerOptions, 'persistence' | 'trustedClose' | 'validateImage'> &
  Omit<SQLiteUnitOfWorkOptions, 'coordinate'> &
  Readonly<{ coordinateMany: GenerationCoordinator }>

/** Identity and the trusted close capability live only for this command, never on the normal jobs worker. */
export function createPayloadGenerationReconciliation(options: Options) {
  return Object.freeze({
    execute: async ({ input, requestId }: { input: unknown; requestId: string }) => {
      const command = parseGenerationReconciliationCommand({ input })
      try {
        const id = await authenticateNativeAdminPrincipal({
          authorization: command.authorization,
          payload: options.payload,
        })
        if (id === null) {
          throw new GenerationReconciliationError({ code: 'RECONCILIATION_UNAUTHORIZED' })
        }
        const base = createPayloadGenerationPersistence({
          ...options,
          nativeAdmin: { id, authorization: command.authorization },
        })
        return await createGenerationReconciliation({
          actor: `admin:${id}`,
          clock: options.clock,
          imageLimits: options.imageLimits,
          persistence: {
            ...base,
            isTransactionUncertain: ({ error }) => error instanceof CreationTransactionError,
          },
          storage: options.storage,
          workerOptions: { ...options, validateImage },
        }).execute({ input: command, requestId })
      } catch (error) {
        if (error instanceof GenerationReconciliationError) {
          throw error
        }
        throw new GenerationReconciliationError({
          code:
            error instanceof AdminCommandError && error.code === 'ADMIN_DATA_INTEGRITY'
              ? 'RECONCILIATION_DATA_INTEGRITY'
              : 'RECONCILIATION_UNAUTHORIZED',
          requestId,
        })
      }
    },
  })
}
