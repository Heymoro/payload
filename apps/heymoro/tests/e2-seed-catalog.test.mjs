import assert from 'node:assert/strict'
import test from 'node:test'
import { createCatalog } from '../src/creation/application/catalog.ts'
import { readE2CatalogTemplate } from './creation/next-business-seed.ts'

for (const [kind, templateId] of [
  ['free', 1],
  ['effect', 2],
]) {
  test(`reads ${kind} through the current stable catalog boundary`, async () => {
    const catalog = fixture()
    if (kind === 'free')
      await assert.rejects(catalog.get({ templateId }), { code: 'TEMPLATE_UNAVAILABLE' })
    const result = await readE2CatalogTemplate({ catalog, template: { kind, templateId } })
    assert.equal(result.mode, kind)
    assert.equal(result.templateId, templateId)
    assert.equal(Object.hasOwn(result, 'templateVersionId'), false)
  })
}
for (const template of [
  { kind: 'free', templateId: 9 },
  { kind: 'effect', templateId: 1 },
  { kind: 'unknown', templateId: 2 },
  { kind: 'free', templateId: 0 },
  { kind: 'effect', templateId: '2' },
]) {
  test(`rejects a current catalog receipt mismatch ${JSON.stringify(template)}`, async () => {
    await assert.rejects(readE2CatalogTemplate({ catalog: fixture(), template }))
  })
}
function fixture() {
  const hostCaps = {
    allowedMimeTypes: ['image/jpeg', 'image/png'],
    minImages: 0,
    maxDescriptionLength: 200,
    maxImageBytes: 1000,
    maxImages: 4,
    maxNotesLength: 100,
    maxTotalImageBytes: 3000,
  }
  const rows = ['free', 'effect'].map((kind, index) => ({
    id: index + 1,
    code: kind,
    kind,
    status: 'published',
    sortOrder: 0,
    isDeleted: false,
    costCredits: 2,
    schemaVersion: 1,
    minClientCapability: 'v1',
    displayConfigJson: JSON.stringify({
      name: kind,
      coverMediaId: 7,
      examples: [{ outputMediaId: 7 }],
    }),
    inputSchemaJson: JSON.stringify({
      ...hostCaps,
      ...(kind === 'free' ? { maxNotesLength: 0 } : { maxDescriptionLength: 0, minImages: 1 }),
    }),
  }))
  return createCatalog({
    hostCaps,
    cursorKey: Buffer.alloc(32, 1),
    capabilityPolicy: { id: 'v1', isCompatible: () => true },
    repository: {
      findFree: async () => [rows[0]],
      readTemplate: async ({ templateId }) => rows.find((row) => row.id === templateId) || null,
      scanTerms: async () => [],
      scanEffects: async () => [rows[1]],
    },
  })
}
