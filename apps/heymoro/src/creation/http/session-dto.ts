import type { SessionRecord } from '../application/session.js'

export function sessionDTO({ session }: { session: SessionRecord }) {
  return {
    id: session.id,
    lastActivityAt: session.lastActivityAt,
    mode: session.mode,
    templateId: session.templateId,
    title: session.title,
    titleSource: session.titleSource,
  }
}
