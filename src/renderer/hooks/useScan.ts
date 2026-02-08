import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import type {
  SerializedRecoverableFile,
  SerializedScanProgress
} from '../store'

export function useScan() {
  const scanStatus = useAppStore((s) => s.scanStatus)
  const scanProgress = useAppStore((s) => s.scanProgress)
  const foundFiles = useAppStore((s) => s.foundFiles)
  const scanError = useAppStore((s) => s.scanError)
  const selectedDevice = useAppStore((s) => s.selectedDevice)
  const scanType = useAppStore((s) => s.scanType)
  const fileCategories = useAppStore((s) => s.fileCategories)
  const selectedFileTypes = useAppStore((s) => s.selectedFileTypes)
  const selectedPartition = useAppStore((s) => s.selectedPartition)
  const scanSessionId = useAppStore((s) => s.scanSessionId)

  const setScanStatus = useAppStore((s) => s.setScanStatus)
  const updateScanProgress = useAppStore((s) => s.updateScanProgress)
  const addFoundFiles = useAppStore((s) => s.addFoundFiles)
  const setScanSessionId = useAppStore((s) => s.setScanSessionId)
  const setScanStartedAt = useAppStore((s) => s.setScanStartedAt)
  const setScanError = useAppStore((s) => s.setScanError)

  const cleanupRef = useRef<(() => void)[]>([])

  // Set up IPC event listeners
  useEffect(() => {
    const unsubProgress = window.api.scan.onProgress(
      (progress: unknown) => {
        updateScanProgress(progress as SerializedScanProgress)
      }
    )

    const unsubFileFound = window.api.scan.onFileFound(
      (data: unknown) => {
        // Main process sends batched arrays of files
        const files = Array.isArray(data)
          ? (data as SerializedRecoverableFile[])
          : [data as SerializedRecoverableFile]
        addFoundFiles(files)
      }
    )

    const unsubComplete = window.api.scan.onComplete(
      (result: unknown) => {
        const res = result as { sessionId: string; filesFound: number }
        setScanSessionId(res.sessionId)
        setScanStatus('completed')
      }
    )

    const unsubError = window.api.scan.onError((error: unknown) => {
      const err = error as { message?: string; sessionId?: string }
      setScanError(err.message || (typeof error === 'string' ? error : 'Scan failed with an unknown error'))
      setScanStatus('error')
    })

    cleanupRef.current = [
      unsubProgress,
      unsubFileFound,
      unsubComplete,
      unsubError
    ]

    return () => {
      cleanupRef.current.forEach((unsub) => unsub())
      cleanupRef.current = []
    }
  }, [
    updateScanProgress,
    addFoundFiles,
    setScanSessionId,
    setScanStatus,
    setScanError
  ])

  const start = useCallback(async () => {
    if (!selectedDevice) return

    const config = {
      devicePath: selectedDevice.path,
      partitionPath: selectedPartition?.path,
      scanType,
      fileCategories,
      fileTypes: selectedFileTypes,
      deviceSize: selectedPartition?.size ?? selectedDevice.size
    }

    try {
      setScanStatus('scanning')
      setScanStartedAt(Date.now())
      setScanError(null)
      const result = await window.api.scan.start(config)
      setScanSessionId(result.sessionId)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to start scan'
      setScanError(message)
      setScanStatus('error')
    }
  }, [
    selectedDevice,
    selectedPartition,
    scanType,
    fileCategories,
    selectedFileTypes,
    setScanStatus,
    setScanStartedAt,
    setScanError,
    setScanSessionId
  ])

  const pause = useCallback(async () => {
    if (!scanSessionId) return
    try {
      await window.api.scan.pause(scanSessionId)
      setScanStatus('paused')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to pause scan'
      setScanError(message)
    }
  }, [scanSessionId, setScanStatus, setScanError])

  const resume = useCallback(async () => {
    if (!scanSessionId) return
    try {
      await window.api.scan.resume(scanSessionId)
      setScanStatus('scanning')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to resume scan'
      setScanError(message)
    }
  }, [scanSessionId, setScanStatus, setScanError])

  const cancel = useCallback(async () => {
    if (!scanSessionId) return
    try {
      await window.api.scan.cancel(scanSessionId)
      setScanStatus('cancelled')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to cancel scan'
      setScanError(message)
    }
  }, [scanSessionId, setScanStatus, setScanError])

  return {
    start,
    pause,
    resume,
    cancel,
    progress: scanProgress,
    status: scanStatus,
    foundFiles,
    error: scanError
  }
}
