import { session, type Session } from 'electron'
import type { Playlist, PlaylistPage, TrackPage, TrackResult } from '../../shared/contracts.js'
import { MusicProvider, type Account, type AuthorizedMedia, type LoginTicket, type PollResult } from './provider.js'
import { array, cookie, imageUrl, object, requestJson, RequestFailure, retryAfterMs, text, type JsonObject } from './transport.js'
import { qqMusicService } from './qqmusic-service.js'
import { lrcLyrics, readableLrc } from './lyrics.js'

const SESSION_COOKIE = 'qqmusic_session'
const PAGE_SIZE = 20

function opaque(value: JsonObject): string {
  return `q_${Buffer.from(JSON.stringify(value)).toString('base64url')}`
}

function decode(value: string): JsonObject {
  if (!value.startsWith('q_')) return { mid: value }
  try { return object(JSON.parse(Buffer.from(value.slice(2), 'base64url').toString('utf8')) as unknown) }
  catch { throw new Error('QQ音乐歌曲或歌单 ID 已损坏，请重新加载') }
}

function positive(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function qqImage(mid: unknown): string | undefined {
  const value = text(mid)
  return value ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${encodeURIComponent(value)}.jpg` : undefined
}

export class QqMusicProvider extends MusicProvider {
  readonly id = 'qqmusic' as const
  readonly name = 'QQ音乐'
  readonly shortName = 'QQ音乐'
  readonly color = '#31c27c'
  readonly origin = 'https://y.qq.com'
  get jar(): Session { return session.fromPartition('persist:wave-api-qqmusic-v1') }

  status() {
    const status = super.status()
    return { ...status, apiMessage: status.connected
      ? 'QQ音乐账号已连接；播放能力以账号会员、版权与地区权限为准'
      : '访客模式可搜索公开曲库；使用 QQ 音乐 App 扫码连接歌单和账号播放权限' }
  }

  private async endpoint(path: string) {
    const service = await qqMusicService()
    return `${service.origin}${path}`
  }

  private async api(path: string, jar = this.jar, signal?: AbortSignal, options: { method?: 'GET' | 'POST'; body?: JsonObject } = {}) {
    const url = await this.endpoint(path)
    const result = await requestJson(jar, url, {
      method: options.method,
      signal: this.requestSignal(signal),
      body: options.body ? JSON.stringify(options.body) : undefined,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    })
    const code = Number(result.data.code)
    if (Number.isFinite(code) && code !== 0 && code !== 200 && ![800, 801, 802, 803].includes(code)) {
      const reason = text(result.data.message || result.data.failureHint, `接口返回 ${code}`)
      throw new RequestFailure(`QQ音乐：${reason}`, { statusCode: String(code), httpStatus: result.statusCode,
        retryAfterMs: Number(result.data.retryAfterMs) || retryAfterMs(result.headers), rateLimited: code === 429 })
    }
    return result.data
  }

  protected async readAccount(jar: Session, signal?: AbortSignal): Promise<Account | undefined> {
    const service = await qqMusicService()
    if (!await cookie(jar, SESSION_COOKIE, service.origin)) return undefined
    let data: JsonObject
    try { data = await this.api('/login/status', jar, signal) }
    catch (error) {
      if (error instanceof RequestFailure && error.httpStatus === 401) return undefined
      throw error
    }
    const profile = object(object(data.data).profile)
    const info = object(profile.info)
    const id = text(profile.musicid || profile.str_musicid || profile.uin)
    if (!id) return undefined
    return { id, name: text(info.nick || profile.nick || profile.nickname, 'QQ音乐账号'),
      avatarUrl: imageUrl(info.avatar || info.pic || profile.avatar || profile.avatarUrl) }
  }

  async acceptLogin(jar: Session, signal: AbortSignal, expectedRevision: number) {
    const service = await qqMusicService()
    const account = await this.readAccount(jar, signal)
    const source = (await jar.cookies.get({ url: service.origin, name: SESSION_COOKIE }))[0]
    if (!account?.id || !source?.value) throw new Error('QQ音乐已确认扫码，但账号会话尚未就绪，请重新登录')
    if (signal.aborted || expectedRevision !== this.revision) throw new Error('登录已取消')
    const revision = ++this.revision
    const target = this.jar
    await target.clearStorageData()
    try {
      await target.cookies.set({ url: service.origin, name: SESSION_COOKIE, value: source.value, path: '/',
        httpOnly: true, sameSite: 'lax', ...(source.expirationDate ? { expirationDate: source.expirationDate } : {}) })
      await target.cookies.flushStore()
      if (signal.aborted || revision !== this.revision) throw new Error('登录已取消')
      this.account = account
    } catch (error) {
      this.account = undefined
      await target.clearStorageData()
      throw error
    }
  }

  async logout() {
    try {
      const service = await qqMusicService()
      if (await cookie(this.jar, SESSION_COOKIE, service.origin)) await this.api('/logout')
    } finally { await super.logout() }
  }

  async createLogin(jar: Session, signal: AbortSignal): Promise<LoginTicket> {
    const created = await this.api('/login/qr/key?channel=qqmusic', jar, signal)
    const token = text(object(created.data).unikey)
    if (!token) throw new Error('QQ音乐未返回二维码标识，请刷新重试')
    const image = await this.api(`/login/qr/create?key=${encodeURIComponent(token)}`, jar, signal)
    const imageDataUrl = text(object(image.data).qrimg)
    if (!imageDataUrl.startsWith('data:image/')) throw new Error('QQ音乐未返回可识别的二维码图片')
    return { token, content: '', imageDataUrl, expiresAt: Date.now() + 175_000 }
  }

  async pollLogin(jar: Session, token: string, signal: AbortSignal): Promise<PollResult> {
    const data = await this.api(`/login/qr/check?key=${encodeURIComponent(token)}`, jar, signal)
    const code = Number(data.code)
    if (code === 803) return { state: 'confirmed', platformStatus: '803' }
    if (code === 802) return { state: 'scanned', platformStatus: '802', message: '已扫码，请在 QQ 音乐 App 中确认登录' }
    if (code === 801) return { state: 'waiting', platformStatus: '801', pollAfterMs: 2000 }
    if (code === 800) return { state: 'expired', platformStatus: '800', message: text(data.failureHint || data.message, '二维码已过期或登录失败') }
    throw new RequestFailure(`QQ音乐返回未知扫码状态 ${text(data.code, '未知')}`, { statusCode: text(data.code) })
  }

  async expireLogin(jar: Session, token: string, remote = true) {
    if (remote) await this.api(`/login/qr/cancel?key=${encodeURIComponent(token)}`, jar).catch(() => {})
  }

  private track(raw: JsonObject): TrackResult {
    const mid = text(raw.mid || raw.songmid)
    const id = positive(raw.id || raw.songid)
    const album = object(raw.album)
    const file = object(raw.file)
    const pay = object(raw.pay)
    const title = text(raw.title || raw.name || raw.songname, '未命名歌曲')
    const artist = array(raw.singer || raw.singers).map(item => text(item.name)).filter(Boolean).join(' / ') || text(raw.singername, '未知歌手')
    const albumMid = text(album.mid || raw.albummid || raw.album_mid)
    const hasKnownFile = [file.size_128mp3, file.size_320mp3, file.size_flac, file.size_hires].some(value => Number(value) > 0)
    const vipRequired = Number(pay.pay_play || pay.paydownload || raw.pay_play) > 0
    return { provider: this.id, trackId: opaque({ mid, ...(id ? { id } : {}) }), title, artist,
      album: text(album.name || raw.albumname || raw.album_name), coverUrl: imageUrl(raw.coverUrl || raw.picUrl) || qqImage(albumMid),
      durationMs: Number(raw.interval || raw.duration) > 0 ? Number(raw.interval || raw.duration) * 1000 : undefined,
      vipRequired, playback: mid && (hasKnownFile || !raw.file) ? 'check' : 'restricted',
      restrictionReason: mid && (hasKnownFile || !raw.file) ? undefined : '平台未提供可播放的歌曲标识或音频文件' }
  }

  async search(query: string, cursor?: string): Promise<TrackPage> {
    const page = Math.max(1, Number(cursor) || 1)
    const data = await this.api(`/search?keyword=${encodeURIComponent(query)}&type=song&page=${page}&limit=${PAGE_SIZE}`)
    const tracks = array(data.items).map(item => this.track(item)).filter(track => track.trackId)
    return { provider: this.id, tracks, cursor: data.more === true ? String(page + 1) : undefined }
  }

  private playlist(raw: JsonObject): Playlist | undefined {
    const tid = positive(raw.tid || raw.disstid || raw.id)
    if (!tid) return undefined
    const dirId = positive(raw.dirId || raw.dirid)
    const writable = Boolean(dirId && dirId < 200 && (raw.dirType === undefined || Number(raw.dirType) === 0))
    return { provider: this.id, id: opaque({ tid, ...(dirId ? { dirId } : {}) }),
      name: text(raw.dirName || raw.dissname || raw.name || raw.title, '未命名歌单'),
      coverUrl: imageUrl(raw.logo || raw.picUrl || raw.cover || raw.coverUrl),
      trackCount: Math.max(0, Number(raw.songnum || raw.songCount || raw.total_song_num) || 0), writable }
  }

  async playlists(cursor?: string): Promise<PlaylistPage> {
    this.requireAccount()
    const suffix = cursor ? `&favoriteOffset=${encodeURIComponent(cursor)}` : ''
    const data = await this.api(`/user/playlist?playCount=1${suffix}`)
    const playlists = array(data.playlist).map(item => this.playlist(item)).filter((item): item is Playlist => Boolean(item))
    const next = positive(data.nextFavoriteOffset)
    return { provider: this.id, playlists, cursor: data.more === true && next ? String(next) : undefined }
  }

  async playlistTracks(playlistId: string, cursor?: string): Promise<TrackPage> {
    this.requireAccount()
    const value = decode(playlistId)
    const tid = positive(value.tid)
    if (!tid) throw new Error('QQ音乐歌单 ID 无效，请重新加载')
    const offset = Math.max(0, Number(cursor) || 0)
    if (positive(value.dirId)) {
      const data = await this.api(`/user/playlist-detail?tid=${tid}&offset=${offset}&limit=100`)
      const tracks = array(data.songs).map(item => this.track(item))
      return { provider: this.id, tracks, cursor: data.more === true ? String(offset + tracks.length) : undefined }
    }
    const data = await this.api(`/getSongListDetail/${tid}`)
    const detail = array(object(data.data).cdlist)[0] || array(data.cdlist)[0] || object(data.data)
    return { provider: this.id, tracks: array(detail.songlist).map(item => this.track(item)) }
  }

  async createPlaylist(name: string, privatePlaylist: boolean): Promise<Playlist> {
    this.requireAccount()
    if (privatePlaylist) throw new Error('QQ音乐当前只支持从本软件创建普通歌单，请取消私密选项')
    const data = await this.api('/user/playlist/create', this.jar, undefined, { method: 'POST', body: { name } })
    const tid = positive(data.tid), dirId = positive(data.dirId)
    if (!tid || !dirId) throw new Error('QQ音乐已处理创建请求，但未返回可确认的歌单')
    return { provider: this.id, id: opaque({ tid, dirId }), name: text(data.name, name), trackCount: 0, writable: true }
  }

  async addToPlaylist(trackId: string, playlistId: string) {
    this.requireAccount()
    const track = decode(trackId), playlist = decode(playlistId)
    const id = positive(track.id), tid = positive(playlist.tid)
    if (!id || !tid) throw new Error('QQ音乐缺少添加歌曲所需的数值 ID，请重新搜索歌曲和歌单')
    const data = await this.api('/user/playlist/tracks', this.jar, undefined, {
      method: 'POST', body: { tid, op: 'add', songs: [{ id, type: 0 }] },
    })
    if (data.changed !== true) throw new Error('QQ音乐未确认歌曲已加入歌单，请刷新歌单核对')
  }

  async lyrics(trackId: string) {
    const mid = text(decode(trackId).mid)
    if (!mid) throw new Error('QQ音乐歌曲缺少歌词标识，请重新搜索')
    // The bundled route exposes optional path params, but its handler reads
    // songmid and isFormat from the query string in the Node runtime.
    const data = await this.api(`/getLyric?songmid=${encodeURIComponent(mid)}&isFormat=false&trans=1`)
    const response = object(data.response)
    return lrcLyrics(this.id, trackId, response.lyric, readableLrc(response.trans))
  }

  async playback(trackId: string): Promise<AuthorizedMedia> {
    const mid = text(decode(trackId).mid)
    if (!mid) throw new Error('QQ音乐歌曲缺少播放标识，请重新搜索')
    const data = await this.api(`/getMusicPlay/${encodeURIComponent(mid)}?quality=best`)
    const entry = object(object(object(data.data).playUrl)[mid])
    const raw = text(entry.url)
    if (!raw) {
      const restriction = object(entry.restriction)
      const hint = text(object(restriction.hint).message || restriction.message)
      throw new Error(text(hint || entry.error, this.account ? '当前账号没有这首歌曲的播放权限' : 'QQ音乐未提供公开播放地址；登录后可按账号权限重试'))
    }
    const url = new URL(raw)
    if (url.protocol === 'http:') url.protocol = 'https:'
    return { url: url.href, expiresAt: Date.now() + 10 * 60_000 }
  }
}
