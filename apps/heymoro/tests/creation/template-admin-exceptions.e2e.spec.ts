import { expect } from '@playwright/test'
import sharp from 'sharp'

import { runAxeScan } from '../../../../test/__helpers/e2e/runAxeScan.js'
import {
  adminURL,
  confirmDialog,
  createDraft,
  inspectAndConfirm,
  login,
  loseOneACK,
  prepareDraft,
  retainInput,
  saveDraft,
  test,
} from './template-admin-browser.js'
import { exerciseRevokedAdmin, requireConfirmed } from './template-admin-run.js'

// Unknown Error / forged-code / actual DB commit-unknown have no formal Next injection port.
// OPEN_INTERFACE_GAP remains in the receipt; transport loss below is not their substitute.
test(
  'should deny an anonymous custom view without rendering management DTOs or Prompt fields',
  { tag: '@case:anonymous' },
  async ({ page, run }) => {
    await page.goto(adminURL({ run }))
    await expect(page.getByLabel('System Prompt')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '模板列表' })).toHaveCount(0)
    expect(await page.locator('.template-editor').count()).toBe(0)
  },
)

test(
  'should preserve a stale second tab and require a fresh explicit inspection for re-listing',
  { tag: '@case:concurrency' },
  async ({ context, images, page, run }) => {
    const { templateId } = await prepareDraft({ images, page, publish: true, run })
    const editorURL = adminURL({ run, templateId })
    await confirmDialog({
      button: page.getByRole('button', { name: '从此版创建新草稿', exact: true }),
      message: /保留原版，以当前内容创建新草稿/,
      page,
    })
    await page.getByLabel('公开名称', { exact: true }).fill('草稿基础')
    await saveDraft({ page })
    const second = await context.newPage()
    try {
      await second.goto(editorURL)
      await second.getByLabel('公开名称', { exact: true }).fill('第二页本地输入')
      await second
        .getByLabel('官方示例图片', { exact: true })
        .setInputFiles({ name: 'retained.png', buffer: images.small, mimeType: 'image/png' })
      const retained = await retainInput({ page: second })
      await page.getByLabel('公开名称', { exact: true }).fill('第一页已保存')
      await saveDraft({ page })
      await second.getByRole('button', { name: '保存草稿', exact: true }).click()
      await expect(second.getByRole('status')).toContainText('服务器事实已变化')
      await expect(second.getByLabel('公开名称', { exact: true })).toHaveValue('第二页本地输入')
      expect(await retainInput({ page: second })).toEqual(retained)
      await confirmDialog({
        button: page.getByRole('button', { name: '下架模板', exact: true }),
        message: /确认下架当前模板/,
        page,
      })
      await expect(page.getByRole('region', { name: '模板编辑' })).toContainText('offline')
      const catalog = await page.request.get(`${run.baseURL}${run.apiRoute}/v1/templates`)
      expect(JSON.stringify(await catalog.json())).not.toContain('异常流程已保存名称')
      const firstVersion = await page
        .getByLabel('版本', { exact: true })
        .locator('option')
        .filter({ hasText: /v1 — published/ })
        .getAttribute('value')
      await page.getByLabel('版本', { exact: true }).selectOption(firstVersion!)
      await inspectAndConfirm({ isRelist: true, page })
      await expect(page.getByRole('region', { name: '模板编辑' })).toContainText('published')
    } finally {
      await second.close()
    }
  },
)

test(
  'should fail true Catalog and Generation class gates after the same Next RSC Action REST Action chain',
  { tag: '@case:generation' },
  async ({ images, page, run }) => {
    const { code, templateId, versionId } = await prepareDraft({ images, page, run })
    // Complete chain already ran; an incomplete stored display body is legal draft data but not publishable.
    const [stored] = run.readTemplate({ code })
    const display = JSON.parse(String(stored!.display_config_json)) as Record<string, unknown>
    const before = run.corruptVersion({
      column: 'display_config_json',
      raw: JSON.stringify({ ...display, coverMediaId: null }),
      templateId,
      versionId,
    })
    await page.goto(adminURL({ run, templateId }))
    await page.getByRole('button', { name: '检查已保存版本', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('请修复展示或输入组后再检查')
    run.corruptVersion({ column: 'display_config_json', raw: before.before, templateId, versionId })
    const generation = JSON.parse(String(stored!.generation_config_json)) as Record<string, unknown>
    run.corruptVersion({
      column: 'generation_config_json',
      raw: JSON.stringify({ ...generation, executorId: 'unregistered-fixture' }),
      templateId,
      versionId,
    })
    await page.goto(adminURL({ run, templateId }))
    await expect(page.getByRole('heading', { name: 'generation 需要修复' })).toBeVisible()
    await page.getByRole('button', { name: '检查已保存版本', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('当前执行器／生成配置不可用')
    // A generic 503, missing registry or different Error class is a hard assertion failure, not a retry.
    await expect(page.getByRole('status')).not.toContainText('服务暂不可用')
  },
)

test(
  'should save incomplete current-schema input and preserve its real Catalog rejection',
  { tag: '@case:catalog' },
  async ({ page, run }) => {
    await login({ page, run })
    await createDraft({ page, run })
    await page.getByLabel('公开名称', { exact: true }).fill('可保存未完成稿')
    await page.getByLabel('最少图片数', { exact: true }).fill('0')
    await page.getByLabel('image/png', { exact: true }).uncheck()
    await saveDraft({ page })
    await page.getByRole('button', { name: '检查已保存版本', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('请修复展示或输入组后再检查')
    await expect(page.getByLabel('公开名称', { exact: true })).toHaveValue('可保存未完成稿')
    await expect(page.getByLabel('image/png', { exact: true })).not.toBeChecked()
    await expect(page.getByLabel('最少图片数', { exact: true })).toHaveValue('0')
  },
)

test(
  'should preserve broken and unknown raw groups until an explicit new-draft rebuild',
  { tag: '@case:corruption' },
  async ({ images, page, run }) => {
    const { templateId, versionId } = await prepareDraft({ images, page, run })
    for (const [column, raw, group] of [
      ['display_config_json', '{"unknownFixtureField":true}', 'display'],
      ['input_schema_json', '{broken-json', 'input'],
      [
        'generation_config_json',
        '{"executorId":"old-executor","parameters":{},"systemPrompt":"preserved"}',
        'generation',
      ],
      ['share_config_json', '{"unknownShare":true}', 'share'],
    ] as const) {
      run.corruptVersion({ column, raw, templateId, versionId })
      await page.goto(adminURL({ run, templateId }))
      const heading = page.getByRole('heading', { name: `${group} 需要修复`, exact: true })
      await expect(heading).toBeVisible()
      await expect(heading.locator('..').locator('pre')).toHaveText(raw)
      await expect(
        heading.locator('..').getByRole('button', { name: '明确重建此组' }),
      ).toBeDisabled()
    }
    await confirmDialog({
      button: page.getByRole('button', { name: '从此版创建新草稿', exact: true }),
      message: /保留原版/,
      page,
    })
    const rebuildButtons = page.getByRole('button', { name: '明确重建此组', exact: true })
    const groups = ['display', 'input', 'generation', 'share'] as const
    for (const [index, group] of groups.entries()) {
      await expect(rebuildButtons).toHaveCount(groups.length - index)
      const heading = page.getByRole('heading', { name: `${group} 需要修复`, exact: true })
      await expect(heading).toBeVisible()
      await confirmDialog({
        button: heading.locator('..').getByRole('button', { name: '明确重建此组', exact: true }),
        message: new RegExp(`仅重建新草稿的${group}组`),
        page,
      })
      await expect(heading).toHaveCount(0)
    }
    await expect(rebuildButtons).toHaveCount(0)
    await page.getByLabel('公开名称', { exact: true }).fill('明确重建新稿')
    await saveDraft({ page })
  },
)

test(
  'should reauthenticate A only after a confirmed independent active admin B disables A',
  { tag: '@case:auth' },
  async ({ browser, images, page, run }) => {
    const { auth, templateId } = await prepareDraft({ images, page, run })
    await page.getByLabel('公开名称', { exact: true }).fill('鉴权失效待保存')
    const retained = await retainInput({ page })
    const guardContext = await browser.newContext()
    let guardToken = ''
    try {
      await exerciseRevokedAdmin({
        ports: {
          createB: ({ token }) =>
            run.command({
              input: {
                action: 'create',
                authorization: `JWT ${token}`,
                ...run.guard,
                role: 'admin',
              },
            }),
          disableA: ({ id, token }) =>
            run.command({
              input: {
                id,
                action: 'update',
                authorization: `JWT ${token}`,
                changes: { status: 'disabled' },
              },
            }),
          exerciseA: async () => {
            // Keep A's original cookie. Logging A in again after disable would not test Action reauthentication.
            await page.getByRole('button', { name: '保存草稿', exact: true }).click()
            await expect(page.getByRole('status')).toContainText('登录已失效，输入仍保留')
            expect(await retainInput({ page })).toEqual(retained)
          },
          loginA: () => Promise.resolve(auth),
          loginB: async () => {
            const b = await login({
              credentials: run.guard,
              page: await guardContext.newPage(),
              run,
            })
            guardToken = b.token
            return b
          },
          restoreA: ({ id, token }) =>
            run.command({
              input: {
                id,
                action: 'update',
                authorization: `JWT ${token}`,
                changes: { status: 'active' },
              },
            }),
        },
      })
      requireConfirmed({
        result: await run.command({
          input: {
            id: auth.id,
            action: 'update',
            authorization: `JWT ${guardToken}`,
            changes: { role: 'operator' },
          },
        }),
      })
      await login({ page, run })
      await page.goto(adminURL({ run, templateId }))
      await page.getByLabel('公开名称', { exact: true }).fill('operator仍可管理')
      await saveDraft({ page })
    } finally {
      await guardContext.close()
    }
  },
)

test(
  'should distinguish Redis write coordination failure from healthy SQLite reads',
  { tag: '@case:redis' },
  async ({ images, page, run }) => {
    await prepareDraft({ images, page, run })
    await page.getByLabel('公开名称', { exact: true }).fill('Redis写故障本地值')
    const retained = await retainInput({ page })
    await run.stopRedis()
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('服务暂不可用，输入仍保留')
    expect(await retainInput({ page })).toEqual(retained)
    await page.getByRole('button', { name: '只读核对服务器（保留本地输入）', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('已读取服务器快照')
    expect(await retainInput({ page })).toEqual(retained)
    await page.getByLabel('搜索内部名称或代码', { exact: true }).fill(`form-${run.runId}`)
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(
      page.getByRole('button', { name: `实际表单内部名称（form-${run.runId}）`, exact: true }),
    ).toBeVisible()
  },
)

test(
  'should discard one real write ACK without automatic replay or losing local inputs',
  { tag: '@case:write-ack' },
  async ({ images, page, run }) => {
    const { code } = await prepareDraft({ images, page, run })
    await page.getByLabel('公开名称', { exact: true }).fill('真实ACK丢失本地值')
    await page
      .getByLabel('官方示例图片', { exact: true })
      .setInputFiles({ name: 'retained.png', buffer: images.small, mimeType: 'image/png' })
    const retained = await retainInput({ page })
    const hook = await loseOneACK({ page })
    try {
      await page.getByRole('button', { name: '保存草稿', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('未收到写入确认，结果未知')
      await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled()
      expect(await retainInput({ page })).toEqual(retained)
      expect(hook.counts()).toEqual({ calls: 1, delivered: 1 })
      const [stored] = run.readTemplate({ code })
      expect(String(stored!.display_config_json)).toContain('真实ACK丢失本地值')
    } finally {
      await hook.close()
    }
  },
)

test(
  'should discard one real upload ACK and preserve the selected File without auto-upload',
  { tag: '@case:upload-ack' },
  async ({ images, page, run }) => {
    await login({ page, run })
    await createDraft({ page, run })
    await page.getByLabel('公开名称', { exact: true }).fill('上传未知仍保留')
    await page
      .getByLabel('官方示例图片', { exact: true })
      .setInputFiles({ name: 'retained.png', buffer: images.large, mimeType: 'image/png' })
    const retained = await retainInput({ page })
    const hook = await loseOneACK({ page, upload: true })
    try {
      await page.getByRole('button', { name: '上传并关联图片', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('服务器可能已存图，但未取得确认ID')
      expect(await retainInput({ page })).toEqual(retained)
      expect(hook.counts()).toEqual({ calls: 1, delivered: 1 })
      expect(
        run.observer.events.some(
          (event) =>
            event.method === 'PUT' && event.requestBytes === images.large.length && event.completed,
        ),
      ).toBe(true)
    } finally {
      await hook.close()
    }
  },
)

test(
  'should classify one real read transport abort separately from unknown writes',
  { tag: '@case:read-abort' },
  async ({ images, page, run }) => {
    await prepareDraft({ images, page, run })
    await page.getByLabel('公开名称', { exact: true }).fill('读取故障本地值')
    const retained = await retainInput({ page })
    let calls = 0
    const pattern = new URL(page.url()).origin + '/**'
    await page.route(pattern, async (route) => {
      if (
        route.request().method() === 'POST' &&
        route.request().headers()['next-action'] &&
        calls++ === 0
      ) {
        await route.abort('failed')
      } else {
        await route.continue()
      }
    })
    await page.getByRole('button', { name: '只读核对服务器（保留本地输入）', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('读取未完成，当前输入已保留。')
    expect(await retainInput({ page })).toEqual(retained)
    expect(calls).toBe(1)
    await page.unroute(pattern)
  },
)

test(
  'should reject Origin mismatch and forged unknown Action fields without writes',
  { tag: '@case:origin' },
  async ({ images, page, run }) => {
    const { code } = await prepareDraft({ images, page, run })
    const before = run.readTemplate({ code })
    for (const fault of ['origin', 'unknown-field'] as const) {
      await page.getByLabel('公开名称', { exact: true }).fill(`边界-${fault}`)
      const retained = await retainInput({ page })
      let calls = 0
      const pattern = new URL(page.url()).origin + '/**'
      await page.route(pattern, async (route) => {
        const request = route.request()
        if (request.method() !== 'POST' || !request.headers()['next-action']) {
          await route.continue()
          return
        }
        calls++
        expect(calls).toBe(1)
        if (fault === 'origin') {
          await route.continue({ headers: { ...request.headers(), origin: 'http://127.0.0.1:1' } })
        } else {
          const text = request.postData()!
          expect(Buffer.byteLength(text)).toBeLessThan(65536)
          const body = JSON.parse(text) as string[]
          expect(typeof body[0]).toBe('string')
          const input = JSON.parse(body[0]!) as Record<string, unknown>
          expect(input).toHaveProperty('templateId')
          input.unrecognizedFixtureField = true
          body[0] = JSON.stringify(input)
          await route.continue({ postData: JSON.stringify(body) })
        }
      })
      await page.getByRole('button', { name: '保存草稿', exact: true }).click()
      await expect(page.getByRole('status')).toContainText(
        fault === 'origin' ? '结果未知' : '输入格式有误',
      )
      expect(await retainInput({ page })).toEqual(retained)
      expect(run.readTemplate({ code })).toEqual(before)
      expect(calls).toBe(1)
      await page.unroute(pattern)
      if (fault === 'origin') {
        await confirmDialog({
          button: page.getByRole('button', { name: '重新载入服务器版本', exact: true }),
          message: /丢弃本地输入/,
          page,
        })
        await expect(page.getByRole('status')).toContainText('已载入服务器版本')
      }
    }
  },
)

test(
  'should reject actual size MIME pixel malformed and extra-field official uploads',
  { tag: '@case:files' },
  async ({ images, page, run }) => {
    await login({ page, run })
    await createDraft({ page, run })
    const oversized = await sharp({
      create: { background: 'red', channels: 3, height: 1200, width: 1200 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer()
    const pixels = await sharp({
      create: { background: 'red', channels: 3, height: 1500, width: 1500 },
    })
      .png()
      .toBuffer()
    const jpeg = await sharp(images.small).jpeg().toBuffer()
    for (const [name, bytes] of [
      ['size', oversized],
      ['pixels', pixels],
      ['mime', jpeg],
      ['truncated', images.large.subarray(0, 128)],
    ] as const) {
      await page
        .getByLabel('官方示例图片', { exact: true })
        .setInputFiles({ name: `${name}.png`, buffer: bytes, mimeType: 'image/png' })
      const retained = await retainInput({ page })
      await page.getByRole('button', { name: '上传并关联图片', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('原文件与输入已保留')
      expect(await retainInput({ page })).toEqual(retained)
      const response = await page.request.post(
        `${run.baseURL}${run.apiRoute}/v1/admin/media/examples`,
        { multipart: { file: { name: `${name}.png`, buffer: bytes, mimeType: 'image/png' } } },
      )
      expect([400, 413, 415, 422]).toContain(response.status())
    }
    const extra = await page.request.post(`${run.baseURL}${run.apiRoute}/v1/admin/media/examples`, {
      multipart: {
        file: { name: 'extra.png', buffer: images.small, mimeType: 'image/png' },
        unknown: 'field',
      },
    })
    expect(extra.status()).toBe(400)
  },
)

test(
  'should retain keyboard focus, zero and false inputs across normal and enhanced themes',
  { tag: '@case:a11y' },
  async ({ images, page, run }, testInfo) => {
    const { templateId } = await prepareDraft({ images, page, run })
    for (const theme of ['light', 'dark']) {
      for (const enhanced of [false, true]) {
        await page.context().addCookies([
          { name: 'payload-theme', url: run.baseURL, value: theme },
          { name: 'payload-high-contrast-mode', url: run.baseURL, value: String(enhanced) },
        ])
        await page.goto(adminURL({ run, templateId }))
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        if (enhanced) {
          await expect(page.locator('html')).toHaveAttribute('data-enhanced-contrast', '')
        } else {
          await expect(page.locator('html')).not.toHaveAttribute('data-enhanced-contrast', '')
        }
        const parameter = page.getByLabel('System Prompt', { exact: true })
        await parameter.focus()
        await parameter.press('End')
        await parameter.pressSequentially(' keyboard')
        await expect(parameter).toBeFocused()
        await expect(parameter).toHaveValue('Fixture private prompt, never public. keyboard')
        await page.getByRole('button', { name: '添加示例', exact: true }).click()
        await expect(page.getByLabel('官方示例图片', { exact: true })).toBeFocused()
        await page.getByRole('button', { name: '删除示例 2', exact: true }).click()
        await expect(page.getByRole('button', { name: '添加示例', exact: true })).toBeFocused()
        await page.setViewportSize({ height: 800, width: 320 })
        await page.addStyleTag({
          content:
            '.template-editor {font-size:200%;line-height:1.5;letter-spacing:.12em;word-spacing:.16em}.template-editor p{margin-bottom:2em}',
        })
        expect(
          await page
            .locator('.template-editor')
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true)
        const scan = await runAxeScan({
          defaultExcludes: false,
          include: ['.template-editor'],
          page,
          screenshotViolations: false,
          testInfo,
        })
        expect(scan.violations).toEqual([])
      }
    }
  },
)

test(
  'should invalidate inspection after local edits and a second-tab server change under backward clock skew',
  { tag: '@case:stale-review' },
  async ({ context, images, page, run }) => {
    const { code, templateId } = await prepareDraft({ images, page, run })
    await page.clock.setFixedTime(new Date('2000-01-01T00:00:00.000Z'))
    await page.getByRole('button', { name: '检查已保存版本', exact: true }).click()
    await expect(page.getByRole('region', { name: '发布检查预览' })).toBeVisible()
    await page.getByLabel('公开名称', { exact: true }).fill('检查后本地修改')
    await expect(page.getByRole('region', { name: '发布检查预览' })).toHaveCount(0)
    await saveDraft({ page })
    await page.getByRole('button', { name: '检查已保存版本', exact: true }).click()
    await page
      .getByLabel('我已检查本次示例、积分与输入约束，并明确确认发布此版本', { exact: true })
      .check()
    const second = await context.newPage()
    try {
      await second.goto(adminURL({ run, templateId }))
      await second.getByLabel('公开名称', { exact: true }).fill('另一页检查后保存')
      await saveDraft({ page: second })
      await page.getByRole('button', { name: '确认发布', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('服务器事实已变化')
      await expect(page.getByRole('region', { name: '发布检查预览' })).toHaveCount(0)
      expect(run.readTemplate({ code })[0]!.published_version_id).toBeNull()
      await confirmDialog({
        button: page.getByRole('button', { name: '重新载入服务器版本', exact: true }),
        message: /丢弃本地输入/,
        page,
      })
      const before = Date.now()
      await inspectAndConfirm({ page })
      const after = Date.now()
      const published = Date.parse(String(run.readTemplate({ code })[0]!.published_at))
      expect(published).toBeGreaterThanOrEqual(before)
      expect(published).toBeLessThanOrEqual(after)
      await expect(page.getByLabel('公开名称', { exact: true })).toBeDisabled()
    } finally {
      await second.close()
    }
  },
)
