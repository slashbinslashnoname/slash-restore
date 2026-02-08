import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../store'
import type { SerializedDeviceInfo } from '../store'

declare global {
  interface Window {
    api: {
      devices: {
        list(): Promise<SerializedDeviceInfo[]>
        refresh(): Promise<SerializedDeviceInfo[]>
      }
      scan: {
        start(config: unknown): Promise<{ sessionId: string }>
        pause(sessionId: string): Promise<void>
        resume(sessionId: string): Promise<void>
        cancel(sessionId: string): Promise<void>
        onProgress(cb: (progress: unknown) => void): () => void
        onFileFound(cb: (file: unknown) => void): () => void
        onComplete(cb: (result: unknown) => void): () => void
        onError(cb: (error: unknown) => void): () => void
      }
      recovery: {
        start(config: unknown): Promise<void>
        pause(): Promise<void>
        resume(): Promise<void>
        cancel(): Promise<void>
        onProgress(cb: (progress: unknown) => void): () => void
        onComplete(cb: (result: unknown) => void): () => void
        onError(cb: (error: unknown) => void): () => void
      }
      privilege: {
        check(): Promise<{
          elevated: boolean
          platform: 'linux' | 'darwin' | 'win32'
          helperPid?: number
        }>
        request(): Promise<{
          elevated: boolean
          platform: 'linux' | 'darwin' | 'win32'
          helperPid?: number
        }>
      }
      preview: {
        generate(
          fileId: string,
          offset: string,
          size: string
        ): Promise<string | null>
        hex(offset: string, length: number): Promise<string>
      }
      dialog: {
        selectDirectory(): Promise<string | null>
      }
    }
  }
}

export function useDevices() {
  const setDevices = useAppStore((s) => s.setDevices)
  const setDevicesLoading = useAppStore((s) => s.setDevicesLoading)
  const devices = useAppStore((s) => s.devices)
  const devicesLoading = useAppStore((s) => s.devicesLoading)
  const [error, setError] = useState<string | null>(null)

  const fetchDevices = useCallback(async () => {
    setDevicesLoading(true)
    setError(null)
    try {
      const result = await window.api.devices.list()
      setDevices(result)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to list devices'
      setError(message)
    } finally {
      setDevicesLoading(false)
    }
  }, [setDevices, setDevicesLoading])

  const refresh = useCallback(async () => {
    setDevicesLoading(true)
    setError(null)
    try {
      const result = await window.api.devices.refresh()
      setDevices(result)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to refresh devices'
      setError(message)
    } finally {
      setDevicesLoading(false)
    }
  }, [setDevices, setDevicesLoading])

  useEffect(() => {
    fetchDevices()
  }, [fetchDevices])

  return { devices, loading: devicesLoading, error, refresh }
}
