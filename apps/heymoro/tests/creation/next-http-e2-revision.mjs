import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { sourceAllowlist } from './next-http-fixture.mjs'
import {
  assertCanonicalPath,
  assertE2Binding,
  assertE2Delta,
  assertE2Directory,
  assertE2Ports,
  assertRelativeSource,
  e2ModeAction,
  assertE2ReadyReceipt,
  assertE2ReadyEvidence,
  assertMissingE2Leaf,
  E2_OLD_TARGETS,
  E2_DIRECTORY,
  e2KernelProfile,
} from './next-http-e2-profile.mjs'

export const E2_SOURCE_ROOT = realpathSync(
  fileURLToPath(new URL('../../../../../', import.meta.url)),
)
const excludes = '/Users/nako/.codex/backup-excludes.txt'
export const E2_OVERLAY_PATHS = Object.freeze([
  'payload/apps/heymoro/next-env.d.ts',
  'payload/apps/heymoro/next.config.mjs',
])

const nextConfig = 'payload/apps/heymoro/next.config.mjs'
const extensionAnchor = '    config.resolve.extensionAlias = {'
const webpackAnchor = '  webpack(config, { isServer, nextRuntime }) {'

/** Current runtime recipe; the former ordinary alias is never emitted for execution. */
export function e2OverlayBytes({ filename, sourceBytes, mirror }) {
  assert(E2_OVERLAY_PATHS.includes(filename))
  const text = overlaySourceText({ sourceBytes })
  if (filename === nextConfig) {
    assertNextConfigAnchors({ text })
    const host = JSON.stringify(
      `${mirror}/payload/apps/heymoro/tests/creation/next-business-host.ts`,
    )
    const plugin = `    if (isServer && nextRuntime === 'nodejs') {\n      config.plugins = [...(config.plugins || []), new webpack.NormalModuleReplacementPlugin(/^@payload-config$/, ${host})]\n    }\n`
    return Buffer.from(
      text
        .replace(webpackAnchor, '  webpack(config, { isServer, nextRuntime, webpack }) {')
        .replace(extensionAnchor, `${plugin}${extensionAnchor}`),
    )
  }
  const prefix = './.next-creation-check/dev/types/'
  assert.equal(text.split(prefix).length, 3, 'Expected exactly two generated declaration imports.')
  return Buffer.from(text.replaceAll(prefix, './.next/dev/types/'))
}

function overlaySourceText({ sourceBytes }) {
  const text = sourceBytes.toString('utf8')
  assert.deepEqual(Buffer.from(text), sourceBytes, 'Overlay source must be valid UTF-8.')
  return text
}
function assertNextConfigAnchors({ text }) {
  assert.equal(
    text.split(extensionAnchor).length,
    2,
    'Expected one existing extensionAlias anchor.',
  )
  assert.equal(
    text.split(webpackAnchor).length,
    2,
    'Expected one existing webpack parameter anchor.',
  )
  assert(!text.includes('config.resolve.alias ='), 'Unexpected preexisting runtime alias.')
  assert(!text.includes('NormalModuleReplacementPlugin'), 'Unexpected preexisting runtime plugin.')
}

/** Readonly recognition of installed old bytes, never a runtime fallback. */
function previousNextConfigBytes({ sourceBytes, mirror }) {
  const text = overlaySourceText({ sourceBytes })
  assertNextConfigAnchors({ text })
  const alias = `    config.resolve.alias = { ...config.resolve.alias, '@payload-config': ${JSON.stringify(`${mirror}/payload/apps/heymoro/tests/creation/next-business-host.ts`)} }\n`
  return Buffer.from(text.replace(extensionAnchor, `${alias}${extensionAnchor}`))
}

export function assertE2OverlayBytes({ filename, overlay, sourceBytes, mirror }) {
  assert.equal(overlay.sourceSHA, shaBytes({ bytes: sourceBytes }))
  const bytes = Buffer.from(overlay.runtimeBase64, 'base64')
  assert.equal(bytes.toString('base64'), overlay.runtimeBase64, 'Noncanonical overlay base64.')
  assert.equal(overlay.runtimeSHA, shaBytes({ bytes }))
  assert.deepEqual(
    bytes,
    e2OverlayBytes({ filename, sourceBytes, mirror }),
    'Unapproved overlay transformation.',
  )
}
/** The before side is only a current-original-derived installed recipe, never an authority fallback. */
export function assertE2OverlayTransition({ authority, filename, sourceBytes }) {
  assertE2OverlayBytes({
    filename,
    overlay: authority.overlays[filename],
    sourceBytes,
    mirror: authority.mirror,
  })
  const beforeSHA = authority.beforeManifest[filename]
  if (filename === nextConfig) {
    const legacySHA = shaBytes({
      bytes: previousNextConfigBytes({ sourceBytes, mirror: authority.mirror }),
    })
    assert(
      [legacySHA, authority.overlays[filename].runtimeSHA].includes(beforeSHA),
      'Unknown installed Next config bytes.',
    )
  } else
    assert.equal(
      beforeSHA,
      authority.overlays[filename].runtimeSHA,
      'Existing declaration bytes are immutable.',
    )
}

export const E2_CONTROLLER_PATHS = Object.freeze([
  'payload/apps/heymoro/tests/next-http-e2.test.mjs',
  ...[
    'next-http-e2-profile.mjs',
    'next-http-e2-revision.mjs',
    'next-http-e2-spike.mjs',
    'next-http-fixture.mjs',
    'next-business-host.ts',
    'next-business-seed.ts',
    'next-business-worker.ts',
    'next-business-http.mjs',
    'next-http-guard.cjs',
  ].map((name) => `payload/apps/heymoro/tests/creation/${name}`),
])
const closurePaths = [
  'next-business-host.ts',
  'next-business-seed.ts',
  'next-business-worker.ts',
].map((name) => `payload/apps/heymoro/tests/creation/${name}`)
export const shaBytes = ({ bytes }) => createHash('sha256').update(bytes).digest('hex')
export const shaFile = ({ filename }) => shaBytes({ bytes: readFileSync(filename) })
export const manifestSHA = ({ manifest }) =>
  shaBytes({
    bytes: JSON.stringify(
      Object.fromEntries(
        Object.entries(manifest).sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
  })
export function readJSON({ filename }) {
  assert(lstatSync(filename).isFile() && !lstatSync(filename).isSymbolicLink())
  return JSON.parse(readFileSync(filename, 'utf8'))
}
export function writeNewJSON({ filename, value }) {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}
export function assertE2SourceMembership({ expected, actual }) {
  assert.equal(new Set(actual).size, actual.length, 'Duplicate source member.')
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    'Source membership changed beyond the frozen manifest.',
  )
}
export function assertE2CandidatePaths({ changes, approvedPaths }) {
  assert(Array.isArray(approvedPaths))
  assert.equal(new Set(approvedPaths).size, approvedPaths.length)
  assert(
    changes.every(({ filename }) => approvedPaths.includes(filename)),
    'Unapproved source candidate.',
  )
}
export function e2ActualManifest({ authority }) {
  const actual = { ...authority.sourceManifest }
  for (const [filename, overlay] of Object.entries(authority.overlays))
    actual[filename] = overlay.runtimeSHA
  return actual
}

/** Schema 3 is one complete current approval; no historical source map grants current bytes. */
export function assertE2AuthorityShape({ authority }) {
  assert.deepEqual(
    Object.keys(authority).sort(),
    [
      'format',
      'profileId',
      'approvedBy',
      'action',
      'directory',
      'mirror',
      'writeRoot',
      'revisionId',
      'targetDir',
      'readyFile',
      'datasetOwnerFile',
      'sourceManifest',
      'sourceManifestSHA',
      'controllerHashes',
      'beforeManifest',
      'actualManifest',
      'changes',
      'overlays',
      'preserved',
      'repositories',
      'historicalProofs',
      'oldTargets',
      'historicalDirectories',
      'targetFingerprint',
    ].sort(),
  )
  assert.equal(authority.format, 3)
  assert.equal(authority.profileId, 'e2-local')
  assert.equal(authority.approvedBy, 'root')
  assert.equal(authority.action, 'prepare-source-only')
  assertE2Binding({ binding: authority })
  assert.match(authority.targetFingerprint, /^[a-f0-9]{64}$/)
  for (const files of [
    authority.sourceManifest,
    authority.beforeManifest,
    authority.actualManifest,
    authority.controllerHashes,
  ]) {
    assert(Object.keys(files).length > 0)
    for (const [filename, sha] of Object.entries(files)) {
      assertRelativeSource({ filename })
      assert.match(sha, /^[a-f0-9]{64}$/)
    }
  }
  assert.equal(manifestSHA({ manifest: authority.sourceManifest }), authority.sourceManifestSHA)
  assert.deepEqual(Object.keys(authority.controllerHashes).sort(), [...E2_CONTROLLER_PATHS].sort())
  assert.deepEqual(Object.keys(authority.overlays).sort(), [...E2_OVERLAY_PATHS].sort())
  for (const [filename, overlay] of Object.entries(authority.overlays)) {
    assert.deepEqual(Object.keys(overlay).sort(), ['runtimeBase64', 'runtimeSHA', 'sourceSHA'])
    assert.equal(overlay.sourceSHA, authority.sourceManifest[filename])
    assert.match(overlay.runtimeSHA, /^[a-f0-9]{64}$/)
    assert(typeof overlay.runtimeBase64 === 'string' && overlay.runtimeBase64.length > 0)
    const runtimeBytes = Buffer.from(overlay.runtimeBase64, 'base64')
    assert.equal(
      runtimeBytes.toString('base64'),
      overlay.runtimeBase64,
      'Noncanonical overlay base64.',
    )
    assert.equal(shaBytes({ bytes: runtimeBytes }), overlay.runtimeSHA)
    assert.notEqual(
      overlay.sourceSHA,
      overlay.runtimeSHA,
      'Original and runtime overlay maps must remain separate.',
    )
    if (filename === nextConfig)
      assert.equal(
        typeof authority.beforeManifest[filename],
        'string',
        'Next config migration requires existing before bytes.',
      )
    else
      assert.equal(
        authority.beforeManifest[filename],
        overlay.runtimeSHA,
        'Existing declaration bytes are immutable.',
      )
  }
  assert.deepEqual(authority.actualManifest, e2ActualManifest({ authority }))
  assertE2Delta({
    before: authority.beforeManifest,
    after: authority.actualManifest,
    changes: authority.changes,
  })
  assertE2CandidatePaths({
    changes: authority.changes,
    approvedPaths: Object.keys(authority.sourceManifest).filter(
      (filename) => filename === nextConfig || !Object.hasOwn(authority.overlays, filename),
    ),
  })
  for (const filename of E2_CONTROLLER_PATHS)
    if (Object.hasOwn(authority.sourceManifest, filename))
      assert.equal(authority.controllerHashes[filename], authority.sourceManifest[filename])
  assert.deepEqual(Object.keys(authority.preserved).sort(), ['ai-engine', 'payload', 'taro'])
  assert.deepEqual(Object.keys(authority.repositories).sort(), ['ai-engine', 'payload', 'taro'])
  for (const [repo, state] of Object.entries(authority.preserved)) {
    assert(Object.keys(state.files).length > 0)
    assert.deepEqual(authority.repositories[repo], {
      head: state.head,
      trackedDiffs: state.trackedDiffs,
      staged: '',
    })
    for (const [filename, sha] of Object.entries(state.files)) {
      assertRelativeSource({ filename })
      assert.match(sha, /^[a-f0-9]{64}$/)
      const sourceName = `${repo}/${filename}`
      if (Object.hasOwn(authority.sourceManifest, sourceName))
        assert.equal(sha, authority.sourceManifest[sourceName])
      if (Object.hasOwn(authority.controllerHashes, sourceName))
        assert.equal(sha, authority.controllerHashes[sourceName])
    }
  }
  assert.equal(new Set(authority.oldTargets).size, authority.oldTargets.length)
  for (const old of E2_OLD_TARGETS)
    assert(authority.oldTargets.includes(old), 'Missing historical target protection.')
  for (const filename of authority.oldTargets) {
    assert.equal(path.dirname(filename), E2_DIRECTORY)
    assert(![authority.targetDir, authority.mirror].includes(filename))
    assert(
      ['new-target', 'e2-product-target'].includes(path.basename(filename)) ||
        /^e2-target-[a-f0-9-]{36}$/.test(path.basename(filename)),
    )
  }
  assert.equal(
    new Set(authority.historicalDirectories).size,
    authority.historicalDirectories.length,
  )
  for (const filename of authority.historicalDirectories) {
    assert(path.isAbsolute(filename) && path.normalize(filename) === filename)
    assert(
      (path.dirname(filename) === E2_DIRECTORY &&
        /^E2-[a-f0-9-]{36}$/.test(path.basename(filename))) ||
        filename.startsWith(`${E2_DIRECTORY}/proof/`),
      'Only approved historical epoch or proof subdirectories may be sealed.',
    )
    assert(
      ![
        authority.targetDir,
        authority.mirror,
        authority.readyFile,
        authority.datasetOwnerFile,
      ].includes(filename),
    )
  }
  for (const [filename, sha] of Object.entries(authority.historicalProofs)) {
    assert(path.isAbsolute(filename) && path.normalize(filename) === filename)
    assert.match(sha, /^[a-f0-9]{64}$/)
    assert(![authority.readyFile, authority.datasetOwnerFile].includes(filename))
    assert(
      !filename.startsWith(`${authority.directory}/proof/E2-runtime-${authority.revisionId}`),
      'Current runtime journal cannot be inherited as history.',
    )
    assert(
      !authority.historicalDirectories.includes(filename),
      'Historical directories are not file hashes.',
    )
  }
  for (const name of ['core.json', 'guard.json'])
    assert.match(
      authority.historicalProofs[`${E2_DIRECTORY}/${name}`],
      /^[a-f0-9]{64}$/,
      'Missing immutable historical root record.',
    )
  for (const [name, sha] of Object.entries(E2_PARENT_HASHES))
    assert.equal(authority.historicalProofs[`${E2_DIRECTORY}/proof/${name}`], sha)
}

/** The caller supplies both the locator and independently reviewed bytes; approvedBy is not an authenticator. */
export function assertE2AuthorityLocator({ authorityFile, authoritySHA } = {}) {
  assert(
    typeof authorityFile === 'string' &&
      path.isAbsolute(authorityFile) &&
      path.normalize(authorityFile) === authorityFile,
    'Explicit authority file required.',
  )
  assert.match(authoritySHA, /^[a-f0-9]{64}$/, 'Explicit reviewed authority SHA required.')
}
export function readE2Authority({ authorityFile, authoritySHA } = {}) {
  assertE2AuthorityLocator({ authorityFile, authoritySHA })
  assertCanonicalPath({ filename: authorityFile })
  assert.equal(
    shaFile({ filename: authorityFile }),
    authoritySHA,
    'Reviewed authority bytes changed.',
  )
  const authority = readJSON({ filename: authorityFile })
  assertE2AuthorityShape({ authority })
  assertE2Directory({ directory: authority.directory })
  assertCanonicalPath({ filename: authority.mirror })
  assertCanonicalPath({ filename: authority.writeRoot })
  assert.equal(realpathSync(path.dirname(authority.targetDir)), E2_DIRECTORY)
  if (existsSync(authority.targetDir)) assertCanonicalPath({ filename: authority.targetDir })
  else assertMissingE2Leaf({ filename: authority.targetDir })
  assertE2SourceMembership({
    expected: [...sourceAllowlist(), ...closurePaths],
    actual: Object.keys(authority.sourceManifest),
  })
  verifyHashMap({ root: E2_SOURCE_ROOT, files: authority.sourceManifest })
  for (const filename of Object.keys(authority.overlays))
    assertE2OverlayTransition({
      authority,
      filename,
      sourceBytes: readFileSync(path.join(E2_SOURCE_ROOT, filename)),
    })
  verifyHashMap({ root: E2_SOURCE_ROOT, files: authority.controllerHashes })
  verifySourceMembership({ root: E2_SOURCE_ROOT, manifest: authority.sourceManifest })
  assert.deepEqual(
    repositoryFacts({ repositories: authority.repositories }),
    authority.repositories,
  )
  for (const [repo, state] of Object.entries(authority.preserved))
    verifyHashMap({ root: path.join(E2_SOURCE_ROOT, repo), files: state.files })
  verifyParents({ authority, authorityFile, authoritySHA })
  return { authority, authorityFile, authoritySHA }
}

/** Old target contents are never read. Only readonly proof bytes and directory membership are checked. */
export function verifyParents({ authority, authorityFile, authoritySHA }) {
  assertE2AuthorityLocator({ authorityFile, authoritySHA })
  for (const [filename, sha] of Object.entries(authority.historicalProofs)) {
    assertCanonicalPath({ filename })
    assert(lstatSync(filename).isFile(), 'Historical proof must be a regular file.')
    assert.equal(shaFile({ filename }), sha, 'Historical proof changed.')
  }
  for (const filename of [...authority.oldTargets, ...authority.historicalDirectories]) {
    assertCanonicalPath({ filename })
    assert(lstatSync(filename).isDirectory(), 'Historical root must be a directory.')
  }
  const proofFiles = []
  const proofDirectories = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      assert(!entry.isSymbolicLink(), 'Symbolic proof surface.')
      if (entry.isDirectory()) {
        assert(
          authority.historicalDirectories.includes(filename),
          'Unregistered historical proof directory.',
        )
        proofDirectories.push(filename)
        walk(filename)
      } else {
        assert(entry.isFile())
        proofFiles.push(filename)
      }
    }
  }
  walk(`${E2_DIRECTORY}/proof`)
  const entries = readdirSync(E2_DIRECTORY, { withFileTypes: true })
  const targetRoots = entries
    .filter((entry) => /^(?:new-target|e2-product-target|e2-target-)/.test(entry.name))
    .map((entry) => `${E2_DIRECTORY}/${entry.name}`)
  const epochs = Object.fromEntries(
    entries
      .filter((entry) => /^E2-[a-f0-9-]{36}$/.test(entry.name))
      .map((entry) => {
        const filename = `${E2_DIRECTORY}/${entry.name}`
        return [
          filename,
          authority.historicalDirectories.includes(filename)
            ? null
            : readJSON({ filename: `${filename}/report.json` }),
        ]
      }),
  )
  assertE2HistoricalMembership({
    authority,
    authorityFile,
    authoritySHA,
    proofFiles,
    proofDirectories,
    targetRoots,
    epochs,
  })
}

/** History is a fixed snapshot. Derived current outputs never mutate that snapshot or become history. */
export function assertE2HistoricalMembership({
  authority,
  authorityFile,
  authoritySHA,
  proofFiles,
  proofDirectories,
  targetRoots,
  epochs,
}) {
  assertE2AuthorityLocator({ authorityFile, authoritySHA })
  const files = runtimeFiles({ authority })
  const stage = `${authority.directory}/proof/E2-runtime-${authority.revisionId}-next-config.mjs`
  assert(
    !Object.values(files).includes(authorityFile) && authorityFile !== stage,
    'Authority locator collides with a reserved runtime output.',
  )
  if (!files.nextConfig)
    assert(!proofFiles.includes(stage), 'A no-migration run must not contain a residual stage.')
  const current = new Set([
    authorityFile,
    ...Object.values(files),
    authority.readyFile,
    authority.datasetOwnerFile,
  ])
  for (const filename of proofFiles)
    assert(
      current.has(filename) || Object.hasOwn(authority.historicalProofs, filename),
      'Missing historical proof protection.',
    )
  for (const filename of Object.keys(authority.historicalProofs))
    if (filename.startsWith(`${authority.directory}/proof/`))
      assert(proofFiles.includes(filename), 'Missing protected historical proof.')
  for (const filename of authority.oldTargets)
    assert(targetRoots.includes(filename), 'Missing protected historical target.')
  for (const filename of targetRoots)
    assert(
      filename === authority.targetDir || authority.oldTargets.includes(filename),
      'Unprotected old target root.',
    )
  for (const filename of authority.historicalDirectories) {
    if (filename.startsWith(`${authority.directory}/proof/`))
      assert(proofDirectories.includes(filename), 'Missing protected proof directory.')
    else assert(Object.hasOwn(epochs, filename), 'Missing sealed epoch root.')
  }
  for (const filename of proofDirectories)
    assert(authority.historicalDirectories.includes(filename), 'Unprotected proof directory.')
  for (const [filename, report] of Object.entries(epochs)) {
    if (authority.historicalDirectories.includes(filename)) continue
    assert.equal(path.dirname(filename), authority.directory)
    assert.match(path.basename(filename), /^E2-[a-f0-9-]{36}$/)
    for (const [key, expected] of Object.entries({
      revisionId: authority.revisionId,
      authorityFile,
      authoritySHA,
      sourceManifestSHA: authority.sourceManifestSHA,
      targetDir: authority.targetDir,
    }))
      assert.equal(report[key], expected, `Unprotected historical epoch: ${key}`)
  }
}

export function runtimeFiles({ authority }) {
  const prefix = `${authority.directory}/proof/E2-runtime-${authority.revisionId}`
  return {
    intent: `${prefix}-intent.json`,
    proof: `${prefix}.json`,
    filesFrom: `${prefix}.txt`,
    dry: `${prefix}-dry.log`,
    copy: `${prefix}-copy.log`,
    ...(authority.changes.some(({ filename }) => filename === nextConfig)
      ? { nextConfig: `${prefix}-next-config.mjs` }
      : {}),
  }
}

/** Pure closed copy description; this does not authorize or execute any filesystem operation. */
export function e2CopyPlan({ authority }) {
  assertE2AuthorityShape({ authority })
  const files = runtimeFiles({ authority })
  const sourceNames = authority.changes
    .filter(({ filename }) => !Object.hasOwn(authority.overlays, filename))
    .map(({ filename }) => filename)
  const intermediateManifest = { ...authority.beforeManifest }
  for (const filename of sourceNames)
    intermediateManifest[filename] = authority.actualManifest[filename]
  assert.deepEqual(
    {
      ...intermediateManifest,
      ...(files.nextConfig ? { [nextConfig]: authority.actualManifest[nextConfig] } : {}),
    },
    authority.actualManifest,
  )
  const copies = []
  if (sourceNames.length)
    copies.push({
      kind: 'source',
      cwd: E2_SOURCE_ROOT,
      args: [
        '-a',
        `--exclude-from=${excludes}`,
        `--files-from=${files.filesFrom}`,
        `${E2_SOURCE_ROOT}/`,
        `${authority.mirror}/`,
      ],
    })
  if (files.nextConfig)
    copies.push({
      kind: 'next-config',
      cwd: E2_SOURCE_ROOT,
      args: [
        '-a',
        `--exclude-from=${excludes}`,
        files.nextConfig,
        path.join(authority.mirror, nextConfig),
      ],
    })
  return {
    sourceNames,
    filesFromText: sourceNames.length ? `${sourceNames.join('\n')}\n` : '',
    intermediateManifest,
    copies,
  }
}

/** New stage bytes are always the current exact runtime recipe, never the recognized old alias. */
export function assertE2NextConfigStageBytes({ authority, bytes, sourceBytes }) {
  assert(Buffer.isBuffer(bytes), 'Missing staged Next config bytes.')
  assertE2OverlayTransition({ authority, filename: nextConfig, sourceBytes })
  assert.deepEqual(bytes, Buffer.from(authority.overlays[nextConfig].runtimeBase64, 'base64'))
  assert.equal(shaBytes({ bytes }), authority.overlays[nextConfig].runtimeSHA)
}

function runtimeExpectation({ authority, authorityFile, authoritySHA }) {
  return {
    format: 3,
    authorityFile,
    authoritySHA,
    revisionId: authority.revisionId,
    targetDir: authority.targetDir,
    sourceManifestSHA: authority.sourceManifestSHA,
    beforeManifest: authority.beforeManifest,
    actualManifest: authority.actualManifest,
    changes: authority.changes,
  }
}

/** Pure complete-journal verification. Only materializeE2Revision can cross the external authority gate. */
export function assertE2CopyJournal({
  revision,
  intentBytes,
  proof,
  filesFrom,
  dryLog,
  copyLog,
  stageBytes,
  sourceBytes,
}) {
  assertE2AuthorityLocator(revision)
  const { authority } = revision
  const plan = e2CopyPlan({ authority })
  const files = runtimeFiles({ authority })
  const expected = runtimeExpectation(revision)
  assert.equal(typeof intentBytes, 'string')
  assertRuntimeIntent({ intent: JSON.parse(intentBytes), expected, authority })
  assert.equal(
    filesFrom,
    plan.filesFromText,
    'Files-from must contain only the exact source names.',
  )
  assertCopyLog({ text: dryLog, plan, isDry: true })
  assertCopyLog({ text: copyLog, plan, isDry: false })
  if (files.nextConfig) assertE2NextConfigStageBytes({ authority, bytes: stageBytes, sourceBytes })
  else assert.equal(stageBytes, undefined, 'A no-migration run must not have staged overlay bytes.')
  assert.deepEqual(proof, {
    ...expected,
    intentSHA: shaBytes({ bytes: intentBytes }),
    filesFromSHA: shaBytes({ bytes: filesFrom }),
    drySHA: shaBytes({ bytes: dryLog }),
    copySHA: shaBytes({ bytes: copyLog }),
    ...(files.nextConfig ? { nextConfigSHA: authority.overlays[nextConfig].runtimeSHA } : {}),
  })
}
function assertCopyLog({ text, plan, isDry }) {
  assert.equal(typeof text, 'string')
  if (!plan.copies.length) {
    assert.equal(text, '')
    return
  }
  assert(text.endsWith('\n'))
  const rows = text.slice(0, -1).split('\n')
  assert.equal(rows.length, plan.copies.length, 'Copy command count changed.')
  for (const [index, line] of rows.entries()) {
    const row = JSON.parse(line)
    assert.equal(JSON.stringify(row), line)
    assert.deepEqual(Object.keys(row).sort(), ['argv', 'cwd', 'exit', 'signal', 'stderr', 'stdout'])
    const copy = plan.copies[index]
    assert.deepEqual(row.argv, [
      '/usr/bin/rsync',
      ...(isDry ? ['--dry-run'] : []),
      '--stats',
      ...copy.args,
    ])
    assert.equal(row.cwd, copy.cwd)
    assert.equal(row.exit, 0)
    assert.equal(row.signal, null)
    assert.equal(typeof row.stdout, 'string')
    assert.equal(typeof row.stderr, 'string')
  }
}

/** Exact source then exact staged overlay, with all preflights before any actual copy. */
export function materializeE2Revision({ authorityFile, authoritySHA } = {}) {
  const revision = readE2Authority({ authorityFile, authoritySHA })
  const { authority } = revision
  const mirror = authority.mirror
  const files = runtimeFiles({ authority })
  const plan = e2CopyPlan({ authority })
  const expected = runtimeExpectation(revision)
  const result = {
    ...revision,
    actualManifest: authority.actualManifest,
    ownerFile: files.proof,
    immutableProofFiles: Object.values(files),
  }
  const journal = (proof) => ({
    revision,
    intentBytes: readFileSync(files.intent, 'utf8'),
    proof,
    filesFrom: readFileSync(files.filesFrom, 'utf8'),
    dryLog: readFileSync(files.dry, 'utf8'),
    copyLog: readFileSync(files.copy, 'utf8'),
    ...(files.nextConfig
      ? {
          stageBytes: readFileSync(files.nextConfig),
          sourceBytes: readFileSync(path.join(E2_SOURCE_ROOT, nextConfig)),
        }
      : {}),
  })
  if (existsSync(files.proof)) {
    verifyStage({ authority, files })
    assertE2CopyJournal(journal(readJSON({ filename: files.proof })))
    verifyHashMap({ root: mirror, files: authority.actualManifest })
    verifySourceMembership({ root: mirror, manifest: authority.actualManifest })
    return result
  }
  assert(
    !Object.values(files).some(existsSync),
    'Incomplete runtime proof: no automatic repair or retry.',
  )
  const listing = run({
    executable: '/usr/sbin/lsof',
    args: ['-d', 'cwd', '-Fn'],
    cwd: E2_SOURCE_ROOT,
  })
  assert(
    !listing.split('\n').some((entry) => entry === `n${mirror}` || entry.startsWith(`n${mirror}/`)),
    'Owned mirror is active.',
  )
  assertCanonicalPath({ filename: excludes })
  verifyHashMap({ root: mirror, files: authority.beforeManifest })
  verifySourceMembership({ root: mirror, manifest: authority.beforeManifest })
  const beforeBytes = Object.fromEntries(
    authority.changes
      .filter(({ beforeSHA }) => beforeSHA !== null)
      .map(({ filename }) => [
        filename,
        readFileSync(path.join(mirror, filename)).toString('base64'),
      ]),
  )
  const intent = { ...expected, beforeBytes }
  assertRuntimeIntent({ intent, expected, authority })
  writeNewJSON({ filename: files.intent, value: intent })
  writeFileSync(files.filesFrom, plan.filesFromText, { flag: 'wx', mode: 0o600 })
  if (files.nextConfig)
    writeFileSync(
      files.nextConfig,
      Buffer.from(authority.overlays[nextConfig].runtimeBase64, 'base64'),
      { flag: 'wx', mode: 0o600 },
    )
  const verifyInputs = ({ configSHA }) => {
    assertRuntimeIntent({ intent: readJSON({ filename: files.intent }), expected, authority })
    assert.equal(readFileSync(files.filesFrom, 'utf8'), plan.filesFromText)
    verifyStage({ authority, files })
    // Overlay destination is always an existing regular canonical managed leaf.
    verifyHashMap({ root: mirror, files: { [nextConfig]: configSHA } })
  }
  const descriptors = []
  try {
    const dry = openSync(files.dry, 'wx', 0o600)
    descriptors.push(dry)
    const copyLog = openSync(files.copy, 'wx', 0o600)
    descriptors.push(copyLog)
    verifyInputs({ configSHA: authority.beforeManifest[nextConfig] })
    for (const copy of plan.copies) runRsync({ copy, isDry: true, log: dry })
    // Original source/controller/guard/lock/Git/history and full before are rechecked after all dry runs.
    readE2Authority({ authorityFile, authoritySHA })
    verifyHashMap({ root: mirror, files: authority.beforeManifest })
    verifySourceMembership({ root: mirror, manifest: authority.beforeManifest })
    verifyInputs({ configSHA: authority.beforeManifest[nextConfig] })
    for (const copy of plan.copies) {
      runRsync({ copy, isDry: false, log: copyLog })
      const manifest = copy.kind === 'source' ? plan.intermediateManifest : authority.actualManifest
      verifyHashMap({ root: mirror, files: manifest })
      verifySourceMembership({ root: mirror, manifest })
      if (copy.kind === 'source' && files.nextConfig) {
        readE2Authority({ authorityFile, authoritySHA })
        verifyInputs({ configSHA: plan.intermediateManifest[nextConfig] })
      }
    }
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor)
  }
  verifyHashMap({ root: mirror, files: authority.actualManifest })
  verifySourceMembership({ root: mirror, manifest: authority.actualManifest })
  readE2Authority({ authorityFile, authoritySHA })
  verifyInputs({ configSHA: authority.actualManifest[nextConfig] })
  const proof = {
    ...expected,
    intentSHA: shaFile({ filename: files.intent }),
    filesFromSHA: shaFile({ filename: files.filesFrom }),
    drySHA: shaFile({ filename: files.dry }),
    copySHA: shaFile({ filename: files.copy }),
    ...(files.nextConfig ? { nextConfigSHA: shaFile({ filename: files.nextConfig }) } : {}),
  }
  assertE2CopyJournal(journal(proof))
  writeNewJSON({ filename: files.proof, value: proof })
  verifyParents({ authority, authorityFile, authoritySHA })
  return result
}

function verifyStage({ authority, files }) {
  if (!files.nextConfig) return
  verifyHashMap({
    root: authority.directory,
    files: {
      [path.relative(authority.directory, files.nextConfig)]:
        authority.overlays[nextConfig].runtimeSHA,
    },
  })
  assertE2NextConfigStageBytes({
    authority,
    bytes: readFileSync(files.nextConfig),
    sourceBytes: readFileSync(path.join(E2_SOURCE_ROOT, nextConfig)),
  })
}
function runRsync({ copy, isDry, log }) {
  const argv = ['/usr/bin/rsync', ...(isDry ? ['--dry-run'] : []), '--stats', ...copy.args]
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: copy.cwd,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 ** 2,
  })
  appendFileSync(
    log,
    `${JSON.stringify({ argv, cwd: copy.cwd, exit: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '' })}\n`,
  )
  assert.equal(result.status, 0, `rsync failed (${result.status}).`)
  assert.equal(result.signal, null)
}
function assertRuntimeIntent({ intent, expected, authority }) {
  assert.deepEqual(
    Object.keys(intent.beforeBytes).sort(),
    authority.changes
      .filter(({ beforeSHA }) => beforeSHA !== null)
      .map(({ filename }) => filename)
      .sort(),
  )
  for (const [filename, encoded] of Object.entries(intent.beforeBytes)) {
    assert.equal(typeof encoded, 'string')
    const bytes = Buffer.from(encoded, 'base64')
    assert.equal(bytes.toString('base64'), encoded, 'Noncanonical before bytes.')
    assert.equal(shaBytes({ bytes }), authority.beforeManifest[filename])
  }
  assert.deepEqual(intent, { ...expected, beforeBytes: intent.beforeBytes })
}

export function assertE2ExecutionGate({
  mode,
  approval,
  verificationId,
  authorityFile,
  authoritySHA,
  binding,
  ports,
  frozenInputs,
  kernelPolicySHA,
}) {
  assertE2AuthorityLocator({ authorityFile, authoritySHA })
  assertE2Binding({ binding })
  assert.match(kernelPolicySHA, /^[a-f0-9]{64}$/)
  assert.deepEqual(
    approval,
    {
      format: 3,
      approvedBy: 'root',
      action: e2ModeAction({ mode }),
      verificationId,
      authorityFile,
      authoritySHA,
      binding,
      ports,
      frozenInputs,
      kernelPolicySHA,
    },
    'Exact root Gate B is required before product operations.',
  )
  assertE2Ports({ ports: approval.ports })
}
export function kernelPolicySHA({ kernelPolicy }) {
  assert.deepEqual(
    Object.keys(kernelPolicy).sort(),
    ['writeRoot', 'ports', 'protectedRoots', 'oldDataRoots', 'immutablePaths'].sort(),
  )
  // Include each whole role-specific kernel program, not only a caller-selected subset of fields.
  return shaBytes({
    bytes: JSON.stringify(
      ['core-init', 'attest', 'seed', 'next-1', 'next-2', 'jobs-1', 'jobs-2', 'snapshot'].map(
        (role) => e2KernelProfile({ ...kernelPolicy, role }),
      ),
    ),
  })
}
export function assertE2RunAuthority({ fixture }) {
  const { authority, authoritySHA, authorityFile } = readE2Authority({
    authorityFile: fixture.e2.control.authorityFile,
    authoritySHA: fixture.e2.control.authoritySHA,
  })
  assert.equal(fixture.report.authoritySHA, authoritySHA)
  assert.equal(fixture.app, `${authority.mirror}/payload/apps/heymoro`)
  assert.equal(fixture.mirror, authority.mirror)
  assert.equal(fixture.directory, authority.directory)
  assert.equal(fixture.dataDir, authority.targetDir)
  assert.equal(fixture.e2.kernelPolicy.writeRoot, authority.writeRoot)
  assertE2Binding({ binding: fixture.e2.control })
  assert.equal(fixture.jsonFile, path.join(fixture.e2.epochRoot, 'core-e2.json'))
  assert.deepEqual(readJSON({ filename: fixture.e2.controlFile }), fixture.e2.control)
  assert.equal(shaFile({ filename: fixture.jsonFile }), fixture.e2.control.jsonSHA)
  assert.deepEqual(fixture.e2.actualManifest, authority.actualManifest)
  assert.deepEqual(fixture.e2.kernelPolicy.ports, fixture.e2.ports)
  assert.equal(fixture.report.mode, fixture.e2.control.mode)
  assert(fixture.e2.kernelPolicy.protectedRoots.includes(E2_SOURCE_ROOT))
  for (const old of authority.oldTargets) {
    assert(fixture.e2.kernelPolicy.protectedRoots.includes(old))
    assert(fixture.e2.kernelPolicy.oldDataRoots.includes(old))
    assert(fixture.config.protectedRoots.includes(old) && fixture.config.oldDataRoots.includes(old))
  }
  for (const epoch of authority.historicalDirectories)
    assert(
      fixture.e2.kernelPolicy.protectedRoots.includes(epoch) &&
        fixture.config.protectedRoots.includes(epoch),
    )
  for (const filename of [
    authorityFile,
    ...Object.keys(authority.historicalProofs),
    ...Object.keys(fixture.e2.frozenInputs),
  ])
    assert(fixture.e2.kernelPolicy.immutablePaths.includes(filename))
  const policySHA = kernelPolicySHA({ kernelPolicy: fixture.e2.kernelPolicy })
  assert.equal(policySHA, fixture.e2.control.kernelPolicySHA, 'Kernel policy drift before spawn.')
  verifySourceMembership({ root: fixture.mirror, manifest: authority.actualManifest })
  verifyHashMap({ root: fixture.mirror, files: authority.actualManifest })
  const filename = path.join(fixture.e2.epochRoot, 'gate-b.json')
  assert(fixture.e2.kernelPolicy.immutablePaths.includes(filename))
  const approval = readJSON({ filename })
  const approvalSHA = shaFile({ filename })
  if (fixture.e2.gateBSHA) assert.equal(approvalSHA, fixture.e2.gateBSHA)
  else fixture.e2.gateBSHA = approvalSHA
  const binding = {
    ...assertE2Binding({ binding: authority }),
    sourceManifestSHA: authority.sourceManifestSHA,
    targetFingerprint: authority.targetFingerprint,
  }
  assertE2ExecutionGate({
    mode: fixture.e2.control.mode,
    approval,
    verificationId: fixture.report.verificationId,
    authorityFile,
    authoritySHA,
    binding,
    ports: fixture.e2.ports,
    frozenInputs: fixture.e2.frozenInputs,
    kernelPolicySHA: policySHA,
  })
  for (const [frozen, sha] of Object.entries(approval.frozenInputs))
    assert.equal(shaFile({ filename: frozen }), sha)
  if (fixture.e2.control.mode === 'initialize') {
    if (!fixture.e2.initialized) assertMissingE2Leaf({ filename: authority.targetDir })
    else assertInitializedProfile({ fixture })
  } else
    assert.deepEqual(
      readE2ReadyBinding({ authority, authorityFile, authoritySHA }),
      fixture.e2.control.ready,
    )
}
export function assertInitializedProfile({ fixture }) {
  assert.equal(fixture.e2.control.mode, 'initialize')
  const command = fixture.report.commands.find(({ name }) => name === 'core-init')
  assert(command && command.exit === 0 && command.signal === null)
  const target = fixture.e2.control.targetDir
  assertCanonicalPath({ filename: target })
  const profile = readJSON({ filename: `${target}/profile.json` })
  assert.equal(profile.state, 'ready')
  assert.equal(profile.profile, 'heymoro-core')
  assert.equal(profile.fingerprint, fixture.e2.control.targetFingerprint)
  assert.match(profile.nonce, /^[a-f0-9-]{36}$/)
  return profile
}

export const E2_PARENT_HASHES = Object.freeze({
  'report.json': '1bab20bfb5808fd95ed738994b6bd7868a93a1379e5c21d2d913f1c2d2d8a972',
  'E0R-source-revision.json': '805d1cc5b3ae6abe886d3d2cfe2bc131392c25181b5e6d43d0a83bae383fdf0f',
  'ready-owner.json': 'e084e72cae78622dda6c23fa3ee907a1bdd485340f48e4646ac4429e57a064fa',
  'ready-owner-E0R.json': '7d4e72f739c463a66790447d129176f5ac14b23cba70df44d1cd35df44a27ac4',
  'E0R-source-before.json': '67dcc96066dfec85e05e6d28630aba8ba7e59b1b34e8a889a37ee76c5e07c401',
  'E0R-source-after.json': '015fc0f6a22f0f0deb94b424fb35fc41f74cdc6e3fdd20444d427c6ea6302208',
  'source-files.txt': '51f73da6ab1b6be584ab7af007177e72e7b5d17e943e78b1cf4102f3897d2c2e',
})

export function repositoryFacts({ repositories }) {
  assert.deepEqual(Object.keys(repositories).sort(), ['ai-engine', 'payload', 'taro'])
  return Object.fromEntries(
    Object.keys(repositories).map((repo) => {
      const cwd = path.join(E2_SOURCE_ROOT, repo)
      const git = (args) => run({ executable: '/usr/bin/git', args, cwd })
      const names = git(['diff', '--name-only']).trim().split('\n').filter(Boolean)
      const trackedDiffs = Object.fromEntries(
        names.map((filename) => {
          assertRelativeSource({ filename })
          return [filename, shaBytes({ bytes: git(['diff', '--binary', '--', filename]) })]
        }),
      )
      const staged = git(['diff', '--cached', '--binary'])
      assert.equal(staged, '', 'E2 requires the inherited empty index.')
      return [repo, { head: git(['rev-parse', 'HEAD']).trim(), trackedDiffs, staged }]
    }),
  )
}
export function verifyHashMap({ root, files }) {
  for (const [filename, sha] of Object.entries(files)) {
    assertRelativeSource({ filename })
    const absolute = path.join(root, filename)
    assertCanonicalPath({ filename: absolute })
    assert(lstatSync(absolute).isFile())
    assert.equal(shaFile({ filename: absolute }), sha, `Frozen file changed: ${filename}`)
  }
}

export function newE2Epoch({ revision, mode }) {
  const { authority } = revision
  const reports = readdirSync(E2_DIRECTORY, { withFileTypes: true })
    .filter(
      (entry) =>
        /^E2-[a-f0-9-]{36}$/.test(entry.name) &&
        !authority.historicalDirectories.includes(`${E2_DIRECTORY}/${entry.name}`),
    )
    .map((entry) => readJSON({ filename: `${E2_DIRECTORY}/${entry.name}/report.json` }))
  const initializationVerificationId =
    mode === 'business' ? readJSON({ filename: authority.readyFile }).verificationId : null
  assertE2EpochSequence({ mode, reports, initializationVerificationId })
  const verificationId = randomUUID()
  const epochRoot = path.join(E2_DIRECTORY, `E2-${verificationId}`)
  mkdirSync(epochRoot, { mode: 0o700 })
  for (const folder of [
    'logs',
    'journal',
    'snapshots',
    'compiler-acks',
    'synthetic',
    'synthetic/.data',
  ])
    mkdirSync(path.join(epochRoot, folder), { mode: 0o700 })
  return { verificationId, epochRoot, ...revision }
}

export function readE2ReadyBinding({ authority, authorityFile, authoritySHA }) {
  assertE2AuthorityLocator({ authorityFile, authoritySHA })
  assert.equal(shaFile({ filename: authorityFile }), authoritySHA)
  assert.deepEqual(readJSON({ filename: authorityFile }), authority)
  const { targetFingerprint, targetDir, readyFile } = authority
  assertCanonicalPath({ filename: targetDir })
  const filename = `${targetDir}/profile.json`
  assertCanonicalPath({ filename })
  const profile = readJSON({ filename })
  const receipt = readJSON({ filename: readyFile })
  assert.equal(receipt.authoritySHA, authoritySHA)
  const binding = {
    ...assertE2Binding({ binding: authority }),
    sourceManifestSHA: authority.sourceManifestSHA,
    authorityFile,
    authoritySHA,
    targetDir: targetDir,
    readyFile: readyFile,
    readySHA: shaFile({ filename: readyFile }),
    profileSHA: shaFile({ filename }),
    profileNonce: profile.nonce,
    targetFingerprint,
  }
  assertE2ReadyReceipt({ binding, profile, receipt, receiptSHA: binding.readySHA })
  const initialization = readJSON({ filename: receipt.initializationFile })
  const report = readJSON({ filename: receipt.reportFile })
  const attestation = JSON.parse(readFileSync(receipt.attest.evidenceFile, 'utf8').trim())
  assertE2ReadyEvidence({
    receipt,
    initialization,
    report,
    attestation,
    hashes: {
      jsonSHA: shaFile({ filename: receipt.jsonFile }),
      controlSHA: shaFile({ filename: receipt.controlFile }),
      initializationSHA: shaFile({ filename: receipt.initializationFile }),
      reportSHA: shaFile({ filename: receipt.reportFile }),
      attestEvidenceSHA: shaBytes({ bytes: JSON.stringify(attestation) }),
    },
  })
  return binding
}

function verifySourceMembership({ root, manifest }) {
  const prefixes = [
    'ai-engine/src',
    'payload/apps/heymoro/src',
    ...[
      'payload',
      'db-sqlite',
      'richtext-lexical',
      'transformer-sharp',
      'next',
      'ui',
      'translations',
      'drizzle',
      'graphql',
    ].map((name) => `payload/packages/${name}/src`),
  ]
  const actual = []
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Source surface contains a symbolic link.')
      const filename = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(filename)
      else actual.push(filename)
    }
  }
  for (const prefix of prefixes) walk(prefix)
  assertE2SourceMembership({
    expected: Object.keys(manifest).filter((filename) =>
      prefixes.some((prefix) => filename.startsWith(`${prefix}/`)),
    ),
    actual,
  })
}

function run({ executable, args, cwd }) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 ** 2,
  })
  assert.equal(result.status, 0, `${path.basename(executable)} failed (${result.status}).`)
  return result.stdout
}

/** Existing partial epochs are terminal evidence, not an implicit recovery or reseed capability. */
export function assertE2EpochSequence({ mode, reports, initializationVerificationId }) {
  e2ModeAction({ mode })
  if (mode === 'initialize') {
    assert.deepEqual(
      reports,
      [],
      'Initialization already attempted; root must approve a new revision and target.',
    )
    return
  }
  assert.equal(
    reports.length,
    1,
    'Business requires exactly one closed initialization and no previous business attempt.',
  )
  const report = reports[0]
  assert.equal(report.mode, 'initialize')
  assert.equal(report.status, 'initialized-awaiting-root')
  assert.equal(report.verificationId, initializationVerificationId)
  assert.equal(report.servicesClosed, true)
  assert.equal(report.cleanupUnconfirmed, false)
  assert.equal(report.error, null)
  for (const key of ['activeLeases', 'rounds', 'httpTraces']) assert.deepEqual(report[key], [])
  assert.deepEqual(
    report.commands.map(({ name, exit, signal }) => ({ name, exit, signal })),
    [
      { name: 'core-init', exit: 0, signal: null },
      { name: 'attest', exit: 0, signal: null },
    ],
  )
}
