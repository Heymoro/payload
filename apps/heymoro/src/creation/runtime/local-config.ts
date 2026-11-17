import path from 'node:path'

import { parseCoreConfig, projectRoot } from './config.js'

/** Developer-only defaults. Persist the resulting private JSON once, outside the checkout. */
export function createLocalCoreConfig({
  root,
  secrets,
}: {
  root: string
  secrets: {
    cursorKey: string
    payloadSecret: string
    quoteKey: string
    storageSecret: string
    storageUser: string
  }
}) {
  const relative = path.relative(projectRoot, root)
  if (!path.isAbsolute(root) || (relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('Local development requires an external absolute data directory.')
  }
  return parseCoreConfig({
    value: {
      capabilities: ['v1'],
      cursorKey: secrets.cursorKey,
      dataDir: path.join(root, 'data'),
      execution: {
        registry: {
          'openai-image-v1': {
            allowedParameters: ['size', 'quality'],
            model: 'gpt-image-1.5',
            parameterRules: {
              quality: { type: 'string', isRequired: false, values: ['low', 'medium', 'high'] },
              size: { type: 'string', isRequired: true, values: ['1024x1024'] },
            },
            provider: 'openai',
            storageBackends: ['local-minio'],
          },
        },
        storageOutput: {
          backend: 'local-minio',
          bucket: 'heymoro-output',
          keyRule: 'task-attempt-result-v1',
        },
      },
      hostCaps: {
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        maxDescriptionLength: 2000,
        maxImageBytes: 5_000_000,
        maxImages: 16,
        maxNotesLength: 500,
        maxTotalImageBytes: 20_000_000,
        minImages: 0,
      },
      identity: { sessionTtlSeconds: 604800, trial: null, wechat: null },
      image: null,
      imageLimits: {
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        maxBytes: 5_000_000,
        maxPixels: 20_000_000,
        timeoutMs: 5000,
      },
      naming: null,
      namingWorker: { engineTimeoutMs: 10000, leaseMs: 30000 },
      payloadSecret: secrets.payloadSecret,
      publicApiUrl: 'http://127.0.0.1:3001',
      quote: {
        audience: 'heymoro:admission',
        issuer: 'heymoro:local',
        keys: { local: secrets.quoteKey },
        signingKid: 'local',
        ttlSeconds: 120,
      },
      redis: {
        acquireTimeoutMs: 5000,
        commandTimeoutMs: 2000,
        connectTimeoutMs: 2000,
        leaseMs: 10000,
        maxHoldMs: 30000,
        namespace: 'heymoro-local',
        renewEveryMs: 2000,
        retryDelayMs: 25,
        url: 'redis://127.0.0.1:16379/0',
      },
      s3: {
        backends: [
          {
            backend: 'local-minio',
            buckets: ['heymoro-input', 'heymoro-output'],
            credentials: {
              accessKeyId: secrets.storageUser,
              secretAccessKey: secrets.storageSecret,
            },
            endpoint: 'http://127.0.0.1:19000',
            forcePathStyle: true,
            region: 'us-east-1',
          },
        ],
        input: { backend: 'local-minio', bucket: 'heymoro-input' },
        limits: {
          connectionTimeoutMs: 1000,
          maxBytes: 16_000_000,
          operationTimeoutMs: 20000,
          requestTimeoutMs: 10000,
        },
        output: { backend: 'local-minio', bucket: 'heymoro-output' },
      },
      worker: { engineTimeoutMs: 180000, leaseMs: 210000 },
    },
  })
}
