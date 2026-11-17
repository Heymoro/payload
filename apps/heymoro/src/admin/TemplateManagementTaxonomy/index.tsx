'use client'

import type { ReactNode } from 'react'

import { useId } from 'react'

import type { TaxonomyTerm, TermPage } from '../template-management-form.js'

type Query = { keyword: string; kind: string }
type NewTerm = { code: string; kind: string; name: string }
type Props = {
  appliedQuery: Query
  canWrite: boolean
  isPending: boolean
  newTerm: NewTerm
  onCreate: (input: NewTerm) => void
  onList: (append: boolean) => void
  onUpdate: (input: {
    id: number
    name: string
    sortOrder: number
    status: TaxonomyTerm['status']
  }) => void
  setNewTerm: (term: NewTerm) => void
  setTermEdits: (edits: Record<number, string>) => void
  setTermQuery: (query: Query) => void
  termEdits: Record<number, string>
  termQuery: Query
  terms: TermPage
}
export function TemplateManagementTaxonomy({
  appliedQuery,
  canWrite,
  isPending,
  newTerm,
  onCreate,
  onList,
  onUpdate,
  setNewTerm,
  setTermEdits,
  setTermQuery,
  termEdits,
  termQuery,
  terms,
}: Props) {
  return (
    <details>
      <summary>管理分类和标签</summary>
      <fieldset disabled={isPending}>
        <div className="template-editor__row">
          <Field label="词条搜索">
            <input
              aria-label="词条搜索"
              onChange={(event) => setTermQuery({ ...termQuery, keyword: event.target.value })}
              value={termQuery.keyword}
            />
          </Field>
          <Field label="词条类型">
            <select
              aria-label="词条类型"
              onChange={(event) => setTermQuery({ ...termQuery, kind: event.target.value })}
              value={termQuery.kind}
            >
              <option value="">全部</option>
              <option value="category">分类</option>
              <option value="label">标签</option>
            </select>
          </Field>
          <button onClick={() => onList(false)} type="button">
            搜索词条
          </button>
        </div>
        <p>
          当前词条筛选：{appliedQuery.keyword || '全部关键词'} / {appliedQuery.kind || '全部类型'}
          。修改输入后请点击搜索词条。
        </p>
        {terms.items.map((term) => (
          <div className="template-editor__row" key={term.id}>
            <Field label={`${term.kind} ${term.code} 名称`}>
              <input
                aria-label={`${term.kind} ${term.code} 名称`}
                onChange={(event) => setTermEdits({ ...termEdits, [term.id]: event.target.value })}
                value={termEdits[term.id] ?? term.name}
              />
            </Field>
            <span>{term.status}</span>
            <button
              disabled={!canWrite}
              onClick={() =>
                onUpdate({
                  id: term.id,
                  name: termEdits[term.id] ?? term.name,
                  sortOrder: term.sortOrder,
                  status: term.status,
                })
              }
              type="button"
            >
              保存词条名称
            </button>
            <button
              disabled={!canWrite}
              onClick={() =>
                onUpdate({
                  id: term.id,
                  name: term.name,
                  sortOrder: term.sortOrder,
                  status: term.status === 'active' ? 'hidden' : 'active',
                })
              }
              type="button"
            >
              {term.status === 'active' ? '隐藏' : '启用'}
            </button>
          </div>
        ))}
        {terms.nextAfterId && (
          <button onClick={() => onList(true)} type="button">
            加载更多词条
          </button>
        )}
        <h3>新建词条</h3>
        <Field label="词条类型">
          <select
            aria-label="词条类型"
            onChange={(event) => setNewTerm({ ...newTerm, kind: event.target.value })}
            value={newTerm.kind}
          >
            <option value="category">分类</option>
            <option value="label">标签</option>
          </select>
        </Field>
        <Field label="词条代码">
          <input
            aria-label="词条代码"
            onChange={(event) => setNewTerm({ ...newTerm, code: event.target.value })}
            value={newTerm.code}
          />
        </Field>
        <Field label="词条名称">
          <input
            aria-label="词条名称"
            onChange={(event) => setNewTerm({ ...newTerm, name: event.target.value })}
            value={newTerm.name}
          />
        </Field>
        <button disabled={!canWrite} onClick={() => onCreate(newTerm)} type="button">
          创建词条
        </button>
      </fieldset>
    </details>
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
