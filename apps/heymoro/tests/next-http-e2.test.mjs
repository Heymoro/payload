import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const load = async () => {
  try {
    return await import('./creation/next-http-e2-profile.mjs')
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {}
    throw error
  }
}

test('should expose only the fixed E2 profile and closed roles', async () => {
  const api = await load()
  assert.equal(typeof api.selectE2Role, 'function', 'fixed E2 profile is missing')
  for (const role of ['next-1', 'next-2', 'seed', 'attest', 'snapshot', 'jobs-1', 'jobs-2'])
    assert.equal(api.selectE2Role({ profileId: 'e2-local', role }).role, role)
  for (const input of [
    { profileId: 'E0', role: 'next-1' },
    { profileId: 'e2-local', role: 'shell' },
    { profileId: 'e2-local', role: 'next-1', executable: '/bin/sh' },
  ])
    assert.throws(() => api.selectE2Role(input))
})

test('should reject arbitrary directories traversal and symbolic links', async () => {
  const api = await load()
  assert.equal(typeof api.assertE2Directory, 'function')
  for (const directory of ['/tmp/other', `${api.E2_DIRECTORY}/../other`, `${api.E2_DIRECTORY}/`])
    assert.throws(() => api.assertE2Directory({ directory }))
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2-rules-')))
  mkdirSync(path.join(root, 'real'))
  symlinkSync(path.join(root, 'real'), path.join(root, 'link'))
  assert.throws(() => api.assertCanonicalPath({ filename: path.join(root, 'link') }))
  assert.equal(
    api.assertCanonicalPath({ filename: path.join(root, 'real') }),
    path.join(root, 'real'),
  )
})

test('should allow exactly authorized source additions and edits with no deletion', async () => {
  const api = await load()
  assert.equal(typeof api.assertE2Delta, 'function')
  const before = { 'a.ts': 'a'.repeat(64), 'b.ts': 'b'.repeat(64) }
  const after = { ...before, 'a.ts': 'c'.repeat(64), 'new.ts': 'd'.repeat(64) }
  const changes = [
    { filename: 'a.ts', beforeSHA: before['a.ts'], afterSHA: after['a.ts'] },
    { filename: 'new.ts', beforeSHA: null, afterSHA: after['new.ts'] },
  ]
  api.assertE2Delta({ before, after, changes })
  for (const actual of [
    { ...after, 'b.ts': 'e'.repeat(64) },
    { ...after, 'extra.ts': 'e'.repeat(64) },
    { 'a.ts': after['a.ts'], 'new.ts': after['new.ts'] },
  ])
    assert.throws(() => api.assertE2Delta({ before, after: actual, changes }))
  assert.throws(() => api.assertE2Delta({ before, after, changes: [...changes, changes[0]] }))
  assert.throws(() =>
    api.assertE2Delta({ before, after, changes: [{ ...changes[0], filename: '../a.ts' }] }),
  )
})

test('should bind all immutable facts including Git state JSON owner and target fingerprint', async () => {
  const api = await load()
  assert.equal(typeof api.assertE2Facts, 'function')
  const expected = {
    parentPassedReportSHA: api.E2_PARENT_SHA,
    revisionSHA: 'a'.repeat(64),
    ownerSHA: 'b'.repeat(64),
    initializationSHA: 'c'.repeat(64),
    lockSHA: 'd'.repeat(64),
    manifestSHA: 'e'.repeat(64),
    sourceManifestSHA: 'f'.repeat(64),
    overlayManifestSHA: '1'.repeat(64),
    jsonSHA: '2'.repeat(64),
    controlSHA: '3'.repeat(64),
    guardSHA: '4'.repeat(64),
    targetFingerprint: '5'.repeat(64),
    repositories: { payload: { head: 'head', trackedDiffs: 'diff', staged: '' } },
  }
  api.assertE2Facts({ expected, actual: structuredClone(expected) })
  for (const key of Object.keys(expected))
    assert.throws(() => api.assertE2Facts({ expected, actual: { ...expected, [key]: 'changed' } }))
  assert.throws(() => api.assertE2Facts({ expected, actual: { ...expected, extra: true } }))
})

test('should deny public or unregistered outbound and make frozen inputs kernel read-only', async () => {
  const api = await load()
  assert.equal(typeof api.e2KernelProfile, 'function')
  const input = {
    role: 'next-1',
    writeRoot: realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2-policy-'))),
    ports: { redis: 12001, s3: 12002, next: 12003 },
    protectedRoots: ['/original'],
    immutablePaths: ['/owned/control.json'],
    oldDataRoots: ['/old'],
  }
  const policy = api.e2KernelProfile(input)
  assert.match(policy, /deny network\*/)
  assert.match(policy, /localhost:12001/)
  assert.match(policy, /localhost:12002/)
  assert.match(policy, /network-bind[^\n]+localhost:12003/)
  assert.match(policy, /network-inbound[^\n]+localhost:12003/)
  const worker = api.e2KernelProfile({ ...input, role: 'jobs-1' })
  assert.doesNotMatch(worker, /allow network-(bind|inbound)/)
  assert.match(policy, /data\(\/\|\$\)/)
  assert.match(policy, /deny file-write\*/)
  assert.match(policy, /control\.json/)
  for (const ports of [
    { redis: 443, s3: 443, next: 3001 },
    { ...input.ports, public: 443 },
    { ...input.ports, redis: 0 },
  ])
    assert.throws(() => api.e2KernelProfile({ ...input, ports }))
})

test('should retain Next lease when its worker stops and observe all active leases', async () => {
  const api = await load()
  assert.equal(typeof api.createE2LeaseRegistry, 'function')
  const registry = api.createE2LeaseRegistry()
  const next = { commandId: 'next', pid: 100, pgid: 100, uid: 501, ownedPorts: [12003] }
  const worker = { commandId: 'worker', pid: 101, pgid: 101, uid: 501, ownedPorts: [] }
  registry.add({ lease: next })
  registry.add({ lease: worker })
  const observed = []
  await registry.observeAll({ observe: ({ lease }) => observed.push(lease.commandId) })
  assert.deepEqual(observed, ['next', 'worker'])
  registry.closed({ lease: worker })
  assert.deepEqual(registry.active(), [next])
  assert.throws(() => registry.closed({ lease: { ...next } }))
})

test('should aggregate cleanup failures without skipping remaining leases', async () => {
  const api = await load()
  assert.equal(typeof api.createE2LeaseRegistry, 'function')
  const registry = api.createE2LeaseRegistry()
  for (const pid of [100, 101])
    registry.add({ lease: { commandId: String(pid), pid, pgid: pid, uid: 501, ownedPorts: [] } })
  const stopped = []
  await assert.rejects(
    registry.cleanupAll({
      stop: ({ lease }) => {
        stopped.push(lease.pid)
        if (lease.pid === 100) throw new Error('Next failed')
      },
    }),
    AggregateError,
  )
  assert.deepEqual(stopped, [100, 101])
  assert.equal(registry.active().length, 1)
})

test('should reject missing guard native compiler ACK or exit-residue evidence', async () => {
  const api = await load()
  assert.equal(typeof api.assertE2LeaseEvidence, 'function')
  const evidence = {
    uid: 501,
    pid: 100,
    pgid: 100,
    commandId: 'id',
    nodePids: [100],
    handshakes: [100],
    nativeControls: [100],
    compilerPids: [101],
    compilerACKs: [101],
    alivePids: [],
    groupMembers: [],
    portOwners: [],
  }
  api.assertE2LeaseEvidence({ evidence })
  for (const key of ['handshakes', 'nativeControls', 'compilerACKs'])
    assert.throws(() => api.assertE2LeaseEvidence({ evidence: { ...evidence, [key]: [] } }))
  for (const key of ['alivePids', 'groupMembers', 'portOwners'])
    assert.throws(() => api.assertE2LeaseEvidence({ evidence: { ...evidence, [key]: [100] } }))
})

test('should require fixed business assertions compiled provenance and all leases closed', async () => {
  const api = await load()
  assert.equal(typeof api.assertE2Success, 'function')
  const revision = await import('./creation/next-http-e2-revision.mjs')
  const frozenSource = { 'payload/apps/heymoro/src/probe.ts': 'a'.repeat(64) }
  const report = {
    ...api.e2RevisionBinding({ revisionId: '01234567-89ab-4cde-8fab-0123456789ab' }),
    authoritySHA: 'b'.repeat(64),
    sourceManifestSHA: 'c'.repeat(64),
    frozenSource,
    frozenSourceSHA: revision.manifestSHA({ manifest: frozenSource }),
    datasetOwnerSHA: 'd'.repeat(64),
    profileId: 'e2-local',
    mode: 'business',
    assertionVersion: 1,
    assertions: Object.fromEntries(
      api.E2_ASSERTIONS.map((key) => [
        key,
        { passed: true, evidence: { fixture: 'synthetic-pure-rule' } },
      ]),
    ),
    rounds: [1, 2].map((round) => ({
      round,
      coldProcess: true,
      compiledJSON: '/owned/core-e2.json',
      compiledRoots: ['/owned/source'],
    })),
    activeLeases: [],
    cleanupUnconfirmed: false,
    servicesClosed: true,
    kernelIsolationProof: {
      sealedNode: true,
      sealedNative: true,
      publicOutbound: true,
      unregisteredLoopback: true,
      workerBind: true,
      nativeEnv: true,
    },
  }
  report.assertions.datasetOwnership.evidence.ownerSHA = report.datasetOwnerSHA
  api.assertE2Success({ report, jsonFile: '/owned/core-e2.json', sourceRoot: '/owned/source' })
  for (const changed of [
    { ...report, kernelIsolationProof: {} },
    { ...report, servicesClosed: false },
    { ...report, assertions: {} },
    { ...report, activeLeases: [1] },
    { ...report, cleanupUnconfirmed: true },
    { ...report, rounds: [] },
    { ...report, frozenSource: {} },
    { ...report, frozenSourceSHA: '0'.repeat(64) },
    { ...report, sourceManifestSHA: '' },
    { ...report, datasetOwnerSHA: '0'.repeat(64) },
  ])
    assert.throws(() =>
      api.assertE2Success({
        report: changed,
        jsonFile: '/owned/core-e2.json',
        sourceRoot: '/owned/source',
      }),
    )
})

test('should reject extra source members and unapproved candidate paths', async () => {
  const revision = await import('./creation/next-http-e2-revision.mjs')
  assert.equal(
    typeof revision.assertE2SourceMembership,
    'function',
    'exact source membership gate is missing',
  )
  revision.assertE2SourceMembership({
    expected: ['payload/apps/heymoro/src/a.ts'],
    actual: ['payload/apps/heymoro/src/a.ts'],
  })
  assert.throws(() =>
    revision.assertE2SourceMembership({
      expected: ['payload/apps/heymoro/src/a.ts'],
      actual: ['payload/apps/heymoro/src/a.ts', 'payload/apps/heymoro/src/extra.ts'],
    }),
  )
  assert.equal(typeof revision.assertE2CandidatePaths, 'function')
  assert.throws(() =>
    revision.assertE2CandidatePaths({
      approvedPaths: ['payload/apps/heymoro/src/approved.ts'],
      changes: Array.from({ length: 28 }, (_, index) => ({
        filename: `payload/packages/payload/src/${index}.ts`,
      })),
    }),
  )
})

const admissionInput = {
  description: '',
  inputMediaIds: [31, 30],
  userNotes: 'ordered synthetic notes',
}
function admissionReply({ status }) {
  const requestId = '4abeb86c-9019-44af-85e7-2f85a84ee05b'
  return {
    response: {
      status,
      headers: new Headers({ 'cache-control': 'private, no-store', 'x-request-id': requestId }),
    },
    envelope: {
      requestId,
      data: {
        clientRequestId: 'synthetic-admission-key',
        costCredits: 2,
        errorCode: null,
        id: 51,
        input: { ...admissionInput },
        roundNo: 1,
        sessionId: 41,
        sourceTaskId: null,
        status: 'queued',
        templateId: 20,
      },
    },
    input: admissionInput,
  }
}

test('should share exact JSON response validation for ordinary and admission replies', async () => {
  const api = await import('./creation/next-business-http.mjs')
  assert.equal(typeof api.validateE2JSONResponse, 'function', 'shared JSON validator is missing')
  const valid = admissionReply({ status: 200 })
  assert.deepEqual(api.validateE2JSONResponse(valid), valid.envelope.data)
  for (const corrupt of [
    { ...valid, envelope: { ...valid.envelope, extra: true } },
    { ...valid, envelope: { ...valid.envelope, data: { payloadSecret: 'synthetic-only' } } },
    {
      ...valid,
      response: {
        ...valid.response,
        headers: new Headers({ 'x-request-id': 'wrong', 'cache-control': 'private, no-store' }),
      },
    },
    {
      ...valid,
      response: {
        ...valid.response,
        headers: new Headers({
          'x-request-id': valid.envelope.requestId,
          'cache-control': 'public',
        }),
      },
    },
  ])
    assert.throws(() => api.validateE2JSONResponse(corrupt))
})

for (const statuses of [
  [201, 200],
  [200, 201],
]) {
  test(`should validate both admission tasks before projecting ${statuses.join('/')}`, async () => {
    const api = await import('./creation/next-business-http.mjs')
    assert.equal(
      typeof api.validateE2AdmissionResponse,
      'function',
      'per-response admission validator is missing',
    )
    const valid = statuses.map((status) => admissionReply({ status }))
    assert.deepEqual(
      valid.map((reply) => api.validateE2AdmissionResponse(reply)),
      valid.map(({ response, envelope }) => ({ status: response.status, task: envelope.data })),
    )
    for (const position of [0, 1]) {
      const mutations = [
        ({ envelope }) => {
          envelope.extra = 'synthetic-only'
        },
        ({ envelope }) => {
          envelope.data.extra = 'synthetic-only'
        },
        ({ envelope }) => {
          envelope.data.systemPrompt = 'synthetic-only'
        },
        ({ envelope }) => {
          envelope.data.input = { ...admissionInput, userNotes: 'changed' }
        },
        ({ response }) => {
          response.headers.set('x-request-id', 'wrong')
        },
        ({ response }) => {
          response.headers.set('cache-control', 'public')
        },
      ]
      for (const mutate of mutations) {
        const replies = statuses.map((status) => admissionReply({ status }))
        mutate(replies[position])
        assert.throws(
          () => replies.map((reply) => api.validateE2AdmissionResponse(reply)),
          `reply position ${position} with HTTP ${statuses[position]} must reject contamination`,
        )
      }
    }
  })
}

test('should reject contamination through the actual concurrent HTTP response path in either position', async (t) => {
  const api = await import('./creation/next-business-http.mjs')
  const { createE2LeaseRegistry } = await load()
  let replies = []
  let position = 0
  t.mock.method(globalThis, 'fetch', async () => {
    const { response, envelope } = replies[position++]
    return Response.json(envelope, { status: response.status, headers: response.headers })
  })
  const mutations = [
    ({ envelope }) => {
      envelope.extra = 'synthetic-only'
    },
    ({ envelope }) => {
      envelope.data.extra = 'synthetic-only'
    },
    ({ envelope }) => {
      envelope.data.systemPrompt = 'synthetic-only'
    },
    ({ envelope }) => {
      envelope.data.input = { ...admissionInput, userNotes: 'changed' }
    },
    ({ response }) => {
      response.headers.set('x-request-id', 'wrong')
    },
    ({ response }) => {
      response.headers.set('cache-control', 'public')
    },
  ]
  for (const statuses of [
    [201, 200],
    [200, 201],
  ]) {
    for (const badPosition of [0, 1]) {
      for (const mutate of mutations) {
        replies = statuses.map((status) => admissionReply({ status }))
        mutate(replies[badPosition])
        position = 0
        const fixture = {
          port: 43210,
          report: { httpTraces: [] },
          e2: { leases: createE2LeaseRegistry() },
        }
        const settled = await Promise.allSettled(
          statuses.map(() =>
            api.requestConcurrentAdmission({
              fixture,
              token: 'synthetic-only',
              body: { input: admissionInput },
            }),
          ),
        )
        assert.equal(
          settled[badPosition].status,
          'rejected',
          `actual helper must reject response ${badPosition} / HTTP ${statuses[badPosition]}`,
        )
        assert.equal(
          settled[1 - badPosition].status,
          'fulfilled',
          'valid sibling reply remains valid',
        )
      }
    }
  }
})

async function fullKernelFixture({ role = 'attest' } = {}) {
  const { sourceAllowlist } = await import('./creation/next-http-fixture.mjs')
  const { E2_DIRECTORY } = await load()
  const closure = ['next-business-host.ts', 'next-business-seed.ts', 'next-business-worker.ts']
  const runtimePaths = [
    ...sourceAllowlist().filter((filename) => filename !== 'payload/apps/heymoro/next-env.d.ts'),
    ...closure.map((filename) => `payload/apps/heymoro/tests/creation/${filename}`),
  ]
  const immutablePaths = [
    ...runtimePaths.map((filename) => `${E2_DIRECTORY}/source/${filename}`),
    ...Array.from(
      { length: 20 },
      (_, index) => `${E2_DIRECTORY}/E2-synthetic-compiler-regression/metadata-${index}.json`,
    ),
  ]
  const readerPaths = [
    'payload/apps/heymoro/src/creation/application/generation-reader-types.ts',
    'payload/apps/heymoro/src/creation/infrastructure/payload/generation-reader.ts',
  ]
  for (const filename of readerPaths)
    assert.equal(runtimePaths.filter((runtimePath) => runtimePath === filename).length, 1)
  assert.equal(new Set(runtimePaths).size, runtimePaths.length)
  const writerPath =
    'payload/apps/heymoro/src/creation/infrastructure/payload/generation-worker-writer.ts'
  assert.equal(runtimePaths.filter((filename) => filename === writerPath).length, 1)
  const schemaPath = 'payload/apps/heymoro/src/media/schema.ts'
  assert.equal(runtimePaths.filter((filename) => filename === schemaPath).length, 1)
  assert.equal(
    immutablePaths.filter((filename) => filename === `${E2_DIRECTORY}/source/${schemaPath}`).length,
    1,
  )
  const imageValidatorPath =
    'payload/apps/heymoro/src/creation/infrastructure/image/sharp-image-validator.ts'
  assert.equal(runtimePaths.filter((filename) => filename === imageValidatorPath).length, 1)
  assert.equal(
    immutablePaths.filter((filename) => filename === `${E2_DIRECTORY}/source/${imageValidatorPath}`)
      .length,
    1,
  )
  const beginTransactionPath =
    'payload/apps/heymoro/src/creation/infrastructure/payload/sqlite-begin-transaction.ts'
  assert.equal(runtimePaths.filter((filename) => filename === beginTransactionPath).length, 1)
  assert.equal(
    immutablePaths.filter(
      (filename) => filename === `${E2_DIRECTORY}/source/${beginTransactionPath}`,
    ).length,
    1,
  )
  const legacyPath = 'payload/apps/heymoro/src/creation/domain/legacy-output-composition.ts'
  assert.equal(runtimePaths.filter((filename) => filename === legacyPath).length, 1)
  assert.equal(
    immutablePaths.filter((filename) => filename === `${E2_DIRECTORY}/source/${legacyPath}`).length,
    1,
  )
  for (const pngPolicyPath of [
    'payload/apps/heymoro/src/creation/infrastructure/image/png-single-frame-policy.mjs',
    'payload/apps/heymoro/src/creation/infrastructure/image/png-single-frame-policy.d.mts',
  ]) {
    assert.equal(runtimePaths.filter((filename) => filename === pngPolicyPath).length, 1)
    assert.equal(
      immutablePaths.filter((filename) => filename === `${E2_DIRECTORY}/source/${pngPolicyPath}`)
        .length,
      1,
    )
  }
  for (const managementPath of [
    'payload/apps/heymoro/src/creation/application/template-management.ts',
    'payload/apps/heymoro/src/creation/infrastructure/payload/current-template-repository.ts',
  ]) {
    assert.equal(runtimePaths.filter((filename) => filename === managementPath).length, 1)
    assert.equal(
      immutablePaths.filter((filename) => filename === `${E2_DIRECTORY}/source/${managementPath}`)
        .length,
      1,
    )
  }
  for (const taxonomyPath of [
    'payload/apps/heymoro/src/creation/application/template-taxonomy.ts',
    'payload/apps/heymoro/src/creation/infrastructure/payload/template-taxonomy-repository.ts',
  ]) {
    assert.equal(runtimePaths.filter((filename) => filename === taxonomyPath).length, 1)
    assert.equal(
      immutablePaths.filter((filename) => filename === `${E2_DIRECTORY}/source/${taxonomyPath}`)
        .length,
      1,
    )
  }
  for (const officialPath of [
    'payload/apps/heymoro/src/creation/infrastructure/payload/official-media-repository.ts',
    'payload/apps/heymoro/src/creation/http/native-admin-auth.ts',
    'payload/apps/heymoro/src/creation/http/official-media-endpoints.ts',
  ]) {
    assert.equal(runtimePaths.filter((filename) => filename === officialPath).length, 1)
    assert.equal(
      immutablePaths.filter((filename) => filename === `${E2_DIRECTORY}/source/${officialPath}`)
        .length,
      1,
    )
  }
  for (const adminPath of [
    'payload/apps/heymoro/src/admin/TemplateManagementView/index.tsx',
    'payload/apps/heymoro/src/admin/TemplateManagementNavLink/index.tsx',
    'payload/apps/heymoro/src/admin/TemplateManagementEditor/index.tsx',
    'payload/apps/heymoro/src/admin/TemplateManagementEditor/index.css',
    'payload/apps/heymoro/src/admin/template-management-actions.ts',
    'payload/apps/heymoro/src/admin/template-management-form.ts',
    'payload/apps/heymoro/src/admin/TemplateManagementFields/index.tsx',
    'payload/apps/heymoro/src/admin/TemplateManagementTaxonomy/index.tsx',
  ]) {
    assert.equal(runtimePaths.filter((filename) => filename === adminPath).length, 1)
    assert.equal(
      immutablePaths.filter((filename) => filename === `${E2_DIRECTORY}/source/${adminPath}`)
        .length,
      1,
    )
  }
  for (const reconciliationPath of [
    'payload/apps/heymoro/src/creation/domain/generation-reconciliation.ts',
    'payload/apps/heymoro/src/creation/application/generation-reconciliation.ts',
    'payload/apps/heymoro/src/creation/infrastructure/payload/generation-reconciliation-repository.ts',
  ]) {
    assert.equal(runtimePaths.filter((filename) => filename === reconciliationPath).length, 1)
    assert.equal(
      immutablePaths.filter(
        (filename) => filename === `${E2_DIRECTORY}/source/${reconciliationPath}`,
      ).length,
      1,
    )
  }
  for (const runtimePath of [
    'payload/apps/heymoro/src/creation/runtime/admin-initialization.ts',
    'payload/apps/heymoro/src/creation/runtime/local-config.ts',
    'payload/apps/heymoro/src/creation/runtime/development-identity.ts',
    'payload/apps/heymoro/src/creation/infrastructure/payload/generation-consumer.ts',
    'payload/apps/heymoro/src/creation/domain/current-template.ts',
    'payload/apps/heymoro/src/creation/application/current-template.ts',
    'payload/apps/heymoro/src/creation/infrastructure/payload/current-template-collection.ts',
    'payload/apps/heymoro/src/creation/infrastructure/payload/current-template-repository.ts',
  ]) {
    assert.equal(runtimePaths.filter((filename) => filename === runtimePath).length, 1)
    assert.equal(
      immutablePaths.filter((filename) => filename === `${E2_DIRECTORY}/source/${runtimePath}`)
        .length,
      1,
    )
  }
  assert.equal(runtimePaths.filter((filename) => !readerPaths.includes(filename)).length, 3502)
  assert.equal(
    runtimePaths.filter((filename) => !readerPaths.includes(filename) && filename !== writerPath)
      .length,
    3501,
  )
  assert.equal(runtimePaths.length, 3504)
  assert.equal(immutablePaths.length, 3524)
  return {
    role,
    writeRoot: realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2-full-policy-'))),
    ports: { redis: 12001, s3: 12002, next: 12003 },
    protectedRoots: ['/Users/nako/Documents/ChatGPT/NexaZ'],
    immutablePaths,
    oldDataRoots: [`${E2_DIRECTORY}/E2-synthetic-compiler-regression/synthetic/.data`],
  }
}

test('should compile the complete 3504-runtime/3524-immutable E2 policy with the native Darwin compiler', async () => {
  const api = await load()
  for (const role of ['next-1', 'attest']) {
    const input = await fullKernelFixture({ role })
    const policy = api.e2KernelProfile(input)
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, '/usr/bin/true'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: '/usr/bin:/bin' },
    })
    assert.equal(result.status, 0, `Full policy native compile failed: ${result.stderr}`)
    assert.equal(result.stderr, '')
  }
})

test('should cover every frozen path with fixed readonly trees or exact literals within the policy budget', async () => {
  const api = await load()
  assert.equal(
    typeof api.e2WriteProtection,
    'function',
    'fixed compact write protection is missing',
  )
  const input = await fullKernelFixture()
  const protection = api.e2WriteProtection({ immutablePaths: input.immutablePaths })
  assert.equal(protection.subpaths.length, 6)
  assert.equal(protection.literals.length, 30)
  for (const filename of input.immutablePaths)
    assert(
      protection.literals.includes(filename) ||
        protection.subpaths.some((root) => filename === root || filename.startsWith(`${root}/`)),
      `Missing readonly coverage: ${filename}`,
    )
  assert(
    protection.subpaths.every(
      (root) => !root.includes('/.next') && !root.endsWith('/apps/heymoro'),
    ),
  )
  assert.throws(() =>
    api.e2WriteProtection({
      immutablePaths: [`${api.E2_DIRECTORY}/source/payload/unregistered.ts`],
    }),
  )
  assert.throws(() =>
    api.e2WriteProtection({
      immutablePaths: [`${api.E2_DIRECTORY}/source/payload/apps/heymoro/.next/cache/write.js`],
    }),
  )
  assert.throws(
    () =>
      api.e2KernelProfile({
        ...input,
        immutablePaths: Array.from(
          { length: 500 },
          (_, index) => `/owned/synthetic-metadata/${'long-'.repeat(20)}${index}.json`,
        ),
      }),
    /budget/,
  )
  assert(Buffer.byteLength(api.e2KernelProfile(input)) <= api.E2_POLICY_MAX_BYTES)
})

test('should bound the full business policy with many historical proofs using only the exact proof tree', async () => {
  const api = await load()
  const proofRoot = `${api.E2_DIRECTORY}/proof`
  const historical = Array.from(
    { length: 400 },
    (_, index) => `${proofRoot}/E2-runtime-${'a'.repeat(64)}-historical-${index}-intent.json`,
  )
  const initializationEpoch = `${api.E2_DIRECTORY}/E2-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
  const businessEpoch = `${api.E2_DIRECTORY}/E2-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
  const business = [
    `${proofRoot}/E2-ready-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json`,
    `${proofRoot}/E2-dataset-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json`,
    `${proofRoot}/E2-authority-${'b'.repeat(64)}.json`,
    `${proofRoot}/compiler-acks/ack-73.json`,
    ...[
      'core-e2.json',
      'control.json',
      'initialization.json',
      'report.json',
      'journal/attest-73.jsonl',
    ].map((name) => `${initializationEpoch}/${name}`),
    ...['core-e2.json', 'control.json', 'guard-e2.json', 'gate-b-request.json', 'gate-b.json'].map(
      (name) => `${businessEpoch}/${name}`,
    ),
    `${api.E2_DIRECTORY}/e2-target-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/profile.json`,
  ]
  const nearPrefixes = [
    `${api.E2_DIRECTORY}/proof-other/exact-literal.json`,
    `${api.E2_DIRECTORY}/proofs/exact-literal.json`,
  ]
  for (const role of ['next-1', 'attest']) {
    const input = await fullKernelFixture({ role })
    input.immutablePaths.push(...historical, ...business, ...nearPrefixes)
    // Regression: the real old renderer exceeds 32KiB before a child is spawned.
    const policy = api.e2KernelProfile(input)
    assert(Buffer.byteLength(policy) <= 32 * 1024)
    const protection = api.e2WriteProtection({ immutablePaths: input.immutablePaths })
    assert.equal(protection.subpaths.length, 7)
    assert.equal(protection.subpaths.filter((root) => root === proofRoot).length, 1)
    for (const filename of input.immutablePaths)
      assert(
        protection.literals.includes(filename) ||
          protection.subpaths.some((root) => filename === root || filename.startsWith(`${root}/`)),
        `Missing exact frozen path coverage: ${filename}`,
      )
    for (const filename of historical) assert(!protection.literals.includes(filename))
    for (const filename of nearPrefixes) {
      assert(protection.literals.includes(filename))
      assert(
        !protection.subpaths.some((root) => filename === root || filename.startsWith(`${root}/`)),
      )
    }
    assert(!protection.subpaths.includes(api.E2_DIRECTORY))
    assert.throws(
      () =>
        api.e2WriteProtection({
          immutablePaths: [`${api.E2_DIRECTORY}/source/payload/unregistered.ts`],
        }),
      /Unregistered runtime source path/,
    )
    const compiled = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, '/usr/bin/true'], {
      encoding: 'utf8',
      timeout: 10000,
      env: { PATH: '/usr/bin:/bin' },
    })
    assert.equal(compiled.status, 0, compiled.stderr)
    assert.equal(compiled.stderr, '')
  }
})

test('should enforce compact policy readonly literals and subpaths on new synthetic native probes', async () => {
  const api = await load()
  const input = await fullKernelFixture()
  const directory = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2-v3-native-synthetic-')),
  )
  const source = path.join(directory, 'source')
  const ownedProof = path.join(directory, 'proof')
  const epoch = path.join(directory, 'epoch')
  mkdirSync(ownedProof)
  mkdirSync(epoch)
  mkdirSync(path.join(epoch, 'compiler-acks'))
  const oldProof = path.join(ownedProof, 'existing.json')
  writeFileSync(oldProof, 'owned-existing-proof', { flag: 'wx' })
  mkdirSync(source)
  mkdirSync(path.join(source, 'nested'))
  mkdirSync(path.join(source, 'nested', '.data'))
  const normal = path.join(directory, 'normal.txt')
  const sealed = path.join(directory, 'sealed-authority-probe.json')
  const nested = path.join(source, 'nested', 'source.txt')
  const env = path.join(directory, '.env.synthetic')
  const data = path.join(source, 'nested', '.data', 'old.txt')
  for (const filename of [normal, sealed, nested, env, data])
    writeFileSync(filename, 'owned-synthetic', { flag: 'wx' })
  const predecessor = `${api.E2_DIRECTORY}/proof/E2-authority-7921b4e1841e7bfffc7c7455df04f433735778ddad3500bbbcd15bbbced859c8.json`
  const policy = api.e2KernelProfile({
    ...input,
    writeRoot: directory,
    protectedRoots: [...input.protectedRoots, source, ownedProof],
    immutablePaths: [...input.immutablePaths, sealed, predecessor],
  })
  const protection = api.e2WriteProtection({
    immutablePaths: [...input.immutablePaths, sealed, predecessor],
  })
  assert(protection.subpaths.includes(`${api.E2_DIRECTORY}/proof`))
  assert(!protection.literals.includes(predecessor))
  assert(predecessor.startsWith(`${api.E2_DIRECTORY}/proof/`))
  const run = (executable, args) =>
    spawnSync('/usr/bin/sandbox-exec', ['-p', policy, executable, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: '/usr/bin:/bin' },
    })
  const allowed = run('/bin/cat', [normal])
  assert.equal(allowed.status, 0)
  assert.equal(allowed.stdout, 'owned-synthetic')
  for (const filename of [
    path.join(epoch, 'compiler-acks', 'ack.json'),
    path.join(epoch, 'attempt-attest.json'),
  ]) {
    const writable = run('/bin/sh', [
      '-c',
      'printf owned-epoch-output > \"$1\"',
      'owned-synthetic',
      filename,
    ])
    assert.equal(writable.status, 0, writable.stderr)
    assert.equal(readFileSync(filename, 'utf8'), 'owned-epoch-output')
  }
  for (const filename of [oldProof, path.join(ownedProof, 'new.json')]) {
    const denied = run('/bin/sh', ['-c', 'printf changed > \"$1\"', 'owned-synthetic', filename])
    assert.equal(denied.status, 1)
    assert.match(denied.stderr, /Operation not permitted|Permission denied/)
  }
  assert.equal(readFileSync(oldProof, 'utf8'), 'owned-existing-proof')
  assert.deepEqual(readdirSync(ownedProof), ['existing.json'])
  assert.throws(() => readFileSync(path.join(ownedProof, 'new.json')), { code: 'ENOENT' })
  for (const filename of [sealed, nested]) {
    const denied = run('/bin/sh', ['-c', 'printf changed > "$1"', 'owned-synthetic', filename])
    assert.equal(denied.status, 1)
    assert.match(denied.stderr, /Operation not permitted|Permission denied/)
    assert.equal(readFileSync(filename, 'utf8'), 'owned-synthetic')
  }
  for (const filename of [env, data]) {
    const denied = run('/bin/cat', [filename])
    assert.equal(denied.status, 1)
    assert.match(denied.stderr, /Operation not permitted|Permission denied/)
    assert.equal(denied.stdout, '')
  }
})

test('should import seed contract helpers without runtime configuration or Payload creation', async () => {
  await assert.doesNotReject(import('./creation/next-business-seed.ts'))
})

test('should enforce the real S3 immutable key contract for official synthetic images', async () => {
  const seed = await import('./creation/next-business-seed.ts')
  assert.equal(typeof seed.officialExampleRef, 'function')
  const { createS3ObjectStorage } =
    await import('../src/creation/infrastructure/s3/object-storage.ts')
  const { startS3HTTPFixture } = await import('./creation/s3-http-fixture.ts')
  const sharp = (await import('sharp')).default
  const { createHash } = await import('node:crypto')
  const http = await startS3HTTPFixture()
  const storage = createS3ObjectStorage({
    backends: [
      {
        backend: 'v4-synthetic',
        endpoint: http.endpoint,
        region: 'fixture',
        credentials: http.credentials,
        buckets: ['synthetic'],
        forcePathStyle: true,
      },
    ],
    image: {
      allowedMimeTypes: ['image/png'],
      maxBytes: 100000,
      maxPixels: 100000,
      timeoutMs: 1000,
    },
    limits: {
      connectionTimeoutMs: 100,
      requestTimeoutMs: 1000,
      operationTimeoutMs: 3000,
      maxBytes: 100000,
    },
  })
  try {
    await storage.verifyBackend({ backend: 'v4-synthetic', bucket: 'synthetic' })
    const bytes = await sharp({ create: { background: 'red', channels: 3, height: 2, width: 3 } })
      .png()
      .toBuffer()
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const destination = { backend: 'v4-synthetic', bucket: 'synthetic' }
    await assert.rejects(
      storage.putImmutable({
        bytes,
        contentType: 'image/png',
        ref: { ...destination, key: `e2-official/revision/red/${sha256}` },
      }),
      { code: 'INVALID_REF' },
    )
    const ref = seed.officialExampleRef({
      adminId: 37,
      destination,
      sha256,
      uuid: '4abeb86c-9019-44af-85e7-2f85a84ee05b',
    })
    assert.equal(ref.key, `references/37/4abeb86c-9019-44af-85e7-2f85a84ee05b/${sha256}`)
    const facts = await storage.putImmutable({ bytes, contentType: 'image/png', ref })
    const returned = await storage.getVerified({ expected: facts, ref })
    assert.equal(returned.sha256, sha256)
    assert.deepEqual(Buffer.from(returned.bytes), bytes)
    assert(
      http.requests.some(
        (request) =>
          request.key === ref.key && request.method === 'PUT' && request.conditional === '*',
      ),
    )
    assert.throws(() =>
      seed.officialExampleRef({
        adminId: 0,
        destination,
        sha256,
        uuid: '4abeb86c-9019-44af-85e7-2f85a84ee05b',
      }),
    )
  } finally {
    storage.close()
    await http.close()
  }
})

test('should separate initialization and close its formal command', async () => {
  const api = await load()
  assert.equal(api.e2ModeAction({ mode: 'initialize' }), 'initialize-fresh-e2')
  assert.throws(() => api.e2ModeAction({ mode: 'inspection' }))
  assert.equal(api.selectE2Role({ profileId: 'e2-local', role: 'core-init' }).role, 'core-init')
  const app = `${api.E2_DIRECTORY}/source/payload/apps/heymoro`
  const jsonFile = `${api.E2_DIRECTORY}/E2-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/core-e2.json`
  const command = api.e2InitializationCommand({ app, jsonFile })
  assert.deepEqual(command.args, [
    '--import',
    'tsx',
    `${app}/scripts/init-target.mjs`,
    '--config',
    jsonFile,
  ])
  assert.equal(command.timeout, 60_000)
  assert.equal(command.name, 'core-init')
  assert.throws(() => api.e2InitializationCommand({ app: '/other', jsonFile: '/other/core.json' }))
})

test('should require an absent nonsymbolic leaf and canonical parent', async () => {
  const api = await load()
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2-fresh-rules-')))
  const filename = path.join(parent, 'target')
  assert.equal(api.assertMissingE2Leaf({ filename }), filename)
  mkdirSync(filename)
  assert.throws(() => api.assertMissingE2Leaf({ filename }))
  symlinkSync(path.join(parent, 'missing'), path.join(parent, 'dangling'))
  assert.throws(() => api.assertMissingE2Leaf({ filename: path.join(parent, 'dangling') }))
  symlinkSync(parent, path.join(parent, 'link'))
  assert.throws(() => api.assertMissingE2Leaf({ filename: path.join(parent, 'link', 'absent') }))
})

function readyFixture({ api }) {
  const profile = {
    format: 1,
    profile: 'heymoro-core',
    nonce: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    state: 'ready',
    fingerprint: 'a'.repeat(64),
  }
  const binding = {
    ...api.e2RevisionBinding({ revisionId: '01234567-89ab-4cde-8fab-0123456789ab' }),
    authorityFile: '/private/tmp/synthetic-authority.json',
    authoritySHA: 'd'.repeat(64),
    sourceManifestSHA: '9'.repeat(64),
    readySHA: 'b'.repeat(64),
    profileSHA: 'c'.repeat(64),
    profileNonce: profile.nonce,
    targetFingerprint: profile.fingerprint,
  }
  const receipt = {
    format: 2,
    approvedBy: 'root',
    action: 'approve-fresh-e2-ready',
    ...binding,
    authoritySHA: 'd'.repeat(64),
    verificationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    jsonSHA: 'e'.repeat(64),
    controlSHA: 'f'.repeat(64),
    initializer: { commandId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', exit: 0 },
    attest: {
      commandId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      exit: 0,
      evidenceSHA: '1'.repeat(64),
    },
  }
  const epoch = `${api.E2_DIRECTORY}/E2-${receipt.verificationId}`
  Object.assign(receipt, {
    jsonFile: `${epoch}/core-e2.json`,
    controlFile: `${epoch}/control.json`,
    initializationFile: `${epoch}/initialization.json`,
    initializationSHA: '2'.repeat(64),
    reportFile: `${epoch}/report.json`,
    reportSHA: '3'.repeat(64),
  })
  receipt.attest.evidenceFile = `${epoch}/journal/attest-73.jsonl`
  delete receipt.readySHA
  return { binding, profile, receipt }
}

test('should bind root ready approval to target nonce profile SHA and actual commands', async () => {
  const api = await load()
  const { binding, profile, receipt } = readyFixture({ api })
  api.assertE2ReadyReceipt({ binding, profile, receipt, receiptSHA: binding.readySHA })
  for (const [field, value] of [
    ['targetDir', `${api.E2_DIRECTORY}/new-target`],
    ['profileNonce', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'],
    ['profileSHA', '9'.repeat(64)],
    ['revisionId', '97e870b1-edf2-49d0-becc-e8c28eca93c9'],
    ['authorityFile', '/private/tmp/wrong-authority.json'],
    ['authoritySHA', '8'.repeat(64)],
    ['sourceManifestSHA', '7'.repeat(64)],
    ['format', 1],
    ['action', 'reuse-inspected-bootstrap'],
  ])
    assert.throws(() =>
      api.assertE2ReadyReceipt({
        binding,
        profile,
        receipt: { ...receipt, [field]: value },
        receiptSHA: binding.readySHA,
      }),
    )
  assert.throws(() =>
    api.assertE2ReadyReceipt({ binding, profile, receipt, receiptSHA: '0'.repeat(64) }),
  )
  assert.throws(() =>
    api.assertE2ReadyReceipt({
      binding,
      profile: { ...profile, state: 'prepared' },
      receipt,
      receiptSHA: binding.readySHA,
    }),
  )
  assert.throws(() =>
    api.assertE2ReadyReceipt({
      binding,
      profile,
      receipt: { ...receipt, initializer: { ...receipt.initializer, exit: 1 } },
      receiptSHA: binding.readySHA,
    }),
  )
})

test('should gate initialization before any product command', async () => {
  const api = await import('./creation/next-http-e2-revision.mjs')
  assert.equal(typeof api.assertE2ExecutionGate, 'function')
  const expected = {
    mode: 'initialize',
    verificationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    authorityFile: '/private/tmp/synthetic-authority.json',
    authoritySHA: 'a'.repeat(64),
    binding: (await load()).e2RevisionBinding({
      revisionId: '01234567-89ab-4cde-8fab-0123456789ab',
    }),
    kernelPolicySHA: 'c'.repeat(64),
    ports: { redis: 12001, s3: 12002, next: 12003 },
    frozenInputs: { '/synthetic/control.json': 'b'.repeat(64) },
  }
  const approval = {
    format: 3,
    approvedBy: 'root',
    action: 'initialize-fresh-e2',
    authorityFile: expected.authorityFile,
    binding: expected.binding,
    kernelPolicySHA: expected.kernelPolicySHA,
    verificationId: expected.verificationId,
    authoritySHA: expected.authoritySHA,
    ports: expected.ports,
    frozenInputs: expected.frozenInputs,
  }
  for (const changed of [
    null,
    {},
    { ...approval, action: 'run-e2-epoch' },
    { ...approval, verificationId: 'other' },
    { ...approval, frozenInputs: {} },
  ])
    assert.throws(() => api.assertE2ExecutionGate({ ...expected, approval: changed }))
  api.assertE2ExecutionGate({ ...expected, approval })
  const spike = readFileSync(new URL('./creation/next-http-e2-spike.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(spike, /bootstrapPreparation|next-business-seed\.ts|recoverBootstrap/)
  assert.match(spike, /initializeE2Target/)
})

test('should deny synthetic legacy target reads and writes without opening the old target', async () => {
  const api = await load()
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2-old-denial-')))
  const old = path.join(root, 'synthetic-old-target')
  mkdirSync(old)
  const filename = path.join(old, 'synthetic.txt')
  writeFileSync(filename, 'owned synthetic')
  const policy = api.e2KernelProfile({
    role: 'core-init',
    writeRoot: realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2-init-policy-'))),
    ports: { redis: 12001, s3: 12002, next: 12003 },
    protectedRoots: [old],
    oldDataRoots: [old],
    immutablePaths: [],
  })
  for (const args of [
    ['-c', 'cat "$1"', 'owned', filename],
    ['-c', 'printf changed > "$1"', 'owned', filename],
  ]) {
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, '/bin/sh', ...args], {
      encoding: 'utf8',
      timeout: 3000,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Operation not permitted|Permission denied/)
  }
  assert.equal(readFileSync(filename, 'utf8'), 'owned synthetic')
})

test('current-template publication records post-save execution proof without a version review', async () => {
  const { publishE2Template } = await import('./creation/next-business-seed.ts')
  const { compileCurrentTemplate } = await import('../src/creation/domain/current-template.ts')
  const caps = {
    allowedMimeTypes: ['image/png'],
    minImages: 0,
    maxImages: 4,
    maxImageBytes: 1000,
    maxTotalImageBytes: 4000,
    maxDescriptionLength: 100,
    maxNotesLength: 100,
  }
  const configuration = {
    capabilities: ['v1'],
    hostCaps: caps,
    execution: {
      registry: {
        image: {
          provider: 'fixture',
          model: 'fixture',
          allowedParameters: [],
          parameterRules: {},
          storageBackends: ['fixture'],
        },
      },
      storageOutput: { backend: 'fixture', bucket: 'output', keyRule: 'task-attempt-result-v1' },
    },
  }
  const row = {
    id: 2,
    kind: 'free',
    code: 'free',
    status: 'offline',
    isDeleted: false,
    costCredits: 2,
    schemaVersion: 1,
    minClientCapability: 'v1',
    displayConfigJson: '{"name":"Free"}',
    inputSchemaJson: JSON.stringify({ ...caps, maxNotesLength: 0 }),
    generationConfigJson: '{"executorId":"image","parameters":{},"systemPrompt":"Draw"}',
  }
  const calls = []
  const stage = await publishE2Template({
    adminId: 1,
    kind: 'free',
    templateId: 2,
    configuration,
    templates: {
      setStatus: async (command) => {
        calls.push(command)
        row.status = command.status
      },
      get: async () => row,
    },
  })
  assert.deepEqual(calls, [{ adminId: 1, templateId: 2, status: 'published' }])
  assert.equal(
    stage.configurationHash,
    compileCurrentTemplate({
      template: row,
      acceptedCapabilities: configuration.capabilities,
      execution: configuration.execution,
      hostCaps: caps,
    }).configurationHash,
  )
  assert.match(stage.exampleMediaHash, /^[a-f0-9]{64}$/)
  assert.equal(stage.state, 'incomplete')
  assert.equal(stage.isDatasetOwner, false)
  assert.equal(/versionId|reviewHash/.test(JSON.stringify(stage)), false)
})

test('should not promote a stage or failed final readback', async () => {
  const seed = await import('./creation/next-business-seed.ts')
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2-dataset-final-')))
  const filename = path.join(directory, 'candidate.json')
  const owner = { state: 'complete', format: 2, readbackSHA: '' }
  await assert.rejects(
    seed.completeE2Dataset({
      filename,
      owner,
      readback: async () => {
        throw new Error('final readback failed')
      },
    }),
  )
  assert.throws(() => readFileSync(filename))
  await assert.rejects(
    seed.completeE2Dataset({
      filename,
      owner: { ...owner, state: 'incomplete' },
      readback: async () => 'a'.repeat(64),
    }),
  )
  assert.throws(() => readFileSync(filename))
  await seed.completeE2Dataset({ filename, owner, readback: async () => 'a'.repeat(64) })
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).readbackSHA, 'a'.repeat(64))
})

async function flatFixture() {
  const api = await import('./creation/next-http-e2-revision.mjs')
  const profile = await load()
  const binding = profile.e2RevisionBinding({ revisionId: '01234567-89ab-4cde-8fab-0123456789ab' })
  const a = 'a'.repeat(64)
  const sourceManifest = {
    'payload/apps/heymoro/next-env.d.ts': a,
    'payload/apps/heymoro/next.config.mjs': a,
    'payload/apps/heymoro/src/creation/application/generation-reader-types.ts': a,
    'payload/apps/heymoro/src/creation/infrastructure/payload/generation-reader.ts': a,
    'payload/apps/heymoro/src/creation/infrastructure/payload/generation-worker-writer.ts': a,
    ...Object.fromEntries(api.E2_CONTROLLER_PATHS.map((filename) => [filename, a])),
  }
  const overlaySources = {
    'payload/apps/heymoro/next.config.mjs':
      'export default {\n  webpack(config, { isServer, nextRuntime }) {\n    config.resolve.extensionAlias = {\n    }\n    return config\n  }\n}\n',
    'payload/apps/heymoro/next-env.d.ts':
      'import "./.next-creation-check/dev/types/routes.d.ts";\nimport "./.next-creation-check/dev/types/root-params.d.ts";\n',
  }
  const overlays = Object.fromEntries(
    api.E2_OVERLAY_PATHS.map((filename) => {
      const sourceBytes = Buffer.from(overlaySources[filename])
      const runtimeBytes = api.e2OverlayBytes({ filename, sourceBytes, mirror: binding.mirror })
      sourceManifest[filename] = api.shaBytes({ bytes: sourceBytes })
      return [
        filename,
        {
          sourceSHA: sourceManifest[filename],
          runtimeSHA: api.shaBytes({ bytes: runtimeBytes }),
          runtimeBase64: runtimeBytes.toString('base64'),
        },
      ]
    }),
  )
  const actualManifest = api.e2ActualManifest({ authority: { sourceManifest, overlays } })
  const beforeManifest = { ...actualManifest }
  delete beforeManifest[
    'payload/apps/heymoro/src/creation/infrastructure/payload/generation-worker-writer.ts'
  ]
  beforeManifest['payload/apps/heymoro/src/creation/infrastructure/payload/generation-reader.ts'] =
    'b'.repeat(64)
  const changes = Object.entries(actualManifest)
    .filter(([name, sha]) => beforeManifest[name] !== sha)
    .map(([filename, afterSHA]) => ({
      filename,
      afterSHA,
      beforeSHA: beforeManifest[filename] ?? null,
    }))
  const state = (files) => ({ head: 'synthetic-head', trackedDiffs: {}, files })
  const preserved = {
    payload: state(
      Object.fromEntries(
        Object.entries(sourceManifest)
          .filter(([name]) => name.startsWith('payload/'))
          .map(([name, sha]) => [name.slice(8), sha]),
      ),
    ),
    taro: state({ 'synthetic-current-client.ts': a }),
    'ai-engine': state({ 'synthetic-current-sdk.ts': a }),
  }
  const authority = {
    format: 3,
    profileId: 'e2-local',
    action: 'prepare-source-only',
    approvedBy: 'root',
    ...binding,
    sourceManifest,
    sourceManifestSHA: api.manifestSHA({ manifest: sourceManifest }),
    controllerHashes: Object.fromEntries(api.E2_CONTROLLER_PATHS.map((filename) => [filename, a])),
    beforeManifest,
    actualManifest,
    changes,
    overlays,
    targetFingerprint: 'f'.repeat(64),
    historicalProofs: {
      [`${profile.E2_DIRECTORY}/core.json`]: a,
      [`${profile.E2_DIRECTORY}/guard.json`]: a,
      ...Object.fromEntries(
        Object.entries(api.E2_PARENT_HASHES).map(([name, sha]) => [
          `${profile.E2_DIRECTORY}/proof/${name}`,
          sha,
        ]),
      ),
    },
    oldTargets: [`${profile.E2_DIRECTORY}/new-target`, `${profile.E2_DIRECTORY}/e2-product-target`],
    historicalDirectories: [
      `${profile.E2_DIRECTORY}/E2-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
      `${profile.E2_DIRECTORY}/proof/compiler-acks`,
    ],
    preserved,
    repositories: Object.fromEntries(
      Object.entries(preserved).map(([repo, entry]) => [
        repo,
        { head: entry.head, trackedDiffs: entry.trackedDiffs, staged: '' },
      ]),
    ),
  }
  return { api, profile, authority }
}

test('should bind a flat current-source approval without historical source inheritance or fixed runtime leaves', async () => {
  const { api, authority } = await flatFixture()
  api.assertE2AuthorityShape({ authority })
  for (const mutate of [
    (a) => {
      a.format = 2
    },
    (a) => {
      a.targetDir += '/child'
    },
    (a) => {
      a.writeRoot = '/'
    },
    (a) => {
      a.controllerInheritance = {}
    },
    (a) => {
      a.sourceManifestSHA = '0'.repeat(64)
    },
    (a) => {
      a.overlays['payload/apps/heymoro/next.config.mjs'].runtimeBase64 += '\n'
    },
    (a) => {
      a.overlays['payload/apps/heymoro/next.config.mjs'].runtimeSHA = '0'.repeat(64)
    },
    (a) => {
      a.changes.pop()
    },
    (a) => {
      a.changes.push(a.changes[0])
    },
    (a) => {
      a.changes[0].beforeSHA = '0'.repeat(64)
    },
    (a) => {
      a.actualManifest['payload/apps/heymoro/next.config.mjs'] = '0'.repeat(64)
    },
    (a) => {
      a.sourceManifest['payload/apps/heymoro/next-env.d.ts'] =
        a.actualManifest['payload/apps/heymoro/next-env.d.ts']
    },
    (a) => {
      a.controllerHashes[api.E2_CONTROLLER_PATHS[0]] = '0'.repeat(64)
    },
    (a) => {
      a.preserved.payload.files['apps/heymoro/next.config.mjs'] = '0'.repeat(64)
    },
    (a) => {
      a.repositories.taro.head = 'drift'
    },
    (a) => {
      a.historicalProofs[a.historicalDirectories[1]] = '0'.repeat(64)
    },
    (a) => {
      a.historicalDirectories.push(`${a.directory}/proof`)
    },
    (a) => {
      delete a.historicalProofs[`${a.directory}/core.json`]
    },
    (a) => {
      delete a.historicalProofs[`${a.directory}/guard.json`]
    },
    (a) => {
      a.oldTargets.pop()
    },
    (a) => {
      a.oldTargets.push(a.targetDir)
    },
    (a) => {
      delete a.historicalProofs[Object.keys(a.historicalProofs)[0]]
    },
    (a) => {
      a.trustPredicate = 'self approval'
    },
  ]) {
    const changed = structuredClone(authority)
    mutate(changed)
    assert.throws(() => api.assertE2AuthorityShape({ authority: changed }))
  }
})

test('should require external authority locator and SHA and reject self-authenticated or legacy inputs', async () => {
  const api = await import('./creation/next-http-e2-revision.mjs')
  for (const args of [
    undefined,
    {},
    { authorityFile: '/tmp/authority.json' },
    { authoritySHA: 'a'.repeat(64) },
  ])
    assert.throws(() => api.readE2Authority(args))
  const spike = await import('./creation/next-http-e2-spike.mjs')
  for (const args of [
    [],
    ['--initialize-and-wait'],
    ['--prepare-and-wait', '--authority', '/tmp/a'],
    ['--wat'],
    ['--prepare-and-wait', '--authority', '/tmp/a', '--authority-sha', 'a'.repeat(64), '--extra'],
  ])
    assert.throws(() => spike.parseE2CLI({ args }))
  assert.deepEqual(
    spike.parseE2CLI({
      args: [
        '--initialize-and-wait',
        '--authority',
        '/private/tmp/approved.json',
        '--authority-sha',
        'a'.repeat(64),
      ],
    }),
    {
      mode: 'initialize',
      authorityFile: '/private/tmp/approved.json',
      authoritySHA: 'a'.repeat(64),
    },
  )
})

test('should derive fresh direct target ready and dataset leaves for each revision and reject unsafe source filenames', async () => {
  const api = await load()
  const one = api.e2RevisionBinding({ revisionId: '01234567-89ab-4cde-8fab-0123456789ab' })
  const two = api.e2RevisionBinding({ revisionId: '11234567-89ab-4cde-8fab-0123456789ab' })
  assert.notEqual(one.targetDir, two.targetDir)
  assert.equal(path.dirname(one.targetDir), api.E2_DIRECTORY)
  assert.match(one.targetDir, /e2-target-01234567/)
  for (const revisionId of ['', '../x', 'e86bf687-958d-495d-9126-9cf3ff903a44/child'])
    assert.throws(() => api.e2RevisionBinding({ revisionId }))
  for (const filename of ['a\nb.ts', 'a\rb.ts', 'a\tb.ts', '-option', 'a/../b.ts'])
    assert.throws(() => api.assertRelativeSource({ filename }))
})

test('should reject stages and legacy datasets before wx owner promotion', async () => {
  const api = await load()
  const { binding } = readyFixture({ api })
  const dataset = {
    format: 2,
    state: 'complete',
    revisionId: binding.revisionId,
    targetDir: binding.targetDir,
    readyFile: binding.readyFile,
    readySHA: binding.readySHA,
    datasetConfigSHA: 'a'.repeat(64),
    readbackSHA: 'b'.repeat(64),
    adminId: 1,
    templates: [
      {
        kind: 'free',
        templateId: 2,
        configurationHash: 'd'.repeat(64),
        exampleMediaHash: 'e'.repeat(64),
      },
      {
        kind: 'effect',
        templateId: 4,
        configurationHash: 'd'.repeat(64),
        exampleMediaHash: 'e'.repeat(64),
      },
    ],
    examples: [
      { id: 6, recipe: 'red', sha256: 'f'.repeat(64) },
      { id: 7, recipe: 'blue', sha256: 'f'.repeat(64) },
    ],
  }
  const control = {
    ...binding,
    revisionId: binding.revisionId,
    targetDir: binding.targetDir,
    ready: binding,
    datasetConfigSHA: dataset.datasetConfigSHA,
  }
  api.assertE2DatasetReceipt({ dataset, control })
  for (const patch of [
    { state: 'incomplete' },
    { format: 1 },
    { targetDir: `${api.E2_DIRECTORY}/new-target` },
    { readySHA: '0'.repeat(64) },
    { readbackSHA: '' },
    { templates: [] },
    { examples: [] },
  ])
    assert.throws(() => api.assertE2DatasetReceipt({ dataset: { ...dataset, ...patch }, control }))
})

test('should keep initialization outputs mutable until initialization and reject premature business services', async () => {
  const api = await load()
  const source = readFileSync(new URL('./creation/next-http-e2-spike.mjs', import.meta.url), 'utf8')
  assert.match(source, /mode === 'business'/)
  const fixture = await import('./creation/next-http-fixture.mjs')
  await assert.rejects(
    fixture.initializeE2Target({ fixture: { e2: { control: { mode: 'business' } } } }),
  )
  await assert.rejects(
    fixture.runE2Worker({
      fixture: { e2: { control: { mode: 'initialize' }, initialized: false } },
      role: 'seed',
    }),
  )
  const policy = api.e2KernelProfile({
    role: 'core-init',
    writeRoot: realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2-init-policy-'))),
    ports: { redis: 12001, s3: 12002, next: 12003 },
    protectedRoots: ['/owned/old'],
    oldDataRoots: ['/owned/old'],
    immutablePaths: [],
  })
  assert.doesNotMatch(policy, /e2-product-target|allow network-(bind|inbound)/)
})

test('should bind root ready approval to the actual initialized epoch files and closed command ledger', async () => {
  const api = await load()
  const { receipt } = readyFixture({ api })
  const epoch = `${api.E2_DIRECTORY}/E2-${receipt.verificationId}`
  Object.assign(receipt, {
    jsonFile: `${epoch}/core-e2.json`,
    controlFile: `${epoch}/control.json`,
    initializationFile: `${epoch}/initialization.json`,
    initializationSHA: '2'.repeat(64),
    reportFile: `${epoch}/report.json`,
    reportSHA: '3'.repeat(64),
  })
  const initialization = {
    format: 2,
    authorityFile: receipt.authorityFile,
    sourceManifestSHA: receipt.sourceManifestSHA,
    revisionId: receipt.revisionId,
    authoritySHA: receipt.authoritySHA,
    controlSHA: receipt.controlSHA,
    jsonSHA: receipt.jsonSHA,
    verificationId: receipt.verificationId,
    targetDir: receipt.targetDir,
    targetFingerprint: receipt.targetFingerprint,
    profileSHA: receipt.profileSHA,
    profileNonce: receipt.profileNonce,
    initializer: receipt.initializer,
  }
  const report = {
    profileId: 'e2-local',
    mode: 'initialize',
    status: 'initialized-awaiting-root',
    servicesClosed: true,
    cleanupUnconfirmed: false,
    activeLeases: [],
    rounds: [],
    httpTraces: [],
    error: null,
    targetDir: receipt.targetDir,
    profileSHA: receipt.profileSHA,
    profileNonce: receipt.profileNonce,
    attestEvidenceSHA: receipt.attest.evidenceSHA,
    attestEvidenceFile: receipt.attest.evidenceFile,
    authorityFile: receipt.authorityFile,
    sourceManifestSHA: receipt.sourceManifestSHA,
    revisionId: receipt.revisionId,
    authoritySHA: receipt.authoritySHA,
    verificationId: receipt.verificationId,
    initializationFile: receipt.initializationFile,
    initializationSHA: receipt.initializationSHA,
    commands: [
      { name: 'core-init', ...receipt.initializer, signal: null },
      {
        name: 'attest',
        commandId: receipt.attest.commandId,
        exit: 0,
        signal: null,
        nodePids: [73],
      },
    ],
  }
  const attestation = {
    event: 'ready',
    role: 'attest',
    pid: 73,
    verificationId: receipt.verificationId,
    details: {
      targetFingerprint: receipt.targetFingerprint,
      nativeEnv: 1,
      publicOutbound: 1,
      sealedNative: 1,
      sealedNode: 1,
      unregisteredLoopback: 1,
      workerBind: 1,
    },
  }
  receipt.attest.evidenceSHA = (await import('./creation/next-http-e2-revision.mjs')).shaBytes({
    bytes: JSON.stringify(attestation),
  })
  report.attestEvidenceSHA = receipt.attest.evidenceSHA
  const hashes = {
    jsonSHA: receipt.jsonSHA,
    controlSHA: receipt.controlSHA,
    initializationSHA: receipt.initializationSHA,
    reportSHA: receipt.reportSHA,
    attestEvidenceSHA: receipt.attest.evidenceSHA,
  }
  api.assertE2ReadyEvidence({ receipt, initialization, report, hashes, attestation })
  assert.throws(() =>
    api.assertE2ReadyEvidence({
      receipt,
      initialization,
      report,
      hashes,
      attestation: { ...attestation, verificationId: 'unrelated' },
    }),
  )
  for (const key of Object.keys(hashes))
    assert.throws(() =>
      api.assertE2ReadyEvidence({
        receipt,
        attestation,
        initialization,
        report,
        hashes: { ...hashes, [key]: '0'.repeat(64) },
      }),
    )
  assert.throws(() =>
    api.assertE2ReadyEvidence({
      receipt,
      attestation,
      initialization: { ...initialization, verificationId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' },
      report,
      hashes,
    }),
  )
  assert.throws(() =>
    api.assertE2ReadyEvidence({
      receipt,
      attestation,
      initialization,
      report: { ...report, servicesClosed: false },
      hashes,
    }),
  )
  assert.throws(() =>
    api.assertE2ReadyEvidence({
      receipt,
      attestation,
      initialization,
      report: {
        ...report,
        commands: report.commands.map((command) => ({
          ...command,
          commandId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        })),
      },
      hashes,
    }),
  )
})

test('should reject Next and repeated initialization in initialize-only mode before authority or spawn', async () => {
  const fixture = await import('./creation/next-http-fixture.mjs')
  assert.throws(
    () => fixture.startE2Next({ fixture: { e2: { control: { mode: 'initialize' } } }, round: 1 }),
    /Business mode required/,
  )
  await assert.rejects(
    fixture.initializeE2Target({
      fixture: { e2: { control: { mode: 'initialize' }, initialized: true } },
    }),
    /Initialization already completed/,
  )
})

test('should confine native writes to one canonical root including sibling and symlink denial', async () => {
  const api = await load()
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2-confinement-')))
  const inside = path.join(root, 'write')
  const outside = path.join(root, 'outside')
  const sibling = `${inside}-sibling`
  for (const folder of [
    inside,
    outside,
    sibling,
    path.join(inside, 'source'),
    path.join(inside, 'old-target'),
    path.join(inside, 'historical-compiler-acks'),
    path.join(inside, 'new-epoch-compiler-acks'),
  ])
    mkdirSync(folder)
  const normal = path.join(inside, 'normal')
  const sealed = path.join(inside, 'sealed.json')
  const source = path.join(inside, 'source', 'source.ts')
  const old = path.join(inside, 'old-target', 'data')
  for (const filename of [
    normal,
    sealed,
    source,
    old,
    path.join(outside, 'existing'),
    path.join(sibling, 'existing'),
  ])
    writeFileSync(filename, 'before')
  symlinkSync(outside, path.join(inside, 'link'))
  const input = {
    role: 'attest',
    writeRoot: inside,
    ports: { redis: 12001, s3: 12002, next: 12003 },
    protectedRoots: [
      path.dirname(source),
      path.dirname(old),
      path.join(inside, 'historical-compiler-acks'),
    ],
    oldDataRoots: [path.dirname(old)],
    immutablePaths: [sealed],
  }
  for (const writeRoot of [
    undefined,
    '/',
    path.dirname(inside),
    `${inside}/`,
    path.join(inside, 'link'),
  ]) {
    if (writeRoot === path.dirname(inside)) continue // real-run binding, not the generic synthetic kernel, rejects a different canonical root.
    assert.throws(() => api.e2KernelProfile({ ...input, writeRoot }))
  }
  const policy = api.e2KernelProfile(input)
  const run = (filename) =>
    spawnSync(
      '/usr/bin/sandbox-exec',
      ['-p', policy, '/bin/sh', '-c', 'printf changed > "$1"', 'synthetic', filename],
      { encoding: 'utf8', timeout: 10000 },
    )
  for (const filename of [
    normal,
    path.join(inside, 'new'),
    path.join(inside, 'new-epoch-compiler-acks', 'ack.json'),
    '/dev/null',
  ])
    assert.equal(run(filename).status, 0)
  for (const filename of [
    sealed,
    source,
    old,
    path.join(outside, 'existing'),
    path.join(outside, 'new'),
    path.join(sibling, 'existing'),
    path.join(sibling, 'new'),
    path.join(inside, 'link', 'escaped'),
    path.join(inside, 'historical-compiler-acks', 'forbidden.json'),
  ])
    assert.notEqual(run(filename).status, 0, filename)
  for (const filename of [
    sealed,
    source,
    old,
    path.join(outside, 'existing'),
    path.join(sibling, 'existing'),
  ])
    assert.equal(readFileSync(filename, 'utf8'), 'before')
  for (const filename of [
    path.join(outside, 'new'),
    path.join(sibling, 'new'),
    path.join(outside, 'escaped'),
  ])
    assert.throws(() => readFileSync(filename))
})

test('should enforce confinement with native node file and sqlite writes without touching an existing database', async () => {
  const api = await load()
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2-node-native-')))
  const writeRoot = path.join(root, 'write')
  const outside = path.join(root, 'outside')
  mkdirSync(writeRoot)
  mkdirSync(outside)
  const sealed = path.join(writeRoot, 'sealed.txt')
  writeFileSync(sealed, 'before')
  const policy = api.e2KernelProfile({
    role: 'attest',
    writeRoot,
    ports: { redis: 12001, s3: 12002, next: 12003 },
    protectedRoots: [],
    oldDataRoots: [],
    immutablePaths: [sealed],
  })
  const script = `
    import assert from 'node:assert/strict';
    import { writeFileSync, readFileSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    const [root, outside, sealed] = process.argv.slice(1);
    writeFileSync(root + '/new.txt', 'owned');
    writeFileSync('/dev/null', 'owned');
    assert.throws(() => writeFileSync(outside + '/new.txt', 'escape'));
    assert.throws(() => writeFileSync(sealed, 'changed'));
    const db = new DatabaseSync(root + '/normal.sqlite');
    db.exec('CREATE TABLE probe (id INTEGER); INSERT INTO probe VALUES (73)');
    assert.equal(db.prepare('SELECT id FROM probe').get().id, 73);
    db.close();
    assert.throws(() => new DatabaseSync(outside + '/outside.sqlite'));
    assert.equal(readFileSync(sealed, 'utf8'), 'before');
  `
  const result = spawnSync(
    '/usr/bin/sandbox-exec',
    [
      '-p',
      policy,
      process.execPath,
      '--input-type=module',
      '-e',
      script,
      writeRoot,
      outside,
      sealed,
    ],
    { encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin' } },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(sealed, 'utf8'), 'before')
  for (const filename of ['new.txt', 'outside.sqlite'])
    assert.throws(() => readFileSync(path.join(outside, filename)))
})

test('should validate sealed Gate B before importing or building the typed product host', () => {
  const source = readFileSync(new URL('./creation/next-business-host.ts', import.meta.url), 'utf8')
  const gate = source.indexOf('\nreadE2Control()')
  assert(gate > 0)
  assert.doesNotMatch(source.slice(0, gate), /^import (?!type).*?(?:sharp|src\/creation)/m)
  assert(source.indexOf("await import('../../src/creation/runtime/payload-config.js')") > gate)
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'tests/creation/next-business-host.ts'],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
      timeout: 10000,
      env: { PATH: process.env.PATH },
    },
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /AssertionError/)
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|SQLITE_|Payload has not/)
})

test('should allow only one initialization and one business epoch and stop partial or repeated attempts before creation', async () => {
  const api = await import('./creation/next-http-e2-revision.mjs')
  const initialized = {
    mode: 'initialize',
    status: 'initialized-awaiting-root',
    verificationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    servicesClosed: true,
    cleanupUnconfirmed: false,
    activeLeases: [],
    rounds: [],
    httpTraces: [],
    error: null,
    commands: [
      { name: 'core-init', exit: 0, signal: null },
      { name: 'attest', exit: 0, signal: null },
    ],
  }
  api.assertE2EpochSequence({ mode: 'initialize', reports: [], initializationVerificationId: null })
  api.assertE2EpochSequence({
    mode: 'business',
    reports: [initialized],
    initializationVerificationId: initialized.verificationId,
  })
  for (const input of [
    { mode: 'initialize', reports: [initialized] },
    { mode: 'business', reports: [] },
    { mode: 'business', reports: [initialized], initializationVerificationId: 'unrelated' },
    { mode: 'business', reports: [{ ...initialized, status: 'prepared-only' }] },
    { mode: 'business', reports: [initialized, { mode: 'business', status: 'failed' }] },
    { mode: 'business', reports: [initialized, { mode: 'business', status: 'passed' }] },
    { mode: 'inspection', reports: [] },
  ])
    assert.throws(() =>
      api.assertE2EpochSequence({
        initializationVerificationId: initialized.verificationId,
        ...input,
      }),
    )
})

test('should preserve approved history while accepting only derived current outputs through initialize ready and business', async () => {
  const { api, authority } = await flatFixture()
  const authorityFile = `${authority.directory}/proof/E2-approved-${authority.revisionId}.json`
  const authoritySHA = 'e'.repeat(64)
  const proofFiles = [...Object.keys(authority.historicalProofs), authorityFile]
  const targetRoots = [...authority.oldTargets]
  const historicalEpochs = Object.fromEntries(
    authority.historicalDirectories
      .filter((filename) => !filename.includes('/proof/'))
      .map((filename) => [filename, null]),
  )
  const input = {
    authority,
    authorityFile,
    authoritySHA,
    proofFiles,
    proofDirectories: [`${authority.directory}/proof/compiler-acks`],
    targetRoots,
    epochs: historicalEpochs,
  }
  api.assertE2HistoricalMembership(input)
  proofFiles.push(...Object.values(api.runtimeFiles({ authority })))
  api.assertE2HistoricalMembership(input)
  const initializationEpoch = `${authority.directory}/E2-11111111-1111-4111-8111-111111111111`
  const currentReport = {
    authorityFile,
    authoritySHA,
    revisionId: authority.revisionId,
    sourceManifestSHA: authority.sourceManifestSHA,
    targetDir: authority.targetDir,
  }
  const epochs = { ...historicalEpochs, [initializationEpoch]: currentReport }
  api.assertE2HistoricalMembership({
    ...input,
    targetRoots: [...targetRoots, authority.targetDir],
    epochs,
  })
  proofFiles.push(authority.readyFile, authority.datasetOwnerFile)
  const businessEpoch = `${authority.directory}/E2-22222222-2222-4222-8222-222222222222`
  api.assertE2HistoricalMembership({
    ...input,
    targetRoots: [...targetRoots, authority.targetDir],
    epochs: { ...epochs, [businessEpoch]: currentReport },
  })
  for (const patch of [
    { proofFiles: [...proofFiles, `${authority.directory}/proof/unapproved.json`] },
    { targetRoots: targetRoots.slice(1) },
    { epochs: { ...epochs, [businessEpoch]: { ...currentReport, authoritySHA: '0'.repeat(64) } } },
    { epochs: {} },
  ])
    assert.throws(() => api.assertE2HistoricalMembership({ ...input, ...patch }))
})

for (const isE2 of [true, false]) {
  test(`should persist ${isE2 ? 'E2 attempt only in its epoch' : 'non-E2 attempt in the legacy proof directory'} with unchanged ownership and updates`, async () => {
    const { persistAttempt } = await import('./creation/next-http-fixture.mjs')
    const revision = await import('./creation/next-http-e2-revision.mjs')
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2R1-attempt-')))
    const proofRoot = path.join(root, 'proof')
    const epochRoot = path.join(root, 'E2-owned-synthetic')
    mkdirSync(proofRoot)
    mkdirSync(epochRoot)
    const historical = path.join(proofRoot, 'historical.json')
    writeFileSync(historical, 'owned historical bytes', { flag: 'wx' })
    const fixture = { directory: root, port: 0, ...(isE2 ? { e2: { epochRoot } } : {}) }
    const processInfo = {
      name: 'attest',
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      pgid: 2_147_483_647,
      pids: new Set([2_147_483_647]),
      nodePids: new Set([2_147_483_647]),
      groups: new Set([2_147_483_647]),
      identities: {},
      compilers: {},
      pendingCompilers: new Set(),
      ownedPorts: [],
      output: 'synthetic first attempt',
    }
    // No process or listener is started. PID/PGID are outside the OS PID range;
    // E2 owns no ports, and the legacy port-zero query cannot address a service.
    const first = persistAttempt({ fixture, processInfo })
    const basename = `attempt-attest-${processInfo.pgid}-${processInfo.attemptId}.json`
    const expected = path.join(isE2 ? epochRoot : proofRoot, basename)
    assert.equal(
      processInfo.attemptFile,
      expected,
      'E2 evidence must not be added to the immutable historical proof directory.',
    )
    assert.equal(readFileSync(historical, 'utf8'), 'owned historical bytes')
    assert.deepEqual(first.groupMembers, [])
    assert.deepEqual(first.alivePIDs, [])
    assert.deepEqual(first.portOwners, [])
    const initial = JSON.parse(readFileSync(expected, 'utf8'))
    assert.equal(initial.attemptId, processInfo.attemptId)
    assert.equal(initial.output, 'synthetic first attempt')
    assert.equal(initial.exit, null)
    assert.deepEqual(initial.groups, [...processInfo.groups])
    assert.deepEqual(initial.pids, [...processInfo.pids])
    assert.deepEqual(initial.nodePids, [...processInfo.nodePids])
    assert.equal(initial.pid, processInfo.pgid)
    assert.equal(initial.pgid, processInfo.pgid)
    processInfo.code = 0
    processInfo.output = 'synthetic completed attempt'
    const second = persistAttempt({ fixture, processInfo, cleanupError: 'synthetic-cleanup-error' })
    assert.equal(processInfo.attemptFile, expected)
    const updatedBytes = readFileSync(expected, 'utf8')
    const updated = JSON.parse(updatedBytes)
    assert.equal(updated.attemptId, initial.attemptId)
    assert.equal(updated.output, processInfo.output)
    assert.equal(updated.exit, 0)
    assert.equal(updated.cleanupError, 'synthetic-cleanup-error')
    assert.deepEqual(second.groupMembers, [])
    assert.deepEqual(second.alivePIDs, [])
    assert.deepEqual(second.portOwners, [])
    assert.deepEqual(
      readdirSync(isE2 ? epochRoot : proofRoot).filter((name) => name.startsWith('attempt-')),
      [basename],
    )
    const collision = { ...processInfo }
    delete collision.attemptFile
    assert.throws(() => persistAttempt({ fixture, processInfo: collision }), { code: 'EEXIST' })
    assert.equal(collision.attemptFile, undefined)
    assert.equal(readFileSync(expected, 'utf8'), updatedBytes)
    const tampered = JSON.stringify({ ...updated, attemptId: 'different-owner' })
    writeFileSync(expected, tampered)
    assert.throws(
      () => persistAttempt({ fixture, processInfo }),
      /Attempt evidence ownership changed/,
    )
    assert.equal(readFileSync(expected, 'utf8'), tampered)
    if (isE2) {
      assert.deepEqual(readdirSync(proofRoot), ['historical.json'])
      const authorityFile = path.join(root, 'authority.json')
      const authoritySHA = 'a'.repeat(64)
      const authority = {
        directory: root,
        changes: [],
        revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        targetDir: path.join(root, 'unused-target'),
        readyFile: path.join(proofRoot, 'unused-ready.json'),
        datasetOwnerFile: path.join(proofRoot, 'unused-owner.json'),
        historicalProofs: { [historical]: revision.shaFile({ filename: historical }) },
        historicalDirectories: [],
        oldTargets: [],
      }
      const membership = () =>
        revision.assertE2HistoricalMembership({
          authority,
          authorityFile,
          authoritySHA,
          proofFiles: readdirSync(proofRoot).map((name) => path.join(proofRoot, name)),
          proofDirectories: [],
          targetRoots: [],
          epochs: {},
        })
      membership()
      writeFileSync(path.join(proofRoot, 'unapproved-attempt.json'), 'owned negative fixture', {
        flag: 'wx',
      })
      assert.throws(membership, /Missing historical proof protection/)
      assert.equal(readFileSync(historical, 'utf8'), 'owned historical bytes')
    }
  })
}

async function businessPreludeFixture() {
  const { createE2LeaseRegistry } = await load()
  const requestId = '4abeb86c-9019-44af-85e7-2f85a84ee05b'
  const fixture = {
    port: 43210,
    report: { assertions: {}, httpTraces: [] },
    e2: {
      leases: createE2LeaseRegistry(),
      control: { verificationId: 'synthetic-business-prelude' },
      codes: { owner: 'private-owner-code-sentinel', foreign: 'private-foreign-code-sentinel' },
    },
  }
  const dataset = {
    templates: [
      { kind: 'free', templateId: 10 },
      { kind: 'effect', templateId: 20 },
    ],
  }
  const replies = [
    { route: '/auth/wechat', status: 201, data: { user: { id: 1 }, token: 'o'.repeat(43) } },
    { route: '/me', status: 200, data: { id: 1 } },
    { route: '/creation-account', status: 200, data: { available: 12, reserved: 0 } },
    { route: '/credits/ledger', status: 200, data: { items: [{ operation: 'grant' }] } },
    { route: '/auth/wechat', status: 201, data: { user: { id: 2 }, token: 'f'.repeat(43) } },
    { route: '/templates', status: 200, data: { items: [{ templateId: 20 }] } },
    {
      route: '/creation-presets/free',
      status: 200,
      data: { templateId: 10 },
    },
  ]
  return { fixture, dataset, replies, requestId }
}

for (const statuses of [
  [201, 201],
  [200, 201],
  [201, 200],
]) {
  test(`should require exact 201 for both real business login calls (${statuses.join('/')})`, async (t) => {
    const api = await import('./creation/next-business-http.mjs')
    const { fixture, dataset, replies, requestId } = await businessPreludeFixture()
    replies[0].status = statuses[0]
    replies[4].status = statuses[1]
    const sentinel = new Error('E2_H1_STOP_AFTER_PRESET')
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (url) => {
      const reply = replies[calls++]
      if (!reply) {
        assert.equal(new URL(url).pathname, '/api/v1/creation-sessions')
        throw sentinel
      }
      assert.equal(new URL(url).pathname, `/api/v1${reply.route}`)
      return Response.json(
        { requestId, data: reply.data },
        {
          status: reply.status,
          headers: { 'x-request-id': requestId, 'cache-control': 'private, no-store' },
        },
      )
    })
    if (statuses.every((status) => status === 201)) {
      await assert.rejects(
        api.businessRoundOne({ fixture, dataset, pngs: [] }),
        (error) => error === sentinel,
      )
      assert.equal(calls, 8)
      assert.equal(fixture.report.assertions.catalogFreePreset.passed, true)
    } else {
      await assert.rejects(
        api.businessRoundOne({ fixture, dataset, pngs: [] }),
        (error) => error.code === 'ERR_ASSERTION' && error.actual === 200 && error.expected === 201,
      )
      assert.equal(calls, statuses[0] === 200 ? 1 : 5)
    }
  })
}

for (const preset of [
  { templateId: 10, templateVersionId: 12 },
  { id: 10, templateVersionId: 11 },
  { templateId: 10, versionNo: 1 },
  { templateId: 99, templateVersionId: 11 },
]) {
  test(`should reject nonformal preset fields before creating a session (${JSON.stringify(preset)})`, async (t) => {
    const api = await import('./creation/next-business-http.mjs')
    const { fixture, dataset, replies, requestId } = await businessPreludeFixture()
    replies[6].data = preset
    let calls = 0
    const sentinel = new Error('E2_H1_STOP_AFTER_PRESET')
    t.mock.method(globalThis, 'fetch', async () => {
      const reply = replies[calls++]
      if (!reply) throw sentinel
      return Response.json(
        { requestId, data: reply.data },
        {
          status: reply.status,
          headers: { 'x-request-id': requestId, 'cache-control': 'private, no-store' },
        },
      )
    })
    await assert.rejects(
      api.businessRoundOne({ fixture, dataset, pngs: [] }),
      (error) => error.code === 'ERR_ASSERTION',
    )
    assert.equal(calls, 7)
    assert.equal(fixture.report.assertions.catalogFreePreset, undefined)
  })
}

for (const concurrent of [false, true]) {
  test(`should retain only safe three-field HTTP diagnostics without retry (${concurrent ? 'concurrent' : 'ordinary'})`, async (t) => {
    const api = await import('./creation/next-business-http.mjs')
    const requestId = '4abeb86c-9019-44af-85e7-2f85a84ee05b'
    const sensitive = 'SENSITIVE_BODY_TOKEN_INPUT_HEADER_SENTINEL'
    const headers = {
      'content-type': 'application/json',
      'x-request-id': requestId,
      'x-private': sensitive,
    }
    const envelope = {
      requestId,
      error: { code: 'NOT_READY', message: sensitive, retryable: false },
      private: sensitive,
    }
    const cases = [
      { body: JSON.stringify(envelope), requestId, code: 'NOT_READY' },
      { body: `<html>${sensitive}</html>`, requestId: null, code: null },
      {
        body: JSON.stringify({ ...envelope, private: sensitive.repeat(200) }),
        requestId: null,
        code: null,
      },
      { body: JSON.stringify({ ...envelope, error: { code: sensitive } }), requestId, code: null },
      {
        body: JSON.stringify({ ...envelope, requestId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
        requestId: null,
        code: 'NOT_READY',
      },
      {
        body: JSON.stringify({ ...envelope, requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
        requestId: null,
        code: 'NOT_READY',
      },
      {
        body: JSON.stringify(envelope),
        headers: { ...headers, 'x-request-id': sensitive },
        requestId: null,
        code: 'NOT_READY',
      },
      {
        body: JSON.stringify({ ...envelope, error: { code: { private: sensitive } } }),
        requestId,
        code: null,
      },
    ]
    let current
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => {
      calls++
      return new Response(current.body, { status: 503, headers: current.headers ?? headers })
    })
    for (const input of cases) {
      current = input
      const { fixture, dataset } = await businessPreludeFixture()
      const before = calls
      const work = concurrent
        ? api.requestConcurrentAdmission({
            fixture,
            token: sensitive,
            body: { input: admissionInput },
          })
        : api.businessRoundOne({ fixture, dataset, pngs: [] })
      await assert.rejects(
        work,
        (error) => error.code === 'ERR_ASSERTION' && !String(error).includes(sensitive),
      )
      assert.equal(calls, before + 1)
      assert.deepEqual(fixture.report.httpTraces, [
        { status: 503, requestId: input.requestId, code: input.code },
      ])
      assert(!JSON.stringify(fixture.report).includes(sensitive))
      assert(!JSON.stringify(fixture.report).includes('private-owner-code-sentinel'))
    }
  })
}

for (const concurrent of [false, true]) {
  test(`should not read an unexpected success body that may contain a token (${concurrent ? 'concurrent' : 'ordinary'})`, async (t) => {
    const api = await import('./creation/next-business-http.mjs')
    const { fixture, dataset } = await businessPreludeFixture()
    let calls = 0
    let reads = 0
    let cancellations = 0
    t.mock.method(globalThis, 'fetch', async () => {
      calls++
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              reads++
              controller.enqueue(new TextEncoder().encode('SENSITIVE_TOKEN_SENTINEL'))
              controller.close()
            },
            cancel() {
              cancellations++
            },
          },
          { highWaterMark: 0 },
        ),
        { status: concurrent ? 202 : 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const work = concurrent
      ? api.requestConcurrentAdmission({
          fixture,
          token: 'private-token',
          body: { input: admissionInput },
        })
      : api.businessRoundOne({ fixture, dataset, pngs: [] })
    await assert.rejects(work, (error) => error.code === 'ERR_ASSERTION')
    assert.equal(calls, 1)
    assert.equal(reads, 0)
    assert.equal(cancellations, 1)
    assert.deepEqual(fixture.report.httpTraces, [
      { status: concurrent ? 202 : 200, requestId: null, code: null },
    ])
    assert(!JSON.stringify(fixture.report).includes('SENSITIVE_TOKEN_SENTINEL'))
  })

  test(
    `should bound error-body reads and abort stalled diagnostics without waiting for cancellation (${concurrent ? 'concurrent' : 'ordinary'})`,
    { timeout: 3000 },
    async (t) => {
      const api = await import('./creation/next-business-http.mjs')
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
      let stalled = false
      let calls = 0
      let reads = 0
      let cancellations = 0
      t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
        assert.equal(milliseconds, 45_000)
        return originalTimeout(stalled ? 10 : milliseconds)
      })
      t.mock.method(globalThis, 'fetch', async () => {
        calls++
        return new Response(
          new ReadableStream(
            {
              pull(controller) {
                reads++
                if (stalled) return new Promise(() => {})
                assert(reads <= 2, 'The bounded diagnostic must not read a third chunk.')
                controller.enqueue(new Uint8Array(reads === 1 ? 2500 : 2000))
              },
              cancel() {
                cancellations++
                return new Promise(() => {})
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 503, headers: { 'content-type': 'application/json' } },
        )
      })
      for (const shouldStall of [false, true]) {
        stalled = shouldStall
        reads = 0
        cancellations = 0
        const before = calls
        const { fixture, dataset } = await businessPreludeFixture()
        const start = Date.now()
        const work = concurrent
          ? api.requestConcurrentAdmission({
              fixture,
              token: 'private-token',
              body: { input: admissionInput },
            })
          : api.businessRoundOne({ fixture, dataset, pngs: [] })
        await assert.rejects(work, (error) => error.code === 'ERR_ASSERTION')
        assert(Date.now() - start < 1500)
        assert.equal(calls, before + 1)
        assert.equal(reads, stalled ? 1 : 2)
        assert.equal(cancellations, 1)
        assert.deepEqual(fixture.report.httpTraces, [{ status: 503, requestId: null, code: null }])
      }
    },
  )
}

function nextConfigSourceFixture() {
  return Buffer.from(
    'export default {\n  webpack(config, { isServer, nextRuntime }) {\n    config.resolve.extensionAlias = {\n    }\n    return config\n  }\n}\n',
  )
}

test('should generate only the exact Node-server replacement plugin while preserving plugins and strict source anchors', async () => {
  const api = await import('./creation/next-http-e2-revision.mjs')
  const require = createRequire(new URL('../package.json', import.meta.url))
  const { webpack } = require('next/dist/compiled/webpack/webpack')
  const mirror = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2R3-recipe-"quoted-')))
  const sourceBytes = nextConfigSourceFixture()
  const filename = 'payload/apps/heymoro/next.config.mjs'
  const bytes = api.e2OverlayBytes({ filename, sourceBytes, mirror })
  assert.match(bytes.toString(), /NormalModuleReplacementPlugin/)
  assert.doesNotMatch(bytes.toString(), /config.resolve.alias/)
  const config = (await import(`data:text/javascript;base64,${bytes.toString('base64')}`)).default
  const existing = { apply() {} }
  for (const [isServer, nextRuntime, expectedCount] of [
    [true, 'nodejs', 2],
    [true, 'edge', 1],
    [false, undefined, 1],
    [true, undefined, 1],
  ]) {
    const plugins = [existing]
    const result = config.webpack({ resolve: {}, plugins }, { isServer, nextRuntime, webpack })
    assert.equal(result.plugins.length, expectedCount)
    assert.equal(result.plugins[0], existing)
    if (expectedCount === 2) {
      assert(result.plugins[1] instanceof webpack.NormalModuleReplacementPlugin)
      assert.equal(
        result.plugins[1].newResource,
        `${mirror}/payload/apps/heymoro/tests/creation/next-business-host.ts`,
      )
      assert.equal(String(result.plugins[1].resourceRegExp), '/^@payload-config$/')
    } else assert.equal(result.plugins, plugins)
  }
  const text = sourceBytes.toString()
  for (const invalid of [
    text.replace('  webpack(config, { isServer, nextRuntime }) {', ''),
    `${text}\n  webpack(config, { isServer, nextRuntime }) {`,
    text.replace('    config.resolve.extensionAlias = {', ''),
    `${text}\n    config.resolve.extensionAlias = {`,
    `${text}\nconfig.resolve.alias = {}`,
    `${text}\nnew webpack.NormalModuleReplacementPlugin`,
  ])
    assert.throws(() => api.e2OverlayBytes({ filename, sourceBytes: Buffer.from(invalid), mirror }))
  assert.throws(() => api.e2OverlayBytes({ filename, sourceBytes: Buffer.from([255]), mirror }))
})

async function overlayMigrationFixture() {
  const input = await flatFixture()
  const filename = 'payload/apps/heymoro/next.config.mjs'
  const sourceBytes = nextConfigSourceFixture()
  const alias = `    config.resolve.alias = { ...config.resolve.alias, '@payload-config': ${JSON.stringify(`${input.authority.mirror}/payload/apps/heymoro/tests/creation/next-business-host.ts`)} }\n`
  const beforeBytes = Buffer.from(
    sourceBytes
      .toString()
      .replace(
        '    config.resolve.extensionAlias = {',
        `${alias}    config.resolve.extensionAlias = {`,
      ),
  )
  input.authority.beforeManifest[filename] = input.api.shaBytes({ bytes: beforeBytes })
  input.authority.changes.push({
    filename,
    beforeSHA: input.authority.beforeManifest[filename],
    afterSHA: input.authority.actualManifest[filename],
  })
  return { ...input, filename, sourceBytes, beforeBytes }
}

test('should approve only the exact original-derived old-alias to new-plugin transition while declarations stay immutable', async () => {
  const { api, authority, filename, sourceBytes } = await overlayMigrationFixture()
  api.assertE2AuthorityShape({ authority })
  api.assertE2OverlayTransition({ authority, filename, sourceBytes })
  const alreadyCurrent = structuredClone(authority)
  alreadyCurrent.beforeManifest[filename] = alreadyCurrent.actualManifest[filename]
  alreadyCurrent.changes = alreadyCurrent.changes.filter((entry) => entry.filename !== filename)
  api.assertE2AuthorityShape({ authority: alreadyCurrent })
  api.assertE2OverlayTransition({ authority: alreadyCurrent, filename, sourceBytes })
  for (const beforeSHA of ['0'.repeat(64), authority.sourceManifest[filename]]) {
    const changed = structuredClone(authority)
    changed.beforeManifest[filename] = beforeSHA
    changed.changes.find((entry) => entry.filename === filename).beforeSHA = beforeSHA
    assert.throws(() =>
      api.assertE2OverlayTransition({ authority: changed, filename, sourceBytes }),
    )
  }
  for (const mutate of [
    (a) => {
      delete a.beforeManifest[filename]
      a.changes.find((entry) => entry.filename === filename).beforeSHA = null
    },
    (a) => {
      a.changes = a.changes.filter((entry) => entry.filename !== filename)
    },
    (a) => {
      a.changes.push(a.changes.find((entry) => entry.filename === filename))
    },
    (a) => {
      const name = 'payload/apps/heymoro/next-env.d.ts'
      a.beforeManifest[name] = 'b'.repeat(64)
      a.changes.push({
        filename: name,
        beforeSHA: 'b'.repeat(64),
        afterSHA: a.actualManifest[name],
      })
    },
    (a) => {
      a.changes.push({
        filename: 'payload/apps/heymoro/unknown.ts',
        beforeSHA: null,
        afterSHA: 'b'.repeat(64),
      })
    },
  ]) {
    const changed = structuredClone(authority)
    mutate(changed)
    assert.throws(() => api.assertE2AuthorityShape({ authority: changed }))
  }
})

test('should plan source-only files-from and a conditional fixed staged overlay with an exact mixed intermediate map', async () => {
  const { api, authority, filename } = await overlayMigrationFixture()
  const plan = api.e2CopyPlan({ authority })
  const files = api.runtimeFiles({ authority })
  assert.equal(
    files.nextConfig,
    `${authority.directory}/proof/E2-runtime-${authority.revisionId}-next-config.mjs`,
  )
  assert(!plan.sourceNames.includes(filename))
  assert(!plan.sourceNames.includes('payload/apps/heymoro/next-env.d.ts'))
  assert.equal(plan.filesFromText, `${plan.sourceNames.join('\n')}\n`)
  assert.deepEqual(
    plan.copies.map(({ kind }) => kind),
    ['source', 'next-config'],
  )
  assert.equal(plan.intermediateManifest[filename], authority.beforeManifest[filename])
  for (const name of plan.sourceNames)
    assert.equal(plan.intermediateManifest[name], authority.actualManifest[name])
  assert.deepEqual(plan.copies[1].args, [
    '-a',
    '--exclude-from=/Users/nako/.codex/backup-excludes.txt',
    files.nextConfig,
    `${authority.mirror}/${filename}`,
  ])
  const current = structuredClone(authority)
  current.beforeManifest = { ...current.actualManifest }
  current.changes = []
  const zero = api.e2CopyPlan({ authority: current })
  assert.deepEqual(zero.copies, [])
  assert.equal(zero.filesFromText, '')
  assert.equal(api.runtimeFiles({ authority: current }).nextConfig, undefined)
  const overlayOnly = structuredClone(authority)
  for (const name of plan.sourceNames)
    overlayOnly.beforeManifest[name] = overlayOnly.actualManifest[name]
  overlayOnly.changes = overlayOnly.changes.filter((entry) => entry.filename === filename)
  assert.deepEqual(
    api.e2CopyPlan({ authority: overlayOnly }).copies.map(({ kind }) => kind),
    ['next-config'],
  )
  assert.deepEqual(api.e2CopyPlan({ authority: overlayOnly }).sourceNames, [])
})

async function ownedCopyFixture() {
  const { api, authority } = await flatFixture()
  const sourceBytes = Object.fromEntries(
    Object.keys(authority.sourceManifest).map((name) => [
      name,
      Buffer.from(`owned immutable source ${name}`),
    ]),
  )
  const config = 'payload/apps/heymoro/next.config.mjs'
  sourceBytes[config] = nextConfigSourceFixture()
  sourceBytes['payload/apps/heymoro/next-env.d.ts'] = Buffer.from(
    'import "./.next-creation-check/dev/types/routes.d.ts";\nimport "./.next-creation-check/dev/types/root-params.d.ts";\n',
  )
  const changed = 'payload/apps/heymoro/src/owned-changed.ts'
  const added = 'payload/apps/heymoro/src/owned-added.ts'
  sourceBytes[changed] = Buffer.from('owned after changed')
  sourceBytes[added] = Buffer.from('owned after added')
  authority.sourceManifest = Object.fromEntries(
    Object.entries(sourceBytes).map(([name, bytes]) => [name, api.shaBytes({ bytes })]),
  )
  const afterBytes = { ...sourceBytes }
  for (const filename of api.E2_OVERLAY_PATHS) {
    const bytes = api.e2OverlayBytes({
      filename,
      sourceBytes: sourceBytes[filename],
      mirror: authority.mirror,
    })
    authority.overlays[filename] = {
      sourceSHA: authority.sourceManifest[filename],
      runtimeSHA: api.shaBytes({ bytes }),
      runtimeBase64: bytes.toString('base64'),
    }
    afterBytes[filename] = bytes
  }
  const beforeBytes = { ...afterBytes }
  const alias = `    config.resolve.alias = { ...config.resolve.alias, '@payload-config': ${JSON.stringify(`${authority.mirror}/payload/apps/heymoro/tests/creation/next-business-host.ts`)} }\n`
  beforeBytes[config] = Buffer.from(
    sourceBytes[config]
      .toString()
      .replace(
        '    config.resolve.extensionAlias = {',
        `${alias}    config.resolve.extensionAlias = {`,
      ),
  )
  beforeBytes[changed] = Buffer.from('owned before changed')
  delete beforeBytes[added]
  authority.sourceManifestSHA = api.manifestSHA({ manifest: authority.sourceManifest })
  authority.controllerHashes = Object.fromEntries(
    api.E2_CONTROLLER_PATHS.map((name) => [name, authority.sourceManifest[name]]),
  )
  authority.preserved.payload.files = Object.fromEntries(
    Object.entries(authority.sourceManifest).map(([name, sha]) => [
      name.slice('payload/'.length),
      sha,
    ]),
  )
  authority.actualManifest = api.e2ActualManifest({ authority })
  authority.beforeManifest = Object.fromEntries(
    Object.entries(beforeBytes).map(([name, bytes]) => [name, api.shaBytes({ bytes })]),
  )
  authority.changes = Object.entries(authority.actualManifest)
    .filter(([name, sha]) => sha !== authority.beforeManifest[name])
    .map(([filename, afterSHA]) => ({
      filename,
      beforeSHA: authority.beforeManifest[filename] ?? null,
      afterSHA,
    }))
  return { api, authority, sourceBytes, beforeBytes, afterBytes, config, changed, added }
}

function syntheticCopyJournal({ api, authority, beforeBytes, sourceBytes }) {
  const plan = api.e2CopyPlan({ authority })
  const revision = {
    authority,
    authorityFile: '/private/tmp/owned-reviewed-authority.json',
    authoritySHA: 'e'.repeat(64),
  }
  const expected = {
    format: 3,
    authorityFile: revision.authorityFile,
    authoritySHA: revision.authoritySHA,
    revisionId: authority.revisionId,
    targetDir: authority.targetDir,
    sourceManifestSHA: authority.sourceManifestSHA,
    beforeManifest: authority.beforeManifest,
    actualManifest: authority.actualManifest,
    changes: authority.changes,
  }
  const intentBytes = `${JSON.stringify({ ...expected, beforeBytes: Object.fromEntries(authority.changes.filter(({ beforeSHA }) => beforeSHA !== null).map(({ filename }) => [filename, beforeBytes[filename].toString('base64')])) }, null, 2)}\n`
  const log = (dry) =>
    plan.copies
      .map(
        (copy) =>
          `${JSON.stringify({ argv: ['/usr/bin/rsync', ...(dry ? ['--dry-run'] : []), '--stats', ...copy.args], cwd: copy.cwd, exit: 0, signal: null, stdout: 'owned synthetic stdout', stderr: '' })}\n`,
      )
      .join('')
  const filesFrom = plan.filesFromText
  const dryLog = log(true)
  const copyLog = log(false)
  const stageBytes = api.runtimeFiles({ authority }).nextConfig
    ? Buffer.from(
        authority.overlays['payload/apps/heymoro/next.config.mjs'].runtimeBase64,
        'base64',
      )
    : undefined
  const proof = {
    ...expected,
    intentSHA: api.shaBytes({ bytes: intentBytes }),
    filesFromSHA: api.shaBytes({ bytes: filesFrom }),
    drySHA: api.shaBytes({ bytes: dryLog }),
    copySHA: api.shaBytes({ bytes: copyLog }),
    ...(stageBytes ? { nextConfigSHA: api.shaBytes({ bytes: stageBytes }) } : {}),
  }
  return {
    revision,
    intentBytes,
    proof,
    filesFrom,
    dryLog,
    copyLog,
    stageBytes,
    sourceBytes: sourceBytes['payload/apps/heymoro/next.config.mjs'],
  }
}

test('should bind complete copy journals to exact stage bytes source-only lists ordered commands and every before byte', async () => {
  const fixture = await ownedCopyFixture()
  const { api, authority, beforeBytes, sourceBytes, config } = fixture
  const journal = syntheticCopyJournal(fixture)
  api.assertE2CopyJournal(journal)
  api.assertE2NextConfigStageBytes({
    authority,
    bytes: journal.stageBytes,
    sourceBytes: sourceBytes[config],
  })
  const oldBytes = beforeBytes[config]
  assert.throws(() =>
    api.assertE2NextConfigStageBytes({
      authority,
      bytes: oldBytes,
      sourceBytes: sourceBytes[config],
    }),
  )
  for (const mutate of [
    (j) => {
      j.stageBytes = undefined
    },
    (j) => {
      j.stageBytes = oldBytes
    },
    (j) => {
      j.stageBytes[0] ^= 1
    },
    (j) => {
      j.sourceBytes = Buffer.from('changed original')
    },
    (j) => {
      j.intentBytes = undefined
    },
    (j) => {
      const intent = JSON.parse(j.intentBytes)
      delete intent.beforeBytes[config]
      j.intentBytes = JSON.stringify(intent)
      j.proof.intentSHA = api.shaBytes({ bytes: j.intentBytes })
    },
    (j) => {
      j.filesFrom += `${config}\n`
      j.proof.filesFromSHA = api.shaBytes({ bytes: j.filesFrom })
    },
    (j) => {
      j.proof.nextConfigSHA = '0'.repeat(64)
    },
    (j) => {
      j.dryLog = ''
      j.proof.drySHA = api.shaBytes({ bytes: j.dryLog })
    },
    (j) => {
      j.copyLog = j.copyLog.trim().split('\n').reverse().join('\n') + '\n'
      j.proof.copySHA = api.shaBytes({ bytes: j.copyLog })
    },
    (j) => {
      const rows = j.dryLog.trim().split('\n').map(JSON.parse)
      rows[1].argv = rows[1].argv.filter((arg) => !arg.startsWith('--exclude-from='))
      j.dryLog = rows.map((row) => JSON.stringify(row) + '\n').join('')
      j.proof.drySHA = api.shaBytes({ bytes: j.dryLog })
    },
    (j) => {
      const rows = j.copyLog.trim().split('\n').map(JSON.parse)
      rows[0].exit = 1
      j.copyLog = rows.map((row) => JSON.stringify(row) + '\n').join('')
      j.proof.copySHA = api.shaBytes({ bytes: j.copyLog })
    },
    (j) => {
      j.proof.revisionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    },
  ]) {
    const changed = {
      ...journal,
      revision: structuredClone(journal.revision),
      proof: structuredClone(journal.proof),
      stageBytes: Buffer.from(journal.stageBytes),
    }
    mutate(changed)
    assert.throws(() => api.assertE2CopyJournal(changed))
  }
  const overlayOnly = structuredClone(authority)
  for (const name of api.e2CopyPlan({ authority }).sourceNames)
    overlayOnly.beforeManifest[name] = overlayOnly.actualManifest[name]
  overlayOnly.changes = overlayOnly.changes.filter(({ filename }) => filename === config)
  const onlyOverlayJournal = syntheticCopyJournal({ ...fixture, authority: overlayOnly })
  api.assertE2CopyJournal(onlyOverlayJournal)
  assert.equal(onlyOverlayJournal.filesFrom, '')
  assert.equal(onlyOverlayJournal.copyLog.trim().split('\n').length, 1)
  const sourceOnly = structuredClone(authority)
  sourceOnly.beforeManifest[config] = sourceOnly.actualManifest[config]
  sourceOnly.changes = sourceOnly.changes.filter(({ filename }) => filename !== config)
  const onlySourceJournal = syntheticCopyJournal({ ...fixture, authority: sourceOnly })
  api.assertE2CopyJournal(onlySourceJournal)
  assert.equal(onlySourceJournal.stageBytes, undefined)
  assert(!Object.hasOwn(onlySourceJournal.proof, 'nextConfigSHA'))
  const current = structuredClone(authority)
  current.beforeManifest = { ...current.actualManifest }
  current.changes = []
  const zero = syntheticCopyJournal({ ...fixture, authority: current })
  api.assertE2CopyJournal(zero)
  assert.throws(() => api.assertE2CopyJournal({ ...zero, stageBytes: journal.stageBytes }))
  assert.throws(() =>
    api.assertE2CopyJournal({
      ...zero,
      proof: { ...zero.proof, nextConfigSHA: journal.proof.nextConfigSHA },
    }),
  )
})

test('should resolve the generated exact replacement before current Next paths without running a compiler', async () => {
  const api = await import('./creation/next-http-e2-revision.mjs')
  const require = createRequire(new URL('../package.json', import.meta.url))
  const { webpack } = require('next/dist/compiled/webpack/webpack')
  const { JsConfigPathsPlugin } = require('next/dist/build/webpack/plugins/jsconfig-paths-plugin')
  const fs = await import('node:fs')
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2R3-resolver-')))
  const production = path.join(root, 'src/payload.config.ts')
  const host = path.join(root, 'payload/apps/heymoro/tests/creation/next-business-host.ts')
  for (const filename of [production, host]) {
    mkdirSync(path.dirname(filename), { recursive: true })
    writeFileSync(filename, 'export default "owned fixture"')
  }
  const bytes = api.e2OverlayBytes({
    filename: 'payload/apps/heymoro/next.config.mjs',
    sourceBytes: nextConfigSourceFixture(),
    mirror: root,
  })
  const generated = (await import(`data:text/javascript;base64,${bytes.toString('base64')}`))
    .default
  const settings = generated.webpack(
    { resolve: {}, plugins: [] },
    { isServer: true, nextRuntime: 'nodejs', webpack },
  )
  const compiler = webpack({
    context: root,
    mode: 'none',
    entry: './not-run.js',
    output: { path: path.join(root, 'not-created-output') },
    plugins: settings.plugins,
  })
  try {
    const factory = compiler.createNormalModuleFactory()
    const beforeResolve = async (request) => {
      const data = { context: root, request, dependencyType: 'esm' }
      await new Promise((resolve, reject) =>
        factory.hooks.beforeResolve.callAsync(data, (error) => (error ? reject(error) : resolve())),
      )
      return data.request
    }
    const resolver = compiler.resolverFactory.get('normal', {
      fileSystem: fs,
      extensions: ['.ts', '.js'],
      alias: { '@payload-config': host },
      plugins: [
        new JsConfigPathsPlugin(
          { '@payload-config': ['./src/payload.config.ts'] },
          { baseUrl: root, isImplicit: true },
        ),
      ],
    })
    const resolve = (request) =>
      new Promise((accept, reject) =>
        resolver.resolve({}, root, request, {}, (error, result) =>
          error ? reject(error) : accept(result),
        ),
      )
    assert.equal(await resolve('@payload-config'), production)
    assert.equal(await beforeResolve('@payload-config'), host)
    assert.equal(await resolve(await beforeResolve('@payload-config')), host)
    assert.equal(await beforeResolve('@payload-config-extra'), '@payload-config-extra')
    assert.equal(await beforeResolve('@payload-config/subpath'), '@payload-config/subpath')
    assert(!readdirSync(root).includes('not-created-output'))
  } finally {
    await new Promise((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('should copy only owned synthetic source then staged config with both dry runs first and exact intermediate bytes', async () => {
  const fixture = await ownedCopyFixture()
  const { api, authority, sourceBytes, beforeBytes, config } = fixture
  const plan = api.e2CopyPlan({ authority })
  const files = api.runtimeFiles({ authority })
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'heymoro-E2R3-rsync-')))
  const source = path.join(root, 'source')
  const mirror = path.join(root, 'mirror')
  const proof = path.join(root, 'proof')
  for (const directory of [source, mirror, proof]) mkdirSync(directory)
  for (const [base, map] of [
    [source, sourceBytes],
    [mirror, beforeBytes],
  ])
    for (const [name, bytes] of Object.entries(map)) {
      const filename = path.join(base, name)
      mkdirSync(path.dirname(filename), { recursive: true })
      writeFileSync(filename, bytes, { flag: 'wx' })
    }
  const remap = (arg) =>
    arg
      .replace(api.E2_SOURCE_ROOT, source)
      .replace(authority.mirror, mirror)
      .replace(`${authority.directory}/proof`, proof)
  const stage = remap(files.nextConfig)
  writeFileSync(stage, Buffer.from(authority.overlays[config].runtimeBase64, 'base64'), {
    flag: 'wx',
    mode: 0o600,
  })
  writeFileSync(remap(files.filesFrom), plan.filesFromText, { flag: 'wx' })
  const savedBefore = Object.fromEntries(
    authority.changes
      .filter(({ beforeSHA }) => beforeSHA !== null)
      .map(({ filename }) => [filename, beforeBytes[filename].toString('base64')]),
  )
  api.writeNewJSON({
    filename: remap(files.intent),
    value: { beforeManifest: authority.beforeManifest, beforeBytes: savedBefore },
  })
  const invocations = []
  const copy = (item, dry) => {
    const args = [...(dry ? ['--dry-run'] : []), '--stats', ...item.args.map(remap)]
    const result = spawnSync('/usr/bin/rsync', args, {
      cwd: source,
      encoding: 'utf8',
      timeout: 10000,
    })
    invocations.push({ kind: item.kind, dry, args, exit: result.status, signal: result.signal })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.signal, null)
  }
  const stageMap = { [path.relative(root, stage)]: authority.overlays[config].runtimeSHA }
  api.verifyHashMap({ root, files: stageMap })
  api.assertE2NextConfigStageBytes({
    authority,
    bytes: readFileSync(stage),
    sourceBytes: sourceBytes[config],
  })
  symlinkSync(stage, path.join(proof, 'wrong-stage-symlink.mjs'))
  assert.throws(() =>
    api.verifyHashMap({
      root,
      files: { 'proof/wrong-stage-symlink.mjs': authority.overlays[config].runtimeSHA },
    }),
  )
  mkdirSync(path.join(proof, 'wrong-stage-directory.mjs'))
  assert.throws(() =>
    api.verifyHashMap({
      root,
      files: { 'proof/wrong-stage-directory.mjs': authority.overlays[config].runtimeSHA },
    }),
  )
  for (const item of plan.copies) copy(item, true)
  api.verifyHashMap({ root: mirror, files: authority.beforeManifest })
  copy(plan.copies[0], false)
  api.verifyHashMap({ root: mirror, files: plan.intermediateManifest })
  assert.equal(
    readFileSync(path.join(mirror, config)).toString('base64'),
    beforeBytes[config].toString('base64'),
  )
  assert.throws(() =>
    api.verifyHashMap({
      root: mirror,
      files: { ...plan.intermediateManifest, [config]: authority.sourceManifest[config] },
    }),
  )
  api.verifyHashMap({ root: source, files: authority.sourceManifest })
  api.verifyHashMap({ root, files: stageMap })
  copy(plan.copies[1], false)
  api.verifyHashMap({ root: mirror, files: authority.actualManifest })
  api.verifyHashMap({ root: source, files: authority.sourceManifest })
  assert.deepEqual(api.readJSON({ filename: remap(files.intent) }).beforeBytes, savedBefore)
  assert.deepEqual(
    invocations.map(({ kind, dry }) => [kind, dry]),
    [
      ['source', true],
      ['next-config', true],
      ['source', false],
      ['next-config', false],
    ],
  )
  assert(
    invocations.every(
      ({ args }) =>
        args.includes('--exclude-from=/Users/nako/.codex/backup-excludes.txt') &&
        !args.some((arg) => /--delete|--copy-links|^-L$/.test(arg)),
    ),
  )
  assert(!readFileSync(remap(files.filesFrom), 'utf8').includes('next.config.mjs'))
})

test('should reject residual or unknown staged siblings instead of inheriting a current journal as history', async () => {
  const { api, authority } = await overlayMigrationFixture()
  const authorityFile = '/private/tmp/owned-overlay-authority.json'
  const authoritySHA = 'a'.repeat(64)
  const files = api.runtimeFiles({ authority })
  const base = {
    authority,
    authorityFile,
    authoritySHA,
    proofFiles: [...Object.keys(authority.historicalProofs), ...Object.values(files)],
    proofDirectories: authority.historicalDirectories.filter((name) => name.includes('/proof/')),
    targetRoots: authority.oldTargets,
    epochs: Object.fromEntries(
      authority.historicalDirectories
        .filter((name) => !name.includes('/proof/'))
        .map((name) => [name, null]),
    ),
  }
  api.assertE2HistoricalMembership(base)
  assert.throws(() =>
    api.assertE2HistoricalMembership({
      ...base,
      proofFiles: [...base.proofFiles, `${files.nextConfig}.unknown-sibling`],
    }),
  )
  const noMigration = structuredClone(authority)
  noMigration.beforeManifest['payload/apps/heymoro/next.config.mjs'] =
    noMigration.actualManifest['payload/apps/heymoro/next.config.mjs']
  noMigration.changes = noMigration.changes.filter(
    ({ filename }) => filename !== 'payload/apps/heymoro/next.config.mjs',
  )
  assert.throws(() => api.assertE2HistoricalMembership({ ...base, authority: noMigration }))
  assert.throws(() =>
    api.assertE2HistoricalMembership({
      ...base,
      authority: noMigration,
      authorityFile: files.nextConfig,
    }),
  )
  for (const filename of [files.nextConfig, `${files.nextConfig}.unknown-sibling`]) {
    const inherited = structuredClone(authority)
    inherited.historicalProofs[filename] = 'b'.repeat(64)
    assert.throws(() => api.assertE2AuthorityShape({ authority: inherited }))
  }
  assert.throws(() => api.materializeE2Revision({ trustPredicate: () => true }))
  assert.throws(() => api.materializeE2Revision({ authoritySHA }))
})
