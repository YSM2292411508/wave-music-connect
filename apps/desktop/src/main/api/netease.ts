import { constants, createCipheriv, createHash, publicEncrypt, randomBytes } from 'node:crypto'
import type { Session } from 'electron'
import type { Playlist, PlaylistPage, TrackPage, TrackResult } from '../../shared/contracts.js'
import { MusicProvider, type LoginTicket, type PollResult } from './provider.js'
import { array, cookie, imageUrl, object, requestJson, RequestFailure, retryAfterMs, text, type JsonObject } from './transport.js'
import { logEvent } from '../logger.js'

const publicKey = '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----'
function encrypt(data: JsonObject): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const key = Array.from(randomBytes(16), value => alphabet[value % alphabet.length]).join('')
  const aes = (input: string, secret: string) => {
    const cipher = createCipheriv('aes-128-cbc', secret, '0102030405060708')
    return Buffer.concat([cipher.update(input, 'utf8'), cipher.final()]).toString('base64')
  }
  const raw = Buffer.alloc(128)
  Buffer.from(key.split('').reverse().join('')).copy(raw, 112)
  return new URLSearchParams({ params: aes(aes(JSON.stringify(data), '0CoJUm6Qyw8W8jud'), key),
    encSecKey: publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, raw).toString('hex') }).toString()
}
const pcDeviceId = randomBytes(16).toString('hex')
function eapi(path: string, data: JsonObject): string {
  const plain = JSON.stringify(data)
  const digest = createHash('md5').update(`nobody${path}use${plain}md5forencrypt`).digest('hex')
  const payload = `${path}-36cd479b6b5-${plain}-36cd479b6b5-${digest}`
  const cipher = createCipheriv('aes-128-ecb', 'e82ckenh8dichen8', null)
  return new URLSearchParams({ params: Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]).toString('hex').toUpperCase() }).toString()
}
export class NeteaseProvider extends MusicProvider {
  readonly id = 'netease' as const
  readonly name = '网易云音乐'
  readonly shortName = '网易云'
  readonly color = '#e5484d'
  readonly origin = 'https://music.163.com'
  private async pcLoginApi(path: string, data: JsonObject, jar: Session, signal: AbortSignal, accepted: number[]) {
    const startedAt = Date.now()
    const stage = path === '/login/qrcode/unikey' ? 'eapi.qr.create' : 'eapi.qr.poll'
    let logged = false
    const revision = this.revision
    signal = this.requestSignal(signal)
    const csrf = await cookie(jar, '__csrf', this.origin)
    const musicU = await cookie(jar, 'MUSIC_U', this.origin)
    const musicA = await cookie(jar, 'MUSIC_A', this.origin)
    const header: JsonObject = { os: 'pc', appver: '3.1.17.204416', osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
      channel: 'netease', deviceId: pcDeviceId, buildver: String(Math.floor(Date.now() / 1000)), resolution: '1920x1080',
      requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`, __csrf: csrf }
    if (musicU) header.MUSIC_U = musicU
    if (musicA) header.MUSIC_A = musicA
    const apiPath = `/api${path}`
    try {
      const result = await requestJson(jar, `https://interfacepc.music.163.com/eapi${path}`, {
        method: 'POST', signal, body: eapi(apiPath, { ...data, header }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8', Referer: `${this.origin}/`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.17.204416' },
      })
      this.checkRevision(revision)
      const platformCode = String(result.data.code || '')
      if (!accepted.includes(Number(result.data.code))) {
        const reason = text(result.data.message || result.data.msg, `接口状态 ${platformCode || '未知'}`)
        logEvent({ provider: this.id, stage, outcome: 'error', durationMs: Date.now() - startedAt,
          httpStatus: result.statusCode, platformCode, retryAfterMs: retryAfterMs(result.headers), message: reason })
        logged = true
        throw new RequestFailure(`网易云登录：${reason}`, { statusCode: platformCode, httpStatus: result.statusCode,
          retryAfterMs: retryAfterMs(result.headers), rateLimited: Number(result.data.code) === 429 })
      }
      logEvent({ provider: this.id, stage, outcome: 'success', durationMs: Date.now() - startedAt,
        httpStatus: result.statusCode, platformCode, hasSession: Boolean(await cookie(jar, 'MUSIC_U', this.origin)) })
      logged = true
      return result.data
    } catch (error) {
      if (!logged) logEvent({ provider: this.id, stage, outcome: 'error', durationMs: Date.now() - startedAt,
        httpStatus: error instanceof RequestFailure ? error.httpStatus : undefined,
        platformCode: error instanceof RequestFailure ? error.statusCode : undefined,
        retryAfterMs: error instanceof RequestFailure ? error.retryAfterMs : undefined,
        message: error instanceof Error ? error.message : '请求失败' })
      throw error
    }
  }

  private async api(path: string, data: JsonObject, jar = this.jar, signal?: AbortSignal, accepted = [200]) {
    const revision = this.revision
    signal = this.requestSignal(signal)
    this.checkRevision(revision)
    const csrf = await cookie(jar, '__csrf', this.origin)
    this.checkRevision(revision)
    const result = await requestJson(jar, `${this.origin}/weapi${path}?csrf_token=${encodeURIComponent(csrf)}`, {
      method: 'POST', signal, body: encrypt({ ...data, csrf_token: csrf }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${this.origin}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' },
    })
    this.checkRevision(revision)
    if (!accepted.includes(Number(result.data.code))) {
      if (Number(result.data.code) === 301 && jar === this.jar) { this.revision++; this.account = undefined }
      throw new RequestFailure(`网易云：${text(result.data.message || result.data.msg, `接口返回 ${text(result.data.code, '未知状态')}`)}`, {
        statusCode: String(result.data.code || ''), httpStatus: result.statusCode,
        retryAfterMs: retryAfterMs(result.headers), rateLimited: Number(result.data.code) === 429,
      })
    }
    return result.data
  }
  protected async readAccount(jar: Session, signal?: AbortSignal) {
    if (!await cookie(jar, 'MUSIC_U', this.origin)) return undefined
    const data = await this.api('/w/nuser/account/get', {}, jar, signal)
    const profile = object(data.profile)
    return profile.userId ? { id: text(profile.userId), name: text(profile.nickname, '网易云账号'), avatarUrl: imageUrl(profile.avatarUrl) } : undefined
  }
  async logout() { await super.logout() }
  async createLogin(jar: Session, signal: AbortSignal): Promise<LoginTicket> {
    const result = await this.pcLoginApi('/login/qrcode/unikey', { type: 3 }, jar, signal, [200])
    const token = text(result.unikey)
    if (!token) throw new Error('网易云未返回二维码，请刷新重试')
    return { token, content: `https://music.163.com/login?codekey=${encodeURIComponent(token)}`, expiresAt: Date.now() + 120_000 }
  }
  async pollLogin(jar: Session, token: string, signal: AbortSignal): Promise<PollResult> {
    const data = await this.pcLoginApi('/login/qrcode/client/login', { key: token, type: 3 }, jar, signal, [800, 801, 802, 803])
    const code = Number(data.code)
    return { state: ({ 800: 'expired', 801: 'waiting', 802: 'scanned', 803: 'confirmed' } as const)[code as 800], platformStatus: String(code) }
  }
  private track(raw: JsonObject, privilege: JsonObject = object(raw.privilege)): TrackResult {
    const id = text(raw.id)
    const restricted = Number(privilege.st) < 0 || privilege.pl === 0 && privilege.fee === 0
    return { provider: this.id, trackId: id, title: text(raw.name, '未命名歌曲'),
      artist: array(raw.ar || raw.artists).map(item => text(item.name)).join(' / ') || '未知歌手',
      album: text(object(raw.al || raw.album).name), coverUrl: imageUrl(object(raw.al || raw.album).picUrl),
      durationMs: Number(raw.dt || raw.duration) || undefined,
      vipRequired: Number(raw.fee || privilege.fee) === 1, playback: restricted ? 'restricted' : 'check',
      restrictionReason: restricted ? '当前账号或所在地区无播放权限' : undefined }
  }
  async search(query: string, cursor = '0'): Promise<TrackPage> {
    const data = await this.api('/cloudsearch/pc', { s: query, type: 1, limit: 30, offset: Number(cursor), total: true })
    const result = object(data.result)
    const songs = array(result.songs)
    const offset = Number(cursor) + songs.length
    return { provider: this.id, tracks: songs.map(song => this.track(song)), cursor: offset < Number(result.songCount) && songs.length ? String(offset) : undefined }
  }
  private playlist(raw: JsonObject): Playlist {
    return { provider: this.id, id: text(raw.id), name: text(raw.name, '未命名歌单'), coverUrl: imageUrl(raw.coverImgUrl),
      trackCount: Number(raw.trackCount) || 0, writable: text(object(raw.creator).userId || raw.userId) === this.account?.id }
  }
  async playlists(cursor = '0'): Promise<PlaylistPage> {
    this.requireAccount()
    if (!this.account?.id) await this.refresh()
    if (!this.account?.id) throw new Error('请刷新网易云账号资料')
    const data = await this.api('/user/playlist', { uid: this.account.id, offset: Number(cursor), limit: 50, includeVideo: false })
    const playlists = array(data.playlist).map(item => this.playlist(item))
    return { provider: this.id, playlists, cursor: data.more && playlists.length ? String(Number(cursor) + playlists.length) : undefined }
  }
  async playlistTracks(playlistId: string, cursor = '0'): Promise<TrackPage> {
    this.requireAccount()
    const detail = await this.api('/v6/playlist/detail', { id: playlistId, n: 100000, s: 0 })
    const ids = array(object(detail.playlist).trackIds)
    const offset = Number(cursor)
    const slice = ids.slice(offset, offset + 50)
    if (!slice.length) return { provider: this.id, tracks: [] }
    const data = await this.api('/v3/song/detail', { c: JSON.stringify(slice.map(item => ({ id: item.id }))) })
    const privileges = new Map(array(data.privileges).map(item => [text(item.id), item]))
    return { provider: this.id, tracks: array(data.songs).map(item => this.track(item, privileges.get(text(item.id)))),
      cursor: offset + slice.length < ids.length ? String(offset + slice.length) : undefined }
  }
  async createPlaylist(name: string, privatePlaylist: boolean): Promise<Playlist> {
    this.requireAccount()
    const data = await this.api('/playlist/create', { name, privacy: privatePlaylist ? '10' : '0', type: 'NORMAL' })
    const result = this.playlist(object(data.playlist))
    if (!result.id) throw new Error('平台未返回新歌单 ID，请刷新歌单确认')
    return { ...result, writable: true }
  }
  async addToPlaylist(trackId: string, playlistId: string) {
    this.requireAccount()
    await this.api('/playlist/manipulate/tracks', { op: 'add', pid: playlistId, trackIds: JSON.stringify([trackId]), imme: true })
  }
  async playback(trackId: string) {
    this.requireAccount()
    const data = await this.api('/song/enhance/player/url', { ids: JSON.stringify([trackId]), br: 320000 })
    const item = array(data.data).find(value => text(value.id) === trackId)
    if (!item || item.code !== 200 || !item.url) throw new Error('网易云未授权播放此歌曲，可能需要 VIP、购买或版权授权')
    if (item.freeTrialInfo) throw new Error('当前账号仅有试听权限，可收藏，暂不播放')
    return { url: text(item.url), expiresAt: Date.now() + Math.min(Number(item.expi) || 300, 1200) * 1000 }
  }
}
