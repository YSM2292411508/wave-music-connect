import type { LyricLine, LyricsResult, ProviderId } from '../../shared/contracts.js'

const TIME_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?]/g
const MAX_LINES = 2000
const MAX_TEXT = 1000

function milliseconds(minutes: string, seconds: string, fraction = '') {
  const fractionMs = fraction ? Number(fraction.padEnd(3, '0').slice(0, 3)) : 0
  return Number(minutes) * 60_000 + Number(seconds) * 1000 + fractionMs
}

function rawText(value: unknown) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 2_000_000)
    : ''
}

function clean(value: unknown) {
  return rawText(value).slice(0, MAX_TEXT)
}

function timedLines(value: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const raw of value.slice(0, 2_000_000).split(/\r?\n/)) {
    TIME_TAG.lastIndex = 0
    const times: number[] = []
    let match: RegExpExecArray | null
    while ((match = TIME_TAG.exec(raw))) times.push(milliseconds(match[1]!, match[2]!, match[3]))
    const content = clean(raw.replace(TIME_TAG, '').replace(/<\d+,\d+(?:,\d+)?>/g, ''))
    if (!content) continue
    for (const timeMs of times) {
      lines.push({ timeMs, text: content })
      if (lines.length >= MAX_LINES) break
    }
    if (lines.length >= MAX_LINES) break
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs)
}

export function readableLrc(value: unknown) {
  const raw = rawText(value)
  if (!raw) return ''
  if (/\[\d{1,3}:\d{2}/.test(raw)) return raw
  if (raw.length > 2_000_000 || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) return ''
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8')
    return /\[\d{1,3}:\d{2}/.test(decoded) ? decoded : ''
  } catch { return '' }
}

export function lrcLyrics(provider: ProviderId, trackId: string, original: unknown, translated?: unknown): LyricsResult {
  const source = readableLrc(original)
  const translations = new Map(timedLines(readableLrc(translated)).map(line => [line.timeMs, line.text]))
  const lines = timedLines(source).map(line => ({ ...line, translation: translations.get(line.timeMs) }))
  const plainText = !lines.length ? clean(source || original) || undefined : undefined
  return { provider, trackId, lines, offsetMs: 0, plainText }
}

export function structuredLyrics(provider: ProviderId, trackId: string, sentences: unknown[], offsetMs = 0): LyricsResult {
  const lines = sentences.slice(0, MAX_LINES).flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const sentence = value as Record<string, unknown>
    const timeMs = Number(sentence.start_ms)
    const endTimeMs = Number(sentence.end_ms)
    const text = clean(sentence.text)
    if (!Number.isFinite(timeMs) || timeMs < 0 || !text) return []
    return [{ timeMs, ...(Number.isFinite(endTimeMs) && endTimeMs > timeMs ? { endTimeMs } : {}), text }]
  }).sort((a, b) => a.timeMs - b.timeMs)
  return { provider, trackId, lines, offsetMs: Number.isFinite(offsetMs) && offsetMs > 0 ? offsetMs : 0 }
}
