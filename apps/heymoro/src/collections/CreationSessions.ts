import type { CollectionConfig } from 'payload'

import { isUserPrincipal } from '../auth-principals.js'

export const TEMPLATE_IDS = ['retro', 'portrait', 'plush', 'garden', 'duel', 'free'] as const

export const CreationSessions: CollectionConfig = {
  slug: 'creation-sessions',
  access: {
    admin: () => false,
    create: () => false,
    delete: () => false,
    read: ({ req }) =>
      isUserPrincipal(req.user) && req.user ? { owner: { equals: req.user.id } } : false,
    update: () => false,
  },
  admin: { useAsTitle: 'title' },
  fields: [
    { name: 'owner', type: 'relationship', index: true, relationTo: 'users', required: true },
    { name: 'templateId', type: 'select', options: [...TEMPLATE_IDS], required: true },
    { name: 'title', type: 'text', maxLength: 100, required: true },
  ],
}
