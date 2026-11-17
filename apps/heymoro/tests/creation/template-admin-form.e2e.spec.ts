import { expect } from '@playwright/test'

import { runAxeScan } from '../../../../test/__helpers/e2e/runAxeScan.js'
import {
  adminURL,
  anonymousContent,
  digest,
  login,
  test,
  upload,
} from './template-admin-browser.js'

// One owned Next instance: Native/RSC → Action → binary REST → Action save/check/publish → reload/catalog.
test(
  'should perform real taxonomy CRUD and >1MiB multipart upload, save, inspect, explicit confirmation and reload',
  { tag: '@case:happy' },
  async ({ images, page, run }, testInfo) => {
    const { large, small } = images
    const code = `form-${run.runId}`
    await login({ page, run })
    await page.goto(adminURL({ run }))
    await page.getByText('管理分类和标签', { exact: true }).click()
    const taxonomy = page
      .locator('details')
      .filter({ has: page.getByText('管理分类和标签', { exact: true }) })
    await taxonomy.getByLabel('词条代码', { exact: true }).fill(`cat-${run.runId}`)
    await taxonomy.getByLabel('词条名称', { exact: true }).fill('真实分类')
    await taxonomy.getByRole('button', { name: '创建词条', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('写入已确认')
    await taxonomy.getByLabel('词条类型', { exact: true }).last().selectOption('label')
    await taxonomy.getByLabel('词条代码', { exact: true }).fill(`tag-${run.runId}`)
    await taxonomy.getByLabel('词条名称', { exact: true }).fill('真实标签')
    await taxonomy.getByRole('button', { name: '创建词条', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('写入已确认')
    const tagName = taxonomy.getByLabel(`label tag-${run.runId} 名称`, { exact: true })
    await tagName.fill('真实标签（重命名）')
    const tagRow = tagName.locator('..').locator('..').locator('..')
    await tagRow.getByRole('button', { name: '保存词条名称', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('写入已确认')
    await tagRow.getByRole('button', { name: '隐藏', exact: true }).click()
    await expect(tagRow).toContainText('hidden')
    await tagRow.getByRole('button', { name: '启用', exact: true }).click()
    await expect(tagRow).toContainText('active')
    await tagName.fill('真实标签')
    await tagRow.getByRole('button', { name: '保存词条名称', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('写入已确认')
    await page.getByText('新建模板', { exact: true }).click()
    await page.getByLabel('稳定代码', { exact: true }).fill(code)
    await page.getByLabel('内部名称', { exact: true }).fill('实际表单内部名称')
    await page.getByRole('button', { name: '创建模板', exact: true }).click()
    await expect(page.getByLabel('公开名称', { exact: true })).toBeVisible()
    await page.getByLabel('公开名称', { exact: true }).fill('公开表单名称')
    await page.getByLabel('选择当前分类', { exact: true }).selectOption({ label: '真实分类' })
    await page.getByLabel('添加当前标签', { exact: true }).selectOption({ label: '真实标签' })
    await page.getByLabel('主标签', { exact: true }).selectOption({ label: '真实标签' })
    await page.getByLabel('单图字节上限', { exact: true }).fill('4194304')
    await page.getByLabel('图片总字节上限', { exact: true }).fill('8388608')
    await page
      .getByLabel('System Prompt', { exact: true })
      .fill('Create a clean image from the supplied input.')
    await page.getByLabel('size（必填）', { exact: true }).selectOption('1024x1024')
    await page.getByLabel('积分', { exact: true }).fill('0')
    const cover = await upload({ bytes: large, isLarge: true, page, position: '封面', run })
    await page.getByRole('button', { name: '添加示例', exact: true }).click()
    await expect(page.getByLabel('官方示例图片', { exact: true })).toBeFocused()
    await expect(page.getByLabel('上传关联位置', { exact: true })).toHaveValue('output:0')
    await page.getByRole('button', { name: '删除示例 1', exact: true }).click()
    await expect(page.getByRole('button', { name: '添加示例', exact: true })).toBeFocused()
    await page.getByRole('button', { name: '添加示例', exact: true }).click()
    await expect(page.getByLabel('官方示例图片', { exact: true })).toBeFocused()
    const output = await upload({ bytes: small, isLarge: false, page, position: '示例1输出', run })
    const input = await upload({
      bytes: large,
      isLarge: true,
      page,
      position: '示例1追加输入',
      run,
    })
    await page.getByLabel('简介', { exact: true }).fill('')
    await page.getByLabel('拍摄提示 photoHint', { exact: true }).fill('')
    await page.getByLabel('最少图片数', { exact: true }).fill('0')
    await page.getByLabel('描述字数上限', { exact: true }).fill('0')
    await page.getByLabel('备注字数上限', { exact: true }).fill('0')
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('写入已确认并完成服务器回读')
    await page.getByRole('button', { name: '重新载入服务器版本', exact: true }).click()
    await expect(page.getByLabel('公开名称', { exact: true })).toHaveValue('公开表单名称')
    await expect(page.getByLabel('积分', { exact: true })).toHaveValue('0')
    await expect(page.getByLabel('System Prompt', { exact: true })).toHaveValue(
      'Create a clean image from the supplied input.',
    )
    const preview = await page.request.get(
      `${run.baseURL}${run.apiRoute}/v1/media/examples/${cover}/content`,
    )
    expect(preview.status()).toBe(200)
    expect(digest({ bytes: await preview.body() })).toBe(digest({ bytes: large }))
    await anonymousContent({ id: cover, bytes: large, page, run })
    await expect(page.locator('.template-editor img').first()).toBeVisible()
    expect(
      await page
        .locator('.template-editor img')
        .first()
        .evaluate(
          (image) =>
            (image as HTMLImageElement).complete &&
            (image as HTMLImageElement).naturalWidth > 0 &&
            (image as HTMLImageElement).naturalHeight > 0,
        ),
    ).toBe(true)
    // Browser wall-clock skew does not supply reviewedAt to the Action.
    await page.clock.setFixedTime(new Date('2040-01-01T00:00:00.000Z'))
    await page.getByRole('button', { name: '检查已保存版本', exact: true }).click()
    await expect(page.getByRole('region', { name: '发布检查预览' })).toBeVisible()
    await expect(page.getByRole('button', { name: '确认发布', exact: true })).toBeDisabled()
    await page
      .getByLabel('我已检查本次示例、积分与输入约束，并明确确认发布此版本', { exact: true })
      .check()
    const scan = await runAxeScan({
      defaultExcludes: false,
      include: ['.template-editor'],
      page,
      screenshotViolations: false,
      testInfo,
    })
    expect(scan.violations).toEqual([])
    await page.getByRole('button', { name: '确认发布', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('写入已确认')
    await expect(page.getByLabel('公开名称', { exact: true })).toBeDisabled()
    const heading = page.getByRole('heading', { name: /实际表单内部名称/ })
    await expect(heading).toBeVisible()
    const published = page.locator('section[aria-label="模板编辑"]')
    await expect(published).toContainText('模板状态：published')
    const pointer = await published.innerText()
    const match = pointer.match(/当前发布指针：(\d+)/)
    expect(match).not.toBeNull()
    // Use actual catalog, not hidden Payload collections or a browser-side projection.
    const catalog = await page.request.get(`${run.baseURL}${run.apiRoute}/v1/templates`)
    expect(catalog.status()).toBe(200)
    const publicBody: unknown = await catalog.json()
    expect(JSON.stringify(publicBody)).toContain('公开表单名称')
    expect(JSON.stringify(publicBody)).not.toContain('systemPrompt')
    expect(JSON.stringify(publicBody)).not.toContain(
      'Create a clean image from the supplied input.',
    )
    for (const forbidden of [
      'generationConfigJson',
      'storageBackend',
      'secretAccessKey',
      'payloadSecret',
    ]) {
      expect(JSON.stringify(publicBody)).not.toContain(forbidden)
    }
    // Resolve stable template ID using the page's server-rendered query on next load below.
    const linkData = await page.evaluate(
      () => document.querySelector('section[aria-label="模板编辑"]')?.textContent,
    )
    expect(linkData).toContain(code)
    // The admin list search is an actual read Action and returns the newly created row.
    await page.getByLabel('搜索内部名称或代码', { exact: true }).fill(code)
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByRole('button', { name: `实际表单内部名称（${code}）`, exact: true }).click()
    await expect(page.getByRole('region', { name: '模板编辑' })).toContainText('published')
    // A real GET to this fixture's public catalog supplies the ID without direct DB access.
    const templateId = findTemplateId({ name: '公开表单名称', value: publicBody })
    const [stored] = run.readTemplate({ code })
    expect(templateId).toBe(Number(stored!.id))
    expect(Number(match![1])).toBe(Number(stored!.published_version_id))
    expect(stored!.cost_credits).toBe(0)
    const display = JSON.parse(String(stored!.display_config_json)) as Record<string, unknown>
    expect(display.examples).toEqual([{ inputMediaIds: [input], outputMediaId: output }])
    expect(display.coverMediaId).toBe(cover)
    expect([display.description, display.photoHint]).toEqual(['', ''])
    const savedInput = JSON.parse(String(stored!.input_schema_json)) as Record<string, unknown>
    expect([
      savedInput.minImages,
      savedInput.maxDescriptionLength,
      savedInput.maxNotesLength,
    ]).toEqual([0, 0, 0])
    await page.reload()
    await page.goto(adminURL({ run, templateId }))
    await expect(page.getByLabel('公开名称', { exact: true })).toHaveValue('公开表单名称')
    await page.setViewportSize({ height: 800, width: 320 })
    expect(
      await page
        .locator('.template-editor')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true)
    await testInfo.attach('actual-form-narrow', {
      body: await page.locator('.template-editor').screenshot(),
      contentType: 'image/png',
    })
  },
)

function findTemplateId({ name, value }: { name: string; value: unknown }): number {
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    if (
      typeof row.templateId === 'number' &&
      JSON.stringify(row.displayConfig ?? null).includes(name)
    ) {
      return row.templateId
    }
    for (const item of Object.values(row)) {
      try {
        return findTemplateId({ name, value: item })
      } catch {
        /* Search the next public DTO branch. */
      }
    }
  }
  throw Error('Published template was not present in actual public catalog.')
}
