import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

await test('should load the real Media Collection without resolving the legacy media service', () => {
  const collectionUrl = new URL('../src/collections/Media.ts', import.meta.url).href
  const schemaUrl = new URL('../src/media/schema.ts', import.meta.url).href
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict'
        import { registerHooks } from 'node:module'

        let isHookVerified = false
        let isLegacyServiceTouched = false
        const schemaDependencyAttempts = []
        const hook = registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier === 'heymoro-media-hook-probe') {
              isHookVerified = true
              return { shortCircuit: true, url: 'data:text/javascript,export default true' }
            }
            if (context.parentURL === ${JSON.stringify(schemaUrl)}) {
              schemaDependencyAttempts.push(specifier)
              throw new Error('HEYMORO_SCHEMA_DEPENDENCY_BLOCKED')
            }
            const resolved = nextResolve(specifier, context)
            if (['/src/service-media.ts', '/src/service-media.js'].some((suffix) => new URL(resolved.url).pathname.endsWith(suffix))) {
              isLegacyServiceTouched = true
              throw new Error('HEYMORO_LEGACY_MEDIA_RESOLVE_BLOCKED')
            }
            return resolved
          },
        })

        try {
          const probe = await import('heymoro-media-hook-probe')
          assert.equal(probe.default, true)
          assert.equal(isHookVerified, true)
          const { Media } = await import(${JSON.stringify(collectionUrl)})
          assert.equal(Media.slug, 'media')
          process.stdout.write(JSON.stringify({ isHookVerified, isLegacyServiceTouched, schemaDependencyAttempts }))
        } catch (error) {
          process.stdout.write(JSON.stringify({
            isHookVerified,
            isLegacyServiceTouched,
            schemaDependencyAttempts,
            error: error.message,
          }))
          process.exitCode = 1
        } finally {
          hook.deregister()
        }
      `,
    ],
    { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10_000 },
  )

  assert.ifError(result.error)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(JSON.parse(result.stdout), {
    isHookVerified: true,
    isLegacyServiceTouched: false,
    schemaDependencyAttempts: [],
  })
})

await test('should expose only the unchanged shared media policy constants', async () => {
  const schema = await import('../src/media/schema.ts')

  assert.deepEqual(Object.keys(schema).sort(), [
    'ALLOWED_MEDIA_MIME_TYPES',
    'MEDIA_LIFECYCLES',
    'MEDIA_MAX_BYTES',
  ])
  assert.equal(schema.MEDIA_MAX_BYTES, 10 * 1024 * 1024)
  assert.deepEqual(schema.ALLOWED_MEDIA_MIME_TYPES, ['image/jpeg', 'image/png', 'application/pdf'])
  assert.deepEqual(schema.MEDIA_LIFECYCLES, ['active', 'pendingDelete', 'physicalDeleted'])
})

await test('should map the schema MIME types into the Collection upload policy', async () => {
  const { Media } = await import('../src/collections/Media.ts')
  const { ALLOWED_MEDIA_MIME_TYPES } = await import('../src/media/schema.ts')

  assert.deepEqual(Media.upload.mimeTypes, [...ALLOWED_MEDIA_MIME_TYPES])
})

await test('should map the schema lifecycles into the unchanged Collection select field', async () => {
  const { Media } = await import('../src/collections/Media.ts')
  const { MEDIA_LIFECYCLES } = await import('../src/media/schema.ts')
  const lifecycle = Media.fields.find((field) => field.name === 'lifecycle')

  assert.equal(lifecycle.defaultValue, 'active')
  assert.deepEqual(
    lifecycle.options,
    MEDIA_LIFECYCLES.map((value) => ({ label: value, value })),
  )
})

await test('should accept the exact schema size limit in the real Collection hook', async () => {
  const { Media } = await import('../src/collections/Media.ts')
  const { MEDIA_MAX_BYTES } = await import('../src/media/schema.ts')
  const data = { alt: 'in-memory boundary' }

  assert.equal(
    Media.hooks.beforeValidate[0]({ data, req: { file: { size: MEDIA_MAX_BYTES } } }),
    data,
  )
})

await test('should reject one byte above the schema size limit in the real Collection hook', async () => {
  const { Media } = await import('../src/collections/Media.ts')
  const { MEDIA_MAX_BYTES } = await import('../src/media/schema.ts')

  assert.throws(
    () => Media.hooks.beforeValidate[0]({ data: {}, req: { file: { size: MEDIA_MAX_BYTES + 1 } } }),
    { message: 'FILE_TOO_LARGE' },
  )
})

await test('should preserve Collection validation without an uploaded file', async () => {
  const { Media } = await import('../src/collections/Media.ts')
  const data = { alt: 'metadata only' }

  assert.equal(Media.hooks.beforeValidate[0]({ data, req: {} }), data)
})

const mediaSignatures = [
  { bytes: [0xff, 0xd8, 0xff], mimeType: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mimeType: 'image/png' },
  { bytes: [...Buffer.from('%PDF-')], mimeType: 'application/pdf' },
]

for (const { bytes, mimeType } of mediaSignatures) {
  await test(`should preserve legacy ${mimeType} signature acceptance`, async () => {
    const { validateMediaBytes } = await import('../src/service-media.ts')

    assert.equal(validateMediaBytes(Buffer.from(bytes), mimeType), mimeType)
  })

  await test(`should preserve legacy ${mimeType} signature rejection`, async () => {
    const { validateMediaBytes } = await import('../src/service-media.ts')

    assert.throws(() => validateMediaBytes(Buffer.from('invalid'), mimeType), {
      message: 'FILE_SIGNATURE_INVALID',
    })
  })
}

await test('should preserve legacy rejection of MIME types outside the shared policy', async () => {
  const { validateMediaBytes } = await import('../src/service-media.ts')

  assert.throws(() => validateMediaBytes(Buffer.from('GIF89a'), 'image/gif'), {
    message: 'FILE_TYPE_NOT_ALLOWED',
  })
})

await test('should preserve legacy acceptance of an exact-limit in-memory JPEG', async () => {
  const { validateMediaBytes } = await import('../src/service-media.ts')
  const { MEDIA_MAX_BYTES } = await import('../src/media/schema.ts')
  const bytes = Buffer.alloc(MEDIA_MAX_BYTES)

  bytes.set([0xff, 0xd8, 0xff])
  assert.equal(validateMediaBytes(bytes, 'image/jpeg'), 'image/jpeg')
})

await test('should preserve legacy rejection of an over-limit in-memory JPEG', async () => {
  const { validateMediaBytes } = await import('../src/service-media.ts')
  const { MEDIA_MAX_BYTES } = await import('../src/media/schema.ts')
  const bytes = Buffer.alloc(MEDIA_MAX_BYTES + 1)

  bytes.set([0xff, 0xd8, 0xff])
  assert.throws(() => validateMediaBytes(bytes, 'image/jpeg'), { message: 'FILE_TOO_LARGE' })
})

await test('should stop exporting shared policy constants from the legacy service', async () => {
  const service = await import('../src/service-media.ts')

  for (const name of ['MEDIA_MAX_BYTES', 'ALLOWED_MEDIA_MIME_TYPES', 'MEDIA_LIFECYCLES']) {
    assert.equal(Object.hasOwn(service, name), false)
  }
  assert.equal(typeof service.validateMediaBytes, 'function')
})
