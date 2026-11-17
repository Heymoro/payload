import type { Field } from 'payload'

export function auditFields(): Field[] {
  return [
    // Configure Payload's existing timestamp fields; these are not additional timestamp columns.
    { name: 'createdAt', type: 'date', admin: { hidden: true }, index: false },
    { name: 'updatedAt', type: 'date', admin: { hidden: true }, index: false },
    { name: 'createdBy', type: 'text', maxLength: 64, required: true },
    { name: 'updatedBy', type: 'text', maxLength: 64, required: true },
    { name: 'isDeleted', type: 'checkbox', defaultValue: false, required: true },
    { name: 'deletedAt', type: 'date' },
    { name: 'deletedBy', type: 'text', maxLength: 64 },
  ]
}

export function validateAudit({
  data,
  isUpdate,
  originalDoc,
}: {
  data: Record<string, unknown>
  isUpdate: boolean
  originalDoc?: Record<string, unknown>
}) {
  if (isUpdate && originalDoc) {
    for (const field of ['createdAt', 'createdBy']) {
      if (Object.hasOwn(data, field) && data[field] !== originalDoc[field]) {
        throw new Error(`Creation audit ${field} is immutable.`)
      }
    }
  }
  const merged = { ...originalDoc, ...data }
  const isDeleted = merged.isDeleted ?? false
  const hasDeletionDate = merged.deletedAt != null
  const hasDeletionActor = merged.deletedBy != null
  if (
    typeof isDeleted !== 'boolean' ||
    (isDeleted ? !hasDeletionDate || !hasDeletionActor : hasDeletionDate || hasDeletionActor)
  ) {
    throw new Error('Creation audit requires a complete, consistent soft-deletion state.')
  }
  for (const field of ['createdBy', 'updatedBy', ...(isDeleted ? ['deletedBy'] : [])]) {
    if (
      typeof merged[field] !== 'string' ||
      !/^(?:(?:user|admin):[1-9]\d*|system:[A-Za-z0-9][\w.-]*)$/.test(merged[field])
    ) {
      throw new Error('Creation audit requires a service-supplied actor.')
    }
  }
  for (const field of ['createdAt', 'updatedAt', ...(isDeleted ? ['deletedAt'] : [])]) {
    const value = merged[field]
    // Missing timestamps on creation are supplied by the native Payload timestamp columns.
    if (value === undefined && !isUpdate && field !== 'deletedAt') {
      continue
    }
    if (
      typeof value !== 'string' ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    ) {
      throw new Error('Creation audit requires UTC millisecond timestamps.')
    }
  }
}
