import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

import type { CoreConfig } from './config.js'
import type { RuntimePorts } from './providers.js'

import { assertNoDevelopmentDataInProduction, parseCoreConfig, projectRoot } from './config.js'
import { readPrivateJSON } from './private-json.js'

/** A host-only identity source, never a new HTTP credential or a persisted configuration switch. */
export function prepareDevelopmentIdentity({
  config,
  mode = process.env.NODE_ENV,
}: {
  config: CoreConfig
  mode?: string
}): Readonly<{ config: CoreConfig; ports?: Pick<RuntimePorts, 'wechat'> }> {
  assertNoDevelopmentDataInProduction({ dataDir: config.dataDir, mode })
  const unchanged = Object.freeze({ config })
  if (
    mode !== 'development' ||
    config.identity.wechat !== null ||
    !['[::1]', '127.0.0.1', 'localhost'].includes(new URL(config.publicApiUrl).hostname)
  ) {
    return unchanged
  }
  let root: string
  try {
    const parent = path.dirname(config.dataDir)
    for (const directory of [parent, config.dataDir]) {
      const stat = lstatSync(directory)
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      ) {
        return unchanged
      }
    }
    root = realpathSync(parent)
    if (realpathSync(config.dataDir) !== path.join(root, 'data')) {
      return unchanged
    }
    const filename = path.join(parent, 'local-profile.json')
    const stat = lstatSync(filename)
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      return unchanged
    }
    const marker = readPrivateJSON({
      fileMessage: 'Invalid local development identity profile.',
      filename,
      maxBytes: 4096,
      pathMessage: 'Invalid local development identity profile.',
      projectRoot,
    })
    if (
      !marker ||
      typeof marker !== 'object' ||
      !('purpose' in marker) ||
      marker.purpose !== 'heymoro-local-development'
    ) {
      return unchanged
    }
  } catch {
    return unchanged
  }
  const verified = Object.freeze({
    openId: `local-development:${createHash('sha256').update(root).digest('hex')}`,
    unionId: null,
  })
  return Object.freeze({
    config: parseCoreConfig({
      value: {
        ...config,
        identity: {
          ...config.identity,
          trial: config.identity.trial ?? { issuedCredits: 100, validForSeconds: null },
          wechat: {
            appId: 'heymoro-local-development-v1',
            appSecret: 'local-development-not-a-wechat-secret',
            maxResponseBytes: 1024,
            timeoutMs: 1000,
          },
        },
      },
    }),
    ports: Object.freeze({ wechat: () => Promise.resolve(verified) }),
  })
}
