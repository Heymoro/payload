import type { ReactNode } from 'react'

import './share.css'

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
