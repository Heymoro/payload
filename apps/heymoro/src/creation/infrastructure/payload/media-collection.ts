import type { CollectionConfig, Field } from 'payload'

import { deepCopyObject } from 'payload'

import type { CreationWriteGate } from './write-gate.js'

import { auditFields, validateAudit } from './collection-audit.js'

/** Replace the existing media definition at the composition root; never register both. */
export function createCreationMediaCollection({
  baseCollection,
  gate,
  staticDir,
}: {
  baseCollection: CollectionConfig
  gate: CreationWriteGate
  staticDir: string
}): CollectionConfig {
  baseCollection = deepCopyObject(baseCollection)
  if (
    baseCollection.slug !== 'media' ||
    !staticDir ||
    !baseCollection.upload ||
    typeof baseCollection.upload !== 'object'
  ) {
    throw new Error(
      'Creation media requires the existing upload collection and an explicit static directory.',
    )
  }
  const replacements = new Set(['filename', 'original', 'owner', 'thumbnailURL', 'url', 'variants'])
  const privateField = ({ name }: { name: string }): Field => ({
    name,
    type: 'text',
    access: { read: () => false },
    ...(name === 'filename' ? { index: true, unique: false } : {}),
  })
  return {
    ...baseCollection,
    access: {
      admin: () => false,
      create: () => false,
      delete: () => false,
      read: () => false,
      update: () => false,
    },
    admin: { ...baseCollection.admin, hidden: true },
    fields: [
      ...baseCollection.fields
        .filter((field) => !('name' in field) || !replacements.has(field.name))
        .map((field) =>
          'name' in field && field.name === 'lifecycle' && field.type === 'select'
            ? { ...field, options: [...field.options, 'uploading'] }
            : field,
        ),
      ...auditFields(),
      { name: 'owner', type: 'number', index: true },
      ...['filename', 'url', 'thumbnailURL'].map((name) => privateField({ name })),
      { name: 'original', type: 'group', access: { read: () => false }, fields: [] },
      { name: 'variants', type: 'group', access: { read: () => false }, fields: [] },
      { name: 'storageBackend', type: 'text', required: true },
      { name: 'storageBucket', type: 'text', required: true },
      {
        name: 'sha256',
        type: 'text',
        required: true,
        validate: (value: unknown) =>
          (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) || 'Expected SHA-256.',
      },
      {
        name: 'visibility',
        type: 'select',
        options: ['private', 'official_public'],
        required: true,
      },
      {
        name: 'purpose',
        type: 'select',
        options: ['reference', 'artifact', 'example', 'avatar'],
        required: true,
      },
    ],
    hooks: {
      ...baseCollection.hooks,
      afterChange: [
        ...(baseCollection.hooks?.afterChange ?? []),
        ({ doc, req }) => {
          gate.assert({ req })
          return doc
        },
      ],
      beforeChange: [
        ({ data, operation, originalDoc, req }) => {
          gate.assert({ req })
          validateAudit({ data, isUpdate: operation === 'update', originalDoc })
          if (operation === 'update') {
            for (const field of [
              'owner',
              'visibility',
              'purpose',
              'storageBackend',
              'storageBucket',
              'storageName',
              'filename',
              'originalName',
              'sha256',
              'mimeType',
              'filesize',
              'width',
              'height',
              'original',
              'variants',
            ]) {
              if (
                Object.hasOwn(data, field) &&
                JSON.stringify(data[field]) !== JSON.stringify(originalDoc?.[field])
              ) {
                throw new Error(`Media ${field} is immutable.`)
              }
            }
          }
          const merged = { ...originalDoc, ...data }
          if (
            merged.owner == null
              ? merged.visibility !== 'official_public' || merged.purpose !== 'example'
              : typeof merged.owner !== 'number' ||
                !Number.isSafeInteger(merged.owner) ||
                merged.owner <= 0
          ) {
            throw new Error(
              'Media owner must be a numeric account, except an official public example.',
            )
          }
          if (merged.filename != null && merged.filename !== merged.storageName) {
            throw new Error('Native filename must match authoritative storageName.')
          }
          return data
        },
        ...(baseCollection.hooks?.beforeChange ?? []),
      ],
      beforeDelete: [
        () => {
          throw new Error('Physical creation deletion is forbidden.')
        },
      ],
      beforeOperation: [gate.beforeOperation, ...(baseCollection.hooks?.beforeOperation ?? [])],
    },
    indexes: [
      { fields: ['storageBackend', 'storageBucket', 'storageName'] },
      { fields: ['owner', 'isDeleted', 'purpose', 'lifecycle'] },
    ],
    lockDocuments: false,
    timestamps: true,
    upload: {
      ...baseCollection.upload,
      disableLocalStorage: true,
      filesRequiredOnCreate: false,
      pasteURL: false,
      staticDir,
    },
    versions: false,
  }
}
