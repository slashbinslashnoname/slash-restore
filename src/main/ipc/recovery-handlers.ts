import type { IpcMain, BrowserWindow } from 'electron'
import { BrowserWindow as BW } from 'electron'
import type {
  RecoveryConfig,
  RecoveryProgress,
  RecoverableFile,
  FileFragment,
} from '../../shared/types'
import { IpcChannels } from '../../shared/types'
import * as path from 'node:path'

// ─── RecoveryManager interface ───────────────────────────────

export interface RecoveryManager {
  startRecovery(config: RecoveryConfig): Promise<string>
  pauseRecovery(recoveryId: string): void
  resumeRecovery(recoveryId: string): void
  cancelRecovery(recoveryId: string): void
  on(event: 'progress', cb: (recoveryId: string, progress: RecoveryProgress) => void): void
  on(event: 'complete', cb: (recoveryId: string) => void): void
  on(event: 'error', cb: (recoveryId: string, error: string) => void): void
  on(event: string, cb: (...args: unknown[]) => void): void
}

// ─── BigInt Serialization ────────────────────────────────────

function serializeRecoveryProgress(progress: RecoveryProgress): Record<string, unknown> {
  return {
    totalFiles: progress.totalFiles,
    completedFiles: progress.completedFiles,
    currentFile: progress.currentFile,
    bytesWritten: progress.bytesWritten.toString(),
    totalBytes: progress.totalBytes.toString(),
    percentage: progress.percentage,
    errors: progress.errors,
  }
}

function deserializeFileFragment(raw: Record<string, unknown>): FileFragment {
  return {
    offset: BigInt(raw.offset as string),
    size: BigInt(raw.size as string),
  }
}

function deserializeRecoverableFile(raw: Record<string, unknown>): RecoverableFile {
  return {
    id: raw.id as string,
    type: raw.type as RecoverableFile['type'],
    category: raw.category as RecoverableFile['category'],
    offset: BigInt(raw.offset as string),
    size: BigInt(raw.size as string),
    sizeEstimated: raw.sizeEstimated as boolean,
    name: raw.name as string | undefined,
    extension: raw.extension as string,
    thumbnail: raw.thumbnail as string | undefined,
    metadata: raw.metadata as RecoverableFile['metadata'],
    recoverability: raw.recoverability as RecoverableFile['recoverability'],
    source: raw.source as RecoverableFile['source'],
    fragments: raw.fragments
      ? (raw.fragments as Record<string, unknown>[]).map(deserializeFileFragment)
      : undefined,
  }
}

function deserializeRecoveryConfig(raw: Record<string, unknown>): RecoveryConfig {
  return {
    files: (raw.files as Record<string, unknown>[]).map(deserializeRecoverableFile),
    destinationPath: raw.destinationPath as string,
    conflictStrategy: raw.conflictStrategy as RecoveryConfig['conflictStrategy'],
    preserveStructure: raw.preserveStructure as boolean,
    sourceDevicePath: raw.sourceDevicePath as string,
  }
}

// ─── Same-device protection ──────────────────────────────────

function isSameDevice(sourcePath: string, destinationPath: string): boolean {
  // Normalise paths and check whether the destination resides on the
  // same device / partition as the source.  This is a basic heuristic
  // comparing the device path prefix (e.g. /dev/sda) with the resolved
  // destination.  A production implementation would use stat(2) to
  // compare st_dev, but this provides a first safety net.
  const normSource = path.resolve(sourcePath)
  const normDest = path.resolve(destinationPath)

  // On Linux the source will be something like /dev/sda1.
  // If the destination starts with the same device path it is clearly wrong.
  if (normDest.startsWith(normSource)) {
    return true
  }

  return false
}

// ─── Helpers ─────────────────────────────────────────────────

function getMainWindow(): BrowserWindow | null {
  const windows = BW.getAllWindows()
  return windows.length > 0 ? windows[0] : null
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

// ─── Handler Registration ────────────────────────────────────

export function registerRecoveryHandlers(
  ipcMain: IpcMain,
  recoveryManager: RecoveryManager,
): void {
  // Forward RecoveryManager events to the renderer process
  recoveryManager.on('progress', (recoveryId: string, progress: RecoveryProgress) => {
    sendToRenderer(IpcChannels.RECOVERY_PROGRESS, recoveryId, serializeRecoveryProgress(progress))
  })

  recoveryManager.on('complete', (recoveryId: string) => {
    sendToRenderer(IpcChannels.RECOVERY_COMPLETE, recoveryId)
  })

  recoveryManager.on('error', (recoveryId: string, error: string) => {
    sendToRenderer(IpcChannels.RECOVERY_ERROR, recoveryId, error)
  })

  // Request / response handlers
  ipcMain.handle(
    IpcChannels.RECOVERY_START,
    async (_event, rawConfig: Record<string, unknown>) => {
      try {
        const config = deserializeRecoveryConfig(rawConfig)

        // Validate: at least one file to recover
        if (!config.files || config.files.length === 0) {
          return { success: false, error: 'No files selected for recovery.' }
        }

        // Validate: destination path is provided
        if (!config.destinationPath) {
          return { success: false, error: 'No destination path specified.' }
        }

        const recoveryId = await recoveryManager.startRecovery(config)
        return { success: true, recoveryId }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }
    },
  )

  ipcMain.handle(IpcChannels.RECOVERY_PAUSE, async (_event, recoveryId: string) => {
    try {
      recoveryManager.pauseRecovery(recoveryId)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  })

  ipcMain.handle(IpcChannels.RECOVERY_RESUME, async (_event, recoveryId: string) => {
    try {
      recoveryManager.resumeRecovery(recoveryId)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  })

  ipcMain.handle(IpcChannels.RECOVERY_CANCEL, async (_event, recoveryId: string) => {
    try {
      recoveryManager.cancelRecovery(recoveryId)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  })
}
