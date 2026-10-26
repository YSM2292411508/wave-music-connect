import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TrackResult } from '../shared/contracts.js'

type StoredFavorite = { track: TrackResult; addedAt: number }
type FavoriteDocument = { version: 1; favorites: StoredFavorite[] }

const MAX_FAVORITES = 5000

export class LocalFavorites {
  private values?: Map<string, StoredFavorite>
  private loading?: Promise<Map<string, StoredFavorite>>
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private normalize: (value: unknown) => TrackResult) {}

  private get path() { return join(app.getPath('userData'), 'local-favorites.json') }
  private key(track: TrackResult) { return `${track.provider}:${track.trackId}` }

  private load() {
    if (this.values) return Promise.resolve(this.values)
    if (this.loading) return this.loading
    this.loading = (async () => {
      const values = new Map<string, StoredFavorite>()
      let raw: unknown
      try { raw = JSON.parse(await readFile(this.path, 'utf8')) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.values = values; return values }
        throw new Error('本地喜欢数据无法读取，请检查应用数据目录')
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('本地喜欢数据格式无效')
      const document = raw as Partial<FavoriteDocument>
      if (document.version !== 1 || !Array.isArray(document.favorites)) throw new Error('本地喜欢数据版本不兼容')
      for (const [index, item] of document.favorites.slice(0, MAX_FAVORITES).entries()) {
        try {
          if (!item || typeof item !== 'object') continue
          const stored = item as Partial<StoredFavorite>
          const track = this.normalize(stored.track)
          const addedAt = Number.isFinite(stored.addedAt) && Number(stored.addedAt) > 0
            ? Number(stored.addedAt) : Date.now() - index
          values.set(this.key(track), { track: { ...track, localFavorite: true }, addedAt })
        } catch { /* Ignore a damaged row without exposing unvalidated local data. */ }
      }
      this.values = values
      return values
    })()
    return this.loading
  }

  async list(): Promise<TrackResult[]> {
    await this.writes
    const values = await this.load()
    return [...values.values()].sort((a, b) => b.addedAt - a.addedAt)
      .map(item => ({ ...item.track, localFavorite: true }))
  }

  set(track: TrackResult, liked: boolean): Promise<void> {
    const operation = this.writes.then(async () => {
      const values = await this.load()
      const key = this.key(track)
      const previous = values.get(key)
      if (liked && !previous && values.size >= MAX_FAVORITES) throw new Error(`本地喜欢最多保存 ${MAX_FAVORITES} 首歌曲`)
      if (liked) values.set(key, { track: { ...track, localFavorite: true }, addedAt: previous?.addedAt || Date.now() })
      else values.delete(key)
      const document: FavoriteDocument = { version: 1, favorites: [...values.values()].sort((a, b) => b.addedAt - a.addedAt) }
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(document), 'utf8')
        await rename(temporary, this.path)
      } catch (error) {
        if (previous) values.set(key, previous)
        else values.delete(key)
        throw error
      } finally { await unlink(temporary).catch(() => {}) }
    })
    this.writes = operation.catch(() => {})
    return operation
  }
}
