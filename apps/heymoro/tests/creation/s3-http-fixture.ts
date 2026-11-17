import type { IncomingMessage } from 'node:http'

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

export async function startS3HTTPFixture() {
  const objects = new Map<string, { bytes: Buffer; type: string }>()
  const requests: { conditional?: string; key: string; method: string }[] = []
  let beforeRequest: (() => Promise<void> | void) | undefined
  let fault:
    | 'ack-lost'
    | 'forbidden'
    | 'hang'
    | 'ignored-condition'
    | 'none'
    | 'oversize'
    | 'repeat-page'
    | 'truncated' = 'none'
  let conflictStatus = 412
  const server = createServer(async (req, res) => {
    try {
      await beforeRequest?.()
      const url = new URL(req.url!, 'http://fixture.invalid')
      const key = decodeURIComponent(url.pathname).replace(/^\/[^/]+\//, '')
      requests.push({
        conditional: req.headers['if-none-match'] as string | undefined,
        key,
        method: req.method!,
      })
      if (fault === 'hang') {
        return
      }
      if (fault === 'forbidden') {
        res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>')
        return
      }
      if (req.method === 'PUT') {
        const bytes = await body(req)
        if (
          objects.has(key) &&
          req.headers['if-none-match'] === '*' &&
          fault !== 'ignored-condition'
        ) {
          res
            .writeHead(conflictStatus)
            .end(
              `<Error><Code>${conflictStatus === 412 ? 'PreconditionFailed' : 'ConditionalRequestConflict'}</Code></Error>`,
            )
          return
        }
        objects.set(key, { type: req.headers['content-type'] ?? 'application/octet-stream', bytes })
        if (fault === 'ack-lost') {
          fault = 'none'
          req.socket.destroy()
          return
        }
        res.writeHead(200, { ETag: '"not-a-sha"' }).end()
      } else if (req.method === 'DELETE') {
        objects.delete(key)
        res.writeHead(204).end()
      } else if (url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix')!
        const keys = [...objects.keys()].filter((item) => item.startsWith(prefix))
        res
          .writeHead(200, { 'content-type': 'application/xml' })
          .end(
            `<ListBucketResult><IsTruncated>${fault === 'repeat-page'}</IsTruncated>${fault === 'repeat-page' ? '<NextContinuationToken>same</NextContinuationToken>' : ''}${keys.map((item) => `<Contents><Key>${item}</Key><Size>${objects.get(item)!.bytes.length}</Size></Contents>`).join('')}</ListBucketResult>`,
          )
      } else if (req.method === 'GET') {
        const object = objects.get(key)
        if (!object) {
          res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>')
          return
        }
        res.writeHead(200, {
          'content-type': object.type,
          ETag: '"forged"',
          'x-amz-meta-sha256': '0'.repeat(64),
        })
        if (fault === 'oversize') {
          res.end(Buffer.alloc(100_001))
        } else if (fault === 'truncated') {
          res.write(object.bytes.subarray(0, 5))
          setTimeout(() => res.destroy(), 5)
        } else {
          res.end(object.bytes)
        }
      } else {
        res.writeHead(405).end()
      }
    } catch {
      res.destroy()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Fixture bind failed')
  }
  return {
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    credentials: { accessKeyId: randomUUID(), secretAccessKey: randomUUID() },
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    observe: (work: () => Promise<void> | void) => {
      beforeRequest = work
    },
    requests,
    setConflict: (value: number) => {
      conflictStatus = value
    },
    setFault: (value: typeof fault) => {
      fault = value
    },
  }
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks)
}
