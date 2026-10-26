import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import * as physicalFs from 'original-fs'

const modules = ['device.node', 'bdms.node', 'bdticket.node', 'metasecml.dll']
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export type QishuiInstallation = {
  root: string
  directory: string
  version: string
  shellVersion: string
  source: 'shell' | 'package'
  selectionNote?: string
}

function compareVersions(left: string, right: string) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

async function hasComponents(directory: string) {
  try { return (await Promise.all(modules.map(name => stat(join(directory, name))))).every(file => file.isFile()) }
  catch { return false }
}

async function readObject(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的汽水安装元数据')
  return value as Record<string, unknown>
}

// Match the installed launcher's package selection, rather than picking the
// newest directory regardless of its configuration or minimum shell version.
async function withConfiguredPackage(shell: QishuiInstallation): Promise<QishuiInstallation> {
  let check = '更新配置'
  try {
    const packages = join(shell.root, 'Packages')
    const config = await readObject(join(packages, 'config.json'))
    if (typeof config.latestVersion !== 'string' || !versionPattern.test(config.latestVersion)) {
      return { ...shell, selectionNote: '更新配置没有有效版本号' }
    }
    const packageRoot = join(packages, config.latestVersion)
    check = '更新包清单'
    const manifest = await readObject(join(packageRoot, 'manifest.json'))
    if (manifest.version !== config.latestVersion) return { ...shell, selectionNote: '更新包版本与配置不一致' }
    if (typeof manifest.shellMinVersion !== 'string' || !versionPattern.test(manifest.shellMinVersion)) {
      return { ...shell, selectionNote: '更新包缺少有效的最低基础版本' }
    }
    if (compareVersions(shell.shellVersion, manifest.shellMinVersion) < 0) {
      return { ...shell, selectionNote: `基础程序 ${shell.shellVersion} 低于更新包要求 ${manifest.shellMinVersion}` }
    }
    if (compareVersions(shell.shellVersion, config.latestVersion) >= 0) {
      return { ...shell, selectionNote: '基础程序版本不低于配置的更新包' }
    }
    const directory = join(packageRoot, 'app.asar.unpacked')
    check = '更新包 ASAR'
    // Electron's normal fs APIs route *.asar through its virtual filesystem.
    // original-fs is the supported way to inspect the physical archives.
    const archives = await Promise.all([
      physicalFs.promises.stat(join(packageRoot, 'app.asar')),
      physicalFs.promises.stat(join(packageRoot, 'main.asar')),
    ])
    if (!archives.every(file => file.isFile())) return { ...shell, selectionNote: '更新包 ASAR 不是文件' }
    check = '更新包安全组件'
    if (await hasComponents(directory)) return { ...shell, directory, version: config.latestVersion, source: 'package' }
    return { ...shell, selectionNote: '更新包设备或安全组件不完整' }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'invalid-metadata'
    return { ...shell, selectionNote: `${check}不可用（${code}）` }
  }
}

export async function findQishuiInstallation(input: string): Promise<QishuiInstallation | undefined> {
  let selected = resolve(input)
  if (basename(selected).toLowerCase().endsWith('.exe')) selected = dirname(selected)
  if (basename(selected).toLowerCase() === 'app.asar.unpacked') selected = dirname(selected)
  if (basename(selected).toLowerCase() === 'resources') selected = dirname(selected)
  if (versionPattern.test(basename(selected)) && basename(dirname(selected)).toLowerCase() === 'packages') {
    selected = dirname(dirname(selected))
  } else if (basename(selected).toLowerCase() === 'packages') selected = dirname(selected)

  const selectedShell = versionPattern.test(basename(selected)) ? selected : undefined
  const root = selectedShell ? dirname(selected) : selected
  const candidates: string[] = selectedShell ? [selectedShell] : []
  if (!selectedShell) {
    try {
      const entries = (await readdir(root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && versionPattern.test(entry.name))
        .sort((a, b) => compareVersions(b.name, a.name))
      candidates.push(...entries.map(entry => join(root, entry.name)))
    } catch { return undefined }
  }
  for (const shell of candidates) {
    const directory = join(shell, 'resources', 'app.asar.unpacked')
    if (!await hasComponents(directory)) continue
    const shellVersion = basename(shell)
    return withConfiguredPackage({ root, directory, version: shellVersion, shellVersion, source: 'shell' })
  }
  return undefined
}
