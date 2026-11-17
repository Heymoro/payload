import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import test from 'node:test'

function fixture() {
  const children = []
  const killed = []
  const signals = new EventEmitter()
  return {
    children,
    killed,
    signals,
    spawnProcess: (...args) => {
      const child = new EventEmitter()
      child.pid = 5000 + children.length
      child.args = args
      children.push(child)
      return child
    },
    killProcess: (pid, signal) => {
      killed.push([pid, signal])
      const child = children.find((entry) => entry.pid === -pid)
      queueMicrotask(() => child.emit('exit', null, signal))
    },
  }
}

test('local supervisor without a provider starts only Next and removes signal listeners', async () => {
  const { runLocalProcesses } = await import('../scripts/local-processes.mjs')
  const f = fixture()
  let ownership
  const result = runLocalProcesses({
    ...f,
    cwd: '/fixture',
    env: {},
    isWorkerEnabled: false,
    onStarted: (record) => {
      ownership = record
    },
  })
  assert.equal(f.children.length, 1)
  assert.deepEqual(ownership, { serverPID: 5000, workerPID: null })
  f.signals.emit('SIGINT')
  await result
  assert.deepEqual(f.killed, [[-5000, 'SIGTERM']])
  assert.equal(f.signals.listenerCount('SIGINT'), 0)
  assert.equal(f.signals.listenerCount('SIGTERM'), 0)
})

test('local supervisor owns watch worker, and a worker exit stops its own Next only', async () => {
  const { runLocalProcesses } = await import('../scripts/local-processes.mjs')
  const f = fixture()
  const result = runLocalProcesses({
    ...f,
    cwd: '/fixture',
    env: {},
    isWorkerEnabled: true,
    onStarted: () => {},
  })
  assert.deepEqual(f.children[1].args[1], [
    '--import',
    'tsx',
    'scripts/jobs-creation.mjs',
    '--watch',
  ])
  assert.equal(f.children[1].args[2].detached, true)
  f.children[1].emit('exit', 1, null)
  await assert.rejects(result, /worker stopped/)
  assert.deepEqual(f.killed, [
    [-5000, 'SIGTERM'],
    [-5001, 'SIGTERM'],
  ])
})

test('a terminated group leader still has its owned group signalled for remaining descendants', async () => {
  const { runLocalProcesses } = await import('../scripts/local-processes.mjs')
  const f = fixture()
  const result = runLocalProcesses({
    ...f,
    cwd: '/fixture',
    env: {},
    isWorkerEnabled: false,
    onStarted: () => {},
  })
  f.children[0].emit('exit', 0, null)
  await result
  assert.deepEqual(f.killed, [[-5000, 'SIGTERM']])
})

test('actual owned Node process groups receive graceful stop and finish before supervisor returns', async () => {
  const { runLocalProcesses } = await import('../scripts/local-processes.mjs')
  const signals = new EventEmitter()
  const children = []
  const result = runLocalProcesses({
    cwd: process.cwd(),
    env: {},
    isWorkerEnabled: true,
    signals,
    onStarted: () => {},
    spawnProcess: (command, args, options) => {
      const child = spawn(
        command,
        [
          '-e',
          `
        process.on('SIGTERM', () => setTimeout(() => { console.log('settled'); process.exit(0) }, 30));
        setInterval(() => {}, 1000);
        console.log('ready');
      `,
        ],
        { ...options, stdio: ['ignore', 'pipe', 'inherit'] },
      )
      let output = ''
      const ready = Promise.withResolvers()
      child.stdout.on('data', (chunk) => {
        output += chunk.toString()
        if (output.includes('ready')) ready.resolve()
      })
      children.push({ child, ready: ready.promise, output: () => output })
      return child
    },
  })
  const timeout = setTimeout(() => signals.emit('SIGTERM'), 5000)
  try {
    await Promise.all(children.map(({ ready }) => ready))
    signals.emit('SIGTERM')
    await result
    assert.equal(
      children.every(({ output }) => output().includes('settled')),
      true,
    )
    for (const { child } of children) {
      assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' })
    }
  } finally {
    clearTimeout(timeout)
    signals.emit('SIGTERM')
    await result
  }
})

test('Next exit and startup errors close any worker, without killing unrelated processes', async () => {
  const { runLocalProcesses } = await import('../scripts/local-processes.mjs')
  for (const scenario of ['next-exit', 'spawn-error', 'record-error']) {
    const f = fixture()
    const result = runLocalProcesses({
      ...f,
      cwd: '/fixture',
      env: {},
      isWorkerEnabled: true,
      onStarted: () => {
        if (scenario === 'record-error') throw new Error('record failed')
      },
    })
    if (scenario === 'next-exit') f.children[0].emit('exit', 1, null)
    if (scenario === 'spawn-error') f.children[1].emit('error', new Error('spawn failed'))
    await assert.rejects(result)
    assert.equal(
      f.killed.every(([pid]) => [-5000, -5001].includes(pid)),
      true,
    )
    assert.equal(f.signals.listenerCount('SIGTERM'), 0)
  }
})
