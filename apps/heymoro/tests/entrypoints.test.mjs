import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('should retire every historical package command', () => {
  const retiredCommands = [
    'setup:local',
    'test:creation-http',
    'test:admin-http',
    'test:http',
    'test:mvp-http',
    'test:unified-spike',
    'dev:creation-fixture',
  ]

  for (const command of retiredCommands) {
    assert.equal(Object.hasOwn(scripts, command), false, `${command} must remain retired`)
  }
})

test('should keep historical script paths out of every remaining package command', () => {
  const retiredPaths = [
    'scripts/setup-local.mjs',
    'tests/creation-http.mjs',
    'tests/admin-http.mjs',
    'tests/http-smoke.mjs',
    'tests/mvp-http.mjs',
    'tests/unified-account/run.mjs',
    'tests/creation-fixture-server.mjs',
  ]

  for (const [command, source] of Object.entries(scripts)) {
    for (const retiredPath of retiredPaths) {
      assert.equal(source.includes(retiredPath), false, `${command} must not invoke ${retiredPath}`)
    }
  }
})

test('should preserve formal commands and the complete unit test glob', () => {
  const formalCommands = {
    'admin:command': 'node --import tsx scripts/admin-commands.mjs',
    'core:init': 'node --import tsx scripts/init-target.mjs',
    'jobs:creation': 'node --import tsx scripts/jobs-creation.mjs',
    test: 'node --import tsx --test tests/*.test.mjs',
  }

  for (const [command, source] of Object.entries(formalCommands)) {
    assert.equal(scripts[command], source, `${command} must preserve its formal entrypoint`)
  }
})
