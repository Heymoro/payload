import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertExecutionSupported,
  compileExecution,
  GenerationError,
  parseSnapshot,
} from '../src/creation/domain/generation.ts'

const digest = 'a'.repeat(64)
const capability = () => ({ rendererId: 'duel-card', rendererVersion: 1, assetDigest: digest })
const recipe = () => ({
  ...capability(),
  metadata: { title: ' 星光 & <猫> 🐈 ', attributes: [{ label: '力量', value: '9000' }] },
})
const configuration = (capabilities = [capability()]) => ({
  registry: {
    image: {
      allowedParameters: [],
      model: 'image-model',
      parameterRules: {},
      provider: 'provider',
      storageBackends: ['private'],
      outputCompositions: capabilities,
    },
  },
  storageOutput: { backend: 'private', bucket: 'results', keyRule: 'task-attempt-result-v1' },
})
const config = (outputComposition) => ({
  executorId: 'image',
  systemPrompt: ' literal\n角色 ',
  parameters: {},
  ...(outputComposition === undefined ? {} : { outputComposition }),
})
const compile = ({ value = config(recipe()), execution = configuration() } = {}) =>
  compileExecution({ execution, generationConfigJson: JSON.stringify(value) })
const legacyPlan = {
  executorId: 'image',
  model: 'image-model',
  parameters: {},
  provider: 'provider',
  systemPrompt: ' literal\n角色 ',
}
const snapshot = (executionPlan = legacyPlan) => ({
  clientInput: {
    operation: 'generate',
    sessionId: 4,
    input: { inputMediaIds: [], description: '角色', userNotes: '' },
  },
  executionPlan,
  input: { inputMediaIds: [], description: '角色', userNotes: '' },
  media: [],
  mode: 'free',
  quote: {
    costCredits: 2,
    issuedAt: '2026-11-15T12:00:00.000Z',
    validUntil: '2026-11-15T12:01:00.000Z',
  },
  schemaVersion: 1,
  storageOutput: configuration().storageOutput,
  templateId: 1,
  templateVersionId: 2,
})
const rejectsCode = (run, code) =>
  assert.throws(run, (error) => error instanceof GenerationError && error.code === code)
const parser = () => import('../src/creation/domain/legacy-output-composition.ts')
const assertFrozenRecipe = (value) => {
  for (const part of [
    value,
    value.metadata,
    value.metadata.attributes,
    ...value.metadata.attributes,
  ])
    assert.ok(Object.isFrozen(part))
}

test('should retain historical recipe snapshots as literal deeply frozen read-only data', () => {
  const value = recipe()
  const outputComposition = {
    assetDigest: value.assetDigest,
    metadata: { attributes: value.metadata.attributes, title: value.metadata.title },
    rendererId: value.rendererId,
    rendererVersion: value.rendererVersion,
  }
  const json = JSON.stringify(snapshot({ ...legacyPlan, outputComposition }))
  const parsed = parseSnapshot({ json })
  assert.equal(JSON.stringify(parsed), json)
  assert.equal(parsed.schemaVersion, 1)
  assert.deepEqual(parsed.executionPlan.outputComposition, value)
  assertFrozenRecipe(parsed.executionPlan.outputComposition)
  assert.notEqual(parsed.executionPlan.outputComposition, outputComposition)
})

test('should preserve exact five-field legacy key order and snapshot bytes with or without capabilities', () => {
  const execution = configuration()
  delete execution.registry.image.outputCompositions
  for (const current of [execution, configuration()]) {
    const { executionPlan, storageOutput } = compile({ value: config(), execution: current })
    assert.equal(Object.hasOwn(executionPlan, 'outputComposition'), false)
    assert.deepEqual(Object.keys(executionPlan), [
      'executorId',
      'model',
      'parameters',
      'provider',
      'systemPrompt',
    ])
    assert.equal(JSON.stringify(executionPlan), JSON.stringify(legacyPlan))
    assertExecutionSupported({ execution: current, executionPlan, storageOutput })
    const json = JSON.stringify(snapshot(executionPlan))
    assert.equal(JSON.stringify(parseSnapshot({ json })), json)
  }
  rejectsCode(
    () => compile({ value: { ...config(), unexpected: true } }),
    'GENERATION_NOT_CONFIGURED',
  )
  rejectsCode(
    () => parseSnapshot({ json: JSON.stringify(snapshot({ ...legacyPlan, unexpected: true })) }),
    'DATA_INTEGRITY_CONFLICT',
  )
})

test('should keep historical snapshots readable after capability withdrawal but reject new execution', () => {
  const executionPlan = { ...legacyPlan, outputComposition: recipe() }
  const parsed = parseSnapshot({ json: JSON.stringify(snapshot(executionPlan)) })
  assert.deepEqual(parsed.executionPlan.outputComposition, recipe())
  const execution = configuration()
  delete execution.registry.image.outputCompositions
  rejectsCode(
    () =>
      assertExecutionSupported({
        execution,
        executionPlan: parsed.executionPlan,
        storageOutput: execution.storageOutput,
      }),
    'GENERATION_NOT_CONFIGURED',
  )
})

const invalidRecipes = () => [
  null,
  false,
  1,
  'duel-card',
  [],
  {},
  { ...recipe(), extra: true },
  { ...recipe(), rendererId: 'plain' },
  { ...recipe(), rendererVersion: 2 },
  { ...recipe(), rendererVersion: '1' },
  ...['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), `${digest}\n`].map((assetDigest) => ({
    ...recipe(),
    assetDigest,
  })),
  ...[null, [], {}, { title: '猫', attributes: [], extra: true }].map((metadata) => ({
    ...recipe(),
    metadata,
  })),
  ...[
    null,
    {},
    [],
    new Array(4).fill({ label: '力', value: '1' }),
    [{ label: '力' }],
    [{ label: '力', value: '1', extra: true }],
  ].map((attributes) => ({ ...recipe(), metadata: { title: '猫', attributes } })),
  ...[
    '',
    ' ',
    '猫'.repeat(25),
    '\n',
    '猫\r犬',
    '猫\t犬',
    '猫\u0000犬',
    '猫\u007f犬',
    '猫\u0085犬',
    '猫\u2028犬',
    '猫\u2029犬',
    '猫\u202e犬',
    '猫\u2066犬',
    '\ud800',
    '\udfff',
  ].map((title) => ({ ...recipe(), metadata: { ...recipe().metadata, title } })),
  ...['', ' ', '猫'.repeat(9), '猫\n犬', '\ud800'].map((label) => ({
    ...recipe(),
    metadata: { title: '猫', attributes: [{ label, value: '1' }] },
  })),
  ...['', ' ', '猫'.repeat(13), '猫\n犬', '\udfff'].map((value) => ({
    ...recipe(),
    metadata: { title: '猫', attributes: [{ label: '力', value }] },
  })),
]

test('should translate malformed recipes at actual compiler assertion and snapshot boundaries', () => {
  for (const value of invalidRecipes()) {
    rejectsCode(() => compile({ value: config(value) }), 'GENERATION_NOT_CONFIGURED')
    const executionPlan = { ...legacyPlan, outputComposition: value }
    rejectsCode(
      () => parseSnapshot({ json: JSON.stringify(snapshot(executionPlan)) }),
      'DATA_INTEGRITY_CONFLICT',
    )
    rejectsCode(
      () =>
        assertExecutionSupported({
          execution: configuration(),
          executionPlan,
          storageOutput: configuration().storageOutput,
        }),
      'GENERATION_NOT_CONFIGURED',
    )
  }
  rejectsCode(
    () =>
      assertExecutionSupported({
        execution: configuration(),
        executionPlan: { ...legacyPlan, outputComposition: undefined },
        storageOutput: configuration().storageOutput,
      }),
    'GENERATION_NOT_CONFIGURED',
  )
})

test('should parse independent deeply immutable copies and preserve Unicode scalar and XML text exactly', async () => {
  const { parseLegacyOutputComposition } = await parser()
  const value = recipe()
  const parsed = parseLegacyOutputComposition({ value })
  assert.deepEqual(parsed, value)
  assertFrozenRecipe(parsed)
  for (const [left, right] of [
    [parsed, value],
    [parsed.metadata, value.metadata],
    [parsed.metadata.attributes, value.metadata.attributes],
    [parsed.metadata.attributes[0], value.metadata.attributes[0]],
  ]) {
    assert.notEqual(left, right)
    assert.equal(Object.isFrozen(right), false)
  }
  value.metadata.title = 'changed'
  value.metadata.attributes[0].value = '0'
  assert.equal(parsed.metadata.title, ' 星光 & <猫> 🐈 ')
  assert.equal(parsed.metadata.attributes[0].value, '9000')
  assert.throws(() => parsed.metadata.attributes.push({ label: '力', value: '1' }), TypeError)
  assert.throws(() => {
    parsed.metadata.title = 'changed'
  }, TypeError)
  assert.throws(() => {
    parsed.metadata.attributes[0].value = '0'
  }, TypeError)
  for (const title of ['🐈'.repeat(24), 'e\u0301', '猫', '&<>"\'']) {
    const result = parseLegacyOutputComposition({
      value: {
        ...recipe(),
        metadata: {
          title,
          attributes: [
            { label: '🐈'.repeat(8), value: '🐈'.repeat(12) },
            { label: '甲', value: '2' },
            { label: '乙', value: '3' },
          ],
        },
      },
    })
    assert.equal(result.metadata.title, title)
    assert.equal(result.metadata.attributes.length, 3)
  }
})

test('should reject non-JSON descriptors symbols prototypes and array holes without invoking getters', async () => {
  const { parseLegacyOutputComposition } = await parser()
  for (const value of [...invalidRecipes(), undefined, new Date(), Object.create(recipe())])
    assert.throws(() => parseLegacyOutputComposition({ value }))
  const values = []
  for (const target of ['root', 'metadata', 'attribute']) {
    for (const mode of ['symbol', 'hidden', 'accessor', 'hiddenRequired']) {
      const value = recipe()
      const object =
        target === 'root'
          ? value
          : target === 'metadata'
            ? value.metadata
            : value.metadata.attributes[0]
      const key = target === 'root' ? 'metadata' : target === 'metadata' ? 'title' : 'label'
      if (mode === 'symbol') object[Symbol('extra')] = true
      if (mode === 'hidden') Object.defineProperty(object, 'hidden', { value: true })
      if (mode === 'accessor')
        Object.defineProperty(object, key, {
          enumerable: true,
          get: () => assert.fail('must not invoke getter'),
        })
      if (mode === 'hiddenRequired') Object.defineProperty(object, key, { enumerable: false })
      values.push(value)
    }
  }
  for (const mode of ['hole', 'extra', 'symbol', 'accessor', 'hidden', 'prototype']) {
    const value = recipe()
    const array = value.metadata.attributes
    if (mode === 'hole') delete array[0]
    if (mode === 'extra') array.extra = true
    if (mode === 'symbol') array[Symbol('extra')] = true
    if (mode === 'accessor')
      Object.defineProperty(array, '0', {
        enumerable: true,
        get: () => assert.fail('must not invoke array getter'),
      })
    if (mode === 'hidden') Object.defineProperty(array, '0', { enumerable: false })
    if (mode === 'prototype') Object.setPrototypeOf(array, null)
    values.push(value)
  }
  for (const value of values)
    assert.throws(
      () => parseLegacyOutputComposition({ value }),
      (error) => error.name !== 'AssertionError',
    )
  const nullPrototype = recipe()
  Object.setPrototypeOf(nullPrototype, null)
  Object.setPrototypeOf(nullPrototype.metadata, null)
  assert.deepEqual(parseLegacyOutputComposition({ value: nullPrototype }), recipe())
})

for (const field of ['title', 'label', 'value']) {
  test(`should reject Unicode format controls in ${field} without silently stripping text`, async () => {
    const { parseLegacyOutputComposition } = await parser()
    for (const control of ['\u00ad', '\u200b', '\u200c', '\u200d', '\u2060', '\u2061', '\ufeff']) {
      for (const text of [control, `星${control}光`]) {
        const value = recipe()
        if (field === 'title') value.metadata.title = text
        else value.metadata.attributes[0][field] = text
        assert.throws(() => parseLegacyOutputComposition({ value }), `format control in ${field}`)
        rejectsCode(() => compile({ value: config(value) }), 'GENERATION_NOT_CONFIGURED')
        rejectsCode(
          () =>
            parseSnapshot({
              json: JSON.stringify(snapshot({ ...legacyPlan, outputComposition: value })),
            }),
          'DATA_INTEGRITY_CONFLICT',
        )
        rejectsCode(
          () =>
            assertExecutionSupported({
              execution: configuration(),
              executionPlan: { ...legacyPlan, outputComposition: value },
              storageOutput: configuration().storageOutput,
            }),
          'GENERATION_NOT_CONFIGURED',
        )
      }
    }
  })
}
