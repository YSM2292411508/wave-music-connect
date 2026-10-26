<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Search, Heart, Library, UserRound, QrCode, RefreshCw, Plus, Play, Pause, SkipBack, SkipForward,
  Volume2, ListMusic, X, LogOut, ShieldCheck, Music2, ChevronLeft, LoaderCircle, AlertCircle,
  ScanLine, FileText } from 'lucide-vue-next'
import appIcon from '../../../build/icon.png'
import type { DesktopBridge, LoginAvailability, ProviderId, ProviderStatus, QrLoginSession, TrackResult, TrackPage, Playlist, PlaylistPage, ViewName } from './types'

const bridge = window.waveDesktop
const appVersion = ref('')
const statuses = ref<ProviderStatus[]>([
  { id: 'netease', name: '网易云音乐', shortName: '网易云', color: '#e5484d', connected: false, sessionRevision: 0, apiReady: true },
  { id: 'qishui', name: '汽水音乐', shortName: '汽水', color: '#20c997', connected: false, sessionRevision: 0, apiReady: true },
])
const activeView = ref<ViewName>('search')
const selected = ref<ProviderId[]>(['netease', 'qishui'])
const query = ref('')
const submitted = ref('')
const trackPages = ref<TrackPage[]>([])
const playlistPages = ref<PlaylistPage[]>([])
const localFavoriteTracks = ref<TrackResult[]>([])
const selectedPlaylist = ref<Playlist | null>(null)
const busy = ref(false)
const refreshing = ref(false)
let requestVersion = 0
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
const pending = ref(new Set<string>())
const brokenImages = ref(new Set<string>())
const lastActionError = ref('')
const titles: Record<ViewName, string> = { search: '发现你的下一首喜欢', localFavorites: '本地喜欢', playlists: '我的歌单', accounts: '账号与访客模式' }
const subtitles: Record<ViewName, string> = { search: '同时搜索网易云与汽水，留住每一次心动。',
  localFavorites: '只保存在这台电脑，可混合保存网易云与汽水歌曲。', playlists: '查看、创建并管理各平台歌单。歌曲只能添加到同一平台。',
  accounts: '网易云与汽水均使用对应 App 扫码登录；访客搜索和本地喜欢无需账号。' }
const provider = (id: ProviderId) => statuses.value.find(item => item.id === id)!
const keyOf = (track: TrackResult) => `${track.provider}:${track.trackId}`
const refOf = (track: TrackResult) => ({ provider: track.provider, trackId: track.trackId })
// contextBridge copies arguments before preload runs, so build plain data here.
function trackSnapshot(track: TrackResult): TrackResult {
  return { provider: track.provider, trackId: track.trackId, title: track.title, artist: track.artist, album: track.album,
    coverUrl: track.coverUrl, durationMs: track.durationMs, localFavorite: Boolean(track.localFavorite),
    vipRequired: track.vipRequired, playback: track.playback, restrictionReason: track.restrictionReason }
}
const localFavoriteKeys = computed(() => new Set(localFavoriteTracks.value.map(keyOf)))
function withLocalFavorite(track: TrackResult): TrackResult {
  return { ...track, localFavorite: localFavoriteKeys.value.has(keyOf(track)) }
}
function syncLocalFavoriteState() {
  const keys = localFavoriteKeys.value
  for (const page of trackPages.value) for (const track of page.tracks) track.localFavorite = keys.has(keyOf(track))
  for (const track of queue.value) track.localFavorite = keys.has(keyOf(track))
  if (currentTrack.value) currentTrack.value.localFavorite = keys.has(keyOf(currentTrack.value))
}
function setLocalFavoriteTracks(value: TrackResult[]) {
  localFavoriteTracks.value = value.map(track => ({ ...track, localFavorite: true }))
  syncLocalFavoriteState()
}
const tracks = computed(() => {
  const groups = selected.value.map(id => trackPages.value.find(page => page.provider === id)?.tracks || [])
  const result: TrackResult[] = []
  for (let i = 0; i < Math.max(0, ...groups.map(group => group.length)); i++) for (const group of groups) if (group[i]) result.push(group[i]!)
  return result
})
const playlists = computed(() => playlistPages.value.flatMap(page => page.playlists))
const errors = computed(() => (activeView.value === 'playlists' && !selectedPlaylist.value ? playlistPages.value : trackPages.value).filter(page => page.error))
const canLoadMore = computed(() => (activeView.value === 'playlists' && !selectedPlaylist.value ? playlistPages.value : trackPages.value).some(page => page.cursor))
const connectedCount = computed(() => statuses.value.filter(item => item.connected).length)
function api(): DesktopBridge { if (!bridge) throw new Error('请在桌面版 EXE 中使用，浏览器预览没有本机接口'); return bridge }
function reason(error: unknown) { return (error instanceof Error ? error.message : '操作失败，请重试').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').slice(0, 500) }
function notify(text: string) { toast.value = text; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.value = '' }, 6000) }
function duration(milliseconds?: number) { const seconds = Math.floor((milliseconds || 0) / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
function imageAvailable(url?: string) { return Boolean(url && !brokenImages.value.has(url)) }
function markImageBroken(url?: string) {
  if (!url || brokenImages.value.has(url)) return
  brokenImages.value = new Set(brokenImages.value).add(url)
}
function mergeTracks(previous: TrackPage[], incoming: TrackPage[], append: boolean) {
  for (const page of incoming) {
    const index = previous.findIndex(item => item.provider === page.provider)
    const old = previous[index]
    const seen = new Map<string, TrackResult>()
    for (const track of [...(append && old ? old.tracks : []), ...page.tracks]) seen.set(keyOf(track), withLocalFavorite(track))
    const merged = { ...page, tracks: [...seen.values()], cursor: page.error && append ? old?.cursor : page.cursor }
    if (index >= 0) previous[index] = merged
    else previous.push(merged)
  }
  return [...previous]
}
function mergePlaylists(previous: PlaylistPage[], incoming: PlaylistPage[], append: boolean) {
  for (const page of incoming) {
    const index = previous.findIndex(item => item.provider === page.provider)
    const old = previous[index]
    const seen = new Map<string, Playlist>()
    for (const playlist of [...(append && old ? old.playlists : []), ...page.playlists]) seen.set(playlist.id, playlist)
    const merged = { ...page, playlists: [...seen.values()], cursor: page.error && append ? old?.cursor : page.cursor }
    if (index >= 0) previous[index] = merged
    else previous.push(merged)
  }
  return [...previous]
}
async function load(more = false, only?: ProviderId) {
  if (!bridge || activeView.value === 'accounts') return
  const version = ++requestVersion
  const view = activeView.value
  const detail = selectedPlaylist.value
  const currentPages = view === 'playlists' && !detail ? playlistPages.value : trackPages.value
  const ids = only ? [only] : more ? selected.value.filter(id => currentPages.some(page => page.provider === id && page.cursor)) : [...selected.value]
  if (!ids.length) { busy.value = false; if (!more) { trackPages.value = []; playlistPages.value = [] }; return }
  if (view === 'search' && !submitted.value) { busy.value = false; return }
  busy.value = true
  lastActionError.value = ''
  const cursors: Partial<Record<ProviderId, string>> = {}
  if (more || only) for (const page of currentPages) if (page.cursor) cursors[page.provider] = page.cursor
  if (!more && !only) { trackPages.value = []; playlistPages.value = [] }
  try {
    if (detail) {
      const page = await api().music.playlistTracks(detail.provider, detail.id, more || only ? cursors[detail.provider] : undefined)
      if (version === requestVersion) trackPages.value = mergeTracks(trackPages.value, [page], more || Boolean(only))
    } else if (view === 'playlists') {
      const pages = await api().music.playlists(ids, cursors)
      if (version === requestVersion) playlistPages.value = mergePlaylists(playlistPages.value, pages, more || Boolean(only))
    } else if (view === 'localFavorites') {
      const local = await api().music.localFavorites()
      if (version === requestVersion) {
        setLocalFavoriteTracks(local)
        trackPages.value = ids.map(id => ({ provider: id, tracks: localFavoriteTracks.value.filter(track => track.provider === id) }))
      }
    } else {
      const pages = await api().music.search(ids, submitted.value, cursors)
      if (version === requestVersion) trackPages.value = mergeTracks(trackPages.value, pages, more || Boolean(only))
    }
  } catch (error) { if (version === requestVersion) { lastActionError.value = reason(error); notify(reason(error)) } }
  finally { if (version === requestVersion) busy.value = false }
}
function navigate(view: ViewName) {
  requestVersion++
  activeView.value = view
  selectedPlaylist.value = null
  trackPages.value = []; playlistPages.value = []; lastActionError.value = ''; busy.value = false
  void load()
}
function search() { if (!query.value.trim()) return; submitted.value = query.value.trim(); activeView.value = 'search'; selectedPlaylist.value = null; void load() }
function toggleProvider(id: ProviderId) { selected.value = selected.value.includes(id) ? selected.value.filter(value => value !== id) : [...selected.value, id] }
watch(selected, () => { selectedPlaylist.value = null; void load() })
async function openPlaylist(playlist: Playlist) {
  selectedPlaylist.value = playlist
  trackPages.value = []
  await load()
}
async function refreshAccounts() {
  if (refreshing.value) return
  refreshing.value = true
  try { statuses.value = await api().providers.refresh() } catch (error) { notify(reason(error)) }
  finally { refreshing.value = false }
}
async function logout(id: ProviderId) {
  if (!confirm(`退出${provider(id).name}账号？只清除本软件的登录状态，不影响官方客户端。`)) return
  try { await api().providers.logout(id); statuses.value = await api().providers.list(); notify('已清除本软件的登录状态') } catch (error) { notify(reason(error)) }
}
async function openLogs() {
  try { await api().diagnostics.openLogs() } catch (error) { notify(reason(error)) }
}

// Login inputs and transient state are memory-only; no phone, code, QR, or cookie fields are persisted by the renderer.
const loginProvider = ref<ProviderId | null>(null)
const loginInfo = ref<QrLoginSession | null>(null)
const loginStarting = ref(false)
const loginError = ref('')
const loginAvailability = ref<Partial<Record<ProviderId, LoginAvailability>>>({})
const loginAvailabilityLoading = ref(false)
const clock = ref(Date.now())
let loginVersion = 0
let loginAttemptId = ''
const qrSeconds = computed(() => Math.max(0, Math.ceil(((loginInfo.value?.expiresAt || 0) - clock.value) / 1000)))
const nextCheckSeconds = computed(() => Math.max(0, Math.ceil(((loginInfo.value?.nextCheckAt || 0) - clock.value) / 1000)))
const activeLoginAvailability = computed(() => loginProvider.value ? loginAvailability.value[loginProvider.value] : undefined)
const loginCooldownSeconds = computed(() => Math.max(0, Math.ceil(((activeLoginAvailability.value?.retryAt || 0) - clock.value) / 1000)))
const loginRequestBusy = computed(() => loginAvailabilityLoading.value || activeLoginAvailability.value?.busy === true)
const loginInProgress = computed(() => loginStarting.value || loginInfo.value?.state === 'validating')
function updateLoginAvailability(state: LoginAvailability) {
  const previous = loginAvailability.value[state.provider]
  if (!previous || state.sequence >= previous.sequence) loginAvailability.value[state.provider] = state
}
async function syncLoginAvailability(id: ProviderId) {
  try { updateLoginAvailability(await api().login.availability(id)) }
  catch (error) { if (loginProvider.value === id) loginError.value = reason(error) }
}
async function openLogin(id: ProviderId) {
  if (provider(id).connected) { navigate('accounts'); return }
  closeLogin()
  loginProvider.value = id
  const version = loginVersion
  loginAvailabilityLoading.value = true
  await syncLoginAvailability(id)
  if (version === loginVersion) loginAvailabilityLoading.value = false
  if (version === loginVersion && !loginRequestBusy.value && !loginCooldownSeconds.value) void refreshQr()
}
async function refreshQr() {
  const id = loginProvider.value
  if (!id || loginInProgress.value || loginRequestBusy.value || loginCooldownSeconds.value > 0) return
  const version = ++loginVersion
  const attemptId = crypto.randomUUID()
  loginAttemptId = attemptId
  loginInfo.value = null; loginError.value = ''; loginStarting.value = true
  try {
    const result = await api().login.start(id, attemptId)
    if (version !== loginVersion) { void bridge?.login.cancel(result.id).catch(() => {}); return }
    const current = loginInfo.value as QrLoginSession | null
    if (!current || result.sequence >= current.sequence) loginInfo.value = result
  } catch (error) { if (version === loginVersion) loginError.value = reason(error) }
  finally { await syncLoginAvailability(id); if (version === loginVersion) loginStarting.value = false }
}
function closeLogin() {
  loginVersion++
  if (loginAttemptId) void bridge?.login.cancel(loginAttemptId).catch(() => {})
  loginAttemptId = ''
  loginProvider.value = null; loginInfo.value = null; loginStarting.value = false; loginError.value = ''
  loginAvailabilityLoading.value = false
}
async function toggleLocalFavorite(track: TrackResult) {
  const key = `local-like:${keyOf(track)}`
  if (pending.value.has(key)) return
  pending.value.add(key)
  const liked = !track.localFavorite
  try {
    const snapshot = trackSnapshot(track)
    await api().music.localFavorite(snapshot, liked)
    if (liked) localFavoriteTracks.value = [{ ...snapshot, localFavorite: true }, ...localFavoriteTracks.value.filter(item => keyOf(item) !== keyOf(snapshot))]
    else localFavoriteTracks.value = localFavoriteTracks.value.filter(item => keyOf(item) !== keyOf(snapshot))
    syncLocalFavoriteState()
    if (activeView.value === 'localFavorites') await load()
    notify(liked ? '已加入本地喜欢' : '已从本地喜欢移除')
  } catch (error) { notify(reason(error)) }
  finally { pending.value.delete(key) }
}
function trackStatus(track: TrackResult) {
  return track.localFavorite ? '本地喜欢' : ''
}

const modal = ref<'add' | 'create' | null>(null)
const targetTrack = ref<TrackResult | null>(null)
const modalPlaylists = ref<Playlist[]>([])
const modalCursor = ref<string | undefined>()
const modalBusy = ref(false)
const modalError = ref('')
const createProvider = ref<ProviderId>('netease')
const playlistName = ref('')
const privatePlaylist = ref(false)
let modalVersion = 0
const writablePlaylists = computed(() => modalPlaylists.value.filter(item => item.writable))
function resetModal() {
  modalVersion++; modal.value = null; targetTrack.value = null; modalBusy.value = false; modalError.value = ''
  modalPlaylists.value = []; modalCursor.value = undefined
}
function closeModal() { if (!modalBusy.value) resetModal() }
async function loadModalPlaylists(more = false) {
  const track = targetTrack.value
  if (!track) return
  const version = ++modalVersion
  modalBusy.value = true; modalError.value = ''
  try {
    const [page] = await api().music.playlists([track.provider], more && modalCursor.value ? { [track.provider]: modalCursor.value } : undefined)
    if (version !== modalVersion || !page) return
    if (page.error) throw new Error(page.error)
    const map = new Map((more ? modalPlaylists.value : []).map(item => [item.id, item]))
    for (const playlist of page.playlists) map.set(playlist.id, playlist)
    modalPlaylists.value = [...map.values()]; modalCursor.value = page.cursor
  } catch (error) { if (version === modalVersion) modalError.value = reason(error) }
  finally { if (version === modalVersion) modalBusy.value = false }
}
function openAdd(track: TrackResult) {
  if (!provider(track.provider).connected) { void openLogin(track.provider); return }
  targetTrack.value = track; modal.value = 'add'; modalPlaylists.value = []; modalCursor.value = undefined; void loadModalPlaylists()
}
function openCreate(fromAdd = false) {
  modalVersion++
  if (!fromAdd) targetTrack.value = null
  createProvider.value = targetTrack.value?.provider || statuses.value.find(item => item.connected)?.id || 'netease'
  playlistName.value = ''; privatePlaylist.value = false; modalError.value = ''; modalBusy.value = false; modal.value = 'create'
}
async function addToPlaylist(playlist: Playlist) {
  const track = targetTrack.value
  if (!track || modalBusy.value) return
  const version = ++modalVersion
  modalBusy.value = true; modalError.value = ''
  try {
    await api().music.addToPlaylist(refOf(track), playlist.id)
    if (version !== modalVersion) return
    notify(`已添加到「${playlist.name}」`); modalBusy.value = false; closeModal()
  } catch (error) { if (version === modalVersion) modalError.value = reason(error) }
  finally { if (version === modalVersion) modalBusy.value = false }
}
async function createPlaylist() {
  if (!playlistName.value.trim() || modalBusy.value) return
  const version = ++modalVersion
  const track = targetTrack.value
  modalBusy.value = true; modalError.value = ''
  try {
    const playlist = await api().music.createPlaylist(createProvider.value, playlistName.value.trim(), privatePlaylist.value)
    if (version !== modalVersion) return
    if (track) {
      try {
        await api().music.addToPlaylist(refOf(track), playlist.id)
        if (version !== modalVersion) return
        notify('歌单已创建，歌曲已添加')
      }
      catch (error) {
        if (version !== modalVersion) return
        // Creation is not rolled back or retried when the second operation fails.
        modal.value = 'add'; modalPlaylists.value = [playlist]; modalError.value = `歌单已创建，但添加歌曲失败：${reason(error)}`; return
      }
    } else notify('歌单已同步创建到所属平台')
    modalBusy.value = false; closeModal()
    if (activeView.value === 'playlists' && !selectedPlaylist.value) void load()
  } catch (error) { if (version === modalVersion) modalError.value = reason(error) }
  finally { if (version === modalVersion) modalBusy.value = false }
}

// The renderer receives an opaque, revocable local media handle, never platform cookies.
const audio = ref<HTMLAudioElement | null>(null)
const currentTrack = ref<TrackResult | null>(null)
const queue = ref<TrackResult[]>([])
const playing = ref(false)
const playbackBusy = ref(false)
const playbackError = ref('')
const queueOpen = ref(false)
const currentTime = ref(0)
const mediaDuration = ref(0)
const volume = ref(70)
let playbackVersion = 0
const sourceUrl = ref('')
const sourceExpiry = ref(0)
const nowDuration = computed(() => mediaDuration.value || (currentTrack.value?.durationMs || 0) / 1000)
const queueIndex = computed(() => currentTrack.value ? queue.value.findIndex(track => keyOf(track) === keyOf(currentTrack.value!)) : -1)
function releaseSource() { const url = sourceUrl.value; sourceUrl.value = ''; sourceExpiry.value = 0; if (url) void bridge?.music.releasePlayback(url).catch(() => {}) }
function stopPlayback(clear = false) {
  playbackVersion++
  audio.value?.pause()
  audio.value?.removeAttribute('src'); audio.value?.load()
  releaseSource(); playing.value = false; playbackBusy.value = false; currentTime.value = 0; mediaDuration.value = 0
  if (clear) { currentTrack.value = null; queue.value = []; playbackError.value = '' }
}
async function play(track: TrackResult, replaceQueue = true) {
  if (track.provider === 'netease' && !provider(track.provider).connected) { void openLogin(track.provider); return }
  if (track.playback === 'restricted') { notify(track.restrictionReason || '当前账号无播放权限；可以加入本地喜欢'); return }
  stopPlayback()
  const version = playbackVersion
  currentTrack.value = { ...track }; playbackBusy.value = true; playbackError.value = ''
  if (replaceQueue) queue.value = [...tracks.value]
  try {
    const source = await api().music.playback(refOf(track))
    if (version !== playbackVersion) { void bridge?.music.releasePlayback(source.url).catch(() => {}); return }
    if (!audio.value) throw new Error('播放器尚未就绪')
    sourceUrl.value = source.url; sourceExpiry.value = source.expiresAt
    audio.value.src = source.url; audio.value.volume = volume.value / 100
    await audio.value.play()
  } catch (error) {
    if (version === playbackVersion) { playbackError.value = reason(error); notify(playbackError.value); audio.value?.pause(); releaseSource() }
  } finally { if (version === playbackVersion) playbackBusy.value = false }
}
async function togglePlayback() {
  if (!currentTrack.value || playbackBusy.value) return
  if (playing.value) audio.value?.pause()
  else if (!sourceUrl.value || Date.now() >= sourceExpiry.value) void play(currentTrack.value, false)
  else try { await audio.value?.play() } catch { playbackError.value = '播放失败，请重新选择歌曲获取授权'; notify(playbackError.value) }
}
function skip(delta: number) { const track = queue.value[queueIndex.value + delta]; if (track) void play(track, false) }
function ended() { playing.value = false; if (queueIndex.value >= 0 && queueIndex.value + 1 < queue.value.length) skip(1) }
function audioError() { if (!sourceUrl.value) return; playing.value = false; playbackError.value = '媒体流无法播放：可能格式不支持、网络异常或授权过期，请重新播放'; notify(playbackError.value); releaseSource() }
function seek(event: Event) { if (audio.value && nowDuration.value) audio.value.currentTime = Number((event.target as HTMLInputElement).value) }
function setVolume(event: Event) { volume.value = Number((event.target as HTMLInputElement).value); if (audio.value) audio.value.volume = volume.value / 100 }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { closeLogin(); closeModal(); queueOpen.value = false }
  if (event.code === 'Space' && !(event.target as HTMLElement)?.closest('input,button,textarea,select,[contenteditable]') && !loginProvider.value && !modal.value) { event.preventDefault(); void togglePlayback() }
}
let clockTimer: ReturnType<typeof setInterval> | undefined
const unsubscribers: (() => void)[] = []
watch(() => statuses.value.map(item => ({ id: item.id, connected: item.connected, revision: item.sessionRevision })), (current, previous) => {
  const changed = new Set(current.filter(item => {
    const old = previous?.find(value => value.id === item.id)
    return old && (old.revision !== item.revision || old.connected !== item.connected)
  }).map(item => item.id))
  if (!changed.size) return
  // Account identity never needs to enter the renderer; this opaque revision invalidates private data.
  requestVersion++; busy.value = false
  trackPages.value = trackPages.value.filter(page => !changed.has(page.provider))
  playlistPages.value = playlistPages.value.filter(page => !changed.has(page.provider))
  if (selectedPlaylist.value && changed.has(selectedPlaylist.value.provider)) selectedPlaylist.value = null
  const retainedQueue = queue.value.filter(track => !changed.has(track.provider))
  if (currentTrack.value && changed.has(currentTrack.value.provider)) stopPlayback(true)
  queue.value = retainedQueue
  if (modal.value && changed.has(targetTrack.value?.provider || createProvider.value)) resetModal()
  if (activeView.value !== 'accounts') void load()
})
onMounted(async () => {
  window.addEventListener('keydown', keydown)
  clockTimer = setInterval(() => { clock.value = Date.now() }, 1000)
  if (!bridge) return
  unsubscribers.push(bridge.providers.onStatusChanged(value => { statuses.value = value }))
  unsubscribers.push(bridge.login.onAvailabilityChanged(updateLoginAvailability))
  unsubscribers.push(bridge.login.onChanged(value => {
    if (loginAttemptId !== value.id || loginProvider.value !== value.provider) return
    if (loginInfo.value?.id === value.id && loginInfo.value.sequence > value.sequence) return
    loginInfo.value = value
    if (value.state === 'confirmed') {
      notify('扫码登录成功')
      const id = value.id
      setTimeout(() => { if (loginInfo.value?.id === id) closeLogin() }, 1000)
    }
  }))
  try { appVersion.value = await bridge.app.version() } catch { appVersion.value = '' }
  try { statuses.value = await bridge.providers.list() } catch (error) { notify(reason(error)) }
  try { setLocalFavoriteTracks(await bridge.music.localFavorites()) } catch (error) { notify(reason(error)) }
  await nextTick()
})
onUnmounted(() => { window.removeEventListener('keydown', keydown); for (const unsubscribe of unsubscribers) unsubscribe(); clearInterval(clockTimer); clearTimeout(toastTimer); closeLogin(); stopPlayback(true) })
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><img :src="appIcon" alt="WaveMusic" /><div><strong>WaveMusic</strong><small>CONNECT · API EDITION</small></div></div>
      <nav aria-label="主导航">
        <button :class="{ active: activeView === 'search' }" @click="navigate('search')"><Search :size="19" />聚合搜索</button>
        <button :class="{ active: activeView === 'localFavorites' }" @click="navigate('localFavorites')"><Heart :size="19" />本地喜欢</button>
        <button :class="{ active: activeView === 'playlists' }" @click="navigate('playlists')"><Library :size="19" />我的歌单</button>
      </nav>
      <p class="sidebar-label">我的音乐平台</p>
      <button v-for="item in statuses" :key="item.id" class="provider-mini" @click="item.connected ? navigate('accounts') : openLogin(item.id)">
        <span class="glyph" :class="item.id">{{ item.shortName.slice(0, 1) }}</span><span><strong>{{ item.name }}</strong><small>{{ item.connected ? item.accountName : '点击扫码登录' }}</small></span><i :class="{ online: item.connected }" />
      </button>
      <div class="sidebar-note"><ShieldCheck :size="17" /><p>本地喜欢留在本机<br /><span>播放权限由平台决定</span></p></div>
      <button class="accounts-nav" :class="{ active: activeView === 'accounts' }" @click="navigate('accounts')"><UserRound :size="19" />账号管理<span>{{ connectedCount }}/2</span></button>
      <small class="version">WaveMusic Connect {{ appVersion || 'desktop' }}</small>
    </aside>

    <main class="workspace">
      <header class="topbar"><span><i class="online" />本地直连 · 无自建后端</span><button class="icon-button" :disabled="refreshing || !bridge" title="刷新账号状态" aria-label="刷新账号状态" @click="refreshAccounts"><RefreshCw :size="17" :class="{ spin: refreshing }" /></button></header>
      <section class="page-header"><p>YOUR MUSIC, TOGETHER.</p><h1>{{ selectedPlaylist?.name || titles[activeView] }}</h1><span>{{ selectedPlaylist ? `${provider(selectedPlaylist.provider).name} · 平台歌单` : subtitles[activeView] }}</span></section>
      <div class="page-content">
        <div v-if="!bridge" class="notice"><AlertCircle :size="20" /><div><strong>当前是浏览器预览</strong><p>扫码、平台接口和播放需要桌面版 EXE。本页不会展示模拟歌曲或虚假登录结果。</p></div></div>

        <template v-if="activeView === 'accounts'">
          <div class="account-grid">
            <article v-for="item in statuses" :key="item.id" class="account-card">
              <div class="account-top"><span class="glyph large" :class="item.id">{{ item.shortName.slice(0, 1) }}</span><span class="status" :class="{ connected: item.connected || item.id === 'qishui' }">{{ item.connected ? '已登录' : item.id === 'qishui' ? '访客模式' : '未登录' }}</span></div>
              <h2>{{ item.name }}</h2><div v-if="item.connected" class="account-person"><img v-if="imageAvailable(item.avatarUrl)" :src="item.avatarUrl" alt="账号头像" @error="markImageBroken(item.avatarUrl)" /><span v-else class="account-avatar-placeholder"><UserRound :size="16" /></span><strong>{{ item.accountName }}</strong></div><p v-else>{{ item.id === 'qishui' ? '无需登录即可搜索和播放公开内容；使用汽水音乐 App 扫码可连接账号功能。' : '使用网易云音乐 App 扫码连接账号。' }}</p>
              <p class="api-message">{{ item.apiMessage || '接口请求在本机完成，登录凭据不发送给自建服务器。' }}</p>
              <div class="account-actions"><button v-if="!item.connected" class="primary" :disabled="!bridge" @click="openLogin(item.id)"><ScanLine :size="17" />{{ item.id === 'qishui' ? '汽水扫码' : '网易云扫码' }}</button><button v-else class="secondary" @click="logout(item.id)"><LogOut :size="16" />退出账号</button></div>
            </article>
          </div>
          <div class="info-panel"><ShieldCheck :size="24" /><div><h3>本地喜欢留在本机</h3><p>红心只写入本软件的本地喜欢，可混合收录网易云与汽水歌曲，不会调用平台收藏接口。</p><p>汽水访客请求参考开源 qishui-api，使用公开 Web、PC 与 H5 接口。播放仍以平台实际返回的普通音频地址为准。</p></div><button class="secondary log-button" :disabled="!bridge" @click="openLogs"><FileText :size="16" />打开日志目录</button></div>
        </template>

        <template v-else>
          <form v-if="activeView === 'search'" class="search-form" @submit.prevent="search"><Search :size="22" /><input v-model="query" maxlength="200" placeholder="搜索歌曲、歌手、专辑…" aria-label="搜索关键词" /><button class="primary" :disabled="!query.trim() || !selected.length || !bridge">搜索音乐</button></form>
           <div class="content-toolbar"><div class="platform-filters"><button v-for="item in statuses" :key="item.id" :class="['filter', item.id, { selected: selected.includes(item.id) }]" @click="toggleProvider(item.id)"><i />{{ item.name }}<span v-if="selected.includes(item.id)">✓</span></button></div><button v-if="activeView === 'playlists' && !selectedPlaylist" class="secondary" :disabled="!bridge" @click="openCreate()"><Plus :size="16" />新建歌单</button><button v-else-if="activeView === 'localFavorites' || selectedPlaylist" class="icon-button" :disabled="busy || !bridge" title="刷新列表" aria-label="刷新列表" @click="load()"><RefreshCw :size="16" /></button></div>
          <button v-if="selectedPlaylist" class="back-link" @click="navigate('playlists')"><ChevronLeft :size="16" />返回我的歌单</button>
          <div v-for="error in errors" :key="error.provider" class="platform-error"><AlertCircle :size="17" /><div><strong>{{ provider(error.provider).name }}</strong><span>{{ error.error }}</span></div><button v-if="error.provider === 'netease' && !provider(error.provider).connected" @click="openLogin(error.provider)">登录</button><button v-else :disabled="busy" @click="load(false, error.provider)">重试</button></div>
          <div v-if="lastActionError" class="platform-error"><AlertCircle :size="17" /><span>{{ lastActionError }}</span><button :disabled="busy" @click="load()">重新加载</button></div>

          <template v-if="activeView === 'playlists' && !selectedPlaylist">
            <div v-if="playlists.length" class="playlist-grid"><button v-for="playlist in playlists" :key="`${playlist.provider}:${playlist.id}`" class="playlist-card" @click="openPlaylist(playlist)"><div class="playlist-cover"><img v-if="imageAvailable(playlist.coverUrl)" :src="playlist.coverUrl" alt="" loading="lazy" @error="markImageBroken(playlist.coverUrl)" /><ListMusic v-else :size="48" /><span class="play-circle"><Play :size="21" fill="currentColor" /></span></div><strong>{{ playlist.name }}</strong><p><span :class="['provider-tag', playlist.provider]">{{ provider(playlist.provider).shortName }}</span>{{ playlist.trackCount }} 首{{ playlist.writable ? ' · 可添加' : '' }}</p></button></div>
            <div v-else-if="!busy" class="empty-state"><Library :size="48" /><h2>把喜欢，整理成歌单</h2><p>登录平台账号后，查看已有歌单，或创建一个新的开始。</p></div>
          </template>
          <template v-else>
             <div v-if="tracks.length" class="track-list"><div class="list-caption"><span>{{ selectedPlaylist ? '歌单歌曲' : activeView === 'localFavorites' ? '跨平台本地喜欢' : `“${submitted}” 的搜索结果` }}</span><small>已加载 {{ tracks.length }} 首 · 点击播放时确认权限</small></div>
               <table><thead><tr><th class="number">#</th><th>音乐标题</th><th class="artist">歌手 / 专辑</th><th class="source">平台</th><th class="length">时长</th><th class="actions">操作</th></tr></thead><tbody><tr v-for="(track, index) in tracks" :key="keyOf(track)" :class="{ current: currentTrack && keyOf(currentTrack) === keyOf(track) }" @dblclick="play(track)"><td class="number"><button class="row-play" :disabled="playbackBusy && currentTrack?.trackId === track.trackId" :title="`播放 ${track.title}`" :aria-label="`播放 ${track.title}`" @click="play(track)"><span>{{ String(index + 1).padStart(2, '0') }}</span><Play :size="15" fill="currentColor" /></button></td><td><div class="track-title"><img v-if="imageAvailable(track.coverUrl)" :src="track.coverUrl" alt="" loading="lazy" @error="markImageBroken(track.coverUrl)" /><span v-else class="cover-placeholder"><Music2 :size="20" /></span><div><strong>{{ track.title }}</strong><small v-if="track.playback === 'restricted'">{{ track.restrictionReason }}</small><small v-else-if="track.localFavorite"><b v-if="track.vipRequired" class="vip">VIP</b>{{ trackStatus(track) }}</small><small v-else-if="track.vipRequired"><b class="vip">VIP</b></small></div></div></td><td class="artist"><strong>{{ track.artist }}</strong><small>{{ track.album || '未知专辑' }}</small></td><td class="source"><span :class="['provider-tag', track.provider]">{{ provider(track.provider).shortName }}</span></td><td class="length">{{ duration(track.durationMs) }}</td><td class="actions"><button :class="['icon-button', 'subtle', { liked: track.localFavorite }]" :disabled="pending.has(`local-like:${keyOf(track)}`)" :title="track.localFavorite ? '从本地喜欢移除' : '加入本地喜欢'" :aria-label="track.localFavorite ? '从本地喜欢移除' : '加入本地喜欢'" @click="toggleLocalFavorite(track)"><Heart :size="17" :fill="track.localFavorite ? 'currentColor' : 'none'" /></button><button class="icon-button subtle" title="添加到歌单" aria-label="添加到歌单" @click="openAdd(track)"><Plus :size="17" /></button></td></tr></tbody></table>
            </div>
            <div v-else-if="!busy" class="empty-state"><component :is="activeView === 'localFavorites' ? Heart : Search" :size="48" /><h2>{{ !selected.length ? '请选择一个音乐平台' : activeView === 'search' && !submitted ? '你想听什么？' : activeView === 'localFavorites' ? '还没有本地喜欢' : '这里暂时没有歌曲' }}</h2><p>{{ activeView === 'search' && !submitted ? '输入关键词，在两个音乐世界里一起发现；汽水可直接使用访客模式。' : activeView === 'localFavorites' ? '喜欢的歌曲会保存在这台电脑。' : '可以调整关键词、刷新列表，平台歌单需要连接账号。' }}</p><div v-if="activeView !== 'search' && activeView !== 'localFavorites' && !connectedCount" class="empty-actions"><button v-for="item in statuses" :key="item.id" class="secondary" :disabled="!bridge" @click="openLogin(item.id)">{{ item.id === 'qishui' ? '汽水音乐 App 扫码' : '网易云音乐 App 扫码' }}</button></div></div>
          </template>
          <div v-if="busy" class="loading"><LoaderCircle :size="20" class="spin" />{{ activeView === 'localFavorites' ? '正在读取本地喜欢…' : '正在向平台请求…' }}</div>
          <button v-else-if="canLoadMore" class="load-more secondary" @click="load(true)">加载更多</button>
        </template>
      </div>
    </main>

    <footer class="player-dock"><div class="now-playing"><img v-if="imageAvailable(currentTrack?.coverUrl)" :src="currentTrack?.coverUrl" alt="" @error="markImageBroken(currentTrack?.coverUrl)" /><span v-else class="dock-cover"><Music2 :size="25" /></span><div><strong>{{ currentTrack?.title || '音乐，在这里汇合' }}</strong><small :title="playbackError">{{ playbackError || (currentTrack ? `${currentTrack.artist} · ${provider(currentTrack.provider).shortName}` : '选择一首歌曲开始播放') }}</small></div><button v-if="currentTrack" class="icon-button subtle" :class="{ liked: currentTrack.localFavorite }" :disabled="pending.has(`local-like:${keyOf(currentTrack)}`)" :title="currentTrack.localFavorite ? '从本地喜欢移除' : '加入本地喜欢'" :aria-label="currentTrack.localFavorite ? '从本地喜欢移除' : '加入本地喜欢'" @click="toggleLocalFavorite(currentTrack)"><Heart :size="17" :fill="currentTrack.localFavorite ? 'currentColor' : 'none'" /></button></div><div class="player-center"><div class="player-buttons"><button class="icon-button subtle" :disabled="queueIndex <= 0" title="上一首" aria-label="上一首" @click="skip(-1)"><SkipBack :size="18" /></button><button class="main-play" :disabled="!currentTrack || playbackBusy" :title="playing ? '暂停' : '播放'" :aria-label="playing ? '暂停' : '播放'" @click="togglePlayback"><LoaderCircle v-if="playbackBusy" :size="22" class="spin" /><Pause v-else-if="playing" :size="21" fill="currentColor" /><Play v-else :size="21" fill="currentColor" /></button><button class="icon-button subtle" :disabled="queueIndex < 0 || queueIndex + 1 >= queue.length" title="下一首" aria-label="下一首" @click="skip(1)"><SkipForward :size="18" /></button></div><div class="progress"><small>{{ duration(currentTime * 1000) }}</small><input type="range" min="0" :max="nowDuration || 1" step="0.1" :value="currentTime" :disabled="!sourceUrl || !nowDuration" aria-label="播放进度" @change="seek" /><small>{{ duration(nowDuration * 1000) }}</small></div></div><div class="player-right"><Volume2 :size="18" /><input type="range" min="0" max="100" :value="volume" aria-label="音量" @input="setVolume" /><button class="icon-button subtle" title="播放队列" aria-label="播放队列" @click="queueOpen = !queueOpen"><ListMusic :size="21" /></button></div></footer>
    <audio ref="audio" preload="none" @play="playing = true" @pause="playing = false" @timeupdate="currentTime = audio?.currentTime || 0" @durationchange="mediaDuration = Number.isFinite(audio?.duration) ? audio!.duration : 0" @ended="ended" @error="audioError" />
    <aside v-if="queueOpen" class="queue-panel"><div><h3>播放队列 <small>{{ queue.length }} 首</small></h3><button class="icon-button subtle" aria-label="关闭队列" @click="queueOpen = false"><X :size="19" /></button></div><p v-if="!queue.length" class="muted">开始播放歌曲后，这里的队列会同步更新。</p><button v-for="(track, index) in queue" :key="keyOf(track)" class="queue-track" :class="{ current: index === queueIndex }" @click="play(track, false)"><span>{{ index + 1 }}</span><div><strong>{{ track.title }}</strong><small>{{ track.artist }} · {{ provider(track.provider).shortName }}</small></div></button></aside>

    <div v-if="loginProvider" class="modal-overlay" @click.self="closeLogin">
      <section class="modal login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title">
        <button class="modal-close icon-button subtle" title="关闭登录" aria-label="关闭登录" @click="closeLogin"><X :size="20" /></button>
        <div class="login-heading"><span class="glyph large" :class="loginProvider">{{ provider(loginProvider).shortName.slice(0, 1) }}</span><div><h2 id="login-title">登录{{ provider(loginProvider).name }}</h2><p>登录凭据只保存在本机</p></div></div>
        <div v-if="loginCooldownSeconds > 0" class="login-notice" role="status"><AlertCircle :size="17" /><div><strong>{{ activeLoginAvailability?.message || '平台要求暂停登录请求' }}</strong><p>{{ loginCooldownSeconds }} 秒后可手动重试。切换登录方式或重开窗口不会重置倒计时；平台限制可能持续更久。</p></div></div>
        <div v-else-if="loginAvailabilityLoading || (loginRequestBusy && !loginInProgress && !loginInfo)" class="login-notice loading-notice" role="status"><LoaderCircle :size="17" class="spin" /><p>正在同步登录状态或结束上一项请求，请稍候…</p></div>
         <div class="qr-login-panel">
          <p>{{ loginProvider === 'qishui' ? '打开汽水音乐 App 扫码并确认' : '打开网易云音乐 App 扫码并确认' }}</p>
          <div class="qr-image"><LoaderCircle v-if="loginStarting || loginInfo?.state === 'validating'" :size="36" class="spin" /><img v-else-if="loginInfo?.imageDataUrl && qrSeconds > 0" :src="loginInfo.imageDataUrl" alt="平台登录二维码" /><div v-else><ShieldCheck v-if="loginInfo?.state === 'confirmed'" :size="44" /><QrCode v-else :size="44" /><span>{{ loginInfo?.state === 'confirmed' ? '登录成功' : '二维码不可用' }}</span></div></div>
          <p class="qr-state" :class="{ error: loginError || loginInfo?.state === 'error' }">{{ loginStarting ? '正在生成二维码…' : loginError || loginInfo?.message || '请刷新二维码' }}</p>
          <small v-if="loginInfo && ['waiting', 'scanned'].includes(loginInfo.state)">{{ qrSeconds > 0 ? `${qrSeconds} 秒后过期 · ${nextCheckSeconds ? `${nextCheckSeconds} 秒后再次检查 · ` : ''}已检查 ${loginInfo.checkCount} 次` : '二维码已过期，请刷新' }}</small>
          <button class="secondary" :disabled="loginInProgress || loginRequestBusy || loginCooldownSeconds > 0 || loginInfo?.state === 'confirmed'" @click="refreshQr"><RefreshCw :size="16" />刷新二维码</button>
          <p class="qr-guide">{{ loginProvider === 'qishui' ? '请使用已登录的汽水音乐 App 扫描；二维码包含当前电脑名称，确认后会继续校验账号。访客搜索和本地喜欢无需登录。' : '网易云音乐 App：使用「扫一扫」，并确认是你本人登录。' }}</p>
        </div>
      </section>
    </div>

    <div v-if="modal" class="modal-overlay" @click.self="closeModal"><section class="modal playlist-modal" role="dialog" aria-modal="true" aria-labelledby="playlist-modal-title"><button class="modal-close icon-button subtle" :disabled="modalBusy" aria-label="关闭歌单窗口" @click="closeModal"><X :size="20" /></button><h2 id="playlist-modal-title">{{ modal === 'create' ? '创建一个新歌单' : '添加到歌单' }}</h2><p v-if="targetTrack">{{ targetTrack.title }} · {{ provider(targetTrack.provider).name }}（仅同平台）</p><p v-else>歌单将直接创建在选择的平台账号中。</p><div v-if="modalError" class="modal-error">{{ modalError }}</div><form v-if="modal === 'create'" class="create-form" @submit.prevent="createPlaylist"><label>所属平台<select v-model="createProvider" :disabled="Boolean(targetTrack) || modalBusy"><option v-for="item in statuses" :key="item.id" :value="item.id" :disabled="!item.connected">{{ item.name }}{{ item.connected ? '' : ' · 未登录' }}</option></select></label><label>歌单名称<input v-model="playlistName" maxlength="80" autofocus placeholder="给你的歌单起个名字" :disabled="modalBusy" /></label><label class="checkbox"><input v-model="privatePlaylist" type="checkbox" :disabled="modalBusy" />设为私密歌单</label><button class="primary" :disabled="modalBusy || !playlistName.trim() || !provider(createProvider).connected"><LoaderCircle v-if="modalBusy" :size="17" class="spin" /><Plus v-else :size="17" />{{ targetTrack ? '创建并添加歌曲' : '创建歌单' }}</button></form><template v-else><button class="new-playlist" :disabled="modalBusy" @click="openCreate(true)"><Plus :size="19" />新建歌单并添加</button><div class="playlist-options"><button v-for="playlist in writablePlaylists" :key="playlist.id" :disabled="modalBusy" @click="addToPlaylist(playlist)"><ListMusic :size="23" /><span><strong>{{ playlist.name }}</strong><small>{{ playlist.trackCount }} 首</small></span><Plus :size="17" /></button><p v-if="!modalBusy && !writablePlaylists.length" class="muted">没有可添加的歌单，可以创建新歌单。</p></div><button v-if="modalCursor && !modalBusy" class="secondary load-more" @click="loadModalPlaylists(true)">更多歌单</button><button v-else-if="modalError && !modalBusy" class="secondary" @click="loadModalPlaylists()">重新加载歌单</button><div v-if="modalBusy" class="loading"><LoaderCircle :size="19" class="spin" />正在同步…</div></template></section></div>
    <div v-if="toast" class="toast" role="status">{{ toast }}<button aria-label="关闭提示" @click="toast = ''"><X :size="15" /></button></div>
  </div>
</template>
