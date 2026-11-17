import assert from 'node:assert/strict'
import test from 'node:test'

const hostCaps = {
  allowedMimeTypes: ['image/png', 'image/jpeg'],
  minImages: 0,
  maxImages: 6,
  maxImageBytes: 1000,
  maxTotalImageBytes: 5000,
  maxDescriptionLength: 100,
  maxNotesLength: 100,
}
const input = { ...hostCaps, minImages: 1, maxImages: 4, maxDescriptionLength: 0 }
const generation = {
  executorId: 'image',
  systemPrompt: 'Preserve the pet.\nDraw a complete card.',
  parameters: { size: '1024x1024', quality: 'low' },
}
const execution = {
  registry: {
    image: {
      provider: 'openai',
      model: 'gpt-image-1.5',
      storageBackends: ['private'],
      allowedParameters: ['size', 'quality'],
      parameterRules: {
        size: { type: 'string', values: ['1024x1024', '1024x1536'], isRequired: true },
        quality: { type: 'string', values: ['low', 'medium'] },
      },
    },
  },
  storageOutput: { backend: 'private', bucket: 'results', keyRule: 'task-attempt-result-v1' },
}
const template = {
  id: 12,
  kind: 'effect',
  costCredits: 1,
  schemaVersion: 1,
  minClientCapability: 'v1',
  displayConfigJson: JSON.stringify({
    name: '决斗卡',
    coverMediaId: 2,
    examples: [{ outputMediaId: 2 }],
  }),
  inputSchemaJson: JSON.stringify(input),
  generationConfigJson: JSON.stringify(generation),
}
const compile = async (patch = {}, options = {}) => {
  const { compileCurrentTemplate } = await import('../src/creation/domain/current-template.ts')
  return compileCurrentTemplate({
    template: { ...template, ...patch },
    execution,
    hostCaps,
    acceptedCapabilities: ['v1'],
    ...options,
  })
}

test('current template compiler has no business-version identity and exposes only public presentation', async () => {
  const result = await compile()
  assert.equal(result.publicTemplate.templateId, 12)
  assert.equal(result.publicTemplate.costCredits, 1)
  assert.equal(result.publicTemplate.mode, 'effect')
  assert.equal(result.executionPlan.systemPrompt, generation.systemPrompt)
  assert.match(result.configurationHash, /^[a-f0-9]{64}$/)
  assert.equal(
    /systemPrompt|configurationHash|executorId|storageOutput|templateVersionId|versionNo|revision/.test(
      JSON.stringify(result.publicTemplate),
    ),
    false,
  )
  assert.equal(Object.isFrozen(result.executionPlan.parameters), true)
  assert.equal(Object.isFrozen(result.publicTemplate.inputSchema.allowedMimeTypes), true)
})

test('execution authorization changes with prompt, parameters, price, effective input limits or resolved host execution', async () => {
  const original = await compile()
  const variants = [
    await compile({ costCredits: 2 }),
    await compile({
      generationConfigJson: JSON.stringify({ ...generation, systemPrompt: 'Another prompt' }),
    }),
    await compile({
      generationConfigJson: JSON.stringify({
        ...generation,
        parameters: { size: '1024x1536', quality: 'low' },
      }),
    }),
    await compile({ inputSchemaJson: JSON.stringify({ ...input, maxImages: 3 }) }),
    await compile({}, { hostCaps: { ...hostCaps, maxImages: 2 } }),
    await compile(
      {},
      {
        execution: {
          ...execution,
          registry: { image: { ...execution.registry.image, model: 'another-supported-model' } },
        },
      },
    ),
    await compile(
      {},
      {
        execution: {
          ...execution,
          storageOutput: { ...execution.storageOutput, bucket: 'other-results' },
        },
      },
    ),
  ]
  for (const result of variants)
    assert.notEqual(result.configurationHash, original.configurationHash)
})

test('canonical execution hash ignores JSON key order and presentation-only changes', async () => {
  const original = await compile()
  const reordered = await compile({
    generationConfigJson: JSON.stringify({
      parameters: { quality: 'low', size: '1024x1024' },
      systemPrompt: generation.systemPrompt,
      executorId: 'image',
    }),
  })
  assert.equal(reordered.configurationHash, original.configurationHash)
  const renamed = await compile({
    displayConfigJson: JSON.stringify({
      name: '新卡面',
      coverMediaId: 3,
      examples: [{ outputMediaId: 3 }],
    }),
  })
  assert.equal(renamed.publicTemplate.displayConfig.name, '新卡面')
  assert.equal(renamed.configurationHash, original.configurationHash)
})

test('free mode uses the same current-template compiler with no reference-image minimum', async () => {
  const result = await compile({
    kind: 'free',
    inputSchemaJson: JSON.stringify({
      ...input,
      minImages: 0,
      maxDescriptionLength: 100,
      maxNotesLength: 0,
    }),
  })
  assert.equal(result.publicTemplate.mode, 'free')
  assert.equal(result.publicTemplate.inputSchema.minImages, 0)
})

test('current template rejects unsupported configuration without falling back to old versions', async () => {
  for (const patch of [
    { id: 0 },
    { costCredits: -1 },
    { costCredits: 0.5 },
    { kind: 'unknown' },
    { schemaVersion: 2 },
    { minClientCapability: 'unsupported' },
    { displayConfigJson: '{}' },
    { inputSchemaJson: '{}' },
    { generationConfigJson: JSON.stringify({ ...generation, parameters: { bad: true } }) },
  ])
    await assert.rejects(compile(patch))
  await assert.rejects(compile({}, { execution: null }))
})

test('compilation does not mutate template or host inputs and snapshots survive later edits', async () => {
  const before = JSON.stringify({ template, execution, hostCaps })
  const result = await compile()
  assert.equal(JSON.stringify({ template, execution, hostCaps }), before)
  assert.notEqual(result.executionPlan.parameters, generation.parameters)
  const newer = await compile({
    generationConfigJson: JSON.stringify({ ...generation, systemPrompt: 'Updated later' }),
  })
  assert.equal(result.executionPlan.systemPrompt, generation.systemPrompt)
  assert.notEqual(newer.configurationHash, result.configurationHash)
})

test('effective limits and MIME membership have canonical semantics independent of raw ordering', async () => {
  const cappedHost = { ...hostCaps, maxImages: 2 }
  const original = await compile({}, { hostCaps: cappedHost })
  const result = await compile(
    {
      inputSchemaJson: JSON.stringify({
        ...input,
        maxImages: 5,
        allowedMimeTypes: [...input.allowedMimeTypes].reverse(),
      }),
    },
    { hostCaps: cappedHost },
  )
  assert.equal(result.publicTemplate.inputSchema.maxImages, 2)
  assert.equal(result.configurationHash, original.configurationHash)
})

test('zero-cost templates remain explicit and template identity participates in authorization', async () => {
  const original = await compile()
  const free = await compile({ costCredits: 0 })
  assert.equal(free.publicTemplate.costCredits, 0)
  assert.notEqual(free.configurationHash, original.configurationHash)
  assert.notEqual((await compile({ id: 13 })).configurationHash, original.configurationHash)
})

test('compiled execution owns its snapshot after the host registry is edited', async () => {
  const editedHost = structuredClone(execution)
  const original = await compile({}, { execution: editedHost })
  editedHost.registry.image.model = 'later-host-model'
  editedHost.storageOutput.bucket = 'later-bucket'
  assert.equal(original.executionPlan.model, 'gpt-image-1.5')
  assert.equal(original.storageOutput.bucket, 'results')
  assert.throws(() => {
    original.executionPlan.parameters.size = '1024x1536'
  }, TypeError)
})
