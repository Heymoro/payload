import type { ChildProcess } from 'node:child_process'

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Approval } from './template-admin-approval.js'
import type { Event as ObservationEvent } from './template-admin-runtime-observer.cjs'

import observation from './template-admin-runtime-observer.cjs'

export type ProcessIdentity = {
  birth: string
  pgid: number
  pid: number
  ppid: number
  uid: number
}
type Role = 'admin' | 'build' | 'init' | 'next-runtime'
type Binding = {
  control: ReturnType<typeof observation.parseControl>
  filename: string
  sha256: string
}

/** This owner has only evidence/control state; it neither starts nor stops application resources. */
export function createRuntimeEvidence({
  approval,
  coreFile,
  coreSHA,
  env,
  outputs,
}: {
  approval: Approval
  coreFile: string
  coreSHA: string
  env: NodeJS.ProcessEnv
  outputs: {
    distDirectory: string
    generatedOutputs: readonly string[]
    runtimeDistDirectory: string
  }
}) {
  const app = path.join(approval.checkout, 'apps/heymoro')
  const observerModule = path.join(app, 'tests/creation/template-admin-runtime-observer.cjs')
  const observerSHA = digest({ bytes: readFileSync(observerModule) })
  const directory = path.join(approval.runDirectory, 'observations')
  assert.equal(outputs.distDirectory, approval.distDirectory)
  assert.equal(env.HEYMORO_DIST_DIR, path.relative(app, outputs.distDirectory))
  mkdirSync(directory, { mode: 0o700 })
  const nonce = randomUUID()
  const controls: Binding[] = []
  const processes = new Map<number, { controlSHA: string; identity: ProcessIdentity }>()
  let collected: ObservationEvent[] = []
  return {
    collect() {
      assert.equal(digest({ bytes: readFileSync(observerModule) }), observerSHA)
      const names = readdirSync(directory)
      const logs = names.filter((name) => /^\d+-\d+-[a-f0-9-]{36}\.jsonl$/.test(name))
      assert(logs.length > 0 && logs.length <= 16 && names.length === logs.length * 2)
      let totalBytes = 0
      const all: ObservationEvent[] = []
      for (const name of logs) {
        const filename = path.join(directory, name)
        assertPrivate({ filename })
        const bytes = readFileSync(filename)
        totalBytes += bytes.length
        assert(totalBytes <= 1048576 && bytes.length <= 65536)
        const doneFile = filename.replace(/\.jsonl$/, '.done.json')
        assertPrivate({ filename: doneFile })
        const doneBytes = readFileSync(doneFile)
        totalBytes += doneBytes.length
        assert(totalBytes <= 1048576)
        const done = JSON.parse(doneBytes.toString('utf8')) as {
          bytes: number
          instance: string
          pid: number
          sequence: number
          sha256: string
          threadId: number
        }
        assert(done.sha256 === digest({ bytes }) && done.bytes === bytes.length)
        const events = bytes
          .toString('utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as ObservationEvent)
        assert(done.sequence === events.length)
        for (const event of events) {
          const owner = event.pid ? processes.get(event.pid) : undefined
          assert(
            owner && event.uid === owner.identity.uid && event.controlSHA === owner.controlSHA,
            'Event not bound to this actual child role.',
          )
          assert(
            event.instance === done.instance &&
              event.pid === done.pid &&
              event.threadId === done.threadId,
          )
          const binding = controls.find((entry) => entry.sha256 === event.controlSHA)
          assert(binding)
          assertPrivate({ filename: binding.filename })
          assert(digest({ bytes: readFileSync(binding.filename) }) === binding.sha256)
          assert(
            event.role === binding.control.role &&
              event.nonce === binding.control.nonce &&
              event.observerSHA === observerSHA,
          )
        }
        all.push(...events)
      }
      for (const entry of controls) {
        assertPrivate({ filename: entry.filename })
        totalBytes += lstatSync(entry.filename).size
        assert(totalBytes <= 1048576)
        observation.validateObservationEvidence({
          allowedPIDs: [...processes.keys()],
          control: entry.control,
          events: all.filter((event) => event.controlSHA === entry.sha256),
        })
      }
      assert(
        controls.some(({ control }) => control.role === 'next-runtime'),
        'Init/admin/build is not Next evidence.',
      )
      collected = all
      return all
    },
    async prepareRole({ role }: { role: Role }) {
      assert(controls.length < 16 && digest({ bytes: readFileSync(coreFile) }) === coreSHA)
      const control = observation.parseControl({
        appRoot: app,
        coreBytes: lstatSync(coreFile).size,
        coreFile,
        coreSHA,
        distRoot: outputs.runtimeDistDirectory,
        format: 1,
        maxBytes: 65536,
        maxEvents: 256,
        nonce,
        observerSHA,
        receiptDirectory: directory,
        role,
        runDirectory: approval.runDirectory,
        sourceAllowlist: [
          'src/payload.config.ts',
          'src/creation/runtime/config.ts',
          'src/creation/runtime/private-json.ts',
          'src/creation/runtime/payload-config.ts',
        ],
      })
      const filename = path.join(
        approval.runDirectory,
        `observation-control-${role}-${controls.length}.json`,
      )
      const bytes = Buffer.from(JSON.stringify(control))
      await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 })
      const sha256 = digest({ bytes })
      controls.push({ control, filename, sha256 })
      return {
        controlSHA: sha256,
        env: {
          ...env,
          HEYMORO_TEMPLATE_ADMIN_OBSERVATION_CONTROL_FILE: filename,
          NODE_ENV: role === 'build' ? 'production' : 'development',
          NODE_OPTIONS: `${env.NODE_OPTIONS} --require=${JSON.stringify(observerModule)}`,
        } as NodeJS.ProcessEnv,
      }
    },
    receipt: () => ({
      controls: controls.map(({ filename, sha256 }) => ({ filename, sha256 })),
      events: collected,
      observerSHA,
      processes: [...processes.values()].map(({ controlSHA, identity }) => ({
        ...identity,
        controlSHA,
      })),
    }),
    async recordChild({ child, controlSHA }: { child: ChildProcess; controlSHA: string }) {
      assert(child.pid && controls.some((entry) => entry.sha256 === controlSHA))
      const identity = (await processSnapshot()).find((entry) => entry.pid === child.pid)
      assert(
        identity && identity.ppid === process.pid && identity.uid === process.getuid!(),
        'Missing OS-verified direct child birth.',
      )
      processes.set(identity.pid, { controlSHA, identity })
      return identity
    },
    rememberClosure({
      controlSHA,
      rootPID,
      snapshot,
    }: {
      controlSHA: string
      rootPID: number
      snapshot: ProcessIdentity[]
    }) {
      const root = processes.get(rootPID)
      assert(root && root.controlSHA === controlSHA)
      assert.deepEqual(
        snapshot.find((entry) => entry.pid === rootPID),
        root.identity,
      )
      const descendants = new Set([rootPID])
      for (let pass = 0; pass < 16; pass++) {
        for (const entry of snapshot) {
          if (
            descendants.has(entry.ppid) &&
            entry.pgid === root.identity.pgid &&
            entry.uid === root.identity.uid
          ) {
            descendants.add(entry.pid)
          }
        }
      }
      for (const entry of snapshot) {
        if (descendants.has(entry.pid)) {
          processes.set(entry.pid, { controlSHA, identity: entry })
        }
      }
      return [...descendants]
    },
  }
}

export async function processSnapshot(): Promise<ProcessIdentity[]> {
  const text = await fixedProcessQuery({
    argv: ['-A', '-o', 'pid=,ppid=,pgid=,uid=,lstart='],
    file: '/bin/ps',
  })
  return text
    .trim()
    .split('\n')
    .map((line) => {
      const parts = line.trim().split(/\s+/)
      return {
        birth: parts.slice(4).join(' '),
        pgid: Number(parts[2]),
        pid: Number(parts[0]),
        ppid: Number(parts[1]),
        uid: Number(parts[3]),
      }
    })
}
export async function listeningPIDs({ port }: { port: number }) {
  assert(Number.isSafeInteger(port) && port > 0 && port < 65536)
  const text = await fixedProcessQuery({
    allowEmpty: true,
    argv: ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'],
    file: '/usr/sbin/lsof',
  })
  return text
    .split('\n')
    .filter((line) => /^p\d+$/.test(line))
    .map((line) => Number(line.slice(1)))
}
function fixedProcessQuery({
  allowEmpty = false,
  argv,
  file,
}: {
  allowEmpty?: boolean
  argv: string[]
  file: '/bin/ps' | '/usr/sbin/lsof'
}) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      file,
      argv,
      {
        env: { LANG: 'C', NODE_ENV: 'test', PATH: '/usr/bin:/bin' },
        maxBuffer: 65536,
        timeout: 5000,
      },
      (error, stdout) => {
        if (error && !(allowEmpty && error.code === 1 && !stdout)) {
          reject(Error('Fixed process identity query failed.'))
        } else {
          resolve(stdout)
        }
      },
    ),
  )
}
function assertPrivate({ filename }: { filename: string }) {
  const info = lstatSync(filename)
  assert(
    info.isFile() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o077) === 0 &&
      info.uid === process.getuid!() &&
      info.size <= 65536 &&
      realpathSync(filename) === filename,
  )
}
function digest({ bytes }: { bytes: Uint8Array }) {
  return createHash('sha256').update(bytes).digest('hex')
}
