import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(tmpdir(), 'heymoro-reconciliation-command-')),
)
test.after(() => fs.rmSync(directory, { recursive: true, force: true }))
const command = {
  action: 'close-undelivered',
  authorization: 'JWT a.b.c',
  taskId: 1,
  attemptId: 2,
  operationId: 'close.1',
  confirmedUndelivered: true,
}
const load = () => import('../scripts/generation-reconciliation.mjs')
async function fixture() {
  const { hostConfig } = await import('./creation/runtime-seed.ts')
  const configFile = path.join(directory, 'core.json')
  const commandFile = path.join(directory, 'command.json')
  fs.writeFileSync(
    configFile,
    JSON.stringify(hostConfig({ dataDir: path.join(directory, 'target') })),
  )
  fs.writeFileSync(commandFile, JSON.stringify(command))
  const calls = []
  const ports = {
    build: async () => ({}),
    open: async ({ config }) => {
      assert.deepEqual(config.logger, { options: { level: 'silent' } })
      return {}
    },
    client: () => ({
      close: () => {
        calls.push('client')
      },
    }),
    destroy: async () => {
      calls.push('destroy')
    },
    runtime: () => ({
      close: async () => {
        calls.push('runtime')
      },
      reconciliation: {
        execute: async ({ input, requestId }) => {
          assert.deepEqual(input, command)
          assert.ok(Object.isFrozen(input))
          calls.push('execute')
          return {
            requestId,
            action: input.action,
            outcome: 'confirmed',
            taskId: 1,
            attemptId: 2,
            taskStatus: 'closed',
            result: 'closed',
            originalOperationId: 'close.1',
            releasedCredits: 2,
            expiredCredits: 0,
          }
        },
      },
    }),
  }
  return { calls, ports, argv: ['--config', configFile, '--command', commandFile], commandFile }
}
test('CLI rejects argv and private JSON failures before starting any target', async () => {
  const { runGenerationReconciliation } = await load()
  for (const argv of [
    [],
    ['--config', '/ABS.json', '--token', 'JWT a.b.c'],
    ['--config', 'relative.json', '--command', '/ABS.json'],
  ]) {
    const result = await runGenerationReconciliation({
      argv,
      ports: { build: async () => assert.fail('must not build') },
    })
    assert.equal(result.outcome, 'not_started')
    assert.equal(result.exitCode, 1)
    assert.doesNotMatch(JSON.stringify(result), /JWT|ABS.json|relative.json|Error:/)
  }
})
test('CLI uses formal service and cleans runtime Payload client independently, preserving confirmed cleanup', async () => {
  const { runGenerationReconciliation } = await load()
  const f = await fixture()
  const runtime = f.ports.runtime
  f.ports.runtime = () => ({
    ...runtime(),
    close: async () => {
      f.calls.push('runtime')
      throw Error('PRIVATE_SECRET')
    },
  })
  f.ports.destroy = async () => {
    f.calls.push('destroy')
    throw Error('PRIVATE_PATH')
  }
  const result = await runGenerationReconciliation(f)
  assert.equal(result.result, 'closed')
  assert.equal(result.outcome, 'confirmed')
  assert.equal(result.cleanupCode, 'RECONCILIATION_CLEANUP_FAILED')
  assert.equal(result.exitCode, 1)
  assert.deepEqual(f.calls, ['execute', 'runtime', 'destroy', 'client'])
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|JWT|bucket|prompt|Authorization/)
})
test('CLI treats unexpected execute errors as unknown, never startup failure or replay', async () => {
  const { runGenerationReconciliation } = await load()
  const f = await fixture()
  const runtime = f.ports.runtime
  f.ports.runtime = () => ({
    ...runtime(),
    reconciliation: {
      execute: async () => {
        f.calls.push('execute')
        throw Error('PRIVATE_EXECUTION')
      },
    },
  })
  const result = await runGenerationReconciliation(f)
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.code, 'RECONCILIATION_OUTCOME_UNKNOWN')
  assert.equal(f.calls.filter((x) => x === 'execute').length, 1)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_EXECUTION/)
})
test('CLI preserves typed unknown and owns partial initialized resources', async () => {
  const { runGenerationReconciliation } = await load()
  const { GenerationReconciliationError } =
    await import('../src/creation/domain/generation-reconciliation.ts')
  const f = await fixture()
  const runtime = f.ports.runtime
  f.ports.runtime = () => ({
    ...runtime(),
    reconciliation: {
      execute: async () => {
        throw new GenerationReconciliationError({
          code: 'RECONCILIATION_OUTCOME_UNKNOWN',
          outcome: 'unknown',
        })
      },
    },
  })
  assert.equal((await runGenerationReconciliation(f)).outcome, 'unknown')
  f.calls.length = 0
  f.ports.build = async () => ({
    onInit: async () => {
      throw Error('PRIVATE_INIT')
    },
  })
  f.ports.open = async ({ config }) => {
    await config.onInit({})
    assert.fail('init must fail')
  }
  const result = await runGenerationReconciliation(f)
  assert.equal(result.outcome, 'not_started')
  assert.equal(result.code, 'RECONCILIATION_STARTUP_FAILED')
  assert.deepEqual(f.calls, ['runtime', 'destroy', 'client'])
})
