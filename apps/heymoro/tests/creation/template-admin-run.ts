import type { ChildProcess } from 'node:child_process'

import { CreateBucketCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statfsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

import type { Approval } from './template-admin-approval.js'
import type { ProcessIdentity } from './template-admin-runtime-evidence.js'

import { cachedMinIOImage, startMinIOFixture } from './minio-fixture.js'
import { startRedisFixture } from './redis-fixture.js'
import {
  buildConfiguration,
  canonicalNode,
  ownedOutputs,
  verifySourceBinding,
} from './template-admin-approval.js'
import {
  createRuntimeEvidence,
  listeningPIDs,
  processSnapshot,
} from './template-admin-runtime-evidence.js'
import { startS3Observer } from './template-admin-s3-observer.js'

export const OPEN_INTERFACE_GAP = Object.freeze([
  'unknown Error',
  'forged code object',
  'database commit unknown',
])
export type Managed = { close: () => Promise<void> }
export type LifecycleStep = { name: string; open: () => Promise<Managed> }
export async function acquireLifecycle({
  deadline,
  now,
  steps,
}: {
  deadline: number
  now: () => number
  steps: readonly LifecycleStep[]
}) {
  const acquired: Managed[] = []
  const phases: { completed: boolean; elapsedMs: number; name: string }[] = []
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      const failures = await cleanupInReverse({
        resources: acquired.map((resource, index) => ({ ...resource, name: String(index) })),
      })
      if (failures.length) {
        throw Error(`Owned lifecycle cleanup failed (${failures.length}).`)
      }
    })())
  try {
    for (const step of steps) {
      assert(now() < deadline, 'Owned lifecycle deadline exceeded.')
      const start = now()
      try {
        acquired.push(await step.open())
        phases.push({ name: step.name, completed: true, elapsedMs: now() - start })
      } catch {
        phases.push({ name: step.name, completed: false, elapsedMs: now() - start })
        throw Error('Owned lifecycle acquisition failed.')
      }
      assert(now() < deadline, 'Owned lifecycle deadline exceeded.')
    }
    return { close, phases }
  } catch {
    await close().catch(() => undefined)
    throw Error(
      'Owned lifecycle failed; acquired resources were independently closed; preserve target evidence.',
    )
  }
}

export type CommandResult = {
  cleanupCode?: string
  code?: string
  data?: { id: number; role: string; status: string }
  outcome?: string
}
export function requireConfirmed({ result }: { result: CommandResult }) {
  assert(
    result.outcome === 'confirmed' &&
      !result.code &&
      !result.cleanupCode &&
      result.data &&
      Number.isSafeInteger(result.data.id) &&
      result.data.id > 0,
    'Command not cleanly confirmed; STOP without replay.',
  )
  return result.data
}
export async function exerciseRevokedAdmin({
  ports,
}: {
  ports: {
    createB: (args: { token: string }) => Promise<CommandResult>
    disableA: (args: { id: number; token: string }) => Promise<CommandResult>
    exerciseA: () => Promise<void>
    loginA: () => Promise<{ id: number; token: string }>
    loginB: () => Promise<{ id: number; token: string }>
    restoreA: (args: { id: number; token: string }) => Promise<CommandResult>
  }
}) {
  const a = await ports.loginA()
  const bRecord = requireConfirmed({ result: await ports.createB({ token: a.token }) })
  assert(bRecord.role === 'admin' && bRecord.status === 'active' && bRecord.id !== a.id)
  const b = await ports.loginB()
  assert(b.id === bRecord.id && b.token)
  const disabled = requireConfirmed({ result: await ports.disableA({ id: a.id, token: b.token }) })
  assert(disabled.id === a.id && disabled.status === 'disabled')
  // Unknown disable must never enter exercise or restoration; guard B owns any later recovery.
  await ports.exerciseA()
  const restored = requireConfirmed({ result: await ports.restoreA({ id: a.id, token: b.token }) })
  assert(restored.id === a.id && restored.status === 'active')
}

export type OwnedRun = Awaited<ReturnType<typeof startOwnedRun>>

/** No import-time effects. Runtime call requires a fresh root execution approval, not SOURCE_ONLY approval. */
export async function startOwnedRun({
  approval,
  scenario,
}: {
  approval: Approval
  scenario: string
}) {
  assert(approval.scenarios.includes(scenario), 'Scenario not root approved.')
  assert.equal(process.execPath, canonicalNode)
  assert.equal(realpathSync(approval.checkout), approval.checkout)
  assert.equal(realpathSync(approval.node), approval.node)
  assert.equal(realpathSync(approval.browser), approval.browser)
  assert(
    !existsSync(approval.runDirectory),
    'Run directory must be new; preserve prior evidence, never resume.',
  )
  const actual = Object.fromEntries(
    Object.keys(approval.sourceFiles).map((filename) => {
      const full = path.join(approval.checkout, filename)
      assert.equal(realpathSync(full), full)
      return [filename, digest({ bytes: readFileSync(full) })]
    }),
  )
  verifySourceBinding({ actualFiles: actual, approval })
  const app = path.join(approval.checkout, 'apps/heymoro')
  // An env allowlist does not prevent Next dotenv discovery. Reject files by name without reading secrets.
  for (const root of [approval.checkout, app]) {
    assert(
      !readdirSync(root).some((name) => /^\.env(?:\.|$)/.test(name)),
      'Next dotenv discovery is not isolated.',
    )
  }
  const filesystem = statfsSync(path.dirname(approval.runDirectory))
  assert(
    filesystem.bavail * filesystem.bsize >= approval.budget.diskBytes + 1073741824,
    'Disk reserve is insufficient.',
  )
  await mkdir(approval.runDirectory, { mode: 0o700 })
  assertPrivate({ directory: true, filename: approval.runDirectory })
  for (const name of ['home', 'tmp']) {
    await mkdir(path.join(approval.runDirectory, name), { mode: 0o700 })
  }
  const coreFile = path.join(approval.runDirectory, 'core.json')
  const receiptFile = path.join(approval.runDirectory, 'receipt.json')
  const entrySHA = Object.fromEntries(
    [
      'scripts/init-target.mjs',
      'scripts/admin-commands.mjs',
      'src/payload.config.ts',
      'node_modules/next/dist/bin/next',
    ].map((filename) => [filename, digest({ bytes: readFileSync(path.join(app, filename)) })]),
  )
  const credentials = {
    email: `admin-${approval.runId}@example.invalid`,
    password: randomBytes(32).toString('base64url'),
  }
  const guard = {
    email: `guard-${approval.runId}@example.invalid`,
    password: randomBytes(32).toString('base64url'),
  }
  const baseURL = `http://127.0.0.1:${approval.nextPort}`
  const outputs = ownedOutputs({ approval, scenario })
  assert(
    !existsSync(outputs.distDirectory),
    'Next output must be a new owned leaf; no unknown build reuse.',
  )
  const env: NodeJS.ProcessEnv = {
    CI: '1',
    COREPACK_ENABLE_NETWORK: '0',
    HEYMORO_CORE_CONFIG_FILE: coreFile,
    HEYMORO_DIST_DIR: path.relative(app, outputs.distDirectory),
    HOME: path.join(approval.runDirectory, 'home'),
    LANG: 'C',
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_ENV: 'development',
    NODE_OPTIONS: `--max-old-space-size=${Math.min(1536, approval.budget.memoryMiB - 512)}`,
    PATH: `${path.dirname(canonicalNode)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    TMPDIR: path.join(approval.runDirectory, 'tmp'),
  }
  let redis: Awaited<ReturnType<typeof startRedisFixture>>
  let minio: Awaited<ReturnType<typeof startMinIOFixture>>
  let observer: Awaited<ReturnType<typeof startS3Observer>>
  let client: S3Client
  let coreSHA = ''
  let profileSHA = ''
  let profileNonce = ''
  let commandSequence = 0
  let phase = 'setup'
  let minioStart = 0
  let minioID = ''
  let isClosed = false
  let hasNextBudgetFailure = false
  let runtimeEvidence: ReturnType<typeof createRuntimeEvidence> | undefined
  let nextIdentity: ProcessIdentity | undefined
  let productionReceipt: ProductionReceipt | undefined
  const phases: { completed: boolean; elapsedMs: number; name: string }[] = []
  const cleanups: { close: () => Promise<void>; name: string }[] = []
  const cleanupFailures: string[] = []
  const faultEvidence: {
    afterSHA: string
    beforeSHA: string
    column: string
    rowsAffected: number
    templateId: number
    versionId: number
  }[] = []
  const stage = async <T>({ name, operation }: { name: string; operation: () => Promise<T> }) => {
    assert(!isClosed)
    if (minioStart) {
      assert(
        performance.now() - minioStart < approval.budget.durationMs,
        'MinIO run window exhausted.',
      )
    }
    phase = name
    const start = performance.now()
    try {
      const result = await operation()
      phases.push({ name, completed: true, elapsedMs: performance.now() - start })
      return result
    } catch {
      phases.push({ name, completed: false, elapsedMs: performance.now() - start })
      throw Error(`Owned stage failed: ${name}; do not replay.`)
    }
  }
  const saveReceipt = async ({ outcome }: { outcome: string }) => {
    const receipt = {
      budget: approval.budget,
      cleanupFailures,
      coreFile,
      coreSHA,
      cwd: app,
      entrySHA,
      faultEvidence,
      format: 1,
      kind: 'derived-template-admin-receipt',
      limits: { deadlineMs: 30000, fileBytes: 4194304, pixels: 2000000, wireBytes: 4210688 },
      minioID,
      nextIdentity,
      OPEN_INTERFACE_GAP,
      outcome,
      outputs,
      phases,
      productionReceipt,
      profileNonce,
      profileSHA,
      runId: approval.runId,
      runtimeEvidence: runtimeEvidence?.receipt(),
      scenario,
      sourceManifestSHA: approval.sourceManifestSHA,
      storage: observer?.events ?? [],
    }
    await writeFile(receiptFile, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
  }
  const close = async ({ outcome = 'not-accepted' }: { outcome?: string } = {}) => {
    if (isClosed) {
      return
    }
    isClosed = true
    cleanupFailures.push(...(await cleanupInReverse({ resources: cleanups })))
    if (observer?.failed) {
      cleanupFailures.push('observer-incomplete')
    }
    if (hasNextBudgetFailure) {
      cleanupFailures.push('next-log-budget')
    }
    if (minioStart && performance.now() - minioStart > 90000) {
      cleanupFailures.push('minio-full-window')
    }
    try {
      verifySourceBinding({
        actualFiles: Object.fromEntries(
          Object.keys(approval.sourceFiles).map((filename) => [
            filename,
            digest({ bytes: readFileSync(path.join(approval.checkout, filename)) }),
          ]),
        ),
        approval,
      })
    } catch {
      cleanupFailures.push('source-fingerprint-changed')
    }
    try {
      assert(runtimeEvidence)
      runtimeEvidence.collect()
    } catch {
      cleanupFailures.push('runtime-observation-incomplete')
    }
    await saveReceipt({ outcome: cleanupFailures.length ? 'cleanup-failed' : outcome })
    assert.equal(cleanupFailures.length, 0, 'Owned cleanup failed; preserve evidence and stop.')
  }
  const command = async ({ input }: { input: object }) => {
    const filename = path.join(approval.runDirectory, `command-${++commandSequence}.json`)
    await writeFile(filename, JSON.stringify(input), { flag: 'wx', mode: 0o600 })
    const text = await observedCommand({
      argv: [
        '--import',
        'tsx',
        'scripts/admin-commands.mjs',
        '--config',
        coreFile,
        '--command',
        filename,
      ],
      maxBytes: 16384,
      role: 'admin',
      timeoutMs: 30000,
    })
    const result = JSON.parse(text.trim()) as CommandResult
    return result
  }
  const readyTarget = () => {
    assert.equal(digest({ bytes: readFileSync(coreFile) }), coreSHA)
    const filename = path.join(approval.runDirectory, 'target/profile.json')
    assert.equal(digest({ bytes: readFileSync(filename) }), profileSHA)
    const profile = JSON.parse(readFileSync(filename, 'utf8')) as {
      fingerprint: string
      nonce: string
      state: string
    }
    assert(
      profile.nonce === profileNonce &&
        profile.state === 'ready' &&
        /^[a-f0-9]{64}$/.test(profile.fingerprint),
    )
    const database = path.join(approval.runDirectory, 'target/core.sqlite')
    assertPrivate({ filename: database })
    return database
  }
  async function observedCommand({
    argv,
    maxBytes,
    role,
    timeoutMs,
  }: {
    argv: string[]
    maxBytes: number
    role: 'admin' | 'build' | 'init'
    timeoutMs: number
  }) {
    assert(runtimeEvidence)
    const prepared = await runtimeEvidence.prepareRole({ role })
    const childEnv = prepared.env
    let child: ChildProcess
    const pending = new Promise<string>((resolve, reject) => {
      child = execFile(
        canonicalNode,
        argv,
        { cwd: app, env: childEnv, maxBuffer: maxBytes, timeout: timeoutMs },
        (error, stdout) => {
          if (role === 'admin' && stdout.trim().startsWith('{')) {
            resolve(stdout)
          } else if (error) {
            reject(Error('Observed fixed Node command failed; do not replay.'))
          } else {
            resolve(stdout)
          }
        },
      )
    })
    // Register rejection handling immediately; a failed OS snapshot never leaves an unobserved promise.
    const settled = pending.then(
      (value) => ({ value }),
      () => ({ failed: true as const }),
    )
    await runtimeEvidence.recordChild({ child: child!, controlSHA: prepared.controlSHA })
    const result = await settled
    assert('value' in result, 'Observed fixed Node command failed; preserve target.')
    return result.value
  }
  try {
    // Reserve first, never reuse an unknown listener. Handoff is verified against the spawned PID closure.
    const reservation = createServer()
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject)
      reservation.listen(approval.nextPort, '127.0.0.1', resolve)
    })
    let isReserved = true
    cleanups.push({
      name: 'port-reservation',
      close: async () => {
        if (isReserved) {
          await new Promise<void>((resolve) => reservation.close(() => resolve()))
        }
      },
    })
    const beforeRedis = await processSnapshot()
    redis = await stage({ name: 'redis', operation: startRedisFixture })
    cleanups.push({
      name: 'redis',
      close: async () => {
        await redis.stop()
        assert(!(await listeningPIDs({ port: Number(new URL(redis.url).port) })).length)
      },
    })
    const redisPIDs = await listeningPIDs({ port: Number(new URL(redis.url).port) })
    assert.equal(redisPIDs.length, 1)
    const redisIdentity = (await processSnapshot()).find((entry) => entry.pid === redisPIDs[0])
    assert(
      redisIdentity &&
        redisIdentity.uid === process.getuid!() &&
        redisIdentity.ppid === process.pid &&
        !beforeRedis.some((entry) => entry.pid === redisIdentity.pid),
    )
    const beforeContainers = await dockerIDs()
    minioStart = performance.now()
    minio = await stage({ name: 'minio', operation: startMinIOFixture })
    cleanups.push({
      name: 'minio',
      close: async () => {
        await minio.close()
        if (minioID) {
          assert(!(await dockerIDs()).includes(minioID))
        }
      },
    })
    minio.reserveBytes({ bytes: approval.budget.objectBytes })
    const candidates = (await dockerIDs()).filter((id) => !beforeContainers.includes(id))
    const matches = []
    for (const id of candidates) {
      const raw = await fixedDocker({
        argv: [
          '--host',
          'unix:///var/run/docker.sock',
          'inspect',
          '--format',
          '{{.Image}} {{json .NetworkSettings.Ports}}',
          id,
        ],
      })
      const split = raw.indexOf(' ')
      if (raw.slice(0, split) !== cachedMinIOImage) {
        continue
      }
      const ports = JSON.parse(raw.slice(split + 1)) as Record<
        string,
        { HostIp: string; HostPort: string }[]
      >
      if (
        ports['9000/tcp']?.length === 1 &&
        ports['9000/tcp'][0]?.HostIp === '127.0.0.1' &&
        ports['9000/tcp'][0]?.HostPort === new URL(minio.endpoint).port
      ) {
        matches.push(id)
      }
    }
    assert.equal(matches.length, 1, 'MinIO ownership is not unique.')
    minioID = matches[0]!
    client = new S3Client({
      credentials: minio.credentials,
      endpoint: minio.endpoint,
      forcePathStyle: true,
      maxAttempts: 1,
      region: 'fixture',
    })
    cleanups.push({
      name: 'sdk',
      close: () => {
        client.destroy()
        return Promise.resolve()
      },
    })
    observer = await stage({
      name: 'observer',
      operation: () =>
        startS3Observer({
          bucket: minio.bucket,
          budget: {
            deadlineMs: 30000,
            maxBytes: approval.budget.observerBytes,
            maxEvents: approval.budget.observerEvents,
            maxInflight: 4,
          },
          endpoint: minio.endpoint,
          phase: () => phase,
        }),
    })
    cleanups.push({ name: 'observer', close: observer.close })
    await stage({
      name: 'bucket',
      operation: () => client.send(new CreateBucketCommand({ Bucket: minio.bucket })),
    })
    const config = buildConfiguration({
      approval,
      bucket: minio.bucket,
      credentials: minio.credentials,
      endpoint: observer.endpoint,
      redisURL: redis.url,
    })
    const bytes = Buffer.from(JSON.stringify(config))
    assert(bytes.length <= 65536)
    await writeFile(coreFile, bytes, { flag: 'wx', mode: 0o600 })
    coreSHA = digest({ bytes })
    runtimeEvidence = createRuntimeEvidence({ approval, coreFile, coreSHA, env, outputs })
    await stage({
      name: 'init',
      operation: () =>
        observedCommand({
          argv: ['--import', 'tsx', 'scripts/init-target.mjs', '--config', coreFile],
          maxBytes: 65536,
          role: 'init',
          timeoutMs: 30000,
        }),
    })
    const profileFile = path.join(approval.runDirectory, 'target/profile.json')
    const profile = JSON.parse(readFileSync(profileFile, 'utf8')) as {
      fingerprint: string
      nonce: string
      state: string
    }
    assert(profile.state === 'ready' && /^[a-f0-9]{64}$/.test(profile.fingerprint))
    profileSHA = digest({ bytes: readFileSync(profileFile) })
    profileNonce = profile.nonce
    const admin = requireConfirmed({
      result: await stage({
        name: 'bootstrap',
        operation: () => command({ input: { action: 'bootstrap', ...credentials } }),
      }),
    })
    assert(admin.role === 'admin' && admin.status === 'active')
    if (approval.mode === 'prod') {
      productionReceipt = await prepareProduction({
        coreSHA,
        deadline: minioStart + approval.budget.durationMs,
        expectedDistDirectory: outputs.distDirectory,
        now: () => performance.now(),
        ports: {
          build: async () => {
            await stage({
              name: 'production-build',
              operation: () =>
                observedCommand({
                  argv: ['node_modules/next/dist/bin/next', 'build', '--webpack'],
                  maxBytes: approval.budget.logBytes,
                  role: 'build',
                  timeoutMs: approval.buildBudgetMs!,
                }),
            })
          },
          inspect: () => {
            readyTarget()
            const dist = outputs.distDirectory
            const names = [
              'BUILD_ID',
              'build-manifest.json',
              'prerender-manifest.json',
              'routes-manifest.json',
              'server/app-paths-manifest.json',
            ]
            const outputHashes = Object.fromEntries(
              names.map((name) => [name, digest({ bytes: readFileSync(path.join(dist, name)) })]),
            )
            const currentFiles = Object.fromEntries(
              Object.keys(approval.sourceFiles).map((name) => [
                name,
                digest({ bytes: readFileSync(path.join(approval.checkout, name)) }),
              ]),
            )
            verifySourceBinding({ actualFiles: currentFiles, approval })
            return Promise.resolve({
              buildId: readFileSync(path.join(dist, 'BUILD_ID'), 'utf8').trim(),
              coreSHA,
              distDirectory: dist,
              outputSHA: digest({ bytes: Buffer.from(JSON.stringify(outputHashes)) }),
              sourceSHA: approval.sourceManifestSHA,
              targetSHA: profileSHA,
            })
          },
          start: async () => {
            /* Receipt verified here; actual owned spawn immediately follows. */
          },
        },
        sourceSHA: approval.sourceManifestSHA,
        targetSHA: profileSHA,
      })
    }
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    )
    isReserved = false
    assert(runtimeEvidence)
    const nextPrepared = await runtimeEvidence.prepareRole({ role: 'next-runtime' })
    const nextEnv = nextPrepared.env
    const child = spawn(
      canonicalNode,
      [
        'node_modules/next/dist/bin/next',
        ...(approval.mode === 'dev' ? ['dev', '--webpack'] : ['start']),
        '--hostname',
        '127.0.0.1',
        '--port',
        String(approval.nextPort),
      ],
      {
        cwd: app,
        detached: true,
        env: { ...nextEnv, NODE_ENV: approval.mode === 'prod' ? 'production' : 'development' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    assert(child.pid)
    let logBytes = 0
    let hasChildError = false
    child.on('error', () => {
      hasChildError = true
    })
    for (const output of [child.stdout!, child.stderr!]) {
      output.on('data', (chunk: Buffer) => {
        logBytes += chunk.length
        if (logBytes > approval.budget.logBytes) {
          hasChildError = true
          hasNextBudgetFailure = true
        }
      })
    }
    cleanups.push({
      name: 'next',
      close: async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          // An exited CLI parent is not proof its forked server or listener stopped.
          await verifyNextStopped({ pid: child.pid!, port: approval.nextPort })
          return
        }
        assert(nextIdentity, 'Missing owned Next birth evidence; no guessed kill.')
        const current = (await processSnapshot()).find((entry) => entry.pid === child.pid)
        assert.deepEqual(current, nextIdentity, 'Next PID identity changed; no guessed kill.')
        const group = (await processSnapshot()).filter((entry) => entry.pgid === child.pid)
        const descendants = new Set([child.pid!])
        for (let pass = 0; pass < 16; pass++) {
          for (const entry of group) {
            if (descendants.has(entry.ppid)) {
              descendants.add(entry.pid)
            }
          }
        }
        runtimeEvidence!.rememberClosure({
          controlSHA: nextPrepared.controlSHA,
          rootPID: child.pid!,
          snapshot: group,
        })
        assert(
          group.every((entry) => entry.uid === process.getuid!() && descendants.has(entry.pid)),
          'Unknown process in Next group; do not kill.',
        )
        process.kill(-child.pid!, 'SIGTERM')
        for (
          let index = 0;
          index < 30 && child.exitCode === null && child.signalCode === null;
          index++
        ) {
          await delay(100)
        }
        if (child.exitCode === null && child.signalCode === null) {
          const still = (await processSnapshot()).find((entry) => entry.pid === child.pid)
          assert.deepEqual(still, nextIdentity)
          process.kill(-child.pid!, 'SIGKILL')
          for (
            let index = 0;
            index < 20 && child.exitCode === null && child.signalCode === null;
            index++
          ) {
            await delay(100)
          }
        }
        await verifyNextStopped({ pid: child.pid!, port: approval.nextPort })
      },
    })
    nextIdentity = (await processSnapshot()).find((entry) => entry.pid === child.pid)
    assert(
      nextIdentity && nextIdentity.pgid === child.pid && nextIdentity.uid === process.getuid!(),
    )
    await runtimeEvidence.recordChild({ child, controlSHA: nextPrepared.controlSHA })
    await stage({
      name: 'next-ready',
      operation: async () => {
        for (;;) {
          assert(
            !hasChildError &&
              child.exitCode === null &&
              child.signalCode === null &&
              performance.now() - minioStart < approval.budget.durationMs,
          )
          const snapshot = await processSnapshot()
          const descendants = new Set([child.pid!])
          for (let pass = 0; pass < 10; pass++) {
            for (const entry of snapshot) {
              if (
                descendants.has(entry.ppid) &&
                entry.uid === nextIdentity!.uid &&
                entry.pgid === nextIdentity!.pgid
              ) {
                descendants.add(entry.pid)
              }
            }
          }
          runtimeEvidence!.rememberClosure({
            controlSHA: nextPrepared.controlSHA,
            rootPID: child.pid!,
            snapshot,
          })
          const listeners = await listeningPIDs({ port: approval.nextPort })
          if (listeners.length) {
            assert(
              listeners.every((pid) => descendants.has(pid)),
              'Next port belongs to an unknown process.',
            )
            try {
              if (
                (await fetch(`${baseURL}/admin/login`, { signal: AbortSignal.timeout(1000) })).ok
              ) {
                break
              }
            } catch {
              /* bounded own startup */
            }
          }
          await delay(100)
        }
      },
    })
    readyTarget()
    return {
      adminId: admin.id,
      adminRoute: '/admin',
      apiRoute: '/api',
      approval,
      baseURL,
      close,
      command,
      corruptVersion: ({
        column,
        raw,
        templateId,
        versionId,
      }: {
        column:
          | 'display_config_json'
          | 'generation_config_json'
          | 'input_schema_json'
          | 'share_config_json'
        raw: string
        templateId: number
        versionId: number
      }) => {
        assert(
          Number.isSafeInteger(templateId) &&
            templateId > 0 &&
            Number.isSafeInteger(versionId) &&
            versionId > 0 &&
            typeof raw === 'string' &&
            raw.length <= 65536,
        )
        assert(
          [
            'display_config_json',
            'generation_config_json',
            'input_schema_json',
            'share_config_json',
          ].includes(column),
        )
        const database = new DatabaseSync(readyTarget())
        try {
          const before = database
            .prepare(
              `SELECT ${column} AS raw FROM template_versions WHERE id = ? AND template_id = ?`,
            )
            .get(versionId, templateId)
          assert(before)
          const result = database
            .prepare(`UPDATE template_versions SET ${column} = ? WHERE id = ? AND template_id = ?`)
            .run(raw, versionId, templateId)
          assert.equal(Number(result.changes), 1)
          const after = database
            .prepare(
              `SELECT ${column} AS raw FROM template_versions WHERE id = ? AND template_id = ?`,
            )
            .get(versionId, templateId)
          assert.equal(after?.raw, raw)
          assert(faultEvidence.length < 16)
          faultEvidence.push({
            afterSHA: digest({ bytes: Buffer.from(raw) }),
            beforeSHA: digest({ bytes: Buffer.from(String(before.raw)) }),
            column,
            rowsAffected: Number(result.changes),
            templateId,
            versionId,
          })
          return {
            afterSHA: digest({ bytes: Buffer.from(raw) }),
            before: String(before.raw),
            beforeSHA: digest({ bytes: Buffer.from(String(before.raw)) }),
          }
        } finally {
          database.close()
        }
      },
      credentials,
      guard,
      observer,
      readMedia: ({ id }: { id: number }) => {
        assert(Number.isSafeInteger(id) && id > 0)
        const database = new DatabaseSync(readyTarget(), { readOnly: true })
        try {
          const row = database
            .prepare(
              'SELECT id, owner, purpose, visibility, sha256, storage_backend, storage_bucket, storage_name FROM media WHERE id = ?',
            )
            .get(id)
          assert(row)
          return row
        } finally {
          database.close()
        }
      },
      readTemplate: ({ code }: { code: string }) => {
        assert(code.includes(approval.runId) && /^[a-z0-9_-]{1,64}$/.test(code))
        const database = new DatabaseSync(readyTarget(), { readOnly: true })
        try {
          const rows = database
            .prepare(
              'SELECT t.id, t.published_version_id, t.status, v.id AS version_id, v.generation_config_json, v.display_config_json, v.input_schema_json, v.share_config_json, v.cost_credits, v.published_at FROM creation_templates t LEFT JOIN template_versions v ON v.template_id = t.id WHERE t.code = ? ORDER BY v.version_no DESC LIMIT 2',
            )
            .all(code)
          assert(rows.length)
          return rows
        } finally {
          database.close()
        }
      },
      runId: approval.runId,
      scenario,
      stage,
      stopRedis: redis.stop,
      verifyPrivateObject: async ({ bytes, key }: { bytes: Buffer; key: string }) => {
        assert(/^official\/examples\/[a-f0-9-]+\/[a-f0-9]{64}$/.test(key))
        const result = await client.send(new GetObjectCommand({ Bucket: minio.bucket, Key: key }))
        assert(result.Body)
        const got = await result.Body.transformToByteArray()
        assert.deepEqual(Buffer.from(got), bytes)
        const anonymous = await fetch(`${minio.endpoint}/${minio.bucket}/${key}`, {
          redirect: 'error',
          signal: AbortSignal.timeout(1000),
        })
        assert.equal(anonymous.status, 403)
        await anonymous.body?.cancel()
      },
    }
  } catch {
    await close({ outcome: 'setup-failed' })
    throw Error('Owned setup failed; evidence preserved; no automatic replay.')
  }
}

async function dockerIDs() {
  const text = await fixedDocker({
    argv: [
      '--host',
      'unix:///var/run/docker.sock',
      'ps',
      '--all',
      '--no-trunc',
      '--format',
      '{{.ID}}',
    ],
  })
  const ids = text.trim().split('\n').filter(Boolean)
  assert(ids.every((id) => /^[a-f0-9]{64}$/.test(id)))
  return ids
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

type ProductionReceipt = {
  buildId: string
  coreSHA: string
  distDirectory: string
  outputSHA: string
  sourceSHA: string
  targetSHA: string
}
export async function prepareProduction({
  coreSHA,
  deadline,
  expectedDistDirectory,
  now,
  ports,
  sourceSHA,
  targetSHA,
}: {
  coreSHA: string
  deadline: number
  expectedDistDirectory: string
  now: () => number
  ports: {
    build: () => Promise<void>
    inspect: () => Promise<ProductionReceipt>
    start: () => Promise<void>
  }
  sourceSHA: string
  targetSHA: string
}) {
  assert(now() < deadline, 'Production deadline exhausted.')
  await ports.build()
  assert(now() < deadline, 'Production build consumed the run budget.')
  const receipt = await ports.inspect()
  assert(
    receipt.distDirectory === expectedDistDirectory &&
      receipt.coreSHA === coreSHA &&
      receipt.sourceSHA === sourceSHA &&
      receipt.targetSHA === targetSHA &&
      /^[\w-]{1,128}$/.test(receipt.buildId) &&
      /^[a-f0-9]{64}$/.test(receipt.outputSHA),
    'Production output is not bound to this ready target.',
  )
  assert(now() < deadline, 'Production inspection consumed the run budget.')
  await ports.start()
  return Object.freeze(receipt)
}

async function cleanupInReverse({
  resources,
}: {
  resources: readonly { close: () => Promise<void>; name: string }[]
}) {
  const failures: string[] = []
  for (const resource of [...resources].reverse()) {
    try {
      await resource.close()
    } catch {
      failures.push(resource.name)
    }
  }
  return failures
}

function fixedDocker({ argv }: { argv: string[] }) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      'docker',
      argv,
      {
        env: {
          LANG: 'C',
          NODE_ENV: 'test',
          PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
        },
        maxBuffer: 65536,
        timeout: 5000,
      },
      (error, stdout) =>
        error ? reject(Error('Owned Docker identity query failed.')) : resolve(stdout),
    ),
  )
}

/** Fixed terminal check, not orphan cleanup: unknown residuals fail and remain untouched. */
export async function verifyNextStopped({
  pid,
  port,
  ports = { listeners: listeningPIDs, processes: processSnapshot },
}: {
  pid: number
  port: number
  ports?: {
    listeners: (args: { port: number }) => Promise<readonly number[]>
    processes: () => Promise<readonly { pgid: number }[]>
  }
}) {
  assert(
    Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(port) && port > 0 && port < 65536,
  )
  const processes = await ports.processes()
  const listeners = await ports.listeners({ port })
  assert(
    !processes.some((entry) => entry.pgid === pid),
    'Next process group survived cleanup; no guessed orphan kill.',
  )
  assert(listeners.length === 0, 'Next listener survived cleanup; no guessed listener kill.')
}
