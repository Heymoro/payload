import { withPayload } from '@payloadcms/next/withPayload'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const fileTypeEntry = pathToFileURL(
  createRequire(require.resolve('payload')).resolve('file-type'),
).href

export default withPayload(
  {
    devIndicators: false,
    distDir: process.env.HEYMORO_DIST_DIR || '.next',
    experimental: { useTypeScriptCli: true },
    async redirects() {
      return [{ source: '/', destination: '/admin', permanent: false }]
    },
    webpack(config, { isServer, nextRuntime }) {
      if (isServer && nextRuntime !== 'edge') {
        // pnpm resolves file-type under Payload, not this app. Keep its dynamic
        // Node imports native instead of letting app-root resolution bundle it.
        const existing = Array.isArray(config.externals)
          ? config.externals
          : config.externals
            ? [config.externals]
            : []
        config.externals = [
          ({ request }, callback) =>
            request === 'file-type' ? callback(null, fileTypeEntry, 'import') : callback(),
          ...existing,
        ]
      }
      config.resolve.extensionAlias = {
        '.cjs': ['.cts', '.cjs'],
        '.js': ['.ts', '.tsx', '.js', '.jsx'],
        '.mjs': ['.mts', '.mjs'],
      }
      return config
    },
  },
  { devBundleServerPackages: true },
)
