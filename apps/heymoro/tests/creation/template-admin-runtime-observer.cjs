// Test-only observation, not an environment, network, source-write or SQLite sandbox.
const assert = require('node:assert/strict')
const { createHash, randomUUID } = require('node:crypto')
const path = require('node:path')

/** @typedef {{format:number,nonce:string,role:string,runDirectory:string,coreFile:string,coreSHA:string,coreBytes:number,appRoot:string,distRoot:string,sourceAllowlist:readonly string[],receiptDirectory:string,observerSHA:string,maxEvents:number,maxBytes:number}} Control */
/** @typedef {{operation:string,label:string,sha256?:string,bytes?:number,complete:boolean,code?:string,sequence?:number,role?:string,pid?:number,ppid?:number,uid?:number,threadId?:number,instance?:string,nonce?:string,controlSHA?:string,observerSHA?:string}} Event */
/** @typedef {{openSync:(...args:any[])=>number,readSync:(...args:any[])=>number,closeSync:(...args:any[])=>unknown,readFileSync:(...args:any[])=>any,readFile:(...args:any[])=>any,promises:{readFile:(...args:any[])=>Promise<any>}}} ProbeFS */
/** @param {unknown} value @returns {Control} */
function parseControl(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value))
  const keys = [
    'format',
    'nonce',
    'role',
    'runDirectory',
    'coreFile',
    'coreSHA',
    'coreBytes',
    'appRoot',
    'distRoot',
    'sourceAllowlist',
    'receiptDirectory',
    'observerSHA',
    'maxEvents',
    'maxBytes',
  ]
  const descriptors = Object.getOwnPropertyDescriptors(value)
  assert(
    Object.keys(descriptors).length === keys.length &&
      keys.every((key) => descriptors[key] && 'value' in descriptors[key]),
  )
  const row = /** @type {Control} */ (value)
  assert(
    row.format === 1 &&
      /^[a-f0-9-]{36}$/.test(row.nonce) &&
      ['init', 'admin', 'build', 'next-runtime'].includes(row.role),
  )
  for (const filename of [
    row.runDirectory,
    row.coreFile,
    row.appRoot,
    row.distRoot,
    row.receiptDirectory,
  ])
    assert(path.isAbsolute(filename) && path.normalize(filename) === filename)
  assert(
    row.coreFile === path.join(row.runDirectory, 'core.json') &&
      inside(row.distRoot, path.join(row.appRoot, '.template-admin-next')) &&
      row.distRoot !== path.join(row.appRoot, '.template-admin-next') &&
      row.receiptDirectory === path.join(row.runDirectory, 'observations'),
  )
  assert(!inside(row.appRoot, row.runDirectory) && !inside(row.runDirectory, row.appRoot))
  assert(/^[a-f0-9]{64}$/.test(row.coreSHA) && /^[a-f0-9]{64}$/.test(row.observerSHA))
  assert(Number.isSafeInteger(row.coreBytes) && row.coreBytes >= 2 && row.coreBytes <= 65536)
  assert(
    Number.isSafeInteger(row.maxEvents) &&
      row.maxEvents >= 4 &&
      row.maxEvents <= 256 &&
      Number.isSafeInteger(row.maxBytes) &&
      row.maxBytes >= 2048 &&
      row.maxBytes <= 65536,
  )
  assert(
    Array.isArray(row.sourceAllowlist) &&
      row.sourceAllowlist.length > 0 &&
      row.sourceAllowlist.length <= 512,
  )
  assert(
    row.sourceAllowlist.every(
      (name) =>
        typeof name === 'string' &&
        !path.isAbsolute(name) &&
        name
          .split('/')
          .every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.env')),
    ),
  )
  return Object.freeze({ ...row, sourceAllowlist: Object.freeze([...row.sourceAllowlist]) })
}
/** Inert factory: no env/control reads, no global installation until install().
 * @param {{control:unknown,fs:ProbeFS,modulePrototype:{_compile:(...args:any[])=>any},emit:(event:Event)=>void,syncExports:()=>void}} args */
function createRuntimeObserver({ control: input, fs, modulePrototype, emit, syncExports }) {
  const control = parseControl(input)
  const originals = {
    openSync: fs.openSync,
    readSync: fs.readSync,
    closeSync: fs.closeSync,
    readFileSync: fs.readFileSync,
    readFile: fs.readFile,
    readPromise: fs.promises.readFile,
    compile: modulePrototype._compile,
  }
  const descriptors = new Set()
  let isFailed = false
  let isInstalled = false
  let count = 0
  let observedBytes = 0
  /** @param {Event} event */
  const observe = (event) => {
    if (isFailed) return
    try {
      const size = Buffer.byteLength(JSON.stringify(event))
      if (++count > control.maxEvents - 1 || (observedBytes += size) > control.maxBytes - 1024) {
        isFailed = true
        return
      }
      emit(event)
    } catch {
      isFailed = true
    }
  }
  /** @param {unknown} filename */
  const label = (filename) => {
    if (typeof filename !== 'string') return null
    const relative = path.relative(control.appRoot, filename)
    if (control.sourceAllowlist.includes(relative)) return `app/${relative}`
    return null
  }
  /** @param {unknown} filename @param {unknown} result @param {unknown} options */
  const observeSource = (filename, result, options) => {
    const approved = label(filename)
    if (!approved) return
    try {
      if (ArrayBuffer.isView(result)) {
        const bytes = Buffer.from(result.buffer, result.byteOffset, result.byteLength)
        observe({
          operation: 'source-read',
          label: approved,
          sha256: hash(bytes),
          bytes: bytes.length,
          complete: true,
        })
      } else if (typeof result === 'string') {
        const encoding =
          typeof options === 'string'
            ? options
            : options && typeof options === 'object' && 'encoding' in options
              ? options.encoding
              : null
        if (typeof encoding === 'string' && Buffer.isEncoding(encoding)) {
          const bytes = Buffer.from(result, encoding)
          // This is returned-text representation, explicitly not the raw file byte digest.
          observe({
            operation: 'text-read',
            label: approved,
            sha256: hash(bytes),
            bytes: bytes.length,
            complete: true,
            code: 'TEXT_REPRESENTATION_ONLY',
          })
        }
      }
    } catch {
      isFailed = true
    }
  }
  return {
    get failed() {
      return isFailed
    },
    install() {
      if (isInstalled) return
      isInstalled = true
      fs.openSync = function (...args) {
        const fd = Reflect.apply(originals.openSync, this, args)
        descriptors.delete(fd)
        if (args[0] === control.coreFile) descriptors.add(fd)
        return fd
      }
      fs.readSync = function (...args) {
        const result = Reflect.apply(originals.readSync, this, args)
        if (descriptors.has(args[0])) {
          try {
            const [, view, offset, , position] = args
            if (
              ArrayBuffer.isView(view) &&
              Number.isSafeInteger(offset) &&
              offset >= 0 &&
              Number.isSafeInteger(result) &&
              result >= 0 &&
              offset + result <= view.byteLength
            ) {
              const bytes = Buffer.from(view.buffer, view.byteOffset + offset, result)
              const sha256 = hash(bytes)
              observe({
                operation: 'core-read',
                label: 'core',
                sha256,
                bytes: result,
                complete:
                  position === 0 && result === control.coreBytes && sha256 === control.coreSHA,
              })
            } else
              observe({
                operation: 'core-read',
                label: 'core',
                complete: false,
                code: 'UNSUPPORTED_READ_SHAPE',
              })
          } catch {
            isFailed = true
          }
        }
        return result
      }
      fs.closeSync = function (...args) {
        try {
          return Reflect.apply(originals.closeSync, this, args)
        } finally {
          descriptors.delete(args[0])
        }
      }
      fs.readFileSync = function (...args) {
        const result = Reflect.apply(originals.readFileSync, this, args)
        observeSource(args[0], result, args[1])
        return result
      }
      fs.readFile = function (...args) {
        const callback = args.at(-1)
        if (typeof callback !== 'function') return Reflect.apply(originals.readFile, this, args)
        const options = args[1]
        const forwarded = [
          ...args.slice(0, -1),
          /** @this {unknown} @param {any[]} values */ function (...values) {
            if (!values[0]) observeSource(args[0], values[1], options)
            // Deliberately outside an observation catch: a user callback throw remains the original throw.
            return Reflect.apply(callback, this, values)
          },
        ]
        return Reflect.apply(originals.readFile, this, forwarded)
      }
      fs.promises.readFile = function (...args) {
        return Reflect.apply(originals.readPromise, this, args).then((result) => {
          observeSource(args[0], result, args[1])
          return result
        })
      }
      modulePrototype._compile = function (...args) {
        const [content, filename] = args
        const approved =
          typeof filename === 'string' &&
          path.normalize(filename) === filename &&
          (inside(filename, control.appRoot) || inside(filename, control.distRoot))
        const result = Reflect.apply(originals.compile, this, args)
        if (approved && (typeof content === 'string' || ArrayBuffer.isView(content))) {
          try {
            const bytes =
              typeof content === 'string'
                ? Buffer.from(content, 'utf8')
                : Buffer.from(content.buffer, content.byteOffset, content.byteLength)
            const root = inside(filename, control.distRoot) ? control.distRoot : control.appRoot
            const prefix = root === control.distRoot ? 'dist' : 'app'
            observe({
              operation: 'compiled-load',
              label: `${prefix}/${path.relative(root, filename)}`,
              sha256: hash(bytes),
              bytes: bytes.length,
              complete: true,
            })
          } catch {
            isFailed = true
          }
        }
        return result
      }
      syncExports()
    },
  }
}
/** @param {{control:unknown,events:Event[],allowedPIDs:number[]}} args */
function validateObservationEvidence({ control: input, events, allowedPIDs }) {
  const control = parseControl(input)
  assert(events.length > 0 && events.length <= control.maxEvents * 16)
  /** @type {Map<string, Event[]>} */
  const groups = new Map()
  for (const event of events) {
    const keys = [
      'operation',
      'label',
      'sha256',
      'bytes',
      'complete',
      'code',
      'sequence',
      'role',
      'pid',
      'ppid',
      'uid',
      'threadId',
      'instance',
      'nonce',
      'controlSHA',
      'observerSHA',
    ]
    assert(Object.keys(event).every((key) => keys.includes(key)))
    assert(
      ['core-read', 'source-read', 'text-read', 'compiled-load', 'terminal'].includes(
        event.operation,
      ),
    )
    assert(
      Number.isSafeInteger(event.threadId) &&
        Number(event.threadId) >= 0 &&
        typeof event.complete === 'boolean',
    )
    assert(event.sha256 === undefined || /^[a-f0-9]{64}$/.test(event.sha256))

    assert(
      event.role === control.role &&
        event.nonce === control.nonce &&
        allowedPIDs.includes(event.pid ?? -1) &&
        event.observerSHA === control.observerSHA,
    )
    assert(typeof event.instance === 'string' && /^[a-f0-9-]{36}$/.test(event.instance))
    const key = `${event.pid}:${event.threadId}:${event.instance}`
    const items = groups.get(key) ?? []
    items.push(event)
    groups.set(key, items)
  }
  assert(groups.size <= 16)
  for (const items of groups.values()) {
    assert(items.every((event, index) => event.sequence === index + 1))
    const terminal = items.at(-1)
    assert(
      terminal &&
        terminal.operation === 'terminal' &&
        terminal.complete === true &&
        !items.some((event) => event.code === 'OBSERVATION_FAILED'),
    )
  }
  assert(
    events.some(
      (event) =>
        event.operation === 'core-read' &&
        event.complete &&
        event.sha256 === control.coreSHA &&
        event.bytes === control.coreBytes,
    ),
  )
  if (control.role === 'next-runtime')
    assert(
      events.some(
        (event) =>
          event.operation === 'compiled-load' &&
          event.complete &&
          [
            'dist/server/app/(payload)/admin/[[...segments]]/page.js',
            'dist/server/app/(payload)/api/[...slug]/route.js',
          ].includes(event.label),
      ),
    )
  return true
}

function activatePreload() {
  const fs = require('node:fs')
  const { Module, syncBuiltinESMExports } = require('node:module')
  const { threadId } = require('node:worker_threads')
  const filename = process.env.HEYMORO_TEMPLATE_ADMIN_OBSERVATION_CONTROL_FILE
  assert(filename && path.isAbsolute(filename))
  const info = fs.lstatSync(filename)
  assert(
    info.isFile() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o077) === 0 &&
      info.uid === process.getuid?.() &&
      info.size <= 65536 &&
      fs.realpathSync(filename) === filename,
  )
  const controlBytes = fs.readFileSync(filename)
  const control = parseControl(JSON.parse(controlBytes.toString('utf8')))
  assert(path.dirname(filename) === control.runDirectory)
  assert(hash(fs.readFileSync(__filename)) === control.observerSHA)
  for (const root of [control.runDirectory, control.receiptDirectory, control.appRoot])
    assert(fs.realpathSync(root) === root && fs.lstatSync(root).isDirectory())
  assert((fs.lstatSync(control.receiptDirectory).mode & 0o077) === 0)
  const instance = randomUUID()
  const originalWrite = fs.writeSync
  const originalClose = fs.closeSync
  /** @type {number | undefined} */
  let descriptor
  const logHash = createHash('sha256')
  const originalWriteFile = fs.writeFileSync
  let isFailed = false
  let sequence = 0
  let bytes = 0
  try {
    descriptor = fs.openSync(
      path.join(control.receiptDirectory, `${process.pid}-${threadId}-${instance}.jsonl`),
      'wx',
      0o600,
    )
  } catch {
    isFailed = true
  }
  /** @param {Event} event */
  const sink = (event) => {
    const row = {
      ...event,
      nonce: control.nonce,
      role: control.role,
      pid: process.pid,
      ppid: process.ppid,
      uid: process.getuid?.(),
      threadId,
      instance,
      sequence: ++sequence,
      controlSHA: hash(controlBytes),
      observerSHA: control.observerSHA,
    }
    const text = `${JSON.stringify(row)}\n`
    if (descriptor === undefined || (bytes += Buffer.byteLength(text)) > control.maxBytes) {
      isFailed = true
      throw Error('Observation sink budget failed.')
    }
    try {
      assert.equal(originalWrite(descriptor, text), Buffer.byteLength(text))
      logHash.update(text)
    } catch {
      isFailed = true
      throw Error('Observation sink failed.')
    }
  }
  const probe = createRuntimeObserver({
    control,
    fs,
    modulePrototype: /** @type {{_compile:(...args:any[])=>any}} */ (
      /** @type {unknown} */ (Module.prototype)
    ),
    emit: sink,
    syncExports: syncBuiltinESMExports,
  })
  probe.install()
  process.once('exit', () => {
    try {
      sink({
        operation: 'terminal',
        label: 'instance',
        complete: !isFailed && !probe.failed,
        ...(isFailed || probe.failed ? { code: 'OBSERVATION_FAILED' } : {}),
      })
    } catch {
      isFailed = true
    }
    if (descriptor !== undefined) {
      try {
        originalClose(descriptor)
      } catch {
        isFailed = true
      }
    }
    if (!isFailed && !probe.failed) {
      try {
        originalWriteFile(
          path.join(control.receiptDirectory, `${process.pid}-${threadId}-${instance}.done.json`),
          JSON.stringify({
            nonce: control.nonce,
            role: control.role,
            pid: process.pid,
            threadId,
            instance,
            sequence,
            bytes,
            sha256: logHash.digest('hex'),
          }),
          { mode: 0o600, flag: 'wx' },
        )
      } catch {
        isFailed = true
      }
    }
  })
}
/** @param {Uint8Array} bytes */
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
/** @param {string} filename @param {string} root */
function inside(filename, root) {
  return filename === root || filename.startsWith(`${root}${path.sep}`)
}
module.exports = { createRuntimeObserver, parseControl, validateObservationEvidence }
// module.isPreloading is false for an ordinary import of the pure factory.
if (/** @type {{isPreloading?:boolean}} */ (module).isPreloading) activatePreload()
