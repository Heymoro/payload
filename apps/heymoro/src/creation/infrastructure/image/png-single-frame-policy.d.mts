import type { Buffer } from 'node:buffer'

export declare function assertSingleFramePNG(args: {
  bytes: Buffer
  assertDeadline: () => void
}): void
