import assert from 'node:assert/strict'
import test from 'node:test'
import { createCreationCollections } from '../src/creation/infrastructure/payload/collections.ts'

const now = '2026-11-17T12:00:00.000Z'
const audit = {
  createdAt: now,
  updatedAt: now,
  createdBy: 'admin:1',
  updatedBy: 'admin:1',
  isDeleted: false,
  deletedAt: null,
  deletedBy: null,
}
const original = {
  ...audit,
  code: 'free',
  kind: 'free',
  name: 'Free',
  status: 'published',
  costCredits: 3,
  displayConfigJson: '{"name":"Free"}',
  generationConfigJson: '{}',
}

function fixture() {
  let authorized = true
  const gate = {
    beforeOperation() {},
    assert() {
      if (!authorized) throw Error('write gate denied')
    },
  }
  const collections = createCreationCollections({ gate })
  const collection = collections.find((item) => item.slug === 'creation-templates')
  const change = ({ data, originalDoc = original }) =>
    collection.hooks.beforeChange[0]({
      data,
      originalDoc,
      operation: originalDoc ? 'update' : 'create',
      req: {},
    })
  return {
    collections,
    collection,
    change,
    revoke: () => {
      authorized = false
    },
  }
}

test('registers a single current configuration without business version fields or unique indexes', () => {
  const { collections, collection } = fixture()
  assert.equal(collections.filter((item) => item.slug === 'creation-templates').length, 1)
  assert.equal(
    collections.some((item) => item.slug === 'template-versions'),
    false,
  )
  assert.equal(collection.versions, false)
  const fields = collection.fields.map((field) => field.name)
  for (const field of [
    'costCredits',
    'displayConfigJson',
    'inputSchemaJson',
    'generationConfigJson',
    'shareConfigJson',
    'createdAt',
    'updatedAt',
    'createdBy',
    'updatedBy',
    'isDeleted',
    'deletedAt',
    'deletedBy',
  ])
    assert.ok(fields.includes(field), field)
  for (const field of ['versionNo', 'publishedVersionId', 'version', 'revision'])
    assert.equal(fields.includes(field), false)
  assert.ok(collection.indexes.every((index) => !index.unique))
})

test('published current configuration remains editable without returning to draft', () => {
  const { change } = fixture()
  const data = {
    updatedAt: now,
    updatedBy: 'admin:1',
    costCredits: 4,
    generationConfigJson: '{"systemPrompt":"new"}',
  }
  assert.equal(change({ data }), data)
})

for (const field of ['code', 'kind']) {
  test(`current ${field} remains a stable lifetime identity`, () => {
    assert.throws(
      () => fixture().change({ data: { [field]: field === 'kind' ? 'effect' : 'new-code' } }),
      /immutable/,
    )
  })
}

for (const status of ['draft', 'withdrawn', 'review', 'unknown']) {
  test(`retired or invalid status ${status} is not accepted`, () => {
    assert.throws(() => fixture().change({ data: { status } }), /Invalid current template state/)
  })
}

test('raw collection changes and after-change callbacks require the write gate', () => {
  const f = fixture()
  f.revoke()
  assert.throws(() => f.change({ data: { costCredits: 4 } }), /gate denied/)
  assert.throws(() => f.collection.hooks.afterChange[0]({ doc: original, req: {} }), /gate denied/)
  for (const operation of ['admin', 'create', 'read', 'update', 'delete'])
    assert.equal(f.collection.access[operation]({}), false)
})

test('standard creation audit is immutable and soft deletion must be complete', () => {
  const { change } = fixture()
  assert.throws(() => change({ data: { createdAt: '2026-11-16T12:00:00.000Z' } }), /immutable/)
  assert.throws(() => change({ data: { createdBy: 'admin:2' } }), /immutable/)
  assert.throws(() => change({ data: { isDeleted: true, deletedAt: now } }), /soft-deletion/)
  assert.throws(() => change({ data: { isDeleted: false, deletedBy: 'admin:1' } }), /soft-deletion/)
  assert.throws(() => change({ data: { updatedBy: 'caller text' } }), /service-supplied actor/)
})

test('physical deletion remains forbidden', () => {
  assert.throws(() => fixture().collection.hooks.beforeDelete[0]({}), /forbidden/)
})

// Payload's number type alone permits fractional/negative business counters.
for (const [name, invalid] of [
  ['schemaVersion', [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]],
  ['costCredits', [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]],
  ['sortOrder', [1.5, Number.MAX_SAFE_INTEGER + 1]],
  ['primaryCategoryId', [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]],
]) {
  test(`current ${name} uses explicit safe-integer range validation`, () => {
    const field = fixture().collection.fields.find((item) => item.name === name)
    assert.equal(typeof field.validate, 'function')
    for (const value of invalid) assert.notEqual(field.validate(value), true, `${name}: ${value}`)
    assert.equal(field.validate(name === 'costCredits' ? 0 : 1), true)
    assert.equal(
      field.validate(null),
      name === 'primaryCategoryId' ? true : 'Expected a required integer.',
    )
    if (name === 'sortOrder') assert.equal(field.validate(-1), true)
  })
}
