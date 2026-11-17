import type { CollectionConfig, Field } from 'payload'

import type { CreationWriteGate } from './write-gate.js'

import { auditFields, validateAudit } from './collection-audit.js'

/** Replaces the old template/version pair at a composition root; never register both templates. */
export function createCurrentTemplateCollection({
  gate,
}: {
  gate: CreationWriteGate
}): CollectionConfig {
  const text = (name: string): Field => ({ name, type: 'text', required: true })
  return {
    slug: 'creation-templates',
    access: {
      admin: () => false,
      create: () => false,
      delete: () => false,
      read: () => false,
      update: () => false,
    },
    admin: { hidden: true },
    dbName: 'creation_templates',
    fields: [
      ...auditFields(),
      ...['code', 'kind', 'name', 'status', 'minClientCapability'].map(text),
      integerField({ name: 'sortOrder', defaultValue: 0, minimum: Number.MIN_SAFE_INTEGER }),
      integerField({ name: 'primaryCategoryId', required: false }),
      integerField({ name: 'schemaVersion' }),
      integerField({ name: 'costCredits', minimum: 0 }),
      ...['displayConfigJson', 'inputSchemaJson', 'generationConfigJson', 'shareConfigJson'].map(
        (name): Field => ({ name, type: 'textarea', required: true }),
      ),
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
          validateAudit({ data, isUpdate: operation === 'update', originalDoc })
          const merged = { ...originalDoc, ...data }
          if (
            !['offline', 'published'].includes(String(merged.status)) ||
            !['effect', 'free'].includes(String(merged.kind))
          ) {
            throw new Error('Invalid current template state.')
          }
          for (const field of ['code', 'kind']) {
            if (operation === 'update' && originalDoc && merged[field] !== originalDoc[field]) {
              throw new Error(`Template ${field} is immutable.`)
            }
          }
          return data
        },
      ],
      beforeDelete: [
        () => {
          throw new Error('Physical template deletion is forbidden.')
        },
      ],
      beforeOperation: [gate.beforeOperation],
    },
    indexes: [
      { fields: ['code'] },
      { fields: ['kind', 'status', 'isDeleted'] },
      { fields: ['isDeleted', 'status', 'sortOrder'] },
      { fields: ['primaryCategoryId', 'isDeleted', 'status'] },
    ],
    lockDocuments: false,
    timestamps: true,
    versions: false,
  }
}

function integerField({
  name,
  defaultValue,
  minimum = 1,
  required = true,
}: {
  defaultValue?: number
  minimum?: number
  name: string
  required?: boolean
}): Field {
  return {
    name,
    type: 'number',
    required,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    validate: (value: unknown) => {
      if (value == null) {
        return !required || 'Expected a required integer.'
      }
      return (
        (typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum) ||
        `Expected an integer of at least ${minimum}.`
      )
    },
  }
}
