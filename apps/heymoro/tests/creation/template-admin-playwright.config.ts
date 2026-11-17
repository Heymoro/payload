import { defineConfig } from '@playwright/test'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { readApproval } from './template-admin-approval.js'

const approval = readApproval()
const marker = path.join(approval.runDirectory, 'root-approval-reservation.json')
const binding = JSON.stringify({
  runId: approval.runId,
  sourceManifestSHA: approval.sourceManifestSHA,
})
if (!existsSync(approval.runDirectory)) {
  mkdirSync(approval.runDirectory, { mode: 0o700 })
  writeFileSync(marker, binding, { flag: 'wx', mode: 0o600 })
} else {
  const info = lstatSync(approval.runDirectory)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid!() ||
    readFileSync(marker, 'utf8') !== binding
  ) {
    throw Error('Existing output is not this root-approved private reservation.')
  }
}
export default defineConfig({
  expect: { timeout: 10000 },
  forbidOnly: true,
  fullyParallel: false,
  grep: new RegExp(`@case:(?:${approval.scenarios.join('|')})(?:\\s|$)`),
  outputDir: path.join(approval.runDirectory, 'playwright'),
  reporter: [['line']],
  retries: 0,
  testDir: '.',
  testMatch: ['template-admin-form.e2e.spec.ts', 'template-admin-exceptions.e2e.spec.ts'],
  timeout: approval.budget.durationMs,
  use: {
    launchOptions: { executablePath: approval.browser },
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  workers: 1,
})
