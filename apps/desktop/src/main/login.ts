import type { Session } from 'electron'
import QRCode from 'qrcode'
import type { LoginAvailability, ProviderId, QrLoginSession } from '../shared/contracts.js'
import type { LoginTicket, MusicProvider } from './api/provider.js'
import { message, RequestFailure } from './api/transport.js'
import { logEvent } from './logger.js'

type Attempt = { id: string; provider: MusicProvider; jar: Session; controller: AbortController;
  ticket?: LoginTicket; view?: QrLoginSession; revision: number; timer?: NodeJS.Timeout; deadline?: NodeJS.Timeout;
  transientJar: boolean; expireRemote: boolean; ticketExpired?: boolean; cleanup?: Promise<void>; pollFailures: number; failure?: string }
type Cooldown = { retryAt: number; message?: string }
export class QrLogins {
  private attempts = new Map<ProviderId, Attempt>()
  private cooldowns = new Map<ProviderId, Cooldown>()
  private operations = new Map<ProviderId, symbol>()
  private cleanups = new Map<ProviderId, Promise<void>>()
  private availabilitySequence = 0
  constructor(private changed: (view: QrLoginSession) => void, private accountChanged: () => void,
    private availabilityChanged: (state: LoginAvailability) => void) {}
  availability(provider: ProviderId): LoginAvailability {
    const cooldown = this.cooldowns.get(provider)
    return { provider, sequence: this.availabilitySequence, busy: this.operations.has(provider) || this.cleanups.has(provider),
      retryAt: cooldown?.retryAt || 0,
      message: (cooldown?.retryAt || 0) > Date.now() ? cooldown?.message : undefined }
  }
  private publishAvailability(provider: ProviderId) {
    this.availabilitySequence++
    this.availabilityChanged(this.availability(provider))
  }
  private begin(provider: ProviderId) {
    const state = this.availability(provider)
    if (state.busy) throw new Error('上一项登录请求正在处理或结束，请稍候')
    if (state.retryAt > Date.now()) throw new Error(`请等待 ${Math.ceil((state.retryAt - Date.now()) / 1000)} 秒后手动重试；平台限制可能持续更久`)
    const operation = Symbol()
    this.operations.set(provider, operation)
    this.publishAvailability(provider)
    return operation
  }
  private end(provider: ProviderId, operation: symbol) {
    if (this.operations.get(provider) === operation) this.operations.delete(provider)
    this.publishAvailability(provider)
  }
  private rememberFailure(provider: ProviderId, error: unknown) {
    if (!(error instanceof RequestFailure) || !error.rateLimited && error.retryAfterMs <= 0) return
    const state = this.availability(provider)
    const retryAt = Math.max(state.retryAt, Date.now() + Math.max(error.retryAfterMs, error.rateLimited ? 60_000 : 0))
    this.cooldowns.set(provider, { retryAt,
      message: error.rateLimited ? '平台限制了登录请求，已停止自动重试' : '平台要求等待后再重试' })
    logEvent({ provider, stage: 'login.cooldown', outcome: 'error', httpStatus: error.httpStatus,
      platformCode: error.statusCode, logId: error.logId, retryAfterMs: retryAt - Date.now(),
      message: '已暂停登录请求；倒计时结束不代表平台限制解除' })
    this.publishAvailability(provider)
  }
  private trackCleanup(provider: ProviderId, cleanup: Promise<void>) {
    const pending = Promise.all([this.cleanups.get(provider), cleanup]).then(() => {})
    this.cleanups.set(provider, pending)
    this.publishAvailability(provider)
    void pending.then(() => {
      if (this.cleanups.get(provider) === pending) this.cleanups.delete(provider)
      this.publishAvailability(provider)
    })
  }
  private current(attempt: Attempt) { return this.attempts.get(attempt.provider.id) === attempt && !attempt.controller.signal.aborted }
  async start(provider: MusicProvider, id: string): Promise<QrLoginSession> {
    const operation = this.begin(provider.id)
    this.cancelProvider(provider.id)
    const previousCleanup = this.cleanups.get(provider.id)
    const loginSession = provider.loginSession(id)
    const jar = loginSession.jar
    jar.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    const attempt: Attempt = { id, provider, jar, controller: new AbortController(), revision: provider.revision,
      transientJar: loginSession.transient, expireRemote: true, pollFailures: 0 }
    this.attempts.set(provider.id, attempt)
    // Includes native initialization and QR generation, not just HTTP timeouts.
    attempt.deadline = setTimeout(() => this.fail(attempt, 'error', '生成二维码超时，请重试'), 65_000)
    try {
      await previousCleanup
      if (!this.current(attempt)) throw new Error('登录请求已取消')
      const ticket = await provider.createLogin(jar, attempt.controller.signal)
      attempt.ticket = ticket
      if (!this.current(attempt)) throw new Error('登录请求已取消')
      const suppliedImage = 'imageDataUrl' in ticket && typeof ticket.imageDataUrl === 'string' ? ticket.imageDataUrl : undefined
      const imageDataUrl = suppliedImage || await QRCode.toDataURL(ticket.content, { width: 260, margin: 2, errorCorrectionLevel: 'M' })
      if (!this.current(attempt)) throw new Error('登录请求已取消')
      clearTimeout(attempt.deadline)
      attempt.view = { id, provider: provider.id, imageDataUrl, state: 'waiting',
        message: provider.id === 'qishui' ? '请使用汽水音乐 App 扫码' : '请使用网易云音乐 App 扫码',
        expiresAt: ticket.expiresAt, sequence: 1, checkCount: 0 }
      attempt.deadline = setTimeout(() => this.fail(attempt, 'expired', '二维码已过期，请刷新', false), Math.max(0, ticket.expiresAt - Date.now()))
      attempt.view.nextCheckAt = Date.now() + 1600
      attempt.timer = setTimeout(() => void this.poll(attempt), 1600)
      return { ...attempt.view }
    } catch (error) {
      this.rememberFailure(provider.id, error)
      if (this.current(attempt)) this.fail(attempt, 'error', message(error), !(error instanceof RequestFailure))
      else this.clean(attempt)
      throw new Error(attempt.failure || message(error))
    } finally { this.end(provider.id, operation) }
  }
  private async validateAccount(attempt: Attempt) {
    const stage = 'qr.account.validate'
    const startedAt = Date.now()
    logEvent({ provider: attempt.provider.id, stage, outcome: 'start' })
    try {
      await attempt.provider.acceptLogin(attempt.jar, attempt.controller.signal, attempt.revision)
      logEvent({ provider: attempt.provider.id, stage, outcome: 'success', durationMs: Date.now() - startedAt })
    } catch (error) {
      this.logFailure(attempt.provider.id, stage, error, startedAt)
      throw error
    }
  }
  private logFailure(provider: ProviderId, stage: string, error: unknown, startedAt: number, reason = message(error)) {
    logEvent({ provider, stage, outcome: 'error', durationMs: Date.now() - startedAt, message: reason,
      httpStatus: error instanceof RequestFailure ? error.httpStatus : undefined,
      platformCode: error instanceof RequestFailure ? error.statusCode : undefined,
      logId: error instanceof RequestFailure ? error.logId : undefined })
  }
  private async poll(attempt: Attempt) {
    if (!this.current(attempt) || !attempt.ticket || !attempt.view) return
    if (this.availability(attempt.provider.id).busy) {
      attempt.timer = setTimeout(() => void this.poll(attempt), 500)
      return
    }
    if (this.availability(attempt.provider.id).retryAt > Date.now()) {
      this.fail(attempt, 'error', '平台要求暂停登录请求，请等待后手动刷新', false)
      return
    }
    const operation = this.begin(attempt.provider.id)
    try {
      const result = await attempt.provider.pollLogin(attempt.jar, attempt.ticket.token, attempt.controller.signal)
      if (result.rateLimit) this.rememberFailure(attempt.provider.id, result.rateLimit)
      if (!this.current(attempt)) return
      attempt.pollFailures = 0
      attempt.view = { ...attempt.view, sequence: attempt.view.sequence + 1, checkCount: attempt.view.checkCount + 1,
        checkedAt: Date.now(), nextCheckAt: undefined, platformStatus: result.platformStatus }
      if (result.state === 'expired') { this.fail(attempt, 'expired', '二维码已失效，请刷新', false); return }
      if (result.state === 'confirmed') {
        // The QR has been consumed; its expiry must not interrupt account validation.
        clearTimeout(attempt.deadline)
        attempt.deadline = setTimeout(() => this.fail(attempt, 'error', '手机已确认，但账号校验超时，请稍后重新登录', false), 30_000)
        attempt.view = { ...attempt.view, state: 'validating', imageDataUrl: '', message: '手机已确认，正在校验账号…',
          sequence: attempt.view.sequence + 1, nextCheckAt: undefined }
        this.changed(attempt.view)
        await this.validateAccount(attempt)
        if (!this.current(attempt)) return
        attempt.view = { ...attempt.view, state: 'confirmed', imageDataUrl: '', message: '扫码登录成功', sequence: attempt.view.sequence + 1 }
        this.changed(attempt.view)
        this.accountChanged()
        this.attempts.delete(attempt.provider.id)
        this.clean(attempt, false)
        return
      }
      const pollAfterMs = Math.max(1000, Math.min(result.pollAfterMs || 2000, 10_000))
      const nextCheckAt = Date.now() + pollAfterMs
      const view: QrLoginSession = { ...attempt.view, state: result.state, nextCheckAt,
        message: result.message || (result.state === 'scanned' ? '已扫码，请在手机上确认登录' : '等待扫码，正在持续检查平台状态') }
      attempt.view = view
      this.changed(view)
      attempt.timer = setTimeout(() => void this.poll(attempt), pollAfterMs)
    } catch (error) {
      this.rememberFailure(attempt.provider.id, error)
      if (!this.current(attempt)) return
      const validating = attempt.view.state === 'validating'
      if (!validating && error instanceof RequestFailure && error.retryable && !error.rateLimited && attempt.pollFailures < 3
        && Date.now() < attempt.view.expiresAt) {
        attempt.pollFailures++
        const retryDelay = Math.max(error.retryAfterMs, 1200 * attempt.pollFailures)
        if (Date.now() + retryDelay >= attempt.view.expiresAt) {
          this.fail(attempt, 'error', '平台要求等待，当前二维码将先过期；请等待后手动刷新', false)
          return
        }
        attempt.view = { ...attempt.view, sequence: attempt.view.sequence + 1, checkCount: attempt.view.checkCount + 1,
          checkedAt: Date.now(), nextCheckAt: Math.min(Date.now() + retryDelay, attempt.view.expiresAt),
          platformStatus: error.statusCode || attempt.view.platformStatus,
          message: `网络波动，正在重试（${attempt.pollFailures}/3）` }
        this.changed(attempt.view)
        attempt.timer = setTimeout(() => void this.poll(attempt), retryDelay)
      } else {
        attempt.view = { ...attempt.view, checkCount: attempt.view.checkCount + 1, checkedAt: Date.now(),
          platformStatus: error instanceof RequestFailure ? error.statusCode || String(error.httpStatus || '') : attempt.view.platformStatus }
        this.fail(attempt, 'error', validating ? `手机已确认，但账号校验失败：${message(error)}` : message(error),
          !validating && !(error instanceof RequestFailure))
      }
    } finally { this.end(attempt.provider.id, operation) }
  }
  private fail(attempt: Attempt, state: 'expired' | 'error' | 'cancelled', reason: string, expireRemote = true) {
    if (this.attempts.get(attempt.provider.id) !== attempt) return
    attempt.failure = reason
    if (attempt.view) this.changed({ ...attempt.view, state, imageDataUrl: '', message: reason,
      nextCheckAt: undefined, sequence: attempt.view.sequence + 1 })
    this.attempts.delete(attempt.provider.id)
    this.clean(attempt, expireRemote)
  }
  private clean(attempt: Attempt, expire = true) {
    // A late QR creation failure must not restart native components after window close.
    if (!expire) attempt.expireRemote = false
    clearTimeout(attempt.timer)
    clearTimeout(attempt.deadline)
    attempt.controller.abort()
    // Serialize repeated cleanup, including tickets that arrive after cancellation.
    attempt.cleanup = (attempt.cleanup || Promise.resolve()).then(async () => {
      if (attempt.ticket && !attempt.ticketExpired) {
        attempt.ticketExpired = true
        const remote = attempt.expireRemote && this.availability(attempt.provider.id).retryAt <= Date.now()
        await attempt.provider.expireLogin(attempt.jar, attempt.ticket.token, remote)
          .catch(error => this.rememberFailure(attempt.provider.id, error))
      }
      if (attempt.transientJar) {
        await attempt.jar.closeAllConnections()
        await attempt.jar.clearStorageData()
      } else {
        await attempt.jar.cookies.flushStore()
      }
    }).catch(() => {})
    this.trackCleanup(attempt.provider.id, attempt.cleanup)
  }
  async cancel(id: string) {
    const providers = new Set<ProviderId>()
    for (const attempt of this.attempts.values()) if (attempt.id === id) providers.add(attempt.provider.id)
    for (const attempt of this.attempts.values()) if (attempt.id === id) this.fail(attempt, 'cancelled', '登录已取消')
    await Promise.all([...providers].map(provider => this.cleanups.get(provider)))
  }
  cancelProvider(id: ProviderId) {
    const attempt = this.attempts.get(id); if (attempt) this.fail(attempt, 'cancelled', '登录已取消')
  }
  close() {
    for (const attempt of this.attempts.values()) this.clean(attempt, false)
    this.attempts.clear()
    // Do not reset cooldowns or outstanding requests when the renderer reloads.
  }
}
