import type { Payload } from 'payload'

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { expect } from 'vitest'

import type { NamingEngine } from '../../src/creation/application/session-naming-types.js'

import { createNamingEngine } from '../../src/creation/infrastructure/ai/naming-engine.js'
import { createPayloadSessionNaming } from '../../src/creation/infrastructure/payload/session-naming-repository.js'
import { createPayloadSessionTitleService } from '../../src/creation/infrastructure/payload/session-title-repository.js'
import { createRedisCreationCoordinator } from '../../src/creation/infrastructure/redis/coordinator.js'
import { close, sqlRows, workerFixture } from './generation-worker-fixture.js'
import { gate, registerNamingFixture } from './sqlite.config.js'

export async function namingFixture({
  deliver = true,
  payload,
}: {
  deliver?: boolean
  payload: Payload
}) {
  const f = await workerFixture({ payload })
  if (deliver) {
    await f.running.run({ taskId: f.taskId })
  }
  const state = {
    calls: 0,
    engine: (async () => ({
      name: 'Green horizon',
      kind: 'name',
      requestId: 'fixture-name',
    })) as NamingEngine,
  }
  const namespace = `name-${randomUUID()}`
  const coordinator = createRedisCreationCoordinator({
    client: f.redis.client,
    config: {
      acquireTimeoutMs: 5000,
      commandTimeoutMs: 500,
      leaseMs: 3000,
      maxHoldMs: 15000,
      namespace,
      renewEveryMs: 500,
      retryDelayMs: 5,
    },
  })
  const options = {
    gate,
    payload,
    ...coordinator,
    clock: () => f.state.now,
    retry: { backoffMs: 1, maxAttempts: 3 },
  }
  const assertOutside = async () => {
    expect(Object.keys(f.adapter.sessions)).toHaveLength(0)
    expect(await f.redis.client.keys('*')).toHaveLength(0)
  }
  const worker = (overrides: Partial<Parameters<typeof createPayloadSessionNaming>[0]> = {}) =>
    createPayloadSessionNaming({
      ...options,
      engine: async (args) => {
        await assertOutside()
        state.calls++
        return state.engine(args)
      },
      engineTimeoutMs: 1000,
      leaseMs: 2000,
      storage: {
        ...f.storage,
        getVerified: async (args) => {
          await assertOutside()
          return f.storage.getVerified(args)
        },
      },
      ...overrides,
    })
  const running = worker()
  const unregister = registerNamingFixture({ payload, run: running.run })
  close.push(async () => {
    unregister()
  })
  const rename = createPayloadSessionTitleService(options)
  return {
    ...f,
    assertNamingOutside: assertOutside,
    nameState: state,
    nameWorker: worker,
    naming: running,
    namingOptions: options,
    rename,
  }
}
export async function sessionRow(f: Awaited<ReturnType<typeof namingFixture>>) {
  return (await sqlRows(f, 'creation_sessions')).find((row) => row.id === f.sessionId)!
}
export async function financialGraph(f: Awaited<ReturnType<typeof namingFixture>>) {
  const tables = [
    'generation_tasks',
    'generation_attempts',
    'generation_inputs',
    'artifacts',
    'media',
    'credit_accounts',
    'credit_reservations',
    'credit_allocations',
    'credit_grants',
    'credit_ledger',
  ]
  return Object.fromEntries(
    await Promise.all(tables.map(async (table) => [table, await sqlRows(f, table)])),
  )
}
export async function namingHTTP({
  mode = 'success',
  observe,
}: {
  mode?: 'bad-json' | 'disconnect' | 'success' | 'timeout'
  observe?: () => Promise<void>
} = {}) {
  const requests: { body: Record<string, unknown>; path: string }[] = []
  const server = createServer(async (req, res) => {
    await observe?.()
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk))
    }
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()), path: req.url ?? '' })
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'fixture-name-http' })
    if (mode === 'success') {
      res.end(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', annotations: [], text: '{"name":"SDK green horizon"}' },
              ],
              role: 'assistant',
              status: 'completed',
            },
          ],
          status: 'completed',
        }),
      )
    } else {
      res.write('{')
      if (mode === 'bad-json') {
        res.end()
      }
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
    expect(String(url)).toBe('https://api.openai.com/v1/responses')
    expect(init?.redirect).toBe('error')
    return globalThis.fetch(String(url).replace('https://api.openai.com', origin), init)
  }
  const options = {
    apiKey: 'fixture-naming-fake-key',
    engineBudgetMs: 1000,
    fetch,
    registered: {
      model: 'explicit-fixture-naming-model',
      parameters: { max_output_tokens: 128 },
      provider: 'openai' as const,
    },
    timeoutMs: mode === 'timeout' ? 70 : 1000,
  }
  return { engine: createNamingEngine(options), options, requests }
}
