import { randomUUID } from 'node:crypto'

import type {
  AdminChanges,
  AdminCommand,
  AdminRecord,
  AdminResult,
  AdminRole,
} from '../domain/admin.js'

import { AdminCommandError, isAdminRequestId, parseAdminCommand } from '../domain/admin.js'

export type AdministrationRepository = Readonly<{
  appendAudit: (args: AdministrationAudit) => Promise<void>
  authenticate: (args: { authorization: string }) => Promise<AdminRecord | null>
  countAll: () => Promise<number>
  countOtherActive: (args: { id: number }) => Promise<number>
  findEmail: (args: { email: string }) => Promise<readonly AdminRecord[]>
  findId: (args: { id: number }) => Promise<AdminRecord | null>
  insert: (args: {
    email: string
    password: string
    role: AdminRole
    status: 'active'
    username?: string
  }) => Promise<AdminRecord>
  update: (args: { changes: AdminChanges; id: number }) => Promise<AdminRecord>
}>
export type AdministrationAudit = Readonly<{
  action: 'admin.bootstrap' | 'admin.create' | 'admin.update'
  actor: string
  afterState: Pick<AdminRecord, 'role' | 'status'>
  beforeState: null | Pick<AdminRecord, 'role' | 'status'>
  id: number
  now: string
  requestId: string
  summary: Readonly<{ changedFields: readonly string[]; passwordChanged: boolean }>
}>
export type AdministrationWrite = <T>(args: {
  resource: 'admin-management'
  work: (args: { repository: AdministrationRepository }) => Promise<T>
}) => Promise<T>

/** Host-only command boundary: validation and immutable snapshot precede the first await. */
export function createAdministration({
  clock,
  mode,
  write,
}: {
  clock: () => string
  mode?: string
  write: AdministrationWrite
}) {
  const executeParsed = async ({
    readCommand,
    suppliedRequestId,
  }: {
    readCommand: () => AdminCommand
    suppliedRequestId?: string
  }): Promise<AdminResult> => {
    const requestId =
      typeof suppliedRequestId === 'string' && isAdminRequestId({ value: suppliedRequestId })
        ? suppliedRequestId
        : randomUUID()
    let hasStarted = false
    try {
      if (suppliedRequestId !== undefined && !isAdminRequestId({ value: suppliedRequestId })) {
        throw new AdminCommandError({ code: 'ADMIN_INVALID_INPUT', outcome: 'not_started' })
      }
      const command = readCommand()
      hasStarted = true
      const data = await write({
        resource: 'admin-management',
        work: async ({ repository }) => {
          let actor = 'system:bootstrap'
          if (command.action !== 'bootstrap') {
            const principal = await repository.authenticate({
              authorization: command.authorization,
            })
            if (!principal) {
              throw new AdminCommandError({ code: 'ADMIN_UNAUTHORIZED' })
            }
            if (principal.role !== 'admin' || principal.status !== 'active') {
              throw new AdminCommandError({ code: 'ADMIN_FORBIDDEN' })
            }
            actor = `admin:${principal.id}`
          }
          if (command.action === 'bootstrap' && (await repository.countAll()) !== 0) {
            throw new AdminCommandError({ code: 'ADMIN_ALREADY_INITIALIZED' })
          }
          let before: AdminRecord | null = null
          let saved: AdminRecord
          let changedFields: string[]
          if (command.action === 'update') {
            before = await repository.findId({ id: command.id })
            if (!before) {
              throw new AdminCommandError({ code: 'ADMIN_NOT_FOUND' })
            }
            changedFields = ['role', 'status'].filter(
              (field) =>
                command.changes[field as 'role' | 'status'] !== undefined &&
                command.changes[field as 'role' | 'status'] !==
                  before?.[field as 'role' | 'status'],
            )
            if (command.changes.password !== undefined) {
              changedFields.push('password')
            }
            if (!changedFields.length) {
              return Object.freeze({
                id: before.id,
                changed: false,
                role: before.role,
                status: before.status,
              })
            }
            if (
              before.role === 'admin' &&
              before.status === 'active' &&
              ((command.changes.role ?? before.role) !== 'admin' ||
                (command.changes.status ?? before.status) !== 'active') &&
              (await repository.countOtherActive({ id: command.id })) < 1
            ) {
              throw new AdminCommandError({ code: 'ADMIN_LAST_ACTIVE_ADMIN' })
            }
            saved = await repository.update({ id: command.id, changes: command.changes })
          } else {
            const existing = await repository.findEmail({ email: command.email })
            if (existing.length > 1) {
              throw new AdminCommandError({ code: 'ADMIN_DATA_INTEGRITY' })
            }
            if (existing.length) {
              throw new AdminCommandError({ code: 'ADMIN_CONFLICT' })
            }
            saved = await repository.insert({
              email: command.email,
              password: command.password,
              role: command.action === 'bootstrap' ? 'admin' : command.role,
              status: 'active',
              ...(command.username !== undefined ? { username: command.username } : {}),
            })
            changedFields = ['role', 'status', 'password']
          }
          await repository.appendAudit({
            id: saved.id,
            action: `admin.${command.action}`,
            actor,
            afterState: { role: saved.role, status: saved.status },
            beforeState: before ? { role: before.role, status: before.status } : null,
            now: clock(),
            requestId,
            summary: {
              changedFields: Object.freeze(changedFields),
              passwordChanged: changedFields.includes('password'),
            },
          })
          return Object.freeze({
            id: saved.id,
            changed: true,
            role: saved.role,
            status: saved.status,
          })
        },
      })
      return Object.freeze({ data, outcome: 'confirmed', requestId })
    } catch (error) {
      if (error instanceof AdminCommandError) {
        throw new AdminCommandError({ code: error.code, outcome: error.outcome, requestId })
      }
      throw new AdminCommandError({
        code: 'ADMIN_FAILED',
        outcome: hasStarted ? 'rolled_back' : 'not_started',
        requestId,
      })
    }
  }
  return Object.freeze({
    execute: ({ input, requestId }: { input: unknown; requestId?: string }) =>
      executeParsed({
        readCommand: () => parseAdminCommand({ input }),
        suppliedRequestId: requestId,
      }),
    initializeDevelopmentPreset: () =>
      executeParsed({
        readCommand: () => {
          if (mode !== 'development') {
            throw new AdminCommandError({ code: 'ADMIN_FORBIDDEN', outcome: 'not_started' })
          }
          return Object.freeze({
            action: 'bootstrap',
            email: 'admin@local.invalid',
            password: '123456',
            username: 'admin',
          })
        },
      }),
  })
}
