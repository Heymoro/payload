import type { Payload } from 'payload'

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { StorageRef } from '../../src/creation/domain/media.js'
import type { CoreConfig } from '../../src/creation/runtime/config.js'
import type { E2Control } from './next-business-host.js'

import { compileCurrentTemplate } from '../../src/creation/domain/current-template.js'
import { createPayloadVerifiedMediaRegistration } from '../../src/creation/infrastructure/payload/media-repository.js'
import { createSQLiteUnitOfWork } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import { createCreationRedisClient } from '../../src/creation/infrastructure/redis/client.js'
import { createRedisCreationCoordinator } from '../../src/creation/infrastructure/redis/coordinator.js'
import { createS3ObjectStorage } from '../../src/creation/infrastructure/s3/object-storage.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'

type Example = {
  filesize: number
  height: number
  id: number
  mimeType: string
  recipe: 'blue' | 'red'
  ref: StorageRef
  sha256: string
  width: number
}
export type DatasetReceipt = {
  adminId: number
  datasetConfigSHA: string
  examples: Example[]
  format: 2
  readbackSHA: string
  readyFile: string
  readySHA: string
  revisionId: string
  state: 'complete'
  targetDir: string
  templates: {
    configurationHash: string
    exampleMediaHash: string
    kind: 'effect' | 'free'
    templateId: number
  }[]
}

export async function readE2CatalogTemplate({
  catalog,
  template,
}: {
  catalog: Pick<ReturnType<typeof getCoreRuntime>['catalog'], 'get' | 'getFreePreset'>
  template: Pick<DatasetReceipt['templates'][number], 'kind' | 'templateId'>
}) {
  assert(template.kind === 'effect' || template.kind === 'free')
  positive({ value: template.templateId })
  const result =
    template.kind === 'free'
      ? await catalog.getFreePreset()
      : await catalog.get({ templateId: template.templateId })
  assert.equal(result.mode, template.kind)
  assert.equal(result.templateId, template.templateId)
  assert.equal(Object.hasOwn(result, 'templateVersionId'), false)
  return result
}

export function officialExampleRef({
  adminId,
  destination,
  sha256,
  uuid: id = randomUUID(),
}: {
  adminId: number
  destination: { backend: string; bucket: string }
  sha256: string
  uuid?: string
}): StorageRef {
  positive({ value: adminId })
  sha({ value: sha256 })
  uuid({ value: id })
  return { ...destination, key: `references/${adminId}/${id}/${sha256}` }
}

function templateEvidence({
  configuration,
  template,
}: {
  configuration: Pick<CoreConfig, 'capabilities' | 'execution' | 'hostCaps'>
  template: Parameters<typeof compileCurrentTemplate>[0]['template']
}) {
  const compiled = compileCurrentTemplate({
    acceptedCapabilities: configuration.capabilities,
    execution: configuration.execution,
    hostCaps: configuration.hostCaps,
    template,
  })
  const display = compiled.publicTemplate.displayConfig
  return {
    configurationHash: compiled.configurationHash,
    exampleMediaHash: createHash('sha256')
      .update(JSON.stringify({ coverMediaId: display.coverMediaId, examples: display.examples }))
      .digest('hex'),
  }
}

export async function publishE2Template({
  adminId,
  configuration,
  kind,
  templateId,
  templates,
}: {
  adminId: number
  configuration: Pick<CoreConfig, 'capabilities' | 'execution' | 'hostCaps'>
  kind: 'effect' | 'free'
  templateId: number
  templates: Pick<ReturnType<typeof getCoreRuntime>['templates'], 'get' | 'setStatus'>
}) {
  await templates.setStatus({ adminId, status: 'published', templateId })
  const template = await templates.get({ adminId, templateId })
  assert.equal(template.id, templateId)
  assert.equal(template.kind, kind)
  assert.equal(template.status, 'published')
  assert.equal(template.isDeleted, false)
  return {
    ...templateEvidence({ configuration, template }),
    isDatasetOwner: false as const,
    kind,
    state: 'incomplete' as const,
    templateId,
  }
}

export async function completeE2Dataset<
  T extends { format: number; readbackSHA: string; state: string },
>({ filename, owner, readback }: { filename: string; owner: T; readback: () => Promise<string> }) {
  assert.equal(owner.format, 2)
  assert.equal(owner.state, 'complete')
  owner.readbackSHA = sha({ value: await readback() })
  writeFileSync(filename, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
  return owner
}

export function assertDatasetBinding({
  control,
  owner,
}: {
  control: E2Control
  owner: DatasetReceipt
}) {
  assert.equal(owner.format, 2)
  assert.equal(owner.state, 'complete')
  assert.equal(owner.revisionId, control.revisionId)
  assert.equal(owner.targetDir, control.targetDir)
  assert(control.ready)
  assert.equal(owner.readyFile, control.ready.readyFile)
  assert.equal(owner.readySHA, control.ready.readySHA)
  assert.equal(owner.datasetConfigSHA, control.datasetConfigSHA)
}

/** No synthetic identities or direct grants: only host administration and publication write services. */
export async function seedE2Dataset({
  clock,
  config,
  control,
  payload,
}: {
  clock: () => string
  config: CoreConfig
  control: E2Control
  payload: Payload
}) {
  const { digest, gate, journal, syntheticPNG } = await import('./next-business-host.js')
  assert.equal(control.mode, 'business')
  assert(control.ready, 'Fresh dataset requires root ready approval.')
  const runtime = getCoreRuntime({ payload })
  const storage = createS3ObjectStorage({
    backends: config.s3.backends,
    image: config.imageLimits,
    limits: config.s3.limits,
  })
  const redis = await createCreationRedisClient(config.redis)
  const coordinator = createRedisCreationCoordinator({ client: redis.client, config: config.redis })
  const common = {
    coordinate: coordinator.coordinate,
    gate,
    payload,
    retry: { backoffMs: 10, maxAttempts: 3 },
  }
  try {
    await storage.verifyBackend(config.s3.input)
    if (existsSync(control.datasetOwnerFile)) {
      const owner = JSON.parse(readFileSync(control.datasetOwnerFile, 'utf8')) as DatasetReceipt
      assertDatasetBinding({ control, owner })
      assert.equal(owner.datasetConfigSHA, control.datasetConfigSHA)
      for (const example of owner.examples) {
        const bytes = await syntheticPNG({ color: example.recipe })
        assert.equal(createHash('sha256').update(bytes).digest('hex'), example.sha256)
        const facts = await storage.putImmutable({
          bytes,
          contentType: 'image/png',
          ref: example.ref,
        })
        assert.equal(facts.sha256, example.sha256)
        await storage.getVerified({ expected: example, ref: example.ref })
      }
      assert.equal(await readback({ config, owner, payload }), owner.readbackSHA)
      journal({ details: { ownerSHA: digest({ value: owner }), reused: 1 }, event: 'dataset' })
      return owner
    }
    const bootstrap = await runtime.administration.execute({
      input: { action: 'bootstrap', email: control.admin.email, password: control.admin.password },
    })
    assert.equal(bootstrap.outcome, 'confirmed')
    const adminId = positive({ value: bootstrap.data.id })
    const examples: Example[] = []
    const register = createPayloadVerifiedMediaRegistration({ gate, payload, storage })
    const write = createSQLiteUnitOfWork(common)
    for (const recipe of ['red', 'blue'] as const) {
      const bytes = await syntheticPNG({ color: recipe })
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const ref = officialExampleRef({ adminId, destination: config.s3.input, sha256 })
      const facts = await storage.putImmutable({ bytes, contentType: 'image/png', ref })
      const media = await write({
        resource: 'e2-official-publication',
        work: ({ req }) =>
          register({
            actor: `admin:${adminId}`,
            facts,
            now: clock(),
            originalName: `e2-${recipe}.png`,
            owner: null,
            purpose: 'example',
            req,
            visibility: 'official_public',
          }),
      })
      examples.push({
        id: media.id,
        filesize: media.filesize,
        height: media.height,
        mimeType: media.mimeType,
        recipe,
        ref,
        sha256: media.sha256,
        width: media.width,
      })
    }
    const published: DatasetReceipt['templates'] = []
    for (const kind of ['free', 'effect'] as const) {
      const template = await runtime.templates.create({
        adminId,
        code: kind === 'free' ? 'free' : `e2-effect-${control.revisionId}`,
        configuration: {
          costCredits: 2,
          displayConfigJson: JSON.stringify({
            name: `E2 ${kind}`,
            coverMediaId: examples[1]!.id,
            examples: [{ inputMediaIds: [examples[0]!.id], outputMediaId: examples[1]!.id }],
          }),
          generationConfigJson: JSON.stringify({
            executorId: 'fixture-v1',
            parameters: { size: '1024x1024' },
            systemPrompt: 'E2 synthetic current template recipe',
          }),
          inputSchemaJson: JSON.stringify({
            ...config.hostCaps,
            ...(kind === 'free'
              ? { maxNotesLength: 0 }
              : { maxDescriptionLength: 0, minImages: 1 }),
          }),
          minClientCapability: 'v1',
          schemaVersion: 1,
          shareConfigJson: '{}',
        },
        kind,
      })
      const stage = await publishE2Template({
        adminId,
        configuration: config,
        kind,
        templateId: template.id,
        templates: runtime.templates,
      })
      writeFileSync(
        path.join(control.snapshotDirectory, `dataset-stage-${kind}.json`),
        JSON.stringify({
          format: 2,
          readyFile: control.ready!.readyFile,
          readySHA: control.ready!.readySHA,
          revisionId: control.revisionId,
          targetDir: control.targetDir,
          ...stage,
        }),
        { flag: 'wx', mode: 0o600 },
      )
      const { isDatasetOwner: _isDatasetOwner, state: _state, ...record } = stage
      published.push(record)
    }
    const owner: DatasetReceipt = {
      adminId,
      datasetConfigSHA: control.datasetConfigSHA,
      examples,
      format: 2,
      readbackSHA: '',
      readyFile: control.ready!.readyFile,
      readySHA: control.ready!.readySHA,
      revisionId: control.revisionId,
      state: 'complete',
      targetDir: control.targetDir,
      templates: published,
    }
    await completeE2Dataset({
      filename: path.join(control.snapshotDirectory, 'dataset-candidate.json'),
      owner,
      readback: () => readback({ config, owner, payload }),
    })
    journal({ details: { ownerSHA: digest({ value: owner }), reused: 0 }, event: 'dataset' })
    return owner
  } finally {
    try {
      await redis.close()
    } finally {
      storage.close()
    }
  }
}

async function readback({
  config,
  owner,
  payload,
}: {
  config: CoreConfig
  owner: Omit<DatasetReceipt, 'readbackSHA'>
  payload: Payload
}) {
  const { digest } = await import('./next-business-host.js')
  const runtime = getCoreRuntime({ payload })
  const admin = await payload.findByID({
    id: owner.adminId,
    collection: 'admins',
    depth: 0,
    overrideAccess: true,
  })
  assert.equal(admin.role, 'admin')
  assert.equal(admin.status, 'active')
  const results = []
  for (const template of owner.templates) {
    const current = await runtime.templates.get({
      adminId: owner.adminId,
      templateId: template.templateId,
    })
    assert.equal(current.status, 'published')
    const inspected = templateEvidence({ configuration: config, template: current })
    assert.equal(inspected.configurationHash, template.configurationHash)
    assert.equal(inspected.exampleMediaHash, template.exampleMediaHash)
    results.push(await readE2CatalogTemplate({ catalog: runtime.catalog, template }))
  }
  for (const example of owner.examples) {
    const media = await runtime.media.readOfficialExample({ mediaId: example.id })
    assert.equal(createHash('sha256').update(media.bytes).digest('hex'), example.sha256)
  }
  return digest({ value: results })
}

function positive({ value }: { value: unknown }): number {
  assert(Number.isSafeInteger(value) && Number(value) > 0)
  return value as number
}
function sha({ value }: { value: unknown }): string {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
  return value as string
}
function uuid({ value }: { value: unknown }): string {
  assert(typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))
  return value as string
}
