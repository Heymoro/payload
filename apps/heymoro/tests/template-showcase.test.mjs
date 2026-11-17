import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePublicTemplateConfig } from '../src/creation/domain/template-config.ts'
const caps = {
  minImages: 0,
  maxImages: 4,
  allowedMimeTypes: ['image/png'],
  maxImageBytes: 1000,
  maxTotalImageBytes: 4000,
  maxDescriptionLength: 200,
  maxNotesLength: 100,
}
const parse = (display) =>
  parsePublicTemplateConfig({
    kind: 'effect',
    schemaVersion: 1,
    hostCaps: caps,
    inputSchemaJson: JSON.stringify({ ...caps, minImages: 1, maxDescriptionLength: 0 }),
    displayConfigJson: JSON.stringify({ name: '合照', ...display }),
  })
test('a new effect can be created before any results exist, without independent example uploads', () => {
  const value = parse({ showcaseShareKeys: [] })
  assert.deepEqual(value.displayConfig.showcaseShareKeys, [])
  assert.equal('examples' in value.displayConfig, false)
})
test('template presentation links actual session shares rather than raw before/after media pairs', () => {
  const value = parse({ showcaseShareKeys: ['a'.repeat(32)] })
  assert.deepEqual(value.displayConfig.showcaseShareKeys, ['a'.repeat(32)])
})
test('historical example pairs are discarded at the read boundary, not republished as conversation results', () => {
  const value = parse({ coverMediaId: 1, examples: [{ inputMediaIds: [2], outputMediaId: 3 }] })
  assert.equal('examples' in value.displayConfig, false)
  assert.deepEqual(value.displayConfig.showcaseShareKeys, [])
})
for (const keys of [
  ['x'],
  ['a'.repeat(32), 'a'.repeat(32)],
  Array.from({ length: 9 }, (_, i) => String(i).repeat(32)),
])
  test('invalid or unbounded share references are rejected ' + JSON.stringify(keys), () =>
    assert.throws(() => parse({ showcaseShareKeys: keys })),
  )
test('admin form edits shared-session references and retires legacy upload fields', async () => {
  const { decodeBody, encodeBody, blankBody } =
    await import('../src/admin/template-management-form.ts')
  const options = { schemaVersion: 1, acceptedCapabilities: ['v1'], hostCaps: caps, executors: [] }
  const body = blankBody({ kind: 'effect', options })
  const form = decodeBody({
    body: {
      ...body,
      displayConfigJson: JSON.stringify({
        name: '合照',
        examples: [{ outputMediaId: 9 }],
        showcaseShareKeys: ['a'.repeat(32)],
      }),
    },
    options,
  })
  assert.equal(form.display.kind, 'editable')
  assert.equal('examples' in form.display.value, false)
  assert.deepEqual(form.display.value.showcaseShareKeys, ['a'.repeat(32)])
  const changed = {
    ...form,
    display: { ...form.display, value: { ...form.display.value, name: '新合照' } },
  }
  assert.equal('examples' in JSON.parse(encodeBody({ form: changed }).displayConfigJson), false)
})
