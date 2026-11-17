import type { InValue } from '@libsql/client'
import type { Payload } from 'payload'

import { getCreationSQLiteAdapter } from '../../src/creation/infrastructure/payload/sqlite-unit-of-work.js'

const columns = {
  costCredits: 'cost_credits',
  deletedAt: 'deleted_at',
  deletedBy: 'deleted_by',
  displayConfigJson: 'display_config_json',
  generationConfigJson: 'generation_config_json',
  inputSchemaJson: 'input_schema_json',
  isDeleted: 'is_deleted',
  minClientCapability: 'min_client_capability',
  schemaVersion: 'schema_version',
  shareConfigJson: 'share_config_json',
  status: 'status',
} as const

/** Deliberate storage corruption only: fixed table/column allowlist, parameterized values, no production bypass. */
export async function corruptCurrentTemplate({
  data,
  payload,
  templateId,
}: {
  data: Record<string, unknown>
  payload: Payload
  templateId: number
}) {
  if (
    !Number.isSafeInteger(templateId) ||
    templateId < 1 ||
    !Object.keys(data).length ||
    Object.keys(data).some((key) => !Object.hasOwn(columns, key))
  ) {
    throw new Error('Invalid corruption fixture column.')
  }
  const entries = Object.entries(data)
  const values: InValue[] = entries.map(([, value]) => {
    if (typeof value === 'boolean') {
      return value ? 1 : 0
    }
    if (value === null || typeof value === 'string' || typeof value === 'number') {
      return value
    }
    throw new Error('Invalid corruption fixture value.')
  })
  const result = await getCreationSQLiteAdapter({ payload }).client.execute({
    args: [...values, templateId],
    sql: `UPDATE creation_templates SET ${entries.map(([key]) => `${columns[key as keyof typeof columns]} = ?`).join(', ')} WHERE id = ?`,
  })
  if (result.rowsAffected !== 1) {
    throw new Error('Corruption fixture requires exactly one existing row.')
  }
}

/** External SQL fault injection, never a way to register successful publication media. */
export async function corruptPublicationMedia({
  data,
  mediaId,
  payload,
}: {
  data: { sha256: string }
  mediaId: number
  payload: Payload
}) {
  if (
    !Number.isSafeInteger(mediaId) ||
    mediaId < 1 ||
    Object.keys(data).length !== 1 ||
    !Object.hasOwn(data, 'sha256') ||
    typeof data.sha256 !== 'string'
  ) {
    throw new Error('Invalid publication media corruption.')
  }
  const result = await getCreationSQLiteAdapter({ payload }).client.execute({
    args: [data.sha256, mediaId],
    sql: 'UPDATE media SET sha256 = ? WHERE id = ?',
  })
  if (result.rowsAffected !== 1) {
    throw new Error('Media corruption requires exactly one existing row.')
  }
}
