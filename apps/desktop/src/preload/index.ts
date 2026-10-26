import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, LoginAvailability, ProviderStatus, QrLoginSession, TrackResult } from '../shared/contracts.js'

function subscribe<T>(channel: string, callback: (value: T) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}
function trackSnapshot(track: TrackResult): TrackResult {
  return { provider: track.provider, trackId: track.trackId, title: track.title, artist: track.artist, album: track.album,
    coverUrl: track.coverUrl, durationMs: track.durationMs, localFavorite: Boolean(track.localFavorite),
    vipRequired: track.vipRequired, playback: track.playback, restrictionReason: track.restrictionReason }
}
const bridge: DesktopBridge = {
  app: {
    version: () => ipcRenderer.invoke('app:version'),
  },
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    refresh: () => ipcRenderer.invoke('providers:refresh'),
    logout: id => ipcRenderer.invoke('providers:logout', id),
    onStatusChanged: callback => subscribe<ProviderStatus[]>('providers:status-changed', callback),
  },
  login: {
    availability: provider => ipcRenderer.invoke('login:availability', provider),
    start: (provider, attemptId) => ipcRenderer.invoke('login:start', { provider, attemptId }),
    cancel: id => ipcRenderer.invoke('login:cancel', id),
    onChanged: callback => subscribe<QrLoginSession>('login:changed', callback),
    onAvailabilityChanged: callback => subscribe<LoginAvailability>('login:availability-changed', callback),
  },
  diagnostics: {
    openLogs: () => ipcRenderer.invoke('diagnostics:open-logs'),
  },
  music: {
    search: (ids, query, cursors) => ipcRenderer.invoke('music:search', { ids: [...ids], query,
      cursors: cursors ? { ...cursors } : undefined }),
    localFavorites: () => ipcRenderer.invoke('music:local-favorites'),
    localFavorite: (track, liked) => ipcRenderer.invoke('music:local-favorite', { track: trackSnapshot(track), liked }),
    playlists: (ids, cursors) => ipcRenderer.invoke('music:playlists', { ids: [...ids],
      cursors: cursors ? { ...cursors } : undefined }),
    playlistTracks: (provider, playlistId, cursor) => ipcRenderer.invoke('music:playlist-tracks', { provider, playlistId, cursor }),
    createPlaylist: (provider, name, privatePlaylist) => ipcRenderer.invoke('music:create-playlist', { provider, name, privatePlaylist }),
    addToPlaylist: (track, playlistId) => ipcRenderer.invoke('music:add-to-playlist', {
      track: { provider: track.provider, trackId: track.trackId }, playlistId,
    }),
    playback: track => ipcRenderer.invoke('music:playback', { provider: track.provider, trackId: track.trackId }),
    releasePlayback: url => ipcRenderer.invoke('music:release-playback', url),
  },
}
contextBridge.exposeInMainWorld('waveDesktop', bridge)
