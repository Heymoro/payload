import type { CollectionConfig, PayloadRequest } from 'payload'

import { isAdministratorPrincipal, isStaffPrincipal, isUserPrincipal } from '../auth-principals.js'
import { writeAuditLog } from '../service-audit.js'
import { assertAttachableMedia, attachmentIds } from '../service-media.js'
import { RECORD_LIMITS } from '../service-records.js'

const ownRecords = ({ req }: { req: PayloadRequest }) => {
  const user = req.user
  if (!isUserPrincipal(user) || !user) {
    return false
  }
  return { owner: { equals: user.id } }
}

export const Records: CollectionConfig = {
  slug: 'records',
  access: {
    admin: ({ req }) => isStaffPrincipal(req.user),
    create: ({ req }) => isUserPrincipal(req.user) || isAdministratorPrincipal(req.user),
    delete: ({ req }) => {
      if (isAdministratorPrincipal(req.user)) {
        return true
      }
      return ownRecords({ req })
    },
    read: ({ req }) => {
      if (isStaffPrincipal(req.user)) {
        return true
      }
      return ownRecords({ req })
    },
    update: ({ req }) => {
      if (isAdministratorPrincipal(req.user)) {
        return true
      }
      return ownRecords({ req })
    },
  },
  admin: {
    useAsTitle: 'title',
  },
  fields: [
    {
      name: 'owner',
      type: 'relationship',
      access: {
        read: ({ req }) => isStaffPrincipal(req.user),
        update: () => false,
      },
      admin: { readOnly: true },
      relationTo: 'users',
      required: true,
    },
    {
      name: 'title',
      type: 'text',
      hooks: {
        beforeValidate: [({ value }) => (typeof value === 'string' ? value.trim() : value)],
      },
      maxLength: RECORD_LIMITS.title.max,
      minLength: RECORD_LIMITS.title.min,
      required: true,
    },
    {
      name: 'body',
      type: 'textarea',
      maxLength: RECORD_LIMITS.body.max,
    },
    {
      name: 'attachments',
      type: 'relationship',
      hasMany: true,
      maxRows: RECORD_LIMITS.attachments.max,
      relationTo: 'media',
    },
    {
      name: 'lifecycle',
      type: 'select',
      access: {
        update: ({ req }) => isAdministratorPrincipal(req.user),
      },
      defaultValue: 'active',
      options: [
        { label: 'Active', value: 'active' },
        { label: 'Archived', value: 'archived' },
      ],
      required: true,
    },
  ],
  hooks: {
    afterChange: [
      async ({ doc, operation, req }) => {
        if (operation !== 'create' && operation !== 'update') {
          return doc
        }
        await writeAuditLog({
          action: operation === 'create' ? 'record.create' : 'record.update',
          req,
          resourceId: String(doc.id),
          resourceType: 'record',
          summary: { lifecycle: doc.lifecycle, title: doc.title },
        })
        return doc
      },
    ],
    afterDelete: [
      async ({ doc, req }) => {
        await writeAuditLog({
          action: 'record.delete',
          req,
          resourceId: String(doc.id),
          resourceType: 'record',
          summary: { title: doc.title },
        })
      },
    ],
    beforeChange: [
      async ({ data, operation, originalDoc, req }) => {
        const user = req.user
        if (isUserPrincipal(user) && user) {
          data.owner = user.id
          if (operation === 'create') {
            data.lifecycle = 'active'
          }
          if (operation === 'update' && originalDoc) {
            data.lifecycle = originalDoc.lifecycle
          }
        }
        // Field maxRows validates after this hook; do not query files for an input it will reject.
        if (
          data.attachments !== undefined &&
          (!Array.isArray(data.attachments) ||
            data.attachments.length <= RECORD_LIMITS.attachments.max)
        ) {
          await assertAttachableMedia({
            allowAnyOwner: isAdministratorPrincipal(user),
            ids: attachmentIds(data.attachments),
            req,
            userId: user && isUserPrincipal(user) ? user.id : undefined,
          })
        }
        return data
      },
    ],
  },
}
