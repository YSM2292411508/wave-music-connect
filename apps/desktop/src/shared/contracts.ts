export type ProviderId = 'netease' | 'qishui'
export type LoginState = 'waiting' | 'scanned' | 'validating' | 'confirmed' | 'expired' | 'cancelled' | 'error'
export type ProviderStatus = {
  id: ProviderId
  name: string
  shortName: string
  color: string
  connected: boolean
  sessionRevision: number
  accountName?: string
  avatarUrl?: string
  apiReady: boolean
  apiMessage?: string
}
export type QrLoginSession = {
  id: string
  provider: ProviderId
  imageDataUrl: string
  state: LoginState
  message: string
  expiresAt: number
  sequence: number
  checkCount: number
  checkedAt?: number
  nextCheckAt?: number
  platformStatus?: string
}
export type LoginAvailability = {
  provider: ProviderId
  sequence: number
  busy: boolean
  retryAt: number
  message?: string
}
export type TrackRef = { provider: ProviderId; trackId: string }
export type TrackResult = TrackRef & {
  title: string
  artist: string
  album: string
  coverUrl?: string
  durationMs?: number
  localFavorite?: boolean
  vipRequired: boolean
  playback: 'check' | 'restricted'
  restrictionReason?: string
}
export type TrackPage = {
  provider: ProviderId
  tracks: TrackResult[]
  cursor?: string
  error?: string
}
export type Playlist = {
  provider: ProviderId
  id: string
  name: string
  coverUrl?: string
  trackCount: number
  writable: boolean
}
export type PlaylistPage = { provider: ProviderId; playlists: Playlist[]; cursor?: string; error?: string }
export type PlaybackSource = { url: string; expiresAt: number }
export type DesktopBridge = {
  app: {
    version(): Promise<string>
  }
  providers: {
    list(): Promise<ProviderStatus[]>
    refresh(): Promise<ProviderStatus[]>
    logout(id: ProviderId): Promise<void>
    onStatusChanged(callback: (statuses: ProviderStatus[]) => void): () => void
  }
  login: {
    availability(id: ProviderId): Promise<LoginAvailability>
    start(id: ProviderId, attemptId: string): Promise<QrLoginSession>
    cancel(id: string): Promise<void>
    onChanged(callback: (session: QrLoginSession) => void): () => void
    onAvailabilityChanged(callback: (state: LoginAvailability) => void): () => void
  }
  diagnostics: {
    openLogs(): Promise<void>
  }
  music: {
    search(ids: ProviderId[], query: string, cursors?: Partial<Record<ProviderId, string>>): Promise<TrackPage[]>
    localFavorites(): Promise<TrackResult[]>
    localFavorite(track: TrackResult, liked: boolean): Promise<void>
    playlists(ids: ProviderId[], cursors?: Partial<Record<ProviderId, string>>): Promise<PlaylistPage[]>
    playlistTracks(provider: ProviderId, playlistId: string, cursor?: string): Promise<TrackPage>
    createPlaylist(provider: ProviderId, name: string, privatePlaylist: boolean): Promise<Playlist>
    addToPlaylist(track: TrackRef, playlistId: string): Promise<void>
    playback(track: TrackRef): Promise<PlaybackSource>
    releasePlayback(url: string): Promise<void>
  }
}
