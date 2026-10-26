import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join, dirname } from 'node:path'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { object, type JsonObject } from './transport.js'
import { findQishuiInstallation, type QishuiInstallation } from './qishui-installation.js'
import { logEvent } from '../logger.js'

const run = promisify(execFile)
export class QishuiNative {
  private installation?: QishuiInstallation
  get directory() { return this.installation?.directory || '' }
  get version() { return this.installation?.version || '' }
  get shellVersion() { return this.installation?.shellVersion || '' }
  get source() { return this.installation?.source }
  get selectionNote() { return this.installation?.selectionNote }
  error = ''
  private child?: UtilityProcess
  private ready?: Promise<{ serial: string }>
  private counter = 0
  private generation = 0
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  onCertificate?: (form: JsonObject) => Promise<{ data: JsonObject; logId: string }>
  onStateChanged?: () => void
  get configPath() { return join(app.getPath('userData'), 'qishui-components.json') }
  async discover() {
    try {
      const saved = object(JSON.parse(await readFile(this.configPath, 'utf8')))
      // Re-resolve legacy component paths, so a saved shell directory does not
      // hide a subsequently installed, configured package update.
      const input = typeof saved.installationRoot === 'string' ? saved.installationRoot : saved.directory
      if (typeof input === 'string') {
        const found = await findQishuiInstallation(input)
        if (found) { this.useInstallation(found); return }
      }
    } catch { /* A fresh installation has no component setting. */ }
    const roots = ['D:/softWare/qiShuiMusic/Soda Music']
    try {
      const { stdout } = await run('reg.exe', ['query', String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{87285ABF-B326-46A4-B8BD-FFDD150917DE}_is1`, '/v', 'DisplayIcon'], { windowsHide: true, timeout: 4000 })
      const icon = stdout.match(/REG_SZ\s+(.+)/)?.[1]?.trim().replace(/^"|"(?:,\d+)?$/g, '').replace(/,\d+$/, '')
      if (icon) roots.unshift(dirname(icon))
    } catch { /* Registry entry is optional. */ }
    for (const root of roots) {
      const found = await findQishuiInstallation(root)
      if (found) { this.useInstallation(found); return }
    }
  }
  private useInstallation(installation: QishuiInstallation) {
    this.installation = installation
    logEvent({ provider: 'qishui', stage: 'components.selected', outcome: 'success',
      clientVersion: installation.version, shellVersion: installation.shellVersion, componentSource: installation.source,
      message: installation.selectionNote || '已解析安装目录；尚未加载组件或验证登录兼容性' })
  }
  async select(input: string) {
    const installation = await findQishuiInstallation(input)
    if (!installation) throw new Error('未找到带明确版本的汽水音乐组件，请选择包含版本文件夹的完整安装目录')
    await mkdir(dirname(this.configPath), { recursive: true })
    await writeFile(this.configPath, JSON.stringify({ directory: installation.directory, installationRoot: installation.root }), 'utf8')
    this.stop()
    this.useInstallation(installation)
    this.error = ''
    this.onStateChanged?.()
  }
  load(): Promise<{ serial: string }> {
    if (this.error) return Promise.reject(new Error(this.error))
    if (this.ready) return this.ready
    if (!this.directory) return Promise.reject(new Error('未找到汽水音乐本机组件，请先在账号页选择安装目录'))
    const generation = this.generation
    const directory = this.directory
    this.ready = (async () => {
      const statePath = join(app.getPath('userData'), 'qishui-security')
      await mkdir(statePath, { recursive: true })
      if (generation !== this.generation) throw new Error('汽水组件已切换，请重试')
      const child = utilityProcess.fork(join(__dirname, 'native-worker.js'), [], {
        serviceName: 'WaveMusic Qishui components', cwd: directory, stdio: 'ignore',
      })
      this.child = child
      child.on('message', async data => {
        if (this.child !== child) return
        if (data.certificate) {
          try {
            if (!this.onCertificate) throw new Error('设备尚未初始化')
            const result = await this.onCertificate(object(data.form))
            if (this.child === child) child.postMessage({ certificate: data.certificate, ...result })
          } catch {
            if (this.child === child) child.postMessage({ certificate: data.certificate, error: '汽水安全证书申请失败' })
          }
          return
        }
        const request = this.pending.get(data.id)
        if (!request) return
        this.pending.delete(data.id)
        clearTimeout(request.timer)
        if (data.error) request.reject(new Error(data.error))
        else request.resolve(data.value)
      })
      child.once('exit', () => {
        if (this.child !== child) return
        this.error = '汽水本机组件进程退出，可能存在版本或 ABI 不兼容；请重新选择安装目录后重试'
        this.failPending(this.error)
        this.child = undefined
        this.onStateChanged?.()
        // Preserve rejected readiness until the user explicitly retries selection.
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); reject(new Error('汽水组件进程启动超时')) }, 10_000)
          const spawned = () => { cleanup(); resolve() }
          const exited = () => { cleanup(); reject(new Error('汽水组件进程启动失败')) }
          const cleanup = () => { clearTimeout(timer); child.off('spawn', spawned); child.off('exit', exited) }
          child.once('spawn', spawned)
          child.once('exit', exited)
        })
        if (this.child !== child) throw new Error('汽水组件已停止')
        const result = await this.call<{ serial: string }>('load', { directory, statePath })
        if (generation !== this.generation) throw new Error('汽水组件已切换，请重试')
        this.onStateChanged?.()
        return result
      }
      catch (error) {
        if (generation === this.generation) {
          this.error = '汽水本机组件初始化失败，当前安装版本可能与客户端不兼容'
          this.onStateChanged?.()
        }
        throw error
      }
    })()
    return this.ready
  }
  call<T = any>(method: string, data: unknown): Promise<T> {
    if (!this.child) return Promise.reject(new Error(this.error || '汽水组件未启动'))
    const child = this.child
    const id = ++this.counter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('汽水本机组件响应超时')) }, 15_000)
      this.pending.set(id, { resolve, reject, timer })
      try { child.postMessage({ id, method, data }) }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('汽水组件通信失败')) }
    })
  }
  private failPending(reason: string) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(reason)) }
    this.pending.clear()
  }
  stop() {
    this.generation++
    const child = this.child
    this.child = undefined
    child?.kill()
    this.ready = undefined
    this.failPending('汽水组件已停止')
  }
}
