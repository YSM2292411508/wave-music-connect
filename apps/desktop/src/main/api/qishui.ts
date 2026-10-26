import { app, session, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { hostname, version as osVersion } from 'node:os'
import { join } from 'node:path'
import type { CookieMap, QishuiCore, QishuiLogin } from 'qishui-core' with { 'resolution-mode': 'import' }
import type { Playlist, PlaylistPage, ProviderStatus, TrackPage, TrackResult } from '../../shared/contracts.js'
import { MusicProvider, type LoginTicket, type PollResult } from './provider.js'
import { array, cookie, diagnostic, imageUrl, object, requestJson, RequestFailure, retryAfterMs, text, type JsonObject } from './transport.js'
import { logEvent } from '../logger.js'

const WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136 Safari/537.36'
const PC_USER_AGENT = 'LunaPC/3.7.0(official)'
const APP = {
  aid: '386088',
  name: 'luna_pc',
  version: '3.7.0',
  channel: 'official',
  package: 'com.soda.music',
}
type DeviceIdentity = { deviceId: string; installId: string; cdid: string }
type QishuiLoginFlow = { login: QishuiLogin; scanned: boolean; initialSession: string }

function sessionSignature(values: CookieMap) {
  return ['sessionid', 'sessionid_ss', 'sid_tt', 'passport_assist_user']
    .map(name => values[name] ? `${name}:${values[name]}` : '')
    .filter(Boolean)
    .join('|')
}

function validDevice(value: unknown): value is DeviceIdentity {
  const device = object(value)
  return /^\d{5,32}$/.test(text(device.deviceId))
    && /^\d{5,32}$/.test(text(device.installId))
    && /^[A-Za-z0-9-]{16,64}$/.test(text(device.cdid))
}

function qrExpiry(value: unknown) {
  const now = Date.now()
  const raw = Number(value)
  const remote = raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : raw > 0 ? now + raw * 1000 : 0
  return remote > now + 5000 && remote < now + 30 * 60_000 ? remote : now + 120_000
}

function httpsUrl(value: unknown) {
  const raw = text(value)
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}

class LegacyQishuiProvider extends MusicProvider {
  readonly id = 'qishui' as const
  readonly name = '汽水音乐'
  readonly shortName = '汽水'
  readonly color = '#20c997'
  readonly origin = 'https://api.qishui.com'
  private readonly h5Origin = 'https://beta-luna.douyin.com'
  private device?: DeviceIdentity
  private devicePromise?: Promise<DeviceIdentity>
  get jar(): Session { return session.fromPartition('persist:wave-api-qishui-v2') }
  loginSession() { return { jar: this.jar, transient: false } }

  status(): ProviderStatus {
    return { ...super.status(), apiReady: true,
      apiMessage: this.account
        ? '汽水账号已连接；登录信息仅保存在本软件中'
        : '访客模式可搜索并播放平台公开提供的内容；平台歌单可使用汽水音乐 App 扫码连接' }
  }

  private async ensureDevice(): Promise<DeviceIdentity> {
    if (this.device) return this.device
    if (!this.devicePromise) {
      this.devicePromise = this.loadOrRegisterDevice().catch(error => {
        this.devicePromise = undefined
        throw error
      })
    }
    this.device = await this.devicePromise
    return this.device
  }

  private async loadOrRegisterDevice(): Promise<DeviceIdentity> {
    const path = join(app.getPath('userData'), 'qishui-device-v2.json')
    try {
      const saved: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (validDevice(saved)) return saved
    } catch {}

    const startedAt = Date.now()
    const cdid = randomUUID()
    const platformVersion = `Windows 10: ${osVersion()}`
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    const url = new URL('/service/2/desktop/device_register/', this.origin)
    for (const [key, value] of Object.entries({
      aid: APP.aid, channel: APP.channel, os: 'Windows', os_version: platformVersion,
      device_platform: 'PC', app_version: APP.version,
    })) url.searchParams.set(key, value)
    const body = JSON.stringify({
      header: {
        device_id: '', install_id: '', os: 'Windows', device_platform: 'PC', sdk_version: '1.0', sdk_version_code: 1,
        aid: Number(APP.aid), mc: '00:00:00:00:00:00', channel: APP.channel, package: APP.package,
        language: 'zh-CN', app_version: APP.version, os_version: platformVersion, device_model: 'no detected',
        time_zone: timeZone, tz_name: timeZone, tz_offset: 0, resolution: 'no detected', app_region: 'cn',
        app_language: 'zh-CN', display_name: '汽水音乐', pc_uuid: randomUUID(), pc_serial: '',
      },
      gen_time: Date.now(), magic_tag: 'ss_app_log',
    })
    try {
      const response = await requestJson(this.jar, url.href, {
        method: 'POST', body,
        headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': PC_USER_AGENT },
      })
      const detail = object(response.data.data)
      const statusCode = Number(response.data.status_code || detail.status_code || 0)
      if (statusCode !== 0) {
        throw new RequestFailure(`汽水设备注册失败（错误码 ${statusCode}）`, {
          statusCode: String(statusCode), httpStatus: response.statusCode, logId: response.headers['x-tt-logid']?.[0],
        })
      }
      const device = {
        deviceId: text(response.data.device_id_str || detail.device_id_str),
        installId: text(response.data.install_id_str || detail.install_id_str),
        cdid,
      }
      if (!validDevice(device)) throw new Error('汽水设备注册未返回有效设备标识')
      await writeFile(path, JSON.stringify(device), 'utf8')
      logEvent({ provider: this.id, stage: 'device.register', outcome: 'success', durationMs: Date.now() - startedAt,
        httpStatus: response.statusCode, platformCode: '0', logId: response.headers['x-tt-logid']?.[0] })
      return device
    } catch (error) {
      logEvent({ provider: this.id, stage: 'device.register', outcome: 'error', durationMs: Date.now() - startedAt,
        httpStatus: error instanceof RequestFailure ? error.httpStatus : undefined,
        platformCode: error instanceof RequestFailure ? error.statusCode : undefined,
        logId: error instanceof RequestFailure ? error.logId : undefined,
        message: error instanceof Error ? error.message : '设备注册失败' })
      throw error
    }
  }

  private async passportParams() {
    const device = await this.ensureDevice()
    return {
      passport_jssdk_version: '4.2.3', passport_jssdk_type: 'lite', is_from_ttaccountsdk: '1', account_sdk_source: 'web',
      aid: APP.aid, device_id: device.deviceId, iid: device.installId, cdid: device.cdid, device_platform: 'PC',
      version_code: APP.version, version_name: APP.version, channel: APP.channel, os: 'Windows', language: 'zh',
    }
  }

  private async hasSession(jar: Session) {
    for (const name of ['sessionid', 'sessionid_ss', 'sid_tt', 'passport_assist_user']) {
      if (await cookie(jar, name, this.origin)) return true
    }
    return false
  }

  private async passportRequest(path: string, params: JsonObject, body: JsonObject | undefined, jar: Session, signal?: AbortSignal) {
    const revision = this.revision
    signal = this.requestSignal(signal)
    this.checkRevision(revision)
    const url = new URL(path, this.origin)
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    const requestBody = body ? new URLSearchParams(body as Record<string, string>).toString() : undefined
    const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*', 'User-Agent': WEB_USER_AGENT }
    if (requestBody !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const stage = path.endsWith('/get_qrcode/') ? 'passport.web.qr.create' : 'passport.web.qr.poll'
    const startedAt = Date.now()
    try {
      const response = await requestJson(jar, url.href, { method: requestBody === undefined ? 'GET' : 'POST', headers, body: requestBody, signal })
      this.checkRevision(revision)
      const detail = object(response.data.data)
      const errorCode = Number(detail.error_code || response.data.error_code || 0)
      if (response.data.message === 'error' || errorCode !== 0) {
        const description = diagnostic(detail.description || detail.error_description || detail.error_msg || detail.message
          || response.data.description || response.data.error_description || response.data.error_msg)
        const reason = errorCode === 7
          ? '汽水登录请求过于频繁（错误码 7），已停止自动请求'
          : errorCode === 4031
            ? '汽水登录参数已失效（错误码 4031），需要更新客户端协议参数'
            : `汽水登录接口拒绝请求（错误码 ${errorCode || '未知'}${description ? `：${description}` : ''}）`
        throw new RequestFailure(reason, {
          statusCode: String(errorCode || 'unknown'), httpStatus: response.statusCode,
          logId: response.headers['x-tt-logid']?.[0], retryAfterMs: retryAfterMs(response.headers), rateLimited: errorCode === 7,
        })
      }
      logEvent({ provider: this.id, stage, outcome: 'success', durationMs: Date.now() - startedAt,
        httpStatus: response.statusCode, platformCode: '0', logId: response.headers['x-tt-logid']?.[0],
        hasSession: await this.hasSession(jar) })
      return detail
    } catch (error) {
      logEvent({ provider: this.id, stage, outcome: 'error', durationMs: Date.now() - startedAt,
        httpStatus: error instanceof RequestFailure ? error.httpStatus : undefined,
        platformCode: error instanceof RequestFailure ? error.statusCode : undefined,
        retryAfterMs: error instanceof RequestFailure ? error.retryAfterMs : undefined,
        logId: error instanceof RequestFailure ? error.logId : undefined,
        message: error instanceof Error ? error.message : '请求失败' })
      throw error
    }
  }

  private async commonPcParams() {
    const device = await this.ensureDevice()
    return {
      aid: APP.aid, app_name: APP.name, region: 'cn', geo_region: 'cn', os_region: 'cn', sim_region: '',
      device_id: device.deviceId, cdid: device.cdid, iid: device.installId, version_name: APP.version, version_code: APP.version,
      channel: APP.channel, build_mode: 'master', network_carrier: '', ac: 'wifi', language: 'zh',
      tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone, resolution: '', device_platform: 'PC',
      device_type: 'Windows', os: 'Windows', os_version: `Windows 10: ${osVersion()}`, fp: device.deviceId,
    }
  }

  private async pcRequest(path: string, params: JsonObject = {}, body?: JsonObject, jar = this.jar, signal?: AbortSignal) {
    const revision = this.revision
    signal = this.requestSignal(signal)
    this.checkRevision(revision)
    const url = new URL(path, this.origin)
    for (const [key, value] of Object.entries({ ...await this.commonPcParams(), ...params })) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }
    const requestBody = body === undefined ? undefined : JSON.stringify(body)
    const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*', 'User-Agent': PC_USER_AGENT,
      'x-luna-background-type': 'foreground', 'x-luna-is-background-req': '0', 'x-luna-is-local-user': this.account ? '1' : '0' }
    if (requestBody !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'
    const response = await requestJson(jar, url.href, { method: requestBody === undefined ? 'GET' : 'POST', headers,
      body: requestBody, signal })
    this.checkRevision(revision)
    const statusCode = Number(response.data.status_code || 0)
    if (statusCode !== 0) {
      if (statusCode === 1000016 && jar === this.jar) { this.revision++; this.account = undefined }
      throw new RequestFailure(`汽水：${text(object(response.data.status_info).status_msg, `接口状态 ${text(statusCode, '未知')}`)}`, {
        statusCode: String(statusCode), httpStatus: response.statusCode,
        logId: response.headers['x-tt-logid']?.[0], retryAfterMs: retryAfterMs(response.headers),
      })
    }
    return response.data
  }

  private async h5Request(origin: string, path: string, params: JsonObject) {
    const revision = this.revision
    const url = new URL(path, origin)
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    const response = await requestJson(this.jar, url.href, { headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': WEB_USER_AGENT },
      signal: this.requestSignal() })
    this.checkRevision(revision)
    if (Number(response.data.status_code || 0) !== 0) throw new Error(`汽水：${text(object(response.data.status_info).status_msg, '访客接口拒绝请求')}`)
    return response.data
  }

  protected async readAccount(jar: Session, signal?: AbortSignal) {
    if (!await this.hasSession(jar)) return undefined
    const data = await this.pcRequest('/luna/pc/me', {}, undefined, jar, signal)
    const info = object(data.my_info)
    if (!info.id) return undefined
    return { id: text(info.id), name: text(info.nickname, '汽水账号'), avatarUrl: imageUrl(info.medium_avatar_url || info.larger_avatar_url),
      vip: info.is_vip === true }
  }

  async createLogin(jar: Session, signal: AbortSignal): Promise<LoginTicket> {
    const data = await this.passportRequest('/passport/web/get_qrcode/', {
      ...await this.passportParams(), next: this.origin, need_logo: 'false', need_short_url: 'false', is_new_login: String(true),
    }, undefined, jar, signal)
    const ticketValue = text(data['token'])
    if (!ticketValue) throw new Error('汽水未返回二维码票据，请重试')
    let scanToken = ticketValue
    const indexUrl = httpsUrl(data.qrcode_index_url)
    if (indexUrl) {
      try { scanToken = new URL(indexUrl).searchParams.get('token') || ticketValue } catch {}
    }
    const content = new URL('https://bff-pc.qishui.com/light/invoke/scan_login')
    content.searchParams.set('token', scanToken)
    content.searchParams.set('os', 'Windows')
    content.searchParams.set('computer_name', hostname() || 'Windows PC')
    return { token: ticketValue, content: content.href, expiresAt: qrExpiry(data.expire_time) }
  }

  async pollLogin(jar: Session, ticketValue: string, signal: AbortSignal): Promise<PollResult> {
    const data = await this.passportRequest('/passport/web/check_qrconnect/', {
      ...await this.passportParams(),
    }, { need_logo: 'false', need_short_url: 'false', is_frontier: 'true', token: ticketValue,
      is_new_login: String(true), next: this.origin }, jar, signal)
    const state = text(data.status)
    const states: Record<string, PollResult['state']> = { '1': 'waiting', new: 'waiting', '2': 'scanned', scanned: 'scanned',
      '3': 'confirmed', confirmed: 'confirmed', '4': 'expired', '5': 'expired', expired: 'expired', refused: 'expired' }
    const mapped = states[state]
    if (!mapped) throw new Error('汽水扫码返回未知状态，请刷新重试')
    logEvent({ provider: this.id, stage: 'passport.web.qr.state', outcome: 'success', platformStatus: state })
    return { state: mapped, platformStatus: state }
  }

  private track(raw: JsonObject): TrackResult {
    return { provider: this.id, trackId: text(raw.id), title: text(raw.name, '未命名歌曲'),
      artist: array(raw.artists).map(item => text(item.name)).join(' / ') || '未知歌手',
      album: text(object(raw.album).name), coverUrl: imageUrl(raw.album) || imageUrl(raw), durationMs: Number(raw.duration) || undefined,
      vipRequired: Boolean(object(raw.label_info).only_vip_playable), playback: 'check' }
  }

  private unwrap(item: JsonObject): JsonObject {
    const entity = object(item.entity || item)
    return object(entity.track || object(entity.track_wrapper).track || object(entity.media_resource).track || entity)
  }

  async search(query: string, cursor = ''): Promise<TrackPage> {
    let searchId = randomUUID()
    let offset = '0'
    if (cursor) {
      try {
        const state = object(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
        if (state.query !== query || !/^[a-f0-9-]{36}$/.test(state.searchId) || typeof state.offset !== 'string' || state.offset.length > 1024) throw new Error()
        searchId = state.searchId; offset = state.offset
      } catch { throw new Error('搜索游标已失效，请重新搜索') }
    }
    const data = await this.pcRequest('/luna/search/track', { q: query, cursor: offset, search_id: searchId,
      search_method: 'input', from_search_id: '', search_scene: '' })
    const groups = array(data.result_groups)
    const tracks = groups.flatMap(group => {
      const items = array(group.items)
      return (items.length ? items : array(group.data)).map(item => this.track(this.unwrap(item)))
    }).filter(item => item.trackId)
    const first = groups[0] || {}
    const next = text(first.next_cursor || data.next_cursor)
    const hasMore = Boolean(first.has_more ?? data.has_more)
    return { provider: this.id, tracks, cursor: hasMore && next && next !== offset
      ? Buffer.from(JSON.stringify({ query, searchId, offset: next })).toString('base64url') : undefined }
  }

  private playlist(raw: JsonObject): Playlist {
    return { provider: this.id, id: text(raw.id), name: text(raw.title || raw.name, '未命名歌单'),
      coverUrl: imageUrl(raw.url_cover), trackCount: Number(raw.count_tracks) || 0,
      writable: text(object(raw.owner).id) === this.account?.id && [1, 2].includes(Number(raw.type)) }
  }

  async playlists(cursor = ''): Promise<PlaylistPage> {
    this.requireAccount()
    const revision = this.revision
    const data = await this.pcRequest('/luna/pc/me/playlist', { cursor, count: 50 })
    this.checkRevision(revision)
    return { provider: this.id, playlists: array(data.playlists).map(item => this.playlist(item)),
      cursor: data.has_more ? text(data.next_cursor) || undefined : undefined }
  }

  async playlistTracks(playlistId: string, cursor = ''): Promise<TrackPage> {
    this.requireAccount()
    const data = await this.pcRequest('/luna/pc/playlist/detail', { playlist_id: playlistId, cursor, count: 50,
      session_id: '', reverse: false })
    const items = Array.isArray(data.media_resources) ? array(data.media_resources).map(item => this.unwrap(item)) : array(data.tracks)
    return { provider: this.id, tracks: items.filter(item => item.id && item.name).map(item => this.track(item)),
      cursor: data.has_more ? text(data.next_cursor) || undefined : undefined }
  }

  async createPlaylist(name: string, privatePlaylist: boolean): Promise<Playlist> {
    this.requireAccount()
    const data = await this.pcRequest('/luna/pc/me/playlist', {}, { name, is_private: privatePlaylist })
    const playlist = this.playlist(object(data.playlist))
    if (!playlist.id) throw new Error('平台未返回新歌单，请刷新歌单确认')
    return { ...playlist, writable: true }
  }

  async addToPlaylist(trackId: string, playlistId: string) {
    this.requireAccount()
    await this.pcRequest('/luna/pc/me/playlist/media/append', {}, { playlist_id: playlistId, media: [{ id: trackId, type: 'track' }] })
  }

  private playbackSource(data: JsonObject) {
    const player = object(data.track_player)
    if (Number(data.risk_result || 0)) throw new Error('汽水未通过播放权限或安全校验')
    if (!player.video_model) throw new Error('汽水没有为此歌曲提供访客播放地址')
    let model: JsonObject
    try { model = typeof player.video_model === 'string' ? object(JSON.parse(player.video_model)) : object(player.video_model) }
    catch { throw new Error('汽水播放数据无法解析') }
    const entries = Array.isArray(model.video_list) ? array(model.video_list) : Object.values(object(model.video_list)).map(object)
    for (const item of entries.filter(value => !value.encrypt_info && !value.play_auth && !value.spade_a)) {
      const raw = text(item.main_url || item.backup_url)
      const url = /^https?:\/\//.test(raw) ? raw : Buffer.from(raw, 'base64').toString('utf8')
      if (/^https?:\/\//.test(url)) return { url, expiresAt: Math.min(Number(player.expire_at || data.expire_at) * 1000 || Date.now() + 300_000, Date.now() + 1200_000) }
    }
    throw new Error('此歌曲没有平台直接提供的普通音频地址；不处理加密或额外授权数据')
  }

  async playback(trackId: string) {
    let primaryError: unknown
    try {
      const h5 = await this.h5Request(this.origin, '/luna/h5/track_v2', { track_id: trackId, device_platform: 'web' })
      return this.playbackSource(h5)
    } catch (error) { primaryError = error }
    try {
      const seo = await this.h5Request(this.h5Origin, '/luna/h5/seo_track', { track_id: trackId, device_platform: 'web' })
      return this.playbackSource(seo)
    } catch (seoError) {
      if (!this.account) throw primaryError || seoError
    }
    const pc = await this.pcRequest('/luna/pc/track_v2', { track_id: trackId, media_type: 'track', queue_type: '' })
    return this.playbackSource(pc)
  }
}

export class QishuiProvider extends LegacyQishuiProvider {
  private corePromise?: Promise<QishuiCore>
  private loginFlows = new Map<string, QishuiLoginFlow>()

  private core() {
    if (!this.corePromise) {
      this.corePromise = import('qishui-core').then(({ createQishui }) => createQishui({
        dataDir: join(app.getPath('userData'), 'qishui-core'),
      })).catch(error => {
        this.corePromise = undefined
        throw error
      })
    }
    return this.corePromise
  }

  private async syncCookies(jar: Session, values: CookieMap) {
    const existing = await jar.cookies.get({ url: this.origin })
    for (const value of existing) {
      await jar.cookies.remove(new URL(value.path || '/', this.origin).href, value.name)
    }
    for (const [name, value] of Object.entries(values)) {
      await jar.cookies.set({ url: this.origin, name, value, secure: true })
    }
    await jar.cookies.flushStore()
  }

  protected async readAccount(jar: Session, signal?: AbortSignal) {
    const core = await this.core()
    if (!core.loggedIn) return super.readAccount(jar, signal)
    await this.syncCookies(jar, core.session.exportCookies())
    const profile = await core.account.me({ refresh: true })
    const user = profile.user
    if (!user.id) return undefined
    return { id: user.id, name: user.nickname || '汽水账号', avatarUrl: user.avatarUrl, vip: user.isVip === true }
  }

  async createLogin(_jar: Session, signal: AbortSignal): Promise<LoginTicket> {
    if (signal.aborted) throw new Error('登录请求已取消')
    const core = await this.core()
    const login = await (await this.core()).login({ fetchProfile: true })
    const token = randomUUID()
    // Capture the baseline after QR creation so cookies set by get_qrcode are
    // not mistaken for credentials delivered after the phone confirmation.
    const initialSession = sessionSignature(core.api.exportCookies())
    this.loginFlows.set(token, { login, scanned: false, initialSession })
    const imageDataUrl = typeof login.qrPng === 'string' && /^data:image\/png;base64,[a-zA-Z0-9+/=\s]+$/.test(login.qrPng)
      && login.qrPng.length <= 2_000_000 ? login.qrPng : undefined
    logEvent({ provider: this.id, stage: 'qishui.qr.create', outcome: 'success',
      platformStatus: imageDataUrl ? 'official-image' : 'local-render' })
    return { token, content: login.scanUrl, expiresAt: login.expiresAt, imageDataUrl }
  }

  async pollLogin(jar: Session, ticketValue: string, signal: AbortSignal): Promise<PollResult> {
    if (signal.aborted) throw new Error('登录请求已取消')
    const login = this.loginFlows.get(ticketValue)
    if (!login) throw new Error('汽水登录会话已失效，请重新扫码')
    const state = await login.login.status()
    if (signal.aborted) throw new Error('登录请求已取消')
    if (state === 'scanned') login.scanned = true
    const core = await this.core()
    const currentSession = sessionSignature(core.api.exportCookies())
    logEvent({ provider: this.id, stage: 'qishui.qr.poll', outcome: state === 'unknown' ? 'error' : 'success',
      platformStatus: state, hasSession: Boolean(currentSession),
      message: state === 'unknown' ? '平台响应未包含可识别的扫码状态；保留当前二维码并继续轮询' : undefined })
    if (state === 'confirmed') await this.syncCookies(jar, core.session.exportCookies())
    if (state === 'waiting' || state === 'scanned' || state === 'confirmed' || state === 'expired') {
      return { state, platformStatus: state }
    }
    if (state === 'timeout') return { state: 'expired', platformStatus: state }
    if (login.scanned && currentSession && currentSession !== login.initialSession) {
      const startedAt = Date.now()
      try {
        // check_qrconnect can set authenticated cookies while omitting data.status.
        // Persist and verify those credentials before reporting success.
        await core.session.save()
        const profile = await core.account.me({ refresh: true })
        if (!profile.user.id) throw new Error('汽水未返回账号资料')
        await this.syncCookies(jar, core.session.exportCookies())
        logEvent({ provider: this.id, stage: 'qishui.qr.cookie-fallback', outcome: 'success',
          durationMs: Date.now() - startedAt, platformStatus: state, hasSession: true })
        return { state: 'confirmed', platformStatus: 'cookie-verified' }
      } catch (error) {
        logEvent({ provider: this.id, stage: 'qishui.qr.cookie-fallback', outcome: 'error',
          durationMs: Date.now() - startedAt, platformStatus: state, hasSession: true,
          message: error instanceof Error ? error.message : '账号资料校验失败' })
      }
    }
    // A response without data.status is inconclusive, not proof that the QR is invalid.
    return { state: 'waiting', platformStatus: 'unknown', pollAfterMs: 3000,
      message: '平台暂未返回明确状态，正在继续检查，请保持二维码打开' }
  }

  async expireLogin(_jar: Session, ticketValue: string) {
    this.loginFlows.delete(ticketValue)
  }

  async logout() {
    this.loginFlows.clear()
    try {
      await (await this.core()).logout()
    } finally {
      await super.logout()
    }
  }
}
