import { Routes, Route, Navigate } from 'react-router-dom'
import { useAppStore } from './store'
import StepIndicator from './components/StepIndicator'
import DeviceSelectionPage from './pages/DeviceSelectionPage'
import ScanConfigPage from './pages/ScanConfigPage'
import ScanProgressPage from './pages/ScanProgressPage'
import FileSelectionPage from './pages/FileSelectionPage'
import RecoveryPage from './pages/RecoveryPage'
import { AlertTriangle, X } from 'lucide-react'

export default function App() {
  const errors = useAppStore((s) => s.errors)
  const dismissError = useAppStore((s) => s.dismissError)

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface text-gray-100">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-surface-lighter px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold tracking-tight text-white">
            Slash Restore
          </h1>
          <span className="rounded bg-primary-600/20 px-2 py-0.5 text-xs font-medium text-primary-400">
            Data Recovery
          </span>
        </div>
      </header>

      {/* Step indicator */}
      <div className="border-b border-surface-lighter px-6 py-3">
        <StepIndicator />
      </div>

      {/* Error toasts */}
      {errors.length > 0 && (
        <div className="absolute right-4 top-20 z-50 flex max-w-md flex-col gap-2">
          {errors.map((err, idx) => (
            <div
              key={idx}
              className="animate-slide-up flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300 shadow-lg"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="flex-1">{err}</span>
              <button
                onClick={() => dismissError(idx)}
                className="shrink-0 text-red-400 hover:text-red-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<DeviceSelectionPage />} />
          <Route path="/scan-config" element={<ScanConfigPage />} />
          <Route path="/scanning" element={<ScanProgressPage />} />
          <Route path="/files" element={<FileSelectionPage />} />
          <Route path="/recovery" element={<RecoveryPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
