export type HttpRequest = Pick<Partial<Request>, 'body' | 'bodyUsed' | 'signal' | 'url'> &
  Pick<Request, 'headers'>

export type HttpRequestCode =
  | 'HTTP_BODY_TOO_LARGE'
  | 'HTTP_REQUEST_TIMEOUT'
  | 'HTTP_UNSUPPORTED_MEDIA_TYPE'
  | 'INPUT_INVALID'

export class HttpRequestError extends Error {
  readonly code: HttpRequestCode
  constructor({ code }: { code: HttpRequestCode }) {
    super('Invalid HTTP request.')
    this.name = 'HttpRequestError'
    this.code = code
  }
}

export function assertNoQuery({ request }: { request: HttpRequest }): void {
  if (typeof request.url !== 'string' || request.url.includes('?')) {
    throw invalid()
  }
}

export const CREATION_JSON_MAX_BYTES = 131072

export async function readJSONBody({
  maxBytes = 16384,
  request,
}: {
  maxBytes?: number
  request: HttpRequest
}): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('HTTP byte budget must be a positive safe integer.')
  }
  const contentType = request.headers.get('content-type') ?? ''
  if (
    !/^application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i.test(contentType.trim())
  ) {
    throw new HttpRequestError({ code: 'HTTP_UNSUPPORTED_MEDIA_TYPE' })
  }
  const bytes = await readRequestBytes({ maxBytes, request })
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw invalid()
  }
}

export async function assertEmptyBody({ request }: { request: HttpRequest }): Promise<void> {
  if ((await readRequestBytes({ request })).byteLength !== 0) {
    throw invalid()
  }
}

/** One deadline covers the entire stream, including slow trickles. Cancellation never owns the deadline. */
export async function readRequestBytes({
  maxBytes = 16384,
  request,
  timeoutMs = 5000,
}: {
  maxBytes?: number
  request: HttpRequest
  timeoutMs?: number
}): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new RangeError('HTTP budgets must be positive safe integers.')
  }
  const { body, signal } = request
  if (
    typeof request.bodyUsed !== 'boolean' ||
    !signal ||
    body === undefined ||
    request.bodyUsed ||
    signal.aborted ||
    body?.locked
  ) {
    throw invalid()
  }
  if (!body) {
    return new Uint8Array()
  }
  const reader = body.getReader()
  const deadline = performance.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  let interrupt: (error: HttpRequestError) => void = () => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = reject
  })
  const onAbort = () => interrupt(invalid())
  let isComplete = false
  try {
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(
      () => interrupt(new HttpRequestError({ code: 'HTTP_REQUEST_TIMEOUT' })),
      timeoutMs,
    )
    if (signal.aborted) {
      throw invalid()
    }
    const bytes = await Promise.race([collectBody({ deadline, maxBytes, reader }), interrupted])
    if (signal.aborted) {
      throw invalid()
    }
    if (performance.now() >= deadline) {
      throw new HttpRequestError({ code: 'HTTP_REQUEST_TIMEOUT' })
    }
    isComplete = true
    return bytes
  } catch (error) {
    if (error instanceof HttpRequestError) {
      throw error
    }
    throw invalid()
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    if (!isComplete) {
      void reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
}

async function collectBody({
  deadline,
  maxBytes,
  reader,
}: {
  deadline: number
  maxBytes: number
  reader: ReadableStreamDefaultReader<Uint8Array>
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    if (performance.now() >= deadline) {
      throw new HttpRequestError({ code: 'HTTP_REQUEST_TIMEOUT' })
    }
    const { done, value } = await reader.read()
    if (performance.now() >= deadline) {
      throw new HttpRequestError({ code: 'HTTP_REQUEST_TIMEOUT' })
    }
    if (done) {
      break
    }
    if (!(value instanceof Uint8Array)) {
      throw invalid()
    }
    total += value.byteLength
    if (total > maxBytes) {
      throw new HttpRequestError({ code: 'HTTP_BODY_TOO_LARGE' })
    }
    if (value.byteLength !== 0) {
      chunks.push(Uint8Array.from(value))
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function invalid() {
  return new HttpRequestError({ code: 'INPUT_INVALID' })
}
