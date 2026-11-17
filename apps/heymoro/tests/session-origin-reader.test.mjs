import assert from 'node:assert/strict'
import test from 'node:test'

import { createOwnerSessions } from '../src/creation/application/owner-sessions.ts'
import {
  createPayloadOwnerSessions,
  createSessionsReader,
} from '../src/creation/infrastructure/payload/owner-sessions-repository.ts'

const cursorKey = new Uint8Array(32).fill(7)
const time = '2026-11-12T00:00:00.000Z'
const profile = {
  id: 9,
  userId: 1,
  clientRequestId: '  创建-原值🦊  ',
  title: 'Original',
  titleSource: 'template',
  mode: 'effect',
  templateId: 2,
  templateVersionId: 3,
  lastActivityAt: time,
  nextRoundNo: 1,
  coverArtifactId: null,
  isDeleted: false,
  deletedAt: null,
  deletedBy: null,
}
const draft = {
  id: 20,
  userId: 1,
  sessionId: 9,
  isDeleted: false,
  description: ' raw ',
  userNotes: '',
  updatedAt: time,
}
const conflict = { code: 'DATA_INTEGRITY_CONFLICT', status: 503 }

function fixture({ row = profile, tuples = [row], actors } = {}) {
  const tupleCalls = []
  const reader = {
    library: { actor: async () => actors ?? [{ id: 1, status: 'active', isDeleted: false }] },
    scan: async () => [row],
    profiles: async () => (row ? [row] : []),
    requestProfiles: async (args) => {
      tupleCalls.push(args)
      return tuples
    },
    inflight: async () => [],
    draft: {
      isAccountActive: async () => true,
      readSession: async () => row,
      findDrafts: async () => [draft],
      findSlots: async () => [],
    },
  }
  const service = createOwnerSessions({ cursorKey, read: ({ work }) => work({ reader }) })
  return { service, tupleCalls }
}

for (const clientRequestId of [profile.clientRequestId, 'x'.repeat(128)]) {
  test(`should project the exact persisted creation key ${JSON.stringify(clientRequestId)}`, async () => {
    const f = fixture({ row: { ...profile, clientRequestId } })
    const detail = await f.service.get({ userId: 1, sessionId: 9 })

    assert.equal(detail.creationClientRequestId, clientRequestId)
    assert.equal(Object.isFrozen(detail), true)
    assert.deepEqual(f.tupleCalls, [{ userId: 1, clientRequestId }])
    assert.equal(Object.hasOwn(detail, 'clientRequestId'), false)
    assert.deepEqual(detail.draft, {
      input: { description: ' raw ', userNotes: '', inputMediaIds: [] },
      updatedAt: time,
    })
  })
}

for (const clientRequestId of [undefined, null, '', ' \n\t ', 123, {}, 'x'.repeat(129)]) {
  test(`should reject a malformed stored creation key ${JSON.stringify(clientRequestId)}`, async () => {
    const f = fixture({ row: { ...profile, clientRequestId } })

    await assert.rejects(() => f.service.get({ userId: 1, sessionId: 9 }), conflict)
    assert.deepEqual(f.tupleCalls, [])
  })
}
test('should reject a missing stored creation key rather than synthesize proof', async () => {
  const { clientRequestId: _key, ...row } = profile
  const f = fixture({ row })

  await assert.rejects(() => f.service.get({ userId: 1, sessionId: 9 }), conflict)
})

for (const [name, tuples] of [
  ['zero', []],
  ['duplicate', [profile, { ...profile, id: 10 }]],
  [
    'soft-deleted duplicate',
    [profile, { ...profile, id: 10, isDeleted: true, deletedAt: time, deletedBy: 'user:1' }],
  ],
  ...[
    { id: 10 },
    { userId: 2 },
    { clientRequestId: 'third-key' },
    { templateId: 4 },
    { mode: 'free' },
    { isDeleted: true, deletedAt: time, deletedBy: 'user:1' },
    { deletedAt: time },
    { deletedBy: 'user:1' },
  ].map((change) => [JSON.stringify(change), [{ ...profile, ...change }]]),
]) {
  test(`should reject conflicting creation tuple evidence: ${name}`, async () => {
    const f = fixture({ tuples })

    await assert.rejects(() => f.service.get({ userId: 1, sessionId: 9 }), conflict)
    assert.deepEqual(f.tupleCalls, [{ userId: 1, clientRequestId: '  创建-原值🦊  ' }])
  })
}

for (const [name, options, error] of [
  [
    'inactive actor',
    { actors: [{ id: 1, status: 'disabled', isDeleted: false }] },
    { status: 401 },
  ],
  ['absent session', { row: null }, { status: 404 }],
  ['foreign session', { row: { ...profile, userId: 2 } }, { status: 404 }],
  ['wrong session id', { row: { ...profile, id: 10 } }, { status: 404 }],
  [
    'deleted session',
    { row: { ...profile, isDeleted: true, deletedAt: time, deletedBy: 'user:1' } },
    { status: 404 },
  ],
]) {
  test(`should preserve ${name} rejection before any creation tuple read`, async () => {
    const f = fixture(options)

    await assert.rejects(() => f.service.get({ userId: 1, sessionId: 9 }), error)
    assert.deepEqual(f.tupleCalls, [])
  })
}

test('should keep list shape and list validity independent of creation proof', async () => {
  const f = fixture({ row: { ...profile, clientRequestId: null } })
  const page = await f.service.list({ userId: 1, query: {} })

  assert.deepEqual(Object.keys(page.items[0]).sort(), [
    'cover',
    'id',
    'lastActivityAt',
    'mode',
    'runningTask',
    'templateId',
    'title',
    'titleSource',
  ])
  assert.deepEqual(f.tupleCalls, [])
})

test('should query exact owner plus literal key with limit two and include deleted rows', async () => {
  const calls = []
  const deleted = { ...profile, id: 10, isDeleted: true, deletedAt: time, deletedBy: 'user:1' }
  const reader = createSessionsReader({
    find: async (args) => {
      calls.push(args)
      return { docs: [profile, deleted], totalDocs: 2 }
    },
  })
  const rows = await reader.requestProfiles({ userId: 1, clientRequestId: '  创建-原值🦊  ' })

  assert.deepEqual(rows, [profile, deleted])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].collection, 'creation-sessions')
  assert.equal(calls[0].limit, 2)
  assert.equal(calls[0].showHiddenFields, true)
  assert.equal(calls[0].select.clientRequestId, true)
  assert.deepEqual(calls[0].where, {
    and: [{ userId: { equals: 1 } }, { clientRequestId: { equals: '  创建-原值🦊  ' } }],
  })
})

for (const result of [
  { docs: [profile, profile], totalDocs: 3 },
  { docs: [profile], totalDocs: 2 },
  { docs: [profile], totalDocs: 0 },
  { docs: [profile], totalDocs: 1.5 },
  { docs: [profile, profile, profile], totalDocs: 3 },
  { docs: null, totalDocs: 0 },
]) {
  test(`should reject incomplete or malformed tuple query metadata ${JSON.stringify(result)}`, async () => {
    const reader = createSessionsReader({ find: async () => result })

    await assert.rejects(
      () => reader.requestProfiles({ userId: 1, clientRequestId: profile.clientRequestId }),
      conflict,
    )
  })
}

function schemaFixture({ hasCreationKey = true } = {}) {
  const names =
    `id userId sessionId taskId mediaId outputIndex createdAt isDeleted deletedAt deletedBy
    templateId templateVersionId mode clientRequestId title titleSource lastActivityAt coverArtifactId
    nextRoundNo roundNo attemptNo provider model status errorCode resultStorageBackend resultStorageBucket
    resultStorageKey resultSha256 sourceTaskId executionSnapshotJson costCredits description userNotes
    requestHash owner lifecycle purpose visibility mimeType filesize width height sha256 storageBackend
    storageBucket storageName artifactId savedAt updatedAt createdBy updatedBy draftId position`.split(
      /\s+/,
    )
  return {
    collections: Object.fromEntries(
      [
        'artifacts',
        'creation-sessions',
        'generation-attempts',
        'generation-tasks',
        'media',
        'saved-artifacts',
        'users',
        'creation-drafts',
        'draft-inputs',
      ].map((slug) => [
        slug,
        {
          config: {
            flattenedFields: names
              .filter(
                (name) =>
                  hasCreationKey || slug !== 'creation-sessions' || name !== 'clientRequestId',
              )
              .map((name) => ({ name, type: name === 'isDeleted' ? 'checkbox' : 'text' })),
          },
        },
      ]),
    ),
  }
}

test('should gate the stored creation key before opening any native snapshot', () => {
  assert.throws(
    () =>
      createPayloadOwnerSessions({ payload: schemaFixture({ hasCreationKey: false }), cursorKey }),
    /Session history requires the complete target schema for creation-sessions/,
  )
})

test('redundant old row version metadata does not replace the stable template identity or leak in detail', async () => {
  const f = fixture({ tuples: [{ ...profile, templateVersionId: 4 }] })
  const detail = await f.service.get({ userId: 1, sessionId: 9 })
  assert.equal(detail.templateId, profile.templateId)
  assert.equal(Object.hasOwn(detail, 'templateVersionId'), false)
})
