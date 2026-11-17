import type { Payload } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildConfig } from 'payload'

import { testDataConfigSymbol } from '../../../../test/__helpers/shared/clearAndSeed/testDataConfig.js'
import { Media } from '../../src/collections/Media.js'
import { createCreationAuditCollection } from '../../src/creation/infrastructure/payload/audit-collection.js'
import { createCreationCollections } from '../../src/creation/infrastructure/payload/collections.js'
import { createGenerationJobsConfig } from '../../src/creation/infrastructure/payload/generation-jobs.js'
import { createCreationMediaCollection } from '../../src/creation/infrastructure/payload/media-collection.js'
import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createCreationWriteGate } from '../../src/creation/infrastructure/payload/write-gate.js'

const generationFixtures = new WeakMap<Payload, (args: { taskId: number }) => Promise<unknown>>()
export function registerGenerationFixture({
  payload,
  run,
}: {
  payload: Payload
  run: (args: { taskId: number }) => Promise<unknown>
}) {
  generationFixtures.set(payload, run)
  return () => generationFixtures.delete(payload)
}

const namingFixtures = new WeakMap<Payload, (args: { sessionId: number }) => Promise<unknown>>()
export function registerNamingFixture({
  payload,
  run,
}: {
  payload: Payload
  run: (args: { sessionId: number }) => Promise<unknown>
}) {
  namingFixtures.set(payload, run)
  return () => namingFixtures.delete(payload)
}

export const gate = createCreationWriteGate()
export const directory = mkdtempSync(path.join(tmpdir(), 'heymoro-t04-a-'))
export const sqliteURL = `file:${path.join(directory, 'creation.sqlite')}`
let closeClient: (() => void) | undefined

export function cleanupSQLiteFixture() {
  closeClient?.()
  rmSync(directory, { force: true, recursive: true })
}

const config = buildConfig({
  db: sqliteAdapter({
    autoIncrement: true,
    client: { url: sqliteURL },
    transactionOptions: { behavior: 'deferred' },
    wal: true,
  }),
  email: () => ({
    name: 'fixture-no-network',
    defaultFromAddress: 'fixture@local.invalid',
    defaultFromName: 'Fixture',
    sendEmail: async () => undefined,
  }),
  jobs: createGenerationJobsConfig({
    handler: async ({ input, req }) => {
      const run = generationFixtures.get(req.payload)
      if (!run) {
        throw new Error('Fixture sentinel generation handler must never run.')
      }
      await run(input)
      return { output: {} }
    },
    namingHandler: async ({ input, req }) => {
      const run = namingFixtures.get(req.payload)
      if (!run) {
        throw new Error('Fixture sentinel naming handler must never run.')
      }
      await run(input)
      return { output: {} }
    },
  }),
  secret: 'isolated-heymoro-sqlite-test-secret-not-a-real-key',
  telemetry: false,
  typescript: { autoGenerate: false },
  // A minimal fixture identity, not a replacement for product authentication.
  collections: [
    {
      slug: 'admins',
      auth: { disableLocalStrategy: true },
      fields: [
        { name: 'role', type: 'select', options: ['admin', 'operator', 'viewer'], required: true },
        { name: 'status', type: 'select', options: ['active', 'disabled'], required: true },
      ],
    },
    {
      slug: 'users',
      auth: { disableLocalStrategy: true },
      fields: [
        { name: 'status', type: 'select', options: ['active', 'disabled'], required: true },
        { name: 'isDeleted', type: 'checkbox', defaultValue: false },
      ],
    },
    ...createCreationCollections({ gate }),
    createCreationAuditCollection({ gate }),
    createCreationMediaCollection({
      baseCollection: Media,
      gate,
      staticDir: path.join(directory, 'uploads'),
    }),
  ],
  onInit: (payload: Payload) => {
    closeClient = () => getCreationSQLiteAdapter({ payload }).client.close()
  },
})

export default config.then((sanitized) =>
  Object.assign(sanitized, {
    [testDataConfigSymbol]: { suite: 'heymoro-t04-a-isolated-creation-sqlite' },
  }),
)
