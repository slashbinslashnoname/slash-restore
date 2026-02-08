import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { RecoveryConfig } from '../../../shared/types'
import { SECTOR_SIZE } from '../../../shared/constants/file-signatures'

// ─── Error Types ──────────────────────────────────────────────

export class FileWriterError extends Error {
  public readonly code: string
  public override readonly cause?: unknown

  constructor(message: string, code: string, cause?: unknown) {
    super(message)
    this.name = 'FileWriterError'
    this.code = code
    this.cause = cause
  }
}

export class SameDeviceError extends FileWriterError {
  constructor(
    public readonly sourcePath: string,
    public readonly destinationPath: string
  ) {
    super(
      `Source "${sourcePath}" and destination "${destinationPath}" are on the same physical device. ` +
        'Writing to the source device during recovery would destroy data.',
      'SAME_DEVICE'
    )
    this.name = 'SameDeviceError'
  }
}

// ─── Types ────────────────────────────────────────────────────

export type ConflictStrategy = RecoveryConfig['conflictStrategy']

export interface WriteOptions {
  /** How to handle an existing file at the destination. Default: 'rename'. */
  conflictStrategy?: ConflictStrategy
  /**
   * Absolute path to the source device so same-device protection can
   * verify the destination is on a different physical disk.
   */
  sourceDevicePath?: string
  /** If true, create intermediate directories as needed. Default: true. */
  createDirectories?: boolean
}

export interface WriteResult {
  /** Whether the file was actually written (false when strategy is 'skip'). */
  written: boolean
  /** Final absolute path of the written file (may differ from requested if renamed). */
  finalPath: string
  /** Number of bytes written. */
  bytesWritten: number
}

/**
 * A function that reads `length` bytes starting at `offset` from the
 * source device.  Used by {@link FileWriter.writeStream} to pull data
 * on demand without loading the entire file into memory.
 */
export type ReadFunction = (offset: bigint, length: number) => Promise<Buffer>

export interface WriteStreamOptions extends WriteOptions {
  /**
   * Size of each read chunk when streaming from the source device.
   * Default: 1 MB (1_048_576 bytes).
   */
  chunkSize?: number
}

// ─── Helpers ──────────────────────────────────────────────────

const DEFAULT_STREAM_CHUNK_SIZE = 1_048_576 // 1 MB

/**
 * Round a byte count up to the nearest sector boundary.
 * Useful for aligning chunk reads when streaming from a block device.
 */
function alignToSector(value: number): number {
  const remainder = value % SECTOR_SIZE
  return remainder === 0 ? value : value + (SECTOR_SIZE - remainder)
}

/**
 * Resolve the device number (st_dev) for the given path.
 * If the path does not exist yet, walk up to the nearest existing ancestor.
 */
async function getDeviceId(targetPath: string): Promise<number> {
  let current = path.resolve(targetPath)

  // Walk up until we find an existing path (worst case: filesystem root)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const stat = await fs.stat(current)
      return stat.dev
    } catch {
      const parent = path.dirname(current)
      if (parent === current) {
        // Reached filesystem root and it doesn't exist -- should never
        // happen on a real system, but guard against infinite loops.
        throw new FileWriterError(
          `Cannot determine device for path "${targetPath}": no existing ancestor found.`,
          'DEVICE_LOOKUP_FAILED'
        )
      }
      current = parent
    }
  }
}

/**
 * Generate a unique filename by appending `_1`, `_2`, ... before the
 * extension until a path is found that does not yet exist on disk.
 *
 * Example: `/dst/photo.jpg` -> `/dst/photo_1.jpg` -> `/dst/photo_2.jpg`
 */
async function generateUniquePath(filePath: string): Promise<string> {
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)

  let counter = 1
  // Safety cap to avoid infinite loops on a pathological filesystem
  const MAX_ATTEMPTS = 10_000

  while (counter <= MAX_ATTEMPTS) {
    const candidate = path.join(dir, `${base}_${counter}${ext}`)
    try {
      await fs.access(candidate)
      // File exists -- try next number
      counter++
    } catch {
      // File does not exist -- this name is available
      return candidate
    }
  }

  throw new FileWriterError(
    `Could not generate a unique filename for "${filePath}" after ${MAX_ATTEMPTS} attempts.`,
    'UNIQUE_NAME_EXHAUSTED'
  )
}

/**
 * Ensure the directory tree leading to `filePath` exists.
 */
async function ensureDirectory(filePath: string): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
}

/**
 * Check whether a file already exists at the given path.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

// ─── FileWriter ───────────────────────────────────────────────

/**
 * Writes recovered file data to a destination directory.
 *
 * Safety features:
 *   - Same-device protection prevents writing recovered data back to the
 *     source device, which would overwrite the data being recovered.
 *   - Configurable conflict resolution: rename (append `_N`), overwrite,
 *     or skip.
 *   - Automatic creation of intermediate directories.
 *   - Streaming write mode for large files that should not be buffered
 *     entirely in memory.
 */
export class FileWriter {
  /**
   * Write a buffer to a destination file.
   *
   * @param data            Buffer of recovered file content.
   * @param destinationPath Absolute path where the file should be written.
   * @param options         Write options (conflict strategy, source device, etc.).
   * @returns Outcome of the write operation.
   */
  async write(
    data: Buffer,
    destinationPath: string,
    options: WriteOptions = {}
  ): Promise<WriteResult> {
    const {
      conflictStrategy = 'rename',
      sourceDevicePath,
      createDirectories = true
    } = options

    const resolvedDest = path.resolve(destinationPath)

    // ── Same-device guard ──────────────────────────────────
    if (sourceDevicePath) {
      await this.assertDifferentDevice(sourceDevicePath, resolvedDest)
    }

    // ── Directory creation ─────────────────────────────────
    if (createDirectories) {
      await ensureDirectory(resolvedDest)
    }

    // ── Conflict resolution ────────────────────────────────
    const finalPath = await this.resolveConflict(resolvedDest, conflictStrategy)

    if (finalPath === null) {
      // Strategy was 'skip' and the file exists
      return { written: false, finalPath: resolvedDest, bytesWritten: 0 }
    }

    // ── Write ──────────────────────────────────────────────
    try {
      await fs.writeFile(finalPath, data)
      return { written: true, finalPath, bytesWritten: data.length }
    } catch (err) {
      throw new FileWriterError(
        `Failed to write "${finalPath}": ${err instanceof Error ? err.message : String(err)}`,
        'WRITE_FAILED',
        err
      )
    }
  }

  /**
   * Stream recovered data from a reader function to a destination file,
   * reading in chunks so arbitrarily large files never need to fit
   * entirely in memory.
   *
   * @param readFn          Function that reads bytes from the source device.
   * @param destinationPath Absolute path where the file should be written.
   * @param size            Total file size in bytes to stream.
   * @param options         Write and streaming options.
   * @returns Outcome of the write operation.
   */
  async writeStream(
    readFn: ReadFunction,
    destinationPath: string,
    size: bigint,
    options: WriteStreamOptions = {}
  ): Promise<WriteResult> {
    const {
      conflictStrategy = 'rename',
      sourceDevicePath,
      createDirectories = true,
      chunkSize = DEFAULT_STREAM_CHUNK_SIZE
    } = options

    const resolvedDest = path.resolve(destinationPath)

    // ── Same-device guard ──────────────────────────────────
    if (sourceDevicePath) {
      await this.assertDifferentDevice(sourceDevicePath, resolvedDest)
    }

    // ── Directory creation ─────────────────────────────────
    if (createDirectories) {
      await ensureDirectory(resolvedDest)
    }

    // ── Conflict resolution ────────────────────────────────
    const finalPath = await this.resolveConflict(resolvedDest, conflictStrategy)

    if (finalPath === null) {
      return { written: false, finalPath: resolvedDest, bytesWritten: 0 }
    }

    // ── Streaming write ────────────────────────────────────
    let handle: fs.FileHandle | null = null
    let totalBytesWritten = 0

    try {
      handle = await fs.open(finalPath, 'w')

      // Align chunk size to sector boundary for efficient device reads
      const alignedChunkSize = alignToSector(chunkSize)
      let remaining = size
      let sourceOffset = 0n

      while (remaining > 0n) {
        const toRead = Number(remaining < BigInt(alignedChunkSize) ? remaining : BigInt(alignedChunkSize))
        const chunk = await readFn(sourceOffset, toRead)

        if (chunk.length === 0) {
          // Source returned no data -- treat as end of readable data
          break
        }

        await handle.write(chunk, 0, chunk.length)
        totalBytesWritten += chunk.length
        sourceOffset += BigInt(chunk.length)
        remaining -= BigInt(chunk.length)

        // If reader returned fewer bytes than requested, we're done
        if (chunk.length < toRead) {
          break
        }
      }

      return { written: true, finalPath, bytesWritten: totalBytesWritten }
    } catch (err) {
      // Attempt to clean up the partial file
      if (handle) {
        try {
          await handle.close()
          handle = null
        } catch {
          // Ignore cleanup errors
        }
        try {
          await fs.unlink(finalPath)
        } catch {
          // Ignore cleanup errors -- partial file may remain
        }
      }

      throw new FileWriterError(
        `Failed to stream-write "${finalPath}": ${err instanceof Error ? err.message : String(err)}`,
        'STREAM_WRITE_FAILED',
        err
      )
    } finally {
      if (handle) {
        try {
          await handle.close()
        } catch {
          // Ignore close errors in finally
        }
      }
    }
  }

  // ── Private ─────────────────────────────────────────────

  /**
   * Verify that the destination is on a different physical device
   * than the source being recovered from.
   *
   * @throws {SameDeviceError} If both paths resolve to the same device.
   */
  private async assertDifferentDevice(
    sourcePath: string,
    destinationPath: string
  ): Promise<void> {
    try {
      const [srcDev, dstDev] = await Promise.all([
        getDeviceId(sourcePath),
        getDeviceId(destinationPath)
      ])

      if (srcDev === dstDev) {
        throw new SameDeviceError(sourcePath, destinationPath)
      }
    } catch (err) {
      // Re-throw our own errors as-is
      if (err instanceof SameDeviceError) {
        throw err
      }

      // For any other stat/lookup failure, warn but do not block.
      // The user may be recovering from an image file on the same disk
      // as the destination, which is perfectly safe.
      // Silently allow the operation to proceed.
    }
  }

  /**
   * Apply the chosen conflict resolution strategy and return the
   * final path to write to, or `null` if the file should be skipped.
   */
  private async resolveConflict(
    filePath: string,
    strategy: ConflictStrategy
  ): Promise<string | null> {
    const exists = await fileExists(filePath)

    if (!exists) {
      return filePath
    }

    switch (strategy) {
      case 'overwrite':
        return filePath

      case 'skip':
        return null

      case 'rename':
        return generateUniquePath(filePath)

      default: {
        // Exhaustive check
        const _exhaustive: never = strategy
        throw new FileWriterError(
          `Unknown conflict strategy: "${strategy}"`,
          'INVALID_STRATEGY'
        )
      }
    }
  }
}
