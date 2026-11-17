import assert from 'node:assert/strict'
import test from 'node:test'
import { createCatalog } from '../src/creation/application/catalog.ts'
import { createSessionCreator } from '../src/creation/application/session.ts'
import { hashSessionCommand, normalizeSessionCommand } from '../src/creation/domain/session.ts'
import { createDraftService } from '../src/creation/application/draft.ts'
import { createQuoteCodec } from '../src/creation/domain/quote.ts'

const now = '2026-11-17T03:00:00.000Z'
const hostCaps = {
  allowedMimeTypes: ['image/png'],
  minImages: 0,
  maxImages: 4,
  maxImageBytes: 1000,
  maxTotalImageBytes: 3000,
  maxDescriptionLength: 100,
  maxNotesLength: 100,
}
const configuration = () => ({
  id: 3,
  code: 'pet',
  kind: 'effect',
  status: 'published',
  isDeleted: false,
  sortOrder: 0,
  costCredits: 1,
  minClientCapability: 'v1',
  schemaVersion: 1,
  displayConfigJson: JSON.stringify({
    name: '合照',
    coverMediaId: 7,
    examples: [{ outputMediaId: 7 }],
  }),
  inputSchemaJson: JSON.stringify({ ...hostCaps, minImages: 1, maxDescriptionLength: 0 }),
})

test('catalog reads current row directly and same-row saves immediately change subsequent detail and list', async () => {
  const row = configuration()
  const catalog = createCatalog({
    capabilityPolicy: { id: 'v1', isCompatible: () => true },
    cursorKey: Buffer.alloc(32, 1),
    hostCaps,
    repository: {
      readTemplate: async () => row,
      findFree: async () => [],
      scanTerms: async () => [],
      scanEffects: async ({ after }) => (after ? [] : [row]),
    },
  })
  const first = await catalog.get({ templateId: 3 })
  assert.equal(first.costCredits, 1)
  assert.equal(Object.hasOwn(first, 'templateVersionId'), false)
  row.costCredits = 4
  row.displayConfigJson = JSON.stringify({
    name: '新合照',
    coverMediaId: 7,
    examples: [{ outputMediaId: 7 }],
  })
  assert.equal((await catalog.get({ templateId: 3 })).costCredits, 4)
  assert.equal((await catalog.list({ query: {} })).items[0].displayConfig.name, '新合照')
  await assert.rejects(catalog.get({ templateId: 3, versionId: 12 }), { code: 'INPUT_INVALID' })
  row.status = 'offline'
  await assert.rejects(catalog.get({ templateId: 3 }), { code: 'TEMPLATE_UNAVAILABLE' })
})

test('session command contains only stable template identity and preserves original idempotency key', async () => {
  const command = { templateId: 3, clientRequestId: ' original key ' }
  assert.deepEqual(normalizeSessionCommand({ value: command }), command)
  assert.match(hashSessionCommand({ command }), /^[a-f0-9]{64}$/)
  assert.throws(() => normalizeSessionCommand({ value: { ...command, templateVersionId: 12 } }), {
    code: 'INPUT_INVALID',
  })
  const row = configuration()
  let saved
  const creator = createSessionCreator({
    clock: () => now,
    hostCaps,
    isCompatible: () => true,
    runCoordinatedTransaction: ({ work }) =>
      work({
        repository: {
          isAccountActive: async () => true,
          findSessionsByRequest: async () => (saved ? [saved] : []),
          readTemplate: async () => row,
          insertSession: async ({ session }) => (saved = { ...session, id: 8 }),
          insertEmptyDraft: async ({ draft }) => ({ ...draft, id: 9 }),
        },
      }),
  })
  const accepted = await creator({ userId: 2, command })
  assert.equal(accepted.session.title, '合照')
  assert.equal(Object.hasOwn(accepted.session, 'templateVersionId'), false)
  row.status = 'offline'
  const retry = await creator({ userId: 2, command })
  assert.equal(retry.isNew, false)
  assert.equal(retry.session.id, 8)
})

test('draft persists within host safety limits without depending on mutable template availability', async () => {
  let stored
  const repository = {
    isAccountActive: async () => true,
    readSession: async () => ({
      id: 8,
      userId: 2,
      templateId: 3,
      mode: 'effect',
      isDeleted: false,
    }),
    findDrafts: async () => [
      {
        id: 9,
        sessionId: 8,
        userId: 2,
        isDeleted: false,
        description: '',
        userNotes: '',
        updatedAt: now,
      },
    ],
    findSlots: async () => [],
    readMedia: async () => null,
    replace: async ({ input }) => {
      stored = input
      return now
    },
  }
  const service = createDraftService({
    clock: () => now,
    hostCaps,
    read: ({ work }) => work({ repository }),
    write: ({ work }) => work({ repository }),
  })
  await service.save({ userId: 2, sessionId: 8, input: { userNotes: '保留输入' } })
  assert.equal(stored.userNotes, '保留输入')
})

test('quote authorizes effective configuration hash rather than a template version', async () => {
  const codec = createQuoteCodec({
    audience: 'local',
    issuer: 'local',
    keys: { test: Buffer.alloc(32, 1) },
    signingKid: 'test',
    ttlSeconds: 60,
  })
  const binding = {
    costCredits: 1,
    configurationHash: 'a'.repeat(64),
    inputHash: 'b'.repeat(64),
    purpose: 'generate',
    sessionId: 8,
    templateId: 3,
    userId: 2,
  }
  const issued = await codec.issue({ binding, now })
  const claims = await codec.verify({ token: issued.quoteToken, now })
  assert.equal(claims.configurationHash, binding.configurationHash)
  assert.equal(claims.templateId, 3)
  assert.equal(Object.hasOwn(claims, 'templateVersionId'), false)
  await assert.rejects(codec.issue({ binding: { ...binding, configurationHash: undefined }, now }))
})

test('actual runtime and admin entry no longer compose publication/history services', async () => {
  const { readFile } = await import('node:fs/promises')
  const runtime = await readFile(
    new URL('../src/creation/runtime/services.ts', import.meta.url),
    'utf8',
  )
  assert.match(runtime, /templates: createPayloadCurrentTemplates/)
  assert.doesNotMatch(runtime, /createPayloadTemplatePublication|createPayloadTemplateManagement/)
  for (const name of [
    'TemplateManagementEditor/index.tsx',
    'TemplateManagementView/index.tsx',
    'template-management-actions.ts',
  ]) {
    const source = await readFile(new URL('../src/admin/' + name, import.meta.url), 'utf8')
    assert.doesNotMatch(
      source,
      /selectedVersion|nextVersionNo|expectedDraft|beforeVersionNo|versionId|draftFingerprint/,
    )
  }
})

test('routine template editor is one form and does not expose infrastructure controls or an upload-target workflow', async () => {
  const { readFile } = await import('node:fs/promises')
  const fields = await readFile(
    new URL('../src/admin/TemplateManagementFields/index.tsx', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(
    fields,
    /role="tablist"|最低客户端能力|上传关联位置|配置版本|label="执行器"|高级生成参数/,
  )
  for (const label of ['名称', '分类', '标签', '封面', '关联会话分享', '内置 Prompt', '生成积分'])
    assert.ok(fields.includes(label), label)
  assert.doesNotMatch(fields, /display\.examples|添加效果示例|inputMediaIds|outputMediaId/)
  const editor = await readFile(
    new URL('../src/admin/TemplateManagementEditor/index.tsx', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(editor, /继续填写配置|ref=\{creationPanel\}|<TemplateManagementTaxonomy/)
})

test('new form supplies required host defaults internally without creating a template version or resetting saved parameters', async () => {
  const { blankBody, decodeBody, encodeBody } =
    await import('../src/admin/template-management-form.ts')
  const options = {
    acceptedCapabilities: ['v1'],
    hostCaps,
    schemaVersion: 1,
    executors: [
      {
        executorId: 'image',
        provider: 'openai',
        model: 'image',
        allowedParameters: ['size', 'quality'],
        parameterRules: {
          size: { type: 'string', isRequired: true, values: ['1024x1024'] },
          quality: { type: 'string', values: ['low', 'high'] },
        },
      },
    ],
  }
  const body = blankBody({ kind: 'free', options })
  assert.deepEqual(JSON.parse(body.generationConfigJson).parameters, { size: '1024x1024' })
  const original = {
    ...body,
    displayConfigJson: JSON.stringify({ name: 'Original' }),
    generationConfigJson: JSON.stringify({
      executorId: 'image',
      systemPrompt: 'Keep me',
      parameters: { size: '1024x1024', quality: 'high' },
    }),
  }
  const form = decodeBody({ body: original, options })
  const edited = { ...form, costCredits: 3 }
  assert.equal(encodeBody({ form: edited }).generationConfigJson, original.generationConfigJson)
})

test('confirmed new-template identity remains available for read-only recovery without replacing the local form', async () => {
  const { confirmedTemplateTarget } = await import('../src/admin/template-management-form.ts')
  assert.equal(typeof confirmedTemplateTarget, 'function')
  assert.equal(confirmedTemplateTarget({ currentId: 0, confirmed: { templateId: 9 } }), 9)
  assert.equal(confirmedTemplateTarget({ currentId: 3, confirmed: { templateId: 9 } }), 3)
  assert.equal(confirmedTemplateTarget({ currentId: 0, confirmed: { templateId: -1 } }), null)
})

test('all selected labels remain removable even when hidden terms are present on the current taxonomy page', async () => {
  const { templateTagOptions } = await import('../src/admin/template-management-form.ts')
  assert.equal(typeof templateTagOptions, 'function')
  const hidden = { id: 3, name: '宠物', code: 'pet', kind: 'label', status: 'hidden', sortOrder: 0 }
  const active = { ...hidden, id: 4, name: '合照', code: 'family', status: 'active' }
  const result = templateTagOptions({
    selected: [
      { id: 3, name: '宠物' },
      { id: 5, name: '不在本页' },
    ],
    terms: [hidden, active],
  })
  assert.deepEqual(
    result.map(({ id }) => id),
    [4, 3, 5],
  )
  assert.equal(result.find(({ id }) => id === 3).status, 'hidden')
})
