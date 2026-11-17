import type { JobsConfig, TaskConfig } from 'payload'

import { runGeneration } from './service-creation.js'

const createImageTask: TaskConfig<{
  input: { generationId: number }
  output: Record<string, never>
}> = {
  slug: 'create-image',
  handler: async ({ input, req }) => {
    await runGeneration({ generationId: input.generationId, req })
    return { output: {} }
  },
  inputSchema: [{ name: 'generationId', type: 'number', required: true }],
  retries: 0,
}

export const creationJobs: JobsConfig = {
  access: { cancel: () => false, queue: () => false, run: () => false },
  autoRun:
    process.env.HEYMORO_JOB_AUTORUN === 'false'
      ? []
      : [{ cron: '*/10 * * * * *', limit: 5, queue: 'creation' }],
  tasks: [createImageTask],
  // Job administration and mutation are server-only, including native REST/GraphQL collection routes.
  jobsCollectionOverrides: ({ defaultJobsCollection }) => ({
    ...defaultJobsCollection,
    access: {
      admin: () => false,
      create: () => false,
      delete: () => false,
      read: () => false,
      update: () => false,
    },
  }),
}
