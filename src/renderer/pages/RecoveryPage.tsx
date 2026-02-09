import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FolderOpen,
  AlertTriangle,
  ChevronLeft,
  Pause,
  Play,
  X,
  CheckCircle2,
  XCircle,
  ExternalLink
} from 'lucide-react'
import { useRecovery } from '../hooks/useRecovery'
import { useAppStore } from '../store'
import ProgressBar from '../components/ProgressBar'

function formatBytes(sizeStr: string): string {
  const bytes = Number(sizeStr)
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export default function RecoveryPage() {
  const navigate = useNavigate()
  const { start, pause, resume, cancel, progress, status, errors } =
    useRecovery()

  const selectedDevice = useAppStore((s) => s.selectedDevice)
  const foundFiles = useAppStore((s) => s.foundFiles)
  const selectedFileIds = useAppStore((s) => s.selectedFileIds)
  const destinationPath = useAppStore((s) => s.destinationPath)
  const setDestinationPath = useAppStore((s) => s.setDestinationPath)
  const conflictStrategy = useAppStore((s) => s.conflictStrategy)
  const setConflictStrategy = useAppStore((s) => s.setConflictStrategy)
  const setCurrentStep = useAppStore((s) => s.setCurrentStep)
  const addError = useAppStore((s) => s.addError)

  const [hasStarted, setHasStarted] = useState(false)

  useEffect(() => {
    setCurrentStep(5)
  }, [setCurrentStep])

  // Set a default destination path if none is selected
  useEffect(() => {
    if (!destinationPath) {
      window.api.dialog.getDefaultRecoveryPath().then((defaultPath) => {
        if (defaultPath) setDestinationPath(defaultPath)
      }).catch(() => { /* ignore */ })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Determine if destination is on same device
  const isSameDevice = useMemo(() => {
    if (!selectedDevice || !destinationPath) return false
    // Simple heuristic: check if destination starts with any mount point of the source device
    return selectedDevice.mountPoints.some((mp) =>
      destinationPath.startsWith(mp.path)
    )
  }, [selectedDevice, destinationPath])

  const filesToRecover = useMemo(
    () => foundFiles.filter((f) => selectedFileIds.has(f.id)),
    [foundFiles, selectedFileIds]
  )

  const totalSize = useMemo(
    () => filesToRecover.reduce((acc, f) => acc + Number(f.size), 0),
    [filesToRecover]
  )

  const handleSelectDestination = async () => {
    try {
      const dir = await window.api.dialog.selectDirectory()
      if (dir) {
        setDestinationPath(dir)
      }
    } catch (err) {
      addError(
        err instanceof Error
          ? err.message
          : 'Failed to select directory'
      )
    }
  }

  const handleStart = async () => {
    if (!destinationPath || filesToRecover.length === 0) return
    setHasStarted(true)
    await start()
  }

  const percentage = progress?.percentage ?? 0
  const completedFiles = progress?.completedFiles ?? 0
  const totalFiles = progress?.totalFiles ?? filesToRecover.length
  const currentFile = progress?.currentFile

  const isConfiguring = !hasStarted
  const isRunning =
    hasStarted &&
    (status === 'recovering' || status === 'paused')
  const isDone =
    hasStarted &&
    (status === 'completed' || status === 'cancelled' || status === 'error')

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white">
          {isConfiguring
            ? 'Recovery Options'
            : isDone
              ? status === 'completed'
                ? 'Recovery Complete'
                : status === 'cancelled'
                  ? 'Recovery Cancelled'
                  : 'Recovery Failed'
              : 'Recovering Files'}
        </h2>
        <p className="mt-1 text-sm text-gray-400">
          {filesToRecover.length} file{filesToRecover.length !== 1 ? 's' : ''}{' '}
          ({formatBytes(String(totalSize))})
        </p>
      </div>

      {/* ─── Configuration Phase ──────────────────────────────── */}
      {isConfiguring && (
        <>
          {/* Destination folder */}
          <section className="mb-6">
            <h3 className="mb-2 text-sm font-semibold text-gray-300">
              Destination Folder
            </h3>
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-surface-lighter bg-surface-light px-4 py-2.5">
                <FolderOpen className="h-4 w-4 shrink-0 text-gray-500" />
                <span
                  className={`truncate text-sm ${destinationPath ? 'text-gray-200' : 'text-gray-600'}`}
                >
                  {destinationPath || 'No folder selected'}
                </span>
              </div>
              <button
                onClick={handleSelectDestination}
                className="shrink-0 rounded-lg bg-surface-light px-4 py-2.5 text-sm text-gray-300 transition-colors hover:bg-surface-lighter"
              >
                Browse...
              </button>
            </div>

            {/* Same-device warning */}
            {isSameDevice && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <div>
                  <p className="text-sm font-medium text-amber-300">
                    Same device warning
                  </p>
                  <p className="mt-0.5 text-xs text-amber-400/70">
                    The destination is on the same device as the source.
                    Writing recovered files to the source device may
                    overwrite data you are trying to recover. Choose a
                    different destination.
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* Conflict resolution */}
          <section className="mb-6">
            <h3 className="mb-2 text-sm font-semibold text-gray-300">
              File Conflict Strategy
            </h3>
            <div className="flex gap-2">
              {(
                [
                  {
                    value: 'rename' as const,
                    label: 'Auto Rename',
                    desc: 'Add number suffix'
                  },
                  {
                    value: 'overwrite' as const,
                    label: 'Overwrite',
                    desc: 'Replace existing'
                  },
                  {
                    value: 'skip' as const,
                    label: 'Skip',
                    desc: 'Keep existing'
                  }
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setConflictStrategy(opt.value)}
                  className={`flex-1 rounded-lg border p-3 text-left transition-colors ${
                    conflictStrategy === opt.value
                      ? 'border-primary-500 bg-primary-500/10'
                      : 'border-surface-lighter bg-surface-light hover:border-gray-600'
                  }`}
                >
                  <p className="text-sm font-medium text-gray-200">
                    {opt.label}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">{opt.desc}</p>
                </button>
              ))}
            </div>
          </section>

          {/* Actions */}
          <div className="flex justify-between">
            <button
              onClick={() => navigate('/files')}
              className="flex items-center gap-2 rounded-lg bg-surface-light px-4 py-2.5 text-sm text-gray-300 transition-colors hover:bg-surface-lighter"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
            <button
              onClick={handleStart}
              disabled={!destinationPath || filesToRecover.length === 0}
              className="rounded-lg bg-primary-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Start Recovery
            </button>
          </div>
        </>
      )}

      {/* ─── Recovery In Progress ─────────────────────────────── */}
      {isRunning && (
        <>
          {/* Overall progress */}
          <div className="mb-6">
            <ProgressBar value={percentage} size="lg" />
            <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
              <span>
                {completedFiles} / {totalFiles} files
              </span>
              <span>
                {formatBytes(progress?.bytesWritten ?? '0')} /{' '}
                {formatBytes(progress?.totalBytes ?? '0')}
              </span>
            </div>
          </div>

          {/* Current file */}
          {currentFile && (
            <div className="mb-6 rounded-lg border border-surface-lighter bg-surface-light px-4 py-3">
              <p className="text-xs text-gray-500">Currently recovering</p>
              <p className="mt-0.5 truncate text-sm text-gray-200">
                {currentFile}
              </p>
            </div>
          )}

          {/* Error list */}
          {errors.length > 0 && (
            <div className="mb-6">
              <h3 className="mb-2 text-sm font-semibold text-red-400">
                Errors ({errors.length})
              </h3>
              <div className="max-h-40 overflow-auto rounded-lg border border-red-500/20 bg-red-500/5">
                {errors.map((err, idx) => (
                  <div
                    key={idx}
                    className="flex items-start gap-2 border-b border-red-500/10 px-4 py-2 last:border-b-0"
                  >
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-red-300">
                        {err.fileName || err.fileId}
                      </p>
                      <p className="text-xs text-red-400/70">{err.error}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center justify-center gap-3">
            {status === 'recovering' ? (
              <button
                onClick={pause}
                className="flex items-center gap-2 rounded-lg bg-surface-light px-5 py-2.5 text-sm text-gray-300 transition-colors hover:bg-surface-lighter"
              >
                <Pause className="h-4 w-4" />
                Pause
              </button>
            ) : (
              <button
                onClick={resume}
                className="flex items-center gap-2 rounded-lg bg-primary-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-500"
              >
                <Play className="h-4 w-4" />
                Resume
              </button>
            )}
            <button
              onClick={cancel}
              className="flex items-center gap-2 rounded-lg bg-red-500/10 px-5 py-2.5 text-sm text-red-300 transition-colors hover:bg-red-500/20"
            >
              <X className="h-4 w-4" />
              Cancel
            </button>
          </div>
        </>
      )}

      {/* ─── Recovery Done ────────────────────────────────────── */}
      {isDone && (
        <>
          {/* Completion summary */}
          <div className="mb-6 flex flex-col items-center gap-4 py-8">
            {status === 'completed' ? (
              <>
                <CheckCircle2 className="h-16 w-16 text-green-400" />
                <div className="text-center">
                  <p className="text-lg font-semibold text-white">
                    Recovery Complete
                  </p>
                  <p className="mt-1 text-sm text-gray-400">
                    {completedFiles} file
                    {completedFiles !== 1 ? 's' : ''} recovered to{' '}
                    <span className="text-gray-300">{destinationPath}</span>
                  </p>
                </div>
              </>
            ) : status === 'cancelled' ? (
              <>
                <X className="h-16 w-16 text-amber-400" />
                <div className="text-center">
                  <p className="text-lg font-semibold text-white">
                    Recovery Cancelled
                  </p>
                  <p className="mt-1 text-sm text-gray-400">
                    {completedFiles} of {totalFiles} files were recovered
                  </p>
                </div>
              </>
            ) : (
              <>
                <XCircle className="h-16 w-16 text-red-400" />
                <div className="text-center">
                  <p className="text-lg font-semibold text-white">
                    Recovery Failed
                  </p>
                  <p className="mt-1 text-sm text-gray-400">
                    {completedFiles} of {totalFiles} files were recovered
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Error list for completed state */}
          {errors.length > 0 && (
            <div className="mb-6">
              <h3 className="mb-2 text-sm font-semibold text-red-400">
                Failed Files ({errors.length})
              </h3>
              <div className="max-h-48 overflow-auto rounded-lg border border-red-500/20 bg-red-500/5">
                {errors.map((err, idx) => (
                  <div
                    key={idx}
                    className="flex items-start gap-2 border-b border-red-500/10 px-4 py-2 last:border-b-0"
                  >
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-red-300">
                        {err.fileName || err.fileId}
                      </p>
                      <p className="text-xs text-red-400/70">{err.error}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-center gap-3">
            {destinationPath && status === 'completed' && (
              <button
                onClick={() => {
                  // Electron shell.openPath would be used here via IPC
                  // For now, just navigate back
                }}
                className="flex items-center gap-2 rounded-lg bg-surface-light px-5 py-2.5 text-sm text-gray-300 transition-colors hover:bg-surface-lighter"
              >
                <ExternalLink className="h-4 w-4" />
                Open Folder
              </button>
            )}
            <button
              onClick={() => navigate('/')}
              className="rounded-lg bg-primary-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-500"
            >
              Done
            </button>
          </div>
        </>
      )}
    </div>
  )
}
