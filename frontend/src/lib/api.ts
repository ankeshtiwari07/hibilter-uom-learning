export class ApiError extends Error {
  status: number
  body: any
  constructor(status: number, message: string, body: any) {
    super(message); this.status = status; this.body = body
  }
}

function csrf(): string {
  const m = document.cookie.match(/(?:^|; )uom_csrf=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : ''
}

export async function api<T = any>(path: string, opts: { method?: string; body?: any; raw?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method || (opts.body !== undefined ? 'POST' : 'GET')
  const headers: Record<string, string> = {}
  let body: BodyInit | undefined
  if (opts.body instanceof FormData) body = opts.body
  else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body) }
  if (method !== 'GET') headers['x-csrf'] = csrf()
  let res: Response
  try {
    res = await fetch(path, { method, headers, body, credentials: 'same-origin', signal: opts.signal })
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e
    throw new ApiError(0, 'Can’t reach the server. Check your connection and try again.', null)
  }
  if (opts.raw) return res as any
  const text = await res.text()
  const data = text ? (() => { try { return JSON.parse(text) } catch { return text } })() : null
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (typeof data.detail === 'string' ? data.detail : data.detail?.[0]?.msg)) || `Request failed (${res.status})`
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('uom:unauthorized'))
    throw new ApiError(res.status, msg, data)
  }
  return data as T
}

export const get = <T = any>(p: string) => api<T>(p)
export const post = <T = any>(p: string, body: any = {}) => api<T>(p, { method: 'POST', body })
export const put = <T = any>(p: string, body: any = {}) => api<T>(p, { method: 'PUT', body })
export const patch = <T = any>(p: string, body: any = {}) => api<T>(p, { method: 'PATCH', body })
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' })

export async function download(path: string, filename: string) {
  const res: Response = await api(path, { raw: true })
  if (!res.ok) throw new ApiError(res.status, 'Export failed', null)
  const blob = await res.blob()
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
