import type { HttpRequest } from './request.js'

import { HttpRequestError } from './request.js'

export function readQuery({
  allowedKeys,
  integerKeys = [],
  request,
}: {
  allowedKeys: readonly string[]
  integerKeys?: readonly string[]
  request: Pick<HttpRequest, 'url'>
}): Record<string, number | string> {
  if (typeof request.url !== 'string') {
    throw invalid()
  }
  const separator = request.url.indexOf('?')
  const result: Record<string, number | string> = {}
  if (separator === -1) {
    return result
  }
  const raw = request.url.slice(separator + 1).split('#')[0]!
  if (!raw) {
    return result
  }
  for (const pair of raw.split('&')) {
    const equals = pair.indexOf('=')
    const key = decode({ value: equals === -1 ? pair : pair.slice(0, equals) })
    const value = decode({ value: equals === -1 ? '' : pair.slice(equals + 1) })
    if (!allowedKeys.includes(key) || Object.hasOwn(result, key)) {
      throw invalid()
    }
    result[key] = integerKeys.includes(key) ? parsePathId({ value }) : value
  }
  return result
}

export function parsePathId({ value }: { value: unknown }): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw invalid()
  }
  const id = Number(value)
  if (!Number.isSafeInteger(id)) {
    throw invalid()
  }
  return id
}

function decode({ value }: { value: string }): string {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '))
  } catch {
    throw invalid()
  }
}
function invalid() {
  return new HttpRequestError({ code: 'INPUT_INVALID' })
}
