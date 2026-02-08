import { app, BrowserWindow, ipcMain, Menu, session, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

import { registerAllHandlers } from './ipc'
import { ScanManager } from './services/scan-manager'
import { RecoveryManager } from './services/recovery-manager'
import { PrivilegeManager } from './services/privilege/index'

// ─── State ──────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null
let scanManager: ScanManager
let recoveryManager: RecoveryManager
let privilegeManager: PrivilegeManager

// ─── Window Creation ────────────────────────────────────────

function createWindow(): void {
  // Center on the display where the cursor currently is
  const cursorPoint = screen.getCursorScreenPoint()
  const currentDisplay = screen.getDisplayNearestPoint(cursorPoint)
  const { x, y, width: dw, height: dh } = currentDisplay.workArea

  const winWidth = 1200
  const winHeight = 800

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: Math.round(x + (dw - winWidth) / 2),
    y: Math.round(y + (dh - winHeight) / 2),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a2e',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Show window once content is ready to avoid visual flash
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    if (is.dev) {
      mainWindow?.webContents.openDevTools()
    }
  })

  // Load the renderer
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Remove default menu in production
  if (!is.dev) {
    Menu.setApplicationMenu(null)
  }

  // Graceful cleanup on window close
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ─── Service Initialization ─────────────────────────────────

function initializeServices(): void {
  scanManager = new ScanManager()
  recoveryManager = new RecoveryManager()
  privilegeManager = new PrivilegeManager()
  scanManager.setPrivilegeManager(privilegeManager)

  registerAllHandlers(ipcMain, { scanManager, recoveryManager, privilegeManager })
}

// ─── App Lifecycle ──────────────────────────────────────────

app.whenReady().then(() => {
  // Set CSP based on environment
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = is.dev
      ? "default-src 'self' 'unsafe-inline' 'unsafe-eval'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })

  initializeServices()
  createWindow()

  // macOS: re-create window when dock icon is clicked and no windows exist
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// ─── Process Error Handling ─────────────────────────────────

process.on('uncaughtException', (error: Error) => {
  console.error('[main] Uncaught exception:', error)
})

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[main] Unhandled rejection:', reason)
})
