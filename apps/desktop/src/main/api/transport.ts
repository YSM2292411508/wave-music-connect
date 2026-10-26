import { net, type Session } from 'electron'

export type JsonObject = Record<string, any>
export function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}
export function array(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object) : []
}
export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback
}
function normalizedImageUrl(value: string): string | undefined {
  const raw = value.trim()
  if (!raw) return undefined
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
    if (url.protocol === 'http:') url.protocol = 'https:'
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}
export function imageUrl(value: unknown, depth = 0, seen = new Set<object>()): string | undefined {
  if (depth > 6 || value === undefined || value === null) return undefined
  if (typeof value === 'string') return normalizedImageUrl(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = imageUrl(item, depth + 1, seen)
      if (result) return result
    }
    return undefined
  }
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return undefined
  seen.add(value)
  const raw = value as Record<string, unknown>
  // Qishui's URLInfo is not a normal URL: the SDK combines its CDN base, URI,
  // and resize template to produce the usable image address.
  const uri = typeof raw.uri === 'string' ? raw.uri : ''
  const cdn = Array.isArray(raw.urls) && typeof raw.urls[0] === 'string' ? raw.urls[0] : ''
  if (uri && cdn) {
    const width = 400
    const height = width
    const suffix = typeof raw.template_prefix === 'string' && raw.template_prefix
      ? `${raw.template_prefix}-crop-center:${width}:${height}.jpg`
      : `c5_${width}x${height}.jpg`
    const resolved = normalizedImageUrl(`${cdn}${uri}~${suffix}`)
    if (resolved) return resolved
  }
  // Platform responses use several equivalent shapes, sometimes nested more than once.
  for (const key of ['url_cover', 'cover_url', 'coverUrl', 'cover', 'cover_image', 'cover_image_url', 'cover_info', 'coverInfo',
    'album_cover', 'picUrl', 'pic_url', 'pic', 'image_url', 'imageUrl', 'image_info', 'avatar_url', 'avatar',
    'url', 'image_uri', 'url_list', 'uri_list', 'urls', 'origin_url', 'large', 'medium', 'small', 'thumbnail', 'image']) {
    const result = imageUrl(raw[key], depth + 1, seen)
    if (result) return result
  }
  return undefined
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请重试'
}
export class RequestFailure extends Error {
  readonly retryable: boolean
  readonly retryAfterMs: number
  readonly statusCode?: string
  readonly httpStatus?: number
  readonly logId?: string
  readonly rateLimited: boolean
  constructor(reason: string, options: { retryable?: boolean; retryAfterMs?: number; statusCode?: string;
    httpStatus?: number; logId?: string; rateLimited?: boolean } = {}) {
    super(reason)
    this.name = 'RequestFailure'
    this.retryable = options.retryable === true && !options.rateLimited
    this.retryAfterMs = options.retryAfterMs || 0
    this.statusCode = options.statusCode
    this.httpStatus = options.httpStatus
    this.logId = options.logId
    this.rateLimited = options.rateLimited === true
  }
}
// Retry-After permits both seconds and an HTTP date. Never shorten a server deadline.
export function retryAfterMs(headers: Record<string, string[]>, now = Date.now()): number {
  const value = headers['retry-after']?.[0]?.trim()
  if (!value) return 0
  const duration = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(duration) ? Math.max(0, Math.min(Math.ceil(duration), Number.MAX_SAFE_INTEGER - now)) : 0
}
// Show only a bounded, redacted description, never a response dump or login URL.
export function diagnostic(value: unknown): string {
  return text(value).replace(/https?:\/\/[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/(?:[\w-]*(?:token|cookie|ticket|session|secret|sign)[\w-]*)[\s"']*[:=][\s"']*[^\s,;}"']+/gi, '[凭据已隐藏]')
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, '[长标识已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 180)
}
export async function cookie(jar: Session, name: string, url: string): Promise<string> {
  return (await jar.cookies.get({ url, name }))[0]?.value || ''
}
export type HttpResult = { data: JsonObject; headers: Record<string, string[]>; statusCode: number }
export async function requestJson(jar: Session, url: string, options: {
  method?: 'GET' | 'POST'
  body?: string | Buffer
  headers?: Record<string, string>
  signal?: AbortSignal
} = {}): Promise<HttpResult> {
  if (options.signal?.aborted) throw new Error('请求已取消')
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: options.method || 'GET', session: jar,
      useSessionCookies: true, credentials: 'include', redirect: 'error' })
    let settled = false
    const finish = (error?: Error, result?: HttpResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = () => { finish(new Error('请求已取消')); request.abort() }
    const timer = setTimeout(() => { finish(new RequestFailure('平台请求超时，请重试', { retryable: true })); request.abort() }, 20_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    for (const [key, value] of Object.entries(options.headers || {})) request.setHeader(key, value)
    request.on('error', () => finish(new RequestFailure('网络请求失败，请检查网络连接', { retryable: true })))
    request.on('response', response => {
      const chunks: Buffer[] = []
      let size = 0
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value : [value]]))
      const logId = headers['x-tt-logid']?.[0]
      response.on('error', () => finish(new RequestFailure('读取平台响应失败', { retryable: true })))
      response.on('data', chunk => {
        size += chunk.length
        if (size > 16 * 1024 * 1024) { finish(new Error('平台响应过大')); request.abort(); return }
        chunks.push(Buffer.from(chunk))
      })
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const rateLimited = response.statusCode === 429
          finish(new RequestFailure(rateLimited ? '平台访问频率受限，已停止自动重试' : `平台返回 HTTP ${response.statusCode}`, {
            retryable: [408, 500, 502, 503, 504].includes(response.statusCode),
            retryAfterMs: retryAfterMs(headers), rateLimited, httpStatus: response.statusCode, logId,
          })); return
        }
        if (response.headers['bdturing-verify'] || response.headers['x-tt-verify-passport-decision']) {
          finish(new RequestFailure('平台要求额外安全验证，请使用官方客户端处理；本软件暂不能完成该验证', {
            statusCode: 'security-verification', httpStatus: response.statusCode, logId,
          })); return
        }
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
          finish(undefined, { data: object(parsed), headers, statusCode: response.statusCode })
        } catch {
          const contentType = headers['content-type']?.[0]?.toLowerCase() || ''
          finish(new RequestFailure(contentType.includes('text/html')
            ? '平台返回网页而不是接口数据，接口地址可能已失效'
            : `平台返回了无法识别的数据（HTTP ${response.statusCode}）`, {
            httpStatus: response.statusCode, logId,
          }))
        }
      })
    })
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}
