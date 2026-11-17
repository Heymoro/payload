import type { CollectionConfig } from 'payload'

import { isUserPrincipal } from '../auth-principals.js'

export const GENERATION_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'unknown'] as const

export const Generations: CollectionConfig = {
  slug: 'generations',
  access: {
    admin: () => false,
    create: () => false,
    delete: () => false,
    read: ({ req }) =>
      isUserPrincipal(req.user) && req.user ? { owner: { equals: req.user.id } } : false,
    update: () => false,
  },
  admin: { useAsTitle: 'id' },
  fields: [
    { name: 'owner', type: 'relationship', index: true, relationTo: 'users', required: true },
    {
      name: 'session',
      type: 'relationship',
      index: true,
      relationTo: 'creation-sessions',
      required: true,
    },
    { name: 'provider', type: 'select', options: ['fixture', 'openai'], required: true },
    { name: 'model', type: 'text', hidden: true, required: true },
    {
      name: 'status',
      type: 'select',
      index: true,
      options: [...GENERATION_STATUSES],
      required: true,
    },
    { name: 'prompt', type: 'textarea', defaultValue: '', maxLength: 2000 },
    { name: 'inputMediaIds', type: 'relationship', hasMany: true, maxRows: 8, relationTo: 'media' },
    { name: 'outputMedia', type: 'relationship', relationTo: 'media' },
    { name: 'saved', type: 'checkbox', defaultValue: false, required: true },
    { name: 'errorCode', type: 'text' },
    { name: 'requestKey', type: 'text', hidden: true, required: true, unique: true },
    { name: 'snapshotHash', type: 'text', hidden: true, required: true },
    { name: 'systemPrompt', type: 'textarea', hidden: true, required: true },
    { name: 'promptVersion', type: 'text', hidden: true, required: true },
    { name: 'leaseUntil', type: 'date', hidden: true },
  ],
}
