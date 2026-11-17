import type { SQLiteSchemaHook } from '@payloadcms/db-sqlite'

import { is, SQL } from 'drizzle-orm'
import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { assertNoDangerousMode } from './config.js'

const profile = 'heymoro-core'
const format = 1
const tickets = new WeakSet<object>()
export type TargetInitialization = Readonly<{ dataDir: string; nonce: string }>
type Manifest = {
  fingerprint?: string
  format: number
  nonce: string
  profile: string
  state: string
}

export function assertTargetInitializationMode() {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    throw new Error('Explicit core initialization requires development or test mode.')
  }
}

/** Exclusive ownership is explicit; failed initialization leaves prepared evidence for inspection. */
export function prepareTarget({ dataDir }: { dataDir: string }): TargetInitialization {
  assertNoDangerousMode()
  assertTargetInitializationMode()
  assertPath({ allowMissingLeaf: true, filename: dataDir })
  mkdirSync(dataDir, { mode: 0o700 })
  const nonce = randomUUID()
  const ticket = Object.freeze({ dataDir, nonce })
  tickets.add(ticket)
  const fd = openSync(path.join(dataDir, 'core.sqlite'), 'wx', 0o600)
  closeSync(fd)
  writeFileSync(
    path.join(dataDir, 'profile.json'),
    JSON.stringify({ format, nonce, profile, state: 'prepared' }),
    { flag: 'wx', mode: 0o600 },
  )
  return ticket
}

export function createTargetProfile({
  dataDir,
  initialization,
}: {
  dataDir: string
  initialization?: TargetInitialization
}) {
  let expectedFingerprint: string | undefined
  let expectedShape: Shape[] | undefined
  const databaseFile = path.join(dataDir, 'core.sqlite')
  const manifestFile = path.join(dataDir, 'profile.json')
  const readManifest = (): Manifest => {
    assertNoDangerousMode()
    for (const filename of [dataDir, databaseFile, manifestFile]) {
      assertPath({ filename })
    }
    const stat = lstatSync(manifestFile)
    if (!stat.isFile() || stat.size > 4096) {
      throw new Error('Unrecognized core target profile.')
    }
    let manifest: Manifest
    try {
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest
    } catch {
      throw new Error('Unrecognized core target profile.')
    }
    if (
      manifest.profile !== profile ||
      manifest.format !== format ||
      typeof manifest.nonce !== 'string' ||
      !/^[\w-]{36}$/.test(manifest.nonce)
    ) {
      throw new Error('Unrecognized core target profile.')
    }
    if (initialization) {
      if (
        !tickets.has(initialization) ||
        initialization.dataDir !== dataDir ||
        manifest.nonce !== initialization.nonce ||
        manifest.state !== 'prepared'
      ) {
        throw new Error('Core initialization ownership is invalid.')
      }
    } else if (manifest.state !== 'ready' || !/^[a-f0-9]{64}$/.test(manifest.fingerprint ?? '')) {
      throw new Error('Core target must already be ready.')
    }
    return manifest
  }
  // Files and markers are checked at configuration, again at Native schema init, and before connect.
  readManifest()
  const afterSchemaInit: SQLiteSchemaHook = ({ schema }) => {
    const manifest = readManifest()
    const expected = Object.values(schema.tables).map((table) =>
      getTableConfig(table as unknown as Parameters<typeof getTableConfig>[0]),
    )
    const dialect = new SQLiteSyncDialect()
    expectedShape = expected
      .map((table) => {
        if (
          table.primaryKeys.length ||
          table.uniqueConstraints.length ||
          table.checks.length ||
          table.indexes.some(({ config }) => Boolean(config.where))
        ) {
          throw new Error('Unsupported Native target constraint metadata.')
        }
        return {
          name: table.name,
          autoIncrement: table.columns.some(
            (column) =>
              column.primary && 'autoIncrement' in column && column.autoIncrement === true,
          ),
          columns: table.columns.map((column) => ({
            name: column.name,
            type: column.getSQLType().toUpperCase(),
            default:
              column.default === undefined
                ? null
                : normalizeDefault(
                    is(column.default, SQL)
                      ? dialect.sqlToQuery(column.default).sql
                      : defaultLiteral(column.default),
                  ),
            hidden: 0,
            notnull: column.notNull ? 1 : 0,
            pk: column.primary ? 1 : 0,
          })),
          foreignKeys: table.foreignKeys
            .map((key) => {
              const reference = key.reference()
              return {
                from: reference.columns.map((column) => column.name).join(','),
                onDelete: (key.onDelete ?? 'no action').toUpperCase(),
                onUpdate: (key.onUpdate ?? 'no action').toUpperCase(),
                table: getTableConfig(reference.foreignTable).name,
                to: reference.foreignColumns.map((column) => column.name).join(','),
              }
            })
            .sort(byJSON),
          indexes: [
            ...table.indexes.map(({ config }) => ({
              name: config.name,
              columns: config.columns.map((column) => {
                if (!('name' in column)) {
                  throw new Error('Unsupported Native expression index.')
                }
                return { name: column.name, coll: 'BINARY', desc: 0 }
              }),
              origin: 'c',
              partial: config.where ? 1 : 0,
              unique: config.unique ? 1 : 0,
            })),
            ...table.columns
              .filter((column) => column.primary && column.getSQLType().toUpperCase() !== 'INTEGER')
              .map((column) => ({
                name: `sqlite_autoindex_${table.name}_1`,
                columns: [{ name: column.name, coll: 'BINARY', desc: 0 }],
                origin: 'pk',
                partial: 0,
                unique: 1,
              })),
          ].sort(byName),
        }
      })
      .sort(byName)
    expectedFingerprint = digest(expectedShape)
    if (initialization) {
      assertTargetInitializationMode()
      const database = new DatabaseSync(databaseFile, { readOnly: true })
      try {
        if (
          database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()
            .length
        ) {
          throw new Error('Prepared target is not empty; refusing schema repair.')
        }
      } finally {
        database.close()
      }
    } else if (manifest.fingerprint !== expectedFingerprint) {
      throw new Error('Core target configuration schema has changed.')
    }
    if (!initialization) {
      attest({ databaseFile, expectedShape })
    }
    return schema
  }
  return Object.freeze({
    afterSchemaInit,
    assertReadyForConnect: () => {
      readManifest()
      if (!expectedFingerprint || !expectedShape) {
        throw new Error('Native schema attestation is required before connect.')
      }
      if (!initialization) {
        attest({ databaseFile, expectedShape })
      }
    },
    databaseFile,
    finish: () => {
      if (!initialization) {
        return
      }
      const manifest = readManifest()
      if (!expectedFingerprint || !expectedShape) {
        throw new Error('Native schema was not initialized.')
      }
      attest({ databaseFile, expectedShape })
      const temporary = path.join(dataDir, `.profile-${initialization.nonce}.json`)
      writeFileSync(
        temporary,
        JSON.stringify({ ...manifest, fingerprint: expectedFingerprint, state: 'ready' }),
        { flag: 'wx', mode: 0o600 },
      )
      readManifest()
      renameSync(temporary, manifestFile)
      tickets.delete(initialization)
    },
  })
}

type Shape = {
  autoIncrement: boolean
  columns: {
    default: null | string
    hidden: number
    name: string
    notnull: number
    pk: number
    type: string
  }[]
  foreignKeys: { from: string; onDelete: string; onUpdate: string; table: string; to: string }[]
  indexes: {
    columns: { coll: string; desc: number; name: string | undefined }[]
    name: string
    origin: string
    partial: number
    unique: number
  }[]
  name: string
}
function attest({ databaseFile, expectedShape }: { databaseFile: string; expectedShape: Shape[] }) {
  const database = new DatabaseSync(databaseFile, { readOnly: true })
  try {
    if (
      database.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger', 'view')").all()
        .length
    ) {
      throw new Error('Unexpected core target executable schema objects.')
    }
    const tables = database
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
    const actual = tables
      .map((table) => {
        const name = String(table.name)
        // Native emits no SQL comments; reject unknown forms rather than treating comment text as constraints.
        if (/--|\/\*|\*\//.test(String(table.sql))) {
          throw new Error('Unsupported core target SQL comments.')
        }
        if (/\bCHECK\s*\(|\bSTRICT\s*(?:;\s*)?$|\bWITHOUT\s+ROWID\b/i.test(String(table.sql))) {
          throw new Error('Unsupported core target table constraint.')
        }
        const columns = database
          .prepare(`PRAGMA table_xinfo(${quote(name)})`)
          .all()
          .map((column) => ({
            name: String(column.name),
            type: String(column.type).toUpperCase(),
            default:
              column.dflt_value === null ? null : normalizeDefault(String(column.dflt_value)),
            hidden: Number(column.hidden),
            notnull: Number(column.notnull),
            pk: Number(column.pk),
          }))
        const indexes = database
          .prepare(`PRAGMA index_list(${quote(name)})`)
          .all()
          .map((index) => ({
            name: String(index.name),
            columns: database
              .prepare(`PRAGMA index_xinfo(${quote(String(index.name))})`)
              .all()
              .filter((column) => Number(column.key) === 1)
              .map((column) => ({
                name: column.name == null ? undefined : String(column.name),
                coll: String(column.coll),
                desc: Number(column.desc),
              })),
            origin: String(index.origin),
            partial: Number(index.partial),
            unique: Number(index.unique),
          }))
          .sort(byName)
        const grouped = new Map<
          number,
          { from: string[]; onDelete: string; onUpdate: string; table: string; to: string[] }
        >()
        for (const key of database.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all()) {
          const id = Number(key.id)
          const group = grouped.get(id) ?? {
            from: [],
            onDelete: String(key.on_delete),
            onUpdate: String(key.on_update),
            table: String(key.table),
            to: [],
          }
          group.from.push(String(key.from))
          group.to.push(String(key.to))
          grouped.set(id, group)
        }
        const foreignKeys = [...grouped.values()]
          .map((key) => ({ ...key, from: key.from.join(','), to: key.to.join(',') }))
          .sort(byJSON)
        return {
          name,
          autoIncrement: /\bAUTOINCREMENT\b/i.test(String(table.sql)),
          columns,
          foreignKeys,
          indexes,
        }
      })
      .sort(byName)
    if (digest(actual) !== digest(expectedShape)) {
      throw new Error('Core target schema attestation failed; no repairs were attempted.')
    }
  } finally {
    database.close()
  }
}
function assertPath({
  allowMissingLeaf = false,
  filename,
}: {
  allowMissingLeaf?: boolean
  filename: string
}) {
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) {
    throw new Error('Core target requires canonical absolute paths.')
  }
  const parts = filename.split(path.sep).filter(Boolean)
  let current = path.parse(filename).root
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    if (allowMissingLeaf && index === parts.length - 1 && !existsSync(current)) {
      continue
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error('Core target paths must not contain symlinks.')
    }
  }
  if (existsSync(filename) && realpathSync(filename) !== filename) {
    throw new Error('Core target path conflict.')
  }
}
function quote(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}
function byName(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name)
}
function byJSON(a: unknown, b: unknown) {
  return JSON.stringify(a).localeCompare(JSON.stringify(b))
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function defaultLiteral(value: unknown) {
  if (value === null) {
    return 'NULL'
  }
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'string') {
    return `'${value.replaceAll("'", "''")}'`
  }
  throw new Error('Unsupported Native default metadata.')
}
function normalizeDefault(value: string): string {
  let result = value.trim()
  while (result.startsWith('(') && result.endsWith(')')) {
    result = result.slice(1, -1).trim()
  }
  return result
}
