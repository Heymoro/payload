import { createHmac, timingSafeEqual } from 'node:crypto'

import { GenerationError } from './generation.js'

/** Only the authenticated canonical envelope is shared; each caller rebuilds its own trusted scope. */
export function createSignedCursor({ cursorKey }: { cursorKey: Uint8Array }) {
  if (!(cursorKey instanceof Uint8Array) || cursorKey.length < 32) {
    throw new Error('Signed cursor requires an explicit key of at least 32 bytes.')
  }
  const key = Buffer.from(cursorKey)
  const encode = ({ value }: { value: unknown }) => {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`
  }
  const decode = <T>({
    normalize,
    token,
  }: {
    normalize: (value: unknown) => T
    token: string
  }): T => {
    try {
      if (typeof token !== 'string' || token.length > 2048 || !/^[\w-]+\.[\w-]{43}$/.test(token)) {
        invalid()
      }
      const [body, signature] = token.split('.') as [string, string]
      const bytes = Buffer.from(body, 'base64url')
      const supplied = Buffer.from(signature, 'base64url')
      const expected = createHmac('sha256', key).update(body).digest()
      if (
        bytes.toString('base64url') !== body ||
        supplied.length !== expected.length ||
        supplied.toString('base64url') !== signature ||
        !timingSafeEqual(supplied, expected)
      ) {
        invalid()
      }
      const value = normalize(JSON.parse(bytes.toString('utf8')) as unknown)
      // Reconstruct from trusted fields, never JSON.stringify the untrusted parsed object.
      if (encode({ value }) !== token) {
        invalid()
      }
      return value
    } catch {
      return invalid()
    }
  }
  return Object.freeze({ decode, encode })
}
function invalid(): never {
  throw new GenerationError({ code: 'INPUT_INVALID' })
}
