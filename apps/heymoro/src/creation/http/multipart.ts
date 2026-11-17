import { File } from 'node:buffer'

import type { HttpRequest } from './request.js'

import { HttpRequestError, readRequestBytes } from './request.js'

/** Bounded wire bytes, then the platform MIME parser. Parsing is not CPU-preemptible or constant-memory. */
export async function readMultipartFile({
  fileMaxBytes,
  request,
  timeoutMs = 30000,
}: {
  fileMaxBytes: number
  request: HttpRequest
  timeoutMs?: number
}): Promise<{ declaredMimeType: string; input: Uint8Array; originalName: string }> {
  if (
    !Number.isSafeInteger(fileMaxBytes) ||
    fileMaxBytes <= 0 ||
    fileMaxBytes > Number.MAX_SAFE_INTEGER - 16384 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new RangeError('Multipart budgets must be positive safe integers.')
  }
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data(?:[\t ]*;|[\t ]*$)/i.test(contentType)) {
    throw new HttpRequestError({ code: 'HTTP_UNSUPPORTED_MEDIA_TYPE' })
  }
  // RFC 2046 bchars, no trailing space; unquoted boundary must also be an HTTP token.
  const match =
    /^multipart\/form-data[\t ]*;[\t ]*boundary[\t ]*=[\t ]*(?:"([\w'()+,\-./:=? ]{1,70})"|([\w'+\-.]{1,70}))[\t ]*$/i.exec(
      contentType,
    )
  if (!match || (match[1] ?? match[2]!).endsWith(' ')) {
    throw invalid()
  }
  const deadline = performance.now() + timeoutMs
  const signal = request.signal
  if (!signal || signal.aborted) {
    throw invalid()
  }
  const check = () => {
    if (signal.aborted) {
      throw invalid()
    }
    if (performance.now() >= deadline) {
      throw new HttpRequestError({ code: 'HTTP_REQUEST_TIMEOUT' })
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let interrupt: (error: HttpRequestError) => void = () => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = reject
  })
  const onAbort = () => interrupt(invalid())
  try {
    check()
    const bytes = await readRequestBytes({ maxBytes: fileMaxBytes + 16384, request, timeoutMs })
    check()
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(
      () => interrupt(new HttpRequestError({ code: 'HTTP_REQUEST_TIMEOUT' })),
      Math.max(1, deadline - performance.now()),
    )
    const form = await Promise.race([
      new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: { 'content-type': contentType },
      }).formData(),
      interrupted,
    ])
    check()
    let file: File | undefined
    for (const [name, value] of form.entries()) {
      if (name !== 'file' || !(value instanceof File) || file) {
        throw invalid()
      }
      file = value
    }
    if (!file) {
      throw invalid()
    }
    if (file.size > fileMaxBytes) {
      throw new HttpRequestError({ code: 'HTTP_BODY_TOO_LARGE' })
    }
    const input = new Uint8Array(await Promise.race([file.arrayBuffer(), interrupted]))
    check()
    return { declaredMimeType: file.type, input, originalName: file.name }
  } catch (error) {
    if (error instanceof HttpRequestError) {
      throw error
    }
    throw invalid()
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
function invalid() {
  return new HttpRequestError({ code: 'INPUT_INVALID' })
}
