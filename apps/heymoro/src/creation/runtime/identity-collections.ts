import type { CollectionConfig } from 'payload'

import { AuthenticationError } from 'payload'

import type { CreationWriteGate } from '../infrastructure/payload/write-gate.js'

import { Admins } from '../../collections/Admins.js'
import { Users } from '../../collections/Users.js'
import { UserSessions } from '../../collections/UserSessions.js'
import { WechatIdentities } from '../../collections/WechatIdentities.js'
import { auditFields, validateAudit } from '../infrastructure/payload/collection-audit.js'
import { createSessionAuthentication } from './session-auth.js'

export function createIdentityCollections({
  clock,
  gate,
  mode = process.env.NODE_ENV,
}: {
  clock: () => string
  gate: CreationWriteGate
  mode?: string
}): CollectionConfig[] {
  const identities = [Users, WechatIdentities, UserSessions].map((base): CollectionConfig => ({
    ...base,
    fields: [...base.fields, ...auditFields()],
    ...(base.slug === 'users'
      ? {
          access: { ...base.access, read: () => false },
          auth: {
            ...(typeof base.auth === 'object' ? base.auth : {}),
            disableLocalStrategy: true,
            strategies: [
              { name: 'core-opaque-session', authenticate: createSessionAuthentication({ clock }) },
            ],
          },
        }
      : {}),
    hooks: {
      ...base.hooks,
      afterChange: [
        ({ doc, req }) => {
          gate.assert({ req })
          return doc
        },
      ],
      beforeChange: [
        ({ data, operation, originalDoc, req }) => {
          gate.assert({ req })
          validateAudit({ data, isUpdate: operation === 'update', originalDoc })
          return data
        },
        ...(base.hooks?.beforeChange ?? []),
      ],
      beforeDelete: [
        () => {
          throw new Error('Physical identity deletion is forbidden.')
        },
      ],
      beforeOperation: [gate.beforeOperation, ...(base.hooks?.beforeOperation ?? [])],
    },
  }))
  return [
    {
      ...Admins,
      auth: {
        ...(typeof Admins.auth === 'object' ? Admins.auth : {}),
        loginWithUsername: { allowEmailLogin: true, requireEmail: true, requireUsername: false },
      },
      hooks: {
        ...Admins.hooks,
        afterChange: [],
        beforeOperation: [
          ({ args, operation, req }) => {
            if (mode === 'production' && operation === 'login' && args.data.password === '123456') {
              throw new AuthenticationError(req?.t, true)
            }
            if (['forgotPassword', 'resetPassword', 'unlock', 'verifyEmail'].includes(operation)) {
              throw new Error('Core administrator password mutation is not enabled.')
            }
            return args
          },
          gate.beforeOperation,
          ...(Admins.hooks?.beforeOperation ?? []),
        ],
      },
    },
    ...identities,
  ]
}
