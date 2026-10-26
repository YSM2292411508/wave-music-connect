import type { ProviderId, ProviderStatus } from '../shared/contracts.js'
import { NeteaseProvider } from './api/netease.js'
import { QishuiProvider } from './api/qishui.js'
import type { MusicProvider } from './api/provider.js'
import { message } from './api/transport.js'

export class Providers {
  readonly netease = new NeteaseProvider()
  readonly qishui = new QishuiProvider()
  readonly all: Record<ProviderId, MusicProvider> = { netease: this.netease, qishui: this.qishui }
  private errors = new Map<ProviderId, string>()
  statuses(): ProviderStatus[] {
    return Object.values(this.all).map(provider => ({ ...provider.status(),
      apiMessage: this.errors.get(provider.id) || provider.status().apiMessage }))
  }
  clearError(id: ProviderId) { this.errors.delete(id) }
  async refresh() {
    await Promise.all(Object.values(this.all).map(async provider => {
      try { await provider.refresh(); this.errors.delete(provider.id) }
      catch (error) { this.errors.set(provider.id, message(error)) }
    }))
    return this.statuses()
  }
}
