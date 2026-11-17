import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import type { CoreConfig } from '../../src/creation/runtime/config.js'

import { parseCoreConfig } from '../../src/creation/runtime/config.js'
import { hostConfiguration } from './next-http-fixture.mjs'

export const canonicalNode =
  '/Users/nako/.cache/heymoro/toolchains/node-v24.22.1-darwin-arm64/bin/node'
export type Approval = Readonly<{
  browser: string
  budget: Readonly<{
    cleanupMs: number
    cpu: number
    diskBytes: number
    durationMs: number
    logBytes: number
    memoryMiB: number
    objectBytes: number
    observerBytes: number
    observerEvents: number
    processes: number
  }>
  buildBudgetMs?: number
  checkout: string
  distDirectory: string
  format: 1
  gates: Readonly<{ cleanCheckout: true; dependencies: true; driver: true; resources: true }>
  generatedOutputs?: readonly string[]
  kind: 'root-approved-template-admin-run'
  mode: 'dev' | 'prod'
  nextPort: number
  node: string
  productionBuildApproved?: true
  runDirectory: string
  runId: string
  runtimeExecutionApproved: true
  scenarios: readonly string[]
  sourceFiles: Readonly<Record<string, string>>
  sourceManifestSHA: string
}>

/** Approval input is root-authored and closed; a derived host receipt is never authority. */
export function parseApproval({ value }: { value: unknown }): Approval {
  const extra =
    value && typeof value === 'object' && (value as Record<string, unknown>).mode === 'prod'
      ? ['productionBuildApproved', 'buildBudgetMs', 'generatedOutputs']
      : []
  const row = exact({
    keys: [
      'format',
      'kind',
      'runtimeExecutionApproved',
      'runId',
      'checkout',
      'distDirectory',
      'runDirectory',
      'node',
      'browser',
      'mode',
      'nextPort',
      'sourceManifestSHA',
      'sourceFiles',
      'budget',
      'gates',
      'scenarios',
      ...extra,
    ],
    value,
  })
  assert(
    row.format === 1 &&
      row.kind === 'root-approved-template-admin-run' &&
      row.runtimeExecutionApproved === true,
    'Root execution approval required.',
  )
  assert(
    typeof row.runId === 'string' && /^[a-z0-9][a-z0-9-]{7,47}$/.test(row.runId),
    'Invalid run ID.',
  )
  for (const key of ['checkout', 'runDirectory', 'browser', 'distDirectory']) {
    assert(
      typeof row[key] === 'string' &&
        path.isAbsolute(row[key]) &&
        path.normalize(row[key]) === row[key],
      'Canonical absolute path required.',
    )
  }
  const checkout = row.checkout as string
  const directory = row.runDirectory as string
  assert(
    !within({ filename: directory, root: checkout }) &&
      !within({ filename: checkout, root: directory }),
    'Checkout/run containment rejected.',
  )
  assert(
    row.node === canonicalNode && ['dev', 'prod'].includes(String(row.mode)),
    'Pinned Node and explicit mode required.',
  )
  const approvedDist = path.join(checkout, 'apps/heymoro/.template-admin-next', String(row.runId))
  assert.equal(row.distDirectory, approvedDist)
  if (row.mode === 'prod') {
    assert(
      row.productionBuildApproved === true &&
        Number.isSafeInteger(row.buildBudgetMs) &&
        Number(row.buildBudgetMs) >= 1000 &&
        Number(row.buildBudgetMs) <= 60000,
    )
    assert.equal(row.distDirectory, approvedDist)
    assert.deepEqual(row.generatedOutputs, ['next', 'next-env.d.ts'])
  }
  assert(
    Number.isSafeInteger(row.nextPort) &&
      Number(row.nextPort) > 1023 &&
      Number(row.nextPort) < 65536,
    'Invalid port.',
  )
  assert(typeof row.sourceManifestSHA === 'string' && /^[a-f0-9]{64}$/.test(row.sourceManifestSHA))
  assert(row.sourceFiles && typeof row.sourceFiles === 'object' && !Array.isArray(row.sourceFiles))
  const entries = Object.entries(row.sourceFiles)
  assert(entries.length > 0 && entries.length <= 10000)
  for (const [filename, sha] of entries) {
    assert(
      !path.isAbsolute(filename) &&
        filename.split('/').every((part) => part && part !== '..' && part !== '.') &&
        /^[a-f0-9]{64}$/.test(String(sha)),
      'Invalid source member.',
    )
  }
  const budget = exact({
    keys: [
      'durationMs',
      'cleanupMs',
      'objectBytes',
      'observerBytes',
      'observerEvents',
      'memoryMiB',
      'cpu',
      'processes',
      'diskBytes',
      'logBytes',
    ],
    value: row.budget,
  })
  for (const amount of Object.values(budget)) {
    assert(Number.isSafeInteger(amount) && Number(amount) > 0, 'Positive bounded budget required.')
  }
  assert(
    Number(budget.durationMs) + Number(budget.cleanupMs) <= 90000 &&
      Number(budget.cleanupMs) >= 10000,
  )
  assert(
    Number(budget.objectBytes) <= 32 * 1048576 &&
      Number(budget.observerBytes) <= 128 * 1048576 &&
      Number(budget.observerEvents) <= 1024,
  )
  assert(
    Number(budget.memoryMiB) >= 1024 &&
      Number(budget.cpu) >= 2 &&
      Number(budget.memoryMiB) <= 4096 &&
      Number(budget.cpu) <= 4 &&
      Number(budget.processes) <= 512 &&
      Number(budget.diskBytes) <= 4 * 1073741824 &&
      Number(budget.logBytes) <= 65536,
  )
  const gates = exact({
    keys: ['driver', 'resources', 'cleanCheckout', 'dependencies'],
    value: row.gates,
  })
  assert(
    Object.values(gates).every((gate) => gate === true),
    'Every external execution gate is required.',
  )
  assert(
    Array.isArray(row.scenarios) &&
      row.scenarios.length > 0 &&
      row.scenarios.length <= 16 &&
      new Set(row.scenarios).size === row.scenarios.length,
  )
  assert(
    row.scenarios.every((scenario) =>
      [
        'a11y',
        'anonymous',
        'auth',
        'catalog',
        'concurrency',
        'corruption',
        'files',
        'generation',
        'happy',
        'origin',
        'read-abort',
        'redis',
        'stale-review',
        'storage',
        'upload-ack',
        'write-ack',
      ].includes(String(scenario)),
    ),
  )
  return freeze({ value: structuredClone(row) }) as Approval
}

export function buildConfiguration({
  approval,
  bucket,
  credentials,
  endpoint,
  redisURL,
}: {
  approval: Approval
  bucket: string
  credentials: { accessKeyId: string; secretAccessKey: string }
  endpoint: string
  redisURL: string
}): CoreConfig {
  const base = hostConfiguration({
    dataDir: path.join(approval.runDirectory, 'target'),
    port: approval.nextPort,
  })
  const candidate = {
    ...base,
    cursorKey: randomBytes(32).toString('base64url'),
    execution: {
      registry: {
        'template-admin-v1': {
          allowedParameters: ['size'],
          model: 'gpt-image-1.5',
          parameterRules: { size: { type: 'string', isRequired: true, values: ['1024x1024'] } },
          provider: 'openai',
          storageBackends: ['template-admin-minio'],
        },
      },
      storageOutput: { backend: 'template-admin-minio', bucket, keyRule: 'task-attempt-result-v1' },
    },
    hostCaps: { ...base.hostCaps, maxImageBytes: 4194304, maxTotalImageBytes: 8388608 },
    identity: { sessionTtlSeconds: 3600, trial: null, wechat: null },
    image: null,
    imageLimits: {
      allowedMimeTypes: ['image/png'],
      maxBytes: 4194304,
      maxPixels: 2000000,
      timeoutMs: 10000,
    },
    naming: null,
    payloadSecret: randomBytes(32).toString('base64url'),
    quote: null,
    redis: { ...base.redis, namespace: `template-admin-${approval.runId}`, url: redisURL },
    s3: {
      backends: [
        {
          backend: 'template-admin-minio',
          buckets: [bucket],
          credentials,
          endpoint,
          forcePathStyle: true,
          region: 'fixture',
        },
      ],
      input: { backend: 'template-admin-minio', bucket },
      limits: {
        connectionTimeoutMs: 1000,
        maxBytes: 4194304,
        operationTimeoutMs: 20000,
        requestTimeoutMs: 10000,
      },
      output: { backend: 'template-admin-minio', bucket },
    },
  }
  return freeze({ value: parseCoreConfig({ value: candidate }) })
}

function exact({
  keys,
  value,
}: {
  keys: readonly string[]
  value: unknown
}): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Closed record required.')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  assert(
    Object.keys(descriptors).length === keys.length &&
      keys.every((key) => descriptors[key] && 'value' in descriptors[key]!),
    'Unknown or missing input field.',
  )
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]))
}
function freeze<T>({ value }: { value: T }): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      freeze({ value: item })
    }
    Object.freeze(value)
  }
  return value
}
function within({ filename, root }: { filename: string; root: string }) {
  return filename === root || filename.startsWith(`${root}${path.sep}`)
}

export function verifySourceBinding({
  actualFiles,
  approval,
}: {
  actualFiles: Readonly<Record<string, string>>
  approval: Approval
}) {
  const sorted = Object.fromEntries(
    Object.entries(actualFiles).sort(([a], [b]) => a.localeCompare(b)),
  )
  assert.equal(
    digest({ bytes: Buffer.from(JSON.stringify(sorted)) }),
    approval.sourceManifestSHA,
    'Full source fingerprint mismatch.',
  )
  assert.deepEqual(
    sorted,
    Object.fromEntries(Object.entries(approval.sourceFiles).sort(([a], [b]) => a.localeCompare(b))),
  )
  assert(Object.hasOwn(sorted, 'apps/heymoro/src/payload.config.ts'))
}
export function readApproval() {
  const filename = process.env.HEYMORO_TEMPLATE_ADMIN_E2E_RUN
  assert(
    filename && path.isAbsolute(filename),
    'Explicit private root approval is required; no default target.',
  )
  assertPrivate({ filename })
  const value: unknown = JSON.parse(readFileSync(filename, 'utf8'))
  return parseApproval({ value })
}
function assertPrivate({ directory = false, filename }: { directory?: boolean; filename: string }) {
  const info = lstatSync(filename)
  assert.equal(realpathSync(filename), filename)
  assert(
    !info.isSymbolicLink() &&
      (directory ? info.isDirectory() : info.isFile()) &&
      info.uid === process.getuid!() &&
      (info.mode & 0o077) === 0,
  )
  if (!directory) {
    assert(info.size <= 65536 || path.basename(filename) === 'core.sqlite')
  }
}
function digest({ bytes }: { bytes: Uint8Array }) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** One resolved root drives build, start, observation and receipts. No external prebuilt reuse. */
export function ownedOutputs({ approval, scenario }: { approval: Approval; scenario?: string }) {
  const root = path.join(approval.checkout, 'apps/heymoro/.template-admin-next', approval.runId)
  if (scenario) {
    assert(approval.scenarios.includes(scenario))
  }
  const distDirectory = scenario ? path.join(root, scenario) : root
  assert.equal(approval.distDirectory, distDirectory)
  if (approval.mode === 'prod') {
    assert(approval.productionBuildApproved)
    assert.deepEqual(approval.generatedOutputs, ['next', 'next-env.d.ts'])
  }
  return Object.freeze({
    distDirectory,
    generatedOutputs: Object.freeze([
      distDirectory,
      path.join(approval.checkout, 'apps/heymoro/next-env.d.ts'),
    ]),
    runtimeDistDirectory: approval.mode === 'dev' ? path.join(distDirectory, 'dev') : distDirectory,
  })
}
