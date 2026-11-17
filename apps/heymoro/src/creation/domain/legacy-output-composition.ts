type LegacyOutputCompositionIdentity = Readonly<{
  assetDigest: string
  rendererId: 'duel-card'
  rendererVersion: 1
}>

export type LegacyOutputComposition = Readonly<
  {
    metadata: Readonly<{
      attributes: readonly Readonly<{ label: string; value: string }>[]
      title: string
    }>
  } & LegacyOutputCompositionIdentity
>

/** Decode historical snapshot data only; never register or execute this retired recipe. */
export function parseLegacyOutputComposition({
  value,
}: {
  value: unknown
}): LegacyOutputComposition {
  const recipe = record({
    fields: ['rendererId', 'rendererVersion', 'assetDigest', 'metadata'],
    value,
  })
  const capability = parseLegacyOutputCompositionIdentity({
    value: {
      assetDigest: recipe.assetDigest,
      rendererId: recipe.rendererId,
      rendererVersion: recipe.rendererVersion,
    },
  })
  const metadata = record({ fields: ['title', 'attributes'], value: recipe.metadata })
  const title = singleLine({ maximum: 24, value: metadata.title })
  const attributes = metadata.attributes
  if (
    !Array.isArray(attributes) ||
    Object.getPrototypeOf(attributes) !== Array.prototype ||
    attributes.length < 1 ||
    attributes.length > 3 ||
    Reflect.ownKeys(attributes).length !== attributes.length + 1
  ) {
    throw new Error('Invalid output composition attributes.')
  }
  const copiedAttributes: Readonly<{ label: string; value: string }>[] = []
  for (let index = 0; index < attributes.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(attributes, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('Invalid output composition attribute entry.')
    }
    const attribute = record({ fields: ['label', 'value'], value: descriptor.value })
    copiedAttributes.push(
      Object.freeze({
        label: singleLine({ maximum: 8, value: attribute.label }),
        value: singleLine({ maximum: 12, value: attribute.value }),
      }),
    )
  }
  return Object.freeze({
    assetDigest: capability.assetDigest,
    metadata: Object.freeze({ attributes: Object.freeze(copiedAttributes), title }),
    rendererId: capability.rendererId,
    rendererVersion: capability.rendererVersion,
  })
}

function parseLegacyOutputCompositionIdentity({
  value,
}: {
  value: unknown
}): LegacyOutputCompositionIdentity {
  const capability = record({ fields: ['rendererId', 'rendererVersion', 'assetDigest'], value })
  if (
    capability.rendererId !== 'duel-card' ||
    capability.rendererVersion !== 1 ||
    typeof capability.assetDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(capability.assetDigest)
  ) {
    throw new Error('Invalid output composition identity.')
  }
  return Object.freeze({
    assetDigest: capability.assetDigest,
    rendererId: capability.rendererId,
    rendererVersion: capability.rendererVersion,
  })
}

function record({
  fields,
  value,
}: {
  fields: readonly string[]
  value: unknown
}): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error('Invalid output composition object.')
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== fields.length ||
    keys.some((key) => {
      if (typeof key !== 'string' || !fields.includes(key)) {
        return true
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
    })
  ) {
    throw new Error('Invalid output composition fields.')
  }
  return value as Record<string, unknown>
}

function singleLine({ maximum, value }: { maximum: number; value: unknown }): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    [...value].length > maximum ||
    /[\p{Cc}\p{Cf}\u2028\u2029\uD800-\uDFFF]/u.test(value)
  ) {
    throw new Error('Invalid output composition text.')
  }
  return value
}
