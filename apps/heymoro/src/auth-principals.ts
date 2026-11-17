import type { PayloadRequest } from 'payload'

export type Principal = NonNullable<PayloadRequest['user']>

export function isAdminPrincipal(user: PayloadRequest['user']): boolean {
  return user?.collection === 'admins' && user.status === 'active'
}

export function isStaffPrincipal(user: PayloadRequest['user']): boolean {
  return isAdminPrincipal(user)
}

export function isAdministratorPrincipal(user: PayloadRequest['user']): boolean {
  return user?.collection === 'admins' && user.status === 'active' && user.role === 'admin'
}

export function isOperatorPrincipal(user: PayloadRequest['user']): boolean {
  return user?.collection === 'admins' && user.status === 'active' && user.role === 'operator'
}

export function isUserPrincipal(user: PayloadRequest['user']): boolean {
  return user?.collection === 'users' && user.status === 'active'
}
