import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels } from '../shared/types'
import type { ElectronAPI, Unsubscribe, SerializedScanConfig, SerializedRecoveryConfig } from './api-types'

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Create an event listener on ipcRenderer that returns an unsubscribe
 * function, as required by the API contract.
 */
function onEvent<T extends unknown[]>(
  channel: string,
  callback: (...args: T) => void,
): Unsubscribe {
  // Electron's ipcRenderer.on callback receives (event, ...args)
  const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
    callback(...(args as T))
  }
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

// ─── Exposed API ─────────────────────────────────────────────

const api: ElectronAPI = {
  // ── Devices ──────────────────────────────────────────────
  devices: {
    async list() {
      const result = await ipcRenderer.invoke(IpcChannels.DEVICE_LIST)
      if (!result.success) throw new Error(result.error ?? 'Failed to list devices')
      return result.devices
    },
    async refresh() {
      const result = await ipcRenderer.invoke(IpcChannels.DEVICE_REFRESH)
      if (!result.success) throw new Error(result.error ?? 'Failed to refresh devices')
      return result.devices
    },
  },

  // ── Scan ─────────────────────────────────────────────────
  scan: {
    async start(config: SerializedScanConfig) {
      const result = await ipcRenderer.invoke(IpcChannels.SCAN_START, config)
      if (!result.success) throw new Error(result.error ?? 'Failed to start scan')
      return { sessionId: result.sessionId }
    },
    async pause(sessionId: string) {
      const result = await ipcRenderer.invoke(IpcChannels.SCAN_PAUSE, sessionId)
      if (!result.success) throw new Error(result.error ?? 'Failed to pause scan')
    },
    async resume(sessionId: string) {
      const result = await ipcRenderer.invoke(IpcChannels.SCAN_RESUME, sessionId)
      if (!result.success) throw new Error(result.error ?? 'Failed to resume scan')
    },
    async cancel(sessionId: string) {
      const result = await ipcRenderer.invoke(IpcChannels.SCAN_CANCEL, sessionId)
      if (!result.success) throw new Error(result.error ?? 'Failed to cancel scan')
    },
    onProgress(cb) {
      return onEvent(IpcChannels.SCAN_PROGRESS, cb)
    },
    onFileFound(cb) {
      return onEvent(IpcChannels.SCAN_FILE_FOUND, cb)
    },
    onComplete(cb) {
      return onEvent(IpcChannels.SCAN_COMPLETE, cb)
    },
    onError(cb) {
      return onEvent(IpcChannels.SCAN_ERROR, cb)
    },
  },

  // ── Recovery ─────────────────────────────────────────────
  recovery: {
    start(config: SerializedRecoveryConfig) {
      // BigInt fields inside files[] are already serialized as strings.
      return ipcRenderer.invoke(IpcChannels.RECOVERY_START, config)
    },
    pause(recoveryId: string) {
      return ipcRenderer.invoke(IpcChannels.RECOVERY_PAUSE, recoveryId)
    },
    resume(recoveryId: string) {
      return ipcRenderer.invoke(IpcChannels.RECOVERY_RESUME, recoveryId)
    },
    cancel(recoveryId: string) {
      return ipcRenderer.invoke(IpcChannels.RECOVERY_CANCEL, recoveryId)
    },
    onProgress(cb) {
      return onEvent(IpcChannels.RECOVERY_PROGRESS, cb)
    },
    onComplete(cb) {
      return onEvent(IpcChannels.RECOVERY_COMPLETE, cb)
    },
    onError(cb) {
      return onEvent(IpcChannels.RECOVERY_ERROR, cb)
    },
  },

  // ── Privilege ────────────────────────────────────────────
  privilege: {
    async check() {
      const result = await ipcRenderer.invoke(IpcChannels.PRIVILEGE_CHECK)
      if (!result.success) throw new Error(result.error ?? 'Failed to check privileges')
      return result.status
    },
    async request() {
      const result = await ipcRenderer.invoke(IpcChannels.PRIVILEGE_REQUEST)
      if (!result.success) throw new Error(result.error ?? 'Failed to request elevation')
      return { elevated: result.elevated, platform: process.platform as 'linux' | 'darwin' | 'win32' }
    },
  },

  // ── Preview ──────────────────────────────────────────────
  preview: {
    generate(devicePath: string, fileId: string, offset: string, size: string) {
      return ipcRenderer.invoke(IpcChannels.PREVIEW_GENERATE, {
        devicePath,
        fileId,
        offset,
        size,
      })
    },
    hex(devicePath: string, offset: string, length: number) {
      return ipcRenderer.invoke(IpcChannels.PREVIEW_HEX, {
        devicePath,
        offset,
        length,
      })
    },
  },

  // ── Dialog ───────────────────────────────────────────────
  dialog: {
    async selectDirectory() {
      const result = await ipcRenderer.invoke(IpcChannels.DIALOG_SELECT_DIRECTORY)
      return result?.path ?? null
    },
  },
}

// ─── Expose via context bridge ───────────────────────────────

contextBridge.exposeInMainWorld('api', api)
