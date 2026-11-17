import { createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

const require = createRequire(path.resolve(process.cwd(), 'packages/graphql/package.json'))
const graphqlDirectory = path.dirname(require.resolve('graphql/package.json'))

export default defineConfig({
  envDir: false,
  oxc: { jsx: { importSource: 'react', runtime: 'automatic' } },
  resolve: {
    alias: [
      { find: /^graphql\/(.*)/, replacement: `${graphqlDirectory}/$1` },
      { find: /^graphql$/, replacement: path.join(graphqlDirectory, 'index.js') },
    ],
  },
  test: {
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 90000,
    include: [
      'apps/heymoro/tests/creation/admin.int.spec.ts',
      'apps/heymoro/tests/creation/identity.int.spec.ts',
      'apps/heymoro/tests/creation/identity-http.int.spec.ts',
      'apps/heymoro/tests/creation/catalog-session-http.int.spec.ts',
      'apps/heymoro/tests/creation/media-http.int.spec.ts',
      'apps/heymoro/tests/creation/library-credits-http.int.spec.ts',
      'apps/heymoro/tests/creation/generation-http.int.spec.ts',
      'apps/heymoro/tests/creation/runtime-root.int.spec.ts',
      'apps/heymoro/tests/creation/runtime-chain.int.spec.ts',
      'apps/heymoro/tests/creation/owner-credits.int.spec.ts',
      'apps/heymoro/tests/creation/owner-task-history.int.spec.ts',
      'apps/heymoro/tests/creation/owner-sessions.int.spec.ts',
      'apps/heymoro/tests/creation/owner-library.int.spec.ts',
      'apps/heymoro/tests/creation/artifact-favorite.int.spec.ts',
      'apps/heymoro/tests/creation/current-template.int.spec.ts',
      'apps/heymoro/tests/creation/session-share.int.spec.ts',
      'apps/heymoro/tests/creation/session-share-http.int.spec.ts',
      'apps/heymoro/tests/creation/template-taxonomy.int.spec.ts',
      'apps/heymoro/tests/creation/session-template.int.spec.ts',
      'apps/heymoro/tests/creation/session-naming.int.spec.ts',
      'apps/heymoro/tests/creation/ai-engine.int.spec.ts',
      'apps/heymoro/tests/creation/generation-worker.int.spec.ts',
      'apps/heymoro/tests/creation/generation-reconciliation.int.spec.ts',
      'apps/heymoro/tests/creation/generation-settlement.int.spec.ts',
      'apps/heymoro/tests/creation/s3.int.spec.ts',
      'apps/heymoro/tests/creation/media.int.spec.ts',
      'apps/heymoro/tests/creation/sqlite.int.spec.ts',
      'apps/heymoro/tests/creation/redis.int.spec.ts',
      'apps/heymoro/tests/creation/catalog.int.spec.ts',
      'apps/heymoro/tests/creation/draft.int.spec.ts',
      'apps/heymoro/tests/creation/credits.int.spec.ts',
      'apps/heymoro/tests/creation/generation.int.spec.ts',
    ],
    testTimeout: 90000,
  },
})
