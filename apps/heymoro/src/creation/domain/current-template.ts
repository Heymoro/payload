import { createHash } from 'node:crypto'

import type { ExecutionConfiguration, ExecutionPlan, StorageOutput } from './generation.js'
import type { InputSchema, PublicTemplateConfig, TemplateKind } from './template-config.js'

import { compileExecution } from './generation.js'
import { CatalogError, freezeCatalogValue, parsePublicTemplateConfig } from './template-config.js'

export type CurrentTemplateConfiguration = Readonly<{
  costCredits: number
  displayConfigJson: string
  generationConfigJson: string
  id: number
  inputSchemaJson: string
  kind: TemplateKind
  minClientCapability: string
  schemaVersion: number
}>

export type CurrentPublicTemplate = PublicTemplateConfig &
  Readonly<{
    costCredits: number
    minClientCapability: string
    mode: TemplateKind
    schemaVersion: 1
    templateId: number
  }>

export type CompiledCurrentTemplate = Readonly<{
  configurationHash: string
  executionPlan: ExecutionPlan
  publicTemplate: CurrentPublicTemplate
  storageOutput: StorageOutput
}>

/** Compile the single current configuration; only effective execution facts authorize a quote. */
export function compileCurrentTemplate({
  acceptedCapabilities,
  execution,
  hostCaps,
  template,
}: {
  acceptedCapabilities: readonly string[]
  execution: ExecutionConfiguration | null
  hostCaps: InputSchema
  template: CurrentTemplateConfiguration
}): CompiledCurrentTemplate {
  if (
    !Number.isSafeInteger(template.id) ||
    template.id < 1 ||
    !Number.isSafeInteger(template.costCredits) ||
    template.costCredits < 0 ||
    !['effect', 'free'].includes(template.kind) ||
    !acceptedCapabilities.includes(template.minClientCapability)
  ) {
    throw new CatalogError({ code: 'TEMPLATE_UNAVAILABLE' })
  }
  const config = parsePublicTemplateConfig({ ...template, hostCaps })
  const { executionPlan, storageOutput } = compileExecution({
    execution,
    generationConfigJson: template.generationConfigJson,
  })
  const publicTemplate: CurrentPublicTemplate = {
    ...config,
    costCredits: template.costCredits,
    minClientCapability: template.minClientCapability,
    mode: template.kind,
    schemaVersion: 1,
    templateId: template.id,
  }
  const configurationHash = hashEffectiveTemplate({
    costCredits: template.costCredits,
    executionPlan,
    inputSchema: config.inputSchema,
    mode: template.kind,
    storageOutput,
    templateId: template.id,
  })
  return freezeCatalogValue({
    value: { configurationHash, executionPlan, publicTemplate, storageOutput },
  })
}

/** Bind the actual selected plan, including original-plan regeneration, not a mutable row counter. */
export function hashEffectiveTemplate({
  costCredits,
  executionPlan,
  inputSchema,
  mode,
  storageOutput,
  templateId,
}: {
  costCredits: number
  executionPlan: ExecutionPlan
  inputSchema: InputSchema
  mode: TemplateKind
  storageOutput: StorageOutput
  templateId: number
}): string {
  return createHash('sha256')
    .update(
      canonicalJSON({
        value: {
          costCredits,
          executionPlan,
          inputSchema: {
            ...inputSchema,
            allowedMimeTypes: [...inputSchema.allowedMimeTypes].sort(),
          },
          mode,
          storageOutput,
          templateId,
        },
      }),
    )
    .digest('hex')
}

function canonicalJSON({ value }: { value: unknown }): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJSON({ value: item })).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJSON({ value: (value as Record<string, unknown>)[key] })}`,
      )
      .join(',')}}`
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return JSON.stringify(value)
  }
  throw new Error('Unsupported template configuration value.')
}
