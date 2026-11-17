import { setTimeout as sleep } from 'node:timers/promises'

import type { CoreConfig } from '../../runtime/config.js'

import { generationQueue, namingQueue } from './generation-jobs.js'

export function configuredGenerationQueues({
  config,
}: {
  config: Pick<CoreConfig, 'execution' | 'image' | 'naming' | 'quote'>
}): string[] {
  return [
    ...(config.image && config.execution && config.quote ? [generationQueue] : []),
    ...(config.naming ? [namingQueue] : []),
  ]
}

/** One claimed job at a time; shutdown waits for its existing delivery/settlement contract. */
export async function consumeGenerationJobs({
  intervalMs = 1000,
  isContinuous = false,
  queues,
  run,
  signal = new AbortController().signal,
}: {
  intervalMs?: number
  isContinuous?: boolean
  queues: readonly string[]
  run: (args: {
    limit: number
    overrideAccess: true
    queue: string
    sequential: true
  }) => Promise<unknown>
  signal?: AbortSignal
}): Promise<void> {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000) {
    throw new Error('Invalid generation consumer polling interval.')
  }
  if (queues.length === 0) {
    return
  }
  do {
    for (const queue of queues) {
      if (signal.aborted) {
        return
      }
      await run({ limit: isContinuous ? 1 : 5, overrideAccess: true, queue, sequential: true })
    }
    if (!isContinuous || signal.aborted) {
      return
    }
    try {
      await sleep(intervalMs, undefined, { signal })
    } catch (error) {
      if (!signal.aborted || (error as Error).name !== 'AbortError') {
        throw error
      }
    }
  } while (!signal.aborted)
}
