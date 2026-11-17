import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'

import {
  assertExecutionSupported,
  compileExecution,
  GenerationError,
} from '../src/creation/domain/generation.ts'
import { createImageEngine } from '../src/creation/infrastructure/ai/image-engine.ts'

const capability = { rendererId: 'duel-card', rendererVersion: 1, assetDigest: 'a'.repeat(64) }
const recipe = {
  ...capability,
  metadata: { title: '星光猫', attributes: [{ label: '力量', value: '9000' }] },
}
const execution = {
  registry: {
    'image-v1': {
      allowedParameters: ['size', 'quality'],
      model: 'gpt-image-1.5',
      provider: 'openai',
      parameterRules: {
        size: { type: 'string', values: ['1024x1024', '1024x1536'], isRequired: true },
        quality: { type: 'string', values: ['low', 'medium', 'high'] },
      },
      storageBackends: ['private'],
      // A stale host property must never re-enable new recipe execution.
      outputCompositions: [capability],
    },
  },
  storageOutput: { backend: 'private', bucket: 'results', keyRule: 'task-attempt-result-v1' },
}
const config = {
  executorId: 'image-v1',
  systemPrompt: ' literal\n角色 ',
  parameters: { size: '1024x1024' },
}
const compile = (value = config) =>
  compileExecution({ execution, generationConfigJson: JSON.stringify(value) })
const rejectsUnsupported = (run) =>
  assert.throws(
    run,
    (error) => error instanceof GenerationError && error.code === 'GENERATION_NOT_CONFIGURED',
  )

test('should reject new recipe configuration even with a matching stale capability registry', () => {
  for (const outputComposition of [recipe, undefined, null]) {
    // JSON omits undefined, so use another explicit extra field for that case.
    const value =
      outputComposition === undefined
        ? { ...config, workflow: 'unexpected' }
        : { ...config, outputComposition }
    rejectsUnsupported(() => compile(value))
  }
})

test('should reject legacy recipe execution even when the stale registry matches', () => {
  const { executionPlan, storageOutput } = compile()
  rejectsUnsupported(() =>
    assertExecutionSupported({
      execution,
      executionPlan: { ...executionPlan, outputComposition: recipe },
      storageOutput,
    }),
  )
})

test('should reject every non-generic live plan field using the not-configured error contract', () => {
  const { executionPlan, storageOutput } = compile()
  for (const value of [
    { ...executionPlan, renderer: 'anything' },
    { ...executionPlan, outputComposition: undefined },
    { ...executionPlan, plain: null },
    { ...executionPlan, parameters: null },
    null,
    [],
  ]) {
    rejectsUnsupported(() =>
      assertExecutionSupported({ execution, executionPlan: value, storageOutput }),
    )
  }
})

const templates = [
  {
    name: 'portrait',
    systemPrompt: ' 绘制肖像\n保留人物特征 ',
    parameters: { size: '1024x1024', quality: 'medium' },
    images: 1,
  },
  {
    name: 'pet',
    systemPrompt: ' 宠物插画\n保留毛色 ',
    parameters: { size: '1024x1024', quality: 'low' },
    images: 1,
  },
  {
    name: 'duel-card',
    systemPrompt: ' 绘制完整卡牌；卡名：星光猫；力量：9000；防御：8000。 ',
    parameters: { size: '1024x1536', quality: 'high' },
    images: 2,
  },
  {
    name: 'sticker',
    systemPrompt: ' 表情贴纸\n清晰轮廓 ',
    parameters: { size: '1024x1024', quality: 'medium' },
    images: 3,
  },
  {
    name: 'scene',
    systemPrompt: ' 绘制文字描述中的场景 ',
    parameters: { size: '1024x1536', quality: 'low' },
    images: 0,
  },
]

test('should use one actual image SDK request per template with only prompt and parameter differences', async () => {
  const output = await sharp({
    create: { width: 2, height: 2, channels: 4, background: '#123456' },
  })
    .png()
    .toBuffer()
  const requests = []
  const engine = createImageEngine({
    apiKey: 'fixture-only-fake-key',
    timeoutMs: 1000,
    engineBudgetMs: 180_000,
    registered: [{ executorId: 'image-v1', provider: 'openai', model: 'gpt-image-1.5' }],
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: init.body })
      return new Response(JSON.stringify({ data: [{ b64_json: output.toString('base64') }] }), {
        headers: {
          'content-type': 'application/json',
          'x-request-id': `fixture-${requests.length}`,
        },
      })
    },
  })
  const images = await Promise.all(
    ['#ff0000', '#00ff00', '#0000ff'].map(async (background) => ({
      bytes: new Uint8Array(
        await sharp({ create: { width: 2, height: 2, channels: 4, background } })
          .png()
          .toBuffer(),
      ),
      mimeType: 'image/png',
    })),
  )
  const input = { description: ' First \n second ', userNotes: ' notes\n\n ' }
  for (const template of templates) {
    const { executionPlan } = compile({
      executorId: 'image-v1',
      systemPrompt: template.systemPrompt,
      parameters: template.parameters,
    })
    assert.deepEqual(Object.keys(executionPlan), [
      'executorId',
      'model',
      'parameters',
      'provider',
      'systemPrompt',
    ])
    const before = requests.length
    const selected = images.slice(0, template.images)
    const result = await engine({
      executionPlan,
      images: selected,
      input,
      signal: new AbortController().signal,
    })
    assert.equal(result.kind, 'output', template.name)
    assert.deepEqual(result.bytes, new Uint8Array(output))
    assert.equal(requests.length, before + 1, template.name)
    const request = requests.at(-1)
    const prompt = `[System]\n${template.systemPrompt}\n\n[Description]\n${input.description}\n\n[User notes]\n${input.userNotes}`
    if (selected.length) {
      assert.equal(request.url, 'https://api.openai.com/v1/images/edits')
      assert.ok(request.body instanceof FormData)
      assert.equal(request.body.get('prompt'), prompt)
      assert.equal(request.body.get('model'), 'gpt-image-1.5')
      assert.equal(request.body.get('n'), '1')
      assert.equal(request.body.get('output_format'), 'png')
      for (const [key, value] of Object.entries(template.parameters))
        assert.equal(request.body.get(key), value)
      const uploaded = request.body.getAll('image[]')
      assert.equal(uploaded.length, selected.length)
      for (let index = 0; index < selected.length; index++) {
        assert.deepEqual(new Uint8Array(await uploaded[index].arrayBuffer()), selected[index].bytes)
      }
      assert.equal(request.body.has('outputComposition'), false)
      assert.equal(request.body.has('metadata'), false)
    } else {
      assert.equal(request.url, 'https://api.openai.com/v1/images/generations')
      assert.deepEqual(JSON.parse(request.body), {
        model: 'gpt-image-1.5',
        n: 1,
        output_format: 'png',
        prompt,
        stream: false,
        ...template.parameters,
      })
    }
  }
  assert.equal(requests.length, templates.length)
})
