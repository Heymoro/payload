import type { Payload } from 'payload'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

export type E2Control = Readonly<{
  admin: Readonly<{ email: string; password: string }>
  authorityFile: string
  authoritySHA: string
  codes: Readonly<Record<string, string>>
  datasetConfigSHA: string
  datasetOwnerFile: string
  directory: string
  format: 2
  initializationFile: string
  journalDirectory: string
  jsonFile: string
  jsonSHA: string
  kernelPolicySHA: string
  mirror: string
  mode: 'business' | 'initialize'
  profileId: 'e2-local'
  ready: null | Readonly<{
    authorityFile: string
    authoritySHA: string
    datasetOwnerFile: string
    directory: string
    mirror: string
    profileNonce: string
    profileSHA: string
    readyFile: string
    readySHA: string
    revisionId: string
    sourceManifestSHA: string
    targetDir: string
    targetFingerprint: string
    writeRoot: string
  }>
  readyFile: string
  revisionId: string
  rounds: readonly [string, string]
  snapshotDirectory: string
  sourceManifestSHA: string
  targetDir: string
  targetFingerprint: string
  verificationId: string
  writeRoot: string
}>
const directory = '/private/var/folders/gn/wbk8wfbd047_wvwkwtyn331r0000gn/T/heymoro-E0-next-5RQ7OV'
const roles = ['next-1', 'next-2', 'seed', 'attest', 'snapshot', 'jobs-1', 'jobs-2'] as const
export type E2Role = (typeof roles)[number]

export function digest({ value }: { value: unknown }): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
export function readE2Control(): { control: E2Control; role: E2Role } {
  const filename = process.env.HEYMORO_E2_CONTROL_FILE
  const role = process.env.HEYMORO_E2_ROLE as E2Role
  assert(filename && path.isAbsolute(filename) && filename.startsWith(`${directory}/E2-`))
  assert(roles.includes(role))
  assert(!lstatSync(filename).isSymbolicLink() && lstatSync(filename).isFile())
  assert(lstatSync(filename).size <= 65_536)
  const control = JSON.parse(readFileSync(filename, 'utf8')) as E2Control
  assert.equal(control.format, 2)
  assert.equal(control.profileId, 'e2-local')
  assert.match(control.revisionId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  assert.equal(control.directory, directory)
  assert.equal(control.mirror, `${directory}/source`)
  assert.equal(control.writeRoot, directory)
  assert.match(control.sourceManifestSHA, /^[a-f0-9]{64}$/)
  assert.match(control.kernelPolicySHA, /^[a-f0-9]{64}$/)
  assert(['business', 'initialize'].includes(control.mode))
  assert.equal(filename, path.join(directory, `E2-${control.verificationId}`, 'control.json'))
  canonical({ filename })
  assert.equal(control.targetDir, path.join(directory, `e2-target-${control.revisionId}`))
  assert.equal(
    control.readyFile,
    path.join(directory, 'proof', `E2-ready-${control.revisionId}.json`),
  )
  assert.equal(control.initializationFile, path.join(path.dirname(filename), 'initialization.json'))
  const approval = JSON.parse(
    readFileSync(path.join(path.dirname(filename), 'gate-b.json'), 'utf8'),
  ) as {
    action: string
    approvedBy: string
    authorityFile: string
    authoritySHA: string
    binding: Record<string, string>
    format: number
    frozenInputs: Record<string, string>
    kernelPolicySHA: string
    verificationId: string
  }
  assert.equal(
    approval.action,
    control.mode === 'initialize' ? 'initialize-fresh-e2' : 'run-e2-epoch',
  )
  assert.equal(approval.format, 3)
  assert.equal(approval.approvedBy, 'root')
  assert.equal(approval.authorityFile, control.authorityFile)
  assert.equal(approval.authoritySHA, control.authoritySHA)
  assert.equal(approval.kernelPolicySHA, control.kernelPolicySHA)
  for (const key of [
    'directory',
    'mirror',
    'writeRoot',
    'revisionId',
    'targetDir',
    'readyFile',
    'datasetOwnerFile',
    'sourceManifestSHA',
    'targetFingerprint',
  ] as const) {
    assert.equal(approval.binding[key], control[key])
  }
  canonical({ filename: control.authorityFile })
  assert.equal(fileSHA({ filename: control.authorityFile }), control.authoritySHA)
  assert.equal(approval.frozenInputs[control.authorityFile], control.authoritySHA)
  const authority = JSON.parse(readFileSync(control.authorityFile, 'utf8')) as {
    action: string
    actualManifest: Record<string, string>
    approvedBy: string
    controllerHashes: Record<string, string>
    format: number
    overlays: Record<string, { runtimeBase64: string; runtimeSHA: string; sourceSHA: string }>
    profileId: string
    sourceManifest: Record<string, string>
  } & Record<string, unknown>
  assert.equal(authority.format, 3)
  assert.equal(authority.profileId, 'e2-local')
  assert.equal(authority.action, 'prepare-source-only')
  assert.equal(authority.approvedBy, 'root')
  for (const key of [
    'directory',
    'mirror',
    'writeRoot',
    'revisionId',
    'targetDir',
    'readyFile',
    'datasetOwnerFile',
    'sourceManifestSHA',
    'targetFingerprint',
  ] as const) {
    assert.equal(authority[key], control[key])
  }
  assert.equal(
    digest({
      value: Object.fromEntries(
        Object.entries(authority.sourceManifest).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    }),
    control.sourceManifestSHA,
  )
  const runtime = { ...authority.sourceManifest }
  const overlayNames = [
    'payload/apps/heymoro/next-env.d.ts',
    'payload/apps/heymoro/next.config.mjs',
  ]
  assert.deepEqual(Object.keys(authority.overlays).sort(), overlayNames.sort())
  for (const [name, overlay] of Object.entries(authority.overlays)) {
    assert.equal(overlay.sourceSHA, authority.sourceManifest[name])
    const bytes = Buffer.from(overlay.runtimeBase64, 'base64')
    assert.equal(bytes.toString('base64'), overlay.runtimeBase64)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), overlay.runtimeSHA)
    runtime[name] = overlay.runtimeSHA
  }
  assert.deepEqual(runtime, authority.actualManifest)
  for (const [name, sha] of Object.entries(authority.actualManifest)) {
    assert(
      !name.split('/').some((part) => part === '..') &&
        [...name].every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
    )
    if (name !== 'payload/apps/heymoro/next-env.d.ts') {
      assert.equal(approval.frozenInputs[path.join(control.mirror, name)], sha)
    }
  }
  assert.equal(approval.verificationId, control.verificationId)
  assert.equal(
    approval.frozenInputs[filename],
    createHash('sha256').update(readFileSync(filename)).digest('hex'),
  )
  if (control.mode === 'initialize') {
    assert.equal(role, 'attest')
  }
  assert.equal(control.jsonFile, process.env.HEYMORO_CORE_CONFIG_FILE)
  canonical({ filename: control.jsonFile })
  assert.equal(fileSHA({ filename: control.jsonFile }), control.jsonSHA)
  assert.equal(approval.frozenInputs[control.jsonFile], control.jsonSHA)
  assert.equal(control.rounds.length, 2)
  assert(Date.parse(control.rounds[1]) > Date.parse(control.rounds[0]) + 60_000)
  assert(Date.parse(control.rounds[1]) < Date.parse(control.rounds[0]) + 3_600_000)
  for (const absolute of [control.journalDirectory, control.snapshotDirectory]) {
    assert.equal(path.dirname(absolute), path.dirname(filename))
  }
  assert.equal(
    control.datasetOwnerFile,
    path.join(directory, 'proof', `E2-dataset-${control.revisionId}.json`),
  )
  return { control: Object.freeze(control), role }
}
function canonical({ filename }: { filename: string }) {
  assert(path.isAbsolute(filename) && path.normalize(filename) === filename)
  let current = path.parse(filename).root
  for (const part of filename.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    assert(!lstatSync(current).isSymbolicLink())
  }
  assert.equal(realpathSync(filename), filename)
}
function fileSHA({ filename }: { filename: string }) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex')
}

// No product runtime import or builder executes until sealed Gate B and authority bytes agree.
readE2Control()
const { default: sharp } = await import('sharp')
const { getCreationSQLiteAdapter } =
  await import('../../src/creation/infrastructure/payload/sqlite-unit-of-work.js')
const { createCreationWriteGate } =
  await import('../../src/creation/infrastructure/payload/write-gate.js')
const { readCoreConfig } = await import('../../src/creation/runtime/config.js')
const { buildCorePayloadConfig } = await import('../../src/creation/runtime/payload-config.js')
const { getCoreRuntime } = await import('../../src/creation/runtime/services.js')
export const gate = createCreationWriteGate()

export function journal({
  details,
  event,
}: {
  details: Record<string, number | string>
  event: 'dataset' | 'image' | 'naming' | 'native-jobs' | 'ready' | 'wechat'
}) {
  const { control, role } = readE2Control()
  appendFileSync(
    path.join(control.journalDirectory, `${role}-${process.pid}.jsonl`),
    `${JSON.stringify({ details, event, pid: process.pid, role, verificationId: control.verificationId })}\n`,
    { mode: 0o600 },
  )
}
export async function syntheticPNG({ color }: { color: 'blue' | 'green' | 'red' }) {
  return sharp({ create: { background: color, channels: 3, height: 2, width: 3 } })
    .png()
    .toBuffer()
}
export function createE2Host() {
  const { control, role } = readE2Control()
  const config = readCoreConfig({ filename: control.jsonFile })
  assert.equal(config.dataDir, control.targetDir)
  assert.equal(realpathSync(config.dataDir), config.dataDir)
  assert(!lstatSync(config.dataDir).isSymbolicLink())
  assert.equal(
    realpathSync(path.join(config.dataDir, 'profile.json')),
    path.join(config.dataDir, 'profile.json'),
  )
  const profile = JSON.parse(readFileSync(path.join(config.dataDir, 'profile.json'), 'utf8')) as {
    fingerprint: string
    format: number
    nonce: string
    profile: string
    state: string
  }
  assert.equal(profile.state, 'ready')
  assert.equal(profile.fingerprint, control.targetFingerprint)
  assert.equal(profile.profile, 'heymoro-core')
  assert.equal(profile.format, 1)
  const profileSHA = createHash('sha256')
    .update(readFileSync(path.join(config.dataDir, 'profile.json')))
    .digest('hex')
  if (control.mode === 'initialize') {
    assert.equal(control.ready, null)
    const initialized = JSON.parse(readFileSync(control.initializationFile, 'utf8')) as {
      authoritySHA: string
      controlSHA: string
      format: number
      initializer: { commandId: string; exit: number }
      jsonSHA: string
      profileNonce: string
      profileSHA: string
      targetDir: string
      targetFingerprint: string
      verificationId: string
    }
    assert.equal(initialized.format, 2)
    assert.equal(initialized.authoritySHA, control.authoritySHA)
    assert.equal(
      initialized.controlSHA,
      createHash('sha256').update(readFileSync(process.env.HEYMORO_E2_CONTROL_FILE!)).digest('hex'),
    )
    assert.equal(initialized.verificationId, control.verificationId)
    assert.equal(initialized.jsonSHA, control.jsonSHA)
    assert.equal(initialized.targetDir, config.dataDir)
    assert.equal(initialized.targetFingerprint, control.targetFingerprint)
    assert.equal(initialized.profileSHA, profileSHA)
    assert.equal(initialized.profileNonce, profile.nonce)
    assert.equal(initialized.initializer.exit, 0)
    assert.match(initialized.initializer.commandId, /^[a-f0-9-]{36}$/)
  } else {
    const ready = control.ready
    assert(ready)
    assert.equal(ready.targetDir, config.dataDir)
    assert.equal(ready.revisionId, control.revisionId)
    assert.equal(
      ready.readyFile,
      path.join(directory, 'proof', `E2-ready-${control.revisionId}.json`),
    )
    assert.equal(
      createHash('sha256').update(readFileSync(ready.readyFile)).digest('hex'),
      ready.readySHA,
    )
    const receipt = JSON.parse(readFileSync(ready.readyFile, 'utf8')) as Record<string, unknown>
    assert.equal(receipt.format, 2)
    assert.equal(receipt.approvedBy, 'root')
    assert.equal(receipt.authorityFile, control.authorityFile)
    assert.equal(ready.authorityFile, control.authorityFile)
    assert.equal(receipt.authoritySHA, control.authoritySHA)
    assert.equal(receipt.sourceManifestSHA, control.sourceManifestSHA)
    assert.equal(ready.authoritySHA, control.authoritySHA)
    assert.equal(ready.sourceManifestSHA, control.sourceManifestSHA)
    assert.equal(receipt.action, 'approve-fresh-e2-ready')
    for (const key of [
      'revisionId',
      'targetDir',
      'readyFile',
      'profileSHA',
      'profileNonce',
      'targetFingerprint',
    ] as const) {
      assert.equal(receipt[key], ready[key])
    }
    assert.equal(ready.profileSHA, profileSHA)
    assert.equal(ready.profileNonce, profile.nonce)
    assert.equal(ready.targetFingerprint, control.targetFingerprint)
  }
  const clock = () => control.rounds[role.endsWith('2') ? 1 : 0]
  const built = buildCorePayloadConfig({
    clock,
    config,
    gate,
    ports: {
      image: async () => {
        const bytes = await syntheticPNG({ color: 'green' })
        journal({
          details: { outputSHA: createHash('sha256').update(bytes).digest('hex') },
          event: 'image',
        })
        return {
          bytes,
          contentType: 'image/png',
          kind: 'output',
          requestId: `e2-image-${process.pid}`,
        }
      },
      naming: () => {
        journal({ details: { recipe: 'e2-name-v1' }, event: 'naming' })
        return Promise.resolve({
          name: 'E2 synthetic creation',
          kind: 'name',
          requestId: `e2-name-${process.pid}`,
        })
      },
      wechat: ({ code }) => {
        assert(Object.hasOwn(control.codes, code), 'Unregistered synthetic Wechat code.')
        journal({ details: { codeHash: digest({ value: code }) }, event: 'wechat' })
        return Promise.resolve({ openId: control.codes[code]!, unionId: null })
      },
    },
  })
  return { built, clock, config, control }
}
export async function closeE2Payload({ payload }: { payload: Payload }) {
  const client = getCreationSQLiteAdapter({ payload }).client
  try {
    await getCoreRuntime({ payload }).close()
  } finally {
    try {
      await payload.destroy()
    } finally {
      client.close()
    }
  }
}

export const hostInstance = createE2Host()
// eslint-disable-next-line no-restricted-exports -- Next @payload-config ABI requires a default config export.
export default hostInstance.built
