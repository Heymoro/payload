import type { SQLiteUnitOfWorkOptions } from './sqlite-unit-of-work.js'

import { createSessionTitleService } from '../../application/session-title.js'
import { createPayloadTitlePersistence } from './session-naming-repository.js'

export function createPayloadSessionTitleService(
  options: { clock: () => string } & SQLiteUnitOfWorkOptions,
) {
  return createSessionTitleService({
    clock: options.clock,
    persistence: createPayloadTitlePersistence(options),
  })
}
