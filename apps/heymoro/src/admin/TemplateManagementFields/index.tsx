'use client'

import type { ReactNode } from 'react'

import { formatAdminURL } from 'payload/shared'
import { useEffect, useId, useRef, useState } from 'react'

import type { DisplayConfig } from '../../creation/domain/template-config.js'
import type { Form, TaxonomyTerm } from '../template-management-form.js'

import { templateTagOptions } from '../template-management-form.js'

type Props = {
  apiRoute: string
  canWrite: boolean
  focusRequest?: { id: number; label: string } | null
  form: Form
  isReadOnly: boolean
  onChange: (form: Form) => void
  onUpload: (args: { files: readonly File[] }) => Promise<readonly number[]>
  terms: readonly TaxonomyTerm[]
}

/** Routine template content only; execution and host policy remain internal configuration. */
export function TemplateManagementFields({
  apiRoute,
  canWrite,
  focusRequest,
  form,
  isReadOnly,
  onChange,
  onUpload,
  terms,
}: Props) {
  const root = useRef<HTMLDivElement>(null)
  const [uploadError, setUploadError] = useState('')
  const [shareLink, setShareLink] = useState('')
  const display = form.display.kind === 'editable' ? form.display.value : null
  const generation = form.generation.kind === 'editable' ? form.generation.value : null
  useEffect(() => {
    if (!focusRequest) {
      return
    }
    const input = Array.from(
      root.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ??
        [],
    ).find((node) => node.getAttribute('aria-label') === focusRequest.label)
    input?.focus()
  }, [focusRequest])
  const updateDisplay = (patch: Partial<DisplayConfig>) => {
    if (form.display.kind === 'editable') {
      onChange({
        ...form,
        display: { ...form.display, value: { ...form.display.value, ...patch } },
      })
    }
  }
  const upload = async ({
    apply,
    files,
  }: {
    apply: (ids: readonly number[]) => void
    files: FileList | null
  }) => {
    if (!files?.length || !canWrite || isReadOnly) {
      return
    }
    setUploadError('')
    try {
      const ids = await onUpload({ files: Array.from(files) })
      if (ids.length) {
        apply(ids)
      }
    } catch {
      setUploadError('图片未上传，请重试；原图片保留。')
    }
  }
  const image = (id: null | number, alt: string) =>
    id ? (
      <img
        alt={alt}
        className="template-editor__asset"
        src={formatAdminURL({ apiRoute, path: `/v1/media/examples/${id}/content` })}
      />
    ) : null
  if (!display || !generation) {
    return <p role="alert">当前配置需要修复，已保留原内容。</p>
  }
  const category = terms.find((term) => term.id === display.categoryId && term.kind === 'category')
  const tags = templateTagOptions({ selected: display.tags, terms })
  return (
    <div className="template-editor__fields template-editor__simple-fields" ref={root}>
      {uploadError && <p role="alert">{uploadError}</p>}
      <fieldset disabled={!canWrite || isReadOnly}>
        <legend>基本信息</legend>
        <Field label="名称">
          <input
            aria-label="名称"
            maxLength={100}
            onChange={(event) => updateDisplay({ name: event.target.value })}
            required
            value={display.name}
          />
        </Field>
        <Field label="简介">
          <textarea
            aria-label="简介"
            maxLength={500}
            onChange={(event) => updateDisplay({ description: event.target.value })}
            rows={2}
            value={display.description}
          />
        </Field>
        <Field label="分类">
          <select
            aria-label="分类"
            onChange={(event) => {
              const selected = terms.find(
                (term) => term.kind === 'category' && term.id === Number(event.target.value),
              )
              updateDisplay({
                categoryId: selected?.id ?? null,
                categoryName: selected?.name ?? null,
              })
            }}
            value={display.categoryId ?? ''}
          >
            <option value="">不分类</option>
            {display.categoryId && !category && (
              <option value={display.categoryId}>{display.categoryName}（已停用）</option>
            )}
            {terms
              .filter((term) => term.kind === 'category')
              .map((term) => (
                <option disabled={term.status !== 'active'} key={term.id} value={term.id}>
                  {term.name}
                  {term.status === 'hidden' ? '（已停用）' : ''}
                  {term.status === 'hidden' ? '（已停用）' : ''}
                </option>
              ))}
          </select>
        </Field>
        {tags.length > 0 && (
          <fieldset className="template-editor__tag-options">
            <legend>标签</legend>
            {tags.map((term) => (
              <label key={term.id}>
                <input
                  aria-label={term.name}
                  checked={display.tagIds.includes(term.id)}
                  disabled={term.status !== 'active' && !display.tagIds.includes(term.id)}
                  onChange={(event) => {
                    const selected = event.target.checked
                    updateDisplay({
                      primaryTagId:
                        !selected && display.primaryTagId === term.id ? null : display.primaryTagId,
                      tagIds: selected
                        ? [...display.tagIds, term.id]
                        : display.tagIds.filter((id) => id !== term.id),
                      tags: selected
                        ? [...display.tags, { id: term.id, name: term.name }]
                        : display.tags.filter((tag) => tag.id !== term.id),
                    })
                  }}
                  type="checkbox"
                />
                {term.name}
                {term.status === 'hidden' ? '（已停用）' : ''}
              </label>
            ))}
          </fieldset>
        )}
      </fieldset>
      <fieldset disabled={!canWrite || isReadOnly}>
        <legend>图片展示</legend>
        <div className="template-editor__cover-row">
          <div>{image(display.coverMediaId, '模板封面')}</div>
          <div>
            <h3>封面</h3>
            <Field label={display.coverMediaId ? '更换封面' : '上传封面'}>
              <input
                accept="image/jpeg,image/png,image/webp"
                aria-label="上传封面"
                className="template-editor__native-file"
                onChange={(event) => {
                  void upload({
                    apply: (ids) => updateDisplay({ coverMediaId: ids[0]! }),
                    files: event.target.files,
                  })
                  event.target.value = ''
                }}
                type="file"
              />
            </Field>
            {display.coverMediaId && (
              <button onClick={() => updateDisplay({ coverMediaId: null })} type="button">
                移除封面
              </button>
            )}
          </div>
        </div>
        <h3>关联会话分享</h3>
        <Field label="会话分享链接">
          <input
            aria-label="会话分享链接"
            onChange={(event) => setShareLink(event.target.value)}
            placeholder="粘贴已发布的会话链接"
            value={shareLink}
          />
        </Field>
        <button
          disabled={!shareLink.trim() || display.showcaseShareKeys.length >= 8}
          onClick={() => {
            const text = shareLink.trim()
            const key = /^[\w-]{32}$/.test(text)
              ? text
              : (() => {
                  try {
                    const url = new URL(text)
                    return url.origin === window.location.origin
                      ? /^\/share\/([\w-]{32})\/?$/.exec(url.pathname)?.[1]
                      : null
                  } catch {
                    return null
                  }
                })()
            if (!key || display.showcaseShareKeys.includes(key)) {
              setUploadError('请使用本站已发布的会话链接，请勿重复关联。')
              return
            }
            updateDisplay({ showcaseShareKeys: [...display.showcaseShareKeys, key] })
            setShareLink('')
            setUploadError('')
          }}
          type="button"
        >
          关联
        </button>
        <ul className="template-editor__share-links">
          {display.showcaseShareKeys.map((key, index) => (
            <li key={key}>
              <img
                alt=""
                height="64"
                src={formatAdminURL({ apiRoute, path: `/v1/session-shares/${key}/cover` })}
                width="64"
              />
              <a href={`/share/${key}`} rel="noreferrer" target="_blank">
                作品会话 {index + 1}（新窗口）
              </a>
              <button
                aria-label={`移除作品会话 ${index + 1}`}
                onClick={() =>
                  updateDisplay({
                    showcaseShareKeys: display.showcaseShareKeys.filter((item) => item !== key),
                  })
                }
                type="button"
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      </fieldset>
      <fieldset disabled={!canWrite || isReadOnly}>
        <legend>生成内容</legend>
        <Field label="内置 Prompt">
          <textarea
            aria-label="内置 Prompt"
            onChange={(event) => {
              if (form.generation.kind === 'editable') {
                onChange({
                  ...form,
                  generation: {
                    ...form.generation,
                    value: { ...generation, systemPrompt: event.target.value },
                  },
                })
              }
            }}
            required
            rows={7}
            value={generation.systemPrompt}
          />
        </Field>
        <Field label="生成积分">
          <input
            aria-label="生成积分"
            min={0}
            onChange={(event) =>
              onChange({
                ...form,
                costCredits: event.target.value === '' ? '' : Number(event.target.value),
              })
            }
            required
            step={1}
            type="number"
            value={form.costCredits}
          />
        </Field>
      </fieldset>
    </div>
  )
}
function Field({ children, label }: { children: ReactNode; label: string }) {
  const id = useId()
  return (
    <label className="template-editor__field" id={id}>
      <span>{label}</span>
      <span>{children}</span>
    </label>
  )
}
