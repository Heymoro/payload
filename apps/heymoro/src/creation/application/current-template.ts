import { createHash } from 'node:crypto'

import type { CurrentTemplateConfiguration } from '../domain/current-template.js'
import type { PublicTemplateConfig, TemplateKind } from '../domain/template-config.js'
import type { MediaRecord } from './media.js'

import { compileCurrentTemplate } from '../domain/current-template.js'
import { GenerationError } from '../domain/generation.js'
import {
  CatalogError,
  freezeCatalogValue,
  parsePublicTemplateConfig,
} from '../domain/template-config.js'
import {
  isPublicationUTC,
  requirePublicationAdministrator,
  TemplatePublicationError,
} from '../domain/template-publication.js'
import { projectTemplateOptions } from './template-management.js'

export type CurrentTemplateBody = Omit<CurrentTemplateConfiguration, 'id' | 'kind'> &
  Readonly<{ shareConfigJson: string }>
export type CurrentTemplateRecord = CurrentTemplateConfiguration &
  Readonly<{
    code: string
    isDeleted: boolean
    name: string
    shareConfigJson: string
    status: 'offline' | 'published'
  }>
export type CurrentTemplateQuery = Readonly<{
  afterId: null | number
  keyword: string
  limit: 21
  status: null | string
}>
type Term = Readonly<{ id: number; isDeleted: boolean; kind: string; name: string; status: string }>
export type CurrentTemplateReader = Readonly<{
  findByCode: (args: { code: string }) => Promise<readonly CurrentTemplateRecord[]>
  list: (args: CurrentTemplateQuery) => Promise<readonly CurrentTemplateRecord[]>
  readAdmin: (args: {
    adminId: number
  }) => Promise<null | Readonly<{ id: number; role: string; status: string }>>
  readMedia: (args: { mediaId: number }) => Promise<MediaRecord | null>
  readShowcase: (args: {
    key: string
  }) => Promise<null | Readonly<{ isDeleted: boolean; status: string; templateId: number }>>
  readTemplate: (args: { templateId: number }) => Promise<CurrentTemplateRecord | null>
  readTerm: (args: { termId: number }) => Promise<null | Term>
}>
export type CurrentTemplateRepository = CurrentTemplateReader &
  Readonly<{
    appendAudit: (args: {
      adminId: number
      after: CurrentTemplateRecord
      before: CurrentTemplateRecord | null
      now: string
    }) => Promise<void>
    insert: (args: {
      actor: string
      body: CurrentTemplateBody
      code: string
      kind: TemplateKind
      name: string
      now: string
    }) => Promise<CurrentTemplateRecord>
    update: (args: {
      actor: string
      before: CurrentTemplateRecord
      body?: CurrentTemplateBody
      name?: string
      now: string
      status?: CurrentTemplateRecord['status']
    }) => Promise<CurrentTemplateRecord>
  }>
export type CurrentTemplateOptions = Omit<
  Parameters<typeof compileCurrentTemplate>[0],
  'template'
> &
  Readonly<{ maxExampleMedia: number }>
type Dependencies = CurrentTemplateOptions &
  Readonly<{
    clock: () => string
    read: <T>(args: {
      work: (args: { repository: CurrentTemplateReader }) => Promise<T>
    }) => Promise<T>
    write: <T>(args: {
      resource: string
      work: (args: { repository: CurrentTemplateRepository }) => Promise<T>
    }) => Promise<T>
  }>

/** One row and one short transaction per mutation; no publication versions or model/storage calls. */
export function createCurrentTemplates({ clock, read, write, ...options }: Dependencies) {
  const settings = freezeCatalogValue({ value: structuredClone(options) })
  if (
    !Number.isSafeInteger(settings.maxExampleMedia) ||
    settings.maxExampleMedia < 1 ||
    settings.maxExampleMedia > 100
  ) {
    throw invalid()
  }
  const time = () => {
    const now = clock()
    if (!isPublicationUTC({ value: now })) {
      throw new Error('Template clock requires strict UTC.')
    }
    return now
  }
  const authorize = async ({
    adminId,
    repository,
  }: {
    adminId: number
    repository: CurrentTemplateReader
  }) => requirePublicationAdministrator({ admin: await repository.readAdmin({ adminId }) })
  const current = async ({
    repository,
    templateId,
  }: {
    repository: CurrentTemplateReader
    templateId: number
  }) => {
    const row = await repository.readTemplate({ templateId })
    if (!row || row.isDeleted) {
      throw new TemplatePublicationError('NOT_FOUND')
    }
    return row
  }
  const presentation = ({ body, kind }: { body: CurrentTemplateBody; kind: TemplateKind }) => {
    try {
      return parsePublicTemplateConfig({ ...body, hostCaps: settings.hostCaps, kind })
    } catch (error) {
      if (error instanceof CatalogError) {
        throw invalid()
      }
      throw error
    }
  }
  const validate = async ({
    repository,
    template,
  }: {
    repository: CurrentTemplateReader
    template: CurrentTemplateRecord
  }) => {
    let config: PublicTemplateConfig
    try {
      config = compileCurrentTemplate({ ...settings, template }).publicTemplate
    } catch (error) {
      if (error instanceof CatalogError || error instanceof GenerationError) {
        throw invalid()
      }
      throw error
    }
    await assertReferences({
      config,
      maxMedia: settings.maxExampleMedia,
      repository,
      templateId: template.id,
    })
  }
  return Object.freeze({
    create: async ({
      adminId,
      code,
      configuration,
      kind,
    }: {
      adminId: number
      code: string
      configuration: CurrentTemplateBody
      kind: TemplateKind
    }) => {
      const id = positive({ value: adminId })
      const body = configurationBody({ value: configuration })
      if (
        typeof code !== 'string' ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(code) ||
        !['effect', 'free'].includes(kind) ||
        (code === 'free') !== (kind === 'free')
      ) {
        throw invalid()
      }
      const now = time()
      return write({
        resource: `template-code:${createHash('sha256').update(code).digest('hex')}`,
        work: async ({ repository }) => {
          await authorize({ adminId: id, repository })
          const matches = await repository.findByCode({ code })
          if (matches.length) {
            throw new TemplatePublicationError(
              matches.length > 1 ? 'DATA_INTEGRITY_CONFLICT' : 'PUBLICATION_CONFLICT',
            )
          }
          const name = presentation({ body, kind }).displayConfig.name
          const saved = await repository.insert({
            name,
            actor: `admin:${id}`,
            body,
            code,
            kind,
            now,
          })
          await validate({ repository, template: saved })
          await repository.appendAudit({ adminId: id, after: saved, before: null, now })
          return freezeCatalogValue({ value: saved })
        },
      })
    },
    get: async ({ adminId, templateId }: { adminId: number; templateId: number }) => {
      const id = positive({ value: adminId })
      const target = positive({ value: templateId })
      return read({
        work: async ({ repository }) => {
          await authorize({ adminId: id, repository })
          return freezeCatalogValue({ value: await current({ repository, templateId: target }) })
        },
      })
    },
    getOptions: async ({ adminId }: { adminId: number }) => {
      const id = positive({ value: adminId })
      return read({
        work: async ({ repository }) => {
          await authorize({ adminId: id, repository })
          return projectTemplateOptions(settings)
        },
      })
    },
    list: async ({
      adminId,
      input = {},
    }: {
      adminId: number
      input?: { afterId?: number; keyword?: string; status?: string }
    }) => {
      const id = positive({ value: adminId })
      const afterId = input.afterId === undefined ? null : positive({ value: input.afterId })
      const keyword = input.keyword ?? ''
      const status = input.status ?? null
      if (
        typeof keyword !== 'string' ||
        Array.from(keyword).length > 80 ||
        (status !== null && !['offline', 'published'].includes(status))
      ) {
        throw invalid()
      }
      return read({
        work: async ({ repository }) => {
          await authorize({ adminId: id, repository })
          const rows = await repository.list({ afterId, keyword, limit: 21, status })
          if (rows.length > 21) {
            throw new TemplatePublicationError('DATA_INTEGRITY_CONFLICT')
          }
          const items = rows.slice(0, 20).map(({ id, name, code, costCredits, kind, status }) => ({
            id,
            name,
            code,
            costCredits,
            kind,
            status,
          }))
          return freezeCatalogValue({
            value: {
              hasMore: rows.length > 20,
              items,
              nextAfterId: rows.length > 20 ? items.at(-1)!.id : null,
            },
          })
        },
      })
    },
    save: async ({
      adminId,
      configuration,
      templateId,
    }: {
      adminId: number
      configuration: CurrentTemplateBody
      templateId: number
    }) => {
      const id = positive({ value: adminId })
      const target = positive({ value: templateId })
      const body = configurationBody({ value: configuration })
      const now = time()
      return write({
        resource: `template:${target}`,
        work: async ({ repository }) => {
          await authorize({ adminId: id, repository })
          const before = await current({ repository, templateId: target })
          const name = presentation({ body, kind: before.kind }).displayConfig.name
          await validate({ repository, template: { ...before, ...body, name } })
          const saved = await repository.update({ name, actor: `admin:${id}`, before, body, now })
          await repository.appendAudit({ adminId: id, after: saved, before, now })
          return freezeCatalogValue({ value: saved })
        },
      })
    },
    setStatus: async ({
      adminId,
      status,
      templateId,
    }: {
      adminId: number
      status: CurrentTemplateRecord['status']
      templateId: number
    }) => {
      const id = positive({ value: adminId })
      const target = positive({ value: templateId })
      const now = time()
      if (!['offline', 'published'].includes(status)) {
        throw invalid()
      }
      return write({
        resource: `template:${target}`,
        work: async ({ repository }) => {
          await authorize({ adminId: id, repository })
          const before = await current({ repository, templateId: target })
          if (status === 'published') {
            await validate({ repository, template: before })
          }
          if (before.status === status) {
            return freezeCatalogValue({ value: before })
          }
          const saved = await repository.update({ actor: `admin:${id}`, before, now, status })
          await repository.appendAudit({ adminId: id, after: saved, before, now })
          return freezeCatalogValue({ value: saved })
        },
      })
    },
  })
}

async function assertReferences({
  config,
  maxMedia,
  repository,
  templateId,
}: {
  config: PublicTemplateConfig
  maxMedia: number
  repository: CurrentTemplateReader
  templateId: number
}) {
  const { displayConfig: display } = config
  const ids = new Set(display.coverMediaId === null ? [] : [display.coverMediaId])
  if (ids.size > maxMedia) {
    throw invalid()
  }
  const media = new Map<number, MediaRecord>()
  for (const mediaId of ids) {
    const row = await repository.readMedia({ mediaId })
    if (
      !row ||
      row.isDeleted ||
      row.owner !== null ||
      row.purpose !== 'example' ||
      row.visibility !== 'official_public' ||
      row.lifecycle !== 'active'
    ) {
      throw new TemplatePublicationError('PUBLICATION_CONFLICT')
    }
    media.set(mediaId, row)
  }
  for (const key of display.showcaseShareKeys) {
    const share = await repository.readShowcase({ key })
    if (
      !share ||
      share.isDeleted ||
      share.status !== 'published' ||
      share.templateId !== templateId
    ) {
      throw new TemplatePublicationError('PUBLICATION_CONFLICT')
    }
  }
  for (const expected of [
    ...(display.categoryId === null
      ? []
      : [{ id: display.categoryId, name: display.categoryName, kind: 'category' }]),
    ...display.tags.map((tag) => ({ ...tag, kind: 'label' })),
  ]) {
    const term = await repository.readTerm({ termId: expected.id })
    if (
      !term ||
      term.isDeleted ||
      term.status !== 'active' ||
      term.kind !== expected.kind ||
      term.name !== expected.name
    ) {
      throw new TemplatePublicationError('PUBLICATION_CONFLICT')
    }
  }
}

function configurationBody({ value }: { value: CurrentTemplateBody }): CurrentTemplateBody {
  const keys = [
    'costCredits',
    'displayConfigJson',
    'generationConfigJson',
    'inputSchemaJson',
    'minClientCapability',
    'schemaVersion',
    'shareConfigJson',
  ] as const
  if (
    !value ||
    typeof value !== 'object' ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  ) {
    throw invalid()
  }
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw invalid()
    }
    const item: unknown = descriptor.value
    if (key === 'costCredits' || key === 'schemaVersion') {
      if (
        typeof item !== 'number' ||
        !Number.isSafeInteger(item) ||
        item < (key === 'schemaVersion' ? 1 : 0)
      ) {
        throw invalid()
      }
    } else if (
      typeof item !== 'string' ||
      Buffer.byteLength(item, 'utf8') > (key === 'minClientCapability' ? 64 : 131072)
    ) {
      throw invalid()
    }
    result[key] = item
  }
  try {
    const share: unknown = JSON.parse(result.shareConfigJson as string)
    if (
      !share ||
      typeof share !== 'object' ||
      Array.isArray(share) ||
      Object.keys(share).length !== 0
    ) {
      throw invalid()
    }
  } catch {
    throw invalid()
  }
  return Object.freeze(result) as CurrentTemplateBody
}
function positive({ value }: { value: number }) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid()
  }
  return value
}
function invalid() {
  return new TemplatePublicationError('INPUT_INVALID')
}
