import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePagination } from '../src/pagination.ts'
import { contentDisposition } from '../src/content-disposition.ts'

test('pagination accepts positive integers, caps size and rejects malformed values', () => {
  assert.deepEqual(parsePagination(new URL('http://localhost/?page=2&limit=80')), {
    page: 2,
    limit: 50,
  })
  for (const value of ['Infinity', '1.5', '0', '-1', 'abc', '9007199254740992']) {
    assert.throws(
      () => parsePagination(new URL(`http://localhost/?page=${value}`)),
      /INVALID_PAGINATION/,
    )
  }
})
test('UTF-8 file name produces a valid header without header injection', () => {
  const value = contentDisposition({ filename: '中文"\r\n文档.pdf' })
  assert.doesNotThrow(() => new Response('pdf', { headers: { 'Content-Disposition': value } }))
  assert.match(value, /filename\*=UTF-8''/)
  assert.ok(!value.includes('\r') && !value.includes('\n'))
})

test('file metadata endpoint returns only the visible active media DTO', async () => {
  const { mediaEndpoints } = await import('../src/endpoint-media.ts')
  const endpoint = mediaEndpoints.find(
    (item) => item.path === '/v1/media/:id' && item.method === 'get',
  )
  assert.ok(endpoint, 'GET media metadata endpoint must exist')
  const media = {
    id: 8,
    owner: 3,
    originalName: '附件.pdf',
    storageName: 'private.pdf',
    mimeType: 'application/pdf',
    filesize: 14,
    lifecycle: 'active',
    createdAt: '2026-11-02',
    updatedAt: '2026-11-02',
  }
  const req = {
    user: { id: 3, collection: 'users', status: 'active' },
    routeParams: { id: '8' },
    headers: new Headers(),
    payload: { findByID: async () => media },
  }
  const response = await endpoint.handler(req)
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.data.id, 8)
  assert.equal(result.data.originalName, '附件.pdf')
  assert.equal(result.data.mimeType, 'application/pdf')
  assert.equal(result.data.storageName, undefined)
})

test('file metadata and content share anonymous, foreign, disabled and removed boundaries', async () => {
  const { mediaEndpoints } = await import('../src/endpoint-media.ts')
  for (const path of ['/v1/media/:id', '/v1/media/:id/content']) {
    const endpoint = mediaEndpoints.find((item) => item.path === path && item.method === 'get')
    assert.ok(endpoint, `${path} must exist`)
    let media = { id: 8, owner: 3, originalName: 'private.pdf', lifecycle: 'active' }
    const req = {
      routeParams: { id: '8' },
      headers: new Headers(),
      payload: { findByID: async () => media },
    }
    assert.equal((await endpoint.handler(req)).status, 401, path)
    req.user = { id: 4, collection: 'users', status: 'active' }
    // A document excluded by collection ACL is returned as null by the authorized Local API.
    media = null
    assert.equal((await endpoint.handler(req)).status, 404, path)
    req.user = { id: 3, collection: 'users', status: 'disabled' }
    assert.equal((await endpoint.handler(req)).status, 401, path)
    req.user.status = 'active'
    media = { id: 8, owner: 3, originalName: 'private.pdf', lifecycle: 'active' }
    for (const lifecycle of ['pendingDelete', 'physicalDeleted']) {
      media.lifecycle = lifecycle
      assert.equal((await endpoint.handler(req)).status, 404, path)
    }
    media = null
    assert.equal((await endpoint.handler(req)).status, 404, path)
  }
})

test('record collection owns title normalization and the attachment count limit', async () => {
  const { Records } = await import('../src/collections/Records.ts')
  const { RECORD_LIMITS } = await import('../src/service-records.ts')
  const fields = Object.fromEntries(
    Records.fields.filter((field) => 'name' in field).map((field) => [field.name, field]),
  )
  assert.equal(fields.attachments.maxRows, 20)
  assert.equal(fields.title.minLength, RECORD_LIMITS.title.min)
  assert.equal(fields.title.maxLength, RECORD_LIMITS.title.max)
  assert.equal(fields.body.maxLength, RECORD_LIMITS.body.max)
  assert.equal(fields.attachments.maxRows, RECORD_LIMITS.attachments.max)
  const normalize = fields.title.hooks?.beforeValidate?.[0]
  assert.equal(typeof normalize, 'function')
  assert.equal(await normalize({ value: '  title  ', operation: 'create' }), 'title')
  assert.equal(await normalize({ value: '   ', operation: 'update' }), '')
  assert.equal(await normalize({ value: undefined, operation: 'update' }), undefined)
})

test('record input parser keeps the whitelist and structure while fields enforce business lengths', async () => {
  const { parseRecordInput } = await import('../src/service-records.ts')
  const title = '  title  ',
    body = 'x'.repeat(10001),
    attachments = Array.from({ length: 21 }, (_, index) => index + 1)
  const result = parseRecordInput({ title, body, attachments, owner: 999, lifecycle: 'archived' })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.data, { title, body, attachments })
  for (const input of [
    { title: 1 },
    { title: 'x', body: [] },
    { title: 'x', attachments: ['1'] },
    { title: 'x', attachments: null },
  ]) {
    assert.ok(parseRecordInput(input).error)
  }
  assert.ok(parseRecordInput({}).error)
  assert.ok(parseRecordInput({ owner: 999 }, true).error)
})

test('record facade maps native field ValidationError to the existing 400 contract', async () => {
  const { ValidationError } = await import('payload')
  const { recordsEndpoints } = await import('../src/endpoint-records.ts')
  const endpoint = recordsEndpoints.find((item) => item.method === 'post')
  const response = await endpoint.handler({
    user: { id: 3, collection: 'users', status: 'active' },
    headers: new Headers(),
    json: async () => ({ title: 'Valid structure' }),
    payload: {
      db: { beginTransaction: async () => 'record-tx', rollbackTransaction: async () => {} },
      create: async ({ req }) => {
        assert.equal(req.transactionID, 'record-tx')
        throw new ValidationError({ errors: [{ path: 'title', message: 'Title is invalid' }] })
      },
      logger: { error: () => {} },
    },
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'VALIDATION_FAILED')
})

test('over-limit attachment input reaches native maxRows without per-file lookups', async () => {
  const { Records } = await import('../src/collections/Records.ts')
  let lookups = 0
  const attachments = Array.from({ length: 200 }, (_, index) => index + 1)
  const data = { title: 'x', attachments }
  const result = await Records.hooks.beforeChange[0]({
    data,
    operation: 'create',
    req: {
      user: { id: 3, collection: 'users', status: 'active' },
      payload: {
        findByID: async ({ id }) => {
          lookups++
          return { id, owner: 3, lifecycle: 'active' }
        },
      },
    },
  })
  assert.equal(lookups, 0)
  assert.deepEqual(result.attachments, attachments)
})

test('media listing delegates owner filtering to Payload collection access without bypass', async () => {
  const { mediaEndpoints } = await import('../src/endpoint-media.ts')
  const endpoint = mediaEndpoints.find((item) => item.path === '/v1/media' && item.method === 'get')
  const user = { id: 7, collection: 'users', status: 'active' }
  let options
  const req = {
    user,
    headers: new Headers(),
    url: 'http://localhost/api/v1/media',
    payload: {
      find: async (input) => {
        options = input
        return { docs: [], page: 1, totalDocs: 0, totalPages: 1 }
      },
    },
  }
  assert.equal((await endpoint.handler(req)).status, 200)
  assert.equal(options.overrideAccess, false)
  assert.equal(options.user, user)
  assert.deepEqual(options.where, { lifecycle: { equals: 'active' } })
  assert.equal(options.req, req)
})

test('media detail uses authorized Local API and preserves the hidden-field DTO boundary', async () => {
  const { mediaEndpoints } = await import('../src/endpoint-media.ts')
  const endpoint = mediaEndpoints.find(
    (item) => item.path === '/v1/media/:id' && item.method === 'get',
  )
  const user = { id: 7, collection: 'users', status: 'active' }
  let options
  const req = {
    user,
    headers: new Headers(),
    routeParams: { id: '9' },
    payload: {
      findByID: async (input) => {
        options = input
        return {
          id: 9,
          owner: 7,
          originalName: 'own.pdf',
          storageName: 'private.pdf',
          lifecycle: 'active',
        }
      },
    },
  }
  const response = await endpoint.handler(req)
  assert.equal(response.status, 200)
  assert.equal(options.overrideAccess, false)
  assert.equal(options.user, user)
  assert.equal(options.disableErrors, true)
  assert.equal(options.depth, 0)
  const result = await response.json()
  assert.equal(result.data.ownerId, 7)
  assert.equal(result.data.storageName, undefined)
  assert.equal(response.headers.get('cache-control'), 'private,no-store')
})

test('Web staff pending media remains outside the active-only v1 read facade', async () => {
  const { mediaEndpoints } = await import('../src/endpoint-media.ts')
  for (const path of ['/v1/media/:id', '/v1/media/:id/content']) {
    const endpoint = mediaEndpoints.find((item) => item.path === path && item.method === 'get')
    const req = {
      user: { id: 1, collection: 'admins', status: 'active', role: 'operator' },
      headers: new Headers(),
      routeParams: { id: '9' },
      payload: { findByID: async () => ({ id: 9, owner: 7, lifecycle: 'pendingDelete' }) },
    }
    assert.equal((await endpoint.handler(req)).status, 404)
  }
})
