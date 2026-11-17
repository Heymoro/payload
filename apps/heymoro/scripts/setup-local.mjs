import { mkdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
await mkdir(new URL('.data/uploads/', root), { recursive: true })
const values = {
  PAYLOAD_SECRET: randomBytes(32).toString('hex'),
  DATABASE_URL: `file:${fileURLToPath(new URL('.data/heymoro.sqlite', root))}`,
  UPLOAD_DIR: fileURLToPath(new URL('.data/uploads', root)),
  PUBLIC_API_URL: 'http://localhost:3001',
  WECHAT_AUTH_PROVIDER: 'mock',
  PAYLOAD_DROP_DATABASE: 'false',
}
try {
  await writeFile(
    new URL('.env.local', root),
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
    { flag: 'wx', mode: 0o600 },
  )
  console.log('Created local dev configuration; secret is not printed.')
} catch (error) {
  if (error.code !== 'EEXIST') throw error
  console.log('Existing configuration preserved; local data directory ready.')
}
