import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createCreationCollections } from '../src/creation/infrastructure/payload/collections.ts'
import { createCreationAuditCollection } from '../src/creation/infrastructure/payload/audit-collection.ts'
import { createCreationMediaCollection } from '../src/creation/infrastructure/payload/media-collection.ts'
import { createIdentityCollections } from '../src/creation/runtime/identity-collections.ts'
import { Media } from '../src/collections/Media.ts'
import { createCreationWriteGate } from '../src/creation/infrastructure/payload/write-gate.ts'
import { createCreationRuntime } from '../src/creation/infrastructure/payload/session-repository.ts'
import * as original from '../src/creation/runtime/services.ts'
import { buildCorePayloadConfig } from '../src/creation/runtime/payload-config.ts'
import { prepareTarget } from '../src/creation/runtime/target-profile.ts'
import { hostConfig } from './creation/runtime-seed.ts'

async function fixture() {
  const gate = createCreationWriteGate()
  const noIO = () => assert.fail('Runtime binding must not issue database or provider IO')
  const config = hostConfig({ dataDir: '/unused/runtime-binding' })
  const configurations = [
    ...createCreationCollections({ gate }),
    ...createIdentityCollections({ gate, clock: () => '2026-11-16T00:00:00.000Z' }),
    createCreationAuditCollection({ gate }),
    createCreationMediaCollection({
      baseCollection: Media,
      gate,
      staticDir: '/unused/runtime-binding',
    }),
  ]
  const fields = (list) =>
    list.flatMap((field) => ('fields' in field ? fields(field.fields) : [field]))
  const payload = {
    collections: Object.fromEntries(
      configurations.map((config) => [
        config.slug,
        {
          config: {
            ...config,
            flattenedFields: [
              ...fields(config.fields),
              ...[
                'id',
                'createdAt',
                'updatedAt',
                ...(config.slug === 'media' ? ['mimeType', 'filesize', 'width', 'height'] : []),
              ].map((name) => ({ name, type: 'text' })),
            ],
          },
        },
      ]),
    ),
    db: {
      name: 'sqlite',
      client: { transaction: noIO },
      schema: {},
      sessions: {},
      initializing: Promise.resolve(),
      autoIncrement: true,
      idType: 'number',
      clientConfig: { url: 'file:/unused/runtime-binding.sqlite' },
    },
  }
  return {
    payload,
    gate,
    config,
    clock: () => '2026-11-16T00:00:00.000Z',
  }
}

test('separately loaded server modules read the same runtime on the same Payload instance', async () => {
  const another = await import('../src/creation/runtime/services.ts?separate-admin-module')
  assert.notEqual(another.getCoreRuntime, original.getCoreRuntime)
  assert.equal(another.runtimeWriteChecks, original.runtimeWriteChecks)
  const args = await fixture()
  const runtime = await original.registerCoreRuntime(args)
  try {
    assert.equal(another.getCoreRuntime({ payload: args.payload }), runtime)
    await assert.rejects(another.registerCoreRuntime(args), /already registered/)
    const separate = await fixture()
    assert.throws(() => another.getCoreRuntime({ payload: separate.payload }), /not registered/)
    assert.equal(Object.keys(args.payload).length, 2)
    assert.equal(JSON.stringify(args.payload).includes('admission'), false)
  } finally {
    await runtime.close()
  }
})

test('an unconfigured image model rejects quotes before database, Redis or provider IO', async () => {
  const args = await fixture()
  args.config = { ...args.config, image: null }
  const runtime = await original.registerCoreRuntime(args)
  Object.defineProperty(args.payload.db, 'initializing', {
    get: () => assert.fail('Unconfigured model must not enter a database snapshot'),
  })
  try {
    await assert.rejects(
      runtime.admission.quoteGenerate({
        userId: 1,
        sessionId: 1,
        input: { inputMediaIds: [], description: 'A quiet landscape', userNotes: '' },
      }),
      { code: 'GENERATION_NOT_CONFIGURED' },
    )
  } finally {
    await runtime.close()
  }
})

test('reloaded collection hooks use the existing Payload runtime gate, not the new config gate', async () => {
  const args = await fixture()
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'heymoro-hook-config-'))
  const mode = process.env.NODE_ENV
  let initial
  let replacement
  try {
    process.env.NODE_ENV = 'test'
    const dataDir = path.join(directory, 'data')
    const rootArgs = {
      config: { ...args.config, dataDir },
      initialization: prepareTarget({ dataDir }),
    }
    initial = await buildCorePayloadConfig(rootArgs)
    replacement = await buildCorePayloadConfig(rootArgs)
  } finally {
    if (mode === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = mode
    rmSync(directory, { recursive: true, force: true })
  }
  const replaceHooks = (config) => {
    for (const collection of config.collections) {
      if (args.payload.collections[collection.slug]) {
        args.payload.collections[collection.slug].config.hooks = collection.hooks
      }
    }
  }
  replaceHooks(initial)
  const runtimeGate = {
    ...args.gate,
    beforeOperation: initial.collections.find((collection) => collection.slug === 'users').hooks
      .beforeOperation[0],
  }
  const runtime = await original.registerCoreRuntime({ ...args, gate: runtimeGate })
  replaceHooks(replacement)
  const transaction = {}
  const transactionID = 'owned-transaction'
  const sessions = { [transactionID]: { db: transaction } }
  const req = { payload: args.payload, transactionID }
  const binding = args.gate.bind({
    req,
    sessions,
    transaction,
    transactionID,
    assertLease: () => {},
  })
  try {
    assert.doesNotThrow(() => createCreationRuntime({ payload: args.payload, gate: runtimeGate }))
    for (const slug of ['users', 'creation-drafts', 'media', 'auditLogs']) {
      const hook = replacement.collections.find((collection) => collection.slug === slug).hooks
        .beforeOperation[0]
      const operation = { args: {}, operation: 'create', req }
      assert.equal(await hook(operation), operation.args)
      assert.throws(
        () => hook({ ...operation, req: { payload: args.payload, context: { trusted: true } } }),
        /capability/,
      )
      assert.throws(() => hook({ ...operation, req: { ...req } }), /capability/)
      assert.throws(() => hook({ ...operation, req: { payload: {} } }), /not registered/)
      assert.equal(
        await hook({ ...operation, operation: 'read', req: { payload: {} } }),
        operation.args,
      )
      assert.throws(
        () => hook({ ...operation, operation: 'delete', req: { payload: {} } }),
        /Physical creation deletion/,
      )
      const foreign = createCreationWriteGate()
      const foreignReq = { payload: args.payload, transactionID }
      const foreignBinding = foreign.bind({
        req: foreignReq,
        sessions,
        transaction,
        transactionID,
        assertLease: () => {},
      })
      try {
        assert.throws(() => hook({ ...operation, req: foreignReq }), /capability/)
      } finally {
        foreignBinding.close()
      }
    }
    binding.seal()
    assert.throws(() => original.runtimeWriteChecks.assert({ req }), /sealed/)
    binding.close()
    const hook = replacement.collections.find((collection) => collection.slug === 'users').hooks
      .beforeOperation[0]
    assert.throws(() => hook({ args: {}, operation: 'create', req }), /capability/)
  } finally {
    binding.close()
    await runtime.close()
  }
})
