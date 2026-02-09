import type { IpcMain } from 'electron'
import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { IpcChannels } from '../../shared/types'
import { registerDeviceHandlers } from './device-handlers'
import { registerScanHandlers, type ScanManager } from './scan-handlers'
import { registerRecoveryHandlers, type RecoveryManager } from './recovery-handlers'
import { registerPrivilegeHandlers } from './privilege-handlers'
import type { PrivilegeManager } from '../services/privilege'
import { registerPreviewHandlers } from './preview-handlers'

// ─── Services aggregate ──────────────────────────────────────

export interface IpcServices {
  scanManager: ScanManager
  recoveryManager: RecoveryManager
  privilegeManager: PrivilegeManager
}

// ─── Register all IPC handlers ───────────────────────────────

export function registerAllHandlers(ipcMain: IpcMain, services: IpcServices): void {
  registerDeviceHandlers(ipcMain)
  registerScanHandlers(ipcMain, services.scanManager)
  registerRecoveryHandlers(ipcMain, services.recoveryManager)
  registerPrivilegeHandlers(ipcMain, services.privilegeManager)
  registerPreviewHandlers(ipcMain)

  // Dialog handler -- lets the renderer open a native directory picker
  ipcMain.handle(IpcChannels.DIALOG_SELECT_DIRECTORY, async () => {
    const win = BrowserWindow.getAllWindows()[0] ?? null
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select recovery destination',
    }

    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, path: null }
    }

    return { success: true, path: result.filePaths[0] }
  })

  // Default recovery path — ~/Documents/SlashRestore Recovery
  ipcMain.handle(IpcChannels.DIALOG_DEFAULT_RECOVERY_PATH, () => {
    const documentsDir = app.getPath('documents')
    return { success: true, path: join(documentsDir, 'SlashRestore Recovery') }
  })
}

// Re-export sub-module types for convenience
export type { ScanManager } from './scan-handlers'
export type { RecoveryManager } from './recovery-handlers'
export type { PrivilegeManager } from '../services/privilege'
