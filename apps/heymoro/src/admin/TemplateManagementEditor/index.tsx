'use client'

import { formatAdminURL } from 'payload/shared'
import { startTransition, useEffect, useRef, useState } from 'react'

import type {
  EditorDTO,
  Form,
  ManagementOptionsDTO,
  TemplatePage,
  TermPage,
} from '../template-management-form.js'

import * as actions from '../template-management-actions.js'
import {
  blankBody,
  bodiesEqual,
  confirmedTemplateTarget,
  decodeBody,
  encodeBody,
  serializeCommand,
} from '../template-management-form.js'
import { TemplateManagementFields } from '../TemplateManagementFields/index.js'
import './index.css'

type Props = {
  apiRoute: string
  initialEditor: EditorDTO | null
  initialList: TemplatePage
  initialQuery: { keyword: string; status: string }
  initialTerms: TermPage
  options: ManagementOptionsDTO
}
const handlers = {
  create: actions.createTemplate,
  editor: actions.loadEditor,
  list: actions.loadList,
  offline: actions.offline,
  publish: actions.publish,
  save: actions.saveTemplate,
}
type Action = keyof typeof handlers
const statusLabels = { offline: '未上架', published: '已上架' }

export function TemplateManagementEditor({
  apiRoute,
  initialEditor,
  initialList,
  initialQuery,
  initialTerms,
  options,
}: Props) {
  const [editor, setEditor] = useState(initialEditor)
  const [form, setForm] = useState<Form | null>(() =>
    initialEditor ? decodeBody({ body: initialEditor.body, options }) : null,
  )
  const [list, setList] = useState(initialList)
  const [keyword, setKeyword] = useState(initialQuery.keyword)
  const [status, setStatus] = useState(initialQuery.status)
  const [appliedQuery, setAppliedQuery] = useState(initialQuery)
  const [isDirty, setDirty] = useState(false)
  const [isPending, setPending] = useState(false)
  const [isUnresolved, setUnresolved] = useState(false)
  const [recoveryTemplateId, setRecoveryTemplateId] = useState<null | number>(
    initialEditor?.template.id ?? null,
  )
  const [message, setMessage] = useState('')
  const [focusRequest, setFocusRequest] = useState<{ id: number; label: string } | null>(null)
  const busy = useRef(false)
  const epoch = useRef(0)
  const feedback = useRef<HTMLParagraphElement>(null)
  const canWrite = !isPending && !isUnresolved
  const isReadOnly = Boolean(
    form &&
    (form.schemaVersion !== 1 ||
      ['display', 'input', 'generation', 'share'].some(
        (key) => form[key as 'display'].kind !== 'editable',
      )),
  )
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (isDirty || isUnresolved) {
        event.preventDefault()
      }
    }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [isDirty, isUnresolved])
  const syncLocation = (templateId: null | number) => {
    const url = new URL(window.location.href)
    if (templateId) {
      url.searchParams.set('templateId', String(templateId))
    } else {
      url.searchParams.delete('templateId')
    }
    window.history.replaceState(window.history.state, '', url)
  }
  const mayDiscard = () =>
    !(isDirty || isUnresolved) || window.confirm('有尚未确认保存的内容，仍要离开？')
  const accept = (next: EditorDTO) => {
    epoch.current++
    setEditor(next)
    setRecoveryTemplateId(next.template.id > 0 ? next.template.id : null)
    setForm(decodeBody({ body: next.body, options }))
    setDirty(false)
    syncLocation(next.template.id)
  }
  const invoke = (action: Action, input: Record<string, unknown>) =>
    new Promise<Awaited<ReturnType<typeof actions.loadList>>>((resolve, reject) => {
      const serialized = serializeCommand({ input })
      startTransition(() => {
        void handlers[action](serialized).then(resolve, reject)
      })
    })
  const refreshList = async () => {
    const result = await invoke('list', {
      keyword: appliedQuery.keyword,
      ...(appliedQuery.status ? { status: appliedQuery.status } : {}),
    })
    if (!result.ok || !result.data.list) {
      throw Error('READ_FAILED')
    }
    setList(result.data.list)
  }
  const run = async (
    action: Action,
    input: Record<string, unknown>,
    apply: (
      result: Extract<Awaited<ReturnType<typeof actions.loadList>>, { ok: true }>,
    ) => boolean | Promise<boolean | void> | void,
  ) => {
    if (busy.current) {
      return
    }
    busy.current = true
    setPending(true)
    const requestEpoch = epoch.current
    const isWrite = !['editor', 'list'].includes(action)
    try {
      const result = await invoke(action, input)
      if (requestEpoch !== epoch.current) {
        return
      }
      if (!result.ok) {
        setMessage(result.error.message)
        if (result.confirmed || result.error.outcome === 'unknown') {
          setUnresolved(true)
          setRecoveryTemplateId(
            confirmedTemplateTarget({
              confirmed: result.confirmed,
              currentId: editor?.template.id ?? 0,
            }),
          )
        }
        feedback.current?.focus()
        return
      }
      const isApplied = await apply(result)
      if (isApplied === false) {
        return
      }
      if (isWrite) {
        setMessage('已保存')
        feedback.current?.focus()
        try {
          await refreshList()
        } catch {
          setMessage('保存已确认，列表未刷新。请重新搜索查看。')
        }
      }
    } catch {
      setMessage(
        isWrite
          ? '未收到保存确认，内容已保留。请先重新读取核对，勿重复保存。'
          : '读取失败，原内容保留，请重试。',
      )
      if (isWrite) {
        setUnresolved(true)
      }
      feedback.current?.focus()
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  const load = (templateId: number) => {
    if (!mayDiscard()) {
      return
    }
    void run('editor', { templateId }, (result) => {
      if (result.data.editor) {
        accept(result.data.editor)
        setUnresolved(false)
        setMessage('')
      }
    })
  }
  const startNew = () => {
    if (!mayDiscard()) {
      return
    }
    const body = blankBody({ kind: 'effect', options })
    accept({
      body,
      template: {
        ...body,
        id: 0,
        name: '新建模板',
        code: `effect-${crypto.randomUUID()}`,
        isDeleted: false,
        kind: 'effect',
        status: 'offline',
      },
    })
    setDirty(false)
    setUnresolved(false)
    setMessage('')
    setFocusRequest((value) => ({ id: (value?.id ?? 0) + 1, label: '名称' }))
  }
  const save = () => {
    if (!editor || !form || !canWrite || isReadOnly) {
      return
    }
    try {
      const body = encodeBody({ form })
      if (form.display.kind === 'editable' && !form.display.value.name.trim()) {
        setMessage('请输入名称')
        setFocusRequest((value) => ({ id: (value?.id ?? 0) + 1, label: '名称' }))
        return
      }
      if (form.generation.kind === 'editable' && !form.generation.value.systemPrompt.trim()) {
        setMessage('请填写内置 Prompt')
        setFocusRequest((value) => ({ id: (value?.id ?? 0) + 1, label: '内置 Prompt' }))
        return
      }
      void run(
        editor.template.id ? 'save' : 'create',
        {
          ...body,
          ...(editor.template.id
            ? { templateId: editor.template.id }
            : { code: editor.template.code, kind: editor.template.kind }),
        },
        (result) => {
          if (!result.data.editor || !bodiesEqual({ left: result.data.editor.body, right: body })) {
            setUnresolved(true)
            setMessage('服务器内容已变化，当前输入保留。请重新读取核对。')
            return false
          }
          accept(result.data.editor)
        },
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '请检查输入')
      feedback.current?.focus()
    }
  }
  const upload = async ({ files }: { files: readonly File[] }): Promise<readonly number[]> => {
    if (busy.current || !canWrite || !form || form.display.kind !== 'editable') {
      return []
    }
    if (files.length > 12) {
      setMessage('一个模板最多使用 12 张展示图片，请先移除不需要的图片。')
      return []
    }
    busy.current = true
    setPending(true)
    const requestEpoch = epoch.current
    const ids: number[] = []
    try {
      for (const file of files) {
        const body = new FormData()
        body.append('file', file)
        const response = await fetch(
          formatAdminURL({ apiRoute, path: '/v1/admin/media/examples' }),
          { body, credentials: 'same-origin', method: 'POST' },
        )
        const envelope = await response.json()
        if (requestEpoch !== epoch.current) {
          return []
        }
        if (!response.ok) {
          throw Error('UPLOAD_FAILED')
        }
        const id: unknown = envelope?.data?.id
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
          throw Error('UPLOAD_UNCONFIRMED')
        }
        ids.push(id)
      }
      setMessage('图片已上传，保存后生效。')
    } catch {
      setMessage(
        ids.length
          ? `已上传 ${ids.length} 张，其余未确认。已上传图片保留，请勿批量重复上传。`
          : '图片上传未确认，原图保留。请检查网络或文件后重试。',
      )
    } finally {
      busy.current = false
      setPending(false)
    }
    return ids
  }
  const changeStatus = (template: TemplatePage['items'][number]) => {
    if (!canWrite || isDirty) {
      return
    }
    const action = template.status === 'published' ? 'offline' : 'publish'
    void run(action, { templateId: template.id }, (result) => {
      if (editor && result.data.editor) {
        accept(result.data.editor)
      }
    })
  }
  return (
    <div aria-busy={isPending} className="template-editor" data-editing={Boolean(editor && form)}>
      <p
        aria-live="polite"
        className={!message && !isPending ? 'template-editor__visually-hidden' : undefined}
        ref={feedback}
        role="status"
        tabIndex={-1}
      >
        {isPending ? '处理中…' : message}
      </p>
      {!editor && (
        <section aria-label="模板列表" className="template-editor__list">
          <div className="template-editor__heading">
            <h2>模板列表</h2>
            <button
              className="template-editor__primary"
              disabled={!canWrite}
              onClick={startNew}
              type="button"
            >
              新建模板
            </button>
          </div>
          <form
            className="template-editor__row"
            onSubmit={(event) => {
              event.preventDefault()
              void run('list', { keyword, ...(status ? { status } : {}) }, (result) => {
                if (result.data.list) {
                  setList(result.data.list)
                  setAppliedQuery({ keyword, status })
                }
              })
            }}
          >
            <input
              aria-label="搜索模板"
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索模板名称"
              value={keyword}
            />
            <select
              aria-label="上架状态"
              onChange={(event) => setStatus(event.target.value)}
              value={status}
            >
              <option value="">全部状态</option>
              <option value="published">已上架</option>
              <option value="offline">未上架</option>
            </select>
            <button disabled={isPending} type="submit">
              搜索
            </button>
          </form>
          <div className="template-editor__table-wrap">
            <table className="template-editor__table">
              <caption className="template-editor__visually-hidden">图片玩法模板</caption>
              <thead>
                <tr>
                  <th scope="col">名称</th>
                  <th scope="col">类型</th>
                  <th scope="col">积分</th>
                  <th scope="col">状态</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>{item.kind === 'free' ? '自由创作' : '图片特效'}</td>
                    <td>{item.costCredits}</td>
                    <td>
                      <span className="template-editor__badge" data-status={item.status}>
                        {statusLabels[item.status]}
                      </span>
                    </td>
                    <td>
                      <div className="template-editor__row">
                        <button
                          aria-label={`编辑${item.name}`}
                          disabled={isPending}
                          onClick={() => load(item.id)}
                          type="button"
                        >
                          编辑
                        </button>
                        <button
                          aria-label={`${item.status === 'published' ? '下架' : '上架'}${item.name}`}
                          disabled={!canWrite}
                          onClick={() => changeStatus(item)}
                          type="button"
                        >
                          {item.status === 'published' ? '下架' : '上架'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!list.items.length && <p className="template-editor__empty">暂无模板</p>}
          </div>
          {list.nextAfterId && (
            <button
              disabled={isPending}
              onClick={() =>
                void run(
                  'list',
                  {
                    keyword: appliedQuery.keyword,
                    ...(appliedQuery.status ? { status: appliedQuery.status } : {}),
                    afterId: list.nextAfterId,
                  },
                  (result) => {
                    if (result.data.list) {
                      setList({
                        ...result.data.list,
                        items: [...list.items, ...result.data.list.items],
                      })
                    }
                  },
                )
              }
              type="button"
            >
              加载更多
            </button>
          )}
        </section>
      )}
      {editor && form && (
        <form
          aria-label="模板编辑"
          className="template-editor__editing template-editor__simple-editing"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <div className="template-editor__editing-header">
            <button
              className="template-editor__back"
              disabled={isPending}
              onClick={() => {
                if (mayDiscard()) {
                  epoch.current++
                  setEditor(null)
                  setForm(null)
                  setDirty(false)
                  setUnresolved(false)
                  setMessage('')
                  syncLocation(null)
                }
              }}
              type="button"
            >
              ← 返回列表
            </button>
            <h2>{editor.template.id ? editor.template.name : '新建模板'}</h2>
            {editor.template.id > 0 && (
              <button
                disabled={!canWrite || isDirty}
                onClick={() => changeStatus(editor.template)}
                type="button"
              >
                {editor.template.status === 'published' ? '下架模板' : '上架模板'}
              </button>
            )}
            <button
              className="template-editor__primary"
              disabled={!canWrite || isReadOnly}
              type="submit"
            >
              保存
            </button>
          </div>
          {isReadOnly && <p role="alert">当前配置格式不受支持，原内容已保留，请联系开发者检查。</p>}
          {isUnresolved && (
            <div role="alert">
              <p>上次操作结果待核对，当前输入保留。</p>
              {recoveryTemplateId !== null && (
                <button
                  disabled={isPending}
                  onClick={() => load(recoveryTemplateId!)}
                  type="button"
                >
                  重新读取
                </button>
              )}
            </div>
          )}
          <TemplateManagementFields
            apiRoute={apiRoute}
            canWrite={canWrite}
            focusRequest={focusRequest}
            form={form}
            isReadOnly={isReadOnly}
            key={editor.template.id}
            onChange={(next) => {
              setForm(next)
              setDirty(true)
            }}
            onUpload={upload}
            terms={initialTerms.items}
          />
        </form>
      )}
    </div>
  )
}
