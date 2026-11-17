import type { CollectionConfig } from 'payload'

import { isAdministratorPrincipal, isStaffPrincipal } from '../auth-principals.js'

export const AuditLogs: CollectionConfig = {
  slug: 'auditLogs',
  access: {
    admin: ({ req }) => isStaffPrincipal(req.user),
    create: () => false,
    delete: () => false,
    read: ({ req }) => isAdministratorPrincipal(req.user),
    update: () => false,
  },
  admin: {
    useAsTitle: 'action',
  },
  fields: [
    {
      name: 'actorType',
      type: 'select',
      options: [
        { label: 'System', value: 'system' },
        { label: 'User', value: 'user' },
        { label: 'Admin', value: 'admin' },
      ],
      required: true,
    },
    { name: 'actorId', type: 'text' },
    { name: 'actorIssuer', type: 'text', admin: { readOnly: true } },
    { name: 'actorSubject', type: 'text', admin: { readOnly: true } },
    { name: 'beforeState', type: 'json', admin: { readOnly: true } },
    { name: 'action', type: 'text', required: true },
    { name: 'resourceType', type: 'text', required: true },
    { name: 'resourceId', type: 'text' },
    { name: 'correlationId', type: 'text', maxLength: 128, required: true },
    { name: 'ipAddress', type: 'text', admin: { readOnly: true } },
    {
      name: 'result',
      type: 'select',
      defaultValue: 'success',
      options: [{ label: 'Success', value: 'success' }],
      required: true,
    },
    { name: 'requestId', type: 'text', maxLength: 128, required: true },
    { name: 'summary', type: 'json' },
    { name: 'afterState', type: 'json', admin: { readOnly: true } },
    { name: 'userAgent', type: 'text', admin: { readOnly: true } },
  ],
  indexes: [
    { fields: ['action', 'createdAt'] },
    { fields: ['resourceType', 'resourceId'] },
    { fields: ['actorType', 'actorId'] },
    { fields: ['correlationId', 'createdAt'] },
  ],
}
