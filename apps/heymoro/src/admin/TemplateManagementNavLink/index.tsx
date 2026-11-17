import type { ServerProps } from 'payload'

import { headers } from 'next/headers'
import Link from 'next/link'
import { formatAdminURL } from 'payload/shared'

import { requireNativeAdmin } from '../../creation/http/native-admin-auth.js'

export async function TemplateManagementNavLink({ payload }: ServerProps) {
  try {
    await requireNativeAdmin({ headers: await headers(), payload })
  } catch {
    return null
  }
  return (
    <Link
      className="nav__link"
      href={formatAdminURL({ adminRoute: payload.config.routes.admin, path: '/templates' })}
    >
      模板管理
    </Link>
  )
}
