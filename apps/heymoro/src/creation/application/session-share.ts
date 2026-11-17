import { AdminCommandError } from '../domain/admin.js'
import { GenerationError, generationTime } from '../domain/generation.js'
import { libraryInput, requestId } from '../domain/library.js'
import { normalizeSessionTitle } from '../domain/session-title.js'
import { freezeCatalogValue } from '../domain/template-config.js'

export type SharedImage = Readonly<{ createdAt: string; height: number; id: number; width: number }>
export type ShareSource = Readonly<{
  id: number
  images: readonly (Readonly<{ mediaId: number }> & SharedImage)[]
  templateId: number
  title: string
  userId: number
}>
export type SessionShare = Readonly<{
  artifactIdsJson: string
  id: number
  isDeleted: boolean
  publicKey: string
  sessionId: number
  status: 'published' | 'revoked'
  templateId: number
  title: string
}>
export type ShareReader = Readonly<{
  admin: (args: {
    adminId: number
  }) => Promise<null | Readonly<{ id: number; role: string; status: string }>>
  byKey: (args: { key: string }) => Promise<readonly SessionShare[]>
  bySession: (args: { sessionId: number }) => Promise<readonly SessionShare[]>
  sessions: (args: {
    afterId: null | number
    limit: number
  }) => Promise<readonly Readonly<{ id: number; templateId: number; title: string }>[]>
  source: (args: { artifactIds?: readonly number[]; sessionId: number }) => Promise<ShareSource>
}>
export type ShareRepository = Readonly<{
  audit: (args: {
    adminId: number
    after: SessionShare
    before: null | SessionShare
    now: string
  }) => Promise<void>
  save: (args: {
    actor: string
    before: null | SessionShare
    data: Omit<SessionShare, 'id'>
    now: string
  }) => Promise<SessionShare>
}> &
  ShareReader
type Dependencies = Readonly<{
  clock: () => string
  makeKey: () => string
  read: <T>(args: { work: (args: { repository: ShareReader }) => Promise<T> }) => Promise<T>
  readImage: (args: {
    mediaId: number
    userId: number
  }) => Promise<Readonly<{ bytes: Uint8Array; mimeType: string }>>
  write: <T>(args: {
    resource: string
    work: (args: { repository: ShareRepository }) => Promise<T>
  }) => Promise<T>
}>

/** Sharing grants access to selected existing artifacts; it never generates or copies an image. */
export function createSessionShares({ clock, makeKey, read, readImage, write }: Dependencies) {
  return Object.freeze({
    get: async ({ key }: { key: string }) =>
      read({ work: async ({ repository }) => publicView(await resolve({ key, repository })) }),
    image: async ({ artifactId, key }: { artifactId: number; key: string }) => {
      requestId({ value: artifactId })
      const before = await read({
        work: ({ repository }) => resolve({ artifactId, key, repository }),
      })
      const image = before.source.images.find((item) => item.id === artifactId)!
      const bytes = await readImage({ mediaId: image.mediaId, userId: before.source.userId })
      const after = await read({
        work: ({ repository }) => resolve({ artifactId, key, repository }),
      })
      if (
        before.share.id !== after.share.id ||
        before.share.artifactIdsJson !== after.share.artifactIdsJson ||
        after.source.images.find((item) => item.id === artifactId)?.mediaId !== image.mediaId
      ) {
        throw new GenerationError({ code: 'NOT_FOUND' })
      }
      return bytes
    },
    inspect: async ({ adminId, sessionId }: { adminId: number; sessionId: number }) => {
      requestId({ value: adminId })
      requestId({ value: sessionId })
      return read({
        work: async ({ repository }) => {
          await administrator({ adminId, repository })
          const source = await repository.source({ sessionId })
          const share = one({ rows: await repository.bySession({ sessionId }) })
          let images = source.images.map(projectImage)
          let hasUnavailablePublishedImages = false
          if (share?.status === 'published' && !share.isDeleted) {
            try {
              const published = await repository.source({
                artifactIds: storedIds({ share }),
                sessionId,
              })
              images = [
                ...published.images.map(projectImage),
                ...images.filter((image) => !published.images.some((item) => item.id === image.id)),
              ]
            } catch (error) {
              if (!(error instanceof GenerationError) || error.code !== 'NOT_FOUND') {
                throw error
              }
              hasUnavailablePublishedImages = true
            }
          }
          return freezeCatalogValue({
            value: {
              hasUnavailablePublishedImages,
              images,
              sessionId,
              share:
                share && !share.isDeleted
                  ? {
                      artifactIds: storedIds({ share }),
                      key: share.publicKey,
                      status: share.status,
                      title: share.title,
                    }
                  : null,
              templateId: source.templateId,
              title: source.title,
            },
          })
        },
      })
    },
    list: async ({ adminId, afterId = null }: { adminId: number; afterId?: null | number }) => {
      requestId({ value: adminId })
      if (afterId !== null) {
        requestId({ value: afterId })
      }
      return read({
        work: async ({ repository }) => {
          await administrator({ adminId, repository })
          const rows = await repository.sessions({ afterId, limit: 21 })
          const items = rows
            .slice(0, 20)
            .map(({ id, templateId, title }) => ({ id, templateId, title }))
          return freezeCatalogValue({
            value: { items, nextAfterId: rows.length > 20 ? items.at(-1)!.id : null },
          })
        },
      })
    },
    previewImage: async ({
      adminId,
      artifactId,
      sessionId,
    }: {
      adminId: number
      artifactId: number
      sessionId: number
    }) => {
      requestId({ value: adminId })
      requestId({ value: sessionId })
      requestId({ value: artifactId })
      const resolve = () =>
        read({
          work: async ({ repository }) => {
            await administrator({ adminId, repository })
            return repository.source({ artifactIds: [artifactId], sessionId })
          },
        })
      const before = await resolve()
      const image = before.images[0]!
      const bytes = await readImage({ mediaId: image.mediaId, userId: before.userId })
      const after = await resolve()
      if (after.userId !== before.userId || after.images[0]?.mediaId !== image.mediaId) {
        throw new GenerationError({ code: 'NOT_FOUND' })
      }
      return bytes
    },
    publish: async ({ adminId, input }: { adminId: number; input: unknown }) => {
      requestId({ value: adminId })
      const command = libraryInput({
        fields: ['sessionId', 'artifactIds', 'title', 'confirmed'],
        value: input,
      })
      const sessionId = requestId({ value: command.sessionId })
      const artifactIds = selectedIds({ value: command.artifactIds })
      if (command.confirmed !== true) {
        throw new GenerationError({ code: 'INPUT_INVALID' })
      }
      let title: string
      try {
        title = normalizeSessionTitle({ value: command.title })
      } catch {
        throw new GenerationError({ code: 'INPUT_INVALID' })
      }
      const candidate = makeKey()
      if (!validKey({ key: candidate })) {
        throw new Error('Invalid host share key generator.')
      }
      const now = generationTime({ now: clock() })
      return write({
        resource: `session-share:${sessionId}`,
        work: async ({ repository }) => {
          await administrator({ adminId, repository })
          const source = await repository.source({ artifactIds, sessionId })
          const before = one({ rows: await repository.bySession({ sessionId }) })
          if (before?.isDeleted) {
            throw new GenerationError({ code: 'NOT_FOUND' })
          }
          const artifactIdsJson = JSON.stringify(artifactIds)
          if (
            before?.status === 'published' &&
            before.title === title &&
            before.artifactIdsJson === artifactIdsJson
          ) {
            return publicationReceipt({ share: before })
          }
          const publicKey = before?.status === 'published' ? before.publicKey : candidate
          const collision = await repository.byKey({ key: publicKey })
          if (collision.length > 1 || collision.some((row) => row.id !== before?.id)) {
            throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
          }
          const after = await repository.save({
            actor: `admin:${adminId}`,
            before,
            data: {
              artifactIdsJson,
              isDeleted: false,
              publicKey,
              sessionId,
              status: 'published',
              templateId: source.templateId,
              title,
            },
            now,
          })
          await repository.audit({ adminId, after, before, now })
          return publicationReceipt({ share: after })
        },
      })
    },
    revoke: async ({ adminId, sessionId }: { adminId: number; sessionId: number }) => {
      requestId({ value: adminId })
      requestId({ value: sessionId })
      const now = generationTime({ now: clock() })
      return write({
        resource: `session-share:${sessionId}`,
        work: async ({ repository }) => {
          await administrator({ adminId, repository })
          const before = one({ rows: await repository.bySession({ sessionId }) })
          if (!before || before.isDeleted || before.status === 'revoked') {
            return { revoked: true as const }
          }
          const { id: _id, ...data } = before
          const after = await repository.save({
            actor: `admin:${adminId}`,
            before,
            data: { ...data, status: 'revoked' },
            now,
          })
          await repository.audit({ adminId, after, before, now })
          return { revoked: true as const }
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
  repository: ShareReader
}) {
  const admin = await repository.admin({ adminId })
  if (!admin || admin.id !== adminId || admin.role !== 'admin' || admin.status !== 'active') {
    throw new AdminCommandError({ code: 'ADMIN_FORBIDDEN', outcome: 'not_started' })
  }
}
async function resolve({
  artifactId,
  key,
  repository,
}: {
  artifactId?: number
  key: string
  repository: ShareReader
}) {
  if (!validKey({ key })) {
    throw new GenerationError({ code: 'NOT_FOUND' })
  }
  const share = one({ rows: await repository.byKey({ key }) })
  if (!share || share.isDeleted || share.status !== 'published') {
    throw new GenerationError({ code: 'NOT_FOUND' })
  }
  const artifactIds = storedIds({ share })
  if (artifactId !== undefined && !artifactIds.includes(artifactId)) {
    throw new GenerationError({ code: 'NOT_FOUND' })
  }
  const source = await repository.source({ artifactIds, sessionId: share.sessionId })
  if (source.id !== share.sessionId || source.templateId !== share.templateId) {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
  return { share, source }
}
function selectedIds({ value }: { value: unknown }): number[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 20 ||
    new Set(value).size !== value.length
  ) {
    throw new GenerationError({ code: 'INPUT_INVALID' })
  }
  return value.map((value) => requestId({ value }))
}
function storedIds({ share }: { share: SessionShare }) {
  try {
    return selectedIds({ value: JSON.parse(share.artifactIdsJson) })
  } catch {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
}
function one({ rows }: { rows: readonly SessionShare[] }): null | SessionShare {
  if (rows.length > 1) {
    throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
  }
  return rows[0] ?? null
}
function validKey({ key }: { key: unknown }): boolean {
  return typeof key === 'string' && /^[\w-]{32}$/.test(key)
}
function projectImage({ id, createdAt, height, width }: SharedImage): SharedImage {
  return { id, createdAt, height, width }
}
function publicationReceipt({ share }: { share: SessionShare }) {
  return freezeCatalogValue({
    value: { key: share.publicKey, sessionId: share.sessionId, templateId: share.templateId },
  })
}
function publicView({ share, source }: Awaited<ReturnType<typeof resolve>>) {
  return freezeCatalogValue({
    value: {
      images: source.images.map(projectImage),
      key: share.publicKey,
      templateId: share.templateId,
      title: share.title,
    },
  })
}
