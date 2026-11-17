type PublicationAdmin = Readonly<{ id: number; role: string; status: string }>

import {
  isPublicationUTC,
  requirePublicationAdministrator,
  TemplatePublicationError,
} from '../domain/template-publication.js'

export type TaxonomyTerm = Readonly<{
  code: string
  id: number
  kind: 'category' | 'label'
  name: string
  sortOrder: number
  status: 'active' | 'hidden'
}>
export type TaxonomyFact = Readonly<{ isDeleted: boolean }> & TaxonomyTerm
export type TaxonomyFilters = Readonly<{
  afterId: null | number
  keyword: string
  kind: null | TaxonomyTerm['kind']
  limit: number
  status: null | TaxonomyTerm['status']
}>
export type TaxonomyReader = Readonly<{
  findTermsByKey: (args: Pick<TaxonomyTerm, 'code' | 'kind'>) => Promise<readonly TaxonomyFact[]>
  listTerms: (args: TaxonomyFilters) => Promise<readonly TaxonomyFact[]>
  readAdmin: (args: { adminId: number }) => Promise<null | PublicationAdmin>
  readTerm: (args: { termId: number }) => Promise<null | TaxonomyFact>
}>
export type TaxonomyRepository = Readonly<{
  appendAudit: (args: {
    adminId: number
    after: TaxonomyTerm
    before: null | TaxonomyTerm
    now: string
  }) => Promise<void>
  insertTerm: (args: {
    actor: string
    data: Omit<TaxonomyTerm, 'id'>
    now: string
  }) => Promise<TaxonomyFact>
  updateTerm: (args: {
    actor: string
    before: TaxonomyFact
    data: Pick<TaxonomyTerm, 'name' | 'sortOrder' | 'status'>
    now: string
  }) => Promise<TaxonomyFact>
}> &
  TaxonomyReader
export type TaxonomyDependencies = Readonly<{
  clock: () => string
  read: <T>(args: { work: (args: { repository: TaxonomyReader }) => Promise<T> }) => Promise<T>
  write: <T>(args: {
    resource: string
    work: (args: { repository: TaxonomyRepository }) => Promise<T>
  }) => Promise<T>
}>

/** Internal use cases; Native authentication belongs to each future server action, not adminId input. */
export function createTemplateTaxonomy({ clock, read, write }: TaxonomyDependencies) {
  const now = () => {
    const value = clock()
    if (!isPublicationUTC({ value })) {
      throw new Error('Taxonomy clock must return strict UTC.')
    }
    return value
  }
  return Object.freeze({
    createTerm: async ({ adminId, input }: { adminId: unknown; input: unknown }) => {
      const id = integer({ isPositive: true, value: adminId })
      const fields = command({ keys: ['kind', 'code', 'name', 'sortOrder'], value: input })
      const data: Omit<TaxonomyTerm, 'id'> = {
        name: name({ value: fields.name }),
        code: code({ value: fields.code }),
        kind: termKind({ value: fields.kind }),
        sortOrder: Object.hasOwn(fields, 'sortOrder') ? integer({ value: fields.sortOrder }) : 0,
        status: 'active',
      }
      return write({
        resource: `taxonomy:${data.kind}:${data.code}`,
        work: async ({ repository }) => {
          await administrator({ adminId: id, repository })
          const candidates = await logical({ repository, ...data })
          if (candidates.length !== 0) {
            throw new TemplatePublicationError('PUBLICATION_CONFLICT')
          }
          const time = now()
          const saved = fact({
            row: await repository.insertTerm({ actor: `admin:${id}`, data, now: time }),
          })
          const after = dto({ row: saved })
          if (
            saved.isDeleted ||
            Object.entries(data).some(([key, value]) => after[key as keyof TaxonomyTerm] !== value)
          ) {
            integrity()
          }
          await repository.appendAudit({ adminId: id, after, before: null, now: time })
          return after
        },
      })
    },
    listTerms: async ({ adminId, input }: { adminId: unknown; input: unknown }) => {
      const id = integer({ isPositive: true, value: adminId })
      const fields = command({ keys: ['afterId', 'kind', 'status', 'keyword'], value: input })
      const afterId =
        !Object.hasOwn(fields, 'afterId') || fields.afterId === null
          ? null
          : integer({ isPositive: true, value: fields.afterId })
      const kind =
        !Object.hasOwn(fields, 'kind') || fields.kind === null
          ? null
          : termKind({ value: fields.kind })
      const status =
        !Object.hasOwn(fields, 'status') || fields.status === null
          ? null
          : termStatus({ value: fields.status })
      const keyword = Object.hasOwn(fields, 'keyword') ? fields.keyword : ''
      if (
        typeof keyword !== 'string' ||
        [...keyword].length > 80 ||
        new TextEncoder().encode(keyword).length > 320
      ) {
        invalid()
      }
      return read({
        work: async ({ repository }) => {
          await administrator({ adminId: id, repository })
          const rows = await repository.listTerms({ afterId, keyword, kind, limit: 21, status })
          if (rows.length > 21) {
            integrity()
          }
          let previous = afterId ?? 0
          const items = rows.map((row) => {
            const value = fact({ row })
            if (
              value.id <= previous ||
              value.isDeleted ||
              (kind !== null && kind !== value.kind) ||
              (status !== null && status !== value.status)
            ) {
              integrity()
            }
            previous = value.id
            return dto({ row: value })
          })
          return Object.freeze({
            items: Object.freeze(items.slice(0, 20)),
            nextAfterId: items.length > 20 ? items[19]!.id : null,
          })
        },
      })
    },
    updateTerm: async ({ adminId, input }: { adminId: unknown; input: unknown }) => {
      const admin = integer({ isPositive: true, value: adminId })
      const fields = command({ keys: ['id', 'name', 'status', 'sortOrder'], value: input })
      const id = integer({ isPositive: true, value: fields.id })
      const data: { name?: string; sortOrder?: number; status?: TaxonomyTerm['status'] } = {}
      if (Object.hasOwn(fields, 'name')) {
        data.name = name({ value: fields.name })
      }
      if (Object.hasOwn(fields, 'status')) {
        data.status = termStatus({ value: fields.status })
      }
      if (Object.hasOwn(fields, 'sortOrder')) {
        data.sortOrder = integer({ value: fields.sortOrder })
      }
      if (Object.keys(data).length === 0) {
        invalid()
      }
      return write({
        resource: `taxonomy-term:${id}`,
        work: async ({ repository }) => {
          await administrator({ adminId: admin, repository })
          const row = await repository.readTerm({ termId: id })
          if (!row) {
            throw new TemplatePublicationError('NOT_FOUND')
          }
          const before = fact({ row })
          if (before.id !== id) {
            integrity()
          }
          if (before.isDeleted) {
            throw new TemplatePublicationError('NOT_FOUND')
          }
          const candidates = await logical({ repository, ...before })
          if (
            candidates.length !== 1 ||
            candidates[0]!.id !== id ||
            Object.keys(before).some(
              (key) =>
                before[key as keyof TaxonomyFact] !== candidates[0]![key as keyof TaxonomyFact],
            )
          ) {
            integrity()
          }
          if (
            Object.entries(data).every(
              ([key, value]) => before[key as keyof TaxonomyTerm] === value,
            )
          ) {
            return dto({ row: before })
          }
          const time = now()
          const change = {
            name: before.name,
            sortOrder: before.sortOrder,
            status: before.status,
            ...data,
          }
          const saved = fact({
            row: await repository.updateTerm({
              actor: `admin:${admin}`,
              before,
              data: change,
              now: time,
            }),
          })
          const after = dto({ row: saved })
          if (
            saved.isDeleted ||
            Object.entries({ ...dto({ row: before }), ...change }).some(
              ([key, value]) => after[key as keyof TaxonomyTerm] !== value,
            )
          ) {
            integrity()
          }
          await repository.appendAudit({
            adminId: admin,
            after,
            before: dto({ row: before }),
            now: time,
          })
          return after
        },
      })
    },
  })
}
async function administrator({
  adminId,
  repository,
}: {
  adminId: number
  repository: TaxonomyReader
}) {
  const admin = requirePublicationAdministrator({ admin: await repository.readAdmin({ adminId }) })
  if (admin.id !== adminId) {
    throw new TemplatePublicationError('UNAUTHENTICATED')
  }
  return admin
}
async function logical({
  code,
  kind,
  repository,
}: { repository: TaxonomyReader } & Pick<TaxonomyTerm, 'code' | 'kind'>) {
  const rows = await repository.findTermsByKey({ code, kind })
  if (rows.length > 1) {
    integrity()
  }
  return rows.map((row) => {
    const value = fact({ row })
    if (value.code !== code || value.kind !== kind) {
      integrity()
    }
    return value
  })
}
function dto({ row }: { row: TaxonomyFact }): TaxonomyTerm {
  return Object.freeze({
    id: row.id,
    name: row.name,
    code: row.code,
    kind: row.kind,
    sortOrder: row.sortOrder,
    status: row.status,
  })
}
function fact({ row }: { row: TaxonomyFact }): TaxonomyFact {
  try {
    if (typeof row.isDeleted !== 'boolean') {
      integrity()
    }
    return {
      id: integer({ isPositive: true, value: row.id }),
      name: name({ value: row.name }),
      code: code({ value: row.code }),
      isDeleted: row.isDeleted,
      kind: termKind({ value: row.kind }),
      sortOrder: integer({ value: row.sortOrder }),
      status: termStatus({ value: row.status }),
    }
  } catch (error) {
    if (error instanceof TemplatePublicationError && error.code === 'INPUT_INVALID') {
      integrity()
    }
    throw error
  }
}
function command({
  keys,
  value,
}: {
  keys: readonly string[]
  value: unknown
}): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  ) {
    invalid()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const result: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      invalid()
    }
    const descriptor = descriptors[key]!
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalid()
    }
    result[key] = descriptor.value
  }
  return result
}
function integer({ isPositive = false, value }: { isPositive?: boolean; value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (isPositive && value < 1)) {
    invalid()
  }
  return value
}
function termKind({ value }: { value: unknown }): TaxonomyTerm['kind'] {
  if (value !== 'category' && value !== 'label') {
    invalid()
  }
  return value
}
function termStatus({ value }: { value: unknown }): TaxonomyTerm['status'] {
  if (value !== 'active' && value !== 'hidden') {
    invalid()
  }
  return value
}
function code({ value }: { value: unknown }): string {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z][a-z0-9_-]*$/.test(value)) {
    invalid()
  }
  return value
}
function name({ value }: { value: unknown }): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 80 ||
    /[\p{Cc}\u2028\u2029]/u.test(value) ||
    [...value].some((char) => {
      const point = char.codePointAt(0)!
      return point >= 0xd800 && point <= 0xdfff
    }) ||
    new TextEncoder().encode(value).length > 320
  ) {
    invalid()
  }
  return value
}
function invalid(): never {
  throw new TemplatePublicationError('INPUT_INVALID')
}
function integrity(): never {
  throw new TemplatePublicationError('DATA_INTEGRITY_CONFLICT')
}
