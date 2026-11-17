import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const guard = fileURLToPath(new URL('./next-http-guard.cjs', import.meta.url))

// Explicit entry point, deliberately outside automatic test discovery.
export function isolationChecks() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E0-negative-')))
  const protectedRoot = path.join(directory, 'original')
  const logs = path.join(directory, 'logs')
  mkdirSync(protectedRoot)
  mkdirSync(logs)
  mkdirSync(path.join(protectedRoot, '.data'))
  writeFileSync(path.join(protectedRoot, 'source.txt'), 'owned-synthetic')
  writeFileSync(path.join(protectedRoot, '.env.probe'), 'owned-synthetic')
  writeFileSync(path.join(protectedRoot, '.data', 'old.json'), '{}')
  const configFile = path.join(directory, 'guard.json')
  writeFileSync(configFile, JSON.stringify({ protectedRoots: [protectedRoot], logs }))
  const code = `
    const fs = require('node:fs'); const root = ${JSON.stringify(protectedRoot)};
    const blocked = (work) => { try { work(); return false } catch (error) { return error.code === 'E0_DENIED' } };
    const checks = {
      write: blocked(() => fs.writeFileSync(root + '/source.txt', 'bad')),
      dotenv: blocked(() => fs.readFileSync(root + '/.env.probe')),
      oldData: blocked(() => fs.readFileSync(root + '/.data/old.json')),
      asyncWrite: false,
    };
    fs.promises.writeFile(root + '/async.txt', 'bad').then(() => {}, (error) => { checks.asyncWrite = error.code === 'E0_DENIED' }).then(() => console.log(JSON.stringify(checks)));
  `
  const result = spawnSync(process.execPath, ['--require', guard, '-e', code], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: '/usr/bin:/bin', HOME: directory, E0_GUARD_CONFIG: configFile },
  })
  assert.equal(result.status, 0, `Guard process failed (${result.status}); not a behavioral RED.`)
  assert.equal(result.stderr.includes('MODULE_NOT_FOUND'), false)
  const checks = JSON.parse(result.stdout.trim())
  assert.deepEqual(checks, { write: true, dotenv: true, oldData: true, asyncWrite: true })
  return { directory, checks }
}

export async function fixtureChecks({ section }) {
  const {
    createFixture,
    sourceAllowlist,
    assertResumeState,
    assertAuthorizedBaseline,
    assertGeneratedOverlay,
    assertPassedVerification,
    verificationEpoch,
    processClosure,
    assertNodeEvidence,
    measureFootprint,
    networkPolicy,
    expectedProvenanceRoot,
    pendingPreparationStages,
    assertNodeTypesTarget,
    parseLockedResolution,
    sourceBytes,
    deriveToolingDescriptor,
    assertToolingDescriptor,
    isNodeProcess,
    assertSignalRaceExited,
    attemptEvidence,
    collectOwnedGroups,
    maySignalGroup,
    assertProcessIdentity,
    observingHTTP,
  } = await import('./next-http-fixture.mjs')
  if (section === 'passed-verification') {
    const directory = '/OWNED'
    const report = {
      directory,
      mirror: '/OWNED/source',
      status: 'passed',
      cleanupUnconfirmed: false,
      rounds: [1, 2].map((round) => ({
        round,
        status: 200,
        database: 'ok',
        requestId: '4abeb86c-9019-44af-85e7-2f85a84ee05b',
        coldProcess: true,
        compiledRoots: ['/OWNED/source'],
        compiledJSON: '/OWNED/core.json',
        owners: [100],
        processes: [100],
      })),
      cleanup: [
        { command: 'next-1', groupExited: true, portClosed: true },
        { command: 'next-2', groupExited: true, portClosed: true },
      ],
    }
    const input = {
      report,
      directory,
      sourceUnchanged: true,
      ownerUnchanged: true,
      processesGone: true,
      portClosed: true,
    }
    assert.equal(
      typeof assertPassedVerification,
      'function',
      'Separate passed verification gate required.',
    )
    const original = JSON.stringify(report)
    assertPassedVerification(input)
    for (const property of ['sourceUnchanged', 'ownerUnchanged', 'processesGone', 'portClosed'])
      assert.throws(() => assertPassedVerification({ ...input, [property]: false }))
    for (const changed of [
      { ...report, status: 'failed' },
      { ...report, cleanupUnconfirmed: true },
      { ...report, rounds: [] },
    ])
      assert.throws(() => assertPassedVerification({ ...input, report: changed }))
    assert.equal(
      typeof verificationEpoch,
      'function',
      'Verification requires independent epoch storage.',
    )
    const epoch = verificationEpoch({ directory, report, parentSHA: 'parent-sha' })
    assert.match(epoch.reportFile, /^\/OWNED\/proof\/verification-[a-f0-9-]{36}\.json$/)
    assert.notEqual(epoch.reportFile, epoch.parentPassedReportPath)
    assert.deepEqual(epoch.rounds, [])
    assert.deepEqual(epoch.commands, [])
    assert.deepEqual(epoch.cleanup, [])
    epoch.rounds.push({ round: 1 })
    assert.equal(JSON.stringify(report), original, 'Passed evidence must remain immutable.')
    return { separatePassedEpoch: true, unsafeInputsRejected: true, oldEvidenceUnchanged: true }
  }
  if (section === 'generated-overlay') {
    const filename = 'payload/apps/heymoro/next-env.d.ts'
    const sourceHashes = {
      [filename]: '85d7858178472e770bed40b3c6e69c5f5925b4787aaae6ef6a60a2fd8dd7de16',
      other: 'same',
    }
    const actualHashes = {
      [filename]: '0f70629890b72a0a82e91972cc032c04b658b26c265373cb711cf576bfbf8fcc',
      other: 'same',
    }
    assert.equal(
      typeof assertGeneratedOverlay,
      'function',
      'Exact generated overlay validator required.',
    )
    assertGeneratedOverlay({ sourceHashes, actualHashes })
    assert.throws(() =>
      assertGeneratedOverlay({
        sourceHashes,
        actualHashes: { ...actualHashes, [filename]: actualHashes[filename] + 'x' },
      }),
    )
    assert.throws(() =>
      assertGeneratedOverlay({ sourceHashes, actualHashes: { ...actualHashes, other: 'changed' } }),
    )
    return { exactNextGeneratedOverlay: true, extraByteAndUnrelatedChangesRejected: true }
  }
  if (section === 'source-revision') {
    const oldBaseline = {
      payload: {
        files: { 'apps/heymoro/src/creation/runtime/config.ts': 'old', 'src/other.ts': 'same' },
        head: 'head',
      },
    }
    const newBaseline = structuredClone(oldBaseline)
    newBaseline.payload.files['apps/heymoro/src/creation/runtime/config.ts'] = 'new'
    const authorization = {
      scope: ['payload/apps/heymoro/src/creation/runtime/config.ts'],
      beforeSHA: 'old',
      afterSHA: 'new',
    }
    assert.equal(
      typeof assertAuthorizedBaseline,
      'function',
      'Explicit controlled baseline validator required.',
    )
    assertAuthorizedBaseline({ oldBaseline, newBaseline, authorization })
    for (const change of [
      (value) => {
        value.payload.files['src/other.ts'] = 'unknown'
      },
      (value) => {
        value.payload.head = 'different'
      },
      (value) => {
        value.payload.files['apps/heymoro/src/creation/runtime/config.ts'] = 'unknown'
      },
    ]) {
      const changed = structuredClone(newBaseline)
      change(changed)
      assert.throws(() =>
        assertAuthorizedBaseline({ oldBaseline, newBaseline: changed, authorization }),
      )
    }
    return { controlledBaseline: true, unrelatedSourceHEADAndUnknownHashRejected: true }
  }
  const files = sourceAllowlist()
  if (section === 'compiler-ack') {
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E0-ack-')))
    const configFile = path.join(directory, 'guard.json')
    writeFileSync(configFile, JSON.stringify({ logs: directory, protectedRoots: [] }))
    const code = `const {compilerAckMatches:f,compilerAckExpired:expired}=require(${JSON.stringify(guard)});const expected={ticket:'ticket-new',commandId:'command-new',pid:200,ppid:100,uid:7,nodeCanonical:'/PIN/node',scriptCanonical:'/OWNED/tsc.js',birthMs:Date.UTC(2026,10,12,22,41,4)};const ack={...expected,pgid:200,birth:'Thu Nov 12 22:41:04 2026 GMT+0000'};const values=[ack,{...ack,ticket:'wrong'},{...ack,commandId:'old'},{...ack,pid:201},{...ack,uid:8},{...ack,birth:'Thu Nov 12 22:40:00 2026 GMT+0000'}].map(ack=>f({ack,expected}));console.log(JSON.stringify({values,expired:expired({started:0,now:1001,timeout:1000})}));`
    const result = spawnSync(process.execPath, ['--require', guard, '-e', code], {
      encoding: 'utf8',
      timeout: 5000,
      env: { PATH: '/usr/bin:/bin', HOME: directory, E0_GUARD_CONFIG: configFile },
    })
    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      values: [true, false, false, false, false, false],
      expired: true,
    })
    return { compilerAckBindingAndDeadlineChecked: true }
  }
  if (section === 'http-observer') {
    let started = false
    let acknowledged = false
    const actual = await observingHTTP({
      work: async () => {
        started = true
        await new Promise((resolve) => setTimeout(resolve, 30))
        return acknowledged
      },
      observer: () => {
        if (started) acknowledged = true
      },
      cancel: () => {},
      pollMs: 1,
    })
    assert.equal(actual, true, 'The HTTP wait must continue observing and acknowledge a compiler.')
    let cancelled = false
    await assert.rejects(
      observingHTTP({
        work: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
        },
        observer: () => {
          throw new Error('injected poll failure')
        },
        cancel: () => {
          cancelled = true
        },
        pollMs: 1,
      }),
      /observer/,
    )
    assert.equal(cancelled, true)
    return { httpWaitKeepsObserverActive: true, observerFailureIsControlled: true }
  }
  if (section === 'detached-policy') {
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E0-policy-')))
    const configFile = path.join(directory, 'guard.json')
    writeFileSync(configFile, JSON.stringify({ logs: directory, protectedRoots: [] }))
    const code = `const {allowsNextTypeScriptDetached:f}=require(${JSON.stringify(guard)});const policy={node:'/PIN/node',script:'/OWNED/typescript/lib/tsc.js',cwd:'/OWNED/app',uid:7,callers:['/OWNED/next/runTypeScriptCli.js']};const valid={node:policy.node,script:policy.script,cwd:policy.cwd,uid:7,shell:false,method:'spawn',caller:policy.callers[0]};console.log(JSON.stringify([valid,{...valid,script:'/outside/tsc.js'},{...valid,cwd:'/outside'},{...valid,shell:true},{...valid,caller:'/outside/caller.js'}].map(request=>f({policy,request}))));`
    const result = spawnSync(process.execPath, ['--require', guard, '-e', code], {
      encoding: 'utf8',
      timeout: 5000,
      env: { PATH: '/usr/bin:/bin', HOME: directory, E0_GUARD_CONFIG: configFile },
    })
    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.stdout.trim()), [true, false, false, false, false])
    return { onlyCanonicalNextTypeScriptDetachedAllowed: true }
  }
  if (section === 'detached-groups') {
    const policy = { node: '/PIN/node', script: '/OWNED/tsc.js' }
    const event = {
      event: 'child',
      pid: 100,
      child: 200,
      node: true,
      detached: true,
      scope: 'next-typescript-cli',
      nodeCanonical: policy.node,
      scriptCanonical: policy.script,
      kernel: { pid: 200, ppid: 100, pgid: 200, uid: 7, birth: 'birth-a' },
    }
    const groups = collectOwnedGroups({
      initialPGID: 100,
      uid: 7,
      knownPIDs: new Set([100, 200]),
      events: [event],
      policy,
    })
    assert.deepEqual([...groups], [100, 200])
    assert.throws(
      () =>
        collectOwnedGroups({
          initialPGID: 100,
          uid: 7,
          knownPIDs: new Set([100, 200]),
          events: [{ ...event, kernel: { ...event.kernel, uid: 8 } }],
          policy,
        }),
      /identity/,
    )
    assert.throws(
      () =>
        assertNodeEvidence({
          nodePids: [100, 200],
          events: [
            { event: 'handshake', pid: 100 },
            { event: 'native-probe', pid: 100, normal: true, env: true, oldData: true },
          ],
        }),
      /200/,
    )
    assert.equal(
      maySignalGroup({ members: [{ state: 'Z' }] }),
      false,
      'Zombie groups must be reaped rather than signaled.',
    )
    assert.equal(maySignalGroup({ members: [{ state: 'S' }] }), true)
    assert.throws(
      () =>
        assertProcessIdentity({
          recorded: { uid: 7, birth: 'birth-a' },
          current: { uid: 7, birth: 'birth-b' },
        }),
      /identity/,
    )
    return { detachedGroupsStayOwned: true, missingGuardRejected: true, zombieNotSignaled: true }
  }
  if (section === 'cleanup') {
    const error = Object.assign(new Error('Owned signal failed.'), { code: 'EPERM' })
    const gone = { error, groupMembers: [], alivePIDs: [], portOwners: [] }
    assert.doesNotThrow(
      () => assertSignalRaceExited(gone),
      'EPERM with confirmed exited ownership needs a recorded race outcome.',
    )
    for (const key of ['groupMembers', 'alivePIDs', 'portOwners'])
      assert.throws(() => assertSignalRaceExited({ ...gone, [key]: [100] }), /signal/)
    const evidence = attemptEvidence({
      processInfo: {
        name: 'next-1',
        output: 'actual startup reason',
        pgid: 100,
        pids: new Set([100]),
        nodePids: new Set([100]),
        signalErrors: [{ code: 'EPERM' }],
      },
      snapshot: { cleanupError: 'EPERM' },
    })
    assert.equal(
      evidence.output,
      'actual startup reason',
      'A cleanup exception must not erase startup output.',
    )
    assert.equal(evidence.cleanupError, 'EPERM')
    return { signalRaceRequiresAllGone: true, startupOutputRetained: true }
  }
  if (section === 'process-kind') {
    assert.equal(
      isNodeProcess({
        command: '/OWNED/source/node_modules/.pnpm/@esbuild+darwin-arm64/bin/esbuild',
      }),
      false,
    )
    assert.equal(isNodeProcess({ command: '/TOOLCHAIN/bin/node' }), true)
    assert.equal(isNodeProcess({ command: 'next-server (v16.4.2)' }), true)
    assert.equal(isNodeProcess({ command: '/usr/bin/nodejs' }), true)
    return { nativePathDoesNotImpersonateNode: true }
  }
  if (section === 'ready-resume') {
    const state = {
      report: {
        directory: '/OWNED',
        mirror: '/OWNED/source',
        status: 'failed',
        commands: [{ name: 'core-init', exit: 0 }],
        cleanup: [{ groupExited: true, portClosed: true }],
      },
      directory: '/OWNED',
      manifest: [],
      expectedFiles: [],
      sourceHashes: {},
      actualHashes: {},
      hasTarget: true,
      readyTarget: true,
    }
    assert.doesNotThrow(
      () => assertResumeState(state),
      'An explicitly owned ready target needs a non-initializing recovery path.',
    )
    assert.throws(() => assertResumeState({ ...state, readyTarget: false }), /target/)
    assert.throws(
      () =>
        assertResumeState({
          ...state,
          report: { ...state.report, commands: [{ name: 'core-init', exit: 1 }] },
        }),
      /initialization/,
    )
    return { readyRecoveryDoesNotInitializeAgain: true }
  }
  if (section === 'derived-tooling') {
    const integrity = `sha512-${'A'.repeat(86)}==`
    const originalManifest = { devDependencies: { '@types/minimist': '1.2.5' } }
    const originalLock = `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    devDependencies:\n      '@types/minimist':\n        specifier: 1.2.5\n        version: 1.2.5\n\n  apps/heymoro:\n    dependencies: {}\n\npackages:\n\n  '@types/minimist@1.2.5':\n    resolution: {integrity: ${integrity}}\n\nsnapshots:\n\n  '@types/minimist@1.2.5': {}\n`
    const descriptor = deriveToolingDescriptor({ originalLock, originalManifest })
    assert(descriptor.manifest, 'Derived single-package manifest is absent.')
    assert.equal(descriptor.manifest.devDependencies['@types/minimist'], '1.2.5')
    assert.equal(descriptor.integrity, integrity)
    assert.equal(descriptor.settings.autoInstallPeers, true)
    assert.deepEqual(descriptor.snapshot, {})
    assert.doesNotThrow(() =>
      assertToolingDescriptor({ descriptor, originalLock, originalManifest }),
    )
    for (const mutation of [
      { ...descriptor, integrity: `sha512-${'B'.repeat(86)}==` },
      {
        ...descriptor,
        manifest: { ...descriptor.manifest, devDependencies: { '@types/minimist': '1.2.6' } },
      },
      { ...descriptor, snapshot: { dependencies: { unexpected: '1.0.0' } } },
      { ...descriptor, settings: { ...descriptor.settings, autoInstallPeers: false } },
    ]) {
      assert.throws(
        () => assertToolingDescriptor({ descriptor: mutation, originalLock, originalManifest }),
        /descriptor/,
      )
    }
    assert.throws(
      () =>
        deriveToolingDescriptor({
          originalManifest,
          originalLock: originalLock.replace(
            "'@types/minimist@1.2.5': {}",
            "'@types/minimist@1.2.5':\n    dependencies:\n      unexpected: 1.0.0",
          ),
        }),
      /snapshot/,
    )
    assert(!networkPolicy({ stage: 'root-tooling-build' }).includes('remote'))
    return { singleLockedTypePackage: true, tamperingRejected: true }
  }
  if (section === 'source-footprint') {
    const mirror = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E0-source-size-')))
    mkdirSync(path.join(mirror, 'src'))
    mkdirSync(path.join(mirror, 'dist'))
    mkdirSync(path.join(mirror, 'node_modules'))
    writeFileSync(path.join(mirror, 'src/a.ts'), 'x')
    writeFileSync(path.join(mirror, 'dist/generated.js'), 'xx')
    writeFileSync(path.join(mirror, 'node_modules/owned-synthetic.bin'), 'xxx')
    assert.equal(
      sourceBytes({ mirror, files: ['src/a.ts'] }),
      1,
      'Source bytes must exclude non-manifest artifacts and dependencies.',
    )
    assert.equal(measureFootprint({ directory: mirror }).logicalBytes, 6)
    return { manifestSourceBytes: 1, wholeMirrorLogicalBytes: 6 }
  }
  if (section === 'tooling') {
    assert.deepEqual(parseLockedResolution({ resolution: '19.3.1(react@19.3.1)' }), {
      version: '19.3.1',
      peers: [{ name: 'react', resolution: '19.3.1' }],
    })
    const valid = {
      mirror: '/OWNED/source',
      canonical:
        '/OWNED/source/payload/node_modules/.pnpm/@types+node@24.12.3/node_modules/@types/node',
      version: '24.12.3',
      expectedVersion: '24.12.3',
    }
    assert.doesNotThrow(() => assertNodeTypesTarget(valid))
    assert.throws(() => assertNodeTypesTarget({ ...valid, version: '24.0.0' }), /version/)
    assert.throws(
      () => assertNodeTypesTarget({ ...valid, canonical: '/original/node_modules/@types/node' }),
      /owned/,
    )
    assert.throws(
      () =>
        assertNodeTypesTarget({
          ...valid,
          canonical: '/OWNED/source-other/node_modules/@types/node',
        }),
      /owned/,
    )
    return { nodeToolingVersionAndOwnershipChecked: true }
  }
  if (section === 'continuation') {
    const commands = [
      { name: 'sdk-install', exit: 0 },
      { name: 'sdk-build', exit: 0 },
      { name: 'payload-install', exit: null },
    ]
    assert.deepEqual(pendingPreparationStages({ commands, sdkVerified: true }), ['payload-install'])
    assert.deepEqual(pendingPreparationStages({ commands, sdkVerified: false }), [
      'sdk-install',
      'sdk-build',
      'payload-install',
    ])
    return { completedSDKRequiresAttestation: true }
  }
  if (section === 'provenance') {
    const mirror = '/OWNED/source'
    const actual = path
      .normalize(
        fileURLToPath(
          new URL(
            '../../../../../../',
            `file://${mirror}/payload/apps/heymoro/src/creation/runtime/config.ts`,
          ),
        ),
      )
      .replace(/\/$/, '')
    assert.equal(
      expectedProvenanceRoot({ mirror }),
      actual,
      'Expected provenance must match the unchanged six-parent URL source contract.',
    )
    return { provenanceRoot: actual }
  }
  if (section === 'network') {
    for (const stage of [
      'core-init',
      'sdk-build',
      'framework-types',
      'next-1',
      'next-2',
      'rsync-copy',
    ]) {
      assert(
        !networkPolicy({ stage }).includes('remote'),
        'A non-install stage opened public networking.',
      )
      assert(
        !networkPolicy({ stage }).includes('mDNSResponder'),
        'A non-install stage opened the DNS resolver socket.',
      )
    }
    assert(
      networkPolicy({ stage: 'sdk-install' }).includes('*:443'),
      'Install HTTPS policy absent.',
    )
    assert(
      networkPolicy({ stage: 'payload-install' }).includes('*:53'),
      'Install DNS policy absent.',
    )
    assert(
      networkPolicy({ stage: 'sdk-install' }).includes('/private/var/run/mDNSResponder'),
      'The exact install-only DNS resolver socket is missing.',
    )
    return { publicNetworkRestrictedToInstall: true }
  }
  if (section === 'footprint') {
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E0-footprint-')))
    writeFileSync(path.join(directory, 'one-byte.txt'), 'x')
    const footprint = measureFootprint({ directory })
    assert.equal(footprint.logicalBytes, 1)
    assert(footprint.diskAllocatedBytes >= 512, 'Logical byte count is not actual disk usage.')
    return footprint
  }
  if (!section || section === 'source') {
    assert(
      files.includes('payload/packages/payload/src/uploads/getFileByPath.ts'),
      'Real uploads source was swallowed as an artifact.',
    )
    assert(
      files.includes('payload/tools/assets.d.ts'),
      'Exact base tsconfig asset declarations are missing.',
    )
    assert(
      files.includes('ai-engine/pnpm-workspace.yaml'),
      'The SDK lock settings configuration is missing.',
    )
  }
  const events = [
    { event: 'child', pid: 100, child: 200, node: true },
    { event: 'child', pid: 200, child: 300, node: true },
  ]
  const ownership = processClosure({ pids: [100], nodePids: [100], events, processes: [] })
  if (!section || section === 'pid') assert.deepEqual([...ownership.pids].sort(), [100, 200, 300])
  assert.throws(() => assertNodeEvidence({ nodePids: ownership.nodePids, events: [] }), /handshake/)
  const fullEvents = [...ownership.nodePids].flatMap((pid) => [
    { pid, event: 'handshake' },
    { pid, event: 'native-probe', normal: true, env: true, oldData: true },
  ])
  assert.doesNotThrow(() =>
    assertNodeEvidence({ nodePids: ownership.nodePids, events: fullEvents }),
  )
  assert.throws(
    () =>
      assertNodeEvidence({
        nodePids: ownership.nodePids,
        events: fullEvents.filter((event) => event.pid !== 300),
      }),
    /handshake/,
  )
  assert.throws(
    () => assertNodeEvidence({ nodePids: [300], events: [{ pid: 300, event: 'handshake' }] }),
    /native/,
  )
  const ppidClosure = processClosure({
    pids: [100],
    nodePids: [100],
    events: [],
    processes: [
      { pid: 300, ppid: 200, command: 'node' },
      { pid: 200, ppid: 100, command: 'node' },
    ],
  })
  assert.deepEqual([...ppidClosure.pids].sort(), [100, 200, 300])
  if (!section || section === 'resume') {
    const state = {
      report: {
        directory: '/owned',
        mirror: '/owned/source',
        status: 'failed',
        runtimeBytes: 13405518,
        commands: [{ name: 'sdk-install', exit: 1 }],
        cleanup: [{ groupExited: true, portClosed: true }],
      },
      directory: '/owned',
      manifest: ['src/a.ts'],
      expectedFiles: ['src/a.ts', 'src/uploads/b.ts'],
      sourceHashes: { 'src/a.ts': 'a' },
      actualHashes: { 'src/a.ts': 'a' },
      hasTarget: false,
    }
    assert.doesNotThrow(
      () => assertResumeState(state),
      'Preparation failure with a populated copy must remain resumable.',
    )
    assert.throws(
      () => assertResumeState({ ...state, report: { ...state.report, cleanupUnconfirmed: true } }),
      /cleanup/i,
      'Historical successful cleanup must not hide an unconfirmed newer attempt.',
    )
    assert.throws(
      () => assertResumeState({ ...state, actualHashes: { 'src/a.ts': 'changed' } }),
      /changed/,
    )
    assert.throws(() => assertResumeState({ ...state, hasTarget: true }), /target/)
    assert.throws(() => assertResumeState({ ...state, directory: '/other' }), /owned/)
    await assert.rejects(
      createFixture(),
      /Explicit owned directory/,
      'Default execution must not create another source copy.',
    )
  }
  if (!section) {
    for (const extra of ['network', 'footprint', 'provenance'])
      await fixtureChecks({ section: extra })
  }
  return {
    sourceFiles: files.length,
    transitivePIDs: [...ownership.pids],
    missingHandshakeRejected: true,
    resumeValidated: true,
  }
}

async function run() {
  const negative =
    process.argv[3] === '--new' ? isolationChecks() : { reusedPriorOwnedIsolationProof: true }
  const {
    createFixture,
    reattestReadyTarget,
    finalizeFixture,
    healthRound,
    hostConfiguration,
    isolationProof,
    prepareMirror,
    sourceAllowlist,
  } = await import('./next-http-fixture.mjs')
  const files = sourceAllowlist()
  assert(files.length > 1000)
  assert(
    !files.some((filename) =>
      filename.split('/').some((part) => /^(?:\.env|\.data|\.next|node_modules)/i.test(part)),
    ),
  )
  const config = hostConfiguration({ dataDir: '/synthetic-only/not-created', port: 12345 })
  for (const provider of ['execution', 'quote', 'image', 'naming'])
    assert.equal(config[provider], null)
  assert.equal(config.identity.wechat, null)
  assert.equal(config.identity.trial, null)
  assert(
    process.argv[3],
    'Explicit existing owned directory or --new required; no automatic second source copy.',
  )
  const fixture = await createFixture({
    resume: process.argv[3] === '--new' ? undefined : process.argv[3],
    allowNew: process.argv[3] === '--new',
    readyTarget: ['--ready-run', '--verify-existing'].includes(process.argv[2]),
    verifyExisting: process.argv[2] === '--verify-existing',
  })
  console.log(JSON.stringify({ evidence: fixture.reportFile, negative }))
  let failure
  try {
    if (!fixture.report.isolation?.nativeProbe) await isolationProof({ fixture: fixture })
    if (fixture.readyTarget) await reattestReadyTarget({ fixture })
    else await prepareMirror({ fixture, install: process.argv[2] !== '--prepare-only' })
    if (process.argv[2] !== '--prepare-only') {
      await healthRound({ fixture: fixture, round: 1 })
      await healthRound({ fixture: fixture, round: 2 })
    }
  } catch (error) {
    failure = error
  }
  try {
    await finalizeFixture({ fixture: fixture, error: failure })
  } catch (error) {
    failure = error
  }
  console.log(
    JSON.stringify({
      status: fixture.report.status,
      evidence: fixture.reportFile,
    }),
  )
  if (failure) throw failure
  if (process.argv[2] === '--prepare-only') return
  const evidence = JSON.parse(readFileSync(fixture.reportFile, 'utf8'))
  assert.equal(evidence.rounds.length, 2)
  assert.equal(evidence.status, 'passed')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--isolation-check') console.log(JSON.stringify(isolationChecks()))
  else if (process.argv[2] === '--fixture-check')
    console.log(JSON.stringify(await fixtureChecks({ section: process.argv[3] })))
  else if (
    ['--run', '--prepare-only', '--ready-run', '--verify-existing'].includes(process.argv[2])
  )
    await run()
  else throw new Error('Expected --isolation-check, --fixture-check, --prepare-only, or --run.')
}
