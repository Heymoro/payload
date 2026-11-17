import test from 'node:test'
import assert from 'node:assert/strict'

const creation = () => import('../src/service-creation.ts')
test('should validate immutable creation snapshots and template image requirements', async () => {
  const { parseGenerationInput, snapshotHash, validateTemplateInputs } = await creation()
  const input = {
    sessionId: 1,
    prompt: ' hello ',
    inputMediaIds: [3, 2],
    clientRequestId: 'request-1',
  }
  assert.deepEqual(parseGenerationInput(input), { ...input, prompt: 'hello' })
  assert.equal(snapshotHash(input), snapshotHash({ ...input }))
  assert.notEqual(snapshotHash(input), snapshotHash({ ...input, inputMediaIds: [2, 3] }))
  for (const bad of [
    { ...input, inputMediaIds: Array(9).fill(1) },
    { ...input, prompt: 'x'.repeat(2001) },
    { ...input, clientRequestId: '' },
    { ...input, status: 'succeeded' },
    { ...input, inputMediaIds: ['3'] },
  ])
    assert.throws(() => parseGenerationInput(bad))
  assert.throws(
    () => validateTemplateInputs({ templateId: 'retro', inputMediaIds: [] }),
    /INPUT_IMAGE_REQUIRED/,
  )
  assert.doesNotThrow(() => validateTemplateInputs({ templateId: 'free', inputMediaIds: [] }))
})
test('should count unknown as reserved and only successful persisted outputs as consumed', async () => {
  const { calculateCreationAccount } = await creation()
  assert.deepEqual(
    calculateCreationAccount({ statuses: ['failed', 'unknown'], configured: true }),
    { available: 1, reserved: 1, consumed: 0, configured: true },
  )
  assert.deepEqual(
    calculateCreationAccount({ statuses: ['succeeded', 'running'], configured: false }),
    { available: 0, reserved: 1, consumed: 1, configured: false },
  )
})
test('should reject missing provider config and fixture provider in production', async () => {
  const { readImageProviderConfig } = await import('../src/image-provider.ts')
  assert.equal(readImageProviderConfig({}).configured, false)
  assert.throws(
    () =>
      readImageProviderConfig({
        NODE_ENV: 'production',
        HEYMORO_IMAGE_PROVIDER: 'fixture',
        HEYMORO_AUTOMATED_TEST: 'true',
      }),
    /FIXTURE_PROVIDER/,
  )
  assert.throws(
    () => readImageProviderConfig({ NODE_ENV: 'development', HEYMORO_IMAGE_PROVIDER: 'fixture' }),
    /FIXTURE_PROVIDER/,
  )
  assert.equal(readImageProviderConfig({ OPENAI_API_KEY: 'unit-test-only' }).model, 'gpt-image-1.5')
})
test('should protect all generation mutation through native REST and GraphQL', async () => {
  const { Generations } = await import('../src/collections/Generations.ts')
  const req = { user: { id: 7, collection: 'users', status: 'active' } }
  for (const operation of ['create', 'update', 'delete'])
    assert.equal(await Generations.access[operation]({ req }), false)
  assert.deepEqual(await Generations.access.read({ req }), { owner: { equals: 7 } })
})
test('should protect both input and output media relationships', async () => {
  const { hasMediaReferences } = await import('../src/service-media.ts')
  const calls = []
  assert.equal(
    await hasMediaReferences(
      {
        payload: {
          find: async (query) => {
            calls.push(query)
            return { totalDocs: query.collection === 'generations' ? 1 : 0 }
          },
        },
      },
      9,
    ),
    true,
  )
  assert.deepEqual(calls.find((query) => query.collection === 'generations').where, {
    or: [{ inputMediaIds: { contains: 9 } }, { outputMedia: { equals: 9 } }],
  })
})
test('should require active user auth on every creation endpoint', async () => {
  const { creationEndpoints } = await import('../src/endpoint-creation.ts')
  assert.equal(creationEndpoints.length, 9)
  for (const endpoint of creationEndpoints) {
    for (const user of [
      null,
      { id: 7, collection: 'users', status: 'disabled' },
      { id: 1, collection: 'admins', status: 'active' },
    ]) {
      const response = await endpoint.handler({ user, headers: new Headers() })
      assert.equal(response.status, 401, `${endpoint.method} ${endpoint.path}`)
    }
  }
})
test('should send all reference images via OpenAI edits and use generations for no image', async () => {
  const { generateImage, ImageProviderError } = await import('../src/image-provider.ts')
  let calls = 0
  const bytes = Buffer.from('unit-test-image')
  const fetcher = async (url, options) => {
    calls++
    assert.equal(options.headers.Authorization, 'Bearer unit-test-only')
    if (calls === 1) {
      assert.match(url, /\/edits$/)
      assert.equal(options.body.getAll('image[]').length, 2)
      assert.equal(options.body.get('n'), '1')
      assert.equal(options.body.get('output_format'), 'png')
      assert.equal(options.headers['Content-Type'], undefined)
    } else {
      assert.match(url, /\/generations$/)
      assert.equal(JSON.parse(options.body).n, 1)
    }
    return Response.json({ data: [{ b64_json: bytes.toString('base64') }] })
  }
  const env = { OPENAI_API_KEY: 'unit-test-only' }
  assert.deepEqual(
    await generateImage({
      prompt: 'test',
      images: [
        { bytes, mimeType: 'image/png' },
        { bytes, mimeType: 'image/jpeg' },
      ],
      env,
      fetcher,
    }),
    bytes,
  )
  assert.deepEqual(await generateImage({ prompt: 'test', images: [], env, fetcher }), bytes)
  await assert.rejects(
    generateImage({
      prompt: 'test',
      images: [],
      env,
      fetcher: async () => {
        throw new Error('timeout')
      },
    }),
    (error) => error instanceof ImageProviderError && !error.isDefinite,
  )
  for (const [status, isDefinite] of [
    [400, true],
    [429, true],
    [500, false],
    [408, false],
  ])
    await assert.rejects(
      generateImage({
        prompt: 'test',
        images: [],
        env,
        fetcher: async () => new Response('', { status }),
      }),
      (error) => error.isDefinite === isDefinite,
    )
})
test('should reuse immutable owner-scoped idempotency metadata before provider or credit checks', async () => {
  const { submitGeneration, parseGenerationInput, snapshotHash } = await creation()
  const input = parseGenerationInput({
    sessionId: 4,
    prompt: 'hello',
    inputMediaIds: [],
    clientRequestId: 'retry-1',
  })
  const generation = { id: 7, owner: 3, snapshotHash: snapshotHash(input) }
  const req = {
    context: {},
    payload: {
      db: {
        beginTransaction: async () => 'tx',
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
      },
      find: async (options) => {
        assert.deepEqual(options.where, {
          and: [{ owner: { equals: 3 } }, { requestKey: { equals: '3:retry-1' } }],
        })
        assert.equal(options.overrideAccess, true)
        return { docs: [generation] }
      },
    },
  }
  assert.deepEqual(await submitGeneration({ req, userId: 3, input }), { generation, isNew: false })
  await assert.rejects(
    submitGeneration({ req, userId: 3, input: { ...input, prompt: 'different' } }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409,
  )
})
test('should reject oversized aggregate image inputs before reservation or queue creation', async () => {
  const { submitGeneration } = await creation()
  const keys = ['NODE_ENV', 'HEYMORO_IMAGE_PROVIDER', 'HEYMORO_AUTOMATED_TEST']
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    NODE_ENV: 'test',
    HEYMORO_IMAGE_PROVIDER: 'fixture',
    HEYMORO_AUTOMATED_TEST: 'true',
  })
  let writes = 0
  const req = {
    context: {},
    user: { id: 3, collection: 'users', status: 'active' },
    payload: {
      db: { beginTransaction: async () => 'tx', rollbackTransaction: async () => {} },
      find: async () => ({ docs: [] }),
      findByID: async ({ collection, id }) =>
        collection === 'creation-sessions'
          ? { id: 1, owner: 3, templateId: 'retro' }
          : { id, owner: 3, mimeType: 'image/png', lifecycle: 'active', filesize: 9 * 1024 * 1024 },
      create: async () => {
        writes++
        throw new Error('must not create')
      },
    },
  }
  try {
    await assert.rejects(
      submitGeneration({
        req,
        userId: 3,
        input: {
          sessionId: 1,
          inputMediaIds: [1, 2, 3, 4],
          prompt: '',
          clientRequestId: 'large-inputs',
        },
      }),
      (error) => error.code === 'INPUT_IMAGES_TOO_LARGE',
    )
    assert.equal(writes, 0)
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
test('should reject unconfigured real provider without creating a task, reservation or job', async () => {
  const { submitGeneration } = await creation()
  const keys = ['HEYMORO_IMAGE_PROVIDER', 'OPENAI_API_KEY']
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, { HEYMORO_IMAGE_PROVIDER: 'openai', OPENAI_API_KEY: '' })
  let writes = 0
  const req = {
    context: {},
    user: { id: 3, collection: 'users', status: 'active' },
    payload: {
      db: { beginTransaction: async () => 'tx', rollbackTransaction: async () => {} },
      find: async () => ({ docs: [] }),
      findByID: async () => ({ id: 1, owner: 3, templateId: 'free' }),
      create: async () => {
        writes++
      },
      jobs: {
        queue: async () => {
          writes++
        },
      },
    },
  }
  try {
    await assert.rejects(
      submitGeneration({
        req,
        userId: 3,
        input: {
          sessionId: 1,
          inputMediaIds: [],
          prompt: 'a forest',
          clientRequestId: 'no-config',
        },
      }),
      (error) => error.code === 'GENERATION_NOT_CONFIGURED' && error.status === 503,
    )
    assert.equal(writes, 0)
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
test('should produce a decodable and distinct fixture image only in automated tests', async () => {
  const { generateImage } = await import('../src/image-provider.ts')
  const sharp = (await import('sharp')).default
  const bytes = await generateImage({
    prompt: 'fixture',
    images: [],
    env: { NODE_ENV: 'test', HEYMORO_IMAGE_PROVIDER: 'fixture', HEYMORO_AUTOMATED_TEST: 'true' },
  })
  const pixels = await sharp(bytes).raw().toBuffer()
  assert.ok(pixels.length > 0)
})
