import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import {
  attachE2Lifecycle,
  finalizeE2Leases,
  hostConfiguration,
  initializeE2Target,
  node,
  observeE2Leases,
  runE2Worker,
  startE2Next,
  stopE2Next,
} from './next-http-fixture.mjs'
import { businessRoundOne, businessRoundTwo, recordE2Assertion } from './next-business-http.mjs'
import {
  assertE2Initialization,
  assertE2DatasetReceipt,
  assertMissingE2Leaf,
  assertE2Binding,
  e2ModeAction,
  assertE2Success,
  E2_DIRECTORY,
} from './next-http-e2-profile.mjs'
import {
  assertE2RunAuthority,
  assertInitializedProfile,
  readE2ReadyBinding,
  kernelPolicySHA,
  manifestSHA,
  assertE2AuthorityLocator,
  E2_SOURCE_ROOT,
  materializeE2Revision,
  newE2Epoch,
  readE2Authority,
  readJSON,
  shaBytes,
  shaFile,
  verifyHashMap,
  verifyParents,
  writeNewJSON,
} from './next-http-e2-revision.mjs'

/** Gate A preparation never imports the typed host or opens the ready DB. */
export async function prepareE2Epoch({ mode = 'business', authorityFile, authoritySHA } = {}) {
  e2ModeAction({ mode })
  assert.equal(process.execPath, node)
  const revision = materializeE2Revision({ authorityFile, authoritySHA })
  const binding = assertE2Binding({ binding: revision.authority })
  if (mode === 'initialize') assertMissingE2Leaf({ filename: binding.targetDir })
  const ready =
    mode === 'business'
      ? readE2ReadyBinding({
          authority: revision.authority,
          authorityFile,
          authoritySHA: revision.authoritySHA,
        })
      : null
  const epoch = newE2Epoch({ revision, mode })
  const { startRedisFixture } = await import('./redis-fixture.ts')
  const { startS3HTTPFixture } = await import('./s3-http-fixture.ts')
  let redis
  let s3
  try {
    redis = await startRedisFixture()
    s3 = await startS3HTTPFixture()
    const ports = {
      redis: redis.port,
      s3: Number(new URL(s3.endpoint).port),
      next: await freePort(),
    }
    const jsonFile = path.join(epoch.epochRoot, 'core-e2.json')
    const config = configuration({
      targetDir: binding.targetDir,
      ports,
      endpoint: s3.endpoint,
      redisURL: redis.url,
      verificationId: epoch.verificationId,
    })
    writeNewJSON({ filename: jsonFile, value: config })
    const codes = { owner: `e2-owner-${randomUUID()}`, foreign: `e2-foreign-${randomUUID()}` }
    const datasetOwnerFile = binding.datasetOwnerFile
    const control = {
      ...binding,
      authorityFile,
      sourceManifestSHA: revision.authority.sourceManifestSHA,
      kernelPolicySHA: '',
      mode,
      ready,
      authoritySHA: revision.authoritySHA,
      initializationFile: path.join(epoch.epochRoot, 'initialization.json'),
      format: 2,
      profileId: 'e2-local',
      revisionId: revision.authority.revisionId,
      verificationId: epoch.verificationId,
      jsonFile,
      jsonSHA: shaFile({ filename: jsonFile }),
      targetFingerprint: revision.authority.targetFingerprint,
      rounds: ['2026-11-13T12:00:00.000Z', '2026-11-13T12:02:00.000Z'],
      codes: {
        [codes.owner]: `e2-open-owner-${randomUUID()}`,
        [codes.foreign]: `e2-open-foreign-${randomUUID()}`,
      },
      journalDirectory: path.join(epoch.epochRoot, 'journal'),
      snapshotDirectory: path.join(epoch.epochRoot, 'snapshots'),
      datasetOwnerFile,
      datasetConfigSHA: shaBytes({
        bytes: JSON.stringify({
          revisionId: revision.authority.revisionId,
          authoritySHA,
          sourceManifestSHA: revision.authority.sourceManifestSHA,
          hostCaps: config.hostCaps,
          execution: config.execution,
          recipe: 'e2-red-blue-3x2-png-v1',
        }),
      }),
      admin: {
        email: `e2-${revision.authority.revisionId}@local.invalid`,
        password: randomBytes(24).toString('base64url'),
      },
    }
    const controlFile = path.join(epoch.epochRoot, 'control.json')
    const nativeProbe = {
      normal: path.join(epoch.epochRoot, 'synthetic', 'normal.sqlite'),
      env: path.join(epoch.epochRoot, 'synthetic', '.env.native.sqlite'),
      oldData: path.join(epoch.epochRoot, 'synthetic', '.data', 'native.sqlite'),
    }
    for (const filename of Object.values(nativeProbe)) {
      const database = new DatabaseSync(filename)
      database.exec('CREATE TABLE owned_probe (id INTEGER); INSERT INTO owned_probe VALUES (73)')
      database.close()
    }
    for (const name of ['sealed-authority-probe.json', 'sealed-control-probe.json'])
      writeNewJSON({
        filename: path.join(epoch.epochRoot, 'synthetic', name),
        value: { probe: 'owned-synthetic' },
      })
    const guardConfig = path.join(epoch.epochRoot, 'guard-e2.json')
    const protectedRoots = [
      E2_SOURCE_ROOT,
      ...revision.authority.oldTargets,
      ...revision.authority.historicalDirectories,
      path.join(E2_DIRECTORY, 'source/payload/node_modules'),
      path.join(E2_DIRECTORY, 'source/ai-engine/node_modules'),
      '/Users/nako/Library/pnpm/store',
      path.join(E2_DIRECTORY, 'pnpm-store'),
    ]
    const oldDataRoots = [
      ...revision.authority.oldTargets,
      path.join(epoch.epochRoot, 'synthetic', '.data'),
    ]
    const immutablePaths = [
      path.join(epoch.epochRoot, 'gate-b.json'),
      path.join(epoch.epochRoot, 'gate-b-request.json'),
      path.join(epoch.epochRoot, 'synthetic', 'sealed-authority-probe.json'),
      path.join(epoch.epochRoot, 'synthetic', 'sealed-control-probe.json'),
      ...(mode === 'business' ? [binding.readyFile, `${binding.targetDir}/profile.json`] : []),
      ...(ready
        ? ['jsonFile', 'controlFile', 'initializationFile', 'reportFile'].map(
            (key) => readJSON({ filename: binding.readyFile })[key],
          )
        : []),
      ...(ready ? [readJSON({ filename: binding.readyFile }).attest.evidenceFile] : []),
      ...(revision.immutableProofFiles || []),
      authorityFile,
      revision.ownerFile,
      jsonFile,
      controlFile,
      guardConfig,
      datasetOwnerFile,
      ...Object.keys(revision.actualManifest)
        .filter((filename) => filename !== 'payload/apps/heymoro/next-env.d.ts')
        .map((filename) => path.join(E2_DIRECTORY, 'source', filename)),
      ...Object.keys(revision.authority.historicalProofs),
    ]
    const kernelPolicy = {
      writeRoot: binding.writeRoot,
      ports,
      protectedRoots,
      oldDataRoots,
      immutablePaths: [...new Set(immutablePaths)],
    }
    control.kernelPolicySHA = kernelPolicySHA({ kernelPolicy })
    writeNewJSON({ filename: controlFile, value: control })
    const report = {
      profileId: 'e2-local',
      mode,
      assertionVersion: 1,
      assertions: {},
      verificationId: epoch.verificationId,
      authoritySHA: revision.authoritySHA,
      ...binding,
      authorityFile,
      sourceManifestSHA: revision.authority.sourceManifestSHA,
      frozenSource: revision.actualManifest,
      frozenSourceSHA: manifestSHA({ manifest: revision.actualManifest }),
      parentPassedReportSHA:
        revision.authority.historicalProofs[`${E2_DIRECTORY}/proof/report.json`],
      status: 'prepared-only',
      rounds: [],
      commands: [],
      cleanup: [],
      httpTraces: [],
      activeLeases: [],
      cleanupUnconfirmed: false,
      limitations: {
        isolationScope:
          'product child sandbox only; controller and Redis/S3 fixtures have independent cleanup',
        coldBuild: false,
        coldServices: false,
        s3: 'in-memory HTTP object fixture; not MinIO persistence',
        models: 'synthetic zero-fee; not paid model quality',
      },
    }
    const fixture = {
      directory: E2_DIRECTORY,
      mirror: path.join(E2_DIRECTORY, 'source'),
      app: path.join(E2_DIRECTORY, 'source/payload/apps/heymoro'),
      provenanceRoot: path.join(E2_DIRECTORY, 'source'),
      dataDir: config.dataDir,
      jsonFile,
      guardConfig,
      port: ports.next,
      config: {
        logs: path.join(epoch.epochRoot, 'logs'),
        protectedRoots,
        oldDataRoots,
        nativeProbe,
        expectedJSON: jsonFile,
      },
      report,
      reportFile: path.join(epoch.epochRoot, 'report.json'),
      current: null,
      e2: {
        profileId: 'e2-local',
        epochRoot: epoch.epochRoot,
        ports,
        codes,
        control,
        controlFile,
        journalDirectory: control.journalDirectory,
        snapshotDirectory: control.snapshotDirectory,
        ackDirectory: path.join(epoch.epochRoot, 'compiler-acks'),
        actualManifest: revision.actualManifest,
        kernelPolicy,
        authority: revision.authority,
        frozenInputs: {},
      },
    }
    writeNewJSON({ filename: fixture.reportFile, value: report })
    writeNewJSON({ filename: guardConfig, value: fixture.config })
    attachE2Lifecycle({ fixture })
    fixture.e2.frozenInputs = Object.fromEntries(
      immutablePaths.filter(existsSync).map((filename) => [filename, shaFile({ filename })]),
    )
    writeNewJSON({
      filename: path.join(epoch.epochRoot, 'gate-b-request.json'),
      value: {
        format: 3,
        approvedBy: 'root',
        authorityFile,
        binding: {
          ...binding,
          sourceManifestSHA: revision.authority.sourceManifestSHA,
          targetFingerprint: revision.authority.targetFingerprint,
        },
        kernelPolicySHA: control.kernelPolicySHA,
        action: e2ModeAction({ mode }),
        verificationId: epoch.verificationId,
        authoritySHA: revision.authoritySHA,
        ports,
        frozenInputs: fixture.e2.frozenInputs,
      },
    })
    persist({ fixture })
    return { fixture, redis, s3 }
  } catch (error) {
    const results = await Promise.allSettled([redis?.stop(), s3?.close()])
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        'Preparation and owned service cleanup failed.',
      )
    throw error
  }
}
export async function runE2Epoch({ fixture }) {
  assertE2RunAuthority({ fixture })
  let failure
  try {
    if (fixture.e2.control.mode === 'initialize') {
      const initializer = await initializeE2Target({ fixture })
      const profile = assertInitializedProfile({ fixture })
      const profileSHA = shaFile({ filename: `${fixture.dataDir}/profile.json` })
      writeNewJSON({
        filename: fixture.e2.control.initializationFile,
        value: {
          format: 2,
          authorityFile: fixture.e2.control.authorityFile,
          authoritySHA: fixture.report.authoritySHA,
          controlSHA: shaFile({ filename: fixture.e2.controlFile }),
          verificationId: fixture.report.verificationId,
          jsonSHA: fixture.e2.control.jsonSHA,
          targetDir: fixture.dataDir,
          revisionId: fixture.e2.control.revisionId,
          sourceManifestSHA: fixture.e2.control.sourceManifestSHA,
          profileSHA,
          profileNonce: profile.nonce,
          targetFingerprint: profile.fingerprint,
          initializer: { commandId: initializer.commandId, exit: 0 },
        },
      })
      fixture.report.initializationFile = fixture.e2.control.initializationFile
      fixture.report.initializationSHA = shaFile({
        filename: fixture.e2.control.initializationFile,
      })
      fixture.report.profileSHA = profileSHA
      fixture.report.profileNonce = profile.nonce
      fixture.report.targetDir = fixture.dataDir
    }
    await runE2Worker({ fixture, role: 'attest' })
    const attestationFile = path.join(
      fixture.e2.journalDirectory,
      (await import('node:fs'))
        .readdirSync(fixture.e2.journalDirectory)
        .find((name) => /^attest-[0-9]+[.]jsonl$/.test(name)),
    )
    const attestation = JSON.parse(readFileSync(attestationFile, 'utf8').trim())
    assert.equal(attestation.event, 'ready')
    const proofNames = [
      'sealedNode',
      'sealedNative',
      'publicOutbound',
      'unregisteredLoopback',
      'workerBind',
      'nativeEnv',
    ]
    for (const name of proofNames) assert.equal(attestation.details[name], 1)
    fixture.report.kernelIsolationProof = Object.fromEntries(proofNames.map((name) => [name, true]))
    if (fixture.e2.control.mode === 'initialize') {
      fixture.report.attestEvidenceFile = attestationFile
      fixture.report.attestEvidenceSHA = shaBytes({ bytes: JSON.stringify(attestation) })
      assert.equal(attestation.verificationId, fixture.report.verificationId)
      assert.equal(attestation.details.targetFingerprint, fixture.e2.control.targetFingerprint)
      assertInitializedProfile({ fixture })
      assert.equal(
        shaFile({ filename: `${fixture.dataDir}/profile.json` }),
        fixture.report.profileSHA,
      )
    } else {
      recordE2Assertion({
        fixture,
        id: 'readyShape',
        evidence: {
          targetFingerprint: fixture.e2.control.targetFingerprint,
          initialized: false,
          readySHA: fixture.e2.control.ready.readySHA,
        },
      })
      await runE2Worker({ fixture, role: 'seed' })
      const ownerFile = fixture.e2.control.datasetOwnerFile
      const candidateFile = path.join(fixture.e2.snapshotDirectory, 'dataset-candidate.json')
      const dataset = readJSON({ filename: existsSync(ownerFile) ? ownerFile : candidateFile })
      assertE2DatasetReceipt({ dataset, control: fixture.e2.control })
      if (!existsSync(ownerFile))
        writeFileSync(ownerFile, readFileSync(candidateFile), { flag: 'wx', mode: 0o600 })
      fixture.e2.datasetOwnerSHA = shaFile({ filename: ownerFile })
      fixture.report.datasetOwnerSHA = fixture.e2.datasetOwnerSHA
      recordE2Assertion({
        fixture,
        id: 'datasetOwnership',
        evidence: {
          ownerSHA: fixture.e2.datasetOwnerSHA,
          revisionId: dataset.revisionId,
          readbackSHA: dataset.readbackSHA,
        },
      })
      const sharp = (await import('sharp')).default
      const pngs = await Promise.all(
        ['red', 'blue'].map((background) =>
          sharp({ create: { background, channels: 3, height: 2, width: 3 } })
            .png()
            .toBuffer(),
        ),
      )
      let state
      for (const round of [1, 2]) {
        const next = startE2Next({ fixture, round })
        try {
          await waitForOwnedNext({ fixture, processInfo: next })
          if (round === 1) state = await businessRoundOne({ fixture, dataset, pngs })
          else await businessRoundTwo({ fixture, state })
        } finally {
          await stopE2Next({ fixture, processInfo: next, round })
        }
      }
    }
  } catch (error) {
    failure = error
  } finally {
    try {
      await finalizeE2Leases({ fixture })
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'E2 work and cleanup failed.')
        : error
      fixture.report.cleanupUnconfirmed = true
    }
    fixture.report.activeLeases = fixture.e2.leases
      .active()
      .map((lease) => ({ commandId: lease.commandId, pgid: lease.pgid }))
    try {
      const { authority } = readE2Authority({
        authorityFile: fixture.e2.control.authorityFile,
        authoritySHA: fixture.e2.control.authoritySHA,
      })
      verifyParents({
        authority,
        authorityFile: fixture.e2.control.authorityFile,
        authoritySHA: fixture.e2.control.authoritySHA,
      })
      verifyHashMap({ root: fixture.mirror, files: fixture.e2.actualManifest })
      for (const [filename, sha] of Object.entries(fixture.e2.frozenInputs))
        assert.equal(shaFile({ filename }), sha)
      if (fixture.e2.datasetOwnerSHA)
        assert.equal(
          shaFile({ filename: fixture.e2.control.datasetOwnerFile }),
          fixture.e2.datasetOwnerSHA,
        )
      // Success remains pending until the outer runner closes and checks Redis/S3 too.
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'E2 evidence protection failed.')
        : error
    }
    fixture.report.status = failure ? 'failed' : 'awaiting-service-cleanup'
    fixture.report.error = failure
      ? { name: failure.name, message: failure.message.slice(0, 500) }
      : null
    persist({ fixture })
  }
  if (failure) throw failure
  return fixture.reportFile
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseE2CLI({ args: process.argv.slice(2) })
  const { mode } = options
  const owned = await prepareE2Epoch(options)
  let error
  try {
    await gateBInput({ fixture: owned.fixture })
    await runE2Epoch({ fixture: owned.fixture })
  } catch (failure) {
    error = failure
  } finally {
    const results = await Promise.allSettled([
      finalizeE2Leases({ fixture: owned.fixture }),
      owned.redis.stop(),
      owned.s3.close(),
    ])
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length)
      error = new AggregateError(
        [...(error ? [error] : []), ...failures],
        'E2 finalization failed.',
      )
    if (!error) {
      try {
        for (const port of Object.values(owned.fixture.e2.ports)) await assertClosedPort({ port })
        readE2Authority({
          authorityFile: options.authorityFile,
          authoritySHA: options.authoritySHA,
        })
        verifyHashMap({ root: owned.fixture.mirror, files: owned.fixture.e2.actualManifest })
        owned.fixture.report.servicesClosed = true
        if (mode === 'initialize') {
          owned.fixture.report.status = 'initialized-awaiting-root'
          assertE2Initialization({ report: owned.fixture.report })
        } else {
          assertE2Success({
            report: owned.fixture.report,
            jsonFile: owned.fixture.jsonFile,
            sourceRoot: owned.fixture.provenanceRoot,
          })
          owned.fixture.report.status = 'passed'
        }
        persist({ fixture: owned.fixture })
      } catch (failure) {
        error = failure
      }
    }
    if (error) {
      owned.fixture.report.status = 'failed'
      owned.fixture.report.cleanupUnconfirmed ||= failures.length > 0
      owned.fixture.report.error = { name: error.name, message: error.message.slice(0, 500) }
      persist({ fixture: owned.fixture })
    }
  }
  if (error) throw error
  process.stdout.write(
    `${JSON.stringify({ status: owned.fixture.report.status, reportFile: owned.fixture.reportFile })}\n`,
  )
}

async function assertClosedPort({ port }) {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}
function configuration({ targetDir, ports, endpoint, redisURL, verificationId }) {
  const value = hostConfiguration({
    dataDir: targetDir,
    port: ports.next,
  })
  value.identity = {
    sessionTtlSeconds: 3600,
    trial: { issuedCredits: 12, validForSeconds: 86400 },
    wechat: {
      appId: 'e2-owned-synthetic',
      appSecret: randomBytes(32).toString('hex'),
      timeoutMs: 100,
      maxResponseBytes: 1024,
    },
  }
  value.redis = { ...value.redis, url: redisURL, namespace: `e2-${verificationId}` }
  value.s3 = {
    ...value.s3,
    backends: [
      {
        backend: 'fixture-metadata',
        endpoint,
        region: 'fixture',
        credentials: { accessKeyId: 'e2-synthetic-access', secretAccessKey: 'e2-synthetic-secret' },
        buckets: ['fixture-input', 'fixture-output'],
        forcePathStyle: true,
      },
    ],
    input: { backend: 'fixture-metadata', bucket: 'fixture-input' },
    output: { backend: 'fixture-metadata', bucket: 'fixture-output' },
  }
  value.execution = {
    registry: {
      'fixture-v1': {
        provider: 'openai',
        model: 'gpt-image-1.5',
        allowedParameters: ['size'],
        parameterRules: { size: { type: 'string', values: ['1024x1024'], isRequired: true } },
        storageBackends: ['fixture-metadata'],
      },
    },
    storageOutput: {
      backend: 'fixture-metadata',
      bucket: 'fixture-output',
      keyRule: 'task-attempt-result-v1',
    },
  }
  value.quote = {
    issuer: 'e2:core',
    audience: 'e2:admission',
    signingKid: 'e2',
    keys: { e2: randomBytes(32).toString('base64url') },
    ttlSeconds: 60,
  }
  value.image = {
    apiKey: 'e2-synthetic-zero-fee',
    timeoutMs: 1000,
    engineBudgetMs: 1000,
    maxInputBytes: 1000,
    maxTotalInputBytes: 1500,
    maxOutputBytes: 100000,
    maxResponseBytes: 200000,
    registered: [{ executorId: 'fixture-v1', provider: 'openai', model: 'gpt-image-1.5' }],
  }
  value.naming = {
    apiKey: 'e2-synthetic-zero-fee',
    timeoutMs: 1000,
    engineBudgetMs: 1000,
    maxInputBytes: 100000,
    maxResponseBytes: 64000,
    registered: {
      provider: 'openai',
      model: 'explicit-fixture-naming-model',
      parameters: { max_output_tokens: 128 },
    },
  }
  return value
}
function persist({ fixture }) {
  const current = readJSON({ filename: fixture.reportFile })
  assert.equal(current.verificationId, fixture.report.verificationId)
  assert.equal(current.authoritySHA, fixture.report.authoritySHA)
  writeFileSync(fixture.reportFile, `${JSON.stringify(fixture.report, null, 2)}\n`, { mode: 0o600 })
}

async function waitForOwnedNext({ fixture, processInfo }) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await observeE2Leases({ fixture })
    const owners = spawnSync(
      '/usr/sbin/lsof',
      ['-nP', `-iTCP:${fixture.port}`, '-sTCP:LISTEN', '-Fp'],
      { encoding: 'utf8', timeout: 3000 },
    )
      .stdout.trim()
      .split('\n')
      .filter((line) => /^p\d+$/.test(line))
      .map((line) => Number(line.slice(1)))
    if (owners.length) {
      assert(owners.every((pid) => processInfo.pids.has(pid)))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('E2 Next bind readiness deadline exceeded.')
}

async function gateBInput({ fixture }) {
  process.stdout.write(
    `${JSON.stringify({ status: 'waiting-root-gate-b', verificationId: fixture.report.verificationId, requestFile: path.join(fixture.e2.epochRoot, 'gate-b-request.json'), approvalFile: path.join(fixture.e2.epochRoot, 'gate-b.json'), timeoutSeconds: 180 })}\n`,
  )
  let timer
  try {
    const received = await Promise.race([
      new Promise((resolve) => {
        process.stdin.setEncoding('utf8')
        process.stdin.once('data', resolve)
        process.stdin.resume()
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Gate B timeout; no run occurred.')), 180_000)
      }),
    ])
    assert.equal(received.trim(), `RUN ${fixture.report.verificationId}`)
    assertE2RunAuthority({ fixture })
  } finally {
    clearTimeout(timer)
    process.stdin.pause()
  }
}

export function parseE2CLI({ args }) {
  assert.equal(args.length, 5, 'Mode plus explicit --authority FILE --authority-sha SHA required.')
  assert(['--prepare-and-wait', '--initialize-and-wait'].includes(args[0]))
  const options = {}
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]
    assert(
      ['--authority', '--authority-sha'].includes(flag) && !Object.hasOwn(options, flag),
      'Unknown or duplicate CLI option.',
    )
    options[flag] = args[index + 1]
  }
  const authorityFile = options['--authority']
  const authoritySHA = options['--authority-sha']
  assertE2AuthorityLocator({ authorityFile, authoritySHA })
  return {
    mode: args[0] === '--initialize-and-wait' ? 'initialize' : 'business',
    authorityFile,
    authoritySHA,
  }
}
