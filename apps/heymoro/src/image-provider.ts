export type ImageProviderEnvironment = {
  HEYMORO_AUTOMATED_TEST?: string
  HEYMORO_FIXTURE_RESULT?: string
  HEYMORO_IMAGE_PROVIDER?: string
  NODE_ENV?: string
  OPENAI_API_KEY?: string
  OPENAI_IMAGE_MODEL?: string
}

export class ImageProviderError extends Error {
  constructor(
    public code: string,
    public isDefinite: boolean,
  ) {
    super(code)
  }
}

export function readImageProviderConfig(env: ImageProviderEnvironment = process.env) {
  const provider = env.HEYMORO_IMAGE_PROVIDER || 'openai'
  if (provider !== 'openai' && provider !== 'fixture') {
    throw new Error('INVALID_IMAGE_PROVIDER')
  }
  if (
    provider === 'fixture' &&
    (env.NODE_ENV === 'production' || env.HEYMORO_AUTOMATED_TEST !== 'true')
  ) {
    throw new Error('FIXTURE_PROVIDER_TEST_ONLY')
  }
  return {
    configured: provider === 'fixture' || Boolean(env.OPENAI_API_KEY?.trim()),
    fixtureResult: env.HEYMORO_FIXTURE_RESULT || 'succeeded',
    key: env.OPENAI_API_KEY?.trim() || '',
    model: env.OPENAI_IMAGE_MODEL?.trim() || 'gpt-image-1.5',
    provider,
  }
}

export async function generateImage({
  env = process.env,
  fetcher = fetch,
  images,
  prompt,
}: {
  env?: ImageProviderEnvironment
  fetcher?: typeof fetch
  images: { bytes: Buffer; mimeType: string }[]
  prompt: string
}): Promise<Buffer> {
  const config = readImageProviderConfig(env)
  if (!config.configured) {
    throw new ImageProviderError('GENERATION_NOT_CONFIGURED', true)
  }
  if (config.provider === 'fixture') {
    if (config.fixtureResult === 'failed') {
      throw new ImageProviderError('GENERATION_REJECTED', true)
    }
    if (config.fixtureResult === 'unknown') {
      throw new ImageProviderError('GENERATION_OUTCOME_UNKNOWN', false)
    }
    // This deliberately distinct 16px output is enabled only by an explicit automated-test environment.
    return Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWOYfe8VSYhhVMO90VCaPVyTBgCC2WMfrmCsPwAAAABJRU5ErkJggg==',
      'base64',
    )
  }
  let body: FormData | string
  const headers: Record<string, string> = { Authorization: `Bearer ${config.key}` }
  if (images.length) {
    const form = new FormData()
    form.set('model', config.model)
    form.set('prompt', prompt)
    form.set('n', '1')
    form.set('output_format', 'png')
    for (const [index, image] of images.entries()) {
      form.append(
        'image[]',
        new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }),
        `input-${index}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`,
      )
    }
    body = form
  } else {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify({ model: config.model, n: 1, output_format: 'png', prompt })
  }
  let response: Response
  try {
    response = await fetcher(
      `https://api.openai.com/v1/images/${images.length ? 'edits' : 'generations'}`,
      {
        body,
        headers,
        method: 'POST',
        signal: AbortSignal.timeout(180_000),
      },
    )
  } catch {
    throw new ImageProviderError('GENERATION_OUTCOME_UNKNOWN', false)
  }
  if (!response.ok) {
    // A transport/server timeout is ambiguous: never release its reservation or auto-repeat the charge.
    const definite =
      response.status >= 400 && response.status < 500 && ![408, 409].includes(response.status)
    throw new ImageProviderError(
      definite ? 'GENERATION_REJECTED' : 'GENERATION_OUTCOME_UNKNOWN',
      definite,
    )
  }
  try {
    const result = (await response.json()) as { data?: { b64_json?: string }[] }
    if (result.data?.length !== 1 || !result.data[0].b64_json) {
      throw new Error('INVALID_OUTPUT')
    }
    const encoded = result.data[0].b64_json
    if (encoded.length > 15 * 1024 * 1024 || !/^[A-Z0-9+/]+={0,2}$/i.test(encoded)) {
      throw new Error('INVALID_OUTPUT')
    }
    return Buffer.from(encoded, 'base64')
  } catch {
    throw new ImageProviderError('GENERATION_OUTPUT_INVALID', false)
  }
}
