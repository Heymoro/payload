export function requirePublicationAdministrator({
  admin,
}: {
  admin: null | Readonly<{ id: number; role: string; status: string }>
}): Readonly<{ id: number; role: 'admin' | 'operator'; status: 'active' }> {
  if (
    !admin ||
    admin.status !== 'active' ||
    (admin.role !== 'admin' && admin.role !== 'operator')
  ) {
    throw new TemplatePublicationError('UNAUTHENTICATED')
  }
  return Object.freeze({ id: admin.id, role: admin.role, status: admin.status })
}

export function isPublicationUTC({ value }: { value: unknown }): boolean {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

export class TemplatePublicationError extends Error {
  readonly status: number
  constructor(
    readonly code:
      | 'DATA_INTEGRITY_CONFLICT'
      | 'INPUT_INVALID'
      | 'NOT_FOUND'
      | 'PUBLICATION_CONFLICT'
      | 'UNAUTHENTICATED',
  ) {
    super(`Template publication ${code}.`)
    this.name = 'TemplatePublicationError'
    this.status =
      code === 'INPUT_INVALID'
        ? 400
        : code === 'UNAUTHENTICATED'
          ? 401
          : code === 'NOT_FOUND'
            ? 404
            : code === 'DATA_INTEGRITY_CONFLICT'
              ? 503
              : 409
  }
}
