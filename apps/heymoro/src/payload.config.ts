import { readCoreConfig } from './creation/runtime/config.js'
import { prepareDevelopmentIdentity } from './creation/runtime/development-identity.js'
import { buildCorePayloadConfig } from './creation/runtime/payload-config.js'

const prepared = prepareDevelopmentIdentity({ config: readCoreConfig() })

export default buildCorePayloadConfig({
  adminInitialization:
    process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'production'
      ? process.env.NODE_ENV
      : undefined,
  config: prepared.config,
  ports: prepared.ports,
})
