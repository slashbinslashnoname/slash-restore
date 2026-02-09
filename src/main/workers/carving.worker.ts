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
import type { FileSignature } from '../../shared/constants/file-signatures'

/** Safety limit: if a single chunk produces more matches than this, the
 *  remaining matches are dropped. This prevents pathologically broad
 *  signatures (e.g. short byte sequences common in zeroed regions) from
 *  causing unbounded memory growth. */
const MAX_MATCHES_PER_CHUNK = 1000
import type {
  FileCategory,
  FileType,
  RecoverableFile,
  ScanProgress
} from '../../shared/types'
import {
  loadAllocationBitmap
} from '../../core/filesystem/allocation-bitmap'
import type { AllocationBitmap } from '../../core/filesystem/allocation-bitmap'

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
  fileTypes?: FileType[]
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

// ─── File size detection ─────────────────────────────────────────

/** Max forward scan for footer search (100 MB). */
const MAX_FOOTER_SCAN = 100 * 1024 * 1024
/** Read chunk size for footer scanning (256 KB). */
const FOOTER_SCAN_CHUNK = 256 * 1024

/** File types using ISO BMFF box structure (ftyp-based containers). */
const ISO_BMFF_TYPES = new Set(['mp4', 'mov', 'heic', 'm4a'])
/** File types using RIFF container with size at offset 4. */
const RIFF_TYPES = new Set(['avi', 'wav', 'webp'])
/** XZ stream footer magic (last 2 bytes of every XZ stream). */
const XZ_FOOTER_MAGIC = Buffer.from([0x59, 0x5a])
/** 7z Start Header is 32 bytes; NextHeaderOffset at 12, NextHeaderSize at 20. */
const SEVENZ_HEADER_SIZE = 32

/**
 * Search forward from `startOffset` for a footer byte sequence.
 * Uses the data already in `existingBuf` first, then reads additional
 * chunks from disk if needed.
 *
 * Returns the file size (footer end - fileStart) or null if not found.
 */
async function searchFooter(
  fd: number,
  fileStart: bigint,
  footer: Buffer,
  maxSize: bigint,
  existingBuf: Buffer,
  bufBaseOffset: bigint
): Promise<bigint | null> {
  const limit = fileStart + (maxSize < BigInt(MAX_FOOTER_SCAN) ? maxSize : BigInt(MAX_FOOTER_SCAN))

  // How much of the existing buffer is usable after the file start?
  const bufStart = Number(fileStart - bufBaseOffset)
  if (bufStart >= 0 && bufStart < existingBuf.length) {
    const idx = existingBuf.indexOf(footer, bufStart + 1)
    if (idx !== -1) {
      const fileEnd = bufBaseOffset + BigInt(idx) + BigInt(footer.length)
      return fileEnd - fileStart
    }
  }

  // Need to read beyond the current buffer
  const scanStart = bufBaseOffset + BigInt(existingBuf.length)
  const scanBuf = Buffer.alloc(FOOTER_SCAN_CHUNK + footer.length - 1)

  for (let offset = scanStart; offset < limit; offset += BigInt(FOOTER_SCAN_CHUNK)) {
    const readLen = Math.min(FOOTER_SCAN_CHUNK + footer.length - 1, Number(limit - offset))
    if (readLen < footer.length) break

    try {
      const r = await fsRead(fd, scanBuf, 0, readLen, Number(offset))
      if (r.bytesRead < footer.length) break

      const idx = scanBuf.subarray(0, r.bytesRead).indexOf(footer)
      if (idx !== -1) {
        const fileEnd = offset + BigInt(idx) + BigInt(footer.length)
        return fileEnd - fileStart
      }
    } catch {
      break
    }
  }

  return null
}

/**
 * Read RIFF container size from the file header.
 * RIFF layout: bytes 0-3 = "RIFF", bytes 4-7 = LE32 payload size.
 * Total file size = payload size + 8.
 *
 * Returns null only if the header is unreadable or not RIFF.
 * 0xFFFFFFFF payload (RF64) or 0 (streaming) → null to allow fallback.
 */
async function detectRiffSize(fd: number, fileStart: bigint): Promise<bigint | null> {
  const buf = Buffer.alloc(12)
  try {
    const r = await fsRead(fd, buf, 0, 12, Number(fileStart))
    if (r.bytesRead < 8) return null
  } catch {
    return null
  }

  // Verify RIFF magic
  if (buf.readUInt32BE(0) !== 0x52494646) return null // "RIFF"

  const payloadSize = buf.readUInt32LE(4)

  // 0 = streaming/unknown, 0xFFFFFFFF = RF64 extended size → can't determine
  if (payloadSize === 0 || payloadSize === 0xffffffff) return null

  return BigInt(payloadSize) + 8n
}

/**
 * Parse ISO Base Media File Format (BMFF) top-level boxes to find total file size.
 * Used for MP4, MOV, HEIC, M4A.
 * Box structure: 4 bytes BE size + 4 bytes type. If size == 1, 8 bytes extended size follows.
 */
async function detectIsoBmffSize(fd: number, fileStart: bigint): Promise<bigint | null> {
  const headerBuf = Buffer.alloc(16)
  let pos = fileStart
  let lastValidEnd = fileStart
  const maxScan = fileStart + BigInt(MAX_FOOTER_SCAN)

  while (pos < maxScan) {
    try {
      const r = await fsRead(fd, headerBuf, 0, 16, Number(pos))
      if (r.bytesRead < 8) break
    } catch {
      break
    }

    let boxSize = BigInt(headerBuf.readUInt32BE(0))
    const boxType = headerBuf.subarray(4, 8).toString('ascii')

    // Validate box type: should be printable ASCII
    if (!/^[a-zA-Z0-9 ]{4}$/.test(boxType)) break

    if (boxSize === 1n) {
      // Extended size (64-bit) at bytes 8-15
      const high = BigInt(headerBuf.readUInt32BE(8))
      const low = BigInt(headerBuf.readUInt32BE(12))
      boxSize = (high << 32n) | low
      if (boxSize < 16n) break
    } else if (boxSize === 0n) {
      // Box extends to end of file — we can't determine size this way
      break
    } else if (boxSize < 8n) {
      break
    }

    pos += boxSize
    lastValidEnd = pos
  }

  const totalSize = lastValidEnd - fileStart
  return totalSize > 0n ? totalSize : null
}

/**
 * Detect 7z archive size from the Start Header.
 * Bytes 12-19: NextHeaderOffset (LE64), 20-27: NextHeaderSize (LE64).
 * Total = 32 + NextHeaderOffset + NextHeaderSize.
 */
async function detect7zSize(fd: number, fileStart: bigint): Promise<bigint | null> {
  const buf = Buffer.alloc(SEVENZ_HEADER_SIZE)
  try {
    const r = await fsRead(fd, buf, 0, SEVENZ_HEADER_SIZE, Number(fileStart))
    if (r.bytesRead < SEVENZ_HEADER_SIZE) return null
  } catch {
    return null
  }

  const nextHeaderOffLo = buf.readUInt32LE(12)
  const nextHeaderOffHi = buf.readUInt32LE(16)
  const nextHeaderSizeLo = buf.readUInt32LE(20)
  const nextHeaderSizeHi = buf.readUInt32LE(24)

  const nextHeaderOffset = (BigInt(nextHeaderOffHi) << 32n) | BigInt(nextHeaderOffLo)
  const nextHeaderSize = (BigInt(nextHeaderSizeHi) << 32n) | BigInt(nextHeaderSizeLo)

  if (nextHeaderOffset === 0n && nextHeaderSize === 0n) return null

  const total = BigInt(SEVENZ_HEADER_SIZE) + nextHeaderOffset + nextHeaderSize
  // Sanity: reject implausible sizes (> 100 GB)
  if (total > 100n * 1024n * 1024n * 1024n) return null

  return total
}

/**
 * Detect the actual file size for a matched signature.
 *
 * Strategy by format:
 * - RIFF (AVI, WAV, WebP): read 4-byte LE size at offset 4
 * - ISO BMFF (MP4, MOV, HEIC, M4A): iterate top-level boxes
 * - 7z: read NextHeaderOffset + NextHeaderSize from Start Header
 * - XZ: scan for footer magic 0x59 0x5A
 * - Footer-based (JPEG, PNG, PDF, GIF): scan forward for footer bytes
 * - Fallback: use sig.maxSize (estimated)
 */
async function detectFileSize(
  fd: number,
  fileStart: bigint,
  sig: FileSignature,
  existingBuf: Buffer,
  bufBaseOffset: bigint
): Promise<{ size: bigint; estimated: boolean }> {
  // RIFF containers — authoritative size from header
  if (RIFF_TYPES.has(sig.type)) {
    const size = await detectRiffSize(fd, fileStart)
    if (size && size >= sig.minSize) {
      return { size, estimated: false }
    }
  }

  // ISO BMFF containers — authoritative size from box structure
  if (ISO_BMFF_TYPES.has(sig.type)) {
    const size = await detectIsoBmffSize(fd, fileStart)
    if (size && size >= sig.minSize) {
      return { size, estimated: false }
    }
  }

  // 7z archives — exact size from Start Header
  if (sig.type === '7z') {
    const size = await detect7zSize(fd, fileStart)
    if (size && size >= sig.minSize) {
      return { size, estimated: false }
    }
  }

  // XZ streams — search for footer magic 0x59 0x5A
  if (sig.type === 'xz') {
    const size = await searchFooter(fd, fileStart, XZ_FOOTER_MAGIC, sig.maxSize, existingBuf, bufBaseOffset)
    if (size && size >= sig.minSize) {
      return { size, estimated: false }
    }
  }

  // Footer-based formats — scan forward for end marker
  if (sig.footer) {
    const size = await searchFooter(fd, fileStart, sig.footer, sig.maxSize, existingBuf, bufBaseOffset)
    if (size && size >= sig.minSize) {
      return { size, estimated: false }
    }
  }

  // Fallback to maxSize
  return { size: sig.maxSize, estimated: true }
}

// ─── Scanner setup ──────────────────────────────────────────────

/**
 * Build the signature scanner with patterns for the requested file types
 * (or file categories as fallback).
 */
function buildScanner(categories: FileCategory[], fileTypes?: FileType[]): SignatureScanner {
  const scanner = new SignatureScanner()

  if (fileTypes && fileTypes.length > 0) {
    const typeSet = new Set(fileTypes)
    for (const sig of FILE_SIGNATURES) {
      if (typeSet.has(sig.type)) {
        scanner.addPattern(sig.header, sig.type, sig.headerOffset)
      }
    }
  } else {
    const categorySet = new Set(categories)
    for (const sig of FILE_SIGNATURES) {
      if (categorySet.has(sig.category)) {
        scanner.addPattern(sig.header, sig.type, sig.headerOffset)
      }
    }
  }

  scanner.build()
  return scanner
}

// ─── Main scan loop ─────────────────────────────────────────────

async function runCarving(): Promise<void> {
  const scanner = buildScanner(config.fileCategories, config.fileTypes)

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

  // Try to load the filesystem allocation bitmap for filtering allocated blocks.
  // Supports ext4, NTFS, and FAT32. Returns null for unsupported/unrecognized
  // filesystems — in that case all bitmap guards are skipped.
  let allocationBitmap: AllocationBitmap | null = null
  try {
    allocationBitmap = await loadAllocationBitmap(fd)
    if (allocationBitmap) {
      console.log(
        `[carving] Loaded ${allocationBitmap.fsType} allocation bitmap: ` +
        `${allocationBitmap.totalBlocks} blocks, blockSize=${allocationBitmap.blockSize}`
      )
    }
  } catch {
    // Non-fatal: fall back to scanning everything
    allocationBitmap = null
  }

  const totalBytes = endOffset - startOffset
  let bytesScanned = 0n
  let currentOffset = startOffset
  let sectorsWithErrors = 0
  const startTime = Date.now()

  const readBuffer = Buffer.alloc(CHUNK_SIZE + CHUNK_OVERLAP)

  // Build a lookup from signature type to its metadata for RecoverableFile creation.
  // For types with multiple signatures (e.g. JPEG has 4 variants), keep the one
  // with the largest maxSize so size detection uses the most permissive bounds.
  const signatureMap = new Map<string, (typeof FILE_SIGNATURES)[number]>()
  for (const s of FILE_SIGNATURES) {
    const existing = signatureMap.get(s.type)
    if (!existing || s.maxSize > existing.maxSize) {
      signatureMap.set(s.type, s)
    }
  }

  // Throttle progress messages to avoid flooding the main thread.
  let lastProgressTime = 0
  const PROGRESS_INTERVAL_MS = 500

  while (currentOffset < endOffset) {
    if (cancelled) break
    await waitIfPaused()
    if (cancelled) break

    // Skip chunks where every block is allocated (no deleted data possible).
    if (allocationBitmap && allocationBitmap.isChunkFullyAllocated(currentOffset, CHUNK_SIZE)) {
      currentOffset += BigInt(CHUNK_SIZE)
      bytesScanned += BigInt(CHUNK_SIZE)
      continue
    }

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

    // Scan the buffer for file signatures. The scanner stops early if
    // MAX_MATCHES_PER_CHUNK is reached, preventing allocation spikes from
    // overly broad signatures hitting zeroed/repetitive regions.
    const matches = scanner.scan(
      readBuffer.subarray(0, bytesRead),
      currentOffset,
      MAX_MATCHES_PER_CHUNK
    )

    // Filter out matches that land in allocated blocks (still-live files).
    const filteredMatches = allocationBitmap
      ? matches.filter((m) => !allocationBitmap!.isByteAllocated(m.offset))
      : matches

    if (filteredMatches.length > 0) {
      const batch: RecoverableFile[] = []
      for (const match of filteredMatches) {
        const sig = signatureMap.get(match.type)
        if (!sig) continue

        // Detect actual file size instead of using maxSize blindly.
        const { size, estimated } = await detectFileSize(
          fd,
          match.offset,
          sig,
          readBuffer.subarray(0, bytesRead),
          currentOffset
        )

        batch.push({
          id: uuidv4(),
          type: sig.type,
          category: sig.category,
          offset: match.offset,
          size,
          sizeEstimated: estimated,
          extension: sig.extension,
          recoverability: 'good',
          source: 'carving'
        })
      }
      if (batch.length > 0) {
        port.postMessage({ type: 'files-batch', sessionId, data: batch })
      }
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
