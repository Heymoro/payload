import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const E2_DIRECTORY =
  '/private/var/folders/gn/wbk8wfbd047_wvwkwtyn331r0000gn/T/heymoro-E0-next-5RQ7OV'
export const E2_PARENT_SHA = '1bab20bfb5808fd95ed738994b6bd7868a93a1379e5c21d2d913f1c2d2d8a972'
export const E2_OLD_TARGETS = Object.freeze([
  `${E2_DIRECTORY}/new-target`,
  `${E2_DIRECTORY}/e2-product-target`,
])

/** A run identifier selects only new canonical direct leaves, never an existing DB version. */
export function e2RevisionBinding({ revisionId }) {
  assert.match(revisionId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  return Object.freeze({
    directory: E2_DIRECTORY,
    mirror: `${E2_DIRECTORY}/source`,
    writeRoot: E2_DIRECTORY,
    revisionId,
    targetDir: `${E2_DIRECTORY}/e2-target-${revisionId}`,
    readyFile: `${E2_DIRECTORY}/proof/E2-ready-${revisionId}.json`,
    datasetOwnerFile: `${E2_DIRECTORY}/proof/E2-dataset-${revisionId}.json`,
  })
}

export function assertE2Binding({ binding }) {
  const expected = e2RevisionBinding({ revisionId: binding.revisionId })
  for (const [key, value] of Object.entries(expected))
    assert.equal(binding[key], value, `Run binding changed: ${key}`)
  return expected
}

const roles = Object.freeze([
  'next-1',
  'next-2',
  'seed',
  'attest',
  'snapshot',
  'jobs-1',
  'jobs-2',
  'core-init',
])
export const E2_ASSERTIONS = Object.freeze([
  'readyShape',
  'datasetOwnership',
  'freshRestLogin',
  'formalTrial',
  'catalogFreePreset',
  'sessionCreatedAndReplayed',
  'traceDTO',
  'freeTextRequiredNoNotes',
  'effectMultipartOwnership',
  'orderedDraftNotes',
  'quoteZeroBusinessWrites',
  'quoteZeroEngine',
  'concurrentSingleTask',
  'nativeCreationJobs',
  'nativeNamingJobs',
  'succeededHistoryLibraryMediaFavoriteCredits',
  'coldRecovery',
  'expiredQuoteValidSession',
  'sameKeyReplayStable',
  'changedInputConflict',
  'regenerationSourceSnapshot',
  'foreignNotFound',
  'logoutIdempotent',
])

export function selectE2Role(input) {
  assert.deepEqual(Object.keys(input).sort(), ['profileId', 'role'])
  assert.equal(input.profileId, 'e2-local')
  assert(roles.includes(input.role), 'Unknown E2 role.')
  return Object.freeze({
    profileId: 'e2-local',
    role: input.role,
    round: input.role.endsWith('2') ? 2 : 1,
  })
}

export function assertCanonicalPath({ filename }) {
  assert(
    path.isAbsolute(filename) && path.normalize(filename) === filename,
    'Canonical absolute path required.',
  )
  let current = path.parse(filename).root
  for (const part of filename.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    assert(!lstatSync(current).isSymbolicLink(), 'Symbolic path component is forbidden.')
  }
  assert.equal(realpathSync(filename), filename)
  return filename
}

export function assertE2Directory({ directory }) {
  assert.equal(directory, E2_DIRECTORY, 'Only the fixed owned E0 directory is registered.')
  return assertCanonicalPath({ filename: directory })
}

export function assertRelativeSource({ filename }) {
  assert(typeof filename === 'string' && filename.length > 0)
  assert(!path.isAbsolute(filename) && path.normalize(filename) === filename)
  assert(!/[\x00-\x1f\x7f]/.test(filename) && !filename.startsWith('-'), 'Unsafe files-from name.')
  assert(
    !filename
      .split('/')
      .some((part) => ['..', '.', 'node_modules'].includes(part) || /^\.(env|data)/i.test(part)),
  )
}

export function assertE2Delta({ before, after, changes }) {
  const expected = { ...before }
  const seen = new Set()
  for (const change of changes) {
    assert.deepEqual(Object.keys(change).sort(), ['afterSHA', 'beforeSHA', 'filename'])
    assertRelativeSource(change)
    assert(!seen.has(change.filename), 'Duplicate revision entry.')
    seen.add(change.filename)
    assert.match(change.afterSHA, /^[a-f0-9]{64}$/)
    assert.equal(before[change.filename] ?? null, change.beforeSHA)
    assert.notEqual(change.beforeSHA, change.afterSHA)
    expected[change.filename] = change.afterSHA
  }
  assert.deepEqual(after, expected, 'Source delta differs from the explicit approved bytes.')
}

export function assertE2Facts({ expected, actual }) {
  assert.equal(expected.parentPassedReportSHA, E2_PARENT_SHA)
  for (const key of [
    'revisionSHA',
    'ownerSHA',
    'initializationSHA',
    'lockSHA',
    'manifestSHA',
    'sourceManifestSHA',
    'overlayManifestSHA',
    'jsonSHA',
    'controlSHA',
    'guardSHA',
    'targetFingerprint',
  ])
    assert.match(expected[key], /^[a-f0-9]{64}$/)
  assert(expected.repositories && Object.keys(expected.repositories).length > 0)
  assert.deepEqual(actual, expected, 'Immutable E2 facts or Git state changed.')
}

export function assertE2Ports({ ports }) {
  assert.deepEqual(Object.keys(ports).sort(), ['next', 'redis', 's3'])
  for (const port of Object.values(ports))
    assert(Number.isInteger(port) && port > 1024 && port < 65536)
  assert.equal(new Set(Object.values(ports)).size, 3)
}

export const E2_POLICY_MAX_BYTES = 32 * 1024
const runtimeSource = `${E2_DIRECTORY}/source`
const readonlyTrees = Object.freeze([
  `${E2_DIRECTORY}/proof`,
  `${runtimeSource}/ai-engine`,
  `${runtimeSource}/payload/packages`,
  `${runtimeSource}/payload/apps/heymoro/src`,
  `${runtimeSource}/payload/apps/heymoro/tests`,
  `${runtimeSource}/payload/apps/heymoro/scripts`,
  `${runtimeSource}/payload/tools`,
])
const readonlyLeaves = Object.freeze(
  [
    'payload/AGENTS.md',
    'payload/package.json',
    'payload/pnpm-lock.yaml',
    'payload/pnpm-workspace.yaml',
    'payload/tsconfig.json',
    'payload/tsconfig.base.json',
    'payload/apps/heymoro/AGENTS.md',
    'payload/apps/heymoro/next.config.mjs',
    'payload/apps/heymoro/package.json',
    'payload/apps/heymoro/tsconfig.json',
  ].map((filename) => `${runtimeSource}/${filename}`),
)
const under = ({ filename, root }) => filename === root || filename.startsWith(`${root}/`)

/** A fixed readonly superset, never a source-membership or authority grant. */
export function e2WriteProtection({ immutablePaths }) {
  assert(Array.isArray(immutablePaths))
  const subpaths = new Set()
  const literals = new Set()
  for (const filename of immutablePaths) {
    assert(
      typeof filename === 'string' &&
        path.isAbsolute(filename) &&
        path.normalize(filename) === filename,
    )
    const tree = readonlyTrees.find((root) => under({ filename, root }))
    if (tree) subpaths.add(tree)
    else {
      if (under({ filename, root: runtimeSource }))
        assert(readonlyLeaves.includes(filename), 'Unregistered runtime source path.')
      literals.add(filename)
    }
  }
  const coverage = { subpaths: [...subpaths], literals: [...literals] }
  assert(
    immutablePaths.every(
      (filename) =>
        literals.has(filename) || coverage.subpaths.some((root) => under({ filename, root })),
    ),
    'Readonly path coverage is incomplete.',
  )
  return Object.freeze({
    subpaths: Object.freeze(coverage.subpaths),
    literals: Object.freeze(coverage.literals),
  })
}

export function e2KernelProfile({
  role,
  ports,
  protectedRoots,
  immutablePaths,
  oldDataRoots,
  writeRoot,
}) {
  assert(
    typeof writeRoot === 'string' && writeRoot !== '/',
    'Explicit non-root writeRoot required.',
  )
  assertCanonicalPath({ filename: writeRoot })
  assert(lstatSync(writeRoot).isDirectory())
  selectE2Role({ profileId: 'e2-local', role })
  assertE2Ports({ ports })
  for (const filename of [...protectedRoots, ...immutablePaths, ...oldDataRoots])
    assert(path.isAbsolute(filename) && path.normalize(filename) === filename)
  const quoted = (value) => JSON.stringify(value)
  const protection = e2WriteProtection({ immutablePaths })
  const policy = `(version 1) (allow default)
    (deny file-write*)
    (allow file-write* (subpath ${quoted(writeRoot)}))
    (allow file-write* (literal \"/dev/null\"))
    (deny network*)
    ${role.startsWith('next-') ? `(allow network-bind (local ip "localhost:${ports.next}"))\n    (allow network-inbound (local ip "localhost:${ports.next}"))` : ''}
    (allow network-outbound (remote ip "localhost:${ports.redis}"))
    (allow network-outbound (remote ip "localhost:${ports.s3}"))
    (deny file-read-data (regex #"/[.][eE][nN][vV][^/]*$"))
    ${protectedRoots.map((root) => `(deny file-read-data (regex #${quoted(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(.*/)?[.]data(/|$)`)}))`).join('\n')}
    ${oldDataRoots.map((root) => `(deny file-read-data (subpath ${quoted(root)}))`).join('\n')}
    ${protectedRoots.map((root) => `(deny file-write* (subpath ${quoted(root)}))`).join('\n')}
    ${protection.subpaths.map((root) => `(deny file-write* (subpath ${quoted(root)}))`).join('\n')}
    ${protection.literals.map((filename) => `(deny file-write* (literal ${quoted(filename)}))`).join('\n')}
  `
  assert(Buffer.byteLength(policy) <= E2_POLICY_MAX_BYTES, 'E2 kernel policy text budget exceeded.')
  return policy
}

/** Identity remains object-bound: one worker cannot release another lease. */
export function createE2LeaseRegistry() {
  const leases = new Map()
  return Object.freeze({
    add: ({ lease }) => {
      assert(typeof lease.commandId === 'string' && lease.commandId)
      for (const key of ['pid', 'pgid', 'uid'])
        assert(Number.isSafeInteger(lease[key]) && lease[key] > (key === 'uid' ? -1 : 1))
      assert(Array.isArray(lease.ownedPorts))
      assert(!leases.has(lease.commandId), 'Duplicate lease command.')
      for (const active of leases.values()) {
        assert.notEqual(active.pgid, lease.pgid)
        assert(!active.ownedPorts.some((port) => lease.ownedPorts.includes(port)))
      }
      leases.set(lease.commandId, lease)
    },
    active: () => [...leases.values()],
    closed: ({ lease }) => {
      assert.equal(leases.get(lease.commandId), lease, 'Lease identity mismatch.')
      leases.delete(lease.commandId)
    },
    observeAll: async ({ observe }) => {
      const errors = []
      for (const lease of leases.values()) {
        try {
          await observe({ lease })
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, 'E2 active lease observation failed.')
    },
    cleanupAll: async ({ stop }) => {
      const errors = []
      for (const lease of [...leases.values()]) {
        try {
          await stop({ lease })
          if (leases.has(lease.commandId)) leases.delete(lease.commandId)
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, 'E2 lease cleanup remains unconfirmed.')
    },
  })
}

export function assertE2LeaseEvidence({ evidence }) {
  for (const key of ['uid', 'pid', 'pgid']) assert(Number.isSafeInteger(evidence[key]))
  assert(evidence.commandId)
  assert(evidence.nodePids.length > 0)
  for (const pid of evidence.nodePids) {
    assert(evidence.handshakes.includes(pid), 'Missing guard handshake.')
    assert(evidence.nativeControls.includes(pid), 'Missing native positive/negative controls.')
  }
  for (const pid of evidence.compilerPids)
    assert(evidence.compilerACKs.includes(pid), 'Missing compiler ACK.')
  for (const key of ['alivePids', 'groupMembers', 'portOwners'])
    assert.deepEqual(evidence[key], [], 'Exit residue remains.')
}

export function e2ModeAction({ mode }) {
  assert(['initialize', 'business'].includes(mode), 'Unknown E2 execution mode.')
  return mode === 'initialize' ? 'initialize-fresh-e2' : 'run-e2-epoch'
}

export function assertMissingE2Leaf({ filename }) {
  assert(path.isAbsolute(filename) && path.normalize(filename) === filename)
  assertCanonicalPath({ filename: path.dirname(filename) })
  let stat
  try {
    stat = lstatSync(filename)
  } catch (error) {
    assert.equal(error.code, 'ENOENT')
  }
  assert(!stat, 'Fresh target leaf must not exist, including symbolic links.')
  return filename
}

export function e2InitializationCommand({ app, jsonFile }) {
  assert.equal(app, `${E2_DIRECTORY}/source/payload/apps/heymoro`)
  assert.equal(path.basename(jsonFile), 'core-e2.json')
  assert.equal(path.dirname(path.dirname(jsonFile)), E2_DIRECTORY)
  assert.match(path.basename(path.dirname(jsonFile)), /^E2-[a-f0-9-]{36}$/)
  assert.equal(path.normalize(jsonFile), jsonFile)
  return {
    name: 'core-init',
    args: ['--import', 'tsx', `${app}/scripts/init-target.mjs`, '--config', jsonFile],
    cwd: app,
    timeout: 60_000,
    readonlyStore: true,
  }
}

export function assertE2ReadyReceipt({ binding, profile, receipt, receiptSHA }) {
  assertE2Binding({ binding })
  assert.match(receiptSHA, /^[a-f0-9]{64}$/)
  assert.equal(receiptSHA, binding.readySHA)
  const epoch = `${E2_DIRECTORY}/E2-${receipt.verificationId}`
  for (const [field, name] of [
    ['jsonFile', 'core-e2.json'],
    ['controlFile', 'control.json'],
    ['initializationFile', 'initialization.json'],
    ['reportFile', 'report.json'],
  ])
    assert.equal(receipt[field], `${epoch}/${name}`)
  for (const key of ['initializationSHA', 'reportSHA']) assert.match(receipt[key], /^[a-f0-9]{64}$/)
  assert.equal(receipt.format, 2)
  assert.equal(receipt.approvedBy, 'root')
  assert.equal(receipt.action, 'approve-fresh-e2-ready')
  for (const key of [
    'authorityFile',
    'authoritySHA',
    'sourceManifestSHA',
    'revisionId',
    'targetDir',
    'readyFile',
    'profileSHA',
    'profileNonce',
    'targetFingerprint',
  ])
    assert.equal(receipt[key], binding[key], `Ready binding changed: ${key}`)
  assert.equal(profile.format, 1)
  assert.equal(profile.profile, 'heymoro-core')
  assert.equal(profile.state, 'ready')
  assert.equal(profile.nonce, binding.profileNonce)
  assert.equal(profile.fingerprint, binding.targetFingerprint)
  assert.match(profile.nonce, /^[a-f0-9-]{36}$/)
  for (const key of ['authoritySHA', 'jsonSHA', 'controlSHA', 'profileSHA', 'targetFingerprint'])
    assert.match(receipt[key], /^[a-f0-9]{64}$/)
  assert.match(receipt.verificationId, /^[a-f0-9-]{36}$/)
  for (const key of ['initializer', 'attest']) {
    assert.match(receipt[key].commandId, /^[a-f0-9-]{36}$/)
    assert.equal(receipt[key].exit, 0)
  }
  assert.notEqual(receipt.initializer.commandId, receipt.attest.commandId)
  assert.equal(path.dirname(receipt.attest.evidenceFile), `${epoch}/journal`)
  assert.match(path.basename(receipt.attest.evidenceFile), /^attest-[0-9]+[.]jsonl$/)
  assert.match(receipt.attest.evidenceSHA, /^[a-f0-9]{64}$/)
}

export function assertE2ReadyEvidence({ receipt, initialization, report, hashes, attestation }) {
  for (const key of ['jsonSHA', 'controlSHA', 'initializationSHA', 'reportSHA'])
    assert.equal(hashes[key], receipt[key])
  assert.equal(initialization.format, 2)
  for (const key of [
    'authorityFile',
    'sourceManifestSHA',
    'revisionId',
    'authoritySHA',
    'controlSHA',
    'jsonSHA',
    'verificationId',
    'targetDir',
    'targetFingerprint',
    'profileSHA',
    'profileNonce',
  ])
    assert.equal(initialization[key], receipt[key])
  assert.deepEqual(initialization.initializer, receipt.initializer)
  assertE2Initialization({ report })
  for (const key of [
    'authorityFile',
    'sourceManifestSHA',
    'authoritySHA',
    'revisionId',
    'verificationId',
    'initializationFile',
    'initializationSHA',
    'targetDir',
    'profileSHA',
    'profileNonce',
  ])
    assert.equal(report[key], receipt[key])
  assert.equal(report.attestEvidenceFile, receipt.attest.evidenceFile)
  assert.equal(hashes.attestEvidenceSHA, receipt.attest.evidenceSHA)
  assert.equal(attestation.event, 'ready')
  assert.equal(attestation.role, 'attest')
  assert.equal(attestation.verificationId, receipt.verificationId)
  assert.equal(attestation.details.targetFingerprint, receipt.targetFingerprint)
  assert(report.commands[1].nodePids.includes(attestation.pid))
  assert.equal(path.basename(receipt.attest.evidenceFile), `attest-${attestation.pid}.jsonl`)
  for (const key of [
    'nativeEnv',
    'publicOutbound',
    'sealedNative',
    'sealedNode',
    'unregisteredLoopback',
    'workerBind',
  ])
    assert.equal(attestation.details[key], 1)
  assert.equal(report.attestEvidenceSHA, receipt.attest.evidenceSHA)
  for (const [index, key] of ['initializer', 'attest'].entries()) {
    assert.equal(report.commands[index].commandId, receipt[key].commandId)
    assert.equal(report.commands[index].signal, null)
  }
}

export function assertE2DatasetReceipt({ dataset, control }) {
  assert.equal(dataset.format, 2)
  assert.equal(dataset.state, 'complete')
  assertE2Binding({ binding: control })
  assert.equal(dataset.revisionId, control.revisionId)
  assert.equal(dataset.targetDir, control.targetDir)
  assert.equal(dataset.readyFile, control.ready.readyFile)
  assert.equal(dataset.readySHA, control.ready.readySHA)
  assert.equal(dataset.datasetConfigSHA, control.datasetConfigSHA)
  assert.match(dataset.readbackSHA, /^[a-f0-9]{64}$/)
  assert(Number.isSafeInteger(dataset.adminId) && dataset.adminId > 0)
  assert.deepEqual(dataset.templates.map(({ kind }) => kind).sort(), ['effect', 'free'])
  assert.deepEqual(dataset.examples.map(({ recipe }) => recipe).sort(), ['blue', 'red'])
  for (const template of dataset.templates) {
    assert(Number.isSafeInteger(template.templateId) && template.templateId > 0)
    assert.equal(Object.hasOwn(template, 'versionId'), false)
    assert.equal(Object.hasOwn(template, 'reviewHash'), false)
    for (const key of ['configurationHash', 'exampleMediaHash'])
      assert.match(template[key], /^[a-f0-9]{64}$/)
  }
  for (const example of dataset.examples) {
    assert(Number.isSafeInteger(example.id) && example.id > 0)
    assert.match(example.sha256, /^[a-f0-9]{64}$/)
  }
}

export function assertE2Initialization({ report }) {
  assert.equal(report.profileId, 'e2-local')
  assert.equal(report.mode, 'initialize')
  assert.equal(report.status, 'initialized-awaiting-root')
  assert.equal(report.servicesClosed, true)
  assert.equal(report.cleanupUnconfirmed, false)
  assert.deepEqual(report.activeLeases, [])
  assert.deepEqual(report.rounds, [])
  assert.deepEqual(report.httpTraces, [])
  assert.deepEqual(
    report.commands.map(({ name, exit }) => [name, exit]),
    [
      ['core-init', 0],
      ['attest', 0],
    ],
  )
  assert.equal(report.error, null)
  for (const key of ['profileSHA', 'attestEvidenceSHA']) assert.match(report[key], /^[a-f0-9]{64}$/)
  assert.match(report.profileNonce, /^[a-f0-9-]{36}$/)
  assert.equal(report.targetDir, e2RevisionBinding({ revisionId: report.revisionId }).targetDir)
}

export function assertE2Success({ report, jsonFile, sourceRoot }) {
  assertE2Binding({ binding: report })
  for (const key of ['authoritySHA', 'sourceManifestSHA', 'frozenSourceSHA', 'datasetOwnerSHA'])
    assert.match(report[key], /^[a-f0-9]{64}$/)
  assert(Object.keys(report.frozenSource).length > 0)
  for (const [filename, sha] of Object.entries(report.frozenSource)) {
    assertRelativeSource({ filename })
    assert.match(sha, /^[a-f0-9]{64}$/)
  }
  assert.equal(
    createHash('sha256')
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(report.frozenSource).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
        ),
      )
      .digest('hex'),
    report.frozenSourceSHA,
  )
  assert.equal(report.assertions.datasetOwnership.evidence.ownerSHA, report.datasetOwnerSHA)
  assert.equal(report.mode, 'business')
  assert.equal(report.profileId, 'e2-local')
  assert.equal(report.servicesClosed, true)
  assert.deepEqual(report.kernelIsolationProof, {
    sealedNode: true,
    sealedNative: true,
    publicOutbound: true,
    unregisteredLoopback: true,
    workerBind: true,
    nativeEnv: true,
  })
  assert.equal(report.assertionVersion, 1)
  assert.deepEqual(Object.keys(report.assertions).sort(), [...E2_ASSERTIONS].sort())
  for (const proof of Object.values(report.assertions)) {
    assert.equal(proof.passed, true)
    assert(proof.evidence && Object.keys(proof.evidence).length > 0)
  }
  assert.deepEqual(report.activeLeases, [])
  assert.equal(report.cleanupUnconfirmed, false)
  assert.equal(report.rounds.length, 2)
  for (const [index, round] of report.rounds.entries()) {
    assert.equal(round.round, index + 1)
    assert.equal(round.coldProcess, true)
    assert.equal(round.compiledJSON, jsonFile)
    assert(round.compiledRoots.includes(sourceRoot))
  }
}
