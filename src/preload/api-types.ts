import type {
  PrivilegeStatus,
  ScanProgress,
  RecoverableFile,
  RecoveryProgress,
} from '../shared/types'

// ─── Serialized variants (bigint fields as strings) ──────────
// These mirror the shared types but with bigint fields replaced by
// string so they can cross the IPC boundary safely.

export interface SerializedPartitionInfo {
  id: string
  path: string
  label: string
  size: string
  offset: string
  filesystem?: string
  mountPoint?: string
}

export interface SerializedDeviceInfo {
  id: string
  name: string
  path: string
  size: string
  type: 'sd' | 'hdd' | 'ssd' | 'usb' | 'unknown'
  model: string
  removable: boolean
  readOnly: boolean
  mountPoints: { path: string; filesystem: string }[]
  filesystem?: string
  partitions: SerializedPartitionInfo[]
}

export interface SerializedScanConfig {
  devicePath: string
  partitionPath?: string
  scanType: 'quick' | 'deep'
  fileCategories: ('photo' | 'video' | 'document' | 'audio' | 'archive' | 'database')[]
  fileTypes?: string[]
  deviceSize?: string
  startOffset?: string
  endOffset?: string
}

export interface SerializedRecoverableFile {
  id: string
  type: string
  category: string
  offset: string
  size: string
  sizeEstimated: boolean
  name?: string
  extension: string
  thumbnail?: string
  metadata?: Record<string, unknown>
  recoverability: 'good' | 'partial' | 'poor'
  source: 'carving' | 'metadata'
  fragments?: { offset: string; size: string }[]
}

export interface SerializedScanProgress {
  bytesScanned: string
  totalBytes: string
  percentage: number
  filesFound: number
  currentSector: string
  estimatedTimeRemaining?: number
  sectorsWithErrors: number
}

export interface SerializedRecoveryConfig {
  files: SerializedRecoverableFile[]
  destinationPath: string
  conflictStrategy: 'rename' | 'overwrite' | 'skip'
  preserveStructure: boolean
  sourceDevicePath: string
}

export interface SerializedRecoveryProgress {
  totalFiles: number
  completedFiles: number
  currentFile?: string
  bytesWritten: string
  totalBytes: string
  percentage: number
  errors: { fileId: string; fileName: string; error: string }[]
}

// ─── IPC Result wrappers ─────────────────────────────────────

export interface IpcResult<T = void> {
  success: boolean
  error?: string
  [key: string]: unknown
}

export interface DeviceListResult extends IpcResult {
  devices: SerializedDeviceInfo[]
}

// ─── Unsubscribe function ────────────────────────────────────

export type Unsubscribe = () => void

// ─── Electron API ────────────────────────────────────────────

export interface ElectronAPI {
  devices: {
    list(): Promise<DeviceListResult>
    refresh(): Promise<DeviceListResult>
  }

  scan: {
    start(config: SerializedScanConfig): Promise<IpcResult & { sessionId?: string }>
    pause(sessionId: string): Promise<IpcResult>
    resume(sessionId: string): Promise<IpcResult>
    cancel(sessionId: string): Promise<IpcResult>
    onProgress(cb: (sessionId: string, progress: SerializedScanProgress) => void): Unsubscribe
    onFileFound(cb: (sessionId: string, file: SerializedRecoverableFile) => void): Unsubscribe
    onComplete(cb: (data: { sessionId: string; filesFound: number }) => void): Unsubscribe
    onError(cb: (sessionId: string, error: string) => void): Unsubscribe
  }

  recovery: {
    start(config: SerializedRecoveryConfig): Promise<IpcResult & { recoveryId?: string }>
    pause(recoveryId: string): Promise<IpcResult>
    resume(recoveryId: string): Promise<IpcResult>
    cancel(recoveryId: string): Promise<IpcResult>
    onProgress(cb: (recoveryId: string, progress: SerializedRecoveryProgress) => void): Unsubscribe
    onComplete(cb: (recoveryId: string) => void): Unsubscribe
    onError(cb: (recoveryId: string, error: string) => void): Unsubscribe
  }

  privilege: {
    check(): Promise<IpcResult & { status?: PrivilegeStatus }>
    request(): Promise<IpcResult & { elevated?: boolean }>
  }

  preview: {
    generate(
      devicePath: string,
      fileId: string,
      offset: string,
      size: string,
    ): Promise<IpcResult & { fileId?: string; base64?: string }>
    hex(
      devicePath: string,
      offset: string,
      length: number,
    ): Promise<IpcResult & { hexDump?: string }>
  }

  dialog: {
    selectDirectory(): Promise<IpcResult & { path?: string | null }>
  }
}

// ─── Window augmentation ─────────────────────────────────────

declare global {
  interface Window {
    api: ElectronAPI
  }
}
