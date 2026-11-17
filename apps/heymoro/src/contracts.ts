export type ApiEnvelope<T> = {
  data: T
  requestId: string
}

export type ApiError = {
  error: {
    code: string
    message: string
  }
  requestId: string
}

export type UserDto = {
  avatarUrl: null | string
  displayName: string
  id: number
  status: 'active' | 'disabled'
}

export type RecordLifecycle = 'active' | 'archived'

export type RecordDto = {
  attachments?: null | number[]
  body?: null | string
  createdAt: string
  id: number
  lifecycle: RecordLifecycle
  title: string
  updatedAt: string
}
