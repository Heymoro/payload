import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionShares } from '../src/creation/application/session-share.ts'

const now = '2026-11-17T12:00:00.000Z'
const key = 'a'.repeat(32)
function fixture() {
  const state = {
    admin: { id: 1, role: 'admin', status: 'active' },
    shares: [],
    audits: [],
    failAudit: false,
    imageCalls: 0,
    writing: false,
  }
  const source = {
    id: 4,
    userId: 9,
    templateId: 3,
    title: '我的创作',
    draft: 'PRIVATE DRAFT',
    systemPrompt: 'PRIVATE PROMPT',
    images: [11, 12].map((id) => ({
      id,
      mediaId: id + 100,
      createdAt: now,
      width: 1024,
      height: 1024,
      userNotes: 'PRIVATE NOTES',
    })),
  }
  const repo = {
    admin: async () => state.admin,
    byKey: async ({ key }) => state.shares.filter((s) => s.publicKey === key),
    bySession: async ({ sessionId }) => state.shares.filter((s) => s.sessionId === sessionId),
    source: async ({ sessionId, artifactIds }) => {
      if (sessionId !== source.id) throw Object.assign(new Error(), { code: 'NOT_FOUND' })
      return {
        ...source,
        images: artifactIds
          ? artifactIds.map((id) => {
              const value = source.images.find((image) => image.id === id)
              if (!value) throw Object.assign(new Error(), { code: 'NOT_FOUND' })
              return value
            })
          : [...source.images],
      }
    },
    sessions: async () => [source],
    save: async ({ before, data }) => {
      const saved = { id: before?.id || state.shares.length + 1, ...data }
      if (before) state.shares[state.shares.indexOf(before)] = saved
      else state.shares.push(saved)
      return saved
    },
    audit: async ({ after }) => {
      if (state.failAudit) throw Error('audit failed')
      state.audits.push(after.id)
    },
  }
  const options = {
    clock: () => now,
    makeKey: () => key,
    read: async ({ work }) => work({ repository: repo }),
    write: async ({ work }) => {
      const saved = structuredClone({ shares: state.shares, audits: state.audits })
      state.writing = true
      try {
        return await work({ repository: repo })
      } catch (error) {
        Object.assign(state, saved)
        throw error
      } finally {
        state.writing = false
      }
    },
    readImage: async () => {
      assert.equal(state.writing, false)
      state.imageCalls++
      return { bytes: new Uint8Array([1, 2]), mimeType: 'image/png' }
    },
  }
  const service = createSessionShares(options)
  const publish = (changes = {}) =>
    service.publish({
      adminId: 1,
      input: {
        sessionId: 4,
        title: '展示会话',
        artifactIds: [11, 12],
        confirmed: true,
        ...changes,
      },
    })
  return { state, source, options, service, publish }
}

test('publishes only an explicit snapshot of existing results without private session/input fields', async () => {
  const f = fixture()
  await f.publish()
  assert.deepEqual(await f.service.get({ key }), {
    key,
    title: '展示会话',
    templateId: 3,
    images: [11, 12].map((id) => ({ id, createdAt: now, width: 1024, height: 1024 })),
  })
  assert.doesNotMatch(
    JSON.stringify(await f.service.get({ key })),
    /PRIVATE|userId|mediaId|draft|systemPrompt|userNotes/,
  )
  f.source.images.push({ id: 13, mediaId: 113, createdAt: now, width: 10, height: 10 })
  assert.deepEqual(
    (await f.service.get({ key })).images.map((i) => i.id),
    [11, 12],
  )
})
for (const admin of [
  null,
  { id: 1, role: 'operator', status: 'active' },
  { id: 1, role: 'admin', status: 'disabled' },
]) {
  test(`sharing requires active admin, not ${JSON.stringify(admin)}`, async () => {
    const f = fixture()
    f.state.admin = admin
    for (const work of [
      f.publish,
      () => f.service.inspect({ adminId: 1, sessionId: 4 }),
      () => f.service.list({ adminId: 1 }),
      () => f.service.revoke({ adminId: 1, sessionId: 4 }),
    ])
      await assert.rejects(work, { code: 'ADMIN_FORBIDDEN' })
    assert.equal(f.state.shares.length, 0)
  })
}
test('same explicit publication replays without another row or audit; update remains one share', async () => {
  const f = fixture()
  const first = await f.publish()
  assert.deepEqual(await f.publish(), first)
  assert.equal(f.state.audits.length, 1)
  await f.publish({ artifactIds: [12], title: '精选作品' })
  assert.equal(f.state.shares.length, 1)
  assert.deepEqual(
    (await f.service.get({ key })).images.map((i) => i.id),
    [12],
  )
})
test('foreign or unselected artifact never reaches private image IO', async () => {
  const f = fixture()
  await f.publish({ artifactIds: [11] })
  await assert.rejects(f.service.image({ key, artifactId: 12 }), { code: 'NOT_FOUND' })
  assert.equal(f.state.imageCalls, 0)
})
test('revocation blocks both metadata and media while retaining the original session and results', async () => {
  const f = fixture()
  await f.publish()
  const before = structuredClone(f.source)
  await f.service.revoke({ adminId: 1, sessionId: 4 })
  await assert.rejects(f.service.get({ key }), { code: 'NOT_FOUND' })
  await assert.rejects(f.service.image({ key, artifactId: 11 }), { code: 'NOT_FOUND' })
  assert.deepEqual(f.source, before)
  assert.equal(f.state.imageCalls, 0)
})
test('revocation during storage IO is checked before returning bytes', async () => {
  const f = fixture()
  const service = createSessionShares({
    ...f.options,
    readImage: async () => {
      await f.service.revoke({ adminId: 1, sessionId: 4 })
      return { bytes: new Uint8Array([1]), mimeType: 'image/png' }
    },
  })
  await f.publish()
  await assert.rejects(service.image({ key, artifactId: 11 }), { code: 'NOT_FOUND' })
})
test('audit failure rolls back sharing without touching the source or financial graph', async () => {
  const f = fixture()
  const before = structuredClone(f.source)
  f.state.failAudit = true
  await assert.rejects(f.publish(), /audit failed/)
  assert.equal(f.state.shares.length, 0)
  assert.deepEqual(f.source, before)
})
test('candidate public keys are checked in the service rather than trusting a SQL UNIQUE', async () => {
  const f = fixture()
  f.state.shares.push({
    id: 8,
    sessionId: 99,
    publicKey: key,
    status: 'published',
    isDeleted: false,
  })
  await assert.rejects(f.publish(), { code: 'DATA_INTEGRITY_CONFLICT' })
  assert.equal(f.state.shares.length, 1)
})
for (const change of [
  { artifactIds: [] },
  { artifactIds: [11, 11] },
  { artifactIds: [0] },
  { artifactIds: Array.from({ length: 21 }, (_, i) => i + 1) },
  { confirmed: false },
  { owner: 9 },
]) {
  test(`rejects malformed publication ${JSON.stringify(change)}`, async () => {
    const f = fixture()
    await assert.rejects(f.publish(change), { code: 'INPUT_INVALID' })
    assert.equal(f.state.shares.length, 0)
  })
}
