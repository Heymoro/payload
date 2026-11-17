'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { syncBuiltinESMExports } = require('node:module')
const childProcess = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { randomUUID } = require('node:crypto')
function allowsNextTypeScriptDetached({ policy, request }) {
  return Boolean(
    policy &&
    request.node === policy.node &&
    request.script === policy.script &&
    request.cwd === policy.cwd &&
    request.uid === policy.uid &&
    request.shell === false &&
    request.method === 'spawn' &&
    policy.callers.includes(request.caller),
  )
}
function compilerAckMatches({ ack, expected }) {
  const keys = ['ticket', 'commandId', 'pid', 'ppid', 'uid', 'nodeCanonical', 'scriptCanonical']
  const birth = Date.parse(ack.birth)
  return (
    keys.every((key) => ack[key] === expected[key]) &&
    ack.pgid === expected.pid &&
    Number.isFinite(birth) &&
    Math.abs(birth - Math.floor(expected.birthMs / 1000) * 1000) <= 1000
  )
}
function compilerAckExpired({ started, now, timeout }) {
  return now - started >= timeout
}
module.exports = { allowsNextTypeScriptDetached, compilerAckMatches, compilerAckExpired }
const raw = Object.fromEntries(
  Object.entries(fs).filter(([, value]) => typeof value === 'function'),
)
const configFile = process.env.E0_GUARD_CONFIG
if (!configFile || !path.isAbsolute(configFile)) throw new Error('E0 guard configuration required.')
const config = JSON.parse(raw.readFileSync(configFile, 'utf8'))
const logFile = path.join(config.logs, `${process.pid}.jsonl`)
let count = 0
function record(event) {
  if (++count > 256) throw new Error('E0 per-process evidence budget exceeded.')
  raw.appendFileSync(
    logFile,
    `${JSON.stringify({ pid: process.pid, ppid: process.ppid, uid: process.getuid(), birthMs: performance.timeOrigin, commandId: process.env.E0_COMMAND_ID || null, atMs: Date.now(), ...event })}\n`,
    { mode: 0o600 },
  )
}
function canonical({ filename }) {
  if (filename instanceof URL) filename = fileURLToPath(filename)
  if (Buffer.isBuffer(filename)) filename = filename.toString()
  if (typeof filename !== 'string') return null
  let result = path.resolve(filename)
  const suffix = []
  while (true) {
    try {
      return path.join(raw.realpathSync(result), ...suffix)
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
      const parent = path.dirname(result)
      if (parent === result) throw error
      suffix.unshift(path.basename(result))
      result = parent
    }
  }
}
const within = ({ filename, root }) =>
  filename === root || filename.startsWith(`${root}${path.sep}`)
function deny({ filename, write }) {
  const resolved = canonical({ filename: filename })
  if (!resolved) return
  const forbiddenRead =
    resolved.split(path.sep).some((part) => /^\.env/i.test(part)) ||
    (config.oldDataRoots || []).some((root) => within({ filename: resolved, root: root })) ||
    config.protectedRoots.some((root) =>
      within({ filename: resolved, root: path.join(root, '.data') }),
    )
  if (
    (!write && !forbiddenRead) ||
    (write && !config.protectedRoots.some((root) => within({ filename: resolved, root: root })))
  )
    return
  record({
    event: 'denied',
    operation: write ? 'write' : 'read',
    category: write ? 'protected-tree' : 'private-data',
  })
  const error = new Error('E0 isolated access denied.')
  error.code = 'E0_DENIED'
  throw error
}
function writes({ flags = 'r' }) {
  return typeof flags === 'number'
    ? Boolean(
        flags &
        (fs.constants.O_WRONLY |
          fs.constants.O_RDWR |
          fs.constants.O_CREAT |
          fs.constants.O_TRUNC |
          fs.constants.O_APPEND),
      )
    : /[wa+]/.test(flags)
}
function readerEvidence({ filename, operation }) {
  if (!config.expectedJSON) return
  const stack = new Error().stack || ''
  if (!/readPrivateJSON|private-json/.test(stack)) return
  const resolved = canonical({ filename: filename })
  const compiled = /webpack-internal|\.next\//.test(stack)
  if (operation === 'root' && resolved !== config.expectedJSON) {
    record({ event: 'private-reader-root', root: resolved, compiled })
  } else if (operation === 'open' && resolved === config.expectedJSON) {
    record({ event: 'private-reader-open', filename: resolved, compiled })
  }
}

record({
  event: 'handshake',
  version: process.version,
  cwd: process.cwd(),
  compilerTicket: process.env.E0_TSC_TICKET || null,
  entryScriptCanonical: process.env.E0_TSC_TICKET
    ? canonical({ filename: process.argv[1] })
    : undefined,
  nodeCanonical: process.env.E0_TSC_TICKET ? canonical({ filename: process.execPath }) : undefined,
})
if (config.nativeProbe) {
  const { DatabaseSync } = require('node:sqlite')
  const normal = new DatabaseSync(config.nativeProbe.normal, { readOnly: true })
  if (normal.prepare('SELECT id FROM owned_probe').get()?.id !== 73)
    throw new Error('E0 native positive control failed.')
  normal.close()
  const refused = (filename) => {
    try {
      const database = new DatabaseSync(filename, { readOnly: true })
      database.close()
      return false
    } catch (error) {
      return error.code === 'ERR_SQLITE_ERROR' && error.errcode === 14
    }
  }
  const env = refused(config.nativeProbe.env)
  const oldData = refused(config.nativeProbe.oldData)
  record({
    event: 'native-probe',
    normal: true,
    positiveTable: 'owned_probe',
    positiveMarker: 73,
    blockedOpenCode: 14,
    env,
    oldData,
  })
  if (!env || !oldData) throw new Error('E0 native OS denial absent.')
}

if (process.env.E0_TSC_TICKET) {
  const policy = config.nextTypeScriptChild
  const ticket = process.env.E0_TSC_TICKET
  const commandId = process.env.E0_COMMAND_ID
  const expected = {
    ticket,
    commandId,
    pid: process.pid,
    ppid: Number(process.env.E0_TSC_PARENT_PID),
    uid: process.getuid(),
    nodeCanonical: canonical({ filename: process.execPath }),
    scriptCanonical: canonical({ filename: process.argv[1] }),
    birthMs: performance.timeOrigin,
  }
  if (
    !policy ||
    expected.nodeCanonical !== policy.node ||
    expected.scriptCanonical !== policy.script ||
    process.ppid !== expected.ppid ||
    expected.uid !== policy.uid ||
    canonical({ filename: process.cwd() }) !== policy.cwd ||
    !/^[a-f0-9-]{36}$/i.test(ticket) ||
    !/^[a-f0-9-]{36}$/i.test(commandId)
  )
    throw new Error('E0 compiler ticket binding is invalid.')
  const directory = policy.ackDirectory
  if (!path.isAbsolute(directory) || raw.realpathSync(directory) !== directory)
    throw new Error('E0 compiler acknowledgement directory is invalid.')
  const filename = path.join(directory, `compiler-${commandId}-${ticket}-${process.pid}.json`)
  const started = performance.now()
  const sleeping = new Int32Array(new SharedArrayBuffer(4))
  let accepted = false
  while (!compilerAckExpired({ started, now: performance.now(), timeout: 5000 })) {
    let fd
    try {
      fd = raw.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      const stat = raw.fstatSync(fd)
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size < 2 ||
        stat.size > 4096
      )
        throw new Error('E0 compiler acknowledgement file is invalid.')
      const ack = JSON.parse(raw.readFileSync(fd, 'utf8'))
      if (!compilerAckMatches({ ack, expected }))
        throw new Error('E0 compiler acknowledgement binding changed.')
      record({ event: 'compiler-ack', ticket, kernel: ack })
      accepted = true
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    } finally {
      if (fd !== undefined) raw.closeSync(fd)
    }
    Atomics.wait(sleeping, 0, 0, 25)
  }
  if (!accepted)
    throw new Error('E0 compiler kernel acknowledgement timed out before its main script.')
}

for (const name of ['readFileSync', 'readFile', 'createReadStream']) {
  fs[name] = function (filename, ...args) {
    deny({ filename, write: false })
    return raw[name].call(this, filename, ...args)
  }
}
for (const name of ['openSync', 'open']) {
  fs[name] = function (filename, flags, ...args) {
    deny({ filename, write: writes({ flags: flags }) })
    readerEvidence({ filename, operation: 'open' })
    return raw[name].call(this, filename, flags, ...args)
  }
}
for (const name of ['realpathSync', 'realpath']) {
  fs[name] = function (filename, ...args) {
    readerEvidence({ filename, operation: 'root' })
    return raw[name].call(this, filename, ...args)
  }
  if (raw[name].native) fs[name].native = fs[name]
}
const writeMethods = [
  'writeFile',
  'appendFile',
  'truncate',
  'unlink',
  'rm',
  'rmdir',
  'mkdir',
  'chmod',
  'chown',
  'utimes',
  'lchmod',
  'lchown',
  'lutimes',
  'mkdtemp',
  'createWriteStream',
]
const twoPaths = ['rename', 'copyFile', 'cp', 'link', 'symlink']
for (const base of [...writeMethods, ...twoPaths]) {
  for (const name of [base, `${base}Sync`]) {
    if (!raw[name]) continue
    fs[name] = function (filename, ...args) {
      deny({ filename, write: true })
      if (twoPaths.includes(base)) deny({ filename: args[0], write: true })
      return raw[name].call(this, filename, ...args)
    }
  }
}
const promises = fs.promises
for (const name of ['readFile', 'open', ...writeMethods, ...twoPaths]) {
  if (typeof promises[name] !== 'function') continue
  const original = promises[name]
  promises[name] = async function (filename, ...args) {
    deny({ filename, write: name === 'open' ? writes({ flags: args[0] }) : name !== 'readFile' })
    if (twoPaths.includes(name)) deny({ filename: args[0], write: true })
    return original.call(this, filename, ...args)
  }
}
for (const name of ['spawn', 'spawnSync', 'fork', 'execFile']) {
  const original = childProcess[name]
  childProcess[name] = function (...args) {
    const options = args.find(
      (argument) =>
        argument &&
        typeof argument === 'object' &&
        !Array.isArray(argument) &&
        argument.detached === true,
    )
    let detachedRequest
    let compilerTicket
    if (options) {
      const policy = config.nextTypeScriptChild
      const stack = new Error().stack || ''
      detachedRequest = {
        node: canonical({ filename: args[0] }),
        script: canonical({ filename: Array.isArray(args[1]) ? args[1][0] : null }),
        cwd: canonical({ filename: options.cwd }),
        uid: options.uid ?? process.getuid(),
        shell: options.shell,
        method: name,
        caller: policy?.callers.find((caller) => stack.includes(caller)) || null,
      }
      const allowed = allowsNextTypeScriptDetached({ policy, request: detachedRequest })
      compilerTicket = allowed ? randomUUID() : null
      record({
        event: 'detached-request',
        allowed,
        ticket: compilerTicket,
        nodeCanonical: detachedRequest.node,
        scriptCanonical: detachedRequest.script,
        cwd: detachedRequest.cwd,
        caller: detachedRequest.caller,
        method: name,
      })
      if (!allowed)
        throw new Error('E0 detached child is outside the exact Next TypeScript policy.')
      if (!String(options.env?.NODE_OPTIONS || '').includes(__filename))
        throw new Error('E0 compiler guard preload is missing.')
      options.env = {
        ...options.env,
        E0_TSC_TICKET: compilerTicket,
        E0_TSC_PARENT_PID: String(process.pid),
        E0_COMMAND_ID: process.env.E0_COMMAND_ID,
      }
    }
    const child = original.apply(this, args)
    if (child.pid) {
      const kernel = null
      record({
        event: 'child',
        method: name,
        child: child.pid,
        node: name === 'fork' || path.basename(String(args[0])) === 'node',
        executable: path.basename(String(args[0])).slice(0, 80),
        detached: Boolean(detachedRequest),
        scope: detachedRequest ? 'next-typescript-cli' : undefined,
        ticket: compilerTicket,
        pendingOuterKernel: Boolean(detachedRequest),
        nodeCanonical: detachedRequest?.node,
        scriptCanonical: detachedRequest?.script,
        scriptBasename: detachedRequest ? path.basename(detachedRequest.script) : undefined,
        caller: detachedRequest?.caller,
        kernel,
      })
    }
    return child
  }
}

syncBuiltinESMExports()
