import { spawn } from 'node:child_process'

/** Own only the two children started here; a stopped worker must not leave a healthy-looking API. */
export async function runLocalProcesses({
  cwd,
  env,
  isWorkerEnabled,
  onStarted,
  spawnProcess = spawn,
  killProcess = process.kill.bind(process),
  signals = process,
}) {
  const children = []
  let isStopping = false
  const stop = () => {
    isStopping = true
    for (const child of children) {
      if (!child.isStopRequested && child.process.pid) {
        child.isStopRequested = true
        try {
          killProcess(-child.process.pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    }
  }
  const start = ({ name, args }) => {
    const childProcess = spawnProcess(process.execPath, args, {
      cwd,
      env,
      detached: true,
      stdio: 'inherit',
    })
    const child = { name, process: childProcess, isStopRequested: false }
    child.done = new Promise((resolve) => {
      childProcess.once('error', (error) => {
        resolve({ error })
      })
      childProcess.once('exit', (code, signal) => {
        resolve({ code, signal })
      })
    }).then((result) => ({ ...result, name }))
    children.push(child)
    return child
  }
  signals.once('SIGTERM', stop)
  signals.once('SIGINT', stop)
  try {
    const server = start({
      name: 'Next',
      args: [
        'node_modules/next/dist/bin/next',
        'dev',
        '--webpack',
        '--hostname',
        '127.0.0.1',
        '--port',
        '3001',
      ],
    })
    const worker = isWorkerEnabled
      ? start({ name: 'worker', args: ['--import', 'tsx', 'scripts/jobs-creation.mjs', '--watch'] })
      : null
    onStarted({ serverPID: server.process.pid, workerPID: worker?.process.pid ?? null })
    const first = await Promise.race(children.map((child) => child.done))
    if (!isStopping && (first.error || first.code !== 0 || first.name === 'worker')) {
      throw new Error(
        `Local ${first.name} stopped (${first.code ?? first.signal ?? 'startup error'}).`,
      )
    }
  } finally {
    stop()
    await Promise.all(children.map((child) => child.done))
    signals.removeListener('SIGTERM', stop)
    signals.removeListener('SIGINT', stop)
  }
}
