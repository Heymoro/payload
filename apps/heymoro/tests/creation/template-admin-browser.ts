import type { APIResponse, Locator, Page, Route } from '@playwright/test'

import { test as base, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import path from 'node:path'
import sharp from 'sharp'

import type { OwnedRun } from './template-admin-run.js'

import { validateImage } from '../../src/creation/infrastructure/image/sharp-image-validator.js'
import { readApproval } from './template-admin-approval.js'
import { startOwnedRun } from './template-admin-run.js'

export type Images = { large: Buffer; small: Buffer }
export const digest = ({ bytes }: { bytes: Uint8Array }) =>
  createHash('sha256').update(bytes).digest('hex')
export const test = base.extend<{ images: Images; run: OwnedRun }>({
  images: async ({ browser }, provide) => {
    expect(browser.isConnected()).toBe(true)
    const raw = Buffer.alloc(1024 * 1024 * 3)
    for (let index = 0; index < raw.length; index++) {
      raw[index] = index % 251
    }
    const large = await sharp(raw, { raw: { channels: 3, height: 1024, width: 1024 } })
      .png({ adaptiveFiltering: false, compressionLevel: 0 })
      .toBuffer()
    expect(large.length).toBeGreaterThan(1048576)
    expect(large.length).toBeLessThanOrEqual(4194304)
    const verified = await validateImage({
      declaredMimeType: 'image/png',
      input: large,
      limits: {
        allowedMimeTypes: ['image/png'],
        maxBytes: 4194304,
        maxPixels: 2000000,
        timeoutMs: 10000,
      },
    })
    expect([verified.width, verified.height, verified.sha256]).toEqual([
      1024,
      1024,
      digest({ bytes: large }),
    ])
    const small = await sharp({ create: { background: 'green', channels: 3, height: 2, width: 3 } })
      .png()
      .toBuffer()
    await provide({ large, small })
  },
  run: async ({ browser, images }, provide, testInfo) => {
    // Browser resolution and image preparation happen before the unchanged 90s MinIO watchdog starts.
    expect(browser.isConnected()).toBe(true)
    expect(images.large.length).toBeGreaterThan(1048576)
    const approval = readApproval()
    const scenario = testInfo.tags.find((tag) => tag.startsWith('@case:'))?.slice(6)
    if (!scenario || !approval.scenarios.includes(scenario)) {
      throw Error('A single root-approved scenario tag is required.')
    }
    const run = await startOwnedRun({
      approval: {
        ...approval,
        distDirectory: path.join(approval.distDirectory, scenario),
        runDirectory: path.join(approval.runDirectory, scenario),
      },
      scenario,
    })
    try {
      await provide(run)
    } finally {
      let contextFailures = 0
      for (const context of browser.contexts()) {
        try {
          await context.close()
        } catch {
          contextFailures++
        }
      }
      await run.close({
        outcome: contextFailures
          ? 'context-cleanup-failed'
          : testInfo.status === 'passed'
            ? 'browser-passed-not-product-accepted'
            : 'browser-failed',
      })
      expect(
        contextFailures,
        'All contexts and the owned host received independent cleanup attempts',
      ).toBe(0)
    }
  },
})
export function adminURL({
  run,
  suffix = '/templates',
  templateId,
}: {
  run: OwnedRun
  suffix?: string
  templateId?: number
}) {
  const url = new URL(`${run.adminRoute}${suffix}`, run.baseURL)
  if (templateId) {
    url.searchParams.set('templateId', String(templateId))
  }
  return url.href
}
export async function login({
  run,
  credentials = run.credentials,
  page,
}: {
  credentials?: { email: string; password: string }
  page: Page
  run: OwnedRun
}) {
  await page.goto(adminURL({ run, suffix: '/login' }))
  await page.getByLabel('Email', { exact: true }).fill(credentials.email)
  await page.getByLabel('Password', { exact: true }).fill(credentials.password)
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `${run.apiRoute}/admins/login`,
  )
  await page.getByRole('button', { name: 'Login', exact: true }).click()
  const response = await pending
  expect(response.status()).toBe(200)
  const result = (await response.json()) as {
    token: string
    user: { id: number; role: string; status: string }
  }
  expect(result.user.status).toBe('active')
  expect(['admin', 'operator']).toContain(result.user.role)
  expect(typeof result.token).toBe('string')
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/)
  // JWT only in memory. Never attach response, storageState or request headers to evidence.
  return { id: result.user.id, token: result.token }
}
export async function createDraft({
  run,
  code = `form-${run.runId}`,
  page,
}: {
  code?: string
  page: Page
  run: OwnedRun
}) {
  await page.goto(adminURL({ run }))
  await page.getByText('新建模板', { exact: true }).click()
  await page.getByLabel('稳定代码', { exact: true }).fill(code.slice(0, 64))
  await page.getByLabel('内部名称', { exact: true }).fill('实际表单内部名称')
  await page.getByRole('button', { name: '创建模板', exact: true }).click()
  await expect(page.getByLabel('公开名称', { exact: true })).toBeVisible()
  const [row] = run.readTemplate({ code: code.slice(0, 64) })
  return { code: code.slice(0, 64), templateId: Number(row!.id) }
}
export async function upload(args: Parameters<typeof uploadThroughUI>[0]) {
  return args.run.stage({ name: 'official-upload', operation: () => uploadThroughUI(args) })
}
async function uploadThroughUI({
  bytes,
  isLarge = false,
  page,
  position,
  run,
}: {
  bytes: Buffer
  isLarge?: boolean
  page: Page
  position: string
  run: OwnedRun
}) {
  await page.getByLabel('上传关联位置', { exact: true }).selectOption({ label: position })
  await page
    .getByLabel('官方示例图片', { exact: true })
    .setInputFiles({ name: 'example.png', buffer: bytes, mimeType: 'image/png' })
  const before = run.observer.events.length
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `${run.apiRoute}/v1/admin/media/examples`,
  )
  await page.getByRole('button', { name: '上传并关联图片', exact: true }).click()
  const response = await pending
  expect(response.status()).toBe(201)
  const request = response.request()
  const headers = await request.allHeaders()
  expect(headers['content-type']).toContain('multipart/form-data')
  expect(typeof headers.authorization).toBe('undefined')
  expect(typeof headers['next-action']).toBe('undefined')
  expect(headers.origin).toBe(run.baseURL)
  expect(typeof headers.cookie).toBe('string')
  const wire = request.postDataBuffer()!
  if (isLarge) {
    expect(wire.length).toBeGreaterThan(1048576)
  }
  expect(wire.length).toBeLessThanOrEqual(4210688)
  expect(wire.toString('latin1').match(/content-disposition: form-data; name="/gi)).toHaveLength(1)
  expect(wire.toString('latin1')).toContain('name="file"')
  const result = (await response.json()) as { data: { id: number } }
  expect(result.data.id).toBeGreaterThan(0)
  await expect(page.getByRole('status')).toContainText('官方图片已入库')
  expect(run.observer.failed).toBe(false)
  const row = run.readMedia({ id: result.data.id })
  expect([row.owner, row.purpose, row.visibility, row.sha256]).toEqual([
    null,
    'example',
    'official_public',
    digest({ bytes }),
  ])
  const events = run.observer.events.slice(before)
  const put = events.find(
    (event) =>
      event.method === 'PUT' &&
      event.requestSHA256 === digest({ bytes }) &&
      event.requestBytes === bytes.length,
  )
  expect(put?.ifNoneMatch).toBe('*')
  expect(put?.completed).toBe(true)
  expect(put?.upstreamStatus).toBe(200)
  const get = events.find(
    (event) => event.method === 'GET' && event.path === put?.path && event.sequence > put!.sequence,
  )
  expect([get?.responseBytes, get?.responseSHA256, get?.completed, get?.upstreamStatus]).toEqual([
    bytes.length,
    digest({ bytes }),
    true,
    200,
  ])
  expect(put?.path).toBe(`/${String(row.storage_bucket)}/${String(row.storage_name)}`)
  await run.verifyPrivateObject({ bytes, key: String(row.storage_name) })
  return result.data.id
}
export async function saveDraft({ page }: { page: Page }) {
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('写入已确认并完成服务器回读')
}
export async function inspectAndConfirm({
  isRelist = false,
  page,
}: {
  isRelist?: boolean
  page: Page
}) {
  await page.getByRole('button', { name: '检查已保存版本', exact: true }).click()
  await expect(page.getByRole('region', { name: '发布检查预览' })).toBeVisible()
  const button = page.getByRole('button', {
    name: isRelist ? '确认重新上架' : '确认发布',
    exact: true,
  })
  await expect(button).toBeDisabled()
  await page
    .getByLabel('我已检查本次示例、积分与输入约束，并明确确认发布此版本', { exact: true })
    .check()
  await button.click()
  await expect(page.getByRole('status')).toContainText('写入已确认')
}
export async function confirmDialog({
  button,
  message,
  page,
}: {
  button: Locator
  message: RegExp
  page: Page
}) {
  const pending = page.waitForEvent('dialog')
  const click = button.click()
  const dialog = await pending
  expect(dialog.type()).toBe('confirm')
  expect(dialog.message()).toMatch(message)
  await dialog.accept()
  await click
}
export async function retainInput({ page }: { page: Page }) {
  return page
    .getByRole('region', { name: '模板编辑', exact: true })
    .locator('input,select,textarea')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const control = element as HTMLInputElement
        return {
          checked: control.checked,
          files: control.files
            ? Array.from(control.files).map((file) => ({
                name: file.name,
                type: file.type,
                size: file.size,
              }))
            : [],
          label: control.getAttribute('aria-label'),
          value: control.type === 'file' ? '' : control.value,
        }
      }),
    )
}
/** Exactly one real request is sent upstream, then ACK is discarded. No fake response or business outcome. */
export async function loseOneACK({
  page,
  upload: isUpload = false,
}: {
  page: Page
  upload?: boolean
}) {
  let calls = 0
  let delivered = 0
  const predicate = (url: URL) => url.origin === new URL(page.url()).origin
  const handler = async (route: Route) => {
    const request = route.request()
    const isTarget =
      request.method() === 'POST' &&
      (isUpload
        ? new URL(request.url()).pathname.endsWith('/v1/admin/media/examples')
        : Boolean(request.headers()['next-action']))
    if (!isTarget) {
      await route.continue()
      return
    }
    calls++
    if (calls !== 1) {
      await route.abort('failed')
      return
    }
    const real = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30000 })
    delivered++
    await real.dispose()
    await route.abort('failed')
  }
  await page.route(predicate, handler)
  return { close: () => page.unroute(predicate, handler), counts: () => ({ calls, delivered }) }
}
export async function anonymousContent({
  id,
  bytes,
  page,
  run,
}: {
  bytes: Buffer
  id: number
  page: Page
  run: OwnedRun
}) {
  const context = await page.context().browser()!.newContext()
  try {
    const response: APIResponse = await context.request.get(
      `${run.baseURL}${run.apiRoute}/v1/media/examples/${id}/content`,
    )
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('image/png')
    expect(digest({ bytes: await response.body() })).toBe(digest({ bytes }))
  } finally {
    await context.close()
  }
}

/** UI-only arrange: no successful media/template records are inserted by host SQL. */
export async function prepareDraft({
  images,
  page,
  publish = false,
  run,
}: {
  images: Images
  page: Page
  publish?: boolean
  run: OwnedRun
}) {
  const auth = await login({ page, run })
  await page.goto(adminURL({ run }))
  await page.getByText('管理分类和标签', { exact: true }).click()
  const taxonomy = page
    .locator('details')
    .filter({ has: page.getByText('管理分类和标签', { exact: true }) })
  await taxonomy.getByLabel('词条代码', { exact: true }).fill(`cat-${run.runId}`)
  await taxonomy.getByLabel('词条名称', { exact: true }).fill('异常流程分类')
  await taxonomy.getByRole('button', { name: '创建词条', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('写入已确认')
  const target = await createDraft({ page, run })
  await page.getByLabel('公开名称', { exact: true }).fill('异常流程已保存名称')
  await page.getByLabel('选择当前分类', { exact: true }).selectOption({ label: '异常流程分类' })
  await page.getByLabel('最少图片数', { exact: true }).fill('0')
  await page.getByLabel('单图字节上限', { exact: true }).fill('4194304')
  await page.getByLabel('图片总字节上限', { exact: true }).fill('8388608')
  await page
    .getByLabel('System Prompt', { exact: true })
    .fill('Fixture private prompt, never public.')
  await page.getByLabel('size（必填）', { exact: true }).selectOption('1024x1024')
  const cover = await upload({ bytes: images.large, isLarge: true, page, position: '封面', run })
  await page.getByRole('button', { name: '添加示例', exact: true }).click()
  await expect(page.getByLabel('官方示例图片', { exact: true })).toBeFocused()
  await upload({ bytes: images.small, page, position: '示例1输出', run })
  await saveDraft({ page })
  const versionId = Number(await page.getByLabel('版本', { exact: true }).inputValue())
  expect(versionId).toBeGreaterThan(0)
  if (publish) {
    await inspectAndConfirm({ page })
  }
  return { ...target, auth, cover, versionId }
}
