import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
const load = () => import('./creation/template-admin-run.js')
const loadApproval = () => import('./creation/template-admin-approval.js')
/** @type {() => import('./creation/template-admin-approval.js').Approval} */
const approval = () => ({
  format: 1,
  kind: 'root-approved-template-admin-run',
  runtimeExecutionApproved: true,
  runId: 'unit-run-01',
  checkout: '/owned/checkout',
  distDirectory: '/owned/checkout/apps/heymoro/.template-admin-next/unit-run-01',
  runDirectory: '/owned/run-01',
  node: '/Users/nako/.cache/heymoro/toolchains/node-v24.22.1-darwin-arm64/bin/node',
  browser: '/owned/browser',
  mode: 'dev',
  nextPort: 18181,
  sourceManifestSHA: 'a'.repeat(64),
  sourceFiles: { 'apps/heymoro/src/payload.config.ts': 'b'.repeat(64) },
  budget: {
    durationMs: 80000,
    cleanupMs: 10000,
    objectBytes: 16 * 1048576,
    observerBytes: 64 * 1048576,
    observerEvents: 256,
    memoryMiB: 2048,
    cpu: 2,
    processes: 256,
    diskBytes: 1073741824,
    logBytes: 65536,
  },
  gates: { driver: true, resources: true, cleanCheckout: true, dependencies: true },
  scenarios: ['happy'],
})
test('should export a side-effect-free closed approval parser', async () => {
  const api = await loadApproval()
  assert.equal(typeof api.parseApproval, 'function')
})
test('should reject self-derived receipts, unknown fields, unsafe paths and budgets', async () => {
  const { parseApproval } = await loadApproval()
  const valid = approval()
  assert.equal(parseApproval({ value: valid }).nextPort, 18181)
  for (const mutation of [
    { kind: 'derived-receipt' },
    { runtimeExecutionApproved: false },
    { secret: 'never accepted' },
    { runDirectory: '/owned/checkout/child' },
    { runDirectory: '/owned' },
    { nextPort: 0 },
    { checkout: '/owned/../checkout' },
    { sourceFiles: { '../outside': 'b'.repeat(64) } },
    { budget: { ...valid.budget, durationMs: 90001 } },
    { gates: { ...valid.gates, driver: false } },
    { mode: 'prod' },
    { scenarios: ['unbounded'] },
  ]) {
    assert.throws(() => parseApproval({ value: { ...valid, ...mutation } }))
  }
})
test('should build and freeze the actual fixed core configuration without provider calls', async () => {
  const { buildConfiguration } = await loadApproval()
  const config = buildConfiguration({
    approval: approval(),
    redisURL: 'redis://127.0.0.1:18182',
    endpoint: 'http://127.0.0.1:18183',
    bucket: 'heymoro-unit',
    credentials: { accessKeyId: 'synthetic-only', secretAccessKey: 'synthetic-only' },
  })
  assert.equal(config.imageLimits.maxBytes, 4194304)
  assert.equal(config.imageLimits.maxPixels, 2000000)
  assert.equal(config.hostCaps.maxTotalImageBytes, 8388608)
  assert.equal(config.s3.limits.maxBytes, 4194304)
  assert(config.execution)
  assert.equal(config.execution.registry['template-admin-v1'].model, 'gpt-image-1.5')
  for (const key of /** @type {const} */ (['image', 'quote', 'naming']))
    assert.equal(config[key], null)
  assert.equal(config.identity.wechat, null)
  assert.equal(Object.isFrozen(config.execution.registry), true)
})
test('should clean every acquired lifecycle step in reverse order and never replay', async () => {
  const { acquireLifecycle } = await load()
  for (let failing = 0; failing < 6; failing++) {
    /** @type {string[]} */
    const calls = []
    const steps = ['redis', 'minio', 'observer', 'sdk', 'bootstrap', 'next'].map((name, index) => ({
      name,
      open: async () => {
        calls.push(`open:${name}`)
        if (index === failing) throw Error('injected')
        return {
          close: async () => {
            calls.push(`close:${name}`)
            throw Error('cleanup injected')
          },
        }
      },
    }))
    await assert.rejects(acquireLifecycle({ steps, now: () => 0, deadline: 1000 }), /lifecycle/)
    assert.deepEqual(calls, [
      ...steps.slice(0, failing + 1).map(({ name }) => `open:${name}`),
      ...steps
        .slice(0, failing)
        .reverse()
        .map(({ name }) => `close:${name}`),
    ])
  }
})
test('should stop bootstrap/guard mutations on unknown or confirmed cleanup failure without replay', async () => {
  const { requireConfirmed, exerciseRevokedAdmin } = await load()
  for (const result of [
    { outcome: 'unknown' },
    { outcome: 'confirmed', code: 'ADMIN_CLEANUP_FAILED' },
    { outcome: 'confirmed', cleanupCode: 'ADMIN_CLEANUP_FAILED' },
    { outcome: 'rolled_back' },
  ]) {
    assert.throws(() => requireConfirmed({ result }))
    for (const failure of ['create', 'disable', 'restore']) {
      /** @type {string[]} */
      const calls = []
      const ok = { outcome: 'confirmed', data: { id: 2, role: 'admin', status: 'active' } }
      const ports = {
        loginA: async () => {
          calls.push('loginA')
          return { id: 1, token: 'memory-A' }
        },
        createB: async () => {
          calls.push('create')
          return failure === 'create' ? result : ok
        },
        loginB: async () => {
          calls.push('loginB')
          return { id: 2, token: 'memory-B' }
        },
        disableA: async () => {
          calls.push('disable')
          return failure === 'disable'
            ? result
            : { ...ok, data: { id: 1, role: 'admin', status: 'disabled' } }
        },
        exerciseA: async () => {
          calls.push('exercise')
        },
        restoreA: async () => {
          calls.push('restore')
          return failure === 'restore'
            ? result
            : { ...ok, data: { id: 1, role: 'admin', status: 'active' } }
        },
      }
      await assert.rejects(exerciseRevokedAdmin({ ports }))
      assert.deepEqual(
        calls,
        failure === 'create'
          ? ['loginA', 'create']
          : failure === 'disable'
            ? ['loginA', 'create', 'loginB', 'disable']
            : ['loginA', 'create', 'loginB', 'disable', 'exercise', 'restore'],
      )
    }
  }
})
test('should stop expired lifecycle after registering cleanup and expose cleanup failure', async () => {
  const { acquireLifecycle } = await load()
  let time = 0
  let closed = 0
  await assert.rejects(
    acquireLifecycle({
      now: () => time,
      deadline: 10,
      steps: [
        {
          name: 'minio',
          open: async () => {
            time = 11
            return {
              close: async () => {
                closed++
              },
            }
          },
        },
      ],
    }),
  )
  assert.equal(closed, 1)
  const managed = await acquireLifecycle({
    now: () => 0,
    deadline: 10,
    steps: [
      {
        name: 'next',
        open: async () => ({
          close: async () => {
            closed++
            throw Error('failure')
          },
        }),
      },
    ],
  })
  await assert.rejects(managed.close(), /cleanup failed/)
  await assert.rejects(managed.close(), /cleanup failed/)
  assert.equal(closed, 2)
})
test('should reject argv/env/sql/URL and stale source membership, even when claimed approved', async () => {
  const { parseApproval, verifySourceBinding } = await loadApproval()
  for (const key of ['argv', 'env', 'sql', 'url', 'cleanupPath'])
    assert.throws(() => parseApproval({ value: { ...approval(), [key]: 'anything' } }))
  assert.equal(typeof verifySourceBinding, 'function')
  assert.throws(() =>
    verifySourceBinding({ approval: approval(), actualFiles: approval().sourceFiles }),
  )
})
test('should require explicit bounded prod build approval and verify its receipt before start', async () => {
  const { parseApproval } = await loadApproval()
  const { prepareProduction } = await load()
  const prod = {
    ...approval(),
    mode: 'prod',
    productionBuildApproved: true,
    buildBudgetMs: 30000,
    distDirectory: '/owned/checkout/apps/heymoro/.template-admin-next/unit-run-01',
    generatedOutputs: ['next', 'next-env.d.ts'],
  }
  assert.equal(parseApproval({ value: prod }).mode, 'prod')
  assert.throws(() => parseApproval({ value: { ...prod, productionBuildApproved: false } }))
  assert.throws(() => parseApproval({ value: { ...prod, distDirectory: '/unknown/build' } }))
  for (const failure of ['build', 'receipt', 'deadline']) {
    /** @type {string[]} */
    const calls = []
    await assert.rejects(
      prepareProduction({
        expectedDistDirectory: '/owned/checkout/apps/heymoro/.template-admin-next/unit-run-01',
        now: () => (failure === 'deadline' ? 100 : 0),
        deadline: 10,
        coreSHA: 'a'.repeat(64),
        sourceSHA: 'b'.repeat(64),
        targetSHA: 'c'.repeat(64),
        ports: {
          build: async () => {
            calls.push('build')
            if (failure === 'build') throw Error('failed')
          },
          inspect: async () => {
            calls.push('inspect')
            return {
              coreSHA: 'WRONG',
              sourceSHA: 'b'.repeat(64),
              targetSHA: 'c'.repeat(64),
              buildId: 'fixture',
              distDirectory: '/owned/checkout/apps/heymoro/.template-admin-next/unit-run-01',
              outputSHA: 'd'.repeat(64),
            }
          },
          start: async () => {
            calls.push('start')
          },
        },
      }),
    )
    assert(!calls.includes('start'))
    assert(calls.filter((name) => name === 'build').length <= 1)
  }
  /** @type {string[]} */
  const calls = []
  await prepareProduction({
    expectedDistDirectory: '/owned/checkout/apps/heymoro/.template-admin-next/unit-run-01',
    now: () => 0,
    deadline: 10,
    coreSHA: 'a'.repeat(64),
    sourceSHA: 'b'.repeat(64),
    targetSHA: 'c'.repeat(64),
    ports: {
      build: async () => {
        calls.push('build')
      },
      inspect: async () => ({
        coreSHA: 'a'.repeat(64),
        sourceSHA: 'b'.repeat(64),
        targetSHA: 'c'.repeat(64),
        buildId: 'fixture',
        distDirectory: '/owned/checkout/apps/heymoro/.template-admin-next/unit-run-01',
        outputSHA: 'd'.repeat(64),
      }),
      start: async () => {
        calls.push('start')
      },
    },
  })
  assert.deepEqual(calls, ['build', 'start'])
})

const loadObserver = () => import('./creation/template-admin-runtime-observer.cjs')
const observationControl = () => ({
  format: 1,
  nonce: '12345678-1234-1234-1234-123456789abc',
  role: 'next-runtime',
  runDirectory: '/owned/run-01/happy',
  coreFile: '/owned/run-01/happy/core.json',
  coreSHA: 'a'.repeat(64),
  coreBytes: 2,
  appRoot: '/owned/checkout/apps/heymoro',
  distRoot: '/owned/checkout/apps/heymoro/.template-admin-next/unit-run-01/happy/dev',
  sourceAllowlist: ['src/payload.config.ts'],
  receiptDirectory: '/owned/run-01/happy/observations',
  observerSHA: 'b'.repeat(64),
  maxEvents: 64,
  maxBytes: 16384,
})
test('should import an inert observation factory and validate closed immutable control', async () => {
  const api = await loadObserver()
  assert.equal(typeof api.createRuntimeObserver, 'function')
})
test('should observe actual fd bytes+1 reads, revoke reused or failed-close descriptors, and preserve exceptions', async () => {
  const { createRuntimeObserver } = await loadObserver()
  const body = Buffer.from('{}')
  /** @type {import('./creation/template-admin-runtime-observer.cjs').Event[]} */
  const events = []
  const originalError = Error('business sentinel')
  let failClose = false
  /** @type {import('./creation/template-admin-runtime-observer.cjs').ProbeFS} */
  const fs = {
    openSync() {
      return 7
    },
    readSync(fd, buffer, offset) {
      body.copy(buffer, offset)
      return 2
    },
    closeSync() {
      if (failClose) throw originalError
    },
    readFileSync() {
      return body
    },
    readFile() {},
    promises: { readFile: async () => body },
  }
  const control = {
    ...observationControl(),
    coreSHA: createHash('sha256').update(body).digest('hex'),
  }
  const probe = createRuntimeObserver({
    control,
    fs,
    modulePrototype: {
      _compile() {
        return 31
      },
    },
    emit: (event) => events.push(event),
    syncExports() {},
  })
  probe.install()
  fs.openSync(control.coreFile)
  const buffer = Buffer.alloc(3, 9)
  assert.equal(fs.readSync(7, buffer, 0, 3, 0), 2)
  const read = events.at(-1)
  assert(read)
  assert.equal(read.complete, true)
  assert.equal(read.sha256, control.coreSHA)
  assert.equal(read.bytes, 2)
  fs.openSync('/not-approved')
  fs.readSync(7, buffer, 0, 3, 0)
  assert.equal(events.filter((event) => event.operation === 'core-read').length, 1)
  fs.openSync(control.coreFile)
  failClose = true
  assert.throws(
    () => fs.closeSync(7),
    (error) => error === originalError,
  )
  fs.readSync(7, buffer, 0, 3, 0)
  assert.equal(events.filter((event) => event.operation === 'core-read').length, 1)
})
test('should preserve source callback/promise values, callback throws and successful compile return values', async () => {
  const { createRuntimeObserver } = await loadObserver()
  /** @type {import('./creation/template-admin-runtime-observer.cjs').Event[]} */
  const events = []
  const bytes = Buffer.from([255, 0])
  const sentinel = Error('callback sentinel')
  /** @type {import('./creation/template-admin-runtime-observer.cjs').ProbeFS} */
  const fs = {
    openSync() {
      return 7
    },
    readSync() {
      return 0
    },
    closeSync() {},
    readFileSync() {
      return bytes
    },
    readFile(filename, callback) {
      return callback(null, bytes)
    },
    promises: { readFile: async () => bytes },
  }
  /** @type {{_compile:(...args:any[])=>any}} */
  const modulePrototype = {
    _compile(content, filename) {
      if (content === 'throw') throw sentinel
      return 13
    },
  }
  const probe = createRuntimeObserver({
    control: observationControl(),
    fs,
    modulePrototype,
    emit: (event) => events.push(event),
    syncExports() {},
  })
  probe.install()
  const filename = observationControl().appRoot + '/src/payload.config.ts'
  assert.equal(fs.readFileSync(filename), bytes)
  assert.throws(
    () =>
      fs.readFile(filename, () => {
        throw sentinel
      }),
    (error) => error === sentinel,
  )
  assert.equal(await fs.promises.readFile(filename), bytes)
  assert.equal(
    modulePrototype._compile(
      'actual compiled string',
      observationControl().distRoot + '/server/app.js',
    ),
    13,
  )
  const compiled = events.at(-1)
  assert(compiled)
  assert.equal(compiled.operation, 'compiled-load')
  assert.throws(
    () => modulePrototype._compile('throw', filename),
    (error) => error === sentinel,
  )
  assert.equal(events.filter((event) => event.operation === 'compiled-load').length, 1)
  const count = events.length
  modulePrototype._compile('other', '/not-approved.js')
  assert.equal(events.length, count)
})
test('should keep observation sink failure independent of business IO and reject incomplete parent evidence', async () => {
  const { createRuntimeObserver, validateObservationEvidence } = await loadObserver()
  /** @type {import('./creation/template-admin-runtime-observer.cjs').ProbeFS} */
  const fs = {
    openSync() {
      return 7
    },
    readSync() {
      return 0
    },
    closeSync() {},
    readFileSync() {
      return Buffer.from('{}')
    },
    readFile() {},
    promises: { readFile: async () => Buffer.from('{}') },
  }
  const probe = createRuntimeObserver({
    control: observationControl(),
    fs,
    modulePrototype: {
      _compile() {
        return 9
      },
    },
    emit() {
      throw Error('sink failed')
    },
    syncExports() {},
  })
  probe.install()
  const bytes = fs.readFileSync(observationControl().appRoot + '/src/payload.config.ts')
  assert.equal(bytes.toString(), '{}')
  assert.equal(probe.failed, true)
  assert.throws(() =>
    validateObservationEvidence({ control: observationControl(), events: [], allowedPIDs: [1] }),
  )
})

test('should require Next-specific complete terminal evidence and reject unknown event fields', async () => {
  const { validateObservationEvidence } = await loadObserver()
  const control = observationControl()
  const shared = {
    nonce: control.nonce,
    role: control.role,
    pid: 77,
    ppid: 1,
    uid: 501,
    threadId: 0,
    instance: '12345678-1234-1234-1234-123456789abc',
    observerSHA: control.observerSHA,
    controlSHA: 'c'.repeat(64),
  }
  const events = [
    {
      ...shared,
      sequence: 1,
      operation: 'core-read',
      label: 'core',
      sha256: control.coreSHA,
      bytes: control.coreBytes,
      complete: true,
    },
    {
      ...shared,
      sequence: 2,
      operation: 'compiled-load',
      label: 'dist/server/app/(payload)/admin/[[...segments]]/page.js',
      sha256: 'd'.repeat(64),
      bytes: 100,
      complete: true,
    },
    { ...shared, sequence: 3, operation: 'terminal', label: 'instance', complete: true },
  ]
  assert.equal(validateObservationEvidence({ control, events, allowedPIDs: [77] }), true)
  assert.throws(() =>
    validateObservationEvidence({ control, events: events.slice(0, 2), allowedPIDs: [77] }),
  )
  assert.throws(() =>
    validateObservationEvidence({
      control,
      events: events.map((event) => ({ ...event, authorization: 'SECRET' })),
      allowedPIDs: [77],
    }),
  )
  assert.throws(() =>
    validateObservationEvidence({
      control,
      events: events.map((event) =>
        event.operation === 'compiled-load' ? { ...event, label: 'dist/auxiliary.js' } : event,
      ),
      allowedPIDs: [77],
    }),
  )
  assert.throws(() =>
    validateObservationEvidence({
      control,
      events: events.map((event) => ({ ...event, role: 'init' })),
      allowedPIDs: [77],
    }),
  )
})

test('should bind production receipts and start to the same explicitly owned output root', async () => {
  const { prepareProduction } = await load()
  const { ownedOutputs, parseApproval } = await loadApproval()
  const approved = parseApproval({
    value: {
      ...approval(),
      mode: 'prod',
      productionBuildApproved: true,
      buildBudgetMs: 30000,
      distDirectory: '/owned/checkout/apps/heymoro/.template-admin-next/unit-run-01',
      generatedOutputs: ['next', 'next-env.d.ts'],
    },
  })
  const outputs = ownedOutputs({ approval: approved })
  assert.equal(outputs.distDirectory, approved.distDirectory)
  assert.deepEqual(outputs.generatedOutputs, [
    '/owned/checkout/apps/heymoro/.template-admin-next/unit-run-01',
    '/owned/checkout/apps/heymoro/next-env.d.ts',
  ])
  let started = 0
  await assert.rejects(
    prepareProduction({
      expectedDistDirectory: outputs.distDirectory,
      now: () => 0,
      deadline: 10,
      coreSHA: 'a'.repeat(64),
      sourceSHA: 'b'.repeat(64),
      targetSHA: 'c'.repeat(64),
      ports: {
        build: async () => {},
        inspect: async () => ({
          distDirectory: '/unknown/prebuilt',
          buildId: 'fixture',
          coreSHA: 'a'.repeat(64),
          sourceSHA: 'b'.repeat(64),
          targetSHA: 'c'.repeat(64),
          outputSHA: 'd'.repeat(64),
        }),
        start: async () => {
          started++
        },
      },
    }),
  )
  assert.equal(started, 0)
})

test('should distinguish partial zero offset BufferView and throwing real-read shapes without extra reads', async () => {
  const { createRuntimeObserver } = await loadObserver()
  const body = Buffer.from('{}')
  const sentinel = Error('read sentinel')
  /** @type {import('./creation/template-admin-runtime-observer.cjs').Event[]} */
  const events = []
  let count = 2
  let reads = 0
  /** @type {import('./creation/template-admin-runtime-observer.cjs').ProbeFS} */
  const fs = {
    openSync: () => 4,
    closeSync() {},
    readSync(fd, view, offset) {
      reads++
      if (count < 0) throw sentinel
      body.copy(Buffer.from(view.buffer, view.byteOffset, view.byteLength), offset, 0, count)
      return count
    },
    readFileSync: () => body,
    readFile() {},
    promises: {
      readFile: async () => {
        throw sentinel
      },
    },
  }
  const control = {
    ...observationControl(),
    coreSHA: createHash('sha256').update(body).digest('hex'),
  }
  const observer = createRuntimeObserver({
    control,
    fs,
    emit: (event) => events.push(event),
    modulePrototype: { _compile() {} },
    syncExports() {},
  })
  observer.install()
  fs.openSync(control.coreFile)
  const backing = new Uint8Array(8)
  const view = new Uint8Array(backing.buffer, 2, 4)
  fs.readSync(4, view, 1, 3, 0)
  assert.equal(events.at(-1)?.sha256, control.coreSHA)
  assert.equal(events.at(-1)?.complete, true)
  for (count of [1, 0]) {
    fs.readSync(4, view, 1, 3, 0)
    assert.equal(events.at(-1)?.complete, false)
  }
  count = -1
  assert.throws(
    () => fs.readSync(4, view, 1, 3, 0),
    (error) => error === sentinel,
  )
  await assert.rejects(
    fs.promises.readFile(control.appRoot + '/src/payload.config.ts'),
    (error) => error === sentinel,
  )
  assert.equal(reads, 4)
})

test('should verify both group and listener absence even after the direct Next child exited', async () => {
  const api = await load()
  assert.equal(typeof api.verifyNextStopped, 'function')
  for (const residual of ['group', 'listener', 'none']) {
    /** @type {string[]} */
    const calls = []
    const pending = api.verifyNextStopped({
      pid: 77,
      port: 18181,
      ports: {
        processes: async () => {
          calls.push('group')
          return residual === 'group' ? [{ pgid: 77 }] : [{ pgid: 99 }]
        },
        listeners: async ({ port }) => {
          assert.equal(port, 18181)
          calls.push('listener')
          return residual === 'listener' ? [88] : []
        },
      },
    })
    if (residual === 'none') await pending
    else await assert.rejects(pending, /survived cleanup/)
    assert.deepEqual(calls, ['group', 'listener'])
  }
})
test('should continue remaining resource cleanups when an exited Next parent left unverifiable residuals', async () => {
  const { acquireLifecycle, verifyNextStopped } = await load()
  /** @type {string[]} */
  const calls = []
  const lifecycle = await acquireLifecycle({
    now: () => 0,
    deadline: 10,
    steps: [
      {
        name: 'redis',
        open: async () => ({
          close: async () => {
            calls.push('redis')
          },
        }),
      },
      {
        name: 'minio',
        open: async () => ({
          close: async () => {
            calls.push('minio')
          },
        }),
      },
      {
        name: 'next',
        open: async () => ({
          close: async () => {
            calls.push('next')
            await verifyNextStopped({
              pid: 77,
              port: 18181,
              ports: {
                processes: async () => {
                  calls.push('group')
                  return [{ pgid: 77 }]
                },
                listeners: async () => {
                  calls.push('listener')
                  return []
                },
              },
            })
          },
        }),
      },
    ],
  })
  await assert.rejects(lifecycle.close(), /cleanup failed/)
  assert.deepEqual(calls, ['next', 'group', 'listener', 'minio', 'redis'])
})
