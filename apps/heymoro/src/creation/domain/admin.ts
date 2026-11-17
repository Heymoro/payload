export type AdminRole = 'admin' | 'operator'
export type AdminStatus = 'active' | 'disabled'
export type AdminRecord = Readonly<{ id: number; role: AdminRole; status: AdminStatus }>
export type AdminChanges = Readonly<{ password?: string; role?: AdminRole; status?: AdminStatus }>
export type AdminCommand =
  | Readonly<{ action: 'bootstrap'; email: string; password: string; username?: string }>
  | Readonly<{
      action: 'create'
      authorization: string
      email: string
      password: string
      role: AdminRole
      username?: string
    }>
  | Readonly<{ action: 'update'; authorization: string; changes: AdminChanges; id: number }>
export type AdminOutcome = 'not_started' | 'rolled_back' | 'unknown'
export type AdminResult = Readonly<{
  data: AdminRecord & Readonly<{ changed: boolean }>
  outcome: 'confirmed'
  requestId: string
}>
export type AdminErrorCode =
  | 'ADMIN_ALREADY_INITIALIZED'
  | 'ADMIN_CONFLICT'
  | 'ADMIN_DATA_INTEGRITY'
  | 'ADMIN_FAILED'
  | 'ADMIN_FORBIDDEN'
  | 'ADMIN_INVALID_INPUT'
  | 'ADMIN_LAST_ACTIVE_ADMIN'
  | 'ADMIN_NOT_FOUND'
  | 'ADMIN_OUTCOME_UNKNOWN'
  | 'ADMIN_UNAUTHORIZED'

const messages: Record<AdminErrorCode, string> = {
  ADMIN_ALREADY_INITIALIZED: 'Administrator initialization has already occurred.',
  ADMIN_CONFLICT: 'Administrator account already exists.',
  ADMIN_DATA_INTEGRITY: 'Administrator data integrity check failed.',
  ADMIN_FAILED: 'Administrator command failed.',
  ADMIN_FORBIDDEN: 'An active administrator is required.',
  ADMIN_INVALID_INPUT: 'Invalid administrator command or trace metadata.',
  ADMIN_LAST_ACTIVE_ADMIN: 'At least one active administrator must remain.',
  ADMIN_NOT_FOUND: 'Administrator account was not found.',
  ADMIN_OUTCOME_UNKNOWN:
    'Administrator transaction outcome is unknown. Verify state before further action.',
  ADMIN_UNAUTHORIZED: 'Native administrator authentication is required.',
}

export class AdminCommandError extends Error {
  readonly code: AdminErrorCode
  readonly outcome: AdminOutcome
  readonly requestId?: string
  readonly status: number

  constructor({
    code,
    outcome = 'rolled_back',
    requestId,
  }: {
    code: AdminErrorCode
    outcome?: AdminOutcome
    requestId?: string
  }) {
    super(messages[code])
    this.name = 'AdminCommandError'
    this.code = code
    this.requestId = requestId
    this.outcome = outcome
    this.status =
      code === 'ADMIN_NOT_FOUND'
        ? 404
        : code === 'ADMIN_UNAUTHORIZED'
          ? 401
          : code === 'ADMIN_FORBIDDEN'
            ? 403
            : ['ADMIN_DATA_INTEGRITY', 'ADMIN_FAILED', 'ADMIN_OUTCOME_UNKNOWN'].includes(code)
              ? 503
              : code === 'ADMIN_INVALID_INPUT'
                ? 400
                : 409
  }
}

/** Copy only own enumerable data properties; never evaluate caller accessors. */
export function parseAdminCommand({ input }: { input: unknown }): AdminCommand {
  try {
    const source = record({
      optional: ['email', 'password', 'authorization', 'role', 'id', 'changes', 'username'],
      required: ['action'],
      value: input,
    })
    if (source.action === 'bootstrap') {
      const value = record({
        optional: ['username'],
        required: ['action', 'email', 'password'],
        value: input,
      })
      return Object.freeze({
        action: 'bootstrap',
        email: email({ value: value.email }),
        password: password({ value: value.password }),
        ...(Object.hasOwn(value, 'username')
          ? { username: username({ value: value.username }) }
          : {}),
      })
    }
    if (source.action === 'create') {
      const value = record({
        optional: ['username'],
        required: ['action', 'authorization', 'email', 'password', 'role'],
        value: input,
      })
      return Object.freeze({
        action: 'create',
        authorization: authorization({ value: value.authorization }),
        email: email({ value: value.email }),
        password: password({ value: value.password }),
        ...(Object.hasOwn(value, 'username')
          ? { username: username({ value: value.username }) }
          : {}),
        role: role({ value: value.role }),
      })
    }
    if (source.action === 'update') {
      const value = record({ required: ['action', 'authorization', 'id', 'changes'], value: input })
      const fields = record({
        optional: ['role', 'status', 'password'],
        required: [],
        value: value.changes,
      })
      if (!Object.keys(fields).length) {
        throw new Error()
      }
      const changes: AdminChanges = Object.freeze({
        ...(Object.hasOwn(fields, 'role') ? { role: role({ value: fields.role }) } : {}),
        ...(Object.hasOwn(fields, 'status') ? { status: status({ value: fields.status }) } : {}),
        ...(Object.hasOwn(fields, 'password')
          ? { password: password({ value: fields.password }) }
          : {}),
      })
      return Object.freeze({
        id: adminId({ value: value.id }),
        action: 'update',
        authorization: authorization({ value: value.authorization }),
        changes,
      })
    }
    throw new Error()
  } catch {
    throw new AdminCommandError({ code: 'ADMIN_INVALID_INPUT', outcome: 'not_started' })
  }
}

export function isAdminRequestId({ value }: { value: unknown }): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}
export function adminRecord({ value }: { value: Record<string, unknown> }): AdminRecord {
  try {
    return Object.freeze({
      id: adminId({ value: value.id }),
      role: role({ value: value.role }),
      status: status({ value: value.status }),
    })
  } catch {
    throw new AdminCommandError({ code: 'ADMIN_DATA_INTEGRITY' })
  }
}
function record({
  optional = [],
  required,
  value,
}: {
  optional?: string[]
  required: string[]
  value: unknown
}): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  ) {
    throw new Error()
  }
  const result: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      (!required.includes(key) && !optional.includes(key)) ||
      !descriptor ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    ) {
      throw new Error()
    }
    result[key] = descriptor.value
  }
  if (required.some((key) => !Object.hasOwn(result, key))) {
    throw new Error()
  }
  return result
}
function adminId({ value }: { value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error()
  }
  return value
}
function role({ value }: { value: unknown }): AdminRole {
  if (value !== 'admin' && value !== 'operator') {
    throw new Error()
  }
  return value
}
function status({ value }: { value: unknown }): AdminStatus {
  if (value !== 'active' && value !== 'disabled') {
    throw new Error()
  }
  return value
}
function email({ value }: { value: unknown }): string {
  if (typeof value !== 'string' || value.length > 320) {
    throw new Error()
  }
  const normalized = value.trim().toLowerCase()
  if (
    normalized.length > 254 ||
    Array.from(normalized).some((character) => {
      const point = character.codePointAt(0)
      return point !== undefined && (point < 32 || point === 127)
    }) ||
    !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(normalized)
  ) {
    throw new Error()
  }
  return normalized
}
function password({ value }: { value: unknown }): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024 || !value.trim()) {
    throw new Error()
  }
  return value
}
function authorization({ value }: { value: unknown }): string {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    !/^JWT [\w-]+\.[\w-]+\.[\w-]+$/.test(value)
  ) {
    throw new Error()
  }
  return value
}

function username({ value }: { value: unknown }): string {
  if (typeof value !== 'string' || value.length > 128) {
    throw new Error()
  }
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(normalized)) {
    throw new Error()
  }
  return normalized
}
