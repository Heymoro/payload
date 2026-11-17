import type { ExecutionConfiguration, ParameterRule } from '../domain/generation.js'
import type { InputSchema } from '../domain/template-config.js'

import { freezeCatalogValue, validateHostCaps } from '../domain/template-config.js'

export type TemplateManagementOptions = Readonly<{
  acceptedCapabilities: readonly string[]
  execution: ExecutionConfiguration | null
  hostCaps: InputSchema
}>
export type ManagementOptionsDTO = Readonly<{
  acceptedCapabilities: readonly string[]
  executors: readonly Readonly<{
    allowedParameters: readonly string[]
    executorId: string
    model: string
    parameterRules: Readonly<Record<string, ParameterRule>>
    provider: string
  }>[]
  hostCaps: InputSchema
  schemaVersion: 1
}>
export function projectTemplateOptions({
  acceptedCapabilities,
  execution,
  hostCaps,
}: TemplateManagementOptions): ManagementOptionsDTO {
  return freezeCatalogValue({
    value: {
      acceptedCapabilities: [...acceptedCapabilities],
      executors: Object.entries(execution?.registry ?? {}).map(([executorId, executor]) => ({
        allowedParameters: executor.allowedParameters.map((value) => value),
        executorId,
        model: executor.model,
        parameterRules: Object.fromEntries(
          Object.entries(executor.parameterRules).map(([name, rule]) => [
            name,
            rule.type === 'number'
              ? {
                  type: rule.type,
                  maximum: rule.maximum,
                  minimum: rule.minimum,
                  ...(rule.isInteger === undefined ? {} : { isInteger: rule.isInteger }),
                  ...(rule.isRequired === undefined ? {} : { isRequired: rule.isRequired }),
                }
              : rule.type === 'string'
                ? {
                    type: rule.type,
                    values: [...rule.values],
                    ...(rule.isRequired === undefined ? {} : { isRequired: rule.isRequired }),
                  }
                : {
                    type: rule.type,
                    ...(rule.isRequired === undefined ? {} : { isRequired: rule.isRequired }),
                  },
          ]),
        ),
        provider: executor.provider,
      })),
      hostCaps: validateHostCaps({ hostCaps }),
      schemaVersion: 1 as const,
    },
  })
}
