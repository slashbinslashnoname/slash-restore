import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Pause, Play, X, Clock, HardDrive, FileSearch } from 'lucide-react'
import { useScan } from '../hooks/useScan'
import { useAppStore } from '../store'
import ProgressBar from '../components/ProgressBar'

function formatBytes(sizeStr: string): string {
  const bytes = Number(sizeStr)
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return `${m}m ${s}s`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

export default function ScanProgressPage() {
  const navigate = useNavigate()
  const { start, pause, resume, cancel, progress, status, foundFiles, error } =
    useScan()
  const setCurrentStep = useAppStore((s) => s.setCurrentStep)
  const scanStartedAt = useAppStore((s) => s.scanStartedAt)

  const [elapsed, setElapsed] = useState(0)
  const startedRef = useRef(false)

  useEffect(() => {
    setCurrentStep(3)
  }, [setCurrentStep])

  // Start scan on mount (only once)
  useEffect(() => {
    if (!startedRef.current && status === 'idle') {
      startedRef.current = true
      start()
    }
  }, [start, status])

  // Track elapsed time
  useEffect(() => {
    if (
      status !== 'scanning' ||
      !scanStartedAt
    )
      return

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - scanStartedAt) / 1000))
    }, 1000)

    return () => clearInterval(interval)
  }, [status, scanStartedAt])

  // Auto-navigate on complete
  useEffect(() => {
    if (status === 'completed') {
      const timer = setTimeout(() => {
        navigate('/files')
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [status, navigate])

  const percentage = progress?.percentage ?? 0
  const bytesScanned = progress?.bytesScanned ?? '0'
  const totalBytes = progress?.totalBytes ?? '0'
  const filesFound = progress?.filesFound ?? 0
  const estimatedRemaining = progress?.estimatedTimeRemaining
  const errorsCount = progress?.sectorsWithErrors ?? 0

  // Last 10 found files (most recent first)
  const recentFiles = foundFiles.slice(-10).reverse()

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white">
          {status === 'completed'
            ? 'Scan Complete'
            : status === 'cancelled'
              ? 'Scan Cancelled'
              : status === 'error'
                ? 'Scan Error'
                : status === 'paused'
                  ? 'Scan Paused'
                  : 'Scanning...'}
        </h2>
        {status === 'scanning' && (
          <p className="mt-1 text-sm text-gray-400">
            Searching for recoverable files
          </p>
        )}
      </div>

      {/* Progress bar */}
      <div className="mb-8">
        <ProgressBar value={percentage} size="lg" />
      </div>

      {/* Stats grid */}
      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          icon={<HardDrive className="h-5 w-5 text-primary-400" />}
          label="Scanned"
          value={`${formatBytes(bytesScanned)} / ${formatBytes(totalBytes)}`}
        />
        <StatCard
          icon={<FileSearch className="h-5 w-5 text-green-400" />}
          label="Files Found"
          value={String(filesFound)}
        />
        <StatCard
          icon={<Clock className="h-5 w-5 text-amber-400" />}
          label="Elapsed"
          value={formatTime(elapsed)}
        />
        <StatCard
          icon={<Clock className="h-5 w-5 text-gray-400" />}
          label="Remaining"
          value={
            estimatedRemaining != null
              ? formatTime(estimatedRemaining)
              : '--'
          }
        />
      </div>

      {/* Error sector count */}
      {errorsCount > 0 && (
        <div className="mb-6 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm text-amber-300">
          {errorsCount} sector{errorsCount !== 1 ? 's' : ''} with read
          errors encountered
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Recent files feed */}
      <section className="mb-8">
        <h3 className="mb-3 text-sm font-semibold text-gray-300">
          Recently Found
        </h3>
        <div className="max-h-64 overflow-auto rounded-lg border border-surface-lighter bg-surface-light">
          {recentFiles.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-500">
              {status === 'scanning'
                ? 'Waiting for files...'
                : 'No files found'}
            </div>
          ) : (
            <div className="divide-y divide-surface-lighter">
              {recentFiles.map((file) => (
                <div
                  key={file.id}
                  className="animate-fade-in flex items-center gap-3 px-4 py-2.5"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      file.recoverability === 'good'
                        ? 'bg-green-400'
                        : file.recoverability === 'partial'
                          ? 'bg-yellow-400'
                          : 'bg-red-400'
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-300">
                    {file.name ||
                      `${file.id.slice(0, 8)}.${file.extension}`}
                  </span>
                  <span className="shrink-0 font-mono text-xs uppercase text-gray-500">
                    {file.extension}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Controls */}
      <div className="flex items-center justify-center gap-3">
        {(status === 'scanning' || status === 'paused') && (
          <>
            {status === 'scanning' ? (
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
          </>
        )}

        {status === 'completed' && (
          <div className="text-sm text-green-400">
            Redirecting to file selection...
          </div>
        )}

        {(status === 'cancelled' || status === 'error') && (
          <button
            onClick={() => navigate('/')}
            className="rounded-lg bg-surface-light px-5 py-2.5 text-sm text-gray-300 transition-colors hover:bg-surface-lighter"
          >
            Back to Devices
          </button>
        )}
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="rounded-lg border border-surface-lighter bg-surface-light p-4">
      <div className="mb-2">{icon}</div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-gray-200">
        {value}
      </p>
    </div>
  )
}
