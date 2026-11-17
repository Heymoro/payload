import { getPayload } from 'payload'
import { readCoreConfig } from '../src/creation/runtime/config.ts'
import { buildCorePayloadConfig } from '../src/creation/runtime/payload-config.ts'
import { getCoreRuntime } from '../src/creation/runtime/services.ts'
import { getCreationSQLiteAdapter } from '../src/creation/infrastructure/payload/sqlite-unit-of-work.ts'
import {
  configuredGenerationQueues,
  consumeGenerationJobs,
} from '../src/creation/infrastructure/payload/generation-consumer.ts'

if (process.argv.slice(2).some((arg) => arg !== '--watch') || process.argv.slice(2).length > 1) {
  throw new Error('Usage: jobs:creation [--watch]')
}
const config = readCoreConfig()
const queues = configuredGenerationQueues({ config })
const controller = new AbortController()
const stop = () => controller.abort()
let payload
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
try {
  if (queues.length > 0 && !controller.signal.aborted) {
    payload = await getPayload({ config: buildCorePayloadConfig({ config }) })
    await consumeGenerationJobs({
      queues,
      run: (args) => payload.jobs.run(args),
      isContinuous: process.argv.includes('--watch'),
      signal: controller.signal,
    })
  } else {
    console.info('Generation and naming providers are not configured; no jobs were claimed.')
  }
} finally {
  process.removeListener('SIGTERM', stop)
  process.removeListener('SIGINT', stop)
  if (payload) {
    try {
      await getCoreRuntime({ payload }).close()
    } finally {
      const client = getCreationSQLiteAdapter({ payload }).client
      try {
        await payload.destroy()
      } finally {
        client.close()
      }
    }
  }
}
