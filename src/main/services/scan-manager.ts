/**
 * ScanManager - Orchestrates data recovery scan sessions.
 *
 * Creates and manages worker threads for two types of scanning:
 * 1. File carving: raw byte-level signature scanning (carving worker)
 * 2. Metadata parsing: filesystem-level file enumeration (metadata worker)
 *
 * Each scan session is identified by a UUID and tracks its lifecycle
 * (start, pause, resume, cancel) along with aggregated results. Events
 * are emitted for the IPC layer to forward to the renderer process.
 */

import { Worker } from 'worker_threads'
import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import * as path from 'path'
import type {
  ScanConfig,
  ScanSession,
  ScanStatus,
  ScanProgress,
  RecoverableFile
} from '../../shared/types'
import type { PrivilegeManager } from './privilege'

/** Messages sent from worker threads to the main thread. */
export interface WorkerMessage {
  type: 'progress' | 'file-found' | 'files-batch' | 'complete' | 'error'
  sessionId: string
  data?: ScanProgress | RecoverableFile | RecoverableFile[] | { error: string }
}

/** Messages sent from the main thread to worker threads. */
export interface WorkerControl {
  type: 'pause' | 'resume' | 'cancel'
}

/**
 * Events emitted by ScanManager.
 *
 * These mirror the IPC channel payloads so the IPC handler can forward
 * them directly to the renderer process.
 */
export interface ScanManagerEvents {
  progress: (sessionId: string, progress: ScanProgress) => void
  'file-found': (sessionId: string, file: RecoverableFile) => void
  complete: (sessionId: string, filesFound: number) => void
  error: (sessionId: string, error: string) => void
}

/**
 * Maximum number of RecoverableFile objects kept in-memory per session.
 * Results are streamed to the renderer via IPC as they arrive, so the
 * main-thread array is only used for post-scan access. Once the cap is
 * reached, new files are still deduplicated, counted, and emitted to
 * the renderer, but not stored in the array.
 */
const MAX_FILES_IN_MEMORY = 50_000

export class ScanManager extends EventEmitter {
  private sessions = new Map<string, ScanSession>()
  private workers = new Map<string, Worker[]>()
  /** Track how many workers per session have sent 'complete'. */
  private completedWorkers = new Map<string, number>()
  /** O(1) deduplication: "offset:type" keys per session. */
  private seenFiles = new Map<string, Set<string>>()
  /** Accurate file count even when foundFiles is capped. */
  private fileCounts = new Map<string, number>()
  private privilegeManager: PrivilegeManager | null = null

  setPrivilegeManager(pm: PrivilegeManager): void {
    this.privilegeManager = pm
  }

  /**
   * Start a new scan session.
   *
   * Spawns one or two worker threads depending on the scan type:
   * - quick scan: metadata worker only (filesystem-level enumeration)
   * - deep scan: both carving and metadata workers
   *
   * @param config - Scan configuration specifying device, type, and file categories.
   * @returns The session ID (UUID) for tracking this scan.
   */
  async start(config: ScanConfig): Promise<string> {
    const sessionId = uuidv4()
    const now = Date.now()

    const session: ScanSession = {
      id: sessionId,
      config,
      status: 'scanning',
      progress: {
        bytesScanned: 0n,
        totalBytes: config.endOffset ?? config.deviceSize ?? 0n,
        percentage: 0,
        filesFound: 0,
        currentSector: config.startOffset ?? 0n,
        sectorsWithErrors: 0
      },
      foundFiles: [],
      startedAt: now
    }

    this.sessions.set(sessionId, session)
    this.seenFiles.set(sessionId, new Set())
    this.fileCounts.set(sessionId, 0)

    const sessionWorkers: Worker[] = []

    try {
      // Ensure we have read access to the device
      const devicePath = config.partitionPath ?? config.devicePath
      console.log('[scan] Starting scan on', devicePath, 'size:', config.deviceSize?.toString(), 'type:', config.scanType)
      if (this.privilegeManager) {
        const granted = await this.privilegeManager.grantDeviceAccess(devicePath)
        if (!granted) {
          throw new Error(`Cannot obtain read access to ${devicePath}. Please elevate privileges.`)
        }
      }

      if (config.scanType === 'deep') {
        // Deep scan: carving only (signature-based, works on any filesystem)
        const carvingWorker = this.spawnCarvingWorker(sessionId, config)
        sessionWorkers.push(carvingWorker)
      } else {
        // Quick scan: metadata first, then carving as fallback
        const metadataWorker = this.spawnMetadataWorker(sessionId, config)
        sessionWorkers.push(metadataWorker)
        // Also run carving so the user gets results even on unsupported filesystems
        const carvingWorker = this.spawnCarvingWorker(sessionId, config)
        sessionWorkers.push(carvingWorker)
      }

      this.workers.set(sessionId, sessionWorkers)
    } catch (err) {
      session.status = 'error'
      session.error =
        err instanceof Error ? err.message : 'Failed to start scan workers'
      this.emit('error', sessionId, session.error)
    }

    return sessionId
  }

  /**
   * Pause a running scan session.
   */
  pause(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.status !== 'scanning') return

    session.status = 'paused'
    this.sendControlMessage(sessionId, { type: 'pause' })
  }

  /**
   * Resume a paused scan session.
   */
  resume(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.status !== 'paused') return

    session.status = 'scanning'
    this.sendControlMessage(sessionId, { type: 'resume' })
  }

  /**
   * Cancel a scan session.
   *
   * Sends cancel to workers and terminates them. The session status
   * is set to 'cancelled'.
   */
  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.status === 'completed' || session.status === 'cancelled') return

    session.status = 'cancelled'
    session.completedAt = Date.now()

    this.sendControlMessage(sessionId, { type: 'cancel' })
    this.terminateWorkers(sessionId)

    const fileCount = this.fileCounts.get(sessionId) ?? session.foundFiles.length
    this.emit('complete', sessionId, fileCount)
  }

  /**
   * Get a scan session by its ID.
   */
  getSession(sessionId: string): ScanSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Get all active scan sessions.
   */
  getActiveSessions(): ScanSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === 'scanning' || s.status === 'paused'
    )
  }

  /**
   * Clean up all sessions and workers. Call during shutdown.
   */
  async dispose(): Promise<void> {
    for (const sessionId of this.workers.keys()) {
      this.terminateWorkers(sessionId)
    }
    this.sessions.clear()
    this.workers.clear()
    this.seenFiles.clear()
    this.fileCounts.clear()
    this.removeAllListeners()
  }

  // ─── Private ──────────────────────────────────────────────────

  private spawnCarvingWorker(sessionId: string, config: ScanConfig): Worker {
    const workerPath = path.resolve(__dirname, 'workers/carving.worker.js')

    const worker = new Worker(workerPath, {
      workerData: {
        sessionId,
        devicePath: config.partitionPath ?? config.devicePath,
        fileCategories: config.fileCategories,
        fileTypes: config.fileTypes,
        deviceSize: (config.deviceSize ?? config.endOffset ?? 0n).toString(),
        startOffset: config.startOffset?.toString() ?? '0',
        endOffset: config.endOffset?.toString() ?? '0',
        scanType: config.scanType
      }
    })

    this.attachWorkerListeners(worker, sessionId, 'carving')
    return worker
  }

  private spawnMetadataWorker(sessionId: string, config: ScanConfig): Worker {
    const workerPath = path.resolve(__dirname, 'workers/metadata.worker.js')

    const worker = new Worker(workerPath, {
      workerData: {
        sessionId,
        devicePath: config.partitionPath ?? config.devicePath,
        fileCategories: config.fileCategories,
        fileTypes: config.fileTypes,
        deviceSize: (config.deviceSize ?? 0n).toString(),
        filesystemType: undefined,
        // For quick scan on whole device, try each partition
        scanPartitions: !config.partitionPath
      }
    })

    this.attachWorkerListeners(worker, sessionId, 'metadata')
    return worker
  }

  private attachWorkerListeners(
    worker: Worker,
    sessionId: string,
    workerType: 'carving' | 'metadata'
  ): void {
    worker.on('message', (msg: WorkerMessage) => {
      this.handleWorkerMessage(sessionId, msg)
    })

    worker.on('error', (err) => {
      console.error(`[scan] ${workerType} worker error:`, err.message)
      const session = this.sessions.get(sessionId)
      if (session) {
        const errorMsg = `${workerType} worker error: ${err.message}`
        session.error = errorMsg
        this.emit('error', sessionId, errorMsg)
      }
    })

    worker.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[scan] ${workerType} worker exited with code`, code)
      }
      this.handleWorkerExit(sessionId, workerType, code)
    })
  }

  private handleWorkerMessage(sessionId: string, msg: WorkerMessage): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    switch (msg.type) {
      case 'progress': {
        const progress = msg.data as ScanProgress
        // Merge progress: take the maximum values across workers.
        session.progress = {
          bytesScanned:
            progress.bytesScanned > session.progress.bytesScanned
              ? progress.bytesScanned
              : session.progress.bytesScanned,
          totalBytes: progress.totalBytes || session.progress.totalBytes,
          percentage: Math.max(progress.percentage, session.progress.percentage),
          filesFound: session.foundFiles.length,
          currentSector: progress.currentSector,
          estimatedTimeRemaining: progress.estimatedTimeRemaining,
          sectorsWithErrors:
            session.progress.sectorsWithErrors + (progress.sectorsWithErrors ?? 0)
        }
        this.emit('progress', sessionId, session.progress)
        break
      }

      case 'file-found': {
        const file = msg.data as RecoverableFile
        const seen = this.seenFiles.get(sessionId)!
        const key = `${file.offset}:${file.type}`
        if (!seen.has(key)) {
          seen.add(key)
          const count = (this.fileCounts.get(sessionId) ?? 0) + 1
          this.fileCounts.set(sessionId, count)
          if (session.foundFiles.length < MAX_FILES_IN_MEMORY) {
            session.foundFiles.push(file)
          }
          session.progress.filesFound = count
          this.emit('file-found', sessionId, file)
        }
        break
      }

      case 'files-batch': {
        const files = msg.data as RecoverableFile[]
        const seen = this.seenFiles.get(sessionId)!
        let count = this.fileCounts.get(sessionId) ?? 0
        for (const file of files) {
          const key = `${file.offset}:${file.type}`
          if (!seen.has(key)) {
            seen.add(key)
            count++
            if (session.foundFiles.length < MAX_FILES_IN_MEMORY) {
              session.foundFiles.push(file)
            }
            this.emit('file-found', sessionId, file)
          }
        }
        this.fileCounts.set(sessionId, count)
        session.progress.filesFound = count
        break
      }

      case 'complete': {
        // Track worker completion. When all workers for a session finish,
        // mark the session as completed.
        const wCount = (this.completedWorkers.get(sessionId) ?? 0) + 1
        this.completedWorkers.set(sessionId, wCount)

        const totalWorkers = this.workers.get(sessionId)?.length ?? 1
        if (wCount >= totalWorkers && session.status === 'scanning') {
          session.status = 'completed'
          session.completedAt = Date.now()
          session.progress.percentage = 100
          const fileCount = this.fileCounts.get(sessionId) ?? session.foundFiles.length
          console.log(`[scan] All workers complete. Found ${fileCount} files.`)
          this.emit('complete', sessionId, fileCount)
          this.terminateWorkers(sessionId)
        }
        break
      }

      case 'error': {
        const errorData = msg.data as { error: string }
        session.error = errorData.error
        this.emit('error', sessionId, errorData.error)
        break
      }
    }
  }

  private handleWorkerExit(
    sessionId: string,
    _workerType: string,
    _code: number
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const sessionWorkers = this.workers.get(sessionId)
    if (!sessionWorkers) return

    // Check if all workers for this session have exited.
    const allExited = sessionWorkers.every((w) => {
      try {
        // threadId is 0 after the worker has exited.
        return w.threadId === 0
      } catch {
        return true
      }
    })

    if (allExited && session.status === 'scanning') {
      session.status = 'completed'
      session.completedAt = Date.now()
      session.progress.percentage = 100
      this.emit('complete', sessionId, session.foundFiles.length)
    }
  }

  private sendControlMessage(sessionId: string, msg: WorkerControl): void {
    const sessionWorkers = this.workers.get(sessionId)
    if (!sessionWorkers) return

    for (const worker of sessionWorkers) {
      try {
        worker.postMessage(msg)
      } catch {
        // Worker may have already exited.
      }
    }
  }

  private terminateWorkers(sessionId: string): void {
    const sessionWorkers = this.workers.get(sessionId)
    if (!sessionWorkers) return

    for (const worker of sessionWorkers) {
      try {
        worker.terminate()
      } catch {
        // Worker may have already exited.
      }
    }

    this.workers.delete(sessionId)
  }
}
