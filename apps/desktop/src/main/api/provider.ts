import { session, type Session } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { Playlist, PlaylistPage, ProviderId, ProviderStatus, TrackPage } from '../../shared/contracts.js'
import { RequestFailure } from './transport.js'

export type LoginTicket = { content: string; token: string; expiresAt: number; imageDataUrl?: string }
export type PollResult = { state: 'waiting' | 'scanned' | 'confirmed' | 'expired'; platformStatus?: string;
  message?: string; pollAfterMs?: number; rateLimit?: RequestFailure }
export type AuthorizedMedia = { url: string; expiresAt: number }
export type Account = { id: string; name: string; avatarUrl?: string; vip?: boolean }
export type LoginSession = { jar: Session; transient: boolean }
export abstract class MusicProvider {
  abstract readonly id: ProviderId
  abstract readonly name: string
  abstract readonly shortName: string
  abstract readonly color: string
  abstract readonly origin: string
  account?: Account
  private accountRevision = 0
  private lifetime = new AbortController()
  get revision() { return this.accountRevision }
  set revision(value: number) {
    if (value === this.accountRevision) return
    this.accountRevision = value
    this.lifetime.abort()
    this.lifetime = new AbortController()
  }
  protected requestSignal(signal?: AbortSignal) {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
  }
  private operation = new AsyncLocalStorage<number>()
  async withAccount<T>(action: () => Promise<T>): Promise<T> {
    const revision = this.revision
    return this.operation.run(revision, async () => {
      const result = await action()
      this.checkRevision(revision)
      return result
    })
  }
  protected checkRevision(revision = this.revision) {
    const operationRevision = this.operation.getStore()
    if (revision !== this.revision || operationRevision !== undefined && operationRevision !== this.revision) throw new Error('账号已变更，请重新加载')
  }
  private mutations: Promise<unknown> = Promise.resolve()
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(action)
    this.mutations = next.catch(() => {})
    return next
  }
  get jar(): Session { return session.fromPartition(`persist:wave-api-${this.id}-v1`) }
  loginSession(id: string): LoginSession {
    return { jar: session.fromPartition(`wave-login-${this.id}-${id}`), transient: true }
  }
  status(): ProviderStatus {
    return { id: this.id, name: this.name, shortName: this.shortName, color: this.color,
      connected: Boolean(this.account), sessionRevision: this.revision,
      accountName: this.account?.name, avatarUrl: this.account?.avatarUrl, apiReady: true }
  }
  requireAccount() {
    if (!this.account) throw new Error(`请先登录${this.name}`)
    return this.account
  }
  logout() {
    this.revision++
    this.account = undefined
    return this.mutate(async () => {
      await this.jar.clearStorageData()
      await this.jar.cookies.flushStore()
    })
  }
  async acceptLogin(jar: Session, signal: AbortSignal, expectedRevision: number) {
    const validationDeadline = Date.now() + 20_000
    const validationSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    let account: Account | undefined
    for (let attempt = 0; attempt < 4; attempt++) {
      if (validationSignal.aborted || expectedRevision !== this.revision) throw new Error('账号校验已取消或超时，请重新登录')
      let retryDelay = 600 * (attempt + 1)
      try {
        // Cookies may arrive just after the successful QR status response.
        await jar.cookies.flushStore()
        account = await this.readAccount(jar, validationSignal)
        if (account?.id) break
      } catch (error) {
        if (!(error instanceof RequestFailure && error.retryable) || attempt === 3) throw error
        retryDelay = Math.max(retryDelay, error.retryAfterMs)
        // Propagate the original failure so the login controller can retain the server cooldown.
        if (Date.now() + retryDelay >= validationDeadline) throw error
      }
      if (attempt < 3) await delay(retryDelay, undefined, { signal: validationSignal })
    }
    if (!account?.id) throw new Error('平台已确认登录，但登录凭据或账号资料未就绪，请重新登录')
    const verifiedAccount = account
    return this.mutate(async () => {
      if (signal.aborted || expectedRevision !== this.revision) throw new Error('登录已取消')
      // Abort old requests before replacing cookies, not after the new account commits.
      const revision = ++this.revision
      const target = this.jar
      if (jar === target) {
        await target.cookies.flushStore()
        if (signal.aborted || revision !== this.revision) throw new Error('登录已取消')
        this.account = verifiedAccount
        return
      }
      await target.clearStorageData()
      try {
        for (const value of await jar.cookies.get({})) {
          if (signal.aborted || revision !== this.revision) throw new Error('登录已取消')
          const domain = value.domain || new URL(this.origin).hostname
          const host = domain.replace(/^\./, '')
          const originHost = new URL(this.origin).hostname
          const root = this.id === 'qishui' ? 'qishui.com' : '163.com'
          if (!(host === originHost || host === root || host.endsWith(`.${root}`))) continue
          const { hostOnly: _hostOnly, session: _session, ...details } = value
          await target.cookies.set({ ...details, url: `https://${host}${value.path || '/'}` })
        }
        await target.cookies.flushStore()
        if (signal.aborted || revision !== this.revision) throw new Error('登录已取消')
        this.account = verifiedAccount
      } catch (error) {
        this.account = undefined
        await target.clearStorageData()
        throw error
      }
    })
  }
  async refresh() {
    const revision = this.revision
    const account = await this.withAccount(() => this.readAccount(this.jar))
    if (revision === this.revision) {
      if (this.account?.id !== account?.id) this.revision++
      this.account = account
    }
  }
  protected abstract readAccount(jar: Session, signal?: AbortSignal): Promise<Account | undefined>
  abstract createLogin(jar: Session, signal: AbortSignal): Promise<LoginTicket>
  abstract pollLogin(jar: Session, token: string, signal: AbortSignal): Promise<PollResult>
  async expireLogin(_jar: Session, _token: string, _remote = true): Promise<void> {}
  abstract search(query: string, cursor?: string): Promise<TrackPage>
  abstract playlists(cursor?: string): Promise<PlaylistPage>
  abstract playlistTracks(playlistId: string, cursor?: string): Promise<TrackPage>
  abstract createPlaylist(name: string, privatePlaylist: boolean): Promise<Playlist>
  abstract addToPlaylist(trackId: string, playlistId: string): Promise<void>
  abstract playback(trackId: string): Promise<AuthorizedMedia>
}
