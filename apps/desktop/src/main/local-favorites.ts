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


  /** Export only local song metadata. Never include credentials or remote media URLs. */
  async exportBackup(): Promise<string> {
    await this.writes
    const values = await this.load()
    const favorites = [...values.values()].sort((a, b) => b.addedAt - a.addedAt)
    return JSON.stringify({ version: 1, favorites } satisfies FavoriteDocument, null, 2)
  }

  /** Merge backup songs without deleting existing favorites. */
  async importBackup(content: string): Promise<{ added: number; skipped: number }> {
    if (content.length > 8 * 1024 * 1024) throw new Error('备份文件过大')
    let parsed: unknown
    try { parsed = JSON.parse(content) }
    catch { throw new Error('备份文件不是有效的 JSON') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('备份文件格式无效')
    const document = parsed as Partial<FavoriteDocument>
    if (document.version !== 1 || !Array.isArray(document.favorites) || document.favorites.length > MAX_FAVORITES) {
      throw new Error('备份格式或收藏数量不受支持')
    }
    // Validate the entire file before touching the existing local collection.
    const incoming: StoredFavorite[] = document.favorites.map(item => {
      if (!item || typeof item !== 'object') throw new Error('备份文件包含无效歌曲')
      const track = this.normalize(item.track)
      const addedAt = typeof item.addedAt === 'number' && Number.isFinite(item.addedAt) && item.addedAt > 0
        ? item.addedAt : Date.now()
      return { track: { ...track, localFavorite: true }, addedAt }
    })
    const operation = this.writes.then(async () => {
      const existing = await this.load()
      const merged = new Map(existing)
      let added = 0
      for (const item of incoming) {
        const key = this.key(item.track)
        if (merged.has(key)) continue
        if (merged.size >= MAX_FAVORITES) throw new Error('合并后的收藏超过 5000 首，未修改原有数据')
        merged.set(key, item)
        added++
      }
      if (!added) return { added, skipped: incoming.length }
      const temporary = `${this.path}.${randomUUID()}.tmp`
      const next: FavoriteDocument = { version: 1,
        favorites: [...merged.values()].sort((a, b) => b.addedAt - a.addedAt) }
      try {
        await writeFile(temporary, JSON.stringify(next), 'utf8')
        await rename(temporary, this.path)
        this.values = merged
      } finally { await unlink(temporary).catch(() => {}) }
      return { added, skipped: incoming.length - added }
    })
    this.writes = operation.catch(() => {})
    return operation
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
