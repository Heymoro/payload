import { getPayload } from 'payload'
import { readCoreConfig } from '../src/creation/runtime/config.ts'
import { buildCorePayloadConfig } from '../src/creation/runtime/payload-config.ts'
import { prepareTarget } from '../src/creation/runtime/target-profile.ts'
import { getCoreRuntime } from '../src/creation/runtime/services.ts'
import { getCreationSQLiteAdapter } from '../src/creation/infrastructure/payload/sqlite-unit-of-work.ts'

if (process.argv.length !== 4 || process.argv[2] !== '--config')
  throw new Error('Usage: core:init --config ABSOLUTE_JSON')
const config = readCoreConfig({ filename: process.argv[3] })
const initialization = prepareTarget({ dataDir: config.dataDir })
let payload
try {
  payload = await getPayload({ config: buildCorePayloadConfig({ config, initialization }) })
  console.log('Core target is ready.')
} finally {
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
