import type { CollectionConfig, PayloadRequest } from 'payload'

import { isAdministratorPrincipal, isStaffPrincipal, isUserPrincipal } from '../auth-principals.js'
import { authenticateUserSession } from '../auth-session.js'
import { writeAuditLog } from '../service-audit.js'

const ownUser = ({ req }: { req: PayloadRequest }) => {
  if (!isUserPrincipal(req.user) || !req.user) {
    return false
  }
  return { id: { equals: req.user.id } }
}

export const Users: CollectionConfig = {
  slug: 'users',
  access: {
    admin: ({ req }) => isStaffPrincipal(req.user),
    create: ({ req }) => isAdministratorPrincipal(req.user),
    delete: ({ req }) => isAdministratorPrincipal(req.user),
    read: ({ req }) => isStaffPrincipal(req.user) || ownUser({ req }),
    update: ({ req }) => isAdministratorPrincipal(req.user) || ownUser({ req }),
  },
  admin: {
    useAsTitle: 'displayName',
  },
  auth: {
    disableLocalStrategy: true,
    strategies: [
      {
        name: 'user-session',
        authenticate: authenticateUserSession,
      },
    ],
  },
  fields: [
    {
      name: 'displayName',
      type: 'text',
      maxLength: 80,
      required: true,
    },
    {
      name: 'avatarUrl',
      type: 'text',
      maxLength: 2048,
    },
    {
      name: 'status',
      type: 'select',
      access: {
        update: ({ req }) => isAdministratorPrincipal(req.user),
      },
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
            action: isUserPrincipal(req.user) ? 'user.profile.update' : 'user.update',
            req,
            resourceId: String(doc.id),
            resourceType: 'user',
            summary: { status: doc.status },
          })
        }
        return doc
      },
    ],
    beforeChange: [
      ({ data, operation, originalDoc, req }) => {
        if (isUserPrincipal(req.user)) {
          if (operation === 'update' && originalDoc) {
            data.status = originalDoc.status
          }
          if (operation === 'create') {
            data.status = 'active'
          }
        }
        return data
      },
    ],
  },
}
