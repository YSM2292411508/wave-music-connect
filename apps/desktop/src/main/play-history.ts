import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TrackResult } from '../shared/contracts.js'

type HistoryEntry = { track: TrackResult; playedAt: number; count: number }
type HistoryDocument = { version: 1; entries: HistoryEntry[] }
const MAX_HISTORY = 200

export class PlayHistory {
  private entries?: HistoryEntry[]
  private loading?: Promise<HistoryEntry[]>
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private normalize: (value: unknown) => TrackResult) {}

  private get path() { return join(app.getPath('userData'), 'play-history.json') }
  private key(track: TrackResult) { return `${track.provider}:${track.trackId}` }

  private load(): Promise<HistoryEntry[]> {
    if (this.entries) return Promise.resolve(this.entries)
    if (this.loading) return this.loading
    this.loading = (async () => {
      let contents: string
      try { contents = await readFile(this.path, 'utf8') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (this.entries = [])
        throw new Error('无法读取本机播放历史')
      }
      let parsed: unknown
      try { parsed = JSON.parse(contents) } catch { throw new Error('播放历史文件无效') }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('播放历史格式无效')
      const document = parsed as Partial<HistoryDocument>
      if (document.version !== 1 || !Array.isArray(document.entries)) throw new Error('播放历史版本不兼容')
      const entries: HistoryEntry[] = []
      const seen = new Set<string>()
      for (const raw of document.entries.slice(0, MAX_HISTORY)) {
        try {
          const track = this.normalize(raw.track)
          const key = this.key(track)
          if (seen.has(key)) continue
          seen.add(key)
          entries.push({ track: { ...track, localFavorite: false },
            playedAt: Number.isFinite(raw.playedAt) ? raw.playedAt : Date.now(),
            count: Number.isSafeInteger(raw.count) && raw.count > 0 ? raw.count : 1 })
        } catch { /* Skip corrupted entries. */ }
      }
      return (this.entries = entries.sort((a, b) => b.playedAt - a.playedAt))
    })()
    return this.loading
  }

  async list(): Promise<TrackResult[]> {
    await this.writes
    return (await this.load()).map(item => ({ ...item.track }))
  }

  record(track: TrackResult): Promise<void> {
    const operation = this.writes.then(async () => {
      const oldEntries = await this.load()
      const key = this.key(track)
      const before = oldEntries.find(item => this.key(item.track) === key)
      const entry: HistoryEntry = { track: { ...this.normalize(track), localFavorite: false },
        playedAt: Date.now(), count: (before?.count || 0) + 1 }
      const next = [entry, ...oldEntries.filter(item => this.key(item.track) !== key)].slice(0, MAX_HISTORY)
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, entries: next } satisfies HistoryDocument), 'utf8')
        await rename(temporary, this.path)
        this.entries = next
      } finally { await unlink(temporary).catch(() => {}) }
    })
    this.writes = operation.catch(() => {})
    return operation
  }

  async clear(): Promise<void> {
    const operation = this.writes.then(async () => {
      await this.load()
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, entries: [] } satisfies HistoryDocument), 'utf8')
        await rename(temporary, this.path)
        this.entries = []
      } finally { await unlink(temporary).catch(() => {}) }
    })
    this.writes = operation.catch(() => {})
    return operation
  }
}
