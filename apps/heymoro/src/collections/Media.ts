import type { CollectionConfig, PayloadRequest, Where } from 'payload'

import path from 'node:path'

import { isAdministratorPrincipal, isStaffPrincipal, isUserPrincipal } from '../auth-principals.js'
import { ALLOWED_MEDIA_MIME_TYPES, MEDIA_LIFECYCLES, MEDIA_MAX_BYTES } from '../media/schema.js'

const managementRead = ({ req }: { req: PayloadRequest }) => isStaffPrincipal(req.user)

export const Media: CollectionConfig = {
  slug: 'media',
  access: {
    admin: ({ req }) => isStaffPrincipal(req.user),
    create: ({ req }) => isAdministratorPrincipal(req.user),
    delete: () => false,
    read: ({ req }) => {
      if (isStaffPrincipal(req.user)) {
        return true
      }
      if (isUserPrincipal(req.user) && req.user) {
        const where: Where = {
          and: [{ owner: { equals: req.user.id } }, { lifecycle: { equals: 'active' } }],
        }
        return where
      }
      return false
    },
    update: ({ req }) => isAdministratorPrincipal(req.user),
  },
  fields: [
    {
      name: 'owner',
      type: 'relationship',
      access: {
        read: ({ req }) => isStaffPrincipal(req.user) || isUserPrincipal(req.user),
        update: () => false,
      },
      admin: { readOnly: true },
      relationTo: 'users',
      required: true,
    },
    {
      name: 'alt',
      type: 'text',
      required: true,
    },
    { name: 'originalName', type: 'text', admin: { readOnly: true }, required: true },
    { name: 'storageName', type: 'text', admin: { readOnly: true }, hidden: true, required: true },
    {
      name: 'lifecycle',
      type: 'select',
      admin: { readOnly: true },
      defaultValue: 'active',
      options: MEDIA_LIFECYCLES.map((value) => ({ label: value, value })),
      required: true,
    },
    {
      name: 'pendingDeleteAt',
      type: 'date',
      access: { read: managementRead },
      admin: { readOnly: true },
    },
    {
      name: 'deleteAttempts',
      type: 'number',
      access: { read: managementRead },
      admin: { readOnly: true },
      defaultValue: 0,
      required: true,
    },
    {
      name: 'lastDeleteError',
      type: 'text',
      access: { read: managementRead },
      admin: { readOnly: true },
    },
    // Override only read access; Payload merges its original upload fields and hooks.
    ...(['filename', 'url', 'thumbnailURL'] as const).map((name) => ({
      name,
      type: 'text' as const,
      access: { read: managementRead },
    })),
    { name: 'original', type: 'group', access: { read: managementRead }, fields: [] },
    { name: 'variants', type: 'group', access: { read: managementRead }, fields: [] },
  ],
  hooks: {
    beforeValidate: [
      ({ data, req }) => {
        const file = req.file
        if (file && file.size > MEDIA_MAX_BYTES) {
          throw new Error('FILE_TOO_LARGE')
        }
        return data
      },
    ],
  },
  upload: {
    disableLocalStorage: true,
    filesRequiredOnCreate: false,
    hideRemoveFile: true,
    mimeTypes: [...ALLOWED_MEDIA_MIME_TYPES],
    modifyResponseHeaders: ({ headers }) => {
      headers.set('Cache-Control', 'private,no-store')
      return headers
    },
    pasteURL: false,
    staticDir: path.resolve(process.env.UPLOAD_DIR || './media'),
  },
}
