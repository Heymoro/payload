import type { ClientRequest, IncomingMessage, RequestOptions, ServerResponse } from 'node:http'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { Transform } from 'node:stream'

export type StorageEvent = Readonly<{
  completed: boolean
  contentType?: string
  elapsedMs: number
  hasSigV4Authorization: boolean
  ifNoneMatch?: '*'
  method: string
  path: string
  phase: string
  requestBytes: number
  requestSHA256: string
  responseBytes: number
  responseSHA256: string
  sequence: number
  upstreamStatus?: number
}>
export type ObserverBudget = {
  deadlineMs: number
  maxBytes: number
  maxEvents: number
  maxInflight: number
}
export type RequestFactory = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest

/** Transparent transport only. No cache, signing, object emulation, business responses or body capture. */
export function createS3Observer({
  bucket,
  budget,
  endpoint,
  phase,
  requestFactory = httpRequest,
}: {
  bucket: string
  budget: ObserverBudget
  endpoint: string
  phase: () => string
  requestFactory?: RequestFactory
}) {
  const destination = new URL(endpoint)
  assert(
    destination.protocol === 'http:' &&
      destination.hostname === '127.0.0.1' &&
      destination.port &&
      destination.pathname === '/' &&
      !destination.username &&
      !destination.password &&
      !destination.search &&
      !destination.hash,
    'Owned MinIO loopback endpoint required.',
  )
  assert(/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket))
  for (const value of Object.values(budget)) {
    assert(Number.isSafeInteger(value) && value > 0)
  }
  assert(
    budget.maxBytes <= 128 * 1048576 &&
      budget.maxEvents <= 1024 &&
      budget.maxInflight <= 8 &&
      budget.deadlineMs <= 30000,
  )
  const events: StorageEvent[] = []
  const inflight = new Set<() => void>()
  let bytes = 0
  let sequence = 0
  let isFailed = false
  let isClosed = false
  const failAll = () => {
    isFailed = true
    for (const cancel of [...inflight]) {
      cancel()
    }
  }
  const handle = ({
    request,
    response,
  }: {
    request: IncomingMessage
    response: ServerResponse
  }) => {
    const pathname = request.url?.split('?')[0] ?? ''
    // Bucket is unique per run; only official objects and real verifier probes are observable.
    const isOwnedPath =
      pathname === `/${bucket}` ||
      pathname === `/${bucket}/` ||
      pathname.startsWith(`/${bucket}/official/examples/`) ||
      pathname.startsWith(`/${bucket}/__heymoro_probe__/`)
    if (
      isClosed ||
      isFailed ||
      !isOwnedPath ||
      !['DELETE', 'GET', 'HEAD', 'PUT'].includes(request.method ?? '') ||
      sequence >= budget.maxEvents ||
      inflight.size >= budget.maxInflight ||
      [...pathname].some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    ) {
      failAll()
      request.destroy()
      response.destroy()
      return
    }
    const currentPhase = phase()
    if (!/^[a-z0-9-]{1,48}$/.test(currentPhase)) {
      failAll()
      request.destroy()
      response.destroy()
      return
    }
    const number = ++sequence
    const started = performance.now()
    const requestHash = createHash('sha256')
    const responseHash = createHash('sha256')
    let requestBytes = 0
    let responseBytes = 0
    let upstreamStatus: number | undefined
    let upstream: ClientRequest | undefined
    let upstreamResponse: IncomingMessage | undefined
    let isDone = false
    let isRequestEnded = false
    const requestTransform = new Transform({
      highWaterMark: 16384,
      transform(chunk: Buffer, _encoding, callback) {
        requestBytes += chunk.length
        bytes += chunk.length
        if (bytes > budget.maxBytes) {
          callback(new Error('Observer throughput budget exceeded.'))
          return
        }
        requestHash.update(chunk)
        callback(null, chunk)
      },
    })
    const responseTransform = new Transform({
      highWaterMark: 16384,
      transform(chunk: Buffer, _encoding, callback) {
        responseBytes += chunk.length
        bytes += chunk.length
        if (bytes > budget.maxBytes) {
          callback(new Error('Observer throughput budget exceeded.'))
          return
        }
        responseHash.update(chunk)
        callback(null, chunk)
      },
    })
    const finish = ({ completed }: { completed: boolean }) => {
      if (isDone) {
        return
      }
      isDone = true
      clearTimeout(timer)
      inflight.delete(cancel)
      const type = request.headers['content-type']
      events.push(
        Object.freeze({
          method: request.method!,
          path: pathname,
          phase: currentPhase,
          sequence: number,
          ...(request.headers['if-none-match'] === '*' ? { ifNoneMatch: '*' as const } : {}),
          ...(typeof type === 'string' && ['application/octet-stream', 'image/png'].includes(type)
            ? { contentType: type }
            : {}),
          hasSigV4Authorization:
            typeof request.headers.authorization === 'string' &&
            request.headers.authorization.startsWith('AWS4-HMAC-SHA256 '),
          requestBytes,
          requestSHA256: requestHash.digest('hex'),
          responseBytes,
          responseSHA256: responseHash.digest('hex'),
          ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
          completed,
          elapsedMs: performance.now() - started,
        }),
      )
    }
    const cancel = () => {
      finish({ completed: false })
      request.unpipe(requestTransform)
      upstreamResponse?.unpipe(responseTransform)
      requestTransform.destroy()
      responseTransform.destroy()
      upstream?.destroy()
      upstreamResponse?.destroy()
      request.destroy()
      response.destroy()
    }
    const fail = () => {
      isFailed = true
      cancel()
    }
    const timer = setTimeout(fail, budget.deadlineMs)
    timer.unref()
    inflight.add(cancel)
    for (const stream of [request, response, requestTransform, responseTransform]) {
      stream.once('error', fail)
    }
    request.once('aborted', fail)
    request.once('end', () => {
      isRequestEnded = true
    })
    request.once('close', () => {
      if (!isRequestEnded) {
        fail()
      }
    })
    response.once('finish', () => finish({ completed: isRequestEnded }))
    response.once('close', () => {
      if (!isDone) {
        fail()
      }
    })
    try {
      upstream = requestFactory(
        {
          agent: false,
          headers: request.rawHeaders,
          hostname: destination.hostname,
          method: request.method,
          path: request.url,
          port: destination.port,
          protocol: 'http:',
        },
        (incoming) => {
          if (isDone) {
            incoming.destroy()
            return
          }
          upstreamResponse = incoming
          upstreamStatus = incoming.statusCode
          incoming.once('error', fail)
          incoming.once('aborted', fail)
          response.writeHead(incoming.statusCode!, incoming.rawHeaders)
          incoming.pipe(responseTransform).pipe(response)
        },
      )
      upstream.once('error', fail)
      // checkContinue on the listener suppresses Node's automatic Continue; only upstream authorizes it.
      upstream.once('continue', () => {
        if (!isDone) {
          response.writeContinue()
        }
      })
      if (request.headers.expect?.toLowerCase() === '100-continue') {
        upstream.flushHeaders()
      }
      request.pipe(requestTransform).pipe(upstream)
    } catch {
      fail()
    }
  }
  return {
    close: () => {
      isClosed = true
      if (inflight.size) {
        isFailed = true
      }
      for (const cancel of [...inflight]) {
        cancel()
      }
      return Promise.resolve()
    },
    get events(): readonly StorageEvent[] {
      return [...events].sort((a, b) => a.sequence - b.sequence)
    },
    get failed() {
      return isFailed
    },
    handle,
  }
}

export async function startS3Observer(args: Parameters<typeof createS3Observer>[0]) {
  const observer = createS3Observer(args)
  const server = createServer((request, response) => observer.handle({ request, response }))
  server.on('checkContinue', (request, response) => observer.handle({ request, response }))
  server.maxConnections = args.budget.maxInflight
  server.headersTimeout = args.budget.deadlineMs
  server.requestTimeout = args.budget.deadlineMs
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address !== 'string' && address.address === '127.0.0.1')
  let closing: Promise<void> | undefined
  return {
    ...observer,
    endpoint: `http://127.0.0.1:${address.port}`,
    // Preserve live getters, not a snapshot spread.
    close: () =>
      (closing ??= (async () => {
        await observer.close()
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      })()),
    get events() {
      return observer.events
    },
    get failed() {
      return observer.failed
    },
  }
}
