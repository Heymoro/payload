export function parsePagination(url: URL): { limit: number; page: number } {
  const page = Number(url.searchParams.get('page') ?? '1')
  const limit = Number(url.searchParams.get('limit') ?? '20')
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger((page - 1) * Math.min(limit, 50))
  ) {
    throw new Error('INVALID_PAGINATION')
  }
  return { limit: Math.min(limit, 50), page }
}
