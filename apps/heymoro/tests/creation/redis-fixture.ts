import type { ChildProcess } from 'node:child_process'

import { Redis } from 'ioredis'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

export type RedisFixture = Awaited<ReturnType<typeof startRedisFixture>>

/** Owns exactly one child, its disposable directory and explicitly registered clients. */
export async function startRedisFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'heymoro-t04-b-redis-'))
  const clients = new Set<Redis>()
  let child: ChildProcess | undefined
  let isStopped = false
  const stop = async () => {
    if (isStopped) {
      return
    }
    isStopped = true
    for (const client of clients) {
      client.disconnect(false)
    }
    clients.clear()
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const owned = child
      const exited = new Promise<void>((resolve) => owned.once('exit', () => resolve()))
      owned.kill('SIGTERM')
      try {
        await bounded({ promise: exited, timeoutMs: 3000 })
      } catch {
        owned.kill('SIGKILL')
        await bounded({ promise: exited, timeoutMs: 3000 })
      }
    }
    await rm(directory, { force: true, recursive: true })
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await unusedLoopbackPort()
      child = spawn(
        '/opt/homebrew/bin/redis-server',
        [
          '--bind',
          '127.0.0.1',
          '--port',
          String(port),
          '--dir',
          directory,
          '--save',
          '',
          '--appendonly',
          'no',
          '--maxmemory',
          '32mb',
          '--maxmemory-policy',
          'noeviction',
          '--protected-mode',
          'yes',
          '--daemonize',
          'no',
          '--logfile',
          '',
        ],
        {
          env: {
            HOME: directory,
            LANG: 'C',
            NODE_ENV: 'test',
            PATH: '/opt/homebrew/bin:/usr/bin:/bin',
            TMPDIR: directory,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      const owned = child
      let hasBindConflict = false
      try {
        await bounded({
          promise: new Promise<void>((resolve, reject) => {
            let output = ''
            const observe = (chunk: Buffer) => {
              output = (output + chunk.toString()).slice(-8192)
              hasBindConflict ||= /Address already in use/.test(output)
              if (/Ready to accept connections/.test(output)) {
                resolve()
              }
            }
            owned.stdout!.on('data', observe)
            owned.stderr!.on('data', observe)
            owned.once('error', () => reject(new Error('Owned Redis child failed to start.')))
            owned.once('exit', () => reject(new Error('Owned Redis child exited before ready.')))
          }),
          timeoutMs: 5000,
        })
      } catch (error) {
        // Never probe a port occupied by an unknown process; retry only after our child exited.
        if (hasBindConflict && (owned.exitCode !== null || owned.signalCode !== null)) {
          continue
        }
        throw error
      }
      if (owned.exitCode !== null || owned.signalCode !== null) {
        throw new Error('Owned Redis child exited after readiness.')
      }
      const url = `redis://127.0.0.1:${port}`
      const register = ({ client }: { client: Redis }) => {
        clients.add(client)
        return client
      }
      const connect = async () => {
        const client = register({
          client: new Redis(url, {
            autoResendUnfulfilledCommands: false,
            commandTimeout: 1000,
            connectTimeout: 1000,
            enableOfflineQueue: false,
            lazyConnect: true,
            maxRetriesPerRequest: 0,
            retryStrategy: null,
          }),
        })
        client.on('error', () => {})
        await bounded({ promise: client.connect(), timeoutMs: 1500 })
        if ((await bounded({ promise: client.ping(), timeoutMs: 1500 })) !== 'PONG') {
          throw new Error('Owned Redis did not answer PING.')
        }
        return client
      }
      const client = await connect()
      return { client, connect, directory, port, register, stop, url }
    }
    throw new Error('Owned Redis exhausted port attempts.')
  } catch (error) {
    await stop()
    throw error
  }
}

export async function bounded<T>({
  promise,
  timeoutMs = 5000,
}: {
  promise: Promise<T>
  timeoutMs?: number
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture deadline exceeded.')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Missing fixture port.')
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}
