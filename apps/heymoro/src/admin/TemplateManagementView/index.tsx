import type { AdminViewServerProps } from 'payload'

import { Gutter } from '@payloadcms/ui'
import { DefaultTemplate } from '@payloadcms/ui/rsc'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { formatAdminURL } from 'payload/shared'

import { AdminCommandError } from '../../creation/domain/admin.js'
import { requireNativeAdmin } from '../../creation/http/native-admin-auth.js'
import { getCoreRuntime } from '../../creation/runtime/services.js'
import { SessionSharePanel } from '../SessionSharePanel/index.js'
import { TemplateManagementEditor } from '../TemplateManagementEditor/index.js'

export async function TemplateManagementView({
  initPageResult,
  params,
  searchParams,
}: AdminViewServerProps) {
  const { locale, permissions, req, visibleEntities } = initPageResult
  let admin
  try {
    admin = await requireNativeAdmin({ headers: await headers(), payload: req.payload })
  } catch (error) {
    if (error instanceof AdminCommandError && error.code === 'ADMIN_UNAUTHORIZED') {
      redirect(formatAdminURL({ adminRoute: req.payload.config.routes.admin, path: '/login' }))
    }
    return (
      <Gutter>
        <h1>模板管理</h1>
        <p role="alert">请使用有效的管理员账号登录。</p>
      </Gutter>
    )
  }
  const runtime = getCoreRuntime({ payload: req.payload })
  // Only explicit primitive query fields cross into the management services.
  const query = searchParams ?? {}
  const keyword = typeof query.keyword === 'string' ? query.keyword : ''
  const status =
    typeof query.status === 'string' && ['offline', 'published'].includes(query.status)
      ? query.status
      : undefined
  const templateId =
    typeof query.templateId === 'string' &&
    /^[1-9]\d*$/.test(query.templateId) &&
    Number.isSafeInteger(Number(query.templateId))
      ? Number(query.templateId)
      : null
  const isSessions = query.panel === 'sessions'
  const content = isSessions ? (
    admin.role === 'admin' ? (
      <SessionSharePanel
        apiRoute={req.payload.config.routes.api}
        initialList={await runtime.sessionShares.list({ adminId: admin.id })}
      />
    ) : (
      <p role="alert">此功能仅管理员可用。</p>
    )
  ) : (
    await (async () => {
      const [list, options, terms, selected] = await Promise.all([
        runtime.templates.list({
          adminId: admin.id,
          input: { keyword, ...(status ? { status } : {}) },
        }),
        runtime.templates.getOptions({ adminId: admin.id }),
        runtime.taxonomy.listTerms({ adminId: admin.id, input: {} }),
        templateId ? runtime.templates.get({ adminId: admin.id, templateId }) : null,
      ])
      return (
        <TemplateManagementEditor
          apiRoute={req.payload.config.routes.api}
          initialEditor={selected ? { body: selected, template: selected } : null}
          initialList={list}
          initialQuery={{ keyword, status: status ?? '' }}
          initialTerms={terms}
          options={options}
        />
      )
    })()
  )
  const managementPath = formatAdminURL({
    adminRoute: req.payload.config.routes.admin,
    path: '/templates',
  })

  return (
    <DefaultTemplate
      i18n={req.i18n}
      locale={locale}
      params={params}
      payload={req.payload}
      permissions={permissions}
      searchParams={searchParams}
      user={req.user!}
      visibleEntities={visibleEntities}
    >
      <Gutter>
        <header className="template-manager-header">
          <h1>{isSessions ? '会话分享' : '模板管理'}</h1>
          <nav aria-label="模板管理模块" className="template-editor__row">
            <a aria-current={!isSessions ? 'page' : undefined} href={managementPath}>
              模板管理
            </a>
            {admin.role === 'admin' && (
              <a
                aria-current={isSessions ? 'page' : undefined}
                href={`${managementPath}?panel=sessions`}
              >
                会话分享
              </a>
            )}
          </nav>
        </header>
        {content}
      </Gutter>
    </DefaultTemplate>
  )
}
