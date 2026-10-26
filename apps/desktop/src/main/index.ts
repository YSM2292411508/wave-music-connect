import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, protocol, session, shell, type IpcMainInvokeEvent } from 'electron'
import type { ProviderId, TrackRef, TrackResult, TrackPage, PlaylistPage } from '../shared/contracts.js'
import { Providers } from './providers.js'
import { QrLogins } from './login.js'
import { MediaStreams } from './media.js'
import { LocalFavorites } from './local-favorites.js'
import { message, object } from './api/transport.js'
import { initializeLogger, logEvent, logsDirectory } from './logger.js'

protocol.registerSchemesAsPrivileged([{ scheme: 'wave-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
let mainWindow: BrowserWindow | null = null
let providers: Providers
let logins: QrLogins
let media: MediaStreams
let localFavorites: LocalFavorites
const rendererPath = join(__dirname, '../renderer/index.html')
function emit(channel: string, data: unknown) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data) }
function publish() {
  emit('providers:status-changed', providers.statuses())
}
function trustedUrl(url: string) {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    try { return new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin } catch { return false }
  }
  return url.split('#')[0] === pathToFileURL(rendererPath).href
}
function authorized(event: IpcMainInvokeEvent) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame
    || !trustedUrl(event.senderFrame.url)) throw new Error('拒绝不受信任的调用')
}
function providerId(value: unknown): ProviderId {
  if (value !== 'netease' && value !== 'qishui') throw new Error('未知音乐平台')
  return value
}
function providerIds(value: unknown): ProviderId[] {
  if (!Array.isArray(value) || !value.length || value.length > 2) throw new Error('请选择音乐平台')
  return [...new Set(value.map(providerId))]
}
function identifier(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error('无效的歌曲或歌单 ID')
  return value
}
function loginAttemptId(value: unknown) {
  const id = identifier(value)
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的登录会话')
  return id
}
function trackRef(value: unknown): TrackRef { const raw = object(value); return { provider: providerId(raw.provider), trackId: identifier(raw.trackId) } }
function optionalText(value: unknown, max: number) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > max) throw new Error('歌曲信息无效')
  return value
}
function coverUrl(value: unknown) {
  const text = optionalText(value, 2048)
  if (!text) return undefined
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
    return url.href
  } catch { throw new Error('歌曲封面地址无效') }
}
function trackSnapshot(value: unknown): TrackResult {
  const raw = object(value)
  const track = trackRef(raw)
  const duration = Number(raw.durationMs)
  const playback = raw.playback === 'restricted' ? 'restricted' : raw.playback === 'check' ? 'check' : undefined
  if (!playback) throw new Error('歌曲播放状态无效')
  return { ...track, title: boundedText(raw.title, 300), artist: boundedText(raw.artist, 500),
    album: optionalText(raw.album, 500) || '', coverUrl: coverUrl(raw.coverUrl),
    durationMs: Number.isFinite(duration) && duration >= 0 && duration <= 7 * 24 * 60 * 60 * 1000 ? duration : undefined,
    localFavorite: true, vipRequired: raw.vipRequired === true, playback,
    restrictionReason: optionalText(raw.restrictionReason, 500) }
}
function cursor(value: unknown, id: ProviderId): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 2048 || id === 'netease' && (!/^\d+$/.test(value) || Number(value) > 10_000_000)) throw new Error('无效的分页游标')
  return value
}
function boundedText(value: unknown, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`请输入 1–${max} 个字符`)
  return value.trim()
}
function handle(channel: string, action: (input: any) => Promise<unknown> | unknown) {
  ipcMain.handle(channel, async (event, input) => {
    authorized(event)
    try { return await action(input) }
    finally { publish() }
  })
}
async function sameAccount<T>(id: ProviderId, action: () => Promise<T>) {
  return providers.all[id].withAccount(action)
}
async function pages(input: any, kind: 'search' | 'playlists') {
  const ids = providerIds(input?.ids)
  const query = kind === 'search' ? boundedText(input.query, 200) : ''
  const cursors = object(input?.cursors)
  return Promise.all(ids.map(async id => {
    const next = cursor(cursors[id], id)
    try {
      return await sameAccount<TrackPage | PlaylistPage>(id, async () => {
        const provider = providers.all[id]
        if (kind === 'search') return provider.search(query, next)
        return provider.playlists(next)
      })
    } catch (error) { return { provider: id, [kind === 'playlists' ? 'playlists' : 'tracks']: [], error: message(error) } }
  }))
}
function registerIpc() {
  handle('app:version', () => app.getVersion())
  handle('login:availability', input => logins.availability(providerId(input)))
  handle('providers:list', () => providers.statuses())
  handle('providers:refresh', async () => {
    const before = new Map(Object.values(providers.all).map(provider => [provider.id, provider.account?.id]))
    const statuses = await providers.refresh()
    for (const provider of Object.values(providers.all)) if (before.get(provider.id) !== provider.account?.id) media.revoke(provider.id)
    return statuses
  })
  handle('providers:logout', async input => {
    const id = providerId(input)
    logins.cancelProvider(id)
    media.revoke(id)
    await providers.all[id].logout()
    providers.clearError(id)
  })
  handle('login:start', async input => {
    const id = providerId(input?.provider)
    const attemptId = loginAttemptId(input?.attemptId)
    if (providers.all[id].account) throw new Error('此平台已登录，请先退出账号再切换')
    return logins.start(providers.all[id], attemptId)
  })
  handle('login:cancel', input => logins.cancel(loginAttemptId(input)))
  handle('diagnostics:open-logs', async () => {
    const error = await shell.openPath(logsDirectory())
    if (error) throw new Error(`无法打开日志目录：${error}`)
  })
  for (const kind of ['search', 'playlists'] as const) handle(`music:${kind}`, input => pages(input, kind))
  handle('music:local-favorites', () => localFavorites.list())
  handle('music:local-favorite', input => {
    if (typeof input?.liked !== 'boolean') throw new Error('无效的本地喜欢状态')
    return localFavorites.set(trackSnapshot(input?.track), input.liked)
  })
  handle('music:playlist-tracks', input => {
    const id = providerId(input?.provider), playlist = identifier(input?.playlistId)
    return sameAccount(id, () => providers.all[id].playlistTracks(playlist, cursor(input?.cursor, id)))
  })
  handle('music:create-playlist', input => {
    const id = providerId(input?.provider), name = boundedText(input?.name, 80)
    if (typeof input?.privatePlaylist !== 'boolean') throw new Error('请选择歌单公开状态')
    return sameAccount(id, () => providers.all[id].createPlaylist(name, input.privatePlaylist))
  })
  handle('music:add-to-playlist', input => {
    const track = trackRef(input?.track), playlist = identifier(input?.playlistId)
    return sameAccount(track.provider, () => providers.all[track.provider].addToPlaylist(track.trackId, playlist))
  })
  handle('music:playback', async input => {
    const track = trackRef(input)
    const source = await sameAccount(track.provider, () => providers.all[track.provider].playback(track.trackId))
    return media.add(track.provider, source)
  })
  handle('music:release-playback', input => {
    if (typeof input !== 'string' || !/^wave-media:\/\/stream\/[a-z0-9-]{36}$/.test(input)) throw new Error('无效的播放授权')
    media.release(input)
  })
}
function createMainWindow() {
  const window = new BrowserWindow({ width: 1440, height: 920, minWidth: 1040, minHeight: 720, show: false,
    title: 'WaveMusic Connect', backgroundColor: '#111416', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, webviewTag: false } })
  mainWindow = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (!trustedUrl(url)) event.preventDefault() })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.on('render-process-gone', () => { logins.close(); media.revoke() })
  window.webContents.on('did-start-loading', () => { logins.close(); media.revoke() })
  window.webContents.on('did-finish-load', () => publish())
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => { logins.close(); media.revoke(); mainWindow = null })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(rendererPath)
}
app.whenReady().then(async () => {
  app.setAppUserModelId('com.wavemusic.connect')
  await initializeLogger()
  logEvent({ provider: 'app', stage: 'lifecycle.start', outcome: 'success', message: `version ${app.getVersion()}` })
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  providers = new Providers()
  localFavorites = new LocalFavorites(trackSnapshot)
  media = new MediaStreams()
  media.register()
  logins = new QrLogins(view => emit('login:changed', view), () => {
    providers.clearError('netease'); providers.clearError('qishui'); publish()
  }, state => emit('login:availability-changed', state))
  registerIpc()
  createMainWindow()
  void providers.refresh().then(publish)
  app.on('activate', () => { if (!mainWindow) createMainWindow() })
})
app.on('before-quit', () => {
  logEvent({ provider: 'app', stage: 'lifecycle.stop', outcome: 'success' })
  logins?.close(); media?.revoke()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
