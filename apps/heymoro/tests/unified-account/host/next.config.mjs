// Test-only Next host: reuses product routes; does not replace the product entry.
import { withPayload } from '@payloadcms/next/withPayload'
import { fileURLToPath } from 'node:url'
export default withPayload(
  {
    experimental: { useTypeScriptCli: true },
    webpack(config) {
      config.resolve.alias['@payload-config'] = fileURLToPath(
        new URL('../config.mjs', import.meta.url),
      )
      config.resolve.extensionAlias = {
        '.js': ['.ts', '.tsx', '.js', '.jsx'],
        '.mjs': ['.mts', '.mjs'],
      }
      return config
    },
  },
  { devBundleServerPackages: true },
)
