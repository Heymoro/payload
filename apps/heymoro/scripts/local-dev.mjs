import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'

import { readCoreConfig } from '../src/creation/runtime/config.ts'
import { createLocalCoreConfig } from '../src/creation/runtime/local-config.ts'
import { configuredGenerationQueues } from '../src/creation/infrastructure/payload/generation-consumer.ts'
import { runLocalProcesses } from './local-processes.mjs'

const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const execute = promisify(execFile)
const purpose = 'heymoro-local-development'

export function localChildEnvironment({ configFile }) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'development',
    NODE_OPTIONS: '--max-old-space-size=4096',
    HEYMORO_CORE_CONFIG_FILE: configFile,
    HEYMORO_DIST_DIR: '.next-local',
    PAYLOAD_DROP_DATABASE: 'false',
    PAYLOAD_MIGRATING: 'false',
    NEXT_TELEMETRY_DISABLED: '1',
    COREPACK_ENABLE_NETWORK: '0',
  }
}

async function vacantPort({ port }) {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', () =>
      reject(new Error(`Local API port ${port} is occupied; no process was stopped.`)),
    )
    server.listen(port, '127.0.0.1', resolve)
  })
  await new Promise((resolve) => server.close(resolve))
}

async function waitForDependencies() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const healthy = await fetch('http://127.0.0.1:19000/minio/health/ready', {
        signal: AbortSignal.timeout(1000),
      })
      if (healthy.ok) {
        await new Promise((resolve, reject) => {
          const socket = net.createConnection({ host: '127.0.0.1', port: 16379 })
          socket.setTimeout(1000)
          socket.once('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'))
          socket.once('data', (data) => {
            socket.destroy()
            data.toString().startsWith('+PONG') ? resolve() : reject(new Error('Redis not ready'))
          })
          socket.once('error', reject)
          socket.once('timeout', () => {
            socket.destroy()
            reject(new Error('Redis timeout'))
          })
        })
        return
      }
    } catch {
      /* A bounded readiness probe does not mutate data or retry a model. */
    }
    await sleep(500)
  }
  throw new Error('Local Redis/MinIO did not become ready; existing data was preserved.')
}

async function ensureBuckets({ config }) {
  const backend = config.s3.backends[0]
  const client = new S3Client({
    endpoint: backend.endpoint,
    region: backend.region,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: backend.credentials.accessKeyId,
      secretAccessKey: backend.credentials.secretAccessKey,
    },
  })
  try {
    for (const Bucket of backend.buckets) {
      try {
        await client.send(new HeadBucketCommand({ Bucket }))
      } catch (error) {
        if (error?.$metadata?.httpStatusCode !== 404) throw error
        await client.send(new CreateBucketCommand({ Bucket }))
      }
    }
  } finally {
    client.destroy()
  }
}

async function childCommand({ script, args, env }) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: app,
      env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Local preparation stopped (${code ?? signal}); no database reset was attempted.`,
            ),
          ),
    )
  })
}

export async function startLocalDevelopment() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && (minor < 22 || (minor === 22 && patch < 1)))) {
    throw new Error('Heymoro requires Node >=24.22.1; no services were started.')
  }
  await vacantPort({ port: 3001 })
  const root = path.join(
    os.homedir(),
    ...(process.platform === 'darwin' ? ['Library', 'Application Support'] : ['.local', 'share']),
    'Heymoro',
    'local',
  )
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if (lstatSync(root).isSymbolicLink())
    throw new Error('Local data directory must not be a symlink.')
  const marker = path.join(root, 'local-profile.json')
  if (existsSync(marker)) {
    if (JSON.parse(readFileSync(marker, 'utf8')).purpose !== purpose)
      throw new Error('Unrecognized local profile; nothing was replaced.')
  } else {
    if (existsSync(path.join(root, 'core.json')) || existsSync(path.join(root, 'data')))
      throw new Error('Existing unowned local data was preserved.')
    writeFileSync(marker, JSON.stringify({ purpose, createdAt: new Date().toISOString() }) + '\n', {
      flag: 'wx',
      mode: 0o600,
    })
  }
  const disk = statfsSync(root)
  if (disk.bavail * disk.bsize < 4 * 1024 ** 3)
    throw new Error('Local development needs at least 4 GiB free disk.')
  const configFile = path.join(root, 'core.json')
  if (!existsSync(configFile)) {
    const config = createLocalCoreConfig({
      root,
      secrets: {
        payloadSecret: randomBytes(48).toString('base64url'),
        cursorKey: randomBytes(32).toString('base64url'),
        quoteKey: randomBytes(32).toString('base64url'),
        storageUser: randomBytes(16).toString('hex'),
        storageSecret: randomBytes(32).toString('hex'),
      },
    })
    writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  const config = readCoreConfig({ filename: configFile })
  if (
    config.dataDir !== path.join(root, 'data') ||
    config.redis.url !== 'redis://127.0.0.1:16379/0' ||
    config.s3.backends[0]?.endpoint !== 'http://127.0.0.1:19000'
  ) {
    throw new Error(
      'This local launcher manages only its own loopback profile; configuration was not changed.',
    )
  }
  const environmentFile = path.join(root, 'compose.env')
  const credentials = config.s3.backends[0].credentials
  if (
    !/^[a-zA-Z0-9_-]+$/.test(credentials.accessKeyId) ||
    !/^[a-zA-Z0-9_-]+$/.test(credentials.secretAccessKey)
  )
    throw new Error('Invalid local storage credential encoding.')
  if (!existsSync(environmentFile))
    writeFileSync(
      environmentFile,
      `HEYMORO_MINIO_USER=${credentials.accessKeyId}\nHEYMORO_MINIO_PASSWORD=${credentials.secretAccessKey}\n`,
      { flag: 'wx', mode: 0o600 },
    )
  await execute(
    'docker',
    [
      '--host',
      'unix:///var/run/docker.sock',
      'compose',
      '--env-file',
      environmentFile,
      '-f',
      path.join(app, 'compose.local.yaml'),
      'up',
      '-d',
      '--pull',
      'never',
    ],
    { cwd: app, maxBuffer: 262144 },
  )
  await waitForDependencies()
  await ensureBuckets({ config })
  const env = localChildEnvironment({ configFile })
  if (!existsSync(config.dataDir))
    await childCommand({ script: 'scripts/init-target.mjs', args: ['--config', configFile], env })
  await childCommand({ script: 'scripts/local-prepare.mjs', args: [configFile], env })
  const recordFile = path.join(root, 'local-process.json')
  console.info(
    '本地后台：http://127.0.0.1:3001/admin/templates · 开发账号 admin / 123456（已有账号不重置）',
  )
  console.info(
    '配置与数据保存在工程外；没有定时关闭。Ctrl+C停止后台，持久化图片和数据库保留。已启用本地开发身份；真实微信服务与OpenAI另行配置。',
  )
  try {
    await runLocalProcesses({
      cwd: app,
      env,
      isWorkerEnabled: configuredGenerationQueues({ config }).length > 0,
      onStarted: (children) =>
        writeFileSync(
          recordFile,
          JSON.stringify({
            purpose,
            entryPID: process.pid,
            ...children,
            configFile,
            startedAt: new Date().toISOString(),
          }) + '\n',
          { mode: 0o600 },
        ),
    })
  } finally {
    if (
      existsSync(recordFile) &&
      JSON.parse(readFileSync(recordFile, 'utf8')).entryPID === process.pid
    )
      unlinkSync(recordFile)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startLocalDevelopment().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
