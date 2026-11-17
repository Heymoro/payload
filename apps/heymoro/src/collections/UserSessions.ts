import type { CollectionConfig } from 'payload'

export const UserSessions: CollectionConfig = {
  slug: 'userSessions',
  access: {
    admin: () => false,
    create: () => false,
    delete: () => false,
    read: () => false,
    update: () => false,
  },
  admin: {
    useAsTitle: 'expiresAt',
  },
  fields: [
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
    },
    {
      name: 'tokenHash',
      type: 'text',
      admin: {
        readOnly: true,
      },
      hidden: true,
      required: true,
    },
    {
      name: 'expiresAt',
      type: 'date',
      required: true,
    },
    {
      name: 'revokedAt',
      type: 'date',
    },
  ],
  indexes: [
    {
      fields: ['tokenHash'],
      unique: true,
    },
    {
      fields: ['user', 'expiresAt'],
    },
  ],
}
