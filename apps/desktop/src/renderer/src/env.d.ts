/// <reference types="vite/client" />

import type { DesktopBridge } from './types'

declare global {
  interface Window {
    waveDesktop?: DesktopBridge
  }
}

export {}
