import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const json = async (name) => JSON.parse(await readFile(path.join(root, name), 'utf8'))

test('application is a private local-workspace consumer with independent commands', async () => {
  const pkg = await json('package.json')
  assert.equal(pkg.name, '@heymoro/server')
  assert.equal(pkg.private, true)
  assert.equal(pkg.dependencies.payload, 'workspace:*')
  assert.match(pkg.scripts.dev, /next dev/)
  assert.doesNotMatch(JSON.stringify(pkg), /starter|test\/dev|buildConfigWithDefaults/)
})

test('runtime source has no fixture or starter imports', async () => {
  const source = path.join(root, 'src')
  const files = await readdir(source, { recursive: true })
  assert.ok(files.includes('payload.config.ts'))
  for (const file of files.filter((name) => /\.[cm]?[jt]sx?$/.test(name))) {
    const text = await readFile(path.join(source, file), 'utf8')
    assert.doesNotMatch(
      text,
      /(?:from\s*|import\s*\()\s*['"][^'"]*(?:test\/|_community|starter|credentials|buildConfigWithDefaults)/,
      file,
    )
  }
})

test('application alias and database configuration are independent of test initialization', async () => {
  const ts = await json('tsconfig.json')
  assert.deepEqual(ts.compilerOptions.paths['@payload-config'], ['./src/payload.config.ts'])
  assert.equal(ts.extends, undefined)
  const config = await readFile(path.join(root, 'src/payload.config.ts'), 'utf8')
  assert.match(config, /buildCorePayloadConfig/)
  assert.match(config, /readCoreConfig/)
  const builder = await readFile(path.join(root, 'src/creation/runtime/payload-config.ts'), 'utf8')
  assert.match(builder, /sqliteAdapter/)
  assert.doesNotMatch(
    builder,
    /Records|Generations|authEndpoints|creationEndpoints|recordsEndpoints|mediaEndpoints|creationJobs/,
  )
  assert.match(builder, /autoLogin: false/)
  assert.doesNotMatch(config, /TEST_SECRET|seed:|re-initialize|buildConfigWithDefaults/)
})

// Original SHA-256 values remain archived in migration-manifest.json.
test('migration source inventory remains available after subsequent development', async () => {
  const manifest = await json('tests/migration-manifest.json')
  assert.equal(manifest.length, 20)
  for (const item of manifest) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/)
    await readFile(path.resolve(root, '../..', item.target))
  }
})

test('Node webpack externalizes the Payload-resolved file-type as native ESM only', async () => {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const config = (await import('../next.config.mjs')).default
  const appRequire = createRequire(new URL('../next.config.mjs', import.meta.url))
  const expected = pathToFileURL(
    createRequire(appRequire.resolve('payload')).resolve('file-type'),
  ).href
  assert.ok(
    config.serverExternalPackages.includes('file-type'),
    'reuse framework external declaration',
  )
  const originalExternal = (_request, callback) => callback()
  const existingPlugin = {}
  const compile = (isServer, nextRuntime) =>
    config.webpack(
      { resolve: {}, externals: [originalExternal], plugins: [existingPlugin] },
      {
        isServer,
        nextRuntime,
        webpack: { IgnorePlugin: class IgnorePlugin {} },
      },
    )
  const server = compile(true, 'nodejs')
  let result
  server.externals[0]({ request: 'file-type' }, (...args) => {
    result = args
  })
  assert.deepEqual(result, [null, expected, 'import'])
  assert.equal(server.externals[1], originalExternal)
  assert.ok(server.plugins.includes(existingPlugin))
  server.externals[0]({ request: 'some-other-package' }, (...args) => {
    result = args
  })
  assert.deepEqual(result, [])
  for (const [isServer, nextRuntime] of [
    [false, undefined],
    [true, 'edge'],
  ]) {
    assert.equal(compile(isServer, nextRuntime).externals[0], originalExternal)
  }
  const native = await import(expected)
  assert.equal(typeof native.fileTypeFromFile, 'function')
  await native.fileTypeFromFile(path.join(root, 'package.json'))
})
