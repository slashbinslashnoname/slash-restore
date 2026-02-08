import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import type { SerializedRecoveryProgress } from '../store'
import type { RecoveryError } from '../../shared/types'

export function useRecovery() {
  const recoveryStatus = useAppStore((s) => s.recoveryStatus)
  const recoveryProgress = useAppStore((s) => s.recoveryProgress)
  const recoveryErrors = useAppStore((s) => s.recoveryErrors)
  const selectedDevice = useAppStore((s) => s.selectedDevice)
  const foundFiles = useAppStore((s) => s.foundFiles)
  const selectedFileIds = useAppStore((s) => s.selectedFileIds)
  const destinationPath = useAppStore((s) => s.destinationPath)
  const conflictStrategy = useAppStore((s) => s.conflictStrategy)
  const preserveStructure = useAppStore((s) => s.preserveStructure)

  const setRecoveryStatus = useAppStore((s) => s.setRecoveryStatus)
  const updateRecoveryProgress = useAppStore((s) => s.updateRecoveryProgress)
  const addRecoveryError = useAppStore((s) => s.addRecoveryError)

  const cleanupRef = useRef<(() => void)[]>([])

  // Set up IPC event listeners
  useEffect(() => {
    const unsubProgress = window.api.recovery.onProgress(
      (progress: unknown) => {
        updateRecoveryProgress(progress as SerializedRecoveryProgress)
      }
    )

    const unsubComplete = window.api.recovery.onComplete(() => {
      setRecoveryStatus('completed')
    })

    const unsubError = window.api.recovery.onError((error: unknown) => {
      const err = error as RecoveryError | { message?: string }
      if ('fileId' in err) {
        addRecoveryError(err as RecoveryError)
      } else {
        setRecoveryStatus('error')
      }
    })

    cleanupRef.current = [unsubProgress, unsubComplete, unsubError]

    return () => {
      cleanupRef.current.forEach((unsub) => unsub())
      cleanupRef.current = []
    }
  }, [updateRecoveryProgress, setRecoveryStatus, addRecoveryError])

  const start = useCallback(async () => {
    if (!selectedDevice || !destinationPath) return

    const filesToRecover = foundFiles.filter((f) =>
      selectedFileIds.has(f.id)
    )

    const config = {
      files: filesToRecover,
      destinationPath,
      conflictStrategy,
      preserveStructure,
      sourceDevicePath: selectedDevice.path
    }

    try {
      setRecoveryStatus('recovering')
      await window.api.recovery.start(config)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to start recovery'
      addRecoveryError({
        fileId: '',
        fileName: '',
        error: message
      })
      setRecoveryStatus('error')
    }
  }, [
    selectedDevice,
    foundFiles,
    selectedFileIds,
    destinationPath,
    conflictStrategy,
    preserveStructure,
    setRecoveryStatus,
    addRecoveryError
  ])

  const pause = useCallback(async () => {
    try {
      await window.api.recovery.pause()
      setRecoveryStatus('paused')
    } catch {
      /* ignore */
    }
  }, [setRecoveryStatus])

  const resume = useCallback(async () => {
    try {
      await window.api.recovery.resume()
      setRecoveryStatus('recovering')
    } catch {
      /* ignore */
    }
  }, [setRecoveryStatus])

  const cancel = useCallback(async () => {
    try {
      await window.api.recovery.cancel()
      setRecoveryStatus('cancelled')
    } catch {
      /* ignore */
    }
  }, [setRecoveryStatus])

  return {
    start,
    pause,
    resume,
    cancel,
    progress: recoveryProgress,
    status: recoveryStatus,
    errors: recoveryErrors
  }
}
