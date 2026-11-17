import assert from 'node:assert/strict'
import test from 'node:test'

import { createArtifactFavorite } from '../src/creation/application/artifact-favorite.ts'
import { generationResultKey } from '../src/creation/domain/generation.ts'
import { hashTaskClientInput } from '../src/creation/domain/input.ts'

const time = '2026-11-12T00:00:00.000Z'
const later = '2026-11-13T00:00:00.000Z'
const args = { artifactId: 5, userId: 1 }
const active = { deletedAt: null, deletedBy: null, isDeleted: false }

test('unit: inserts through the semantic port with exact trusted arguments after coordination', async () => {
  const f = fixture()
  assert.equal(Object.hasOwn(f.repository, 'insert'), false)
  assert.equal(Object.hasOwn(f.repository, 'update'), false)
  const result = await f.service.set({ ...args, isFavorite: true })
  assert.deepEqual(result, { isFavorite: true, savedAt: time })
  assert.equal(Object.isFrozen(result), true)
  assert.deepEqual(f.events, [
    { operation: 'insertFavorite', input: { ...args, actor: 'user:1', now: time } },
  ])
  assert.equal(f.state.clockCalls, 1)
})

test('unit: removes and restores the same identity using distinct exact semantic commands', async () => {
  const f = fixture()
  await f.service.set({ ...args, isFavorite: true })
  f.state.now = later
  assert.deepEqual(await f.service.set({ ...args, isFavorite: false }), {
    isFavorite: false,
    savedAt: null,
  })
  assert.equal(f.rows[0].savedAt, time)
  assert.deepEqual(await f.service.set({ ...args, isFavorite: true }), {
    isFavorite: true,
    savedAt: later,
  })
  assert.deepEqual(f.events.slice(1), [
    { operation: 'removeFavorite', input: { id: 6, actor: 'user:1', now: later } },
    { operation: 'restoreFavorite', input: { id: 6, actor: 'user:1', now: later } },
  ])
  assert.equal(f.rows.length, 1)
  assert.equal(f.rows[0].id, 6)
  assert.equal(f.state.clockCalls, 3)
})

test('unit: absent DELETE and active or deleted replays do not sample time or write', async () => {
  const f = fixture()
  await f.service.set({ ...args, isFavorite: false })
  assert.equal(f.state.clockCalls, 0)
  assert.deepEqual(f.events, [])
  await f.service.set({ ...args, isFavorite: true })
  f.state.now = 'invalid unused clock'
  assert.deepEqual(await f.service.set({ ...args, isFavorite: true }), {
    isFavorite: true,
    savedAt: time,
  })
  assert.equal(f.state.clockCalls, 1)
  f.state.now = later
  await f.service.set({ ...args, isFavorite: false })
  f.state.now = 'invalid unused clock'
  assert.deepEqual(await f.service.set({ ...args, isFavorite: false }), {
    isFavorite: false,
    savedAt: null,
  })
  assert.equal(f.state.clockCalls, 2)
  assert.equal(f.events.length, 2)
})

test('unit: descriptor-safe input rejects untrusted extra fields before entering the write boundary', async () => {
  const f = fixture()
  let getterCalls = 0
  for (const input of [
    { ...args, isFavorite: true, actor: 'admin:99' },
    { ...args, isFavorite: true, now: time },
    { ...args, isFavorite: 'true' },
    { ...args, isFavorite: true, artifactId: 0 },
    Object.defineProperty({ ...args }, 'isFavorite', {
      enumerable: true,
      get() {
        getterCalls++
        return true
      },
    }),
  ]) {
    await assert.rejects(() => f.service.set(input), { code: 'INPUT_INVALID' })
  }
  await assert.rejects(() => f.service.set({ ...args, userId: 0, isFavorite: true }), {
    code: 'UNAUTHENTICATED',
  })
  assert.equal(getterCalls, 0)
  assert.equal(f.state.writeCalls, 0)
  assert.equal(f.state.clockCalls, 0)
  assert.deepEqual(f.events, [])
})

for (const scenario of [
  'inactive',
  'missing',
  'foreign',
  'deleted',
  'identity',
  'media',
  'duplicate',
]) {
  test(`unit: rejects ${scenario} evidence before sampling time or writing`, async () => {
    const f = fixture()
    let code = 'DATA_INTEGRITY_CONFLICT'
    if (scenario === 'inactive') {
      f.user.status = 'disabled'
      code = 'UNAUTHENTICATED'
    } else if (scenario === 'missing') {
      f.repository.artifacts = async () => []
      code = 'NOT_FOUND'
    } else if (scenario === 'foreign') {
      f.artifact.userId = 2
      code = 'NOT_FOUND'
    } else if (scenario === 'deleted') {
      Object.assign(f.artifact, { isDeleted: true, deletedAt: time, deletedBy: 'user:1' })
      code = 'NOT_FOUND'
    } else if (scenario === 'identity') {
      f.artifact.outputIndex = 2
    } else if (scenario === 'media') {
      f.media.lifecycle = 'deleted'
    } else {
      f.rows.push(favoriteRow(), { ...favoriteRow(), id: 7, isDeleted: true })
    }
    await assert.rejects(() => f.service.set({ ...args, isFavorite: true }), { code })
    assert.equal(f.state.clockCalls, 0)
    assert.deepEqual(f.events, [])
  })
}

test('unit: cleanup skips delivery eligibility for a coherent artifact tombstone but rejects malformed identity', async () => {
  const f = fixture()
  f.rows.push(favoriteRow())
  f.media.lifecycle = 'deleted'
  Object.assign(f.artifact, { isDeleted: true, deletedAt: time, deletedBy: 'user:1' })
  await f.service.set({ ...args, isFavorite: false })
  assert.deepEqual(f.events, [
    { operation: 'removeFavorite', input: { id: 6, actor: 'user:1', now: time } },
  ])
  f.artifact.deletedAt = null
  await assert.rejects(() => f.service.set({ ...args, isFavorite: false }), {
    code: 'DATA_INTEGRITY_CONFLICT',
  })
  assert.equal(f.state.clockCalls, 1)
  assert.equal(f.events.length, 1)
})

for (const changes of [{ id: 0 }, { isDeleted: 'false' }, { savedAt: 'invalid' }]) {
  test(`unit: rejects malformed favorite ${Object.keys(changes)[0]} even during cleanup`, async () => {
    const f = fixture()
    f.rows.push({ ...favoriteRow(), ...changes })
    await assert.rejects(() => f.service.set({ ...args, isFavorite: false }), {
      code: 'DATA_INTEGRITY_CONFLICT',
    })
    assert.equal(f.state.clockCalls, 0)
    assert.deepEqual(f.events, [])
  })
}

for (const operation of ['insertFavorite', 'removeFavorite', 'restoreFavorite']) {
  test(`unit: propagates the original ${operation} failure without an alternate write`, async () => {
    const f = fixture()
    if (operation !== 'insertFavorite') {
      f.rows.push({ ...favoriteRow(), isDeleted: operation === 'restoreFavorite' })
    }
    const error = new Error('Unit semantic port failure')
    f.repository[operation] = async (input) => {
      f.events.push({ operation, input })
      throw error
    }
    await assert.rejects(
      () => f.service.set({ ...args, isFavorite: operation !== 'removeFavorite' }),
      (actual) => actual === error,
    )
    assert.equal(f.events.length, 1)
    assert.equal(f.state.clockCalls, 1)
  })
}

test('unit: invalid sampled time fails before any semantic command', async () => {
  const f = fixture()
  f.state.now = 'invalid'
  await assert.rejects(() => f.service.set({ ...args, isFavorite: true }), {
    code: 'INPUT_INVALID',
  })
  assert.equal(f.state.clockCalls, 1)
  assert.deepEqual(f.events, [])
})

function favoriteRow() {
  return { ...active, ...args, id: 6, savedAt: time }
}

// Complete synthetic delivery facts exercise the real projection. No Native worker or services run here.
function fixture() {
  const input = { inputMediaIds: [], description: 'unit delivery', userNotes: '' }
  const clientInput = { operation: 'generate', sessionId: 2, input }
  const snapshot = {
    schemaVersion: 1,
    clientInput,
    input,
    mode: 'free',
    templateId: 3,
    templateVersionId: 4,
    executionPlan: {
      executorId: 'unit',
      provider: 'unit',
      model: 'unit',
      parameters: {},
      systemPrompt: 'unit prompt',
    },
    media: [],
    storageOutput: { backend: 'fixture', bucket: 'output', keyRule: 'task-attempt-result-v1' },
    quote: { costCredits: 0, issuedAt: time, validUntil: '2026-11-12T00:01:00.000Z' },
  }
  const sha256 = 'a'.repeat(64)
  const storageName = generationResultKey({
    attemptId: 8,
    keyRule: snapshot.storageOutput.keyRule,
    sha256,
    taskId: 10,
  })
  const artifact = {
    ...active,
    id: 5,
    userId: 1,
    taskId: 10,
    sessionId: 2,
    mediaId: 9,
    outputIndex: 1,
    createdAt: time,
  }
  const user = { id: 1, status: 'active', isDeleted: false }
  const media = {
    ...active,
    id: 9,
    owner: 1,
    lifecycle: 'active',
    purpose: 'artifact',
    visibility: 'private',
    mimeType: 'image/png',
    sha256,
    filesize: 100,
    width: 16,
    height: 16,
    storageBackend: 'fixture',
    storageBucket: 'output',
    storageName,
  }
  const task = {
    ...active,
    id: 10,
    userId: 1,
    sessionId: 2,
    templateId: 3,
    sourceTaskId: null,
    status: 'succeeded',
    costCredits: 0,
    description: input.description,
    userNotes: '',
    executionSnapshotJson: JSON.stringify(snapshot),
    requestHash: hashTaskClientInput({ clientInput }),
  }
  const rows = []
  const events = []
  const state = { clockCalls: 0, isHeld: false, now: time, writeCalls: 0 }
  const repository = {
    actor: async () => [user],
    artifacts: async () => [artifact],
    artifactTuples: async () => [artifact],
    attempts: async () => [
      {
        ...active,
        id: 8,
        taskId: 10,
        attemptNo: 1,
        provider: 'unit',
        model: 'unit',
        status: 'succeeded',
        resultStorageBackend: 'fixture',
        resultStorageBucket: 'output',
        resultStorageKey: storageName,
        resultSha256: sha256,
      },
    ],
    favorites: async () => rows,
    media: async () => [media],
    mediaLocators: async () => [media],
    scan: async () => [],
    sessions: async () => [
      { ...active, id: 2, userId: 1, templateId: 3, templateVersionId: 4, mode: 'free' },
    ],
    tasks: async () => [task],
    insertFavorite: async (input) => {
      events.push({ operation: 'insertFavorite', input })
      rows.push({ ...favoriteRow(), savedAt: input.now })
    },
    removeFavorite: async (input) => {
      events.push({ operation: 'removeFavorite', input })
      rows[0] = { ...rows[0], isDeleted: true }
    },
    restoreFavorite: async (input) => {
      events.push({ operation: 'restoreFavorite', input })
      rows[0] = { ...rows[0], isDeleted: false, savedAt: input.now }
    },
  }
  const service = createArtifactFavorite({
    clock: () => {
      assert.equal(state.isHeld, true)
      state.clockCalls++
      return state.now
    },
    write: async ({ artifactId, userId, work }) => {
      assert.deepEqual({ artifactId, userId }, args)
      state.writeCalls++
      state.isHeld = true
      try {
        return await work({ repository })
      } finally {
        state.isHeld = false
      }
    },
  })
  return { artifact, events, media, repository, rows, service, state, user }
}
