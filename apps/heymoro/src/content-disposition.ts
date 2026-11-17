export function contentDisposition({ filename }: { filename: string }): string {
  const clean = filename.replace(/[\r\n"\\]/g, '_')
  const ascii = clean.replace(/[^\x20-\x7E]/g, '_') || 'download'
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
