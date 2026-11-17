import { createServer } from 'node:http'
import { expect } from 'vitest'

import type { GenerationEngine } from '../../src/creation/application/generation-worker.js'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { createImageEngine } from '../../src/creation/infrastructure/ai/image-engine.js'
import { execution } from './generation-fixture.js'
import { close, image, sqlRows, workerFixture } from './generation-worker-fixture.js'
import { cleanupSQLiteFixture } from './sqlite.config.js'

const registered = [
  { executorId: 'fixture-v1', model: 'gpt-image-1.5', provider: 'openai' },
] as const
const configuration = {
  ...execution,
  registry: {
    'fixture-v1': {
      ...execution.registry['fixture-v1'],
      model: 'gpt-image-1.5',
      provider: 'openai',
    },
  },
}
async function httpFixture({
  mode,
  observe,
}: {
  mode: 'disconnect' | 'success' | 'timeout'
  observe?: () => Promise<void>
}) {
  const output = await image('green')
  const requests: { body: Buffer; path: string }[] = []
  const server = createServer(async (req, res) => {
    await observe?.()
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk))
    }
    requests.push({ body: Buffer.concat(chunks), path: req.url ?? '' })
    res.setHeader('content-type', 'application/json')
    res.setHeader('x-request-id', 'sdk-fixture-output')
    if (mode === 'success') {
      res.end(JSON.stringify({ data: [{ b64_json: output.toString('base64') }] }))
    } else {
      res.write('{')
      if (mode === 'disconnect') {
        setImmediate(() => res.destroy())
      }
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing fixture address')
  }
  const origin = `http://127.0.0.1:${address.port}`
  close.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  )
  const fetch: typeof globalThis.fetch = (url, init) => {
    expect(String(url)).toMatch(/^https:\/\/api\.openai\.com\/v1\/images\/(generations|edits)$/)
    expect(init?.redirect).toBe('error')
    return globalThis.fetch(String(url).replace('https://api.openai.com', origin), init)
  }
  return { fetch, requests }
}
const options = {
  apiKey: 'fixture-only-fake-key',
  engineBudgetMs: 180_000,
  registered,
  timeoutMs: 1000,
}
const args = (): Parameters<GenerationEngine>[0] => ({
  executionPlan: {
    executorId: 'fixture-v1',
    model: 'gpt-image-1.5',
    parameters: { size: '1024x1024' },
    provider: 'openai',
    systemPrompt: ' System \n',
  },
  images: [],
  input: { description: ' First \n second ', userNotes: ' notes\n\n ' },
  signal: new AbortController().signal,
})
test.suite(
  'Heymoro official image SDK host adapter',
  { config: './sqlite.config.ts', cron: false },
  () => {
    test.afterEach(async () => {
      for (const work of close.splice(0).reverse()) {
        await work()
      }
    })
    test.afterAll(() => cleanupSQLiteFixture())
    test('composes the accepted versioned prompt preserving original text and maps JSON generation', async () => {
      const http = await httpFixture({ mode: 'success' })
      const result = await createImageEngine({ ...options, fetch: http.fetch })(args())
      expect(result.kind).toBe('output')
      const body = JSON.parse(http.requests[0]!.body.toString()) as { prompt: string }
      expect(body.prompt).toBe(
        '[System]\n System \n\n\n[Description]\n First \n second \n\n[User notes]\n notes\n\n ',
      )
      expect(http.requests).toHaveLength(1)
    })
    test('rejects unknown executor/provider/model/parameter or SDK budget exceeding engine before network', async () => {
      const http = await httpFixture({ mode: 'success' })
      for (const changes of [
        { executorId: 'unknown' },
        { provider: 'other' },
        { model: 'other' },
        { parameters: { n: 4 } },
      ]) {
        const input = args()
        input.executionPlan = { ...input.executionPlan, ...changes }
        expect((await createImageEngine({ ...options, fetch: http.fetch })(input)).kind).toBe(
          'not_sent',
        )
      }
      expect(
        (await createImageEngine({ ...options, fetch: http.fetch, timeoutMs: 180_001 })(args()))
          .kind,
      ).toBe('not_sent')
      expect(http.requests).toHaveLength(0)
    })
    test('rejects runtime unsupported provider and model even when the registry matches the accepted plan', async () => {
      const http = await httpFixture({ mode: 'success' })
      for (const unsupported of [
        { model: 'gpt-image-1.5', provider: 'other' },
        { model: 'other', provider: 'openai' },
        { model: 'other', provider: 'other' },
      ]) {
        const registered = [{ executorId: 'other-v1', ...unsupported }]
        const input = args()
        input.executionPlan = { ...input.executionPlan, ...registered[0]! }
        const engine = createImageEngine({
          ...options,
          fetch: http.fetch,
          registered,
        } as unknown as Parameters<typeof createImageEngine>[0])
        expect(await engine(input)).toEqual({ kind: 'not_sent', requestId: null })
      }
      expect(http.requests).toHaveLength(0)
    })
    for (const mode of ['success', 'disconnect', 'timeout'] as const) {
      test(`real worker SDK ${mode} settles without duplicate request or I/O locks`, async ({
        payload,
      }) => {
        const f = await workerFixture({ execution: configuration, payload })
        const http = await httpFixture({ mode, observe: f.assertOutside })
        const engine = createImageEngine({
          ...options,
          fetch: http.fetch,
          timeoutMs: mode === 'timeout' ? 70 : 1000,
        })
        const worker = f.worker({
          engine,
          engineTimeoutMs: 180_000,
          execution: configuration,
          leaseMs: 210_000,
        })
        expect(await worker.run({ taskId: f.taskId })).toBe(
          mode === 'success' ? 'succeeded' : 'unknown',
        )
        expect(http.requests).toHaveLength(1)
        expect(http.requests[0]?.path).toBe('/v1/images/edits')
        const body = http.requests[0]!.body
        expect(body.indexOf(f.bytes[0]!)).toBeGreaterThan(-1)
        expect(body.indexOf(f.bytes[1]!)).toBeGreaterThan(body.indexOf(f.bytes[0]!))
        expect((await sqlRows(f, 'generation_tasks'))[0]?.status).toBe(
          mode === 'success' ? 'succeeded' : 'unknown',
        )
        expect((await sqlRows(f, 'credit_reservations'))[0]?.status).toBe(
          mode === 'success' ? 'captured' : 'reserved',
        )
        expect(await sqlRows(f, 'artifacts')).toHaveLength(mode === 'success' ? 1 : 0)
        const ledger = await sqlRows(f, 'credit_ledger')
        expect(ledger.filter((row) => row.operation === 'capture')).toHaveLength(
          mode === 'success' ? 1 : 0,
        )
        expect(ledger.filter((row) => row.operation === 'release')).toHaveLength(0)
        f.state.now = '2026-11-12T13:00:00.000Z'
        await worker.run({ taskId: f.taskId })
        expect(http.requests).toHaveLength(1)
      })
    }
  },
)
