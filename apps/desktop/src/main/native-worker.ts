// Only this isolated process loads the user's installed native components.
// No recovered commercial JavaScript or binaries are bundled with this application.
import { join } from 'node:path'
import { createRequire } from 'node:module'

const nativeRequire = createRequire(__filename)
const port = process.parentPort!
let device: any
let bdms: any
let ticket: any
const requests = new Map<string, any>()
const certificates = new Map<number, (...args: any[]) => void>()
let certificateId = 0

const settings = {
  session_guard_config: {
    enable: true, ree_enable_symmetric: true, config_version: '20250908.1',
    ree_path: ['/luna/pc/me/collection/media', '/luna/pc/user/me/privacy/setting',
      '/luna/pc/me/collection/playlist', '/luna/pc/me/collection/album', '/luna/pc/me/follow',
      '/luna/pc/me/collection/artist', '/webcast/room/create/', '/web/api/media/user/info/', '/passport/token/beat/web/'],
    ree_path_prefix: [], ree_exclude_path: [], ree_exclude_path_prefix: [],
  },
  enable_full_path_track: true,
}

async function dispatch(method: string, data: any) {
  if (method === 'load') {
    process.chdir(data.directory)
    device = nativeRequire(join(data.directory, 'device.node'))
    bdms = nativeRequire(join(data.directory, 'bdms.node'))
    ticket = nativeRequire(join(data.directory, 'bdticket.node'))
    for (const [module, names] of [[device, ['getSerial', 'applogDecorated']],
      [bdms, ['init', 'generateHttpSignatureHeaders']],
      [ticket, ['registerEventEmitter', 'refreshSettings', 'startBDTicket', 'handleRequest', 'handleResponse']]] as [any, string[]][]) {
      if (names.some(name => typeof module?.[name] !== 'function')) throw new Error('本机汽水组件导出接口不兼容')
    }
    ticket.registerEventEmitter((event: string, form: unknown, callback: (...args: any[]) => void) => {
      if (event !== 'pc_request_cert' || typeof callback !== 'function') return
      const id = ++certificateId
      certificates.set(id, callback)
      port.postMessage({ certificate: id, form })
      setTimeout(() => {
        const pending = certificates.get(id)
        if (pending) { certificates.delete(id); pending({ data: {} }, '', { httpStatusCode: -1, message: '证书请求超时' }) }
      }, 25_000).unref()
    })
    ticket.refreshSettings(settings)
    ticket.startBDTicket(data.statePath)
    return { serial: String(device.getSerial()) }
  }
  if (method === 'decorate') return Buffer.from(device.applogDecorated(Buffer.from(data.body))).toString('base64')
  if (method === 'initialize') { bdms.init({ deviceId: data.did }); return true }
  if (method === 'sign') {
    const headers = { ...data.headers }
    const url = new URL(data.url)
    if (!url.pathname.startsWith('/passport/') && !url.pathname.startsWith('/ttwid/')) {
      const lines = Object.entries(headers).map(([name, value]) => `${name}\r\n${value}`).join('\r\n')
      const signed = String(bdms.generateHttpSignatureHeaders(data.url, lines)).split('\r\n').filter(value => value.trim())
      if (signed.length % 2) throw new Error('汽水签名组件返回无效响应')
      for (let i = 0; i < signed.length; i += 2) headers[signed[i]] = signed[i + 1]
    }
    if (requests.size > 100) throw new Error('汽水签名请求过多')
    const result = ticket.handleRequest(url.host, url.pathname, headers, data.sessionId, data.sessionSS)
    requests.set(data.requestId, { headers, sessionId: data.sessionId, sessionSS: data.sessionSS, associated: result.associated || {} })
    setTimeout(() => requests.delete(data.requestId), 60_000).unref()
    return { ...headers, ...result.headers }
  }
  if (method === 'response') {
    const request = requests.get(data.requestId)
    requests.delete(data.requestId)
    if (request && data.headers) {
      const url = new URL(data.url)
      ticket.handleResponse(url.host, url.pathname, data.headers, data.sessionId || '',
        request.headers, request.sessionId, request.sessionSS, request.associated)
    }
    return true
  }
  throw new Error('未知组件指令')
}

port.on('message', async ({ data }) => {
  if (data.certificate) {
    const callback = certificates.get(data.certificate)
    certificates.delete(data.certificate)
    callback?.({ data: data.data || {} }, data.logId || '', { httpStatusCode: data.error ? -1 : 0, message: data.error || '' })
    return
  }
  try { port.postMessage({ id: data.id, value: await dispatch(data.method, data.data) }) }
  catch { port.postMessage({ id: data.id, error: `汽水本机组件调用失败（${data.method}），可能与当前 Electron 不兼容` }) }
})
