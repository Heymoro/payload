// Isolated compatibility fixture, not a product runtime or migration path.
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig, APIError } from 'payload'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUserSession, authenticateUserSession } from '../../src/auth-session.ts'
import { hashOpaqueToken } from '../../src/auth-crypto.ts'
import { unifiedContext } from '../../src/auth-unified-context.ts'
import { authEndpoints } from '../../src/endpoint-auth.ts'
import { WechatIdentities } from '../../src/collections/WechatIdentities.ts'
import { UserSessions as ExistingSessions } from '../../src/collections/UserSessions.ts'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const isolated = path.resolve(process.env.SPIKE_DATA_DIR || '')
if (
  process.env.NODE_ENV !== 'development' ||
  !isolated.startsWith(path.join(appRoot, '.data', 'unified-spike-')) ||
  process.env.DATABASE_URL !== `file:${path.join(isolated, 'spike.sqlite')}` ||
  !process.env.SPIKE_CONTROL_TOKEN
) {
  throw new Error('Unified account fixture requires its own guarded database')
}

const context = (req) => unifiedContext({ user: req.user, headers: req.headers })
const staff = ({ req }) => context(req) === 'management'
const administrator = (req) => context(req) === 'management' && req.user.managementRole === 'admin'
const internal = Symbol('isolated-bootstrap')
function denied() {
  throw new APIError('FORBIDDEN', 403)
}
const Sessions = {
  ...ExistingSessions,
  fields: [
    ...ExistingSessions.fields,
    {
      name: 'audience',
      type: 'select',
      required: true,
      defaultValue: 'client',
      options: ['client'],
    },
  ],
}
const Users = {
  slug: 'users',
  access: {
    admin: staff,
    create: ({ req }) => administrator(req),
    read: ({ req }) =>
      context(req) === 'management' ||
      (context(req) === 'client' ? { id: { equals: req.user.id } } : false),
    update: ({ req }) =>
      administrator(req) || (context(req) === 'client' ? { id: { equals: req.user.id } } : false),
    delete: () => false,
  },
  auth: {
    loginWithUsername: { allowEmailLogin: true, requireEmail: false, requireUsername: false },
    strategies: [
      {
        name: 'user-session',
        authenticate: async (args) => {
          const result = await authenticateUserSession(args)
          if (!result.user) return result
          const token = args.headers.get('authorization')?.split(' ')[1]
          const session = await args.payload.find({
            collection: 'userSessions',
            where: {
              and: [
                { tokenHash: { equals: hashOpaqueToken(token) } },
                { audience: { equals: 'client' } },
              ],
            },
            depth: 0,
            limit: 1,
            overrideAccess: true,
            req: args.req,
          })
          return {
            user: session.docs.length
              ? { ...result.user, _strategy: 'user-session', _sessionAudience: 'client' }
              : null,
          }
        },
      },
    ],
  },
  hooks: {
    beforeChange: [
      ({ data, operation, req }) => {
        if (req.context.bootstrap === internal) return data
        if (operation === 'create') {
          if (data.managementRole && data.managementRole !== 'none') denied()
          if (data.managementCredentialsEnabled) denied()
        }
        if (context(req) === 'client') {
          for (const key of Object.keys(data))
            if (!['displayName', 'avatarUrl'].includes(key)) denied()
        }
        return data
      },
    ],
    beforeLogin: [
      ({ user }) => {
        if (
          user.status !== 'active' ||
          !user.managementCredentialsEnabled ||
          !['admin', 'operator'].includes(user.managementRole)
        )
          denied()
      },
    ],
  },
  fields: [
    { name: 'displayName', type: 'text', required: true },
    { name: 'avatarUrl', type: 'text' },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'active',
      options: ['active', 'disabled'],
    },
    {
      name: 'managementRole',
      type: 'select',
      required: true,
      defaultValue: 'none',
      options: ['none', 'operator', 'admin'],
    },
    { name: 'managementCredentialsEnabled', type: 'checkbox', defaultValue: false },
  ],
}
export default buildConfig({
  secret: process.env.PAYLOAD_SECRET,
  cookiePrefix: 'unified-spike',
  auth: { jwtOrder: ['JWT', 'cookie'] },
  admin: { user: 'users', autoLogin: false },
  db: sqliteAdapter({
    client: { url: process.env.DATABASE_URL },
    autoIncrement: true,
    transactionOptions: { behavior: 'immediate' },
  }),
  editor: lexicalEditor({}),
  collections: [Users, Sessions, WechatIdentities],
  typescript: { autoGenerate: false },
  endpoints: [
    authEndpoints.find((endpoint) => endpoint.path === '/v1/auth/wechat'),
    {
      path: '/v1/health/ready',
      method: 'get',
      handler: async () => Response.json({ ready: true }),
    },
    {
      path: '/spike/control',
      method: 'post',
      handler: async (req) => {
        // Controller secret is generated by the test harness; this endpoint never exists in product config.
        if (req.headers.get('x-spike-control') !== process.env.SPIKE_CONTROL_TOKEN) denied()
        const body = await req.json()
        if (body.action === 'session') {
          const data = await createUserSession({ payload: req.payload, userId: body.id })
          return Response.json(data)
        }
        if (body.action === 'enroll') {
          const user = await req.payload.update({
            collection: 'users',
            id: body.id,
            data: {
              email: body.email,
              password: body.password,
              managementRole: 'admin',
              managementCredentialsEnabled: true,
            },
            context: { bootstrap: internal },
            overrideAccess: true,
          })
          return Response.json({ id: user.id })
        }
        if (body.action === 'patch') {
          await req.payload.update({
            collection: 'users',
            id: body.id,
            data: body.data,
            context: { bootstrap: internal },
            overrideAccess: true,
          })
          return Response.json({ ok: true })
        }
        if (body.action === 'expire') {
          await req.payload.update({
            collection: 'userSessions',
            where: { tokenHash: { equals: hashOpaqueToken(body.token) } },
            data: { expiresAt: new Date(Date.now() - 60000).toISOString() },
            overrideAccess: true,
          })
          return Response.json({ ok: true })
        }
        if (body.action === 'revoke') {
          await req.payload.update({
            collection: 'userSessions',
            where: { tokenHash: { equals: hashOpaqueToken(body.token) } },
            data: { revokedAt: new Date().toISOString() },
            overrideAccess: true,
          })
          return Response.json({ ok: true })
        }
        if (body.action === 'inventory') {
          const result = await req.payload.find({
            collection: 'users',
            overrideAccess: true,
            depth: 0,
            sort: 'id',
          })
          return Response.json({
            count: result.totalDocs,
            items: result.docs.map(
              ({ id, email, managementRole, managementCredentialsEnabled }) => ({
                id,
                email,
                managementRole,
                managementCredentialsEnabled,
              }),
            ),
          })
        }
        denied()
      },
    },
    {
      path: '/v1/me',
      method: 'get',
      handler: async (req) =>
        context(req) === 'client'
          ? Response.json({ id: req.user.id, displayName: req.user.displayName })
          : Response.json({ error: 'CLIENT_REQUIRED' }, { status: 401 }),
    },
    {
      path: '/v1/media/cleanup',
      method: 'post',
      handler: async (req) =>
        administrator(req)
          ? Response.json({ allowed: true })
          : Response.json({ error: 'FORBIDDEN' }, { status: 403 }),
    },
  ],
})
