/**
 * Carving worker thread - Performs raw byte-level file signature scanning.
 *
 * This worker reads the device in chunks, passes each chunk through the
 * SignatureScanner (Aho-Corasick multi-pattern matcher), and posts found
 * file headers back to the main thread along with progress updates.
 *
 * Communication protocol (parentPort):
 *   Worker -> Main: { type: 'progress', sessionId, data: ScanProgress }
 *   Worker -> Main: { type: 'file-found', sessionId, data: RecoverableFile }
 *   Worker -> Main: { type: 'complete', sessionId }
 *   Worker -> Main: { type: 'error', sessionId, data: { error: string } }
 *   Main -> Worker: { type: 'pause' | 'resume' | 'cancel' }
 *
 * workerData shape:
 *   {
 *     sessionId: string,
 *     devicePath: string,
 *     fileCategories: FileCategory[],
 *     startOffset: string,  // bigint as string
 *     endOffset: string,    // bigint as string (0 = entire device)
 *     scanType: ScanType
 *   }
 */

import { parentPort, workerData } from 'worker_threads'
import * as fs from 'fs'
import { promisify } from 'util'
import { v4 as uuidv4 } from 'uuid'
import { SignatureScanner } from '../../core/carving/signature-scanner'
import {
  FILE_SIGNATURES,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  SECTOR_SIZE
} from '../../shared/constants/file-signatures'
import type {
  FileCategory,
  RecoverableFile,
  ScanProgress
} from '../../shared/types'

const fsOpen = promisify(fs.open)
const fsRead = promisify(fs.read)
const fsFstat = promisify(fs.fstat)
const fsClose = promisify(fs.close)

if (!parentPort) {
  throw new Error('carving.worker.ts must be run as a worker thread')
}

const port = parentPort

// ─── Worker configuration from workerData ───────────────────────

interface CarvingWorkerData {
  sessionId: string
  devicePath: string
  fileCategories: FileCategory[]
  deviceSize: string
  startOffset: string
  endOffset: string
  scanType: string
}

const config = workerData as CarvingWorkerData
const sessionId = config.sessionId

// ─── Control state ──────────────────────────────────────────────

let paused = false
let cancelled = false
let pauseResolve: (() => void) | null = null

port.on('message', (msg: { type: string }) => {
  switch (msg.type) {
    case 'pause':
      paused = true
      break
    case 'resume':
      paused = false
      if (pauseResolve) {
        pauseResolve()
        pauseResolve = null
      }
      break
    case 'cancel':
      cancelled = true
      paused = false
      if (pauseResolve) {
        pauseResolve()
        pauseResolve = null
      }
      break
  }
})

/**
 * Wait while paused. Returns immediately if not paused.
 */
function waitIfPaused(): Promise<void> {
  if (!paused) return Promise.resolve()
  return new Promise<void>((resolve) => {
    pauseResolve = resolve
  })
}

// ─── Scanner setup ──────────────────────────────────────────────

/**
 * Build the signature scanner with patterns for the requested file categories.
 */
function buildScanner(categories: FileCategory[]): SignatureScanner {
  const scanner = new SignatureScanner()
  const categorySet = new Set(categories)

  for (const sig of FILE_SIGNATURES) {
    if (categorySet.has(sig.category)) {
      scanner.addPattern(sig.header, sig.type, sig.headerOffset)
    }
  }

  scanner.build()
  return scanner
}

// ─── Main scan loop ─────────────────────────────────────────────

async function runCarving(): Promise<void> {
  const scanner = buildScanner(config.fileCategories)

  // Open device for reading.
  const fd = await fsOpen(config.devicePath, 'r')

  // On Linux, stat.size is 0 for block devices. Use the size passed from
  // device enumeration (lsblk), falling back to fstat for image files.
  let deviceSize = BigInt(config.deviceSize || '0')
  if (deviceSize === 0n) {
    try {
      const stat = await fsFstat(fd)
      deviceSize = stat.size > 0 ? BigInt(stat.size) : 0n
    } catch {
      deviceSize = 0n
    }
  }

  const startOffset = BigInt(config.startOffset || '0')
  const endOffset =
    config.endOffset && config.endOffset !== '0'
      ? BigInt(config.endOffset)
      : deviceSize

  if (endOffset === 0n) {
    port.postMessage({
      type: 'error',
      sessionId,
      data: { error: 'Cannot determine device size and no endOffset provided' }
    })
    await fsClose(fd)
    return
  }

  const totalBytes = endOffset - startOffset
  let bytesScanned = 0n
  let currentOffset = startOffset
  let sectorsWithErrors = 0
  const startTime = Date.now()

  const readBuffer = Buffer.alloc(CHUNK_SIZE + CHUNK_OVERLAP)

  // Build a lookup from signature type to its metadata for RecoverableFile creation.
  const signatureMap = new Map(FILE_SIGNATURES.map((s) => [s.type, s]))

  // Throttle progress messages to avoid flooding the main thread.
  let lastProgressTime = 0
  const PROGRESS_INTERVAL_MS = 500

  while (currentOffset < endOffset) {
    if (cancelled) break
    await waitIfPaused()
    if (cancelled) break

    // Determine how much to read.
    const remaining = endOffset - currentOffset
    const readLength = Number(
      remaining < BigInt(readBuffer.length)
        ? remaining
        : BigInt(readBuffer.length)
    )

    let bytesRead = 0
    try {
      const result = await fsRead(
        fd,
        readBuffer,
        0,
        readLength,
        Number(currentOffset)
      )
      bytesRead = result.bytesRead
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'EIO') {
        // Bad sector - skip this chunk and log the error.
        sectorsWithErrors += Math.ceil(readLength / SECTOR_SIZE)
        currentOffset += BigInt(CHUNK_SIZE)
        bytesScanned += BigInt(CHUNK_SIZE)
        continue
      }
      throw error
    }

    if (bytesRead === 0) break

    // Scan the buffer for file signatures.
    const matches = scanner.scan(
      readBuffer.subarray(0, bytesRead),
      currentOffset
    )

    for (const match of matches) {
      const sig = signatureMap.get(match.type)
      if (!sig) continue

      const file: RecoverableFile = {
        id: uuidv4(),
        type: sig.type,
        category: sig.category,
        offset: match.offset,
        size: sig.maxSize, // Will be refined by the extractor later
        sizeEstimated: true,
        extension: sig.extension,
        recoverability: 'good',
        source: 'carving'
      }

      port.postMessage({
        type: 'file-found',
        sessionId,
        data: file
      })
    }

    // Advance: move forward by CHUNK_SIZE (not readLength) so the overlap
    // region is re-scanned in the next iteration to catch headers that
    // straddle chunk boundaries.
    const advance = BigInt(CHUNK_SIZE)
    currentOffset += advance
    bytesScanned += advance

    // Emit progress at most every PROGRESS_INTERVAL_MS to avoid flooding IPC.
    const now = Date.now()
    if (now - lastProgressTime >= PROGRESS_INTERVAL_MS) {
      lastProgressTime = now
      const elapsed = now - startTime
      const rate = elapsed > 0 ? Number(bytesScanned) / (elapsed / 1000) : 0
      const remainingBytes = totalBytes - bytesScanned
      const estimatedTimeRemaining =
        rate > 0 ? Math.round(Number(remainingBytes) / rate) : undefined

      const progress: ScanProgress = {
        bytesScanned,
        totalBytes,
        percentage:
          totalBytes > 0n
            ? Math.min(100, Number((bytesScanned * 100n) / totalBytes))
            : 0,
        filesFound: 0, // Updated by ScanManager
        currentSector: currentOffset / BigInt(SECTOR_SIZE),
        estimatedTimeRemaining,
        sectorsWithErrors
      }

      port.postMessage({ type: 'progress', sessionId, data: progress })
    }
  }

  await fsClose(fd)

  // Send a final progress update so the UI reaches 100%.
  const finalProgress: ScanProgress = {
    bytesScanned: cancelled ? bytesScanned : totalBytes,
    totalBytes,
    percentage: cancelled ? Number((bytesScanned * 100n) / (totalBytes || 1n)) : 100,
    filesFound: 0,
    currentSector: currentOffset / BigInt(SECTOR_SIZE),
    sectorsWithErrors
  }
  port.postMessage({ type: 'progress', sessionId, data: finalProgress })
  port.postMessage({ type: 'complete', sessionId })
}

// ─── Entry point ────────────────────────────────────────────────

runCarving().catch((err) => {
  port.postMessage({
    type: 'error',
    sessionId,
    data: { error: err instanceof Error ? err.message : String(err) }
  })
})
