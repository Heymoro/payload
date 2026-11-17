import type { CollectionConfig } from 'payload'

import { deepCopyObject } from 'payload'

import type { CreationWriteGate } from './write-gate.js'

import { AuditLogs } from '../../../collections/AuditLogs.js'
import { auditFields, validateAudit } from './collection-audit.js'

/** Extend the existing audit target; this is not a second audit stream. */
export function createCreationAuditCollection({
  gate,
}: {
  gate: CreationWriteGate
}): CollectionConfig {
  const base = deepCopyObject(AuditLogs)
  const names = new Set(auditFields().map((field) => ('name' in field ? field.name : '')))
  return {
    ...base,
    access: {
      admin: () => false,
      create: () => false,
      delete: () => false,
      read: () => false,
      update: () => false,
    },
    admin: { ...base.admin, hidden: true },
    fields: [
      ...base.fields.filter((field) => !('name' in field) || !names.has(field.name)),
      ...auditFields(),
    ],
    hooks: {
      afterChange: [
        ({ doc, req }) => {
          gate.assert({ req })
          return doc
        },
      ],
      beforeChange: [
        ({ data, operation, originalDoc, req }) => {
          gate.assert({ req })
          if (operation !== 'create' || data.isDeleted === true) {
            throw new Error('Creation audit is append-only.')
          }
          validateAudit({ data, isUpdate: false, originalDoc })
          return data
        },
      ],
      beforeDelete: [
        () => {
          throw new Error('Creation audit is append-only.')
        },
      ],
      beforeOperation: [gate.beforeOperation],
    },
    lockDocuments: false,
    timestamps: true,
    versions: false,
  }
}
