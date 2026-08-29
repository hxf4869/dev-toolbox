export interface ApiErrorBody {
  error?: {
    code?: string
    message?: string
    requestId?: string
  }
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: string

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message || '请求未成功，请稍后重试')
    this.name = 'ApiError'
    this.status = status
    this.code = body.error?.code || 'UNKNOWN_ERROR'
    this.requestId = body.error?.requestId
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...init.headers,
    },
  })
  if (response.status === 204) return undefined as T

  const body = (await response.json().catch(() => ({}))) as ApiErrorBody | T
  if (!response.ok) throw new ApiError(response.status, body as ApiErrorBody)
  return body as T
}

export function jsonRequest(method: string, value: unknown, csrfToken?: string): RequestInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken
  return { method, headers, body: JSON.stringify(value) }
}
