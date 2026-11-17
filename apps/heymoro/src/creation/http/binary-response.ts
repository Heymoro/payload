export function binaryResponse({
  bytes,
  mimeType,
  requestId,
}: {
  bytes: Uint8Array
  mimeType: string
  requestId: string
}): Response {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      'cache-control': 'private, no-store',
      'content-disposition': `inline; filename="image.${extension}"`,
      'content-length': String(bytes.byteLength),
      'content-type': mimeType,
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
    },
  })
}
