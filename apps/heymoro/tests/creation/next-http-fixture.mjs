import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assertE2RunAuthority } from './next-http-e2-revision.mjs'
import {
  createE2LeaseRegistry,
  e2InitializationCommand,
  e2KernelProfile,
  selectE2Role,
} from './next-http-e2-profile.mjs'

export const node = '/Users/nako/.cache/heymoro/toolchains/node-v24.22.1-darwin-arm64/bin/node'
const pnpm = '/Users/nako/.cache/node/corepack/v1/pnpm/11.28.6/bin/pnpm.cjs'
const store = '/Users/nako/Library/pnpm/store'
const excludes = '/Users/nako/.codex/backup-excludes.txt'
const guard = fileURLToPath(new URL('./next-http-guard.cjs', import.meta.url))
const source = realpathSync(fileURLToPath(new URL('../../../../../', import.meta.url)))
const frameworks = [
  'payload',
  'db-sqlite',
  'richtext-lexical',
  'transformer-sharp',
  'next',
  'ui',
  'translations',
  'drizzle',
  'graphql',
]
const within = ({ filename, root }) =>
  filename === root || filename.startsWith(`${root}${path.sep}`)
const sleep = ({ milliseconds }) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const hash = ({ filename }) => createHash('sha256').update(readFileSync(filename)).digest('hex')
const sensitive = ({ name }) =>
  /^\.(?:env|data|next)/i.test(name) || name === 'node_modules' || name.endsWith('.tsbuildinfo')

export function processClosure({ pids, nodePids, events, processes = [] }) {
  pids = new Set(pids)
  nodePids = new Set(nodePids)
  let size
  do {
    size = pids.size
    for (const event of events) {
      if (event.event === 'handshake' && pids.has(event.ppid)) {
        pids.add(event.pid)
        nodePids.add(event.pid)
      }
      if (event.event !== 'child' || !pids.has(event.pid)) continue
      pids.add(event.child)
      if (event.node) nodePids.add(event.child)
    }
    for (const entry of processes) {
      if (!pids.has(entry.ppid)) continue
      pids.add(entry.pid)
      if (isNodeProcess({ command: entry.command })) nodePids.add(entry.pid)
    }
  } while (size !== pids.size)
  return { pids, nodePids }
}

export function isNodeProcess({ command }) {
  const basename = path.basename(command)
  return (
    ['node', 'nodejs', 'pnpm'].includes(basename) ||
    /^next-server(?: \(v[\w.-]+\))?$/.test(basename)
  )
}

export function collectOwnedGroups({ initialPGID, uid, knownPIDs, events, policy }) {
  const groups = new Set([initialPGID])
  for (const event of events) {
    if (event.event !== 'child' || !event.detached || !knownPIDs.has(event.pid)) continue
    assert(
      event.scope === 'next-typescript-cli' &&
        event.nodeCanonical === policy?.node &&
        event.scriptCanonical === policy?.script,
      'Detached child identity is outside the exact compiler policy.',
    )
    const kernel = event.kernel
    assert(
      kernel &&
        kernel.pid === event.child &&
        kernel.ppid === event.pid &&
        kernel.pgid === event.child &&
        kernel.uid === uid &&
        kernel.birth,
      'Detached child kernel identity is unproven.',
    )
    groups.add(kernel.pgid)
  }
  assert(groups.size <= 17, 'Explicit compiler group budget exceeded.')
  return groups
}

export function maySignalGroup({ members }) {
  return members.some((member) => !member.state.startsWith('Z'))
}

export function assertProcessIdentity({ recorded, current }) {
  assert(Number.isInteger(current.uid) && current.birth, 'Kernel PID identity is incomplete.')
  assert.deepEqual(current, recorded, 'Owned PID birth identity changed.')
}

export async function observingHTTP({ work, observer, cancel, pollMs = 100 }) {
  let settled = false
  let result
  let workError
  const pending = Promise.resolve()
    .then(work)
    .then(
      (value) => {
        result = value
        settled = true
      },
      (error) => {
        workError = error
        settled = true
      },
    )
  while (!settled) {
    try {
      await observer()
    } catch (error) {
      cancel()
      await Promise.race([pending, sleep({ milliseconds: 1000 })])
      const failure = new Error('E0 observer failed during the HTTP wait.', { cause: error })
      failure.code = 'E0_OBSERVER'
      failure.observerError = {
        name: error.name,
        code: error.code,
        message: error.message.slice(0, 500),
      }
      throw failure
    }
    if (!settled) await sleep({ milliseconds: pollMs })
  }
  if (workError) throw workError
  return result
}

export function assertSignalRaceExited({ error, groupMembers, alivePIDs, portOwners }) {
  if (error.code !== 'EPERM' || groupMembers.length || alivePIDs.length || portOwners.length)
    throw error
  return { signalError: error.code, confirmedExitedAfterRace: true }
}

export function attemptEvidence({ processInfo, snapshot }) {
  return {
    name: processInfo.name,
    pid: processInfo.pgid,
    pgid: processInfo.pgid,
    pids: [...processInfo.pids],
    nodePids: [...processInfo.nodePids],
    executables: processInfo.executables || {},
    exit: processInfo.code ?? null,
    signal: processInfo.signal ?? null,
    signalErrors: processInfo.signalErrors || [],
    startupFailure: processInfo.startupFailure || null,
    observerError: processInfo.observerError || null,
    output: (processInfo.output || '')
      .slice(-65_536)
      .replace(/(Bearer\s+|(?:apiKey|token|password)\s*[:=]\s*)[^\s,]+/gi, '$1[REDACTED]'),
    ...snapshot,
  }
}
export function assertNodeEvidence({ nodePids, events }) {
  for (const pid of nodePids) {
    assert(
      events.some((event) => event.pid === pid && event.event === 'handshake'),
      `Missing guard handshake for PID ${pid}.`,
    )
    assert(
      events.some(
        (event) =>
          event.pid === pid &&
          event.event === 'native-probe' &&
          event.normal &&
          event.env &&
          event.oldData,
      ),
      `Missing OS native guard for PID ${pid}.`,
    )
  }
}
const revisedSource = 'payload/apps/heymoro/src/creation/runtime/config.ts'
const originalConfigSHA = '2d6118958cd6d6674e78ab986d0007a38c93b683bba28ce7c5d62218a7d1bd70'
const revisedConfigSHA = '30719ca0a1b1035a0d1a2cfc4940c9dcda577a7d36f87bb259f4c5b0f8d30397'
const sourceAuthorization = '/tmp/heymoro-E0R-source-authorization.json'

export function assertAuthorizedBaseline({ oldBaseline, newBaseline, authorization }) {
  assert.deepEqual(authorization.scope, [revisedSource])
  const filename = revisedSource.slice('payload/'.length)
  assert.equal(oldBaseline.payload.files[filename], authorization.beforeSHA)
  assert.equal(newBaseline.payload.files[filename], authorization.afterSHA)
  const expected = structuredClone(oldBaseline)
  expected.payload.files[filename] = authorization.afterSHA
  assert.deepEqual(
    newBaseline,
    expected,
    'Only the approved config SHA may change in the baseline.',
  )
}

function controlledSourceBaseline() {
  const authorization = JSON.parse(readFileSync(sourceAuthorization, 'utf8'))
  assert.equal(authorization.beforeSHA, originalConfigSHA)
  assert.equal(authorization.afterSHA, revisedConfigSHA)
  assert.equal(authorization.baseline, '/tmp/heymoro-E0R-preserved-state.json')
  assert.equal(authorization.originalBaselineRetained, '/tmp/heymoro-E0-preserved-state.json')
  const oldBaseline = JSON.parse(readFileSync(authorization.originalBaselineRetained, 'utf8'))
  const newBaseline = JSON.parse(readFileSync(authorization.baseline, 'utf8'))
  assertAuthorizedBaseline({ oldBaseline, newBaseline, authorization })
  return newBaseline
}

const generatedOverlay = {
  filename: 'payload/apps/heymoro/next-env.d.ts',
  sourceSHA: '85d7858178472e770bed40b3c6e69c5f5925b4787aaae6ef6a60a2fd8dd7de16',
  generatedSHA: '0f70629890b72a0a82e91972cc032c04b658b26c265373cb711cf576bfbf8fcc',
  generator: 'Next16.4.2/writeAppTypeDeclarations',
  distDir: '.next',
  provenancePID: 87049,
}
export function assertGeneratedOverlay({ sourceHashes, actualHashes }) {
  assert.equal(sourceHashes[generatedOverlay.filename], generatedOverlay.sourceSHA)
  assert.deepEqual(
    actualHashes,
    { ...sourceHashes, [generatedOverlay.filename]: generatedOverlay.generatedSHA },
    'Unexpected mirror overlay beyond the exact proven Next declaration.',
  )
  return generatedOverlay
}

function assertSourceRevision({ directory, sourceHashes, actualHashes }) {
  const proof = path.join(directory, 'proof')
  const revision = JSON.parse(readFileSync(path.join(proof, 'E0R-source-revision.json'), 'utf8'))
  assert.equal(revision.directory, directory)
  assert.equal(revision.authorizationSHA, hash({ filename: sourceAuthorization }))
  assert.equal(revision.beforeSHA, originalConfigSHA)
  assert.equal(revision.afterSHA, revisedConfigSHA)
  assert.deepEqual(revision.changedFiles, [revisedSource])
  const before = JSON.parse(readFileSync(path.join(proof, 'E0R-source-before.json'), 'utf8'))
  const after = JSON.parse(readFileSync(path.join(proof, 'E0R-source-after.json'), 'utf8'))
  assert.equal(before[revisedSource], originalConfigSHA)
  const expected = { ...before, [revisedSource]: revisedConfigSHA }
  assert.deepEqual(after, expected)
  assert.deepEqual(sourceHashes, after, 'Original source differs from the explicit E0R revision.')
  assert.deepEqual(
    revision.generatedOverlay,
    assertGeneratedOverlay({ sourceHashes, actualHashes }),
  )
  assert.equal(
    revision.beforeManifestSHA,
    hash({ filename: path.join(proof, 'E0R-source-before.json') }),
  )
  assert.equal(
    revision.afterManifestSHA,
    hash({ filename: path.join(proof, 'E0R-source-after.json') }),
  )
  assert.equal(revision.previousOwnerSHA, hash({ filename: path.join(proof, 'ready-owner.json') }))
  const owner = JSON.parse(readFileSync(path.join(proof, 'ready-owner-E0R.json'), 'utf8'))
  assert.deepEqual(owner, {
    ...JSON.parse(readFileSync(path.join(proof, 'ready-owner.json'), 'utf8')),
    revision,
  })
  return revision
}

export function verificationEpoch({ directory, report, parentSHA }) {
  const verificationId = randomUUID()
  return {
    verificationId,
    reportFile: path.join(directory, 'proof', `verification-${verificationId}.json`),
    parentPassedReportPath: path.join(directory, 'proof/report.json'),
    parentPassedReportSHA: parentSHA,
    initializationEvidence: report.commands?.find((entry) => entry.name === 'core-init'),
    rounds: [],
    commands: [],
    cleanup: [],
  }
}

export function assertPassedVerification({
  report,
  directory,
  sourceUnchanged,
  ownerUnchanged,
  processesGone,
  portClosed,
}) {
  assert.equal(report.directory, directory)
  assert.equal(report.mirror, path.join(directory, 'source'))
  assert.equal(
    report.status,
    'passed',
    'Independent verification requires an already passed report.',
  )
  assert.equal(report.cleanupUnconfirmed, false)
  assert(
    sourceUnchanged && ownerUnchanged && processesGone && portClosed,
    'Passed verification inputs or ownership changed.',
  )
  assert.equal(report.rounds.length, 2)
  for (const [index, round] of report.rounds.entries()) {
    assert.equal(round.round, index + 1)
    assert.equal(round.status, 200)
    assert.equal(round.database, 'ok')
    assert.equal(round.coldProcess, true)
    assert.match(round.requestId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
    assert(round.compiledRoots.includes(path.join(directory, 'source')))
    assert.equal(round.compiledJSON, path.join(directory, 'core.json'))
    assert(round.owners.length > 0 && round.owners.every((pid) => round.processes.includes(pid)))
    assert(
      report.cleanup.some(
        (entry) => entry.command === `next-${index + 1}` && entry.groupExited && entry.portClosed,
      ),
    )
  }
}

export function assertResumeState({
  report,
  directory,
  manifest,
  expectedFiles,
  sourceHashes,
  actualHashes,
  hasTarget,
  readyTarget = false,
  allowGeneratedOverlay = false,
}) {
  assert.equal(report.directory, directory, 'Resume requires the original owned directory.')
  assert.equal(
    report.mirror,
    path.join(directory, 'source'),
    'Resume requires the original owned source copy.',
  )
  assert(
    ['failed', 'prepared-only'].includes(report.status),
    'Only a preparation failure or preparation-only result is resumable.',
  )
  assert(
    report.cleanupUnconfirmed !== true,
    'Resume requires independent reconciliation of the prior unconfirmed cleanup.',
  )
  if (readyTarget) {
    const initializations = report.commands.filter((entry) => entry.name === 'core-init')
    assert(
      hasTarget && initializations.length === 1 && initializations[0].exit === 0,
      'Ready recovery requires exactly one successful owned initialization.',
    )
  } else assert(!hasTarget, 'An initialized target is outside preparation resume.')
  assert(
    report.commands.every((entry) =>
      [
        'os-negative',
        'rsync-dry-run',
        'rsync-copy',
        'sdk-install',
        'sdk-build',
        'payload-install',
        'framework-types',
        'root-tooling-install',
        ...(readyTarget ? ['core-init', 'ready-attest', 'next-1', 'next-2'] : []),
      ].includes(entry.name),
    ),
    'Resume crossed preparation boundary.',
  )
  assert(
    report.cleanup.every((entry) => entry.groupExited && entry.portClosed),
    'Resume requires confirmed cleanup.',
  )
  if (allowGeneratedOverlay) assertGeneratedOverlay({ sourceHashes, actualHashes })
  const expected = new Set(expectedFiles)
  for (const filename of manifest) {
    assert(expected.has(filename), 'Resume manifest exceeds the fixed source scope.')
    assert.equal(
      actualHashes[filename],
      allowGeneratedOverlay && filename === generatedOverlay.filename
        ? generatedOverlay.generatedSHA
        : sourceHashes[filename],
      `Resume source bytes changed: ${filename}`,
    )
  }
}

/** Fixed source surface. No recursive copy of a checkout, environment, database, or dependency tree. */
export function sourceAllowlist() {
  const files = []
  const add = (relative) => {
    const filename = path.join(source, relative)
    assert(!relative.split('/').some((name) => sensitive({ name })), 'Excluded source path.')
    assert(
      lstatSync(filename).isFile() && !lstatSync(filename).isSymbolicLink(),
      'Unknown source symlink or non-file.',
    )
    assert.equal(realpathSync(filename), filename, 'Source ancestor symlink.')
    files.push(relative)
  }
  const tree = (relative) => {
    for (const entry of readdirSync(path.join(source, relative), { withFileTypes: true })) {
      if (sensitive({ name: entry.name })) continue
      assert(!entry.isSymbolicLink(), 'Unknown source tree symlink.')
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) tree(child)
      else add(child)
    }
  }
  for (const filename of [
    'next.config.mjs',
    'package.json',
    'tsconfig.json',
    'next-env.d.ts',
    'AGENTS.md',
    'scripts/init-target.mjs',
  ])
    add(`payload/apps/heymoro/${filename}`)
  tree('payload/apps/heymoro/src')
  for (const framework of frameworks) {
    for (const filename of ['package.json', 'tsconfig.json'])
      add(`payload/packages/${framework}/${filename}`)
    tree(`payload/packages/${framework}/src`)
  }
  for (const filename of [
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'tsconfig.base.json',
    'AGENTS.md',
  ])
    add(`payload/${filename}`)
  add('payload/tools/assets.d.ts')
  for (const filename of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json'])
    add(`ai-engine/${filename}`)
  tree('ai-engine/src')
  return files.sort()
}

export function hostConfiguration({ dataDir, port }) {
  return {
    dataDir,
    publicApiUrl: `http://127.0.0.1:${port}`,
    payloadSecret: 'explicit-isolated-E0-secret-with-no-production-use',
    cursorKey: Buffer.alloc(32, 11).toString('base64url'),
    capabilities: ['v1'],
    identity: { sessionTtlSeconds: 3600, trial: null, wechat: null },
    hostCaps: {
      allowedMimeTypes: ['image/png'],
      minImages: 0,
      maxImages: 4,
      maxImageBytes: 1000,
      maxTotalImageBytes: 1500,
      maxDescriptionLength: 200,
      maxNotesLength: 100,
    },
    imageLimits: {
      allowedMimeTypes: ['image/png'],
      maxBytes: 100000,
      maxPixels: 100000,
      timeoutMs: 1000,
    },
    redis: {
      url: 'redis://127.0.0.1:1/0',
      connectTimeoutMs: 200,
      namespace: 'e0-unused',
      leaseMs: 3000,
      renewEveryMs: 500,
      maxHoldMs: 15000,
      acquireTimeoutMs: 5000,
      retryDelayMs: 5,
      commandTimeoutMs: 500,
    },
    s3: {
      backends: [
        {
          backend: 'e0-unused',
          endpoint: 'http://127.0.0.1:1',
          region: 'fixture',
          credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
          buckets: ['fixture-input', 'fixture-output'],
          forcePathStyle: true,
        },
      ],
      limits: {
        connectionTimeoutMs: 100,
        requestTimeoutMs: 500,
        operationTimeoutMs: 2000,
        maxBytes: 100000,
      },
      input: { backend: 'e0-unused', bucket: 'fixture-input' },
      output: { backend: 'e0-unused', bucket: 'fixture-output' },
    },
    execution: null,
    quote: null,
    image: null,
    naming: null,
    worker: { leaseMs: 10000, engineTimeoutMs: 1000 },
    namingWorker: { leaseMs: 2000, engineTimeoutMs: 1000 },
  }
}

export async function createFixture({
  resume,
  allowNew = false,
  readyTarget = false,
  verifyExisting = false,
} = {}) {
  assert(
    !verifyExisting || (resume && readyTarget && !allowNew),
    'Verification uses only an existing ready target.',
  )
  assert(resume || allowNew, 'Explicit owned directory required; no automatic second source copy.')
  assert.equal(process.execPath, node, 'Run with the pinned Node executable.')
  assert.equal(process.version, 'v24.22.1')
  accessSync(excludes, constants.R_OK)
  assert.equal(
    spawnSync(node, [pnpm, '--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: `${path.dirname(node)}:/usr/bin:/bin`, COREPACK_ENABLE_NETWORK: '0' },
    }).stdout.trim(),
    '11.28.6',
  )
  const directory = resume
    ? realpathSync(resume)
    : realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E0-next-')))
  let previous
  if (resume) {
    previous = JSON.parse(readFileSync(path.join(directory, 'proof/report.json'), 'utf8'))
    assert.equal(previous.directory, directory)
    assert.equal(previous.mirror, path.join(directory, 'source'))
  }
  const mirror = path.join(directory, 'source')
  assert(!within({ filename: mirror, root: source }) && !within({ filename: source, root: mirror }))
  const cwd = spawnSync('/usr/sbin/lsof', ['-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
    timeout: 5000,
  }).stdout
  assert(!cwd?.split('\n').includes(`n${mirror}`), 'Destination belongs to another process.')
  for (const name of ['source', 'home', 'logs', 'proof', 'synthetic', 'synthetic/.data'])
    mkdirSync(path.join(directory, name), { recursive: true, mode: 0o700 })
  const nativeProbe = {
    normal: path.join(directory, 'synthetic', 'normal.sqlite'),
    env: path.join(directory, 'synthetic', '.env.native.sqlite'),
    oldData: path.join(directory, 'synthetic', '.data', 'native.sqlite'),
  }
  for (const filename of Object.values(nativeProbe)) {
    const database = new DatabaseSync(filename, { readOnly: Boolean(resume) })
    if (!resume)
      database.exec('CREATE TABLE owned_probe (id INTEGER); INSERT INTO owned_probe VALUES (73)')
    assert.equal(database.prepare('SELECT id FROM owned_probe').get().id, 73)
    database.close()
  }
  assert.equal(hash({ filename: nativeProbe.normal }), hash({ filename: nativeProbe.env }))
  assert.equal(hash({ filename: nativeProbe.normal }), hash({ filename: nativeProbe.oldData }))
  writeFileSync(path.join(directory, 'synthetic', 'source.txt'), 'owned-synthetic')
  const files = sourceAllowlist()
  const filesFrom = path.join(directory, 'proof', 'source-files.txt')
  if (resume) {
    const manifest = readFileSync(filesFrom, 'utf8').trim().split('\n')
    const sourceHashes = {}
    const actualHashes = {}
    for (const filename of manifest) {
      assert(files.includes(filename), 'Resume manifest exceeds fixed source scope.')
      sourceHashes[filename] = hash({ filename: path.join(source, filename) })
      actualHashes[filename] = hash({ filename: path.join(mirror, filename) })
    }
    if (readyTarget) assertSourceRevision({ directory, sourceHashes, actualHashes })
    if (verifyExisting) {
      const kernel = processTable()
      const ownedPIDs = new Set(previous.rounds.flatMap((round) => round.processes))
      const ownedGroups = new Set(previous.cleanup.slice(-3).flatMap((entry) => entry.groups))
      await assertPortClosed({ port: previous.port })
      readyOwnership({
        fixture: {
          directory,
          dataDir: path.join(directory, 'new-target'),
          jsonFile: path.join(directory, 'core.json'),
          filesFrom,
          report: previous,
          port: previous.port,
        },
      })
      assertPassedVerification({
        report: previous,
        directory,
        sourceUnchanged: true,
        ownerUnchanged: true,
        processesGone: !kernel.some(
          (entry) => ownedPIDs.has(entry.pid) || ownedGroups.has(entry.pgid),
        ),
        portClosed: true,
      })
    } else
      assertResumeState({
        report: previous,
        directory,
        manifest,
        expectedFiles: files,
        sourceHashes,
        actualHashes,
        hasTarget: existsSync(path.join(directory, 'new-target')),
        readyTarget,
        allowGeneratedOverlay: readyTarget,
      })
    if (!verifyExisting)
      for (const [name, contents] of [
        ['report-first.json', readFileSync(path.join(directory, 'proof/report.json'))],
        ['source-files-first.txt', readFileSync(filesFrom)],
      ]) {
        const filename = path.join(directory, 'proof', name)
        if (!existsSync(filename)) writeFileSync(filename, contents, { flag: 'wx', mode: 0o600 })
      }
  }
  if (!verifyExisting) writeFileSync(filesFrom, `${files.join('\n')}\n`, { mode: 0o600 })
  const sourceBytes = files.reduce(
    (size, filename) => size + statSync(path.join(source, filename)).size,
    0,
  )
  const space = statfsSync(directory)
  assert(
    Number(space.bavail) * Number(space.bsize) > sourceBytes + 8 * 1024 ** 3,
    'Insufficient free space; no existing backups were removed.',
  )
  const port = previous ? previous.port : await unusedPort()
  await assertPortClosed({ port: port })
  const payloadRoot = path.join(mirror, 'payload')
  const app = path.join(payloadRoot, 'apps', 'heymoro')
  const dataDir = path.join(directory, 'new-target')
  const jsonFile = path.join(directory, 'core.json')
  const configuration = JSON.stringify(hostConfiguration({ dataDir, port }))
  if (readyTarget)
    assert.equal(readFileSync(jsonFile, 'utf8'), configuration, 'Ready JSON changed; no overwrite.')
  else writeFileSync(jsonFile, configuration, { mode: 0o600 })
  const guardConfig = path.join(directory, 'guard.json')
  const oldDataRoots = [path.join(directory, 'synthetic', '.data')]
  const config = {
    logs: path.join(directory, 'logs'),
    protectedRoots: [source],
    oldDataRoots,
    nativeProbe,
    expectedJSON: jsonFile,
  }
  writeFileSync(guardConfig, JSON.stringify(config), { mode: 0o600 })
  const protectedSnapshot = preserveSources()
  const epoch = verifyExisting
    ? verificationEpoch({
        directory,
        report: previous,
        parentSHA: hash({ filename: path.join(directory, 'proof/report.json') }),
      })
    : null
  const reportFile = epoch?.reportFile || path.join(directory, 'proof/report.json')
  const report = {
    ...previous,
    directory,
    mirror,
    sourceFiles: files.length,
    expectedSourceBytes: sourceBytes,
    freeBytes: Number(space.bavail) * Number(space.bsize),
    port,
    rounds: verifyExisting ? [] : previous?.rounds || [],
    commands: verifyExisting ? [] : previous?.commands || [],
    cleanup: verifyExisting ? [] : previous?.cleanup || [],
    ...epoch,
    status: 'pending',
    preparationResume: Boolean(resume),
  }
  const fixture = {
    directory,
    mirror,
    payloadRoot,
    app,
    dataDir,
    jsonFile,
    filesFrom,
    files,
    port,
    config,
    guardConfig,
    provenanceRoot: expectedProvenanceRoot({ mirror }),
    report,
    reportFile,
    protectedSnapshot,
    current: null,
    resumed: Boolean(resume),
    needsSourceCopy: files.some((filename) => !existsSync(path.join(mirror, filename))),
    readyTarget,
  }
  if (verifyExisting)
    writeFileSync(reportFile, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
  const manifestHistory = path.join(
    directory,
    'proof',
    `source-manifest-${report.commands.length}.json`,
  )
  if (!verifyExisting && !existsSync(manifestHistory))
    writeFileSync(
      manifestHistory,
      JSON.stringify(
        Object.fromEntries(
          files.map((filename) => [filename, hash({ filename: path.join(source, filename) })]),
        ),
      ),
      { flag: 'wx', mode: 0o600 },
    )
  writeReport({ fixture: fixture })
  return fixture
}

export function networkPolicy({ stage }) {
  const install = ['sdk-install', 'payload-install', 'root-tooling-install'].includes(stage)
  return `(deny network*)
    (allow network-bind (local ip "localhost:*"))
    (allow network-inbound (local ip "localhost:*"))
    ${install ? '(allow network-outbound (remote ip "*:443") (remote ip "*:53") (remote unix-socket (path "/private/var/run/mDNSResponder")))' : ''}`
}

export function expectedProvenanceRoot({ mirror }) {
  return path.resolve(mirror)
}

export function pendingPreparationStages({ commands, sdkVerified, payloadVerified = false }) {
  if (
    payloadVerified &&
    commands.filter((entry) => entry.name === 'payload-install').at(-1)?.exit === 0
  )
    return []
  if (
    sdkVerified &&
    ['sdk-install', 'sdk-build'].every(
      (name) => commands.filter((entry) => entry.name === name).at(-1)?.exit === 0,
    )
  )
    return ['payload-install']
  return ['sdk-install', 'sdk-build', 'payload-install']
}

export function assertNodeTypesTarget({ mirror, canonical, version, expectedVersion }) {
  assert.equal(version, expectedVersion, 'Node tooling version differs from the root lock.')
  assert(
    within({ filename: canonical, root: mirror }),
    'Node tooling must target the owned dependency tree.',
  )
}

export function parseLockedResolution({ resolution }) {
  resolution = resolution.replace(/^'|'$/g, '')
  if (resolution.startsWith('@typescript/typescript6@'))
    resolution = resolution.slice('@typescript/typescript6@'.length)
  const version = resolution.split('(')[0]
  const peers = []
  let depth = 0
  let start = -1
  for (let index = version.length; index < resolution.length; index++) {
    if (resolution[index] === '(') {
      if (depth++ === 0) start = index + 1
    } else if (resolution[index] === ')') {
      assert(depth > 0, 'Invalid locked peer graph.')
      if (--depth === 0) {
        const entry = resolution.slice(start, index)
        const separator = entry.indexOf('@', entry.startsWith('@') ? 1 : 0)
        assert(separator > 0, 'Invalid locked peer package.')
        peers.push({ name: entry.slice(0, separator), resolution: entry.slice(separator + 1) })
      }
    } else assert(depth > 0, 'Unexpected locked resolution suffix.')
  }
  assert.equal(depth, 0, 'Unbalanced locked peer graph.')
  return { version, peers }
}

function verifyLockedPeers({
  fixture,
  canonical,
  resolution,
  requireAllDirect = false,
  ownershipRoot = fixture.mirror,
}) {
  const expected = parseLockedResolution({ resolution })
  const metadata = JSON.parse(readFileSync(path.join(canonical, 'package.json'), 'utf8'))
  assertNodeTypesTarget({
    mirror: ownershipRoot,
    canonical,
    version: metadata.version,
    expectedVersion: expected.version,
  })
  const container = canonical.slice(
    0,
    canonical.lastIndexOf('/node_modules/') + '/node_modules'.length,
  )
  if (requireAllDirect) {
    for (const name of Object.keys(metadata.peerDependencies || {})) {
      if (!metadata.peerDependenciesMeta?.[name]?.optional)
        assert(
          expected.peers.some((peer) => peer.name === name),
          'Required direct peer missing from locked resolution.',
        )
    }
  }
  const peers = expected.peers.map(({ name, resolution }) => {
    const candidate = path.join(container, name)
    const optional = metadata.peerDependenciesMeta?.[name]?.optional === true
    const direct = Boolean(metadata.peerDependencies?.[name])
    const present = existsSync(candidate)
    if (!direct)
      return {
        name,
        resolution,
        direct: false,
        presentAtPeerContainer: present,
        classification: 'locked transitive context, not a declared direct peer',
      }
    if (!present) {
      assert(optional, 'Required direct peer is missing from the installed dependency tree.')
      return { name, resolution, direct: true, optional: true, present: false }
    }
    const peer = realpathSync(candidate)
    return {
      name,
      canonical: peer,
      resolution,
      direct: true,
      optional,
      present: true,
      graph: verifyLockedPeers({ fixture, canonical: peer, resolution }),
    }
  })
  return {
    version: metadata.version,
    peers,
    scope: 'locked resolution context plus materialized declared direct peers',
  }
}

function installOwnedRootDependencies({ fixture, minimistTypes }) {
  const manifest = JSON.parse(readFileSync(path.join(fixture.payloadRoot, 'package.json'), 'utf8'))
  const lock = readFileSync(path.join(fixture.payloadRoot, 'pnpm-lock.yaml'), 'utf8')
  const rootSection = lock.split('  apps/heymoro:')[0]
  const appSection = lock.split('  apps/heymoro:\n')[1].split(/\n  \S/)[0]
  const readResolution = ({ section, name }) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = section.match(
      new RegExp(
        `^      (?:'${escaped}'|${escaped}):\\n        specifier: ([^\\n]+)\\n        version: ([^\\n]+)$`,
        'm',
      ),
    )
    assert(match, 'Missing declared root dependency lock entry.')
    return { specifier: match[1], resolution: match[2] }
  }
  const entries = []
  for (const name of [
    '@types/node',
    'react',
    'react-dom',
    'next',
    '@types/react',
    '@types/react-dom',
    'drizzle-kit',
    'typescript',
    'minimist',
    '@types/minimist',
  ]) {
    const root = readResolution({ section: rootSection, name })
    const rootOnly = ['drizzle-kit', 'typescript', 'minimist', '@types/minimist'].includes(name)
    const app = rootOnly ? null : readResolution({ section: appSection, name })
    if (app)
      assert.equal(
        root.resolution,
        app.resolution,
        'Root/application complete peer resolutions differ.',
      )
    const declaration = manifest.devDependencies[name] || manifest.dependencies?.[name]
    assert(
      declaration === 'catalog:' || declaration === root.specifier,
      'Root dependency declaration differs.',
    )
    const fixedTargets = {
      'drizzle-kit': 'drizzle-kit@0.31.7_supports-color@10.2.2/node_modules/drizzle-kit',
      typescript: '@typescript+typescript6@6.0.2/node_modules/@typescript/typescript6',
      minimist: 'minimist@1.2.8/node_modules/minimist',
    }
    const canonical =
      name === '@types/minimist'
        ? minimistTypes
        : rootOnly
          ? realpathSync(path.join(fixture.payloadRoot, 'node_modules/.pnpm', fixedTargets[name]))
          : realpathSync(path.join(fixture.app, 'node_modules', name))
    const graph = verifyLockedPeers({
      fixture,
      canonical,
      resolution: root.resolution,
      requireAllDirect: true,
      ownershipRoot:
        name === '@types/minimist' ? path.join(fixture.directory, 'root-tooling') : fixture.mirror,
    })
    const destination = path.join(fixture.payloadRoot, 'node_modules', name)
    let existing
    try {
      existing = lstatSync(destination)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (existing) {
      assert(existing.isSymbolicLink(), 'Unknown root dependency object; no overwrite.')
      assert.equal(
        realpathSync(destination),
        canonical,
        'Existing root dependency link differs; no overwrite.',
      )
    } else {
      mkdirSync(path.dirname(destination), { recursive: true })
      assert.equal(
        realpathSync(path.dirname(destination)),
        path.dirname(destination),
        'Root dependency parent must be canonical and owned.',
      )
      symlinkSync(path.relative(path.dirname(destination), canonical), destination, 'dir')
    }
    entries.push({
      name,
      rootResolution: root.resolution,
      appResolution: app?.resolution || null,
      canonical,
      destination,
      graph,
    })
    fixture.report.rootTooling = [...entries]
    writeReport({ fixture })
  }
  fixture.report.rootTooling = entries
  writeReport({ fixture })
}

function attestPayloadInstall({ fixture }) {
  assert.equal(
    hash({ filename: path.join(fixture.payloadRoot, 'pnpm-lock.yaml') }),
    hash({ filename: path.join(source, 'payload/pnpm-lock.yaml') }),
  )
  const manifest = JSON.parse(readFileSync(path.join(fixture.app, 'package.json'), 'utf8'))
  const dependencies = {}
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const canonical = realpathSync(path.join(fixture.app, 'node_modules', name))
    assert(
      within({ filename: canonical, root: fixture.mirror }),
      'Installed dependency escaped the owned mirror.',
    )
    const metadata = JSON.parse(readFileSync(path.join(canonical, 'package.json'), 'utf8'))
    dependencies[name] = { canonical, version: metadata.version }
  }
  assert.equal(dependencies.next.version, '16.4.2')
  if (fixture.report.payloadAttestation)
    assert.deepEqual(
      dependencies,
      fixture.report.payloadAttestation,
      'Owned installed dependency metadata changed.',
    )
  fixture.report.payloadAttestation = dependencies
  writeReport({ fixture })
  return true
}

function attestSDK({ fixture }) {
  const inputs = Object.fromEntries(
    fixture.files
      .filter((filename) => filename.startsWith('ai-engine/'))
      .map((filename) => [filename, hash({ filename: path.join(fixture.mirror, filename) })]),
  )
  const outputRoot = path.join(fixture.mirror, 'ai-engine/dist')
  const outputs = {}
  const visit = ({ directory }) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'SDK artifact must not be a symlink.')
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) visit({ directory: filename })
      else outputs[path.relative(outputRoot, filename)] = hash({ filename })
    }
  }
  visit({ directory: outputRoot })
  assert(outputs['index.js'] && outputs['index.d.ts'], 'SDK build artifacts missing.')
  const current = {
    inputs,
    outputs,
    compiler: hash({
      filename: path.join(fixture.mirror, 'ai-engine/node_modules/typescript/package.json'),
    }),
  }
  if (fixture.report.sdkAttestation)
    assert.deepEqual(
      current,
      fixture.report.sdkAttestation,
      'SDK inputs or artifacts changed after successful build.',
    )
  fixture.report.sdkAttestation = current
  writeReport({ fixture })
  return true
}

export function measureFootprint({ directory }) {
  const result = spawnSync('/usr/bin/du', ['-sk', directory], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(result.status, 0, 'Actual disk usage measurement failed.')
  const kibibytes = Number(result.stdout.match(/^(\d+)\s/)?.[1])
  assert(Number.isFinite(kibibytes), 'Invalid du result.')
  return {
    logicalBytes: treeBytes({ directory: directory }),
    diskAllocatedBytes: kibibytes * 1024,
    diskMeasurement: 'du -sk (1024-byte units)',
  }
}

export function sourceBytes({ mirror, files }) {
  return files.reduce((bytes, filename) => {
    assert(
      !path.isAbsolute(filename) &&
        !filename.split('/').some((part) => part === '..' || sensitive({ name: part })),
      'Source manifest path is outside its allowlist boundary.',
    )
    const actual = path.join(mirror, filename)
    assert.equal(
      realpathSync(actual),
      actual,
      'Source manifest file must not resolve through links.',
    )
    return bytes + statSync(actual).size
  }, 0)
}

export function deriveToolingDescriptor({ originalLock, originalManifest }) {
  assert.equal(
    originalManifest.devDependencies?.['@types/minimist'],
    '1.2.5',
    'Original type package declaration changed.',
  )
  assert(/^lockfileVersion: '9[.]0'\n/.test(originalLock), 'Unexpected original lock format.')
  const settings = { autoInstallPeers: true, excludeLinksFromLockfile: false }
  const settingsText = originalLock.match(/^settings:\n((?: {2}[^\n]+\n)+)/m)?.[1]
  assert.equal(
    settingsText,
    '  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n',
    'Original settings differ.',
  )
  const importer = originalLock
    .split('  apps/heymoro:')[0]
    .match(/'@types\/minimist':\n\s+specifier: ([^\n]+)\n\s+version: ([^\n]+)/)
  assert.equal(importer?.[1], '1.2.5', 'Original importer version differs.')
  assert.equal(importer?.[2], '1.2.5', 'Original importer resolution differs.')
  const packages = originalLock.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0]
  const entry = packages?.match(/^  '@types\/minimist@1[.]2[.]5':\n((?: {4}[^\n]+\n)*)/m)?.[1]
  const integrity = entry?.match(
    /^    resolution: \{integrity: (sha512-[A-Za-z0-9+/]{86}==)\}\n$/,
  )?.[1]
  assert(integrity, 'Original complete package entry or SHA512 integrity differs.')
  const snapshots = originalLock.split('\nsnapshots:\n')[1]
  assert(
    /^  '@types\/minimist@1[.]2[.]5': \{\}\n?$/m.test(snapshots || ''),
    'Original type package snapshot is not dependency-free.',
  )
  const manifest = {
    name: 'heymoro-e0-root-tooling',
    private: true,
    version: '0.0.0',
    devDependencies: { '@types/minimist': '1.2.5' },
  }
  const lockText = `lockfileVersion: '9.0'\n\nsettings:\n${settingsText}\nimporters:\n\n  .:\n    devDependencies:\n      '@types/minimist':\n        specifier: 1.2.5\n        version: 1.2.5\n\npackages:\n\n  '@types/minimist@1.2.5':\n${entry}\nsnapshots:\n\n  '@types/minimist@1.2.5': {}\n`
  return { manifest, lockText, lockfileVersion: '9.0', settings, integrity, snapshot: {} }
}

async function materializeDeclaredType({ fixture }) {
  const originalLock = readFileSync(path.join(source, 'payload/pnpm-lock.yaml'), 'utf8')
  const originalManifest = JSON.parse(
    readFileSync(path.join(source, 'payload/package.json'), 'utf8'),
  )
  const descriptor = deriveToolingDescriptor({ originalLock, originalManifest })
  assertToolingDescriptor({ descriptor, originalLock, originalManifest })
  const directory = path.join(fixture.directory, 'root-tooling')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  assert.equal(
    realpathSync(directory),
    directory,
    'Root tooling runtime must be owned and canonical.',
  )
  const manifestFile = path.join(directory, 'package.json')
  const lockFile = path.join(directory, 'pnpm-lock.yaml')
  for (const [filename, contents] of [
    [manifestFile, JSON.stringify(descriptor.manifest, null, 2)],
    [lockFile, descriptor.lockText],
  ]) {
    if (existsSync(filename))
      assert.equal(
        readFileSync(filename, 'utf8'),
        contents,
        'Existing derived descriptor differs; no overwrite.',
      )
    else writeFileSync(filename, contents, { flag: 'wx', mode: 0o600 })
  }
  const before = {
    manifest: hash({ filename: manifestFile }),
    lock: hash({ filename: lockFile }),
    originalManifest: hash({ filename: path.join(source, 'payload/package.json') }),
    originalLock: hash({ filename: path.join(source, 'payload/pnpm-lock.yaml') }),
  }
  const completed =
    fixture.report.commands.filter((entry) => entry.name === 'root-tooling-install').at(-1)
      ?.exit === 0
  if (!completed)
    await command({
      fixture,
      options: {
        name: 'root-tooling-install',
        executable: node,
        args: [
          pnpm,
          '--ignore-workspace',
          'install',
          '--frozen-lockfile',
          '--ignore-scripts',
          '--package-import-method=copy',
          `--store-dir=${path.join(fixture.directory, 'pnpm-store')}`,
          '--registry=https://registry.npmjs.org/',
          '--fetch-retries=0',
          '--fetch-timeout=20000',
          '--network-concurrency=4',
          '--child-concurrency=1',
          '--reporter=append-only',
        ],
        cwd: directory,
        timeout: 60_000,
      },
    })
  assert.equal(hash({ filename: manifestFile }), before.manifest)
  assert.equal(hash({ filename: lockFile }), before.lock)
  assert.equal(
    hash({ filename: path.join(source, 'payload/package.json') }),
    before.originalManifest,
  )
  assert.equal(hash({ filename: path.join(source, 'payload/pnpm-lock.yaml') }), before.originalLock)
  const canonical = realpathSync(path.join(directory, 'node_modules/@types/minimist'))
  assertNodeTypesTarget({
    mirror: directory,
    canonical,
    version: JSON.parse(readFileSync(path.join(canonical, 'package.json'), 'utf8')).version,
    expectedVersion: '1.2.5',
  })
  const metadata = JSON.parse(readFileSync(path.join(canonical, 'package.json'), 'utf8'))
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'])
    assert.deepEqual(
      metadata[field] || {},
      {},
      'Installed type package gained a dependency closure.',
    )
  assert.equal(metadata.name, '@types/minimist')
  fixture.report.derivedTooling = {
    directory,
    descriptor,
    hashes: before,
    canonical,
    declarationSHA: hash({ filename: path.join(canonical, 'index.d.ts') }),
    provenance: 'Derived single-package acceptance lock; not a byte copy of the production lock.',
  }
  writeReport({ fixture })
  return canonical
}

export function assertToolingDescriptor({ descriptor, originalLock, originalManifest }) {
  assert.deepEqual(
    descriptor,
    deriveToolingDescriptor({ originalLock, originalManifest }),
    'Derived tooling descriptor differs from its original locked input.',
  )
}

export function refreshReportFootprints({ directory }) {
  directory = realpathSync(directory)
  const filename = path.join(directory, 'proof/report.json')
  const report = JSON.parse(readFileSync(filename, 'utf8'))
  assert.equal(report.directory, directory, 'Only the owned report may be refreshed.')
  assert.equal(report.mirror, path.join(directory, 'source'))
  const files = readFileSync(path.join(directory, 'proof/source-files.txt'), 'utf8')
    .trim()
    .split('\n')
  report.actualSourceBytes = sourceBytes({ mirror: report.mirror, files })
  report.mirrorFootprint = measureFootprint({ directory: report.mirror })
  report.runtimeFootprint = measureFootprint({ directory })
  delete report.sourceFootprint
  writeFileSync(filename, JSON.stringify(report, null, 2), { mode: 0o600 })
  return {
    actualSourceBytes: report.actualSourceBytes,
    mirrorFootprint: report.mirrorFootprint,
    runtimeFootprint: report.runtimeFootprint,
    status: report.status,
  }
}

function profile({ fixture, readonlyStore = false, stage }) {
  if (fixture.e2) return e2KernelProfile({ ...fixture.e2.kernelPolicy, role: stage })
  const quoted = (value) => JSON.stringify(value)
  const roots = [
    ...fixture.config.protectedRoots,
    ...(readonlyStore ? [store, path.join(fixture.directory, 'pnpm-store')] : []),
  ]
  const sourceRegex = `^${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(.*/)?[.]data(/|$)`
  return `(version 1) (allow default)
    ${networkPolicy({ stage })}
    (deny file-read-data (regex #"/[.][eE][nN][vV][^/]*$"))
    (deny file-read-data (regex #${quoted(sourceRegex)}))
    (deny file-read-data (subpath ${quoted(fixture.config.oldDataRoots[0])}))
    ${roots.map((root) => `(deny file-write* (subpath ${quoted(root)}))`).join('\n')}
  `
}

function environment({ fixture }) {
  return {
    PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin`,
    HOME: path.join(fixture.directory, 'home'),
    TMPDIR: fixture.directory,
    LANG: 'en_US.UTF-8',
    NODE_ENV: 'development',
    CI: '1',
    COREPACK_ENABLE_NETWORK: '0',
    NEXT_TELEMETRY_DISABLED: '1',
    NEXT_DISABLE_MEM_OVERRIDE: '1',
    HEYMORO_CORE_CONFIG_FILE: fixture.jsonFile,
    ...(fixture.e2 ? { HEYMORO_E2_CONTROL_FILE: fixture.e2.controlFile } : {}),
    E0_GUARD_CONFIG: fixture.guardConfig,
    NODE_OPTIONS: `--max-old-space-size=3072 --require=${guard}`,
    npm_config_userconfig: '/dev/null',
    npm_config_globalconfig: '/dev/null',
  }
}

export async function isolationProof({ fixture }) {
  const test = `
    const {spawnSync}=require('node:child_process');const fs=require('node:fs');
    const write=${JSON.stringify(path.join(fixture.directory, 'synthetic', 'source.txt'))};
    let blocked=false;try{fs.writeFileSync(write,'bad')}catch(e){blocked=['EPERM','EACCES','E0_DENIED'].includes(e.code)};
    if(!blocked)throw Error('Synthetic OS write guard absent');
    const native=spawnSync('/bin/sh',['-c','printf bad > "$1"','owned',write],{encoding:'utf8',timeout:3000});
    if(native.status===0)throw Error('Synthetic native OS write guard absent');
    const socket=require('node:net').createConnection({host:'192.0.2.1',port:443});
    socket.setTimeout(2000);
    socket.on('error',(error)=>{if(!['EPERM','EACCES'].includes(error.code))throw Error('OS public-network denial was not proven');console.log(JSON.stringify({publicNetworkDenied:true,code:error.code}))});
    socket.on('connect',()=>{socket.destroy();throw Error('Non-install stage opened outbound networking')});
    socket.on('timeout',()=>{socket.destroy();throw Error('OS public-network denial timed out')});
  `
  const synthetic = path.join(fixture.directory, 'synthetic')
  const original = [...fixture.config.protectedRoots]
  fixture.config.protectedRoots.push(synthetic)
  writeFileSync(fixture.guardConfig, JSON.stringify(fixture.config), { mode: 0o600 })
  await command({
    fixture: fixture,
    options: {
      name: 'os-negative',
      executable: node,
      args: ['-e', test],
      cwd: fixture.directory,
      timeout: 15_000,
    },
  })
  assert.equal(readFileSync(path.join(synthetic, 'source.txt'), 'utf8'), 'owned-synthetic')
  fixture.config.protectedRoots = original
  writeFileSync(fixture.guardConfig, JSON.stringify(fixture.config), { mode: 0o600 })
  fixture.report.isolation = { nativeProbe: true, originalSyntheticRetained: true }
  writeReport({ fixture: fixture })
}

export async function prepareMirror({ fixture, install: shouldInstall = true }) {
  if (fixture.needsSourceCopy) {
    const args = [
      '-a',
      ...(fixture.resumed ? ['--ignore-existing'] : []),
      `--exclude-from=${excludes}`,
      `--files-from=${fixture.filesFrom}`,
      '--stats',
      `${source}/`,
      `${fixture.mirror}/`,
    ]
    await command({
      fixture: fixture,
      options: {
        name: 'rsync-dry-run',
        executable: '/usr/bin/rsync',
        args: ['--dry-run', ...args],
        cwd: fixture.directory,
        timeout: 30_000,
        isNode: false,
      },
    })
    await command({
      fixture: fixture,
      options: {
        name: 'rsync-copy',
        executable: '/usr/bin/rsync',
        args,
        cwd: fixture.directory,
        timeout: 30_000,
        isNode: false,
      },
    })
  }
  for (const filename of fixture.files) {
    assert.equal(
      hash({ filename: path.join(fixture.mirror, filename) }),
      hash({ filename: path.join(source, filename) }),
      'Source transfer changed bytes.',
    )
  }
  if (!fixture.resumed) assert(!existsSync(path.join(fixture.app, 'node_modules')))
  fixture.report.actualSourceBytes = sourceBytes({ mirror: fixture.mirror, files: fixture.files })
  fixture.report.mirrorFootprint = measureFootprint({ directory: fixture.mirror })
  delete fixture.report.sourceFootprint
  writeReport({ fixture: fixture })
  if (!shouldInstall) return
  const install = [
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--package-import-method=copy',
    `--store-dir=${path.join(fixture.directory, 'pnpm-store')}`,
    '--registry=https://registry.npmjs.org/',
    '--fetch-retries=0',
    '--fetch-timeout=20000',
    '--network-concurrency=4',
    '--child-concurrency=1',
    '--reporter=append-only',
  ]
  const completedSDK = ['sdk-install', 'sdk-build'].every(
    (name) => fixture.report.commands.filter((entry) => entry.name === name).at(-1)?.exit === 0,
  )
  const completedPayload =
    fixture.report.commands.filter((entry) => entry.name === 'payload-install').at(-1)?.exit === 0
  const pending = pendingPreparationStages({
    commands: fixture.report.commands,
    sdkVerified: completedSDK && attestSDK({ fixture }),
    payloadVerified: completedPayload && attestPayloadInstall({ fixture }),
  })
  if (pending.includes('sdk-install')) {
    await command({
      fixture: fixture,
      options: {
        name: 'sdk-install',
        executable: node,
        args: [pnpm, ...install],
        cwd: path.join(fixture.mirror, 'ai-engine'),
        timeout: 180_000,
      },
    })
    await command({
      fixture: fixture,
      options: {
        name: 'sdk-build',
        executable: node,
        args: [path.join(fixture.mirror, 'ai-engine', 'node_modules', 'typescript', 'bin', 'tsc')],
        cwd: path.join(fixture.mirror, 'ai-engine'),
        timeout: 60_000,
        readonlyStore: true,
      },
    })
    attestSDK({ fixture })
  }
  if (pending.includes('payload-install')) {
    await command({
      fixture: fixture,
      options: {
        name: 'payload-install',
        executable: node,
        args: [
          pnpm,
          '--filter',
          '@heymoro/server...',
          '--config.exclude-workspace-root-project=true',
          ...install,
        ],
        cwd: fixture.payloadRoot,
        timeout: 360_000,
      },
    })
    attestPayloadInstall({ fixture })
  }
  assert.equal(
    hash({ filename: path.join(fixture.payloadRoot, 'pnpm-lock.yaml') }),
    hash({ filename: path.join(source, 'payload/pnpm-lock.yaml') }),
  )
  assert.equal(
    hash({ filename: path.join(fixture.mirror, 'ai-engine/pnpm-lock.yaml') }),
    hash({ filename: path.join(source, 'ai-engine/pnpm-lock.yaml') }),
  )
  const minimistTypes = await materializeDeclaredType({ fixture })
  installOwnedRootDependencies({ fixture, minimistTypes })
  await command({
    fixture: fixture,
    options: {
      name: 'framework-types',
      executable: node,
      args: [
        path.join(fixture.app, 'node_modules/typescript/bin/tsc'),
        '-b',
        ...['db-sqlite', 'richtext-lexical', 'transformer-sharp', 'next'].map((name) =>
          path.join(fixture.payloadRoot, 'packages', name),
        ),
        '--stopBuildOnErrors',
      ],
      cwd: fixture.app,
      timeout: 120_000,
      readonlyStore: true,
    },
  })
  fixture.report.runtimeBytes = treeBytes({ directory: fixture.mirror })
  fixture.report.runtimeFootprint = measureFootprint({ directory: fixture.directory })
  fixture.report.actualSourceBytes = sourceBytes({ mirror: fixture.mirror, files: fixture.files })
  fixture.report.mirrorFootprint = measureFootprint({ directory: fixture.mirror })
  delete fixture.report.sourceFootprint
  writeReport({ fixture: fixture })
  await command({
    fixture: fixture,
    options: {
      name: 'core-init',
      executable: node,
      args: [
        '--import',
        path.join(fixture.app, 'node_modules/tsx/dist/loader.mjs'),
        path.join(fixture.app, 'scripts/init-target.mjs'),
        '--config',
        fixture.jsonFile,
      ],
      cwd: fixture.app,
      timeout: 60_000,
      readonlyStore: true,
    },
  })
  const manifest = JSON.parse(readFileSync(path.join(fixture.dataDir, 'profile.json'), 'utf8'))
  assert.equal(manifest.state, 'ready')
  assert.match(manifest.fingerprint, /^[a-f0-9]{64}$/)
  fixture.report.targetReady = true
  writeReport({ fixture: fixture })
}

export async function healthRound({ fixture, round }) {
  configureNextCompilerPolicy({ fixture })
  await assertPortClosed({ port: fixture.port })
  const processInfo = start({
    fixture,
    name: `next-${round}`,
    executable: node,
    args: [
      path.join(fixture.app, 'node_modules/next/dist/bin/next'),
      'dev',
      fixture.app,
      '--webpack',
      '-H',
      '127.0.0.1',
      '-p',
      String(fixture.port),
    ],
    cwd: fixture.app,
    readonlyStore: true,
  })
  let response
  try {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      observe({ fixture: fixture, processInfo: processInfo })
      if (processInfo.exited)
        throw new Error(`Next exited before HTTP: ${processInfo.code}/${processInfo.signal}`)
      const owner = portOwners({ port: fixture.port })
      if (owner.length) {
        assert(
          owner.every((pid) => processInfo.pids.has(pid)),
          'Port owned by an unowned process.',
        )
        const cancellation = new AbortController()
        const received = await observingHTTP({
          work: async () => {
            const request = await fetch(`http://127.0.0.1:${fixture.port}/api/v1/health/ready`, {
              signal: AbortSignal.any([AbortSignal.timeout(45_000), cancellation.signal]),
            })
            return { status: request.status, body: await request.json() }
          },
          observer: () => observe({ fixture, processInfo }),
          cancel: () => cancellation.abort(),
        })
        const body = received.body
        assert.equal(
          received.status,
          200,
          'Actual health HTTP failed; no retry on application failure.',
        )
        assert.equal(body.data.database, 'ok')
        assert.equal(body.data.status, 'ready')
        assert.match(
          body.requestId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        )
        response = {
          status: received.status,
          database: body.data.database,
          requestId: body.requestId,
          owners: owner,
        }
        break
      }
      await sleep({ milliseconds: 100 })
    }
    assert(response, 'Next readiness timeout.')
  } catch (error) {
    processInfo.observerError = error.observerError || null
    processInfo.startupFailure = {
      name: error.name,
      code: error.code,
      message: error.message.slice(0, 500),
    }
    throw error
  } finally {
    await stop({ fixture: fixture, processInfo: processInfo })
  }
  validateProcesses({ fixture: fixture, processInfo: processInfo })
  const events = readEvents({ fixture: fixture }).filter(
    (event) => event.commandId === processInfo.commandId && processInfo.pids.has(event.pid),
  )
  const opens = events.filter((event) => event.event === 'private-reader-open' && event.compiled)
  const roots = events.filter((event) => event.event === 'private-reader-root' && event.compiled)
  assert(opens.length > 0, 'No actual compiled private JSON open evidence.')
  assert(
    roots.some((event) => event.root === fixture.provenanceRoot),
    'Compiled projectRoot did not resolve to the source provenance root.',
  )
  assert(opens.every((event) => event.filename === fixture.jsonFile))
  assert(
    !within({ filename: fixture.jsonFile, root: fixture.provenanceRoot }) &&
      !within({ filename: fixture.dataDir, root: fixture.provenanceRoot }),
  )
  fixture.report.rounds.push({
    round,
    ...response,
    processes: [...processInfo.pids],
    compiledRoots: [...new Set(roots.map((event) => event.root))],
    compiledJSON: fixture.jsonFile,
    coldProcess: true,
    coldBuild: false,
    retainedBuildCache: true,
  })
  writeReport({ fixture: fixture })
}

function configureNextCompilerPolicy({ fixture }) {
  const nextRoot = realpathSync(path.join(fixture.app, 'node_modules/next'))
  const compilerRoot = realpathSync(path.join(fixture.app, 'node_modules/typescript'))
  assert.equal(
    JSON.parse(readFileSync(path.join(compilerRoot, 'package.json'), 'utf8')).version,
    '7.0.2',
  )
  assert(
    within({ filename: nextRoot, root: fixture.mirror }) &&
      within({ filename: compilerRoot, root: fixture.mirror }),
  )
  const caller = path.join(nextRoot, 'dist/lib/typescript/runTypeScriptCli.js')
  fixture.config.nextTypeScriptChild = {
    node: realpathSync(node),
    script: realpathSync(path.join(compilerRoot, 'lib/tsc.js')),
    cwd: fixture.app,
    uid: process.getuid(),
    callers: [caller, path.join(nextRoot, 'src/lib/typescript/runTypeScriptCli.ts')],
    callerSHA: hash({ filename: caller }),
    ackDirectory: fixture.e2?.ackDirectory || path.join(fixture.directory, 'proof/compiler-acks'),
  }
  mkdirSync(fixture.config.nextTypeScriptChild.ackDirectory, { recursive: true, mode: 0o700 })
  assert.equal(
    realpathSync(fixture.config.nextTypeScriptChild.ackDirectory),
    fixture.config.nextTypeScriptChild.ackDirectory,
  )
  writeFileSync(fixture.guardConfig, JSON.stringify(fixture.config), { mode: 0o600 })
  fixture.report.nextCompilerPolicy = fixture.config.nextTypeScriptChild
  writeReport({ fixture })
}

function start({ fixture, name, executable, args, cwd, readonlyStore = false, isNode = true }) {
  if (!fixture.e2) assert(!fixture.current, 'Previous owned process group is still active.')
  else selectE2Role({ profileId: 'e2-local', role: name })
  const commandId = randomUUID()
  const child = spawn(
    '/usr/bin/sandbox-exec',
    ['-p', profile({ fixture, readonlyStore, stage: name }), executable, ...args],
    {
      cwd,
      env: {
        ...environment({ fixture: fixture }),
        E0_COMMAND_ID: commandId,
        ...(fixture.e2 ? { HEYMORO_E2_ROLE: name } : {}),
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const processInfo = {
    child,
    pgid: child.pid,
    pids: new Set([child.pid]),
    nodePids: new Set(isNode ? [child.pid] : []),
    name,
    exited: false,
    output: '',
    code: null,
    signal: null,
    executables: {},
    signalErrors: [],
    attemptId: randomUUID(),
    closed: false,
    compilers: {},
    commandId,
    groups: new Set([child.pid]),
    uid: process.getuid(),
    identities: {},
  }
  if (fixture.e2) {
    processInfo.pid = child.pid
    processInfo.ownedPorts = name.startsWith('next-') ? [fixture.port] : []
    fixture.e2.leases.add({ lease: processInfo })
  } else fixture.current = processInfo
  const output = (bytes) => {
    processInfo.output = (processInfo.output + bytes.toString()).slice(-65_536)
  }
  child.stdout.on('data', output)
  child.stderr.on('data', output)
  child.on('error', (error) => {
    processInfo.error = error.code
  })
  child.on('close', (code, signal) => {
    processInfo.closed = true
    processInfo.code = code
    processInfo.signal = signal
  })
  child.on('exit', (code, signal) => {
    processInfo.exited = true
    processInfo.code = code
    processInfo.signal = signal
  })
  return processInfo
}

async function command({ fixture, options }) {
  const processInfo = start({ fixture, ...options })
  const deadline = Date.now() + options.timeout
  let nextDiskCheck = Date.now()
  try {
    while (!processInfo.exited && Date.now() < deadline) {
      if (fixture.e2) await observeE2Leases({ fixture })
      else observe({ fixture: fixture, processInfo: processInfo })
      if (
        Date.now() >= nextDiskCheck &&
        ['sdk-install', 'payload-install', 'root-tooling-install'].includes(options.name)
      ) {
        const footprint = measureFootprint({ directory: fixture.directory })
        assert(
          footprint.diskAllocatedBytes < 6 * 1024 ** 3,
          'Owned dependency download budget exceeded.',
        )
        const space = statfsSync(fixture.directory)
        assert(
          Number(space.bavail) * Number(space.bsize) > 4 * 1024 ** 3,
          'Host free-space reserve exhausted.',
        )
        nextDiskCheck = Date.now() + 5000
      }
      await sleep({ milliseconds: 100 })
    }
    assert(processInfo.exited, `${options.name} exceeded its time budget.`)
    assert.equal(
      processInfo.code,
      0,
      `${options.name} exited ${processInfo.code}; see bounded external evidence.`,
    )
  } finally {
    await stop({ fixture: fixture, processInfo: processInfo })
  }
  validateProcesses({ fixture: fixture, processInfo: processInfo })
  return processInfo
}

function attestCompilerChildren({ fixture, processInfo, events, processes }) {
  const policy = fixture.config.nextTypeScriptChild
  const pending = new Set()
  for (const event of events) {
    if (event.event !== 'child' || !event.detached || !processInfo.pids.has(event.pid)) continue
    assert(
      policy &&
        event.scope === 'next-typescript-cli' &&
        event.nodeCanonical === policy.node &&
        event.scriptCanonical === policy.script &&
        policy.callers.includes(event.caller) &&
        event.uid === processInfo.uid &&
        /^[a-f0-9-]{36}$/i.test(event.ticket),
      'Detached compiler request identity changed.',
    )
    const row = processes.find((entry) => entry.pid === event.child)
    let proof = processInfo.compilers[event.child]
    if (!proof && row) {
      assert(
        row.pgid === event.child &&
          row.ppid === event.pid &&
          row.uid === processInfo.uid &&
          row.birth,
        'Outer kernel compiler identity is unproven.',
      )
      const text = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(row.pid), '-d', 'txt', '-Fn'], {
        encoding: 'utf8',
        timeout: 3000,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      })
      assert.equal(text.status, 0, 'Compiler executable kernel inspection failed.')
      assert(
        text.stdout.split('\n').includes(`n${policy.node}`),
        'Actual compiler Node executable is outside the fixed canonical target.',
      )
      proof = {
        kernel: { pid: row.pid, ppid: row.ppid, pgid: row.pgid, uid: row.uid, birth: row.birth },
        ticket: event.ticket,
        nodeCanonical: policy.node,
        scriptCanonical: event.scriptCanonical,
        caller: event.caller,
        acknowledged: false,
      }
      processInfo.compilers[event.child] = proof
    }
    if (!proof) {
      pending.add(event.child)
      continue
    }
    if (row)
      assertProcessIdentity({
        recorded: { uid: proof.kernel.uid, birth: proof.kernel.birth },
        current: { uid: row.uid, birth: row.birth },
      })
    assert.equal(proof.ticket, event.ticket, 'Compiler ticket changed.')
    const handshake = events.find(
      (entry) =>
        entry.event === 'handshake' &&
        entry.pid === event.child &&
        entry.compilerTicket === event.ticket,
    )
    const native = events.find(
      (entry) =>
        entry.event === 'native-probe' &&
        entry.pid === event.child &&
        entry.normal &&
        entry.env &&
        entry.oldData,
    )
    if (!proof.acknowledged && handshake && native) {
      assert(
        handshake.ppid === event.pid &&
          handshake.uid === proof.kernel.uid &&
          handshake.entryScriptCanonical === policy.script &&
          handshake.nodeCanonical === policy.node,
        'Compiler preload ticket or canonical entry changed.',
      )
      const ack = {
        ...proof.kernel,
        ticket: event.ticket,
        commandId: processInfo.commandId,
        nodeCanonical: policy.node,
        scriptCanonical: policy.script,
      }
      const filename = path.join(
        policy.ackDirectory,
        `compiler-${processInfo.commandId}-${event.ticket}-${event.child}.json`,
      )
      const temporary = path.join(policy.ackDirectory, `.ack-${randomUUID()}.json`)
      writeFileSync(temporary, JSON.stringify(ack), { flag: 'wx', mode: 0o600 })
      linkSync(temporary, filename)
      proof.acknowledged = true
      proof.ackFile = filename
    }
  }
  return {
    events: events
      .filter((event) => !event.detached || processInfo.compilers[event.child])
      .map((event) =>
        event.detached ? { ...event, kernel: processInfo.compilers[event.child].kernel } : event,
      ),
    pending,
  }
}

function observe({ fixture, processInfo }) {
  const processes = processTable()
  const rawEvents = readEvents({ fixture }).filter(
    (event) => event.commandId === processInfo.commandId,
  )
  const closure = processClosure({
    pids: processInfo.pids,
    nodePids: processInfo.nodePids,
    events: rawEvents,
    processes,
  })
  processInfo.pids = closure.pids
  processInfo.nodePids = closure.nodePids
  const attested = attestCompilerChildren({ fixture, processInfo, events: rawEvents, processes })
  const events = attested.events
  processInfo.pendingCompilers = attested.pending
  processInfo.groups = collectOwnedGroups({
    initialPGID: processInfo.pgid,
    uid: processInfo.uid,
    knownPIDs: processInfo.pids,
    events,
    policy: fixture.config.nextTypeScriptChild,
  })
  for (const event of events) {
    if (!event.detached || !event.kernel || !processInfo.pids.has(event.child)) continue
    const expected = { uid: event.kernel.uid, birth: event.kernel.birth }
    const previous = processInfo.identities[event.child]
    if (previous) assertProcessIdentity({ recorded: previous, current: expected })
    processInfo.identities[event.child] = expected
  }
  for (const entry of processes) {
    if (!processInfo.pids.has(entry.pid) && !processInfo.groups.has(entry.pgid)) continue
    if (processInfo.pendingCompilers.has(entry.pid)) continue
    assert(
      processInfo.groups.has(entry.pgid),
      'Owned child escaped its explicitly recorded groups.',
    )
    assert.equal(entry.uid, processInfo.uid, 'Owned process UID changed.')
    if (!processInfo.pids.has(entry.pid))
      assert(processInfo.pids.has(entry.ppid), 'Unknown process entered an owned group.')
    const current = { uid: entry.uid, birth: entry.birth }
    if (processInfo.identities[entry.pid])
      assertProcessIdentity({ recorded: processInfo.identities[entry.pid], current })
    else processInfo.identities[entry.pid] = current
    processInfo.pids.add(entry.pid)
    processInfo.executables[entry.pid] = {
      basename: path.basename(entry.command).slice(0, 80),
      ppid: entry.ppid,
      pgid: entry.pgid,
      uid: entry.uid,
      birth: entry.birth,
      state: entry.state,
      classifiedNode: isNodeProcess({ command: entry.command }),
    }
    if (isNodeProcess({ command: entry.command })) processInfo.nodePids.add(entry.pid)
  }
}

export function persistAttempt({ fixture, processInfo, cleanupError = null }) {
  const table = processTable()
  const snapshot = {
    groups: [...processInfo.groups],
    identities: processInfo.identities,
    compilers: processInfo.compilers,
    pendingCompilers: [...(processInfo.pendingCompilers || [])],
    groupMembers: table
      .filter((entry) => processInfo.groups.has(entry.pgid))
      .map((entry) => ({
        pid: entry.pid,
        ppid: entry.ppid,
        pgid: entry.pgid,
        uid: entry.uid,
        birth: entry.birth,
        state: entry.state,
        basename: path.basename(entry.command).slice(0, 80),
      })),
    alivePIDs: table.filter((entry) => processInfo.pids.has(entry.pid)).map((entry) => entry.pid),
    port: fixture.port,
    portOwners: fixture.e2
      ? processInfo.ownedPorts.flatMap((port) => portOwners({ port }))
      : portOwners({ port: fixture.port }),
    cleanupError,
  }
  const evidence = {
    attemptId: processInfo.attemptId,
    ...attemptEvidence({ processInfo, snapshot }),
  }
  const filename = path.join(
    fixture.e2 ? fixture.e2.epochRoot : path.join(fixture.directory, 'proof'),
    `attempt-${processInfo.name}-${processInfo.pgid}-${processInfo.attemptId}.json`,
  )
  if (processInfo.attemptFile) {
    assert.equal(
      JSON.parse(readFileSync(filename, 'utf8')).attemptId,
      processInfo.attemptId,
      'Attempt evidence ownership changed.',
    )
    writeFileSync(filename, JSON.stringify(evidence, null, 2), { mode: 0o600 })
  } else {
    writeFileSync(filename, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 })
    processInfo.attemptFile = filename
  }
  return snapshot
}

async function drainExitedChildren({ fixture, processInfo }) {
  const deadline = Date.now() + 1000
  await sleep({ milliseconds: 25 })
  while (Date.now() < deadline) {
    observe({ fixture, processInfo })
    const snapshot = persistAttempt({ fixture, processInfo })
    if (!snapshot.groupMembers.some((entry) => entry.state.startsWith('Z'))) break
    await sleep({ milliseconds: 25 })
  }
}

async function stop({ fixture, processInfo }) {
  try {
    try {
      observe({ fixture, processInfo })
    } finally {
      persistAttempt({ fixture, processInfo })
    }
    assert(
      Number.isSafeInteger(processInfo.pgid) && processInfo.pgid > 1,
      'Owned PGID must be an explicit positive process group.',
    )
    await drainExitedChildren({ fixture, processInfo })
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      observe({ fixture, processInfo })
      for (const pgid of processInfo.groups) {
        assert(Number.isSafeInteger(pgid) && pgid > 1, 'Explicit child PGID is invalid.')
        observe({ fixture, processInfo })
        const snapshot = persistAttempt({ fixture, processInfo })
        const members = snapshot.groupMembers.filter((entry) => entry.pgid === pgid)
        if (!maySignalGroup({ members })) continue
        assert(
          members.every((entry) => processInfo.pids.has(entry.pid)),
          'Unowned group member.',
        )
        for (const entry of members)
          assertProcessIdentity({
            recorded: processInfo.identities[entry.pid],
            current: { uid: entry.uid, birth: entry.birth },
          })
        try {
          process.kill(-pgid, signal)
        } catch (error) {
          processInfo.signalErrors.push({ code: error.code, signal, pgid })
          const fresh = persistAttempt({ fixture, processInfo, cleanupError: error.code })
          if (error.code === 'EPERM') {
            assertSignalRaceExited({
              error,
              groupMembers: fresh.groupMembers,
              alivePIDs: fresh.alivePIDs,
              portOwners: fresh.portOwners,
            })
            processInfo.signalRaceExited = true
            break
          }
          if (error.code !== 'ESRCH') throw error
        }
      }
      const deadline = Date.now() + (signal === 'SIGTERM' ? 5000 : 2000)
      while (Date.now() < deadline) {
        observe({ fixture, processInfo })
        const snapshot = persistAttempt({ fixture, processInfo })
        if (!snapshot.groupMembers.length && !snapshot.alivePIDs.length) break
        await sleep({ milliseconds: 50 })
      }
    }
    const final = persistAttempt({ fixture, processInfo })
    assert(
      !final.groupMembers.length && !final.alivePIDs.length,
      'Recorded owned PID or group remains.',
    )
    for (const port of fixture.e2 ? processInfo.ownedPorts : [fixture.port])
      await assertPortClosed({ port })
    const drainDeadline = Date.now() + 1000
    while (!processInfo.closed && Date.now() < drainDeadline) await sleep({ milliseconds: 25 })
    persistAttempt({ fixture, processInfo })
    if (fixture.e2) fixture.e2.leases.closed({ lease: processInfo })
    else fixture.current = null
    fixture.report.commands.push({
      ...attemptEvidence({
        processInfo,
        snapshot: {
          groups: [...processInfo.groups],
          identities: processInfo.identities,
          commandId: processInfo.commandId,
        },
      }),
      attemptFile: processInfo.attemptFile,
      signalRaceExited: Boolean(processInfo.signalRaceExited),
    })
    fixture.report.cleanup.push({
      command: processInfo.name,
      groups: [...processInfo.groups],
      groupExited: true,
      portClosed: true,
      signalErrors: processInfo.signalErrors,
    })
    writeReport({ fixture })
  } catch (error) {
    processInfo.cleanupFailed = true
    processInfo.cleanupFailure = error
    persistAttempt({ fixture, processInfo, cleanupError: error.code || error.name })
    throw error
  }
}

function validateProcesses({ fixture, processInfo }) {
  const events = readEvents({ fixture: fixture }).filter(
    (event) => event.commandId === processInfo.commandId,
  )
  const closure = processClosure({ pids: processInfo.pids, nodePids: processInfo.nodePids, events })
  processInfo.pids = closure.pids
  processInfo.nodePids = closure.nodePids
  assertNodeEvidence({ nodePids: processInfo.nodePids, events })
  for (const [pid, proof] of Object.entries(processInfo.compilers))
    assert(
      proof.acknowledged &&
        events.some(
          (event) =>
            event.event === 'compiler-ack' &&
            event.pid === Number(pid) &&
            event.ticket === proof.ticket &&
            event.kernel.birth === proof.kernel.birth &&
            event.kernel.pgid === Number(pid),
        ),
      'Compiler child did not confirm its exact outer kernel acknowledgement.',
    )
  const refusals = events.filter(
    (event) => processInfo.pids.has(event.pid) && event.event === 'denied',
  )
  assert.equal(
    refusals.length,
    processInfo.name === 'os-negative' ? 1 : 0,
    'Unexpected protected access attempt.',
  )
}

function readEvents({ fixture }) {
  return readdirSync(fixture.config.logs)
    .filter((filename) => /^\d+\.jsonl$/.test(filename))
    .flatMap((filename) => {
      const contents = readFileSync(path.join(fixture.config.logs, filename), 'utf8')
      assert(contents.length <= 262_144, 'Evidence file exceeds budget.')
      return contents
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    })
}

function processTable() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,uid=,stat=,lstart=,comm='], {
    encoding: 'utf8',
    timeout: 3000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  })
  assert.equal(result.status, 0)
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.match(
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/,
      )
      assert(match, 'Kernel process identity format is unsupported.')
      const [, pid, ppid, pgid, uid, state, birth, command] = match
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        uid: Number(uid),
        state,
        birth,
        command,
      }
    })
}

function portOwners({ port }) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
    timeout: 3000,
  })
  assert([0, 1].includes(result.status), 'Port ownership inspection failed.')
  return [...new Set(result.stdout.trim().split('\n').filter(Boolean).map(Number))]
}
async function unusedPort() {
  const socket = net.createServer()
  await new Promise((resolve, reject) =>
    socket.once('error', reject).listen(0, '127.0.0.1', resolve),
  )
  const { port } = socket.address()
  await new Promise((resolve) => socket.close(resolve))
  assert.notEqual(port, 3001)
  return port
}
async function assertPortClosed({ port }) {
  assert.equal(
    portOwners({ port: port }).length,
    0,
    'Owned port remains open or was taken by another process.',
  )
}
function preserveSources() {
  const baseline = controlledSourceBaseline()
  const result = {}
  for (const [repo, state] of Object.entries(baseline)) {
    result[repo] = {
      head: git({ repo: repo, args: ['rev-parse', 'HEAD'] }),
      diff: git({ repo: repo, args: ['diff', '--binary'] }),
      cached: git({ repo: repo, args: ['diff', '--cached', '--binary'] }),
      files: {},
    }
    assert.equal(result[repo].head.trim(), state.head)
    for (const [filename, expected] of Object.entries(state.files)) {
      assert(!filename.split('/').some((part) => /^\.(env|data)/i.test(part)))
      const digest = hash({ filename: path.join(source, repo, filename) })
      if (!['apps/heymoro/README.md', 'apps/heymoro/docs/verification.md'].includes(filename))
        assert.equal(digest, expected, `Pre-existing source mismatch: ${repo}/${filename}`)
      result[repo].files[filename] = digest
    }
  }
  return result
}
function git({ repo, args }) {
  const result = spawnSync('/usr/bin/git', ['-C', path.join(source, repo), ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 8 * 1024 ** 2,
  })
  assert.equal(result.status, 0)
  return result.stdout
}
export async function finalizeFixture({ fixture, error }) {
  let cleanupFailure
  if (fixture.current) {
    if (fixture.current.cleanupFailed) cleanupFailure = fixture.current.cleanupFailure
    else {
      try {
        await stop({ fixture, processInfo: fixture.current })
      } catch (failure) {
        cleanupFailure = failure
      }
    }
  }
  error ||= cleanupFailure
  fixture.report.cleanupUnconfirmed = Boolean(cleanupFailure)
  if (fixture.report.verificationId)
    assert.equal(
      hash({ filename: fixture.report.parentPassedReportPath }),
      fixture.report.parentPassedReportSHA,
      'Original passed evidence changed during verification.',
    )
  for (const [repo, state] of Object.entries(fixture.protectedSnapshot)) {
    assert.equal(git({ repo: repo, args: ['rev-parse', 'HEAD'] }), state.head)
    assert.equal(git({ repo: repo, args: ['diff', '--binary'] }), state.diff)
    assert.equal(git({ repo: repo, args: ['diff', '--cached', '--binary'] }), state.cached)
    for (const [filename, digest] of Object.entries(state.files)) {
      if (['apps/heymoro/README.md', 'apps/heymoro/docs/verification.md'].includes(filename))
        continue
      assert.equal(
        hash({ filename: path.join(source, repo, filename) }),
        digest,
        `Source changed: ${repo}/${filename}`,
      )
    }
  }
  fixture.report.status = error
    ? 'failed'
    : fixture.report.rounds.length === 2
      ? 'passed'
      : 'prepared-only'
  fixture.report.error = error
    ? { name: error.name, code: error.code, message: error.message.slice(0, 500) }
    : null
  fixture.report.sourceProtection = {
    payloadBaseline: 231,
    payloadUnchanged: 228,
    authorizedSourceRevision: revisedSource,
    sourceAuthorizationSHA: hash({ filename: sourceAuthorization }),
    taro: 84,
    sdk: 15,
    trackedDiffAndHEADRetained: true,
  }
  fixture.report.retainedSourceCopy = true
  fixture.report.runtimeBytes = treeBytes({ directory: fixture.mirror })
  fixture.report.runtimeFootprint = measureFootprint({ directory: fixture.directory })
  fixture.report.actualSourceBytes = sourceBytes({ mirror: fixture.mirror, files: fixture.files })
  fixture.report.mirrorFootprint = measureFootprint({ directory: fixture.mirror })
  delete fixture.report.sourceFootprint
  writeReport({ fixture: fixture })
  if (cleanupFailure) throw cleanupFailure
}
function writeReport({ fixture }) {
  if (fixture.e2) {
    const previous = JSON.parse(readFileSync(fixture.reportFile, 'utf8'))
    assert.equal(previous.verificationId, fixture.report.verificationId)
    assert.equal(previous.authoritySHA, fixture.report.authoritySHA)
  }
  writeFileSync(fixture.reportFile, JSON.stringify(fixture.report, null, 2), { mode: 0o600 })
}
function treeBytes({ directory }) {
  let bytes = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    bytes += entry.isDirectory() ? treeBytes({ directory: filename }) : statSync(filename).size
  }
  return bytes
}

function readyOwnership({ fixture }) {
  assert.equal(realpathSync(fixture.dataDir), fixture.dataDir, 'Ready dataDir must be canonical.')
  for (const filename of [
    fixture.dataDir,
    path.join(fixture.dataDir, 'profile.json'),
    path.join(fixture.dataDir, 'core.sqlite'),
  ])
    assert(!lstatSync(filename).isSymbolicLink(), 'Ready target paths must not be symlinks.')
  const initialization = fixture.report.initializationEvidence
    ? [fixture.report.initializationEvidence]
    : fixture.report.commands.filter((entry) => entry.name === 'core-init')
  assert.equal(initialization.length, 1, 'Ready target must have one recorded initialization.')
  assert.equal(initialization[0].exit, 0, 'Ready target initialization did not exit successfully.')
  assert(
    initialization[0].output.includes('Core target is ready.'),
    'Ready target initialization output is missing.',
  )
  const profile = JSON.parse(readFileSync(path.join(fixture.dataDir, 'profile.json'), 'utf8'))
  assert.equal(profile.state, 'ready')
  assert.equal(profile.profile, 'heymoro-core')
  assert.match(profile.fingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(
    JSON.parse(readFileSync(fixture.jsonFile, 'utf8')),
    hostConfiguration({ dataDir: fixture.dataDir, port: fixture.port }),
  )
  const current = {
    directory: fixture.directory,
    dataDir: fixture.dataDir,
    jsonFile: fixture.jsonFile,
    coreInitPID: initialization[0].pid,
    configurationSHA: hash({ filename: fixture.jsonFile }),
    profileSHA: hash({ filename: path.join(fixture.dataDir, 'profile.json') }),
    sourceManifestSHA: hash({ filename: fixture.filesFrom }),
    productionManifestSHA: hash({ filename: path.join(source, 'payload/package.json') }),
    productionLockSHA: hash({ filename: path.join(source, 'payload/pnpm-lock.yaml') }),
  }
  const filename = path.join(fixture.directory, 'proof/ready-owner.json')
  if (existsSync(filename))
    assert.deepEqual(
      JSON.parse(readFileSync(filename, 'utf8')),
      current,
      'Ready target ownership record changed.',
    )
  else writeFileSync(filename, JSON.stringify(current, null, 2), { flag: 'wx', mode: 0o600 })
  return current
}

export async function reattestReadyTarget({ fixture }) {
  assert(fixture.readyTarget, 'Ready attestation requires the explicit recovery entry point.')
  const before = readyOwnership({ fixture })
  await command({
    fixture,
    options: {
      name: 'ready-attest',
      executable: node,
      args: [
        '--import',
        path.join(fixture.app, 'node_modules/tsx/dist/loader.mjs'),
        fileURLToPath(import.meta.url),
        '--ready-attest',
        fixture.directory,
      ],
      cwd: fixture.app,
      timeout: 60_000,
      readonlyStore: true,
    },
  })
  assert.deepEqual(readyOwnership({ fixture }), before)
  fixture.report.readyReattestation = {
    passed: true,
    initializationRepeated: false,
    owner: before,
    compiledHTTPProof: false,
  }
  writeReport({ fixture })
}

async function readyAttestationWorker({ directory }) {
  assert.equal(realpathSync(directory), directory)
  const app = path.join(directory, 'source/payload/apps/heymoro')
  const configuration = await import(pathToFileURL(path.join(app, 'src/payload.config.ts')).href)
  const { getPayload } = await import(
    pathToFileURL(path.join(directory, 'source/payload/packages/payload/src/index.ts')).href
  )
  const { getCoreRuntime } = await import(
    pathToFileURL(path.join(app, 'src/creation/runtime/services.ts')).href
  )
  const { getCreationSQLiteAdapter } = await import(
    pathToFileURL(path.join(app, 'src/creation/infrastructure/payload/sqlite-unit-of-work.ts')).href
  )
  let payload
  try {
    payload = await getPayload({ config: configuration.default })
    await payload.find({ collection: 'admins', depth: 0, limit: 1, overrideAccess: true })
    console.log('Owned ready target attested without initialization.')
  } finally {
    if (payload) {
      try {
        await getCoreRuntime({ payload }).close()
      } finally {
        const client = getCreationSQLiteAdapter({ payload }).client
        try {
          await payload.destroy()
        } finally {
          client.close()
        }
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--ready-attest')
  await readyAttestationWorker({ directory: process.argv[3] })

/** E2 uses the same guarded spawn/observe/stop kernel with a separate multi-lease registry. */
export function attachE2Lifecycle({ fixture }) {
  assert.equal(fixture.e2.profileId, 'e2-local')
  assert(!fixture.current)
  assert(!fixture.e2.leases)
  fixture.e2.leases = createE2LeaseRegistry()
  configureNextCompilerPolicy({ fixture })
}

export async function observeE2Leases({ fixture }) {
  await fixture.e2.leases.observeAll({
    observe: ({ lease }) => {
      observe({ fixture, processInfo: lease })
      if (lease.error) throw new Error(`E2 child spawn failed: ${lease.error}`)
      if (lease.name.startsWith('next-') && lease.exited)
        throw new Error('E2 Next lease exited during active work.')
    },
  })
}

export function startE2Next({ fixture, round }) {
  assert.equal(fixture.e2.control.mode, 'business', 'Business mode required for Next.')
  assert([1, 2].includes(round))
  assertE2RunAuthority({ fixture })
  return start({
    fixture,
    name: `next-${round}`,
    executable: node,
    args: [
      path.join(fixture.app, 'node_modules/next/dist/bin/next'),
      'dev',
      fixture.app,
      '--webpack',
      '-H',
      '127.0.0.1',
      '-p',
      String(fixture.port),
    ],
    cwd: fixture.app,
    readonlyStore: true,
  })
}

/** The initialization role has one private command and no caller-supplied executable or argv. */
export async function initializeE2Target({ fixture }) {
  assert.equal(fixture.e2.control.mode, 'initialize')
  assert.notEqual(fixture.e2.initialized, true, 'Initialization already completed.')
  assertE2RunAuthority({ fixture })
  const processInfo = await command({
    fixture,
    options: {
      ...e2InitializationCommand({ app: fixture.app, jsonFile: fixture.jsonFile }),
      executable: node,
    },
  })
  fixture.e2.initialized = true
  return { commandId: processInfo.commandId, pids: [...processInfo.pids] }
}

export async function runE2Worker({ fixture, role }) {
  selectE2Role({ profileId: 'e2-local', role })
  assert(['seed', 'attest', 'snapshot', 'jobs-1', 'jobs-2'].includes(role))
  if (fixture.e2.control.mode === 'initialize') {
    assert.equal(role, 'attest')
    assert.equal(fixture.e2.initialized, true)
  }
  assertE2RunAuthority({ fixture })
  const processInfo = await command({
    fixture,
    options: {
      name: role,
      executable: node,
      args: ['--import', 'tsx', path.join(fixture.app, 'tests/creation/next-business-worker.ts')],
      cwd: fixture.app,
      timeout: 60_000,
      readonlyStore: true,
    },
  })
  return { commandId: processInfo.commandId, pids: [...processInfo.pids] }
}

export async function stopE2Next({ fixture, processInfo, round }) {
  assert.equal(processInfo.name, `next-${round}`)
  await stop({ fixture, processInfo })
  validateProcesses({ fixture, processInfo })
  const events = readEvents({ fixture }).filter(
    (event) => event.commandId === processInfo.commandId,
  )
  const opens = events.filter((event) => event.event === 'private-reader-open' && event.compiled)
  const roots = events.filter((event) => event.event === 'private-reader-root' && event.compiled)
  assert(opens.length > 0 && opens.every((event) => event.filename === fixture.jsonFile))
  assert(roots.some((event) => event.root === fixture.provenanceRoot))
  fixture.report.rounds.push({
    round,
    coldProcess: true,
    coldBuild: false,
    coldServices: false,
    compiledJSON: fixture.jsonFile,
    compiledRoots: [...new Set(roots.map((event) => event.root))],
    commandId: processInfo.commandId,
    pids: [...processInfo.pids],
  })
  writeReport({ fixture })
}

export async function finalizeE2Leases({ fixture }) {
  await fixture.e2.leases.cleanupAll({ stop: ({ lease }) => stop({ fixture, processInfo: lease }) })
}
