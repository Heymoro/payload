import type { CollectionConfig } from 'payload'

export const WechatIdentities: CollectionConfig = {
  slug: 'wechatIdentities',
  access: {
    admin: () => false,
    create: () => false,
    delete: () => false,
    read: () => false,
    update: () => false,
  },
  admin: {
    useAsTitle: 'openId',
  },
  fields: [
    {
      name: 'appId',
      type: 'text',
      maxLength: 128,
      required: true,
    },
    {
      name: 'openId',
      type: 'text',
      maxLength: 256,
      required: true,
    },
    {
      name: 'unionId',
      type: 'text',
      maxLength: 256,
    },
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
    },
  ],
  indexes: [
    {
      fields: ['appId', 'openId'],
      unique: true,
    },
  ],
}
