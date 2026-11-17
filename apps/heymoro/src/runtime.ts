export type RuntimeEnvironment = {
  DATABASE_URL?: string
  NODE_ENV?: string
  PAYLOAD_SECRET?: string
  PUBLIC_API_URL?: string
  UPLOAD_DIR?: string
  WECHAT_APP_ID?: string
  WECHAT_APP_SECRET?: string
  WECHAT_AUTH_PROVIDER?: string
}

export type RuntimeConfig = {
  databaseUrl: string
  nodeEnv: 'development' | 'production' | 'test'
  payloadSecret: string
  publicApiUrl: string
  uploadDir: string
  wechatAppId: string
  wechatAppSecret: string
  wechatAuthProvider: 'mock' | 'wechat'
}

function required(env: RuntimeEnvironment, name: keyof RuntimeEnvironment): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new Error(`${String(name)} is required`)
  }
  return value
}

function rejectPlaceholder(name: string, value: string): string {
  if (/YOUR_|replace-with|change-me|example\.com|^secret-value$/i.test(value)) {
    throw new Error(`${name} must contain a real deployment value`)
  }
  return value
}

export function readRuntimeConfig(env: RuntimeEnvironment = process.env): RuntimeConfig {
  const rawNodeEnv = env.NODE_ENV?.trim() || 'development'
  if (!['development', 'production', 'test'].includes(rawNodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production')
  }
  const nodeEnv = rawNodeEnv as RuntimeConfig['nodeEnv']
  const databaseUrl = required(env, 'DATABASE_URL')
  const payloadSecret = required(env, 'PAYLOAD_SECRET')
  const uploadDir = required(env, 'UPLOAD_DIR')
  const publicApiUrl = required(env, 'PUBLIC_API_URL').replace(/\/$/, '')
  const provider = (env.WECHAT_AUTH_PROVIDER?.trim() ||
    'wechat') as RuntimeConfig['wechatAuthProvider']

  if (provider !== 'wechat' && provider !== 'mock') {
    throw new Error('WECHAT_AUTH_PROVIDER must be wechat or mock')
  }
  if (nodeEnv === 'production' && provider === 'mock') {
    throw new Error('WECHAT_AUTH_PROVIDER=mock is not allowed in production')
  }
  if (nodeEnv === 'production' && !uploadDir.startsWith('/')) {
    throw new Error('UPLOAD_DIR must be an absolute path in production')
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(publicApiUrl)
  } catch {
    throw new Error('PUBLIC_API_URL must be a valid URL')
  }
  if (nodeEnv === 'production' && parsedUrl.protocol !== 'https:') {
    throw new Error('PUBLIC_API_URL must use HTTPS in production')
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('PUBLIC_API_URL must not contain credentials')
  }

  if (nodeEnv === 'production' && payloadSecret.length < 32) {
    throw new Error('PAYLOAD_SECRET must be at least 32 characters in production')
  }

  if (provider === 'mock') {
    return {
      databaseUrl,
      nodeEnv,
      payloadSecret,
      publicApiUrl,
      uploadDir,
      wechatAppId: env.WECHAT_APP_ID?.trim() || 'mock-app-id',
      wechatAppSecret: '',
      wechatAuthProvider: 'mock',
    }
  }

  const wechatAppId = rejectPlaceholder('WECHAT_APP_ID', required(env, 'WECHAT_APP_ID'))
  const wechatAppSecret = rejectPlaceholder('WECHAT_APP_SECRET', required(env, 'WECHAT_APP_SECRET'))
  if (!/^wx[\w-]{8,}$/.test(wechatAppId)) {
    throw new Error('WECHAT_APP_ID has an invalid format')
  }

  return {
    databaseUrl,
    nodeEnv,
    payloadSecret,
    publicApiUrl,
    uploadDir,
    wechatAppId,
    wechatAppSecret,
    wechatAuthProvider: 'wechat',
  }
}
