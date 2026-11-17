import type { Payload } from 'payload'

import { createHash } from 'node:crypto'

import type { CreationWriteGate } from '../infrastructure/payload/write-gate.js'
import type { CoreConfig } from './config.js'
import type { RuntimePorts } from './providers.js'

import { createQuoteCodec } from '../domain/quote.js'
import { createPayloadAdministration } from '../infrastructure/payload/admin-repository.js'
import { createPayloadArtifactFavorite } from '../infrastructure/payload/artifact-favorite-repository.js'
import { createPayloadCatalog } from '../infrastructure/payload/catalog-repository.js'
import { createPayloadCurrentTemplates } from '../infrastructure/payload/current-template-repository.js'
import { createPayloadDraftService } from '../infrastructure/payload/draft-repository.js'
import { createPayloadGenerationReconciliation } from '../infrastructure/payload/generation-reconciliation-repository.js'
import { createPayloadGenerationService } from '../infrastructure/payload/generation-repository.js'
import { createPayloadGenerationWorker } from '../infrastructure/payload/generation-worker-repository.js'
import { createPayloadIdentityService } from '../infrastructure/payload/identity-repository.js'
import { createPayloadMediaService } from '../infrastructure/payload/media-repository.js'
import { createPayloadOfficialMediaUploadService } from '../infrastructure/payload/official-media-repository.js'
import { createPayloadOwnerCredits } from '../infrastructure/payload/owner-credits-repository.js'
import { createPayloadOwnerLibrary } from '../infrastructure/payload/owner-library-repository.js'
import { createPayloadOwnerSessions } from '../infrastructure/payload/owner-sessions-repository.js'
import { createPayloadOwnerTaskHistory } from '../infrastructure/payload/owner-task-history-repository.js'
import { createPayloadSessionNaming } from '../infrastructure/payload/session-naming-repository.js'
import { createPayloadSessionCreator } from '../infrastructure/payload/session-repository.js'
import { createPayloadSessionShares } from '../infrastructure/payload/session-share-repository.js'
import { createPayloadSessionTitleService } from '../infrastructure/payload/session-title-repository.js'
import { createPayloadTemplateTaxonomy } from '../infrastructure/payload/template-taxonomy-repository.js'
import { referenceImageLimits } from './config.js'
import { createRuntimeProviders } from './providers.js'

// Next's RSC, route and Server Action bundles can load this module independently.
// Keep ownership on the Payload instance, not in a bundle-local registry.
const runtimeKey = Symbol.for('heymoro.core.runtime.v1')
type RuntimeOwner = { [runtimeKey]?: Awaited<ReturnType<typeof compose>> } & Payload

const writeChecksKey = Symbol.for('heymoro.core.write-checks.v1')
type WriteChecks = Pick<CreationWriteGate, 'assert' | 'beforeOperation'>
const registry = globalThis as { [writeChecksKey]?: Readonly<WriteChecks> } & typeof globalThis

// Only the stateless dispatcher is shared. Each Payload runtime retains its private gate.
export const runtimeWriteChecks: Readonly<WriteChecks> =
  registry[writeChecksKey] ??
  Object.freeze({
    assert: ({ req }) => getCoreRuntime({ payload: req.payload }).assertOwnedWrite({ req }),
    beforeOperation: ({ args, operation, req }) => {
      if (operation === 'delete') {
        throw new Error('Physical creation deletion is forbidden.')
      }
      if (operation === 'create' || operation === 'update') {
        getCoreRuntime({ payload: req.payload }).assertOwnedWrite({ req })
      }
      return args
    },
  })
if (!Object.hasOwn(registry, writeChecksKey)) {
  Object.defineProperty(registry, writeChecksKey, { value: runtimeWriteChecks })
}

export async function registerCoreRuntime(args: {
  clock: () => string
  config: CoreConfig
  gate: CreationWriteGate
  payload: Payload
  ports?: RuntimePorts
}) {
  if (Object.hasOwn(args.payload, runtimeKey)) {
    throw new Error('Core runtime already registered.')
  }
  const runtime = await compose(args)
  if (Object.hasOwn(args.payload, runtimeKey)) {
    await runtime.close()
    throw new Error('Core runtime already registered.')
  }
  Object.defineProperty(args.payload, runtimeKey, { value: runtime })
  return runtime
}
export function getCoreRuntime({ payload }: { payload: Payload }) {
  const runtime = Object.hasOwn(payload, runtimeKey)
    ? (payload as RuntimeOwner)[runtimeKey]
    : undefined
  if (!runtime) {
    throw new Error('Core runtime is not registered on this Payload instance.')
  }
  return runtime
}
async function compose({
  clock,
  config,
  gate,
  payload,
  ports,
}: {
  clock: () => string
  config: CoreConfig
  gate: CreationWriteGate
  payload: Payload
  ports?: RuntimePorts
}) {
  const providers = createRuntimeProviders({ config, ports })
  try {
    const common = {
      clock,
      coordinate: providers.coordinate,
      gate,
      payload,
      retry: { backoffMs: 10, maxAttempts: 3 },
    }
    const cursorKey = Buffer.from(config.cursorKey, 'base64url')
    const accepted = new Set(config.capabilities)
    const isCompatible = ({
      minClientCapability,
      schemaVersion,
    }: {
      minClientCapability: string
      schemaVersion: number
    }) => schemaVersion === 1 && accepted.has(minClientCapability)
    const capabilityPolicy = {
      id: `core-v1:${createHash('sha256').update(JSON.stringify(config.capabilities)).digest('hex')}`,
      isCompatible,
    }
    const quoteCodec = config.quote
      ? createQuoteCodec({
          ...config.quote,
          keys: Object.fromEntries(
            Object.entries(config.quote.keys).map(([kid, key]) => [
              kid,
              Buffer.from(key, 'base64url'),
            ]),
          ),
        })
      : null
    const execution = config.execution
    const hostCaps = config.hostCaps
    const storage = providers.storage
    const configured = Boolean(execution && quoteCodec && config.image)
    const media = createPayloadMediaService({
      ...common,
      destination: config.s3.input,
      imageLimits: referenceImageLimits({ hostCaps, imageLimits: config.imageLimits }),
      storage,
    })
    return Object.freeze({
      administration: createPayloadAdministration(common),
      admission: createPayloadGenerationService({
        ...common,
        coordinateMany: providers.coordinateMany,
        execution: configured ? execution : null,
        hostCaps,
        isCompatible,
        quoteCodec,
      }),
      assertOwnedWrite: gate.assert,
      catalog: createPayloadCatalog({ capabilityPolicy, cursorKey, hostCaps, payload }),
      close: providers.close,
      credits: createPayloadOwnerCredits({
        clock,
        cursorKey,
        payload,
        readiness: () => configured,
      }),
      draft: createPayloadDraftService({ ...common, hostCaps }),
      favorite: createPayloadArtifactFavorite(common),
      identity: createPayloadIdentityService({
        ...common,
        exchange: providers.wechat,
        policy: config.identity,
      }),
      library: createPayloadOwnerLibrary({ cursorKey, payload }),
      media,
      naming: createPayloadSessionNaming({
        ...common,
        engine: providers.naming,
        ...config.namingWorker,
        storage,
      }),
      officialMedia: createPayloadOfficialMediaUploadService({
        ...common,
        destination: config.s3.input,
        imageLimits: config.imageLimits,
        storage,
      }),
      reconciliation: createPayloadGenerationReconciliation({
        ...common,
        coordinateMany: providers.coordinateMany,
        engine: null,
        ...config.worker,
        execution,
        imageLimits: config.imageLimits,
        storage,
      }),
      session: createPayloadSessionCreator({ ...common, hostCaps, isCompatible }),
      sessions: createPayloadOwnerSessions({ cursorKey, payload }),
      sessionShares: createPayloadSessionShares({ ...common, readImage: media.readForUser }),
      tasks: createPayloadOwnerTaskHistory({ cursorKey, payload }),
      taxonomy: createPayloadTemplateTaxonomy(common),
      templates: createPayloadCurrentTemplates({
        ...common,
        acceptedCapabilities: config.capabilities,
        execution,
        hostCaps,
        maxExampleMedia: 12,
      }),
      title: createPayloadSessionTitleService(common),
      worker: createPayloadGenerationWorker({
        ...common,
        coordinateMany: providers.coordinateMany,
        engine: providers.image,
        ...config.worker,
        execution,
        imageLimits: config.imageLimits,
        storage,
        trustedClose: null,
      }),
    })
  } catch (error) {
    await providers.close()
    throw error
  }
}
