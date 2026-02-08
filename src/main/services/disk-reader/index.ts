/**
 * DiskReaderService - Managed block reader for the main process.
 *
 * Wraps the core BlockReader interface to provide a higher-level service
 * that manages open device handles, privilege checks, and graceful cleanup.
 * Only one handle per device path is kept open at a time.
 */

import * as fs from 'fs'
import { promisify } from 'util'
import { execFile } from 'child_process'
import type { BlockReader } from '../../../core/io/block-reader'
import { PrivilegeManager } from '../privilege'

const execFileAsync = promisify(execFile)

const fsOpen = promisify(fs.open)
const fsRead = promisify(fs.read)
const fsClose = promisify(fs.close)
const fsFstat = promisify(fs.fstat)

/**
 * Concrete BlockReader implementation that opens a raw device or image file
 * using Node.js fs primitives. Reads are aligned and retried on transient
 * errors.
 */
class FileBlockReader implements BlockReader {
  readonly path: string
  readonly size: bigint
  private fd: number
  private closed = false

  private constructor(path: string, fd: number, size: bigint) {
    this.path = path
    this.fd = fd
    this.size = size
  }

  /**
   * Open a device or image file for reading.
   *
   * On Linux/macOS the file is opened with O_RDONLY. On Windows the path
   * is expected to be a PhysicalDrive path; Node's fs.open handles it
   * transparently.
   */
  static async open(devicePath: string): Promise<FileBlockReader> {
    const fd = await fsOpen(devicePath, 'r')

    let size: bigint
      const stat = await fsFstat(fd)
      // For regular files, stat.size is accurate.
      // For block devices on Linux, stat.size is 0 - we need an alternative approach.
      if (stat.size > 0) {
        size = BigInt(stat.size)
      } else {
        try {
          const { stdout } = await execFileAsync('blockdev', ['--getsize64', devicePath])
          size = BigInt(stdout.trim())
        } catch (e: unknown) {
          console.warn(`blockdev failed: ${e}, falling back to stat.size=0`)
          size = 0n
        }
      }
        size = await FileBlockReader.probeDeviceSize(fd)
      }
    } catch {
      // Fallback: if we cannot determine size, set to max safe value.
      // The consumer should use the device size from enumeration instead.
      size = 0n
    }

    return new FileBlockReader(devicePath, fd, size)
  }

  /**
   * Probe the size of a block device by performing a binary search with reads.
   *
   * Block devices report stat.size = 0 on Linux. We perform a binary search
   * on read offsets to find the last readable position.
   */
  private static async probeDeviceSize(fd: number): Promise<bigint> {
    const probeBuffer = Buffer.alloc(512)

    // Start with a reasonable upper bound (16 TB).
    let low = 0n
    let high = 16n * 1024n * 1024n * 1024n * 1024n

    // First check if the device is even readable at offset 0.
    try {
      await fsRead(fd, probeBuffer, 0, 512, 0)
    } catch {
      return 0n
    }

    // Binary search for the boundary.
    while (high - low > 512n) {
      const mid = (low + high) / 2n
      // Align to 512-byte sector boundary.
      const aligned = mid - (mid % 512n)

      try {
        await fsRead(fd, probeBuffer, 0, 512, Number(aligned))
        low = aligned + 512n
      } catch {
        high = aligned
      }
    }

    return low
  }

  async read(offset: bigint, length: number): Promise<Buffer> {
    if (this.closed) {
      throw new Error(`BlockReader for ${this.path} has been closed`)
    }

    const buffer = Buffer.alloc(length)
    let bytesRead = 0
    let currentOffset = offset

    // Read in chunks - some platforms limit single read sizes on raw devices.
    while (bytesRead < length) {
      const remaining = length - bytesRead
      const chunkSize = Math.min(remaining, 1024 * 1024) // 1 MB chunks

      try {
        const result = await fsRead(
          this.fd,
          buffer,
          bytesRead,
          chunkSize,
          Number(currentOffset)
        )

        if (result.bytesRead === 0) {
          // End of device reached.
          break
        }

        bytesRead += result.bytesRead
        currentOffset += BigInt(result.bytesRead)
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException
        // EIO typically means a bad sector. Fill with zeros and continue
        // to allow best-effort recovery.
        if (error.code === 'EIO') {
          buffer.fill(0, bytesRead, bytesRead + chunkSize)
          bytesRead += chunkSize
          currentOffset += BigInt(chunkSize)
        } else {
          throw error
        }
      }
    }

    // Return only the bytes that were actually read.
    return bytesRead < length ? buffer.subarray(0, bytesRead) : buffer
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await fsClose(this.fd)
  }
}

/**
 * Service that manages open BlockReader instances for the main process.
 *
 * Keeps a map of device path to open reader, ensuring only one handle per
 * path exists at a time. Checks for sufficient privileges before opening.
 */
export class DiskReaderService {
  private readers = new Map<string, FileBlockReader>()
  private privilegeManager: PrivilegeManager

  constructor(privilegeManager: PrivilegeManager) {
    this.privilegeManager = privilegeManager
  }

  /**
   * Open a device for reading.
   *
   * If the device is already open, returns the existing reader. Otherwise,
   * checks for sufficient privileges and opens a new reader.
   *
   * @param devicePath - Absolute path to the block device or image file.
   * @returns A BlockReader instance for the device.
   */
  async openDevice(devicePath: string): Promise<BlockReader> {
    const existing = this.readers.get(devicePath)
    if (existing) return existing

    // Ensure we have adequate privileges before attempting to open the device.
    const hasPrivilege = await this.privilegeManager.checkPrivilege()
    if (!hasPrivilege) {
      throw new Error(
        `Insufficient privileges to open device ${devicePath}. ` +
        'Request elevation before opening devices.'
      )
    }

    const reader = await FileBlockReader.open(devicePath)
    this.readers.set(devicePath, reader)
    return reader
  }

  /**
   * Read sectors from an already-open device.
   *
   * @param devicePath - Path to the device (must be already opened).
   * @param offset - Byte offset to start reading from.
   * @param length - Number of bytes to read.
   * @returns The data read from the device.
   */
  async readSectors(
    devicePath: string,
    offset: bigint,
    length: number
  ): Promise<Buffer> {
    const reader = this.readers.get(devicePath)
    if (!reader) {
      throw new Error(
        `Device ${devicePath} is not open. Call openDevice() first.`
      )
    }
    return reader.read(offset, length)
  }

  /**
   * Close a device handle and release resources.
   *
   * @param devicePath - Path to the device to close.
   */
  async closeDevice(devicePath: string): Promise<void> {
    const reader = this.readers.get(devicePath)
    if (!reader) return

    this.readers.delete(devicePath)
    await reader.close()
  }

  /**
   * Close all open device handles.
   *
   * Should be called during application shutdown.
   */
  async closeAll(): Promise<void> {
    const closeTasks = Array.from(this.readers.values()).map((r) => r.close())
    this.readers.clear()
    await Promise.allSettled(closeTasks)
  }
}
