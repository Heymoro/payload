import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate as tick } from 'node:timers/promises'

const filename = fileURLToPath(import.meta.url)
const option = ({ name }) => process.argv[process.argv.indexOf(name) + 1]
const integer = ({ name, fallback, maximum }) => {
  const value = process.argv.includes(name) ? Number(option({ name })) : fallback
  assert.ok(Number.isSafeInteger(value) && value > 0 && value <= maximum, name)
  return value
}
const fromClient = createRequire(createRequire(import.meta.url).resolve('@libsql/client'))
const fromBinding = createRequire(fromClient.resolve('libsql'))
const nativeFile = fromBinding.resolve('@libsql/darwin-arm64')
const binarySHA256 = createHash('sha256')
  .update(await readFile(nativeFile))
  .digest('hex')

if (process.argv.includes('--child')) {
  const { createClient } = await import('@libsql/client')
  const cycles = integer({ name: '--cycles', fallback: 2000, maximum: 10000 })
  const client = createClient({ url: `file:${option({ name: '--db' })}` })
  await client.execute('PRAGMA journal_mode=WAL')
  await client.execute('CREATE TABLE smoke (seq INTEGER PRIMARY KEY, label TEXT, bytes BLOB)')
  let expected = 0
  for (let index = 1; index <= cycles; index++) {
    const transaction = await client.transaction('deferred')
    try {
      await transaction.execute({
        sql: 'INSERT INTO smoke VALUES (?, ?, ?)',
        args: [index, `row-${index}`, new Uint8Array([0, 127, 255])],
      })
      await client.execute('SELECT COUNT(*) FROM smoke')
      if (index % 7 === 0) await transaction.rollback()
      else {
        await transaction.commit()
        expected++
      }
    } finally {
      transaction.close()
    }
    if (index % 25 === 0) {
      global.gc()
      await tick()
      global.gc()
      await tick()
    }
  }
  const count = await client.execute('SELECT COUNT(*) AS count FROM smoke')
  assert.equal(Number(count.rows[0].count), expected)
  const row = (await client.execute('SELECT label, bytes FROM smoke ORDER BY seq LIMIT 1')).rows[0]
  assert.equal(row.label, 'row-1')
  assert.deepEqual([...new Uint8Array(row.bytes)], [0, 127, 255])
  assert.equal((await client.execute('PRAGMA quick_check')).rows[0].quick_check, 'ok')
  client.close()
  for (let index = 0; index < 12; index++) {
    global.gc()
    await tick()
  }
  console.log(JSON.stringify({ cycles, committed: expected, binarySHA256 }))
} else {
  assert.equal(process.platform, 'darwin', 'This backport is validated only on Darwin arm64.')
  assert.equal(process.arch, 'arm64')
  const runs = integer({ name: '--runs', fallback: 8, maximum: 20 })
  const cycles = integer({ name: '--cycles', fallback: 2000, maximum: 10000 })
  const output = option({ name: '--output' })
  assert.ok(
    process.argv.includes('--output') && path.isAbsolute(output),
    'Use a new absolute output directory.',
  )
  await mkdir(output, { mode: 0o700 })
  const results = []
  for (let index = 0; index < runs; index++) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--expose-gc',
          '--max-old-space-size=256',
          filename,
          '--child',
          '--cycles',
          String(cycles),
          '--db',
          path.join(output, `run-${index}.sqlite`),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stdout = '',
        stderr = ''
      const timeout = setTimeout(() => child.kill('SIGTERM'), 120000)
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        assert.ok(stdout.length < 32768)
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
        assert.ok(stderr.length < 32768)
      })
      child.on('error', reject)
      child.on('close', (code, signal) => {
        clearTimeout(timeout)
        resolve({ code, signal, stdout, stderr })
      })
    })
    results.push(result)
    await writeFile(
      path.join(output, 'report.json'),
      JSON.stringify({ nativeFile, binarySHA256, runs, cycles, results }, null, 2),
    )
    assert.equal(result.signal, null, `native process ${index} crashed`)
    assert.equal(result.code, 0, `native process ${index}: ${result.stderr}`)
  }
  console.log(
    JSON.stringify({
      runs,
      cycles,
      totalTransactions: runs * cycles,
      allProcessesExitedCleanly: true,
      binarySHA256,
    }),
  )
}
