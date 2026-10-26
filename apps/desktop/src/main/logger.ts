import { app } from 'electron'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../shared/contracts.js'
import { diagnostic } from './api/transport.js'

type LogEvent = {
  provider?: ProviderId | 'app'
  stage: string
  outcome: 'start' | 'success' | 'error' | 'cancelled'
  durationMs?: number
  retryAfterMs?: number
  httpStatus?: number
  platformCode?: string
  platformStatus?: string
  clientVersion?: string
  shellVersion?: string
  componentSource?: 'shell' | 'package'
  logId?: string
  hasSession?: boolean
  message?: string
}

let directory = ''
let file = ''
let writes: Promise<void> = Promise.resolve()

function safeText(value: string, max = 180) {
  return diagnostic(value)
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已隐藏]')
    .replace(/(?:验证码|captcha|code)\s*[:=：]?\s*\d{4,8}/gi, '[验证码已隐藏]')
    .slice(0, max)
}

export async function initializeLogger() {
  directory = join(app.getPath('userData'), 'logs')
  file = join(directory, 'wavemusic.log')
  await mkdir(directory, { recursive: true })
  try {
    const info = await stat(file)
    if (info.size > 4 * 1024 * 1024) await rename(file, join(directory, `wavemusic-${Date.now()}.log`))
  } catch { /* The log is created by the first event. */ }
}

export function logsDirectory() {
  if (!directory) throw new Error('日志目录尚未初始化')
  return directory
}

export function logEvent(event: LogEvent) {
  if (!file) return
  const record: Record<string, unknown> = {
    time: new Date().toISOString(),
    provider: event.provider || 'app',
    stage: safeText(event.stage, 80),
    outcome: event.outcome,
  }
  if (Number.isFinite(event.durationMs)) record.durationMs = Math.max(0, Math.round(event.durationMs!))
  if (Number.isFinite(event.retryAfterMs)) record.retryAfterMs = Math.max(0, Math.round(event.retryAfterMs!))
  if (Number.isInteger(event.httpStatus)) record.httpStatus = event.httpStatus
  if (event.platformCode) record.platformCode = safeText(event.platformCode, 40)
  if (event.platformStatus) record.platformStatus = safeText(event.platformStatus, 40)
  if (event.clientVersion) record.clientVersion = safeText(event.clientVersion, 40)
  if (event.shellVersion) record.shellVersion = safeText(event.shellVersion, 40)
  if (event.componentSource) record.componentSource = event.componentSource
  if (event.logId) record.logId = event.logId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 160)
  if (typeof event.hasSession === 'boolean') record.hasSession = event.hasSession
  if (event.message) record.message = safeText(event.message)
  const line = `${JSON.stringify(record)}\n`
  writes = writes.then(() => appendFile(file, line, { encoding: 'utf8', mode: 0o600 })).catch(() => {})
}
