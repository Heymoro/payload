import { randomBytes } from 'node:crypto'

import type { createAdministration } from '../application/admin.js'

import { AdminCommandError } from '../domain/admin.js'

/** Host startup only. Generate once outside the administration transaction/retry boundary. */
export async function initializeAdmins({
  administration,
  logger,
  mode,
}: {
  administration: ReturnType<typeof createAdministration>
  logger: { info: (entry: { msg: string; password: string; username: string }) => unknown }
  mode: 'development' | 'production'
}): Promise<Readonly<{ adminId: number; status: 'created' } | { status: 'skipped' }>> {
  const password = mode === 'production' ? randomBytes(24).toString('base64url') : null
  let adminId: number
  try {
    const result = await (mode === 'development'
      ? administration.initializeDevelopmentPreset()
      : administration.execute({
          input: { action: 'bootstrap', email: 'admin@local.invalid', password, username: 'admin' },
        }))
    if (result.outcome !== 'confirmed' || !result.data.changed) {
      throw new AdminCommandError({ code: 'ADMIN_OUTCOME_UNKNOWN', outcome: 'unknown' })
    }
    adminId = result.data.id
  } catch (error) {
    if (error instanceof AdminCommandError && error.code === 'ADMIN_ALREADY_INITIALIZED') {
      return Object.freeze({ status: 'skipped' })
    }
    if (error instanceof AdminCommandError) {
      throw error
    }
    throw new AdminCommandError({ code: 'ADMIN_FAILED', outcome: 'not_started' })
  }
  if (password !== null) {
    try {
      logger.info({
        msg: 'First administrator initialized. Store this password securely.',
        password,
        username: 'admin',
      })
    } catch {
      throw new Error('Administrator created, but initial credential logging failed.')
    }
  }
  return Object.freeze({ adminId, status: 'created' })
}
