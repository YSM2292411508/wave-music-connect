import { app, safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'

type EmbeddedService = { origin: string; server: Server; persistent: boolean }

let servicePromise: Promise<EmbeddedService> | undefined

function sessionSecret(): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  const path = join(app.getPath('userData'), 'qqmusic-session-secret.bin')
  if (existsSync(path)) {
    try { return safeStorage.decryptString(readFileSync(path)) }
    catch { /* Replace a damaged local key. Existing encrypted sessions will be rejected. */ }
  }
  const secret = randomBytes(32).toString('base64url')
  writeFileSync(path, safeStorage.encryptString(secret))
  return secret
}

async function start(): Promise<EmbeddedService> {
  const previousAuthSessionPath = process.env.QQ_AUTH_SESSION_PATH
  const previousSessionSecret = process.env.QQ_SESSION_SECRET
  const previousUpdateCheck = process.env.QQ_DISABLE_UPDATE_CHECK
  const previousEnvironment = process.env.NODE_ENV
  const secret = sessionSecret()
  if (secret) {
    process.env.QQ_AUTH_SESSION_PATH = join(app.getPath('userData'), 'qqmusic-auth-sessions.json')
    process.env.QQ_SESSION_SECRET = secret
  } else {
    delete process.env.QQ_AUTH_SESSION_PATH
    delete process.env.QQ_SESSION_SECRET
  }
  process.env.QQ_DISABLE_UPDATE_CHECK = 'true'

  // The package's test host exposes the same Koa application without binding its default port.
  // WaveMusic owns a loopback-only random port so multiple app instances cannot collide on 3200.
  process.env.NODE_ENV = 'test'
  let module: typeof import('@yakult-green-tea/qq-music-api')
  try { module = await import('@yakult-green-tea/qq-music-api') }
  finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousEnvironment
    if (previousAuthSessionPath === undefined) delete process.env.QQ_AUTH_SESSION_PATH
    else process.env.QQ_AUTH_SESSION_PATH = previousAuthSessionPath
    if (previousSessionSecret === undefined) delete process.env.QQ_SESSION_SECRET
    else process.env.QQ_SESSION_SECRET = previousSessionSecret
    if (previousUpdateCheck === undefined) delete process.env.QQ_DISABLE_UPDATE_CHECK
    else process.env.QQ_DISABLE_UPDATE_CHECK = previousUpdateCheck
  }
  // Node wraps this CommonJS package as `default.default`, while some bundlers
  // expose the Koa app directly as `default`. Accept both public interop shapes.
  const nestedDefault = (module.default as unknown as { default?: typeof module.default }).default
  const koaApp = typeof module.default?.callback === 'function' ? module.default : nestedDefault
  if (!koaApp || typeof koaApp.callback !== 'function') throw new Error('QQ音乐本地服务模块格式不兼容')
  const server = createServer(koaApp.callback())
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off('listening', listening); reject(error) }
    const listening = () => { server.off('error', failed); resolve() }
    server.once('error', failed)
    server.once('listening', listening)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('QQ音乐本地服务未能取得监听端口')
  }
  return { origin: `http://127.0.0.1:${address.port}`, server, persistent: Boolean(secret) }
}

export function qqMusicService() {
  servicePromise ||= start().catch(error => { servicePromise = undefined; throw error })
  return servicePromise
}

export async function closeQqMusicService() {
  const service = await servicePromise?.catch(() => undefined)
  if (!service?.server.listening) return
  await new Promise<void>(resolve => service.server.close(() => resolve()))
}
