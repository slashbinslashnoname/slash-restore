/**
 * CarvingEngine - Orchestrates disk scanning and file signature matching.
 *
 * Reads the device in 1 MB chunks with 64-byte overlap between consecutive
 * chunks (to catch file headers that straddle a chunk boundary). For each
 * header match found by the {@link SignatureScanner}, the appropriate
 * {@link FileExtractor} is invoked to determine the file size and metadata.
 *
 * The engine supports pause / resume / cancel and emits events so the UI
 * can display real-time progress.
 *
 * Events:
 *   - 'progress'   : ScanProgress   - Periodic progress updates.
 *   - 'file-found' : RecoverableFile - A recoverable file was identified.
 *   - 'error'      : { offset: bigint, error: string } - Non-fatal error.
 *   - 'complete'   : { filesFound: number } - Scan finished.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

import { BlockReader } from '../io/block-reader'
import { SignatureScanner, type SignatureMatch } from './signature-scanner'
import type { ReadableDevice, FileExtractor } from './file-extractors/base-extractor'
import { createExtractorMap } from './file-extractors'

import type {
  FileCategory,
  FileType,
  RecoverableFile,
  ScanProgress
} from '../../shared/types'

import {
  FILE_SIGNATURES,
  type FileSignature,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  SIGNATURE_MAP,
  getSignaturesByCategory,
  getSignaturesByTypes
} from '../../shared/constants/file-signatures'

// ─── Types ─────────────────────────────────────────────────────

export interface CarvingScanConfig {
  /** Absolute byte offset to start scanning from. */
  startOffset: bigint
  /** Absolute byte offset to stop scanning at (exclusive). */
  endOffset: bigint
  /** File categories to search for. */
  categories: FileCategory[]
  /** When provided, only these specific file types are scanned (overrides categories). */
  fileTypes?: FileType[]
}

export interface CarvingEngineEvents {
  progress: [ScanProgress]
  'file-found': [RecoverableFile]
  error: [{ offset: bigint; error: string }]
  complete: [{ filesFound: number }]
}

// ─── ReadableDevice adapter ────────────────────────────────────

/**
 * Wraps the real BlockReader to satisfy the simpler ReadableDevice interface
 * that file extractors expect.
 */
function createReadableDevice(blockReader: BlockReader): ReadableDevice {
  return {
    get size() {
      return blockReader.size
    },
    async read(offset: bigint, length: number): Promise<Buffer> {
      const result = await blockReader.readAt(offset, length)
      return result.buffer
    }
  }
}

// ─── CarvingEngine ─────────────────────────────────────────────

export class CarvingEngine extends EventEmitter {
  private readonly blockReader: BlockReader
  private readonly scanner: SignatureScanner
  private readonly extractors: Map<FileType, FileExtractor>

  private status: 'idle' | 'scanning' | 'paused' | 'cancelled' = 'idle'
  private pausePromise: Promise<void> | null = null
  private pauseResolve: (() => void) | null = null

  constructor(blockReader: BlockReader, scanner?: SignatureScanner) {
    super()
    this.blockReader = blockReader
    this.scanner = scanner ?? new SignatureScanner()
    this.extractors = createExtractorMap()
  }

  // ── Public API ──────────────────────────────────────────

  /**
   * Start scanning the device for recoverable files.
   *
   * @param config - Scan configuration specifying the byte range and categories.
   */
  async scan(config: CarvingScanConfig): Promise<void> {
    if (this.status === 'scanning') {
      throw new Error('A scan is already in progress')
    }

    this.status = 'scanning'

    // Build the scanner with signatures matching the requested file types or categories.
    const signatures = config.fileTypes && config.fileTypes.length > 0
      ? this.getSignaturesForTypes(config.fileTypes)
      : this.getSignaturesForCategories(config.categories)
    this.buildScanner(signatures)

    const readable = createReadableDevice(this.blockReader)
    const totalBytes = config.endOffset - config.startOffset

    let bytesScanned = 0n
    let filesFound = 0
    let sectorsWithErrors = 0
    const startTime = Date.now()

    // Track offsets we've already found files at, to avoid duplicates
    // from the chunk overlap region.
    const foundOffsets = new Set<string>()

    let currentOffset = config.startOffset

    try {
      while (currentOffset < config.endOffset) {
        // ── Check for pause / cancel ──
        if (this.status === 'cancelled') {
          break
        }
        if (this.status === 'paused') {
          await this.waitForResume()
          if (this.status === 'cancelled') break
        }

        // ── Read a chunk ──
        const remaining = Number(config.endOffset - currentOffset)
        const readSize = Math.min(CHUNK_SIZE, remaining)

        let chunk: Buffer
        try {
          const result = await this.blockReader.readAt(currentOffset, readSize)
          chunk = result.buffer
          if (result.bytesRead === 0) {
            // End of device reached.
            break
          }
        } catch (err) {
          // Read error - try chunked read with recovery.
          try {
            const result = await this.blockReader.readChunked(currentOffset, readSize)
            chunk = result.buffer
            sectorsWithErrors += result.failedSectors.length
          } catch (fatalErr) {
            const errMsg = fatalErr instanceof Error ? fatalErr.message : String(fatalErr)
            this.emit('error', { offset: currentOffset, error: errMsg })
            // Skip this chunk and continue.
            currentOffset += BigInt(readSize - CHUNK_OVERLAP)
            bytesScanned += BigInt(readSize - CHUNK_OVERLAP)
            continue
          }
        }

        // ── Scan the chunk for signatures ──
        const matches = this.scanner.scan(chunk, currentOffset)

        // ── Process matches ──
        for (const match of matches) {
          if (this.status === 'cancelled') break

          // De-duplicate matches in the overlap region.
          const offsetKey = match.offset.toString()
          if (foundOffsets.has(offsetKey)) continue
          foundOffsets.add(offsetKey)

          // Skip matches outside our scan range.
          if (match.offset < config.startOffset || match.offset >= config.endOffset) {
            continue
          }

          try {
            const file = await this.processMatch(match, readable, signatures)
            if (file) {
              filesFound++
              this.emit('file-found', file)
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            this.emit('error', { offset: match.offset, error: errMsg })
          }
        }

        // ── Advance to next chunk ──
        // Overlap the last CHUNK_OVERLAP bytes to catch headers that span boundaries.
        const advance = readSize > CHUNK_OVERLAP ? readSize - CHUNK_OVERLAP : readSize
        currentOffset += BigInt(advance)
        bytesScanned += BigInt(advance)

        // ── Emit progress ──
        const percentage =
          totalBytes > 0n
            ? Math.min(100, Number((bytesScanned * 100n) / totalBytes))
            : 100

        const elapsedMs = Date.now() - startTime
        const bytesPerMs = elapsedMs > 0 ? Number(bytesScanned) / elapsedMs : 0
        const remainingBytes = Number(totalBytes - bytesScanned)
        const estimatedTimeRemaining =
          bytesPerMs > 0 ? Math.round(remainingBytes / bytesPerMs) : undefined

        const progress: ScanProgress = {
          bytesScanned,
          totalBytes,
          percentage,
          filesFound,
          currentSector: currentOffset / 512n,
          estimatedTimeRemaining,
          sectorsWithErrors
        }

        this.emit('progress', progress)
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.emit('error', { offset: currentOffset, error: `Fatal scan error: ${errMsg}` })
    }

    this.status = 'idle'
    this.emit('complete', { filesFound })
  }

  /**
   * Pause the scan. The scan loop will block at the next chunk boundary
   * until {@link resume} is called.
   */
  pause(): void {
    if (this.status !== 'scanning') return

    this.status = 'paused'
    this.pausePromise = new Promise<void>(resolve => {
      this.pauseResolve = resolve
    })
  }

  /**
   * Resume a paused scan.
   */
  resume(): void {
    if (this.status !== 'paused') return

    this.status = 'scanning'
    if (this.pauseResolve) {
      this.pauseResolve()
      this.pauseResolve = null
      this.pausePromise = null
    }
  }

  /**
   * Cancel the scan. The scan loop will exit at the next chunk boundary.
   */
  cancel(): void {
    if (this.status === 'idle') return

    this.status = 'cancelled'

    // If paused, unblock the wait so the loop can exit.
    if (this.pauseResolve) {
      this.pauseResolve()
      this.pauseResolve = null
      this.pausePromise = null
    }
  }

  /**
   * Get the current scan status.
   */
  getStatus(): string {
    return this.status
  }

  // ── Private ─────────────────────────────────────────────

  /**
   * Wait until the engine is resumed or cancelled.
   */
  private async waitForResume(): Promise<void> {
    if (this.pausePromise) {
      await this.pausePromise
    }
  }

  /**
   * Get the file signatures that match the requested file types.
   */
  private getSignaturesForTypes(types: FileType[]): FileSignature[] {
    return getSignaturesByTypes(types)
  }

  /**
   * Get the file signatures that match the requested categories.
   */
  private getSignaturesForCategories(categories: FileCategory[]): FileSignature[] {
    if (categories.length === 0) {
      return [...FILE_SIGNATURES]
    }

    const sigs: FileSignature[] = []
    for (const cat of categories) {
      sigs.push(...getSignaturesByCategory(cat))
    }
    return sigs
  }

  /**
   * Build the Aho-Corasick scanner with the given signatures.
   *
   * Some signatures share the same header bytes (e.g., docx and xlsx both use
   * PK\x03\x04). We add each unique (header, headerOffset) pair once, using
   * a composite label to track which types might match. The extractor will
   * differentiate later.
   */
  private buildScanner(signatures: FileSignature[]): void {
    // De-duplicate identical patterns.
    const seen = new Map<string, boolean>()

    for (const sig of signatures) {
      const key = sig.header.toString('hex') + ':' + sig.headerOffset
      if (seen.has(key)) continue
      seen.set(key, true)

      this.scanner.addPattern(sig.header, sig.type, sig.headerOffset)
    }

    this.scanner.build()
  }

  /**
   * Process a single signature match: invoke the extractor and build a
   * RecoverableFile record if the extraction succeeds.
   */
  private async processMatch(
    match: SignatureMatch,
    reader: ReadableDevice,
    signatures: FileSignature[]
  ): Promise<RecoverableFile | null> {
    const fileType = match.type as FileType
    const signature = SIGNATURE_MAP.get(fileType)

    if (!signature) {
      return null
    }

    const extractor = this.extractors.get(fileType)
    if (!extractor) {
      return null
    }

    // Run the extractor.
    const result = await extractor.extract(reader, match.offset)

    // Validate the extracted size against signature constraints.
    if (result.size < signature.minSize) {
      return null // Too small - likely a false positive.
    }

    let effectiveSize = result.size
    let sizeEstimated = result.estimated

    if (effectiveSize > signature.maxSize) {
      effectiveSize = signature.maxSize
      sizeEstimated = true
    }

    // Determine recoverability heuristic.
    let recoverability: 'good' | 'partial' | 'poor'
    if (!sizeEstimated) {
      recoverability = 'good'
    } else if (effectiveSize > signature.minSize * 2n) {
      recoverability = 'partial'
    } else {
      recoverability = 'poor'
    }

    const file: RecoverableFile = {
      id: randomUUID(),
      type: fileType,
      category: signature.category,
      offset: match.offset,
      size: effectiveSize,
      sizeEstimated,
      extension: signature.extension,
      metadata: result.metadata,
      recoverability,
      source: 'carving'
    }

    return file
  }
}
