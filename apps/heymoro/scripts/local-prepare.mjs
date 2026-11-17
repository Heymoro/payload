import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPayload } from 'payload'

import { initializeAdmins } from '../src/creation/runtime/admin-initialization.ts'
import { readCoreConfig } from '../src/creation/runtime/config.ts'
import { buildCorePayloadConfig } from '../src/creation/runtime/payload-config.ts'
import { getCoreRuntime } from '../src/creation/runtime/services.ts'
import { getCreationSQLiteAdapter } from '../src/creation/infrastructure/payload/sqlite-unit-of-work.ts'

if (process.env.NODE_ENV !== 'development' || process.argv.length !== 3) {
  throw new Error('Local preparation requires development mode and an explicit private config.')
}
const config = readCoreConfig({ filename: process.argv[2] })
let payload
try {
  payload = await getPayload({ config: buildCorePayloadConfig({ config }) })
  const runtime = getCoreRuntime({ payload })
  const initialized = await initializeAdmins({
    administration: runtime.administration,
    logger: payload.logger,
    mode: 'development',
  })
  // Never overwrite operator-owned content or attempt yesterday's default password.
  if (initialized.status === 'created') {
    const adminId = initialized.adminId
    const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
    const bytes = await readFile(
      path.resolve(app, '../../../taro/apps/heymoro/src/assets/retro.jpg'),
    )
    const cover = await runtime.officialMedia.upload({
      adminId,
      declaredMimeType: 'image/jpeg',
      input: bytes,
      originalName: 'retro-example.jpg',
    })
    for (const [code, kind, name] of [
      ['free', 'free', '自由创作'],
      ['retro-family', 'effect', '复古全家福'],
    ]) {
      const template = await runtime.templates.create({
        adminId,
        code,
        kind,
        configuration: {
          schemaVersion: 1,
          minClientCapability: 'v1',
          costCredits: 1,
          displayConfigJson: JSON.stringify({
            name,
            description:
              kind === 'effect' ? '让照片中的主角出现在同一张复古合照里。' : '描述你想生成的画面。',
            coverMediaId: kind === 'effect' ? cover.id : null,
            showcaseShareKeys: [],
          }),
          inputSchemaJson: JSON.stringify({
            ...config.hostCaps,
            minImages: kind === 'effect' ? 1 : 0,
            maxImages: 4,
            maxDescriptionLength: kind === 'free' ? 2000 : 0,
            maxNotesLength: kind === 'effect' ? 500 : 0,
          }),
          generationConfigJson: JSON.stringify({
            executorId: 'openai-image-v1',
            systemPrompt:
              kind === 'effect'
                ? 'Use all supplied reference images to create a coherent warm vintage family portrait. Preserve the distinguishing features of every subject.'
                : 'Create an image according to the user description and all supplied reference images.',
            parameters: { size: '1024x1024', quality: 'low' },
          }),
          shareConfigJson: '{}',
        },
      })
      await runtime.templates.setStatus({ adminId, templateId: template.id, status: 'published' })
    }
    console.info('本地初始模板已发布；这是示例图，不是本轮AI生成结果。')
  }
} finally {
  if (payload) {
    const client = getCreationSQLiteAdapter({ payload }).client
    try {
      await getCoreRuntime({ payload }).close()
    } finally {
      try {
        await payload.destroy()
      } finally {
        client.close()
      }
    }
  }
}
