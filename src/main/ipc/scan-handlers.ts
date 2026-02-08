import type { IpcMain, BrowserWindow } from 'electron'
import { BrowserWindow as BW } from 'electron'
import type { ScanConfig, ScanProgress, RecoverableFile, FileFragment } from '../../shared/types'
import { IpcChannels } from '../../shared/types'

// ─── ScanManager interface ───────────────────────────────────
// Minimal interface so this module does not depend on the concrete class.

export interface ScanManager {
  start(config: ScanConfig): Promise<string>
  pause(sessionId: string): void
  resume(sessionId: string): void
  cancel(sessionId: string): void
  on(event: 'progress', cb: (sessionId: string, progress: ScanProgress) => void): void
  on(event: 'file-found', cb: (sessionId: string, file: RecoverableFile) => void): void
  on(event: 'complete', cb: (sessionId: string, filesFound: number) => void): void
  on(event: 'error', cb: (sessionId: string, error: string) => void): void
  on(event: string, cb: (...args: unknown[]) => void): void
}

// ─── BigInt Serialization ────────────────────────────────────

function serializeBigInts<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === 'bigint') return obj.toString() as unknown as T
  if (Array.isArray(obj)) return obj.map(serializeBigInts) as unknown as T
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = serializeBigInts(value)
    }
    return result as T
  }
  return obj
}

function deserializeScanConfig(raw: Record<string, unknown>): ScanConfig {
  return {
    devicePath: raw.devicePath as string,
    partitionPath: raw.partitionPath as string | undefined,
    scanType: raw.scanType as ScanConfig['scanType'],
    fileCategories: raw.fileCategories as ScanConfig['fileCategories'],
    fileTypes: raw.fileTypes as ScanConfig['fileTypes'],
    deviceSize: raw.deviceSize != null ? BigInt(raw.deviceSize as string) : undefined,
    startOffset: raw.startOffset != null ? BigInt(raw.startOffset as string) : undefined,
    endOffset: raw.endOffset != null ? BigInt(raw.endOffset as string) : undefined,
  }
}

function serializeScanProgress(progress: ScanProgress): Record<string, unknown> {
  return {
    bytesScanned: progress.bytesScanned.toString(),
    totalBytes: progress.totalBytes.toString(),
    percentage: progress.percentage,
    filesFound: progress.filesFound,
    currentSector: progress.currentSector.toString(),
    estimatedTimeRemaining: progress.estimatedTimeRemaining,
    sectorsWithErrors: progress.sectorsWithErrors,
  }
}

function serializeFileFragment(fragment: FileFragment): Record<string, unknown> {
  return {
    offset: fragment.offset.toString(),
    size: fragment.size.toString(),
  }
}

function serializeRecoverableFile(file: RecoverableFile): Record<string, unknown> {
  return {
    ...file,
    offset: file.offset.toString(),
    size: file.size.toString(),
    fragments: file.fragments?.map(serializeFileFragment),
  }
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

export function registerScanHandlers(ipcMain: IpcMain, scanManager: ScanManager): void {
  // ── Throttled IPC forwarding ──────────────────────────────
  // Batch file-found events and throttle progress to keep the
  // renderer responsive during high-throughput deep scans.

  const RENDERER_THROTTLE_MS = 250
  let pendingFiles: Record<string, unknown>[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function flushPendingFiles(): void {
    if (pendingFiles.length === 0) return
    sendToRenderer(IpcChannels.SCAN_FILE_FOUND, pendingFiles)
    pendingFiles = []
    flushTimer = null
  }

  scanManager.on('progress', (_sessionId: string, progress: ScanProgress) => {
    sendToRenderer(IpcChannels.SCAN_PROGRESS, serializeScanProgress(progress))
  })

  scanManager.on('file-found', (_sessionId: string, file: RecoverableFile) => {
    pendingFiles.push(serializeRecoverableFile(file))
    if (!flushTimer) {
      flushTimer = setTimeout(flushPendingFiles, RENDERER_THROTTLE_MS)
    }
  })

  scanManager.on('complete', (sessionId: string, filesFound: number) => {
    // Flush any remaining files before sending complete
    flushPendingFiles()
    sendToRenderer(IpcChannels.SCAN_COMPLETE, { sessionId, filesFound })
  })

  scanManager.on('error', (sessionId: string, error: string) => {
    console.error('[scan] worker error:', sessionId, error)
    sendToRenderer(IpcChannels.SCAN_ERROR, { sessionId, message: error })
  })

  // Request / response handlers
  ipcMain.handle(IpcChannels.SCAN_START, async (_event, rawConfig: Record<string, unknown>) => {
    try {
      const config = deserializeScanConfig(rawConfig)
      const sessionId = await scanManager.start(config)
      return { success: true, sessionId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[scan] start failed:', message)
      return { success: false, error: message }
    }
  })

  ipcMain.handle(IpcChannels.SCAN_PAUSE, async (_event, sessionId: string) => {
    try {
      scanManager.pause(sessionId)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  })

  ipcMain.handle(IpcChannels.SCAN_RESUME, async (_event, sessionId: string) => {
    try {
      scanManager.resume(sessionId)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  })

  ipcMain.handle(IpcChannels.SCAN_CANCEL, async (_event, sessionId: string) => {
    try {
      scanManager.cancel(sessionId)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  })
}
