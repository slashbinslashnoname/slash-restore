import type { IpcMain } from 'electron'
import { IpcChannels } from '../../shared/types'
import type { PrivilegeManager } from '../services/privilege'

// ─── Handler Registration ────────────────────────────────────

export function registerPrivilegeHandlers(
  ipcMain: IpcMain,
  privilegeManager: PrivilegeManager,
): void {
  ipcMain.handle(IpcChannels.PRIVILEGE_CHECK, async () => {
    try {
      const status = await privilegeManager.getStatus()
      return { success: true, status }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  })

  ipcMain.handle(IpcChannels.PRIVILEGE_REQUEST, async () => {
    try {
      const elevated = await privilegeManager.requestElevation()
      return { success: true, elevated }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  })
}
