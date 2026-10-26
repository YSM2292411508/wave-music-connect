import { randomUUID } from 'node:crypto'
import { net, protocol } from 'electron'
import type { ProviderId, PlaybackSource } from '../shared/contracts.js'
import type { AuthorizedMedia } from './api/provider.js'

type Grant = AuthorizedMedia & { provider: ProviderId; requests: Set<AbortController> }
const domains: Record<ProviderId, string[]> = {
  netease: ['music.126.net'],
  qishui: ['douyinvod.com', 'bytecdn.cn', 'bytecdntp.com', 'ibytedtos.com', 'pstatp.com', 'byteimg.com',
    'zijieapi.com', 'qishui.com', 'bytedance.com', 'bytedance.net', 'byted.org', 'snssdk.com'],
}
function allowed(provider: ProviderId, input: string): string {
  const url = new URL(input)
  if (url.protocol === 'http:') url.protocol = 'https:'
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
    || !domains[provider].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw new Error('平台返回了不受信任的媒体地址，已拒绝播放')
  return url.href
}
export class MediaStreams {
  private grants = new Map<string, Grant>()
  constructor() {
    setInterval(() => {
      for (const [id, grant] of this.grants) if (grant.expiresAt <= Date.now()) this.remove(id)
    }, 15_000).unref()
  }
  add(provider: ProviderId, source: AuthorizedMedia): PlaybackSource {
    const url = allowed(provider, source.url)
    if (!Number.isFinite(source.expiresAt) || source.expiresAt <= Date.now()) throw new Error('播放授权已过期，请重试')
    // A small bounded queue; never save signed platform media URLs to disk.
    while (this.grants.size >= 8) this.remove(this.grants.keys().next().value!)
    const id = randomUUID()
    this.grants.set(id, { ...source, url, provider, requests: new Set() })
    return { url: `wave-media://stream/${id}`, expiresAt: source.expiresAt }
  }
  release(url: string) {
    try { const parsed = new URL(url); if (parsed.protocol === 'wave-media:' && parsed.host === 'stream') this.remove(parsed.pathname.slice(1)) } catch { /* Already released. */ }
  }
  private remove(id: string) {
    const grant = this.grants.get(id)
    if (grant) for (const controller of grant.requests) controller.abort()
    this.grants.delete(id)
  }
  revoke(provider?: ProviderId) { for (const [id, grant] of this.grants) if (!provider || grant.provider === provider) this.remove(id) }
  register() {
    protocol.handle('wave-media', async request => {
      const url = new URL(request.url)
      const id = url.pathname.slice(1)
      const grant = url.host === 'stream' ? this.grants.get(id) : undefined
      if (!grant || grant.expiresAt <= Date.now()) return new Response(null, { status: 410 })
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
      const range = request.headers.get('range')
      if (range && !/^bytes=\d*-\d*$/.test(range)) return new Response(null, { status: 416 })
      if (grant.requests.size >= 8) return new Response(null, { status: 429 })
      const controller = new AbortController()
      grant.requests.add(controller)
      const abort = () => controller.abort()
      request.signal.addEventListener('abort', abort, { once: true })
      const cleanup = () => { grant.requests.delete(controller); request.signal.removeEventListener('abort', abort); clearTimeout(timeout) }
      const timeout = setTimeout(() => controller.abort(), Math.min(grant.expiresAt - Date.now(), 30 * 60_000))
      try {
        let target = grant.url
        let response: Response | undefined
        for (let i = 0; i <= 3; i++) {
          response = await net.fetch(allowed(grant.provider, target), { method: request.method,
            redirect: 'manual', credentials: 'omit', headers: range ? { Range: range } : {}, signal: controller.signal })
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location')
            await response.body?.cancel()
            if (!location) throw new Error('Missing redirect')
            target = new URL(location, target).href
          } else break
        }
        if (!response || ![200, 206].includes(response.status)) { cleanup(); return new Response(null, { status: 502 }) }
        const headers = new Headers({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' })
        for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const value = response.headers.get(name)
          if (value) headers.set(name, value)
        }
        if (!response.body || request.method === 'HEAD') { cleanup(); return new Response(null, { status: response.status, headers }) }
        const reader = response.body.getReader()
        const body = new ReadableStream({
          async pull(stream) {
            try { const part = await reader.read(); if (part.done) { cleanup(); stream.close() } else stream.enqueue(part.value) }
            catch { cleanup(); stream.error(new Error('媒体流已结束')) }
          },
          async cancel() { cleanup(); controller.abort(); await reader.cancel().catch(() => {}) },
        })
        return new Response(body, { status: response.status, headers })
      } catch { cleanup(); return new Response(null, { status: 502 }) }
    })
  }
}
