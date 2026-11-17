'use server'

import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type {
  ActionResult,
  EditorDTO,
  ManagementOptionsDTO,
  TaxonomyTerm,
  TemplatePage,
  TermPage,
} from './template-management-form.js'

import { MediaError } from '../creation/application/media.js'
import { AdminCommandError } from '../creation/domain/admin.js'
import { GenerationError } from '../creation/domain/generation.js'
import { MediaStorageError } from '../creation/domain/media.js'
import { CatalogError } from '../creation/domain/template-config.js'
import { TemplatePublicationError } from '../creation/domain/template-publication.js'
import { requireNativeAdmin } from '../creation/http/native-admin-auth.js'
import { CreationTransactionError } from '../creation/infrastructure/payload/sqlite-unit-of-work.js'
import { RedisCoordinationError } from '../creation/infrastructure/redis/coordinator.js'
import { getCoreRuntime } from '../creation/runtime/services.js'
import config from '../payload.config.js'
import { assertDraftMetadata, safeFailure, serializeCommand } from './template-management-form.js'

type Data = {
  editor?: EditorDTO
  list?: TemplatePage
  options?: ManagementOptionsDTO
  term?: TaxonomyTerm
  terms?: TermPage
}
const bodyFields = [
  'schemaVersion',
  'minClientCapability',
  'costCredits',
  'displayConfigJson',
  'inputSchemaJson',
  'generationConfigJson',
  'shareConfigJson',
] as const
const commands = {
  create: ['code', 'kind', ...bodyFields],
  createTerm: ['code', 'kind', 'name', 'sortOrder'],
  editor: ['templateId'],
  list: ['afterId', 'keyword', 'status'],
  offline: ['templateId'],
  options: [],
  publish: ['templateId'],
  save: ['templateId', ...bodyFields],
  terms: ['afterId', 'kind', 'status', 'keyword'],
  updateTerm: ['id', 'name', 'status', 'sortOrder'],
} as const
type Action = keyof typeof commands

export async function loadList(input: string) {
  return execute({ action: 'list', serialized: input })
}
export async function loadEditor(input: string) {
  return execute({ action: 'editor', serialized: input })
}
export async function loadOptions(input: string) {
  return execute({ action: 'options', serialized: input })
}
export async function loadTerms(input: string) {
  return execute({ action: 'terms', serialized: input })
}
export async function createTemplate(input: string) {
  return execute({ action: 'create', serialized: input })
}
export async function saveTemplate(input: string) {
  return execute({ action: 'save', serialized: input })
}
export async function publish(input: string) {
  return execute({ action: 'publish', serialized: input })
}
export async function offline(input: string) {
  return execute({ action: 'offline', serialized: input })
}
export async function createTerm(input: string) {
  return execute({ action: 'createTerm', serialized: input })
}
export async function updateTerm(input: string) {
  return execute({ action: 'updateTerm', serialized: input })
}

/** A single bounded command transport; authentication and service authorization run afresh on every call. */
async function execute({
  action,
  serialized,
}: {
  action: Action
  serialized: string
}): Promise<ActionResult<Data>> {
  let confirmed: { templateId?: number; termId?: number } | undefined
  try {
    const payload = await getPayload({ config })
    const admin = await requireNativeAdmin({ headers: await headers(), payload })
    const input = parseCommand({ action, serialized })
    const runtime = getCoreRuntime({ payload })
    const adminId = admin.id
    const editor = async ({ templateId }: { templateId: number }): Promise<EditorDTO> => {
      const template = await runtime.templates.get({ adminId, templateId })
      return { body: template, template }
    }
    if (action === 'options') {
      return {
        data: { options: await runtime.templates.getOptions({ adminId }) },
        ok: true,
        outcome: 'read',
      }
    }
    if (action === 'list') {
      return {
        data: { list: await runtime.templates.list({ adminId, input }) },
        ok: true,
        outcome: 'read',
      }
    }
    if (action === 'editor') {
      return {
        data: { editor: await editor({ templateId: input.templateId as number }) },
        ok: true,
        outcome: 'read',
      }
    }
    if (action === 'terms') {
      return {
        data: { terms: await runtime.taxonomy.listTerms({ adminId, input }) },
        ok: true,
        outcome: 'read',
      }
    }
    if (action === 'createTerm' || action === 'updateTerm') {
      const term =
        action === 'createTerm'
          ? await runtime.taxonomy.createTerm({ adminId, input })
          : await runtime.taxonomy.updateTerm({ adminId, input })
      confirmed = { termId: term.id }
      const terms = await runtime.taxonomy.listTerms({
        adminId,
        input: { keyword: term.code, kind: term.kind },
      })
      const currentTerm = terms.items.find((item) => item.id === term.id)
      if (!currentTerm) {
        throw new TemplatePublicationError('DATA_INTEGRITY_CONFLICT')
      }
      return { data: { term: currentTerm, terms }, ok: true, outcome: 'confirmed' }
    }
    let templateId: number
    if (action === 'create' || action === 'save') {
      const options = await runtime.templates.getOptions({ adminId })
      assertDraftMetadata({ acceptedCapabilities: options.acceptedCapabilities, input })
      const configuration = Object.fromEntries(
        bodyFields.map((name) => [name, input[name]]),
      ) as Parameters<typeof runtime.templates.save>[0]['configuration']
      const saved =
        action === 'create'
          ? await runtime.templates.create({
              adminId,
              code: input.code as string,
              configuration,
              kind: input.kind as 'effect' | 'free',
            })
          : await runtime.templates.save({
              adminId,
              configuration,
              templateId: input.templateId as number,
            })
      templateId = saved.id
      confirmed = { templateId }
    } else {
      const saved = await runtime.templates.setStatus({
        adminId,
        status: action === 'publish' ? 'published' : 'offline',
        templateId: input.templateId as number,
      })
      templateId = saved.id
      confirmed = { templateId }
    }
    return { data: { editor: await editor({ templateId }) }, ok: true, outcome: 'confirmed' }
  } catch (error) {
    const family =
      error instanceof AdminCommandError
        ? 'admin'
        : error instanceof TemplatePublicationError
          ? 'publication'
          : error instanceof CatalogError
            ? 'catalog'
            : error instanceof GenerationError
              ? 'generation'
              : error instanceof MediaError
                ? 'media'
                : error instanceof MediaStorageError
                  ? 'storage'
                  : error instanceof RedisCoordinationError
                    ? 'coordination'
                    : error instanceof CreationTransactionError
                      ? 'transaction'
                      : 'unknown'
    const code =
      error instanceof CreationTransactionError
        ? 'OPERATION_OUTCOME_UNKNOWN'
        : error instanceof AdminCommandError ||
            error instanceof TemplatePublicationError ||
            error instanceof CatalogError ||
            error instanceof GenerationError ||
            error instanceof MediaError ||
            error instanceof MediaStorageError ||
            error instanceof RedisCoordinationError
          ? error.code
          : 'UNKNOWN'
    return { error: safeFailure({ code, family }), ok: false, ...(confirmed ? { confirmed } : {}) }
  }
}
function parseCommand({ action, serialized }: { action: Action; serialized: string }) {
  if (
    typeof serialized !== 'string' ||
    new TextEncoder().encode(serialized).length > 768 * 1024 ||
    new TextEncoder().encode(JSON.stringify(serialized)).length > 900 * 1024
  ) {
    throw new TemplatePublicationError('INPUT_INVALID')
  }
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new TemplatePublicationError('INPUT_INVALID')
  }
  if (
    !record(value) ||
    Object.keys(value).some((key) => !(commands[action] as readonly string[]).includes(key))
  ) {
    throw new TemplatePublicationError('INPUT_INVALID')
  }
  try {
    serializeCommand({ input: value })
  } catch {
    throw new TemplatePublicationError('INPUT_INVALID')
  }
  return value
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
