import type { CollectionConfig, PayloadRequest } from 'payload'

import { APIError } from 'payload'

import { isAdministratorPrincipal, isStaffPrincipal } from '../auth-principals.js'
import { writeAuditLog } from '../service-audit.js'

async function requireAnotherAdministrator({
  id,
  req,
}: {
  id: number | string
  req: PayloadRequest
}) {
  const others = await req.payload.count({
    collection: 'admins',
    overrideAccess: true,
    req,
    where: {
      and: [
        { role: { equals: 'admin' } },
        { status: { equals: 'active' } },
        { id: { not_equals: id } },
      ],
    },
  })
  if (others.totalDocs === 0) {
    throw new APIError('LAST_ACTIVE_ADMIN: 至少保留一名启用的管理员', 400)
  }
}

export const Admins: CollectionConfig = {
  slug: 'admins',
  access: {
    admin: ({ req }) => isStaffPrincipal(req.user),
    create: ({ req }) => isAdministratorPrincipal(req.user),
    delete: ({ req }) => isAdministratorPrincipal(req.user),
    read: ({ req }) => isStaffPrincipal(req.user),
    update: ({ req }) => isAdministratorPrincipal(req.user),
  },
  admin: {
    useAsTitle: 'email',
  },
  auth: {
    maxLoginAttempts: 5,
    tokenExpiration: 60 * 60 * 8,
  },
  fields: [
    {
      name: 'role',
      type: 'select',
      defaultValue: 'operator',
      options: [
        { label: 'Administrator', value: 'admin' },
        { label: 'Operator', value: 'operator' },
      ],
      required: true,
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'active',
      options: [
        { label: 'Active', value: 'active' },
        { label: 'Disabled', value: 'disabled' },
      ],
      required: true,
    },
  ],
  hooks: {
    afterChange: [
      async ({ doc, operation, req }) => {
        if (operation === 'update' && req.user) {
          await writeAuditLog({
            action: 'admin.update',
            req,
            resourceId: String(doc.id),
            resourceType: 'admin',
            summary: { role: doc.role, status: doc.status },
          })
        }
        return doc
      },
    ],
    beforeChange: [
      async ({ data, operation, originalDoc, req }) => {
        if (operation === 'create') {
          const existing = await req.payload.count({
            collection: 'admins',
            overrideAccess: true,
            req,
          })
          if (existing.totalDocs === 0) {
            data.role = 'admin'
            data.status = 'active'
          }
        } else if (
          originalDoc?.role === 'admin' &&
          originalDoc.status === 'active' &&
          ((data.role !== undefined && data.role !== 'admin') ||
            (data.status !== undefined && data.status !== 'active'))
        ) {
          await requireAnotherAdministrator({ id: originalDoc.id, req })
        }
        return data
      },
    ],
    beforeDelete: [
      async ({ id, req }) => {
        const original = await req.payload.findByID({
          id,
          collection: 'admins',
          overrideAccess: true,
          req,
        })
        if (original.role === 'admin' && original.status === 'active') {
          await requireAnotherAdministrator({ id, req })
        }
      },
    ],
    beforeLogin: [
      ({ user }) => {
        if (user.status !== 'active') {
          throw new Error('管理员账号已被停用')
        }
      },
    ],
    beforeOperation: [
      ({ args, operation }) => {
        // Protect the invariant one document at a time; bulk hooks run in parallel.
        if (
          (operation === 'update' || operation === 'delete') &&
          !('id' in args && args.id !== undefined)
        ) {
          throw new APIError('ADMIN_BULK_NOT_SUPPORTED: 请逐个修改管理员', 400)
        }
        return args
      },
    ],
  },
}
