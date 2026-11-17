import { GenerationError } from './generation.js'

/** Shared user/AI title rule; normalize edge whitespace, never remove forbidden content. */
export function normalizeSessionTitle({ value }: { value: unknown }): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 100 ||
    /[\p{Cc}\u2028\u2029]/u.test(value)
  ) {
    throw new GenerationError({ code: 'INPUT_INVALID' })
  }
  return value.trim()
}
export function normalizeTitleCommand({ value }: { value: unknown }) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  ) {
    throw new GenerationError({ code: 'INPUT_INVALID' })
  }
  const keys = Reflect.ownKeys(value)
  const property = Object.getOwnPropertyDescriptor(value, 'title')
  if (
    keys.length !== 1 ||
    keys[0] !== 'title' ||
    !property?.enumerable ||
    !Object.hasOwn(property, 'value')
  ) {
    throw new GenerationError({ code: 'INPUT_INVALID' })
  }
  return normalizeSessionTitle({ value: property.value })
}
