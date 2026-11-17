'use client'

import { formatAdminURL } from 'payload/shared'
import { useRef, useState } from 'react'

import type { createSessionShares } from '../../creation/application/session-share.js'

type Service = ReturnType<typeof createSessionShares>
type Detail = Awaited<ReturnType<Service['inspect']>>
type Page = Awaited<ReturnType<Service['list']>>

/** Manage publication of existing results, never a second creation or upload workflow. */
export function SessionSharePanel({
  apiRoute,
  initialList,
}: {
  apiRoute: string
  initialList: Page
}) {
  const [list, setList] = useState(initialList)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [title, setTitle] = useState('')
  const [selected, setSelected] = useState<number[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [isPending, setPending] = useState(false)
  const [isUnresolved, setUnresolved] = useState(false)
  const [message, setMessage] = useState('')
  const flight = useRef(false)
  const feedback = useRef<HTMLParagraphElement>(null)
  const api = ({ path }: { path: string }) =>
    formatAdminURL({ apiRoute, path: `/v1/admin/session-shares${path}` })
  const request = async <T,>({ body, path }: { body?: unknown; path: string }): Promise<T> => {
    const response = await fetch(api({ path }), {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
          }),
    })
    const envelope = await response.json()
    if (!response.ok || !envelope.data) {
      throw new Error('分享操作未确认，请重新读取后检查状态。')
    }
    return envelope.data as T
  }
  const run = async ({
    isMutation = false,
    work,
  }: {
    isMutation?: boolean
    work: () => Promise<void>
  }) => {
    if (flight.current) {
      return
    }
    flight.current = true
    setPending(true)
    setMessage('')
    try {
      await work()
    } catch {
      setMessage(
        isMutation ? '操作结果尚未确认，请重新读取，勿重复提交。' : '暂时读取失败，请重试。',
      )
      if (isMutation) {
        setUnresolved(true)
      }
    } finally {
      flight.current = false
      setPending(false)
      requestAnimationFrame(() => feedback.current?.focus())
    }
  }
  const inspect = ({ sessionId }: { sessionId: number }) =>
    run({
      work: async () => {
        const next = await request<Detail>({ path: `/${sessionId}` })
        setDetail(next)
        setTitle(next.share?.title ?? next.title)
        setSelected(
          next.share?.status === 'published'
            ? next.share.artifactIds
            : next.images.map((i) => i.id),
        )
        setConfirmed(false)
        setUnresolved(false)
        setMessage(next.images.length ? '已读取会话。' : '这个会话还没有可分享的成品。')
      },
    })
  const publish = () => {
    if (
      !detail ||
      detail.hasUnavailablePublishedImages ||
      isUnresolved ||
      !confirmed ||
      !selected.length ||
      !title.trim()
    ) {
      return
    }
    void run({
      isMutation: true,
      work: async () => {
        const receipt = await request<Awaited<ReturnType<Service['publish']>>>({
          body: { artifactIds: selected, confirmed: true, title },
          path: `/${detail.sessionId}`,
        })
        setDetail({
          ...detail,
          share: { artifactIds: [...selected], key: receipt.key, status: 'published', title },
        })
        setConfirmed(false)
        setMessage('会话已分享，可复制链接并关联到模板。')
      },
    })
  }
  return (
    <section
      aria-busy={isPending}
      aria-label="会话分享"
      className="template-editor session-share-panel"
    >
      <p className="template-editor__feedback" ref={feedback} role="status" tabIndex={-1}>
        {message}
      </p>
      <div className="session-share-panel__layout">
        <section>
          <h2>创作会话</h2>
          <div className="template-editor__table-wrap">
            <table className="template-editor__table">
              <thead>
                <tr>
                  <th>会话</th>
                  <th>模板</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((item) => (
                  <tr aria-selected={detail?.sessionId === item.id} key={item.id}>
                    <td>{item.title}</td>
                    <td>#{item.templateId}</td>
                    <td>
                      <button
                        disabled={isPending}
                        onClick={() => void inspect({ sessionId: item.id })}
                        type="button"
                      >
                        查看
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!list.items.length && <p>还没有创作会话。在小程序正常生成作品后，即可在这里分享。</p>}
          {list.nextAfterId && (
            <button
              disabled={isPending}
              onClick={() =>
                void run({
                  work: async () => {
                    const next = await request<Page>({ path: `?afterId=${list.nextAfterId}` })
                    setList({
                      items: [...list.items, ...next.items],
                      nextAfterId: next.nextAfterId,
                    })
                  },
                })
              }
              type="button"
            >
              加载更多
            </button>
          )}
        </section>
        <section>
          <h2>分享设置</h2>
          {!detail ? (
            <p>选择一个已有会话。</p>
          ) : (
            <>
              <p>
                {detail.title} · 模板 #{detail.templateId}
              </p>
              {detail.hasUnavailablePublishedImages && (
                <p role="alert">部分公开作品已移除，请先撤销分享再重新选择。</p>
              )}
              <fieldset disabled={isPending || isUnresolved}>
                <legend className="template-editor__visually-hidden">公开内容</legend>
                <label className="template-editor__field">
                  <span>分享标题</span>
                  <input
                    aria-label="分享标题"
                    maxLength={100}
                    onChange={(event) => {
                      setTitle(event.target.value)
                      setConfirmed(false)
                    }}
                    value={title}
                  />
                </label>
                <fieldset>
                  <legend>选择公开的成品（最多 20 张）</legend>
                  <div className="session-share-panel__images">
                    {detail.images.map((image) => (
                      <label key={image.id}>
                        <img
                          alt={`成品 ${image.id}`}
                          src={api({ path: `/${detail.sessionId}/images/${image.id}` })}
                        />
                        <span>
                          <input
                            aria-label={`公开成品 ${image.id}`}
                            checked={selected.includes(image.id)}
                            onChange={(event) => {
                              setSelected(
                                event.target.checked
                                  ? [...selected, image.id]
                                  : selected.filter((id) => id !== image.id),
                              )
                              setConfirmed(false)
                            }}
                            type="checkbox"
                          />
                          成品 {image.id}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label>
                  <input
                    aria-label="已确认所选成品可公开展示"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    type="checkbox"
                  />
                  已确认所选成品可公开展示
                </label>
                <div className="template-editor__row">
                  <button
                    className="template-editor__primary"
                    disabled={
                      !confirmed ||
                      !selected.length ||
                      selected.length > 20 ||
                      detail.hasUnavailablePublishedImages ||
                      !title.trim()
                    }
                    onClick={publish}
                    type="button"
                  >
                    {detail.share?.status === 'published' ? '更新分享' : '生成分享链接'}
                  </button>
                  {detail.share?.status === 'published' && (
                    <button
                      onClick={() =>
                        void run({
                          isMutation: true,
                          work: async () => {
                            await request({ body: {}, path: `/${detail.sessionId}/revoke` })
                            setDetail({
                              ...detail,
                              share: detail.share ? { ...detail.share, status: 'revoked' } : null,
                            })
                            setMessage('分享已撤销，旧链接及关联展示已失效。')
                          },
                        })
                      }
                      type="button"
                    >
                      撤销分享
                    </button>
                  )}
                </div>
              </fieldset>
              {detail.share?.status === 'published' && (
                <div className="template-editor__row">
                  <a href={`/share/${detail.share.key}`} rel="noreferrer" target="_blank">
                    查看分享（新窗口）
                  </a>
                  <button
                    disabled={isPending}
                    onClick={() =>
                      void run({
                        work: async () => {
                          await navigator.clipboard.writeText(
                            `${window.location.origin}/share/${detail.share!.key}`,
                          )
                          setMessage('链接已复制。')
                        },
                      })
                    }
                    type="button"
                  >
                    复制链接
                  </button>
                </div>
              )}
              <button
                disabled={isPending}
                onClick={() => void inspect({ sessionId: detail.sessionId })}
                type="button"
              >
                重新读取
              </button>
            </>
          )}
        </section>
      </div>
    </section>
  )
}
