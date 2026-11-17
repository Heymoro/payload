import type { CreationInput } from '../domain/input.js'
import type { InputSchema } from '../domain/template-config.js'
import type { DraftMedia } from './draft.js'

import { CreationInputError } from '../domain/input.js'

/** Shared draft / quote / submission media rules; no normalization or text rewriting at the adapter layer. */
export async function validateReferenceMedia<T extends DraftMedia>({
  input,
  limits,
  readMedia,
  userId,
}: {
  input: CreationInput
  limits: InputSchema
  readMedia: (args: { mediaId: number }) => Promise<null | T>
  userId: number
}): Promise<T[]> {
  const result: T[] = []
  let totalBytes = 0
  for (const mediaId of input.inputMediaIds) {
    const media = await readMedia({ mediaId })
    if (
      !media ||
      media.id !== mediaId ||
      media.owner !== userId ||
      media.isDeleted ||
      media.visibility !== 'private' ||
      media.purpose !== 'reference' ||
      media.lifecycle !== 'active' ||
      media.mimeType === null ||
      !limits.allowedMimeTypes.includes(media.mimeType) ||
      media.filesize === null ||
      !Number.isSafeInteger(media.filesize) ||
      media.filesize <= 0 ||
      media.filesize > limits.maxImageBytes
    ) {
      throw new CreationInputError({
        message: 'Reference media is unavailable or exceeds the configured limits.',
      })
    }
    totalBytes += media.filesize
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalImageBytes) {
      throw new CreationInputError({ message: 'Reference media exceeds the total byte limit.' })
    }
    result.push(media)
  }
  return result
}
