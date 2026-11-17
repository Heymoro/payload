import assert from 'node:assert/strict'
import test from 'node:test'

function fixtureBody() {
  return {
    schemaVersion: 1,
    minClientCapability: 'v1',
    costCredits: 2,
    displayConfigJson: ' { "name": "Free", "coverMediaId": null, "examples": [] }\n',
    inputSchemaJson: JSON.stringify({
      minImages: 0,
      maxImages: 4,
      maxImageBytes: 1000,
      maxTotalImageBytes: 4000,
      allowedMimeTypes: ['image/png'],
      maxDescriptionLength: 200,
      maxNotesLength: 0,
    }),
    generationConfigJson:
      '{"executorId":"simple","parameters":{"count":0,"enabled":false},"systemPrompt":"Draw"}',
    shareConfigJson: '{}',
  }
}

test('form codec preserves raw bytes, false and zero; corrupt and unknown groups require explicit repair', async () => {
  const codec = await import('../src/admin/template-management-form.ts')
  const f = { body: fixtureBody() }
  const options = {
    acceptedCapabilities: ['v1'],
    schemaVersion: 1,
    hostCaps: {},
    executors: [
      {
        executorId: 'simple',
        allowedParameters: ['count', 'enabled'],
        parameterRules: {
          count: { type: 'number', minimum: 0, maximum: 3, isInteger: true },
          enabled: { type: 'boolean' },
        },
      },
    ],
  }
  const body = {
    ...f.body,
    generationConfigJson:
      '{ "executorId":"simple", "parameters":{"count":0,"enabled":false}, "systemPrompt":"Draw" }\n',
  }
  const decoded = codec.decodeBody({ body, options })
  assert.equal(decoded.generation.kind, 'editable')
  assert.deepEqual(codec.encodeBody({ form: decoded }), body)
  assert.equal(
    codec.parameterValue({ text: '', rule: options.executors[0].parameterRules.count }),
    undefined,
  )
  assert.equal(
    codec.parameterValue({ text: '0', rule: options.executors[0].parameterRules.count }),
    0,
  )
  assert.equal(
    codec.parameterValue({ text: 'false', rule: options.executors[0].parameterRules.enabled }),
    false,
  )
  assert.throws(() =>
    codec.parameterValue({ text: '4', rule: options.executors[0].parameterRules.count }),
  )
  const broken = codec.decodeBody({
    body: { ...body, displayConfigJson: '{', shareConfigJson: '{"unknown":1}' },
    options,
  })
  assert.equal(broken.display.kind, 'repairRequired')
  assert.equal(broken.share.kind, 'repairRequired')
  assert.deepEqual(codec.encodeBody({ form: broken }), {
    ...body,
    displayConfigJson: '{',
    shareConfigJson: '{"unknown":1}',
  })
})

test('codec requires explicit reconstruction for unknown schema and enforces transport and per-group budgets', async () => {
  const codec = await import('../src/admin/template-management-form.ts')
  const f = { body: fixtureBody() }
  const options = { acceptedCapabilities: ['v1'], schemaVersion: 1, hostCaps: {}, executors: [] }
  const form = codec.decodeBody({ body: { ...f.body, schemaVersion: 2 }, options })
  assert.equal(form.display.kind, 'repairRequired')
  assert.equal(form.input.kind, 'repairRequired')
  assert.equal(form.share.kind, 'repairRequired')
  assert.throws(() =>
    codec.serializeCommand({ input: { ...f.body, displayConfigJson: 'x'.repeat(131073) } }),
  )
  assert.throws(() => codec.serializeCommand({ input: { data: '字'.repeat(270000) } }))
  assert.equal(
    codec.bodiesEqual({
      left: f.body,
      right: Object.fromEntries(Object.entries(f.body).reverse()),
    }),
    true,
  )
})

test('safe errors reject inherited family/code names and numeric whitespace is not silently zero', async () => {
  const { safeFailure, parameterValue } = await import('../src/admin/template-management-form.ts')
  for (const [family, code] of [
    ['catalog', 'constructor'],
    ['constructor', 'name'],
    ['generation', 'toString'],
  ]) {
    const result = safeFailure({ family, code })
    assert.equal(result.status, 503)
    assert.equal(result.code, 'SERVICE_UNAVAILABLE')
  }
  assert.throws(() =>
    parameterValue({ text: ' ', rule: { type: 'number', minimum: 0, maximum: 3 } }),
  )
})

test('draft metadata is restricted to schema1 and current host capabilities before a C save', async () => {
  const { assertDraftMetadata } = await import('../src/admin/template-management-form.ts')
  assert.equal(typeof assertDraftMetadata, 'function')
  assert.doesNotThrow(() =>
    assertDraftMetadata({
      input: { schemaVersion: 1, minClientCapability: 'v1' },
      acceptedCapabilities: ['v1'],
    }),
  )
  for (const input of [
    { schemaVersion: 2, minClientCapability: 'v1' },
    { schemaVersion: 1, minClientCapability: 'unknown' },
  ])
    assert.throws(() => assertDraftMetadata({ input, acceptedCapabilities: ['v1'] }))
})
