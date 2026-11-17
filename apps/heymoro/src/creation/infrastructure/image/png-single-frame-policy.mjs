/** PNG loader metadata does not expose APNG frames; inspect bounded chunks, never payload substrings. */
export function assertSingleFramePNG({ assertDeadline, bytes }) {
  assertDeadline()
  if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024) {
    throw new Error('PNG input exceeds supported bounds.')
  }
  if (
    bytes.length < 8 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error('Invalid PNG signature.')
  }
  let offset = 8
  let hasHeader = false
  let hasPalette = false
  let hasImageData = false
  let hasEndedImageData = false
  while (offset < bytes.length) {
    assertDeadline()
    if (bytes.length - offset < 12) {
      throw new Error('Truncated PNG chunk.')
    }
    const length = bytes.readUInt32BE(offset)
    if (length > 0x7fffffff || length > bytes.length - offset - 12) {
      throw new Error('PNG chunk exceeds input bounds.')
    }
    const end = offset + length + 12
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) {
      throw new Error('Invalid PNG chunk type.')
    }
    let crc = 0xffffffff
    for (let index = offset + 4; index < end - 4; index++) {
      if ((index - (offset + 4)) % 16384 === 0) {
        assertDeadline()
      }
      crc = (crc >>> 8) ^ pngCRCTable[(crc ^ bytes[index]) & 255]
    }
    if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(end - 4)) {
      throw new Error('Invalid PNG chunk CRC.')
    }
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) {
      throw new Error('Animated PNG is unsupported.')
    }
    if (!hasHeader && type !== 'IHDR') {
      throw new Error('PNG header must be first.')
    }
    if (type === 'IHDR') {
      if (hasHeader || length !== 13) {
        throw new Error('Invalid PNG header.')
      }
      hasHeader = true
    } else if (type === 'PLTE') {
      if (hasPalette || hasImageData || !length || length > 768 || length % 3) {
        throw new Error('Invalid PNG palette.')
      }
      hasPalette = true
    } else if (type === 'IDAT') {
      if (hasEndedImageData) {
        throw new Error('PNG image data chunks must be consecutive.')
      }
      hasImageData = true
    } else if (type === 'IEND') {
      if (length !== 0 || !hasImageData || end !== bytes.length) {
        throw new Error('Invalid PNG end or trailing bytes.')
      }
      assertDeadline()
      return
    } else if (type[0] === type[0].toUpperCase()) {
      throw new Error('Unknown critical PNG chunk.')
    }
    if (hasImageData && type !== 'IDAT') {
      hasEndedImageData = true
    }
    offset = end
  }
  throw new Error('Missing PNG end chunk.')
}

const pngCRCTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let entry = value
  for (let bit = 0; bit < 8; bit++) {
    entry = (entry >>> 1) ^ (entry & 1 ? 0xedb88320 : 0)
  }
  return entry >>> 0
})
