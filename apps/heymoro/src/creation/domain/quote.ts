import { errors, jwtVerify, SignJWT } from 'jose'

import { GenerationError, generationTime, integer, nonblank } from './generation.js'

export type QuoteBinding = Readonly<{
  configurationHash: string
  costCredits: number
  inputHash?: string
  purpose: 'generate' | 'regenerate'
  sessionId: number
  sourceArtifactId?: number
  templateId: number
  userId: number
}>
export type QuoteClaims = QuoteBinding & Readonly<{ exp: number; iat: number }>
export type QuoteCodec = Readonly<{
  issue: (args: {
    binding: QuoteBinding
    now: string
  }) => Promise<{ quoteToken: string; validUntil: string }>
  verify: (args: { now: string; token: string }) => Promise<QuoteClaims>
}>

/** Fixed algorithm and a copied local trust store; JWT headers never trigger key discovery or network access. */
export function createQuoteCodec({
  audience,
  issuer,
  keys,
  signingKid,
  ttlSeconds,
}: {
  audience: string
  issuer: string
  keys: Readonly<Record<string, Uint8Array>>
  signingKid: string
  ttlSeconds: number
}): QuoteCodec {
  for (const value of [issuer, audience, signingKid]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) {
      throw new Error('Explicit quote issuer, audience and signing kid are required.')
    }
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) {
    throw new Error('Quote TTL must be 1–3600 seconds.')
  }
  const trustedKeys = new Map<string, Uint8Array>()
  for (const [kid, key] of Object.entries(keys)) {
    if (!kid.trim() || kid.length > 200 || !(key instanceof Uint8Array) || key.byteLength < 32) {
      throw new Error('Quote keys require a nonempty kid and at least 32 bytes.')
    }
    trustedKeys.set(kid, new Uint8Array(key))
  }
  const signingKey = trustedKeys.get(signingKid)
  if (!signingKey) {
    throw new Error('Quote signing key must exist in the explicit trust store.')
  }
  return Object.freeze({
    issue: async ({ binding, now }) => {
      const iat = Math.floor(Date.parse(generationTime({ now })) / 1000)
      const claims = parseClaims({ ttlSeconds, value: { ...binding, exp: iat + ttlSeconds, iat } })
      const quoteToken = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256', kid: signingKid, typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(audience)
        .sign(signingKey)
      return { quoteToken, validUntil: new Date(claims.exp * 1000).toISOString() }
    },
    verify: async ({ now, token }) => {
      const currentDate = new Date(generationTime({ now }))
      try {
        if (typeof token !== 'string' || token.length > 8192) {
          throw new Error()
        }
        const { payload } = await jwtVerify(
          token,
          (header) => {
            if (
              header.alg !== 'HS256' ||
              typeof header.kid !== 'string' ||
              header.typ !== 'JWT' ||
              header.jku !== undefined ||
              header.jwk !== undefined ||
              header.x5u !== undefined
            ) {
              throw new Error()
            }
            const key = trustedKeys.get(header.kid)
            if (!key) {
              throw new Error()
            }
            return key
          },
          {
            algorithms: ['HS256'],
            audience,
            clockTolerance: 0,
            currentDate,
            issuer,
            requiredClaims: ['iat', 'exp', 'iss', 'aud'],
          },
        )
        const claims = parseClaims({ ttlSeconds, value: payload })
        if (claims.iat > Math.floor(currentDate.getTime() / 1000)) {
          throw new Error()
        }
        return claims
      } catch (error) {
        throw new GenerationError({
          code: error instanceof errors.JWTExpired ? 'QUOTE_EXPIRED' : 'QUOTE_CHANGED',
        })
      }
    },
  })
}

function parseClaims({
  ttlSeconds,
  value,
}: {
  ttlSeconds: number
  value: Record<string, unknown>
}): QuoteClaims {
  const purpose = value.purpose
  if (purpose !== 'generate' && purpose !== 'regenerate') {
    throw new GenerationError({ code: 'QUOTE_CHANGED' })
  }
  const iat = integer({ minimum: 0, value: value.iat })
  const exp = integer({ minimum: 0, value: value.exp })
  if (exp <= iat || exp - iat > ttlSeconds) {
    throw new GenerationError({ code: 'QUOTE_CHANGED' })
  }
  const common = {
    configurationHash: nonblank({ value: value.configurationHash }),
    costCredits: integer({ minimum: 0, value: value.costCredits }),
    exp,
    iat,
    purpose,
    sessionId: integer({ value: value.sessionId }),
    templateId: integer({ value: value.templateId }),
    userId: integer({ value: value.userId }),
  }
  if (!/^[a-f0-9]{64}$/.test(common.configurationHash) || value.templateVersionId !== undefined) {
    throw new GenerationError({ code: 'QUOTE_CHANGED' })
  }
  if (purpose === 'generate') {
    const inputHash = nonblank({ value: value.inputHash })
    if (!/^[a-f0-9]{64}$/.test(inputHash) || value.sourceArtifactId !== undefined) {
      throw new GenerationError({ code: 'QUOTE_CHANGED' })
    }
    return { ...common, inputHash, purpose }
  }
  if (value.inputHash !== undefined) {
    throw new GenerationError({ code: 'QUOTE_CHANGED' })
  }
  return { ...common, purpose, sourceArtifactId: integer({ value: value.sourceArtifactId }) }
}
