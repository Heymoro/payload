import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, openSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { getPayload } from 'payload'

import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'
import {
  closeE2Payload,
  digest,
  hostInstance,
  journal,
  readE2Control,
} from './next-business-host.js'
import { seedE2Dataset } from './next-business-seed.js'

const { control, role } = readE2Control()
assert(['attest', 'jobs-1', 'jobs-2', 'seed', 'snapshot'].includes(role))
const payload = await getPayload({ config: hostInstance.built })
try {
  if (role === 'seed') {
    await seedE2Dataset({
      clock: hostInstance.clock,
      config: hostInstance.config,
      control,
      payload,
    })
  } else if (role.startsWith('jobs-')) {
    for (const queue of ['creation', 'creation-naming']) {
      await payload.jobs.run({ limit: 5, overrideAccess: true, queue })
      journal({ details: { queue }, event: 'native-jobs' })
    }
  } else if (role === 'snapshot') {
    const client = getCreationSQLiteAdapter({ payload }).client
    const tables = [
      'generation_tasks',
      'generation_attempts',
      'generation_inputs',
      'artifacts',
      'saved_artifacts',
      'credit_accounts',
      'credit_grants',
      'credit_reservations',
      'credit_allocations',
      'credit_ledger',
      'creation_sessions',
      'creation_drafts',
      'draft_inputs',
      'media',
      'payload_jobs',
      'users',
      'user_sessions',
      'wechat_identities',
      'audit_logs',
      'creation_templates',
      'template_versions',
      'taxonomy_terms',
    ]
    const snapshots = await Promise.all(
      tables.map(async (table) => ({
        rows: (await client.execute(`SELECT * FROM ${table} ORDER BY id`)).rows,
        table,
      })),
    )
    const commandId = process.env.E0_COMMAND_ID
    assert(commandId && /^[a-f0-9-]{36}$/.test(commandId))
    writeFileSync(
      path.join(control.snapshotDirectory, `snapshot-${commandId}.json`),
      JSON.stringify({
        commandId,
        counts: Object.fromEntries(snapshots.map(({ rows, table }) => [table, rows.length])),
        sha: digest({ value: snapshots }),
        tableHashes: Object.fromEntries(
          snapshots.map(({ rows, table }) => [table, digest({ value: rows })]),
        ),
        verificationId: control.verificationId,
      }),
      { flag: 'wx', mode: 0o600 },
    )
  } else {
    await kernelProbes()
    journal({
      details: {
        nativeEnv: 1,
        publicOutbound: 1,
        sealedNative: 1,
        sealedNode: 1,
        targetFingerprint: control.targetFingerprint,
        unregisteredLoopback: 1,
        workerBind: 1,
      },
      event: 'ready',
    })
  }
} finally {
  await closeE2Payload({ payload })
}

async function kernelProbes() {
  const synthetic = path.join(path.dirname(control.jsonFile), 'synthetic')
  for (const name of ['sealed-authority-probe.json', 'sealed-control-probe.json']) {
    const filename = path.join(synthetic, name)
    assert.throws(
      () => {
        const fd = openSync(filename, 'r+')
        closeSync(fd)
      },
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        ['EACCES', 'EPERM'].includes(String(error.code)),
    )
    const native = spawnSync(
      '/bin/sh',
      ['-c', 'printf denied > "$1"', 'e2-owned-probe', filename],
      { encoding: 'utf8', timeout: 3000 },
    )
    assert.notEqual(native.status, 0, 'Native sealed write was not denied.')
    assert.match(native.stderr, /Operation not permitted|Permission denied/)
  }
  const envProbe = spawnSync('/bin/cat', [path.join(synthetic, '.env.native.sqlite')], {
    encoding: 'utf8',
    timeout: 3000,
  })
  assert.notEqual(envProbe.status, 0)
  assert.match(envProbe.stderr, /Operation not permitted|Permission denied/)
  const denied = (code: unknown) => ['EACCES', 'EPERM'].includes(String(code))
  for (const host of ['192.0.2.1', '127.0.0.1']) {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({
        host,
        port: host === '127.0.0.1' ? Number(new URL(hostInstance.config.publicApiUrl).port) : 443,
      })
      socket.setTimeout(2000)
      socket.once('connect', () => {
        socket.destroy()
        reject(new Error('Unregistered network connection succeeded.'))
      })
      socket.once('timeout', () => {
        socket.destroy()
        reject(new Error('Kernel outbound denial was not proven.'))
      })
      socket.once('error', (error: NodeJS.ErrnoException) => {
        socket.destroy()
        if (denied(error.code)) {
          resolve()
        } else {
          reject(new Error('Unexpected network failure; not a denial proof.'))
        }
      })
    })
  }
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (denied(error.code)) {
        resolve()
      } else {
        reject(new Error('Worker bind denial was not proven.'))
      }
    })
    server.listen(
      { host: '127.0.0.1', port: Number(new URL(hostInstance.config.publicApiUrl).port) },
      () => {
        server.close()
        reject(new Error('Worker acquired a forbidden listener.'))
      },
    )
  })
}
