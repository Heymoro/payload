import config from '@payload-config'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { GenerationError } from '../../../../creation/domain/generation.js'
import { getCoreRuntime } from '../../../../creation/runtime/services.js'

export const dynamic = 'force-dynamic'
export const metadata = {
  title: '作品会话 · Heymoro',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function SharedSession({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  const payload = await getPayload({ config })
  let share
  try {
    share = await getCoreRuntime({ payload }).sessionShares.get({ key })
  } catch (error) {
    if (error instanceof GenerationError && error.code === 'NOT_FOUND') notFound()
    throw error
  }
  const api = payload.config.routes.api
  return (
    <main className="public-session">
      <header>
        <span className="public-session__brand">Heymoro</span>
        <h1>{share.title}</h1>
        <p>{share.images.length} 张作品 · AI 生成</p>
      </header>
      <section aria-label="会话作品">
        {share.images.map((image, index) => (
          <figure key={image.id}>
            <img
              src={`${api}/v1/session-shares/${key}/images/${image.id}`}
              alt={`${share.title} · 作品 ${index + 1}`}
              width={image.width}
              height={image.height}
              loading={index ? 'lazy' : 'eager'}
            />
          </figure>
        ))}
      </section>
    </main>
  )
}
