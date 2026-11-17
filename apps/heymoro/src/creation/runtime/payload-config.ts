import type { Payload } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfig } from 'payload'

import type { CreationWriteGate } from '../infrastructure/payload/write-gate.js'
import type { CoreConfig } from './config.js'
import type { RuntimePorts } from './providers.js'
import type { TargetInitialization } from './target-profile.js'

import { Media } from '../../collections/Media.js'
import { healthEndpoints } from '../../endpoint-health.js'
import { catalogEndpoints } from '../http/catalog-endpoints.js'
import { creditsEndpoints } from '../http/credits-endpoints.js'
import { generationEndpoints } from '../http/generation-endpoints.js'
import { identityEndpoints } from '../http/identity-endpoints.js'
import { libraryEndpoints } from '../http/library-endpoints.js'
import { createMediaEndpoints } from '../http/media-endpoints.js'
import { createOfficialMediaEndpoints } from '../http/official-media-endpoints.js'
import { sessionEndpoints } from '../http/session-endpoints.js'
import { sessionShareEndpoints } from '../http/session-share-endpoints.js'
import { createCreationAuditCollection } from '../infrastructure/payload/audit-collection.js'
import { createCreationCollections } from '../infrastructure/payload/collections.js'
import { createGenerationJobsConfig } from '../infrastructure/payload/generation-jobs.js'
import { createCreationMediaCollection } from '../infrastructure/payload/media-collection.js'
import { createSQLiteBeginTransaction } from '../infrastructure/payload/sqlite-begin-transaction.js'
import { getCreationSQLiteAdapter } from '../infrastructure/payload/sqlite-unit-of-work.js'
import { createCreationWriteGate } from '../infrastructure/payload/write-gate.js'
import { initializeAdmins } from './admin-initialization.js'
import { assertNoDangerousMode } from './config.js'
import { createIdentityCollections } from './identity-collections.js'
import { getCoreRuntime, registerCoreRuntime, runtimeWriteChecks } from './services.js'
import { assertTargetInitializationMode, createTargetProfile } from './target-profile.js'

/** The only product composition root. Host ports are typed constructor DI, never JSON/HTTP switches. */
export function buildCorePayloadConfig({
  adminInitialization,
  clock = () => new Date().toISOString(),
  config,
  gate: suppliedGate,
  initialization,
  ports,
}: {
  adminInitialization?: 'development' | 'production'
  clock?: () => string
  config: CoreConfig
  gate?: CreationWriteGate
  initialization?: TargetInitialization
  ports?: RuntimePorts
}) {
  assertNoDangerousMode()
  if (initialization) {
    assertTargetInitializationMode()
  }
  const gate = suppliedGate ?? createCreationWriteGate()
  // Payload reload replaces collection hooks without rerunning onInit. The live runtime
  // retains its owner gate; replacement hooks must check that same request capability.
  const hookGate: CreationWriteGate = suppliedGate ?? { ...gate, ...runtimeWriteChecks }
  const runtimeGate: CreationWriteGate = suppliedGate ?? {
    ...gate,
    beforeOperation: hookGate.beforeOperation,
  }
  const target = createTargetProfile({ dataDir: config.dataDir, initialization })
  const nativeAdapter = sqliteAdapter({
    afterSchemaInit: [target.afterSchemaInit],
    autoIncrement: true,
    client: { url: `file:${target.databaseFile}` },
    push: Boolean(initialization),
    transactionOptions: { behavior: 'deferred' },
    wal: true,
  })
  const db: typeof nativeAdapter = {
    ...nativeAdapter,
    init: (args) => {
      const adapter = nativeAdapter.init(args)
      adapter.beginTransaction = createSQLiteBeginTransaction({
        beginTransaction: adapter.beginTransaction,
      })
      const connect = adapter.connect
      if (!connect) {
        throw new Error('Native SQLite connect is required.')
      }
      adapter.connect = async function (...parameters) {
        assertNoDangerousMode()
        target.assertReadyForConnect()
        return connect.apply(this, parameters)
      }
      return adapter
    },
  }
  return buildConfig({
    admin: {
      autoLogin: false,
      components: {
        afterNavLinks: ['/admin/TemplateManagementNavLink/index.js#TemplateManagementNavLink'],
        views: {
          templates: {
            Component: '/admin/TemplateManagementView/index.js#TemplateManagementView',
            exact: true,
            path: '/templates',
          },
        },
      },
      importMap: { baseDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..') },
      user: 'admins',
    },
    collections: [
      ...createIdentityCollections({ clock, gate: hookGate }),
      ...createCreationCollections({ gate: hookGate }),
      createCreationMediaCollection({
        baseCollection: Media,
        gate: hookGate,
        staticDir: path.join(config.dataDir, 'uploads'),
      }),
      createCreationAuditCollection({ gate: hookGate }),
    ],
    csrf: [new URL(config.publicApiUrl).origin],
    db,
    email: () => ({
      name: 'core-email-disabled',
      defaultFromAddress: 'disabled@local.invalid',
      defaultFromName: 'Core',
      sendEmail: () => Promise.reject(new Error('Core email sending is not enabled.')),
    }),
    endpoints: [
      ...healthEndpoints,
      ...identityEndpoints,
      ...catalogEndpoints,
      ...sessionEndpoints,
      ...createMediaEndpoints({
        canUploadReferences: config.hostCaps.maxImages > 0,
        fileMaxBytes: Math.min(config.hostCaps.maxImageBytes, config.imageLimits.maxBytes),
      }),
      ...createOfficialMediaEndpoints({ fileMaxBytes: config.imageLimits.maxBytes }),
      ...libraryEndpoints,
      ...creditsEndpoints,
      ...generationEndpoints,
      ...sessionShareEndpoints,
    ],
    jobs: createGenerationJobsConfig({
      handler: async ({ input, req }) => {
        await getCoreRuntime({ payload: req.payload }).worker.run(input)
        return { output: {} }
      },
      namingHandler: async ({ input, req }) => {
        await getCoreRuntime({ payload: req.payload }).naming.run(input)
        return { output: {} }
      },
    }),
    onInit: async (payload: Payload) => {
      let runtime: Awaited<ReturnType<typeof registerCoreRuntime>> | undefined
      try {
        target.finish()
        runtime = await registerCoreRuntime({ clock, config, gate: runtimeGate, payload, ports })
        if (adminInitialization) {
          await initializeAdmins({
            administration: runtime.administration,
            logger: payload.logger,
            mode: adminInitialization,
          })
        }
      } catch (error) {
        await runtime?.close().catch(() => undefined)
        const client = getCreationSQLiteAdapter({ payload }).client
        try {
          await payload.destroy()
        } finally {
          client.close()
        }
        throw error
      }
    },
    secret: config.payloadSecret,
    serverURL: config.publicApiUrl,
    telemetry: false,
    typescript: { autoGenerate: false },
  })
}
