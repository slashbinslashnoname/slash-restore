import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, ShieldAlert, ChevronRight } from 'lucide-react'
import { useDevices } from '../hooks/useDevices'
import { useAppStore } from '../store'
import DeviceCard from '../components/DeviceCard'

export default function DeviceSelectionPage() {
  const navigate = useNavigate()
  const { devices, loading, error, refresh } = useDevices()
  const selectedDevice = useAppStore((s) => s.selectedDevice)
  const selectDevice = useAppStore((s) => s.selectDevice)
  const setCurrentStep = useAppStore((s) => s.setCurrentStep)
  const privilege = useAppStore((s) => s.privilege)
  const setPrivilege = useAppStore((s) => s.setPrivilege)
  const addError = useAppStore((s) => s.addError)

  const [elevating, setElevating] = useState(false)

  // Set step on mount
  useEffect(() => {
    setCurrentStep(1)
  }, [setCurrentStep])

  // Check privileges on mount
  useEffect(() => {
    window.api.privilege
      .check()
      .then(setPrivilege)
      .catch(() => {
        /* ignore */
      })
  }, [setPrivilege])

  const handleElevate = async () => {
    setElevating(true)
    try {
      const status = await window.api.privilege.request()
      setPrivilege(status)
      if (status.elevated) {
        refresh()
      }
    } catch (err) {
      addError(
        err instanceof Error
          ? err.message
          : 'Failed to elevate privileges'
      )
    } finally {
      setElevating(false)
    }
  }

  const handleNext = () => {
    if (!selectedDevice) return
    navigate('/scan-config')
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      {/* Page header */}
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white">Select Device</h2>
        <p className="mt-1 text-sm text-gray-400">
          Choose a device to scan for recoverable files
        </p>
      </div>

      {/* Privilege warning */}
      {privilege && !privilege.elevated && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <ShieldAlert className="h-5 w-5 shrink-0 text-amber-400" />
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-300">
              Elevated privileges required
            </p>
            <p className="mt-0.5 text-xs text-amber-400/70">
              Raw device access requires administrator privileges. Some
              devices may not be visible without elevation.
            </p>
          </div>
          <button
            onClick={handleElevate}
            disabled={elevating}
            className="shrink-0 rounded-lg bg-amber-500/20 px-4 py-2 text-sm font-medium text-amber-300 transition-colors hover:bg-amber-500/30 disabled:opacity-50"
          >
            {elevating ? 'Requesting...' : 'Elevate'}
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm text-gray-500">
          {devices.length} device{devices.length !== 1 ? 's' : ''} found
        </span>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg bg-surface-light px-3 py-2 text-sm text-gray-300 transition-colors hover:bg-surface-lighter disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
          />
          Refresh
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && devices.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-16">
          <RefreshCw className="h-8 w-8 animate-spin text-primary-500" />
          <p className="text-sm text-gray-400">Scanning for devices...</p>
        </div>
      )}

      {/* Device list */}
      {!loading && devices.length === 0 && !error && (
        <div className="flex flex-col items-center gap-3 py-16">
          <p className="text-gray-400">No devices found</p>
          <p className="text-xs text-gray-600">
            Connect a storage device and click Refresh
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {devices.map((device) => (
          <DeviceCard
            key={device.id}
            device={device}
            selected={selectedDevice?.id === device.id}
            onClick={() => selectDevice(device)}
          />
        ))}
      </div>

      {/* Footer actions */}
      <div className="mt-8 flex justify-end">
        <button
          onClick={handleNext}
          disabled={!selectedDevice}
          className="flex items-center gap-2 rounded-lg bg-primary-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
