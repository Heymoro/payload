import { expect } from 'vitest'

import { test } from '../../../../test/__helpers/int/vitest.js'
import { getCoreRuntime } from '../../src/creation/runtime/services.js'
import { cleanupRuntime, config, gate, state } from './runtime.config.js'
import { controlledWrite, seedChain } from './runtime-seed.js'

test.suite(
  'Existing session sharing through actual Native HTTP',
  { config: './runtime.config.ts', cron: false },
  () => {
    test.afterAll(cleanupRuntime)
    test('uses Native admin cookie to publish existing generated results, associates template, and revokes JSON command', async ({
      payload,
      restClient,
    }) => {
      const f = await seedChain({ config, gate, payload })
      const runtime = getCoreRuntime({ payload })
      const session = (
        await runtime.session({
          command: { clientRequestId: 'share-http-session', templateId: f.templateId },
          userId: f.userId,
        })
      ).session
      const input = { description: 'PRIVATE human input', inputMediaIds: [], userNotes: '' }
      const quote = await runtime.admission.quoteGenerate({
        input,
        sessionId: session.id,
        userId: f.userId,
      })
      const task = await runtime.admission.submitGenerate({
        clientRequestId: 'share-http-generation',
        input,
        quoteToken: quote.quoteToken,
        sessionId: session.id,
        userId: f.userId,
      })
      state.kind = 'output'
      await runtime.worker.run({ taskId: task.task.id })
      const artifact = (await runtime.library.list({ query: {}, userId: f.userId })).items[0]!
      const login = await restClient.POST('/admins/login', {
        auth: false,
        body: JSON.stringify({
          email: `fixture-${f.userId}@local.invalid`,
          password: 'fixture-local-password-137',
        }),
        headers: { origin: config.publicApiUrl },
      })
      expect(login.status).toBe(200)
      const headers = {
        cookie: login.headers.get('set-cookie')!.split(';')[0]!,
        origin: config.publicApiUrl,
      }
      const path = `/v1/admin/session-shares/${session.id}`
      const command = { artifactIds: [artifact.id], confirmed: true, title: '公开会话' }
      expect(
        (await restClient.POST(path, { auth: false, body: JSON.stringify(command) })).status,
      ).toBe(401)
      expect(
        (
          await restClient.POST(path, {
            auth: false,
            body: JSON.stringify(command),
            headers: { ...headers, origin: 'https://evil.invalid' },
          })
        ).status,
      ).toBe(401)
      expect(
        (
          await restClient.POST(path, {
            auth: false,
            body: JSON.stringify(command),
            headers: { ...headers, authorization: `Bearer ${f.token}` },
          })
        ).status,
      ).toBe(403)
      const response = await restClient.POST(path, {
        auth: false,
        body: JSON.stringify(command),
        headers,
      })
      expect(response.status).toBe(200)
      const share = (await response.json()).data
      const publicPath = `/v1/session-shares/${share.key}`
      const view = await restClient.GET(publicPath, { auth: false })
      expect(view.status).toBe(200)
      expect(JSON.stringify(await view.json())).not.toMatch(
        /PRIVATE|userId|inputMediaIds|mediaId|systemPrompt|storage/,
      )
      for (const imagePath of [`${publicPath}/cover`, `${publicPath}/images/${artifact.id}`]) {
        const image = await restClient.GET(imagePath, { auth: false })
        expect(image.status).toBe(200)
        expect(image.headers.get('cache-control')).toContain('no-store')
        expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0)
      }
      expect(
        (await restClient.GET(`${path}/images/${artifact.id}`, { auth: false, headers })).status,
      ).toBe(200)
      const current = await runtime.templates.get({ adminId: f.adminId, templateId: f.templateId })
      const {
        id: _id,
        name: _name,
        code: _code,
        isDeleted: _deleted,
        kind: _kind,
        status: _status,
        ...body
      } = current
      await runtime.templates.save({
        adminId: f.adminId,
        configuration: {
          ...body,
          displayConfigJson: JSON.stringify({
            name: 'Runtime free',
            showcaseShareKeys: [share.key],
          }),
        },
        templateId: f.templateId,
      })
      expect((await runtime.catalog.getFreePreset()).displayConfig.showcaseShareKeys).toEqual([
        share.key,
      ])
      const revoke = await restClient.POST(`${path}/revoke`, { auth: false, body: '{}', headers })
      expect(revoke.status).toBe(200)
      expect((await restClient.GET(publicPath, { auth: false })).status).toBe(404)
      expect((await restClient.GET(`${publicPath}/cover`, { auth: false })).status).toBe(404)
      expect((await runtime.catalog.getFreePreset()).displayConfig.showcaseShareKeys).toEqual([])
      const again = await restClient.POST(path, {
        auth: false,
        body: JSON.stringify(command),
        headers,
      })
      expect(again.status).toBe(200)
      expect((await again.json()).data.key).not.toBe(share.key)
      await controlledWrite({
        gate,
        payload,
        work: ({ req }) =>
          gate.run({
            req,
            work: () =>
              payload.create({
                collection: 'admins',
                data: {
                  email: 'remaining@fixture.invalid',
                  password: 'fixture-remaining-password-137',
                  role: 'admin',
                  status: 'active',
                },
                overrideAccess: true,
                req,
              }),
          }),
      })
      await controlledWrite({
        gate,
        payload,
        work: ({ req }) =>
          gate.run({
            req,
            work: () =>
              payload.update({
                id: f.adminId,
                collection: 'admins',
                data: { role: 'operator' } as never,
                overrideAccess: true,
                req,
              }),
          }),
      })
      expect(
        (await restClient.GET('/v1/admin/session-shares', { auth: false, headers })).status,
      ).toBe(403)
      expect(
        (await restClient.POST(`${path}/revoke`, { auth: false, body: '{}', headers })).status,
      ).toBe(403)
    })
  },
)
