import test from 'node:test'
import assert from 'node:assert/strict'
import { Admins } from '../src/collections/Admins.ts'
import { UserSessions } from '../src/collections/UserSessions.ts'
import { WechatIdentities } from '../src/collections/WechatIdentities.ts'
import { isAdministratorPrincipal, isStaffPrincipal } from '../src/auth-principals.ts'
import { cleanupOrphanMedia } from '../src/service-media.ts'

const activeAdmin = { id: 1, collection: 'admins', status: 'active', role: 'admin' }
const operator = { ...activeAdmin, role: 'operator' }
function req(totalDocs = 0) {
  return { user: null, payload: { count: async () => ({ totalDocs }) } }
}

test('empty database first admin is active administrator regardless of default role', async () => {
  const hook = Admins.hooks.beforeChange?.[0]
  assert.equal(typeof hook, 'function')
  const data = await hook({
    data: { role: 'operator', status: 'disabled' },
    operation: 'create',
    req: req(0),
  })
  assert.equal(data.role, 'admin')
  assert.equal(data.status, 'active')
  const later = await hook({ data: { role: 'operator' }, operation: 'create', req: req(1) })
  assert.equal(later.role, 'operator')
})
test('disabled administrator has no staff or administrator privileges', () => {
  assert.equal(isStaffPrincipal({ ...activeAdmin, status: 'disabled' }), false)
  assert.equal(isAdministratorPrincipal({ ...activeAdmin, status: 'disabled' }), false)
  assert.equal(isStaffPrincipal(operator), true)
})
test('raw identity and session storage is not editable by operators', async () => {
  for (const config of [UserSessions, WechatIdentities]) {
    for (const operation of ['create', 'read', 'update', 'delete']) {
      assert.equal(await config.access[operation]({ req: { user: operator } }), false)
    }
  }
})
test('last active administrator cannot be demoted, disabled or deleted', async () => {
  const request = { ...req(0), user: activeAdmin }
  for (const data of [{ role: 'operator' }, { status: 'disabled' }]) {
    await assert.rejects(
      Admins.hooks.beforeChange[0]({
        data,
        originalDoc: activeAdmin,
        operation: 'update',
        req: request,
      }),
      /LAST_ACTIVE_ADMIN/,
    )
  }
  request.payload.findByID = async () => activeAdmin
  await assert.rejects(Admins.hooks.beforeDelete[0]({ id: 1, req: request }), /LAST_ACTIVE_ADMIN/)
  request.payload.count = async () => ({ totalDocs: 1 })
  await assert.doesNotReject(Admins.hooks.beforeDelete[0]({ id: 1, req: request }))
})
test('cleanup never treats active independent files as abandoned uploads', async () => {
  const queries = []
  const payload = {
    db: { beginTransaction: async () => 'cleanup-tx', commitTransaction: async () => {} },
    find: async (query) => {
      assert.equal(query.req.transactionID, 'cleanup-tx')
      queries.push(query)
      return { docs: [] }
    },
  }
  const result = await cleanupOrphanMedia({ payload, req: { payload } })
  assert.equal(result.queued, 0)
  assert.equal(queries.length, 1)
  assert.match(JSON.stringify(queries[0].where), /pendingDelete/)
  assert.ok(!JSON.stringify(queries[0].where).includes('createdAt'))
})

test('media collection read policy owns user isolation and preserves Web staff visibility', async () => {
  const { Media } = await import('../src/collections/Media.ts')
  const user = { id: 7, collection: 'users', status: 'active' }
  assert.deepEqual(await Media.access.read({ req: { user } }), {
    and: [{ owner: { equals: 7 } }, { lifecycle: { equals: 'active' } }],
  })
  for (const principal of [
    null,
    { ...user, status: 'disabled' },
    { ...activeAdmin, status: 'disabled' },
    { ...operator, status: 'disabled' },
  ]) {
    assert.equal(await Media.access.read({ req: { user: principal } }), false)
  }
  for (const principal of [activeAdmin, operator])
    assert.equal(await Media.access.read({ req: { user: principal } }), true)
  assert.equal(await Media.access.admin({ req: { user } }), false)
  assert.equal(await Media.access.update({ req: { user } }), false)
  assert.equal(await Media.access.delete({ req: { user } }), false)
})

test('media field reads keep ownerId but withhold operational and storage aliases from clients', async () => {
  const { Media } = await import('../src/collections/Media.ts')
  const fields = Object.fromEntries(
    Media.fields.filter((field) => 'name' in field).map((field) => [field.name, field]),
  )
  const user = { id: 7, collection: 'users', status: 'active' }
  assert.equal(await fields.owner.access.read({ req: { user } }), true)
  assert.equal(await fields.owner.access.update({ req: { user } }), false)
  assert.equal(fields.storageName.hidden, true)
  for (const name of [
    'pendingDeleteAt',
    'deleteAttempts',
    'lastDeleteError',
    'filename',
    'url',
    'thumbnailURL',
    'original',
    'variants',
  ]) {
    assert.equal(typeof fields[name]?.access?.read, 'function', name)
    assert.equal(await fields[name].access.read({ req: { user } }), false, name)
    for (const principal of [activeAdmin, operator])
      assert.equal(await fields[name].access.read({ req: { user: principal } }), true, name)
  }
})

test('read-only upload field overrides preserve Payload base schema and hooks', async () => {
  const { Media } = await import('../src/collections/Media.ts')
  const { getBaseUploadFields } =
    await import('../../../packages/payload/src/uploads/getBaseFields.ts')
  const { mergeBaseFields } =
    await import('../../../packages/payload/src/fields/mergeBaseFields.ts')
  const baseFields = getBaseUploadFields({
    collection: {
      ...Media,
      upload: {
        ...Media.upload,
        variants: [{ name: 'thumbnail' }, { name: 'medium' }, { name: 'large' }],
      },
    },
    config: { routes: { api: '/api' } },
  })
  const merged = mergeBaseFields(Media.fields, baseFields)
  for (const base of baseFields) {
    const field = merged.find((item) => item.name === base.name)
    assert.equal(field.type, base.type)
    assert.equal(field.unique, base.unique)
    assert.equal(field.index, base.index)
    assert.equal(field.validate, base.validate)
    if (base.hooks) assert.deepEqual(field.hooks, base.hooks)
    if (base.fields) assert.deepEqual(field.fields, base.fields)
  }
})
