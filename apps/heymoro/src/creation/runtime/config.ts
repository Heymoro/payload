import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ExecutionConfiguration } from '../domain/generation.js'
import type { IdentityPolicy } from '../domain/identity.js'
import type { ImageLimits } from '../domain/image.js'
import type { InputSchema } from '../domain/template-config.js'
import type { RedisCoordinationConfig } from '../infrastructure/redis/coordinator.js'
import type { S3Backend, S3Limits } from '../infrastructure/s3/object-storage.js'

import { parseIdentityPolicy } from '../domain/identity.js'
import { validateImageLimits } from '../domain/image.js'
import { createQuoteCodec } from '../domain/quote.js'
import { validateHostCaps } from '../domain/template-config.js'
import { createImageEngine } from '../infrastructure/ai/image-engine.js'
import { createNamingEngine } from '../infrastructure/ai/naming-engine.js'
import { createRedisCreationCoordinator } from '../infrastructure/redis/coordinator.js'
import { readPrivateJSON } from './private-json.js'

export type CoreConfig = Readonly<{
  capabilities: readonly string[]
  cursorKey: string
  dataDir: string
  execution: ExecutionConfiguration | null
  hostCaps: InputSchema
  identity: IdentityPolicy
  image: null | Omit<Parameters<typeof createImageEngine>[0], 'fetch'>
  imageLimits: ImageLimits
  naming: null | Omit<Parameters<typeof createNamingEngine>[0], 'clientFactory' | 'fetch'>
  namingWorker: Readonly<{ engineTimeoutMs: number; leaseMs: number }>
  payloadSecret: string
  publicApiUrl: string
  quote: null | Readonly<{
    audience: string
    issuer: string
    keys: Readonly<Record<string, string>>
    signingKid: string
    ttlSeconds: number
  }>
  redis: Readonly<{ connectTimeoutMs: number; url: string }> & RedisCoordinationConfig
  s3: Readonly<{
    backends: readonly S3Backend[]
    input: { backend: string; bucket: string }
    limits: S3Limits
    output: { backend: string; bucket: string }
  }>
  worker: Readonly<{ engineTimeoutMs: number; leaseMs: number }>
}>
export const projectRoot =
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..') + path.sep

export function assertNoDangerousMode() {
  for (const name of ['PAYLOAD_DROP_DATABASE', 'PAYLOAD_MIGRATING']) {
    if (process.env[name] && process.env[name] !== 'false') {
      throw new Error(`Forbidden core mode: ${name}.`)
    }
  }
}

export function readCoreConfig({
  filename = process.env.HEYMORO_CORE_CONFIG_FILE,
}: { filename?: string } = {}): CoreConfig {
  assertNoDangerousMode()
  const value = readPrivateJSON({
    fileMessage: 'Invalid external core configuration file.',
    filename,
    maxBytes: 65_536,
    pathMessage: 'HEYMORO_CORE_CONFIG_FILE requires an external absolute JSON configuration path.',
    projectRoot,
  })
  const config = parseCoreConfig({ value })
  assertNoDevelopmentDataInProduction({ dataDir: config.dataDir })
  return config
}

/** Production host inputs must never open the persistent developer profile, including aliases. */
export function assertNoDevelopmentDataInProduction({
  dataDir,
  mode = process.env.NODE_ENV,
}: {
  dataDir: string
  mode?: string
}) {
  if (mode !== 'production') {
    return
  }
  const starts = new Set([path.resolve(dataDir)])
  try {
    starts.add(realpathSync(dataDir))
  } catch (error) {
    if (!isAbsentPath({ error })) {
      throw new Error('Invalid production data directory.')
    }
  }
  for (const start of starts) {
    let directory = start
    while (true) {
      let hasMarker = false
      try {
        lstatSync(path.join(directory, 'local-profile.json'))
        hasMarker = true
      } catch (error) {
        if (!isAbsentPath({ error })) {
          throw new Error('Invalid production data directory.')
        }
      }
      if (hasMarker) {
        throw new Error('Local development data is forbidden in production.')
      }
      const parent = path.dirname(directory)
      if (parent === directory) {
        break
      }
      directory = parent
    }
  }
}

/** JSON is the sole host input. No environment defaults or caller-controlled test switches. */
export function parseCoreConfig({ value }: { value: unknown }): CoreConfig {
  try {
    const config = object({
      keys: [
        'dataDir',
        'publicApiUrl',
        'payloadSecret',
        'cursorKey',
        'hostCaps',
        'imageLimits',
        'capabilities',
        'redis',
        's3',
        'execution',
        'quote',
        'image',
        'naming',
        'worker',
        'namingWorker',
        'identity',
      ],
      value,
    })
    if (!path.isAbsolute(string(config.dataDir)) || string(config.payloadSecret).length < 32) {
      throw new Error()
    }
    const identity = parseIdentityPolicy({ value: config.identity })
    secretKey(config.cursorKey)
    const api = new URL(string(config.publicApiUrl))
    if (
      !['http:', 'https:'].includes(api.protocol) ||
      api.username ||
      api.password ||
      api.search ||
      api.hash
    ) {
      throw new Error()
    }
    const caps = object({
      keys: [
        'minImages',
        'maxImages',
        'allowedMimeTypes',
        'maxImageBytes',
        'maxTotalImageBytes',
        'maxDescriptionLength',
        'maxNotesLength',
      ],
      value: config.hostCaps,
    })
    for (const key of ['minImages', 'maxImages']) {
      integer(caps[key], 0, 16)
    }
    for (const key of ['maxDescriptionLength', 'maxNotesLength']) {
      integer(caps[key], 0, 10000)
    }
    integer(caps.maxImageBytes, 1, 5_000_000)
    integer(caps.maxTotalImageBytes, 1, 20_000_000)
    if (
      !Array.isArray(caps.allowedMimeTypes) ||
      !caps.allowedMimeTypes.length ||
      caps.allowedMimeTypes.some(
        (mime) => !['image/jpeg', 'image/png', 'image/webp'].includes(String(mime)),
      ) ||
      Number(caps.minImages) > Number(caps.maxImages)
    ) {
      throw new Error()
    }
    if (
      !Array.isArray(config.capabilities) ||
      config.capabilities.some((item) => typeof item !== 'string' || !/^[\w.-]{1,64}$/.test(item))
    ) {
      throw new Error()
    }
    validateHostCaps({ hostCaps: caps })
    const redis = object({
      keys: [
        'url',
        'connectTimeoutMs',
        'namespace',
        'leaseMs',
        'renewEveryMs',
        'maxHoldMs',
        'acquireTimeoutMs',
        'retryDelayMs',
        'commandTimeoutMs',
      ],
      value: config.redis,
    })
    const redisURL = new URL(string(redis.url))
    if (
      !['redis:', 'rediss:'].includes(redisURL.protocol) ||
      !redisURL.hostname ||
      !redisURL.port ||
      redisURL.search ||
      redisURL.hash ||
      (redisURL.pathname !== '' && !/^\/(?:0|[1-9]\d*)?$/.test(redisURL.pathname))
    ) {
      throw new Error()
    }
    integer(redis.connectTimeoutMs, 1, 60000)
    createRedisCreationCoordinator({
      client: { eval: () => Promise.resolve(null), set: () => Promise.resolve(null) },
      config: redis as CoreConfig['redis'],
    })
    for (const name of ['worker', 'namingWorker']) {
      const budget = object({ keys: ['engineTimeoutMs', 'leaseMs'], value: config[name] })
      integer(budget.engineTimeoutMs, 1, 300000)
      integer(budget.leaseMs, Number(budget.engineTimeoutMs), 600000)
    }
    const s3 = object({ keys: ['backends', 'limits', 'input', 'output'], value: config.s3 })
    const limits = object({
      keys: ['connectionTimeoutMs', 'maxBytes', 'operationTimeoutMs', 'requestTimeoutMs'],
      value: s3.limits,
    })
    for (const name of Object.keys(limits)) {
      integer(limits[name], 1, name === 'maxBytes' ? 32 * 1024 * 1024 : 60000)
    }
    if (!Array.isArray(s3.backends) || !s3.backends.length) {
      throw new Error()
    }
    const names = new Set<string>()
    for (const backend of s3.backends) {
      const b = object({
        keys: ['backend', 'buckets', 'credentials', 'endpoint', 'forcePathStyle', 'region'],
        value: backend,
      })
      const endpoint = new URL(string(b.endpoint))
      if (
        !/^[a-z0-9][\w.-]{0,63}$/i.test(string(b.backend)) ||
        names.has(string(b.backend)) ||
        !['http:', 'https:'].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        endpoint.search ||
        typeof b.forcePathStyle !== 'boolean'
      ) {
        throw new Error()
      }
      names.add(string(b.backend))
      string(b.region)
      if (
        !Array.isArray(b.buckets) ||
        !b.buckets.length ||
        b.buckets.some(
          (bucket) =>
            typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket),
        )
      ) {
        throw new Error()
      }
      const credentials = object({
        keys: ['accessKeyId', 'secretAccessKey'],
        optional: ['sessionToken'],
        value: b.credentials,
      })
      for (const item of Object.values(credentials)) {
        string(item)
      }
    }
    for (const name of ['input', 'output']) {
      const destination = object({ keys: ['backend', 'bucket'], value: s3[name] })
      if (
        typeof destination.backend !== 'string' ||
        typeof destination.bucket !== 'string' ||
        !/^[a-z0-9][\w.-]{0,63}$/i.test(destination.backend) ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(destination.bucket) ||
        !s3.backends.some(
          (backend) =>
            backend.backend === destination.backend && backend.buckets.includes(destination.bucket),
        )
      ) {
        throw new Error()
      }
    }
    if (config.quote !== null) {
      const quote = object({
        keys: ['audience', 'issuer', 'keys', 'signingKid', 'ttlSeconds'],
        value: config.quote,
      })
      if (!quote.keys || typeof quote.keys !== 'object' || Array.isArray(quote.keys)) {
        throw new Error()
      }
      for (const key of Object.values(quote.keys)) {
        secretKey(key)
      }
      createQuoteCodec({
        ...(quote as Omit<NonNullable<CoreConfig['quote']>, 'keys'>),
        keys: Object.fromEntries(
          Object.entries(quote.keys).map(([kid, key]) => [
            kid,
            Buffer.from(string(key), 'base64url'),
          ]),
        ),
      })
    }
    // SDK adapters validate their own remaining request details. JSON permits only their typed primitives.
    for (const name of ['image', 'naming']) {
      if (config[name] !== null) {
        const provider = object({
          keys: ['apiKey', 'timeoutMs', 'engineBudgetMs', 'registered'],
          optional:
            name === 'image'
              ? ['maxInputBytes', 'maxTotalInputBytes', 'maxResponseBytes', 'maxOutputBytes']
              : ['maxInputBytes', 'maxResponseBytes'],
          value: config[name],
        })
        if (/[\r\n]/.test(string(provider.apiKey))) {
          throw new Error()
        }
        integer(provider.timeoutMs, 1, 300000)
        integer(
          provider.engineBudgetMs,
          Number(provider.timeoutMs),
          Number(
            (config[name === 'image' ? 'worker' : 'namingWorker'] as Record<string, unknown>)
              .engineTimeoutMs,
          ),
        )
        if (provider.maxInputBytes !== undefined) {
          integer(provider.maxInputBytes, 1, 5_000_000)
        }
        if (provider.maxTotalInputBytes !== undefined) {
          integer(provider.maxTotalInputBytes, 1, 20_000_000)
        }
        if (provider.maxOutputBytes !== undefined) {
          integer(provider.maxOutputBytes, 1, 32_000_000)
        }
        if (provider.maxResponseBytes !== undefined) {
          integer(provider.maxResponseBytes, 1, name === 'image' ? 48_000_000 : 1_000_000)
        }
        if (name === 'image') {
          if (!Array.isArray(provider.registered) || !provider.registered.length) {
            throw new Error()
          }
          for (const item of provider.registered) {
            const entry = object({ keys: ['executorId', 'model', 'provider'], value: item })
            string(entry.executorId)
            if (entry.model !== 'gpt-image-1.5' || entry.provider !== 'openai') {
              throw new Error()
            }
          }
        } else if (provider.registered !== null) {
          const entry = object({
            keys: ['model', 'provider', 'parameters'],
            value: provider.registered,
          })
          string(entry.model)
          if (entry.provider !== 'openai') {
            throw new Error()
          }
          const parameters = object({ keys: ['max_output_tokens'], value: entry.parameters })
          integer(parameters.max_output_tokens, 1, 1024)
          if (
            !/^[a-z0-9][\w.:-]{0,127}$/i.test(String(entry.model)) ||
            String(entry.model).startsWith('gpt-image')
          ) {
            throw new Error()
          }
          for (const parameter of Object.values(parameters)) {
            if (typeof parameter !== 'number' || !Number.isFinite(parameter)) {
              throw new Error()
            }
          }
        }
      }
    }
    const result = { ...config, identity } as unknown as CoreConfig
    object({
      keys: ['allowedMimeTypes', 'maxBytes', 'maxPixels', 'timeoutMs'],
      value: result.imageLimits,
    })
    validateImageLimits({ limits: result.imageLimits })
    referenceImageLimits({ hostCaps: result.hostCaps, imageLimits: result.imageLimits })
    if (result.imageLimits.maxBytes > result.s3.limits.maxBytes) {
      throw new Error()
    }
    if (result.execution !== null) {
      object({ keys: ['registry', 'storageOutput'], value: result.execution })
      if (
        result.execution.storageOutput.backend !== result.s3.output.backend ||
        result.execution.storageOutput.bucket !== result.s3.output.bucket
      ) {
        throw new Error()
      }
      object({ keys: ['backend', 'bucket', 'keyRule'], value: result.execution.storageOutput })
      if (
        !result.execution.registry ||
        typeof result.execution.registry !== 'object' ||
        Array.isArray(result.execution.registry)
      ) {
        throw new Error()
      }
      if (
        !Object.keys(result.execution.registry).length ||
        result.execution.storageOutput.keyRule !== 'task-attempt-result-v1'
      ) {
        throw new Error()
      }
      for (const [executorId, executor] of Object.entries(result.execution.registry)) {
        object({
          keys: ['provider', 'model', 'allowedParameters', 'parameterRules', 'storageBackends'],
          value: executor,
        })
        if (
          executor.provider !== 'openai' ||
          executor.model !== 'gpt-image-1.5' ||
          !Array.isArray(executor.allowedParameters) ||
          !Array.isArray(executor.storageBackends)
        ) {
          throw new Error()
        }
        if (!/^[A-Z0-9][\w.-]{0,63}$/i.test(executorId)) {
          throw new Error()
        }
        if (
          !executor.storageBackends.includes(result.s3.output.backend) ||
          executor.storageBackends.some(
            (backend) => typeof backend !== 'string' || !names.has(backend),
          ) ||
          new Set(executor.allowedParameters).size !== executor.allowedParameters.length ||
          executor.allowedParameters.some(
            (parameter) =>
              !['background', 'input_fidelity', 'moderation', 'quality', 'size'].includes(
                parameter,
              ),
          )
        ) {
          throw new Error()
        }
        object({ keys: [...executor.allowedParameters], value: executor.parameterRules })
        for (const rule of Object.values(executor.parameterRules)) {
          if (rule.type === 'string') {
            object({ keys: ['type', 'values'], optional: ['isRequired'], value: rule })
            if (
              !Array.isArray(rule.values) ||
              !rule.values.length ||
              rule.values.some((item) => typeof item !== 'string')
            ) {
              throw new Error()
            }
          } else if (rule.type === 'number') {
            object({
              keys: ['type', 'minimum', 'maximum'],
              optional: ['isRequired', 'isInteger'],
              value: rule,
            })
            if (
              !Number.isFinite(rule.minimum) ||
              !Number.isFinite(rule.maximum) ||
              rule.minimum > rule.maximum ||
              (rule.isInteger !== undefined && typeof rule.isInteger !== 'boolean')
            ) {
              throw new Error()
            }
          } else if (rule.type === 'boolean') {
            object({ keys: ['type'], optional: ['isRequired'], value: rule })
          } else {
            throw new Error()
          }
          if (rule.isRequired !== undefined && typeof rule.isRequired !== 'boolean') {
            throw new Error()
          }
        }
        if (
          result.image &&
          !result.image.registered.some(
            (item) =>
              item.executorId === executorId &&
              item.provider === executor.provider &&
              item.model === executor.model,
          )
        ) {
          throw new Error()
        }
      }
    }
    if (result.image) {
      createImageEngine(result.image)
    }
    if (result.naming) {
      createNamingEngine(result.naming)
    }
    return freeze(JSON.parse(JSON.stringify(result)) as CoreConfig)
  } catch {
    throw new Error('Invalid core configuration fields or types.')
  }
}
/** Reference uploads use host input caps; generated outputs retain the global decoder policy. */
export function referenceImageLimits({
  hostCaps,
  imageLimits,
}: {
  hostCaps: Pick<InputSchema, 'allowedMimeTypes' | 'maxImageBytes' | 'maxImages'>
  imageLimits: ImageLimits
}): ImageLimits {
  if (hostCaps.maxImages === 0) {
    return imageLimits
  }
  if (
    hostCaps.maxImageBytes > imageLimits.maxBytes ||
    hostCaps.allowedMimeTypes.some((mime) => !imageLimits.allowedMimeTypes.includes(mime))
  ) {
    throw new Error('Reference input caps exceed the global image decoder policy.')
  }
  return Object.freeze({
    ...imageLimits,
    allowedMimeTypes: Object.freeze([...hostCaps.allowedMimeTypes]),
    maxBytes: hostCaps.maxImageBytes,
  })
}
function object({
  keys,
  optional = [],
  value,
}: {
  keys: string[]
  optional?: string[]
  value: unknown
}): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  ) {
    throw new Error()
  }
  const record: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      (!keys.includes(key) && !optional.includes(key)) ||
      !descriptor ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    ) {
      throw new Error()
    }
    record[key] = descriptor.value
  }
  if (keys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error()
  }
  return record
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) {
    throw new Error()
  }
  return value
}
function integer(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error()
  }
}
function secretKey(value: unknown) {
  const key = string(value)
  if (
    !/^[\w-]{43,512}$/.test(key) ||
    Buffer.from(key, 'base64url').toString('base64url') !== key ||
    Buffer.from(key, 'base64url').length < 32
  ) {
    throw new Error()
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freeze(child)
    }
    Object.freeze(value)
  }
  return value
}

function isAbsentPath({ error }: { error: unknown }): boolean {
  return (
    error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))
  )
}
