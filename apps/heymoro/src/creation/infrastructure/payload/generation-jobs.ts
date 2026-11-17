import type { JobsConfig, TaskHandler } from 'payload'

export const generationTaskSlug = 'heymoro-generate-v1'
export const generationQueue = 'creation'
export const namingTaskSlug = 'heymoro-name-v1'
export const namingQueue = 'creation-naming'

/** Composition root must provide the actual worker; admission never runs it or retries a paid call. */
export function createGenerationJobsConfig({
  handler,
  namingHandler,
}: {
  handler: TaskHandler<{ input: { taskId: number }; output: object }>
  namingHandler?: TaskHandler<{ input: { sessionId: number }; output: object }>
}): JobsConfig {
  if (typeof handler !== 'function') {
    throw new Error('A generation task handler is required.')
  }
  return {
    access: { cancel: () => false, queue: () => false, run: () => false },
    autoRun: [],
    deleteJobOnComplete: false,
    jobsCollectionOverrides: ({ defaultJobsCollection }) => ({
      ...defaultJobsCollection,
      access: {
        admin: () => false,
        create: () => false,
        delete: () => false,
        read: () => false,
        update: () => false,
      },
      admin: { ...defaultJobsCollection.admin, hidden: true },
    }),
    tasks: [
      {
        slug: namingTaskSlug,
        handler:
          namingHandler ??
          (() => {
            throw new Error('Naming handler is not configured.')
          }),
        inputSchema: [{ name: 'sessionId', type: 'number', required: true }],
        outputSchema: [],
        retries: 0,
      },
      {
        slug: generationTaskSlug,
        handler,
        inputSchema: [{ name: 'taskId', type: 'number', required: true }],
        outputSchema: [],
        retries: 0,
      },
    ],
  }
}
