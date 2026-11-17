import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'

/** Shared by the two private host JSON inputs. All IO, including close, stays inside the redaction boundary. */
export function readPrivateJSON({
  fileMessage,
  filename,
  maxBytes,
  pathMessage,
  projectRoot,
}: {
  fileMessage: string
  filename?: string
  maxBytes: number
  pathMessage: string
  projectRoot: string
}): unknown {
  if (
    !filename ||
    !path.isAbsolute(filename) ||
    path.extname(filename) !== '.json' ||
    path.basename(filename).startsWith('.env')
  ) {
    throw new Error(pathMessage)
  }
  try {
    if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()) {
      throw new Error()
    }
    const canonical = realpathSync(filename)
    const relative = path.relative(realpathSync(projectRoot), canonical)
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..') {
      throw new Error()
    }
    const descriptor = openSync(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const before = fstatSync(descriptor)
      if (!before.isFile() || before.size < 2 || before.size > maxBytes) {
        throw new Error()
      }
      const bytes = Buffer.alloc(before.size + 1)
      const size = readSync(descriptor, bytes, 0, bytes.length, 0)
      const after = fstatSync(descriptor)
      const leaf = lstatSync(canonical)
      if (
        leaf.dev !== after.dev ||
        leaf.ino !== after.ino ||
        leaf.size !== after.size ||
        leaf.mtimeMs !== after.mtimeMs ||
        leaf.ctimeMs !== after.ctimeMs ||
        size !== before.size ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        realpathSync(filename) !== canonical ||
        lstatSync(filename).isSymbolicLink()
      ) {
        throw new Error()
      }
      return JSON.parse(bytes.subarray(0, size).toString('utf8')) as unknown
    } finally {
      closeSync(descriptor)
    }
  } catch {
    throw new Error(fileMessage)
  }
}
