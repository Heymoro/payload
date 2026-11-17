import type { Payload } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildConfig } from 'payload'

import { testDataConfigSymbol } from '../../../../test/__helpers/shared/clearAndSeed/testDataConfig.js'
import { Media } from '../../src/collections/Media.js'
import { createCreationAuditCollection } from '../../src/creation/infrastructure/payload/audit-collection.js'
import { createCreationCollections } from '../../src/creation/infrastructure/payload/collections.js'
import { createCurrentTemplateCollection } from '../../src/creation/infrastructure/payload/current-template-collection.js'
import { createCreationMediaCollection } from '../../src/creation/infrastructure/payload/media-collection.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createCreationWriteGate } from '../../src/creation/infrastructure/payload/write-gate.js'
import { startRedisFixture } from './redis-fixture.js'

export const directory = realpathSync(
  mkdtempSync(path.join(tmpdir(), 'heymoro-current-templates-')),
)
export const gate = createCreationWriteGate()
export const redis = await startRedisFixture()
let client: ReturnType<typeof getCreationSQLiteAdapter>['client'] | undefined

export async function cleanupCurrentTemplates() {
  await redis.stop()
  client?.close()
  client = undefined
}

export default buildConfig({
  collections: [
    {
      slug: 'admins',
      auth: { disableLocalStrategy: true },
      fields: [
        { name: 'role', type: 'text', required: true },
        { name: 'status', type: 'text', required: true },
      ],
    },
    createCurrentTemplateCollection({ gate }),
    ...createCreationCollections({ gate }).filter(({ slug }) =>
      ['session-shares', 'taxonomy-terms'].includes(slug),
    ),
    createCreationMediaCollection({
      baseCollection: Media,
      gate,
      staticDir: path.join(directory, 'uploads'),
    }),
    createCreationAuditCollection({ gate }),
  ],
  db: sqliteAdapter({
    autoIncrement: true,
    client: { url: `file:${path.join(directory, 'current.sqlite')}` },
    transactionOptions: { behavior: 'deferred' },
    wal: true,
  }),
  onInit: (payload: Payload) => {
    client = getCreationSQLiteAdapter({ payload }).client
  },
  secret: 'current-template-native-fixture-not-a-real-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
}).then((config) =>
  Object.assign(config, {
    [testDataConfigSymbol]: { suite: 'heymoro-current-template-isolated' },
  }),
)
