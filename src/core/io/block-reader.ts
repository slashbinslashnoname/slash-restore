import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

import {
  SECTOR_SIZE,
  CHUNK_SIZE,
  MAX_READ_RETRIES,
  RETRY_BACKOFF_MS
} from '../../shared/constants/file-signatures'

// ─── Error Types ──────────────────────────────────────────────

export class BlockReaderError extends Error {
  public readonly code: string
  public override readonly cause?: unknown

  constructor(message: string, code: string, cause?: unknown) {
    super(message)
    this.name = 'BlockReaderError'
    this.code = code
    this.cause = cause
  }
}

export class BadSectorError extends BlockReaderError {
  public readonly sectorOffset: bigint

  constructor(sectorOffset: bigint, cause?: unknown) {
    super(`Bad sector at offset ${sectorOffset}`, 'BAD_SECTOR', cause)
    this.name = 'BadSectorError'
    this.sectorOffset = sectorOffset
  }
}

// ─── Result Types ─────────────────────────────────────────────

export interface ReadResult {
  /** Buffer containing the data that was read. */
  buffer: Buffer
  /** Actual number of bytes read (may be less than requested near end of device). */
  bytesRead: number
}

export interface ChunkedReadResult {
  /** Concatenated buffer of all chunks. */
  buffer: Buffer
  /** Total bytes successfully read across all chunks. */
  bytesRead: number
  /** Offsets of sectors that could not be read after all retries. */
  failedSectors: bigint[]
}

// ─── Statistics ───────────────────────────────────────────────

export interface BlockReaderStats {
  /** Total number of logical read operations performed. */
  totalReads: number
  /** Total bytes delivered to callers. */
  totalBytesRead: bigint
  /** Number of sectors that failed after all retries. */
  sectorErrors: number
  /** Total retry attempts across all sectors. */
  retriesPerformed: number
  /** Offsets of every unrecoverable sector. */
  failedSectorOffsets: bigint[]
}

// ─── Helpers ──────────────────────────────────────────────────

const SECTOR_SIZE_BIG = BigInt(SECTOR_SIZE)

/** Round a bigint offset down to the nearest sector boundary. */
function alignDown(offset: bigint): bigint {
  return offset - (offset % SECTOR_SIZE_BIG)
}

/** Round a bigint value up to the nearest sector boundary. */
function alignUp(value: bigint): bigint {
  const remainder = value % SECTOR_SIZE_BIG
  return remainder === 0n ? value : value + (SECTOR_SIZE_BIG - remainder)
}

/** Sleep for the specified number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── BlockReader ──────────────────────────────────────────────

/**
 * Buffered, sector-aligned block reader for raw device I/O.
 *
 * Design choices:
 *   - Every offset is `bigint` so disks > 2 TB are fully addressable.
 *   - Reads are aligned to 512-byte sector boundaries before being issued
 *     to the OS, then the requested sub-range is extracted.
 *   - Individual sector reads are retried up to {@link MAX_READ_RETRIES}
 *     times with exponential backoff starting at {@link RETRY_BACKOFF_MS}.
 *   - In chunked mode, unrecoverable sectors are zero-filled so scanning
 *     can continue past damaged regions.
 */
export class BlockReader {
  private handle: FileHandle | null = null
  private devicePath: string = ''
  private deviceSize: bigint = 0n

  private stats: BlockReaderStats = {
    totalReads: 0,
    totalBytesRead: 0n,
    sectorErrors: 0,
    retriesPerformed: 0,
    failedSectorOffsets: []
  }

  // ── Public Accessors ────────────────────────────────────

  /** Whether the reader currently holds an open file handle. */
  get isOpen(): boolean {
    return this.handle !== null
  }

  /** Absolute path of the currently opened device or image. */
  get path(): string {
    return this.devicePath
  }

  /** Total size of the opened device / image in bytes. */
  get size(): bigint {
    return this.deviceSize
  }

  /** Count of sectors that could not be read after exhausting retries. */
  get sectorErrorCount(): number {
    return this.stats.sectorErrors
  }

  /** Return a defensive copy of the current read statistics. */
  getStats(): Readonly<BlockReaderStats> {
    return {
      ...this.stats,
      failedSectorOffsets: [...this.stats.failedSectorOffsets]
    }
  }

  // ── Lifecycle ───────────────────────────────────────────

  /**
   * Open a block device or image file for reading.
   *
   * @param path Absolute path to the block device or disk image.
   * @throws {BlockReaderError} If the reader is already open or the path
   *   cannot be accessed.
   */
  async open(path: string): Promise<void> {
    if (this.handle) {
      throw new BlockReaderError(
        'Reader is already open. Call close() before opening a new device.',
        'ALREADY_OPEN'
      )
    }

    try {
      this.handle = await fs.open(path, 'r')

      const stat = await this.handle.stat()
      // For regular files stat.size is accurate.
      // For block devices on Linux stat.size is 0 -- callers should use
      // an ioctl or /sys/block/<dev>/size to obtain the real size and
      // pass it separately.  We store whatever stat reports.
      this.deviceSize = BigInt(stat.size)
      this.devicePath = path

      // Reset statistics for the new session
      this.stats = {
        totalReads: 0,
        totalBytesRead: 0n,
        sectorErrors: 0,
        retriesPerformed: 0,
        failedSectorOffsets: []
      }
    } catch (err) {
      // If the handle was partially opened, clean up
      if (this.handle) {
        try {
          await this.handle.close()
        } catch {
          // Ignore close-on-error failures
        }
        this.handle = null
      }

      throw new BlockReaderError(
        `Failed to open "${path}": ${err instanceof Error ? err.message : String(err)}`,
        'OPEN_FAILED',
        err
      )
    }
  }

  /**
   * Close the underlying file handle and release all resources.
   *
   * Safe to call multiple times. After closing, the reader can be
   * re-opened with a different path via {@link open}.
   */
  async close(): Promise<void> {
    if (this.handle) {
      try {
        await this.handle.close()
      } catch {
        // Swallow close errors -- the handle may already be invalid
        // (e.g. device was removed). Nothing actionable for the caller.
      } finally {
        this.handle = null
        this.devicePath = ''
        this.deviceSize = 0n
      }
    }
  }

  // ── Reading ─────────────────────────────────────────────

  /**
   * Read `length` bytes starting at `offset`.
   *
   * The I/O is sector-aligned: the actual system call may start before
   * `offset` and read past `offset + length`, but only the requested
   * window is returned.  Individual sectors are retried with exponential
   * backoff.  If a sector remains unreadable after all retries a
   * {@link BadSectorError} is thrown.
   *
   * @param offset Byte offset into the device (bigint).
   * @param length Number of bytes to read.
   * @returns The requested data and the count of bytes actually read.
   * @throws {BlockReaderError} If the reader is not open.
   * @throws {BadSectorError}   If a sector is unrecoverable.
   */
  async readAt(offset: bigint, length: number): Promise<ReadResult> {
    this.ensureOpen()

    if (length <= 0) {
      return { buffer: Buffer.alloc(0), bytesRead: 0 }
    }

    const alignedStart = alignDown(offset)
    const alignedEnd = alignUp(offset + BigInt(length))
    const alignedLength = Number(alignedEnd - alignedStart)

    const alignedBuffer = Buffer.alloc(alignedLength)
    let rawBytesRead = 0

    // Read sector-by-sector through the aligned window
    for (
      let sectorOffset = alignedStart;
      sectorOffset < alignedEnd;
      sectorOffset += SECTOR_SIZE_BIG
    ) {
      const bufPos = Number(sectorOffset - alignedStart)
      const toRead = Math.min(SECTOR_SIZE, alignedLength - bufPos)
      rawBytesRead += await this.readSectorWithRetry(
        sectorOffset,
        alignedBuffer,
        bufPos,
        toRead
      )
    }

    // Slice out only the caller's requested window
    const headPadding = Number(offset - alignedStart)
    const available = Math.max(0, Math.min(length, rawBytesRead - headPadding))
    const result = Buffer.alloc(available)

    if (available > 0) {
      alignedBuffer.copy(result, 0, headPadding, headPadding + available)
    }

    this.stats.totalReads++
    this.stats.totalBytesRead += BigInt(available)

    return { buffer: result, bytesRead: available }
  }

  /**
   * Read a large region in configurable chunks.
   *
   * Unlike {@link readAt}, unrecoverable sectors are **zero-filled**
   * rather than throwing, so a scan can continue past damaged regions.
   * The offsets of every skipped sector are returned in `failedSectors`.
   *
   * @param offset    Start offset (bigint).
   * @param length    Total number of bytes to read.
   * @param chunkSize Size of each I/O chunk in bytes (default 1 MB).
   *                  Rounded up to a sector boundary internally.
   * @returns Concatenated data, total bytes read, and failed sector list.
   */
  async readChunked(
    offset: bigint,
    length: number,
    chunkSize: number = CHUNK_SIZE
  ): Promise<ChunkedReadResult> {
    this.ensureOpen()

    if (length <= 0) {
      return { buffer: Buffer.alloc(0), bytesRead: 0, failedSectors: [] }
    }

    // Ensure chunk size is at least one sector and sector-aligned
    const effectiveChunkSize = Math.max(
      SECTOR_SIZE,
      Number(alignUp(BigInt(chunkSize)))
    )

    const resultBuffer = Buffer.alloc(length)
    let totalBytesRead = 0
    const allFailedSectors: bigint[] = []
    let remaining = length
    let currentOffset = offset

    while (remaining > 0) {
      const thisChunk = Math.min(effectiveChunkSize, remaining)
      const { buffer: chunkBuf, bytesRead, failedSectors } =
        await this.readChunkWithRecovery(currentOffset, thisChunk)

      chunkBuf.copy(resultBuffer, totalBytesRead, 0, bytesRead)
      totalBytesRead += bytesRead
      allFailedSectors.push(...failedSectors)

      currentOffset += BigInt(thisChunk)
      remaining -= thisChunk

      // Fewer bytes than requested means we've hit end-of-device
      if (bytesRead < thisChunk) {
        break
      }
    }

    return {
      buffer: resultBuffer.subarray(0, totalBytesRead),
      bytesRead: totalBytesRead,
      failedSectors: allFailedSectors
    }
  }

  // ── Private ─────────────────────────────────────────────

  /** Throw if the reader has no open file handle. */
  private ensureOpen(): void {
    if (!this.handle) {
      throw new BlockReaderError(
        'BlockReader is not open. Call open() first.',
        'NOT_OPEN'
      )
    }
  }

  /**
   * Read a single chunk sector-by-sector, zero-filling any
   * unrecoverable sectors so scanning can continue.
   */
  private async readChunkWithRecovery(
    offset: bigint,
    length: number
  ): Promise<{ buffer: Buffer; bytesRead: number; failedSectors: bigint[] }> {
    const alignedStart = alignDown(offset)
    const alignedEnd = alignUp(offset + BigInt(length))
    const alignedLength = Number(alignedEnd - alignedStart)

    const alignedBuffer = Buffer.alloc(alignedLength) // zero-initialized
    let rawBytesRead = 0
    const failedSectors: bigint[] = []

    for (
      let sectorOffset = alignedStart;
      sectorOffset < alignedEnd;
      sectorOffset += SECTOR_SIZE_BIG
    ) {
      const bufPos = Number(sectorOffset - alignedStart)
      const toRead = Math.min(SECTOR_SIZE, alignedLength - bufPos)

      try {
        rawBytesRead += await this.readSectorWithRetry(
          sectorOffset,
          alignedBuffer,
          bufPos,
          toRead
        )
      } catch {
        // Sector is unrecoverable -- buffer is already zero-filled
        rawBytesRead += toRead
        failedSectors.push(sectorOffset)
      }
    }

    // Extract the caller's requested window from the aligned buffer
    const headPadding = Number(offset - alignedStart)
    const resultLength = Math.min(length, rawBytesRead - headPadding)
    const resultBuffer = Buffer.from(
      alignedBuffer.subarray(headPadding, headPadding + resultLength)
    )

    this.stats.totalReads++
    this.stats.totalBytesRead += BigInt(resultLength)

    return { buffer: resultBuffer, bytesRead: resultLength, failedSectors }
  }

  /**
   * Read a single sector with up to {@link MAX_READ_RETRIES} retries
   * using exponential backoff.
   *
   * @returns Number of bytes actually read from the OS.
   * @throws {BadSectorError} When all retries are exhausted.
   */
  private async readSectorWithRetry(
    sectorOffset: bigint,
    buffer: Buffer,
    bufferPosition: number,
    bytesToRead: number
  ): Promise<number> {
    let lastError: unknown

    for (let attempt = 0; attempt <= MAX_READ_RETRIES; attempt++) {
      try {
        // Node's fs.FileHandle.read accepts a numeric position.
        // For offsets beyond Number.MAX_SAFE_INTEGER (> 8 PB) this
        // would lose precision, but no physical disk reaches that today.
        const { bytesRead } = await this.handle!.read(
          buffer,
          bufferPosition,
          bytesToRead,
          Number(sectorOffset)
        )
        return bytesRead
      } catch (err) {
        lastError = err

        if (attempt < MAX_READ_RETRIES) {
          this.stats.retriesPerformed++
          const backoffMs = RETRY_BACKOFF_MS * Math.pow(2, attempt)
          await sleep(backoffMs)
        }
      }
    }

    // All retries exhausted -- record and propagate
    this.stats.sectorErrors++
    this.stats.failedSectorOffsets.push(sectorOffset)

    throw new BadSectorError(sectorOffset, lastError)
  }
}
