import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const cachedMinIOImage =
  'sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e'

/** Uses only the pinned local cache, loopback publish, own tmpfs, credentials and container ID. */
export async function startMinIOFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'heymoro-minio-docker-'))
  const name = `heymoro-t06a-${randomUUID()}`
  const credentials = {
    accessKeyId: randomBytes(16).toString('hex'),
    secretAccessKey: randomBytes(24).toString('hex'),
  }
  const env: NodeJS.ProcessEnv = {
    MINIO_BROWSER: 'off',
    MINIO_ROOT_PASSWORD: credentials.secretAccessKey,
    MINIO_ROOT_USER: credentials.accessKeyId,
    NODE_ENV: 'test',
    PATH: process.env.PATH,
  }
  const prefix = ['--host', 'unix:///var/run/docker.sock', '--config', directory]
  let id: string | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let closePromise: Promise<void> | undefined
  let reservedBytes = 0
  const docker = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        'docker',
        [...prefix, ...args],
        { env, maxBuffer: 64 * 1024, timeout: 15_000 },
        (error, stdout) => {
          if (error) {
            reject(new Error(`Owned MinIO fixture Docker operation failed (${args[0]}).`))
          } else {
            resolve(stdout.trim())
          }
        },
      )
    })
  const close = () => {
    closePromise ??= (async () => {
      clearTimeout(watchdog)
      try {
        if (id) {
          await docker(['rm', '--force', id])
          const remaining = await docker([
            'ps',
            '--all',
            '--quiet',
            '--no-trunc',
            '--filter',
            `id=${id}`,
          ])
          if (remaining) {
            throw new Error('Owned MinIO fixture container survived cleanup.')
          }
        }
      } finally {
        await rm(directory, { force: true, recursive: true })
      }
    })()
    return closePromise
  }
  try {
    // No pull, shared volume, user Docker config, remote host, or container logs.
    id = await docker([
      'run',
      '--detach',
      '--pull',
      'never',
      '--name',
      name,
      '--cpus',
      '1',
      '--memory',
      '512m',
      '--memory-swap',
      '512m',
      '--pids-limit',
      '128',
      '--log-driver',
      'none',
      '--tmpfs',
      '/data:size=2g,nodev,nosuid,noexec',
      '--publish',
      '127.0.0.1::9000',
      '--env',
      'MINIO_ROOT_USER',
      '--env',
      'MINIO_ROOT_PASSWORD',
      '--env',
      'MINIO_BROWSER',
      cachedMinIOImage,
      'server',
      '/data',
      '--address',
      ':9000',
    ])
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error('Owned MinIO fixture returned invalid container ID.')
    }
    watchdog = setTimeout(() => {
      void close().catch(() => undefined)
    }, 90_000)
    const config = JSON.parse(
      await docker(['inspect', '--format', '{{json .HostConfig}}', id]),
    ) as {
      LogConfig: { Type: string }
      Memory: number
      MemorySwap: number
      NanoCpus: number
      PidsLimit: number
      Tmpfs: Record<string, string>
    }
    if (
      config.NanoCpus !== 1_000_000_000 ||
      config.Memory !== 512 * 1024 * 1024 ||
      config.MemorySwap !== config.Memory ||
      config.PidsLimit !== 128 ||
      config.LogConfig.Type !== 'none' ||
      config.Tmpfs['/data'] !== 'size=2g,nodev,nosuid,noexec'
    ) {
      throw new Error('Owned MinIO fixture resource limits did not take effect.')
    }
    if ((await docker(['inspect', '--format', '{{.Image}}', id])) !== cachedMinIOImage) {
      throw new Error('Owned MinIO fixture image differs from pin.')
    }
    const ports = JSON.parse(
      await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', id]),
    ) as Record<string, { HostIp: string; HostPort: string }[]>
    const bindings = ports['9000/tcp']
    if (
      !bindings ||
      bindings.length !== 1 ||
      bindings[0]!.HostIp !== '127.0.0.1' ||
      !/^\d+$/.test(bindings[0]!.HostPort)
    ) {
      throw new Error('Owned MinIO fixture must publish only one loopback port.')
    }
    const endpoint = `http://127.0.0.1:${bindings[0]!.HostPort}`
    const deadline = Date.now() + 20_000
    for (;;) {
      try {
        if (
          (await fetch(`${endpoint}/minio/health/ready`, { signal: AbortSignal.timeout(500) })).ok
        ) {
          break
        }
      } catch {
        /* owned service may still be starting */
      }
      if (Date.now() >= deadline) {
        throw new Error('Owned MinIO fixture readiness deadline exceeded.')
      }
      await delay(100)
    }
    return {
      bucket: `heymoro-${randomUUID()}`,
      close,
      credentials,
      endpoint,
      reserveBytes: ({ bytes }: { bytes: number }) => {
        if (
          !Number.isSafeInteger(bytes) ||
          bytes < 0 ||
          (reservedBytes += bytes) > 32 * 1024 * 1024
        ) {
          throw new Error('Owned MinIO fixture 32 MiB data budget exceeded.')
        }
      },
    }
  } catch (error) {
    if (!id) {
      // A lost docker-run acknowledgement can still have created our uniquely named container.
      const candidate = await docker(['inspect', '--format', '{{.Id}}', name]).catch(() => '')
      if (/^[a-f0-9]{64}$/.test(candidate)) {
        id = candidate
      }
    }
    await close()
    throw error
  }
}
