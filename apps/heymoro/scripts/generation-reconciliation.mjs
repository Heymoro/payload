import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { getPayload } from 'payload'

import {
  GenerationReconciliationError,
  parseGenerationReconciliationCommand,
} from '../src/creation/domain/generation-reconciliation.ts'
import { getCreationSQLiteAdapter } from '../src/creation/infrastructure/payload/sqlite-unit-of-work.ts'
import { projectRoot, readCoreConfig } from '../src/creation/runtime/config.ts'
import { buildCorePayloadConfig } from '../src/creation/runtime/payload-config.ts'
import { readPrivateJSON } from '../src/creation/runtime/private-json.ts'
import { getCoreRuntime } from '../src/creation/runtime/services.ts'

/**
 * @typedef {import('payload').Payload} Payload
 * @typedef {import('../src/creation/domain/generation-reconciliation.ts').ReconciliationResult} ReconciliationResult
 * @typedef {{ requestId: string, outcome: ReconciliationResult['outcome'] | import('../src/creation/domain/generation-reconciliation.ts').ReconciliationOutcome, action?: ReconciliationResult['action'], taskId?: number, attemptId?: null | number, taskStatus?: string, result?: ReconciliationResult['result'], originalOperationId?: string, releasedCredits?: number, expiredCredits?: number, code?: string, message?: string, cleanupCode?: string, exitCode: number }} CLIResult
 * @typedef {Partial<{ build: typeof buildCorePayloadConfig, open: typeof getPayload, runtime: (payload: Payload) => ReturnType<typeof getCoreRuntime>, client: (payload: Payload) => ReturnType<typeof getCreationSQLiteAdapter>['client'], destroy: (payload: Payload) => Promise<void> }>} HostPorts
 */

/**
 * Typed host seams inject lifecycle failures without JSON switches or credentials.
 * @param {{ argv: string[], ports?: HostPorts }} args
 * @returns {Promise<CLIResult>}
 */
export async function runGenerationReconciliation({ argv, ports = {} }) {
  const requestId = randomUUID()
  /** @type {Payload | undefined} */
  let payload
  /** @type {ReturnType<typeof getCoreRuntime> | undefined} */
  let runtime
  /** @type {ReturnType<typeof getCreationSQLiteAdapter>['client'] | undefined} */
  let client
  /** @type {CLIResult} */
  let result
  let hasCleanupFailed = false
  let hasExecutionStarted = false
  /** @type {import('../src/creation/domain/generation-reconciliation.ts').GenerationReconciliationCommand | undefined} */
  let command
  try {
    if (argv.length !== 4 || argv[0] !== '--config' || argv[2] !== '--command') {
      result = {
        requestId,
        outcome: 'not_started',
        code: 'RECONCILIATION_USAGE',
        message: 'Usage: generation:reconcile --config ABSOLUTE_JSON --command ABSOLUTE_JSON',
        exitCode: 1,
      }
    } else {
      const input = parseGenerationReconciliationCommand({
        input: readPrivateJSON({
          filename: argv[3],
          maxBytes: 16_384,
          projectRoot,
          pathMessage: 'Invalid private command path.',
          fileMessage: 'Invalid private command file.',
        }),
      })
      command = input
      const config = readCoreConfig({ filename: argv[1] })
      const sanitized = await (ports.build ?? buildCorePayloadConfig)({ config })
      // Payload's logger:false selects its default logger; only silent level suppresses onInit raw errors too.
      sanitized.logger = { options: { level: 'silent' } }
      const database = sanitized.db
      if (database) {
        const initialize = database.init
        database.init = (args) => {
          payload = args.payload
          return initialize.call(database, args)
        }
      }
      const onInit = sanitized.onInit
      sanitized.onInit = async (instance) => {
        payload = instance
        client = (ports.client ?? ((payload) => getCreationSQLiteAdapter({ payload }).client))(
          instance,
        )
        await onInit?.(instance)
        runtime = (ports.runtime ?? ((payload) => getCoreRuntime({ payload })))(instance)
      }
      payload = await (ports.open ?? getPayload)({ config: sanitized })
      client = (ports.client ?? ((payload) => getCreationSQLiteAdapter({ payload }).client))(
        payload,
      )
      runtime = (ports.runtime ?? ((payload) => getCoreRuntime({ payload })))(payload)
      hasExecutionStarted = true
      const confirmed = await runtime.reconciliation.execute({ input, requestId })
      // Fixed DTO: even a host seam never forwards secrets or arbitrary persistence properties.
      result = {
        requestId,
        action: input.action,
        outcome: confirmed.outcome,
        taskId: confirmed.taskId,
        attemptId: confirmed.attemptId,
        taskStatus: confirmed.taskStatus,
        result: confirmed.result,
        ...(confirmed.originalOperationId === undefined
          ? {}
          : { originalOperationId: confirmed.originalOperationId }),
        ...(confirmed.releasedCredits === undefined
          ? {}
          : { releasedCredits: confirmed.releasedCredits }),
        ...(confirmed.expiredCredits === undefined
          ? {}
          : { expiredCredits: confirmed.expiredCredits }),
        exitCode: 0,
      }
    }
  } catch (error) {
    result =
      error instanceof GenerationReconciliationError
        ? {
            requestId,
            outcome: error.outcome,
            code: error.code,
            message: error.message,
            exitCode: 1,
          }
        : {
            requestId,
            outcome: hasExecutionStarted ? 'unknown' : 'not_started',
            code: hasExecutionStarted
              ? 'RECONCILIATION_OUTCOME_UNKNOWN'
              : 'RECONCILIATION_STARTUP_FAILED',
            message: hasExecutionStarted
              ? 'Command outcome is unknown. Verify evidence before further action.'
              : 'Private generation reconciliation command initialization failed.',
            exitCode: 1,
          }
  } finally {
    if (payload && !client) {
      try {
        client = (ports.client ?? ((payload) => getCreationSQLiteAdapter({ payload }).client))(
          payload,
        )
      } catch {
        /* Native initialization may have failed before creating a client. */
      }
    }
    if (payload && !runtime) {
      try {
        runtime = (ports.runtime ?? ((payload) => getCoreRuntime({ payload })))(payload)
      } catch {
        /* Registration may not have completed. */
      }
    }
    try {
      await runtime?.close()
    } catch {
      hasCleanupFailed = true
    }
    try {
      if (payload) await (ports.destroy ?? ((payload) => payload.destroy()))(payload)
    } catch {
      hasCleanupFailed = true
    }
    try {
      client?.close()
    } catch {
      hasCleanupFailed = true
    }
  }
  if (hasCleanupFailed && result.outcome === 'confirmed')
    return {
      ...result,
      cleanupCode: 'RECONCILIATION_CLEANUP_FAILED',
      message: 'Command confirmed; resource cleanup failed. Do not replay the command.',
      exitCode: 1,
    }
  if (hasCleanupFailed)
    return { ...result, cleanupCode: 'RECONCILIATION_CLEANUP_FAILED', exitCode: 1 }
  return {
    ...result,
    ...(command
      ? {
          action: command.action,
          taskId: command.taskId,
          ...('attemptId' in command ? { attemptId: command.attemptId } : {}),
        }
      : {}),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { exitCode, ...result } = await runGenerationReconciliation({ argv: process.argv.slice(2) })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = exitCode
}
