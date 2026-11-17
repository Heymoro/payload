import type { ImageClientOptions, ImageParameters } from '@heymoro/ai-engine'

import { createImageClient } from '@heymoro/ai-engine'

import type { GenerationEngine } from '../../application/generation-worker.js'

type Options = ImageClientOptions &
  Readonly<{
    engineBudgetMs: number
    registered: readonly Readonly<{
      executorId: string
      model: 'gpt-image-1.5'
      provider: 'openai'
    }>[]
  }>

/** Compose only the accepted execution snapshot. No draft or template lookup. */
export function createImageEngine(options: Options): GenerationEngine {
  const registered = options.registered.map((item) => ({ ...item }))
  const isBudgetValid =
    Number.isSafeInteger(options.engineBudgetMs) &&
    options.engineBudgetMs > 0 &&
    options.engineBudgetMs <= 300_000 &&
    options.timeoutMs <= options.engineBudgetMs &&
    (options.maxInputBytes ?? 5_000_000) <= 5_000_000 &&
    (options.maxTotalInputBytes ?? 20_000_000) <= 20_000_000
  const generate = createImageClient({
    ...options,
    maxInputBytes: options.maxInputBytes ?? 5_000_000,
    maxTotalInputBytes: options.maxTotalInputBytes ?? 20_000_000,
  })
  return async ({ executionPlan, images, input, signal }) => {
    if (
      !isBudgetValid ||
      executionPlan.provider !== 'openai' ||
      executionPlan.model !== 'gpt-image-1.5' ||
      !registered.some(
        ({ executorId, model, provider }) =>
          executorId === executionPlan.executorId &&
          model === executionPlan.model &&
          provider === executionPlan.provider,
      ) ||
      typeof executionPlan.systemPrompt !== 'string' ||
      !executionPlan.systemPrompt.trim() ||
      typeof input.description !== 'string' ||
      typeof input.userNotes !== 'string'
    ) {
      return { kind: 'not_sent', requestId: null }
    }
    // Version 1 composition: preserve original text/whitespace as ordered substrings.
    const prompt = `[System]\n${executionPlan.systemPrompt}\n\n[Description]\n${input.description}\n\n[User notes]\n${input.userNotes}`
    return generate({
      images,
      model: executionPlan.model,
      parameters: executionPlan.parameters as ImageParameters,
      prompt,
      signal,
    })
  }
}
