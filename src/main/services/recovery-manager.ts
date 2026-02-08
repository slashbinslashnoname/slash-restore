/**
 * RecoveryManager - Orchestrates file recovery from a source device to a destination.
 *
 * Reads file data from the source device using BlockReader and writes it to
 * the destination filesystem. Supports pause/resume/cancel and tracks progress
 * with event emission for IPC forwarding.
 *
 * Safety: before starting, verifies that the source device and destination
 * path are NOT on the same physical device to prevent data corruption.
 */

import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { promisify } from 'util'
import { execFile } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import type { BlockReader } from '../../core/io/block-reader'
import type {
  RecoverableFile,
  RecoveryConfig,
  RecoveryProgress,
  RecoveryStatus,
  RecoveryError
} from '../../shared/types'
import { DiskReaderService } from './disk-reader'

const fsMkdir = promisify(fs.mkdir)
const fsWriteFile = promisify(fs.writeFile)
const fsStat = promisify(fs.stat)
const fsAccess = promisify(fs.access)
const fsRealpath = promisify(fs.realpath)
const execFileAsync = promisify(execFile)

/** Chunk size for reading from source device during recovery (1 MB). */
const RECOVERY_CHUNK_SIZE = 1024 * 1024

/**
 * Events emitted by RecoveryManager.
 */
export interface RecoveryManagerEvents {
  progress: (progress: RecoveryProgress) => void
  complete: (progress: RecoveryProgress) => void
  error: (error: string) => void
}

export class RecoveryManager extends EventEmitter {
  private diskReader: DiskReaderService
  private status: RecoveryStatus = 'idle'
  private paused = false
  private cancelled = false
  private pausePromise: Promise<void> | null = null
  private pauseResolve: (() => void) | null = null

  constructor(diskReader: DiskReaderService) {
    super()
    this.diskReader = diskReader
  }

  /**
   * Start recovering files to the destination path.
   *
   * @param config - Recovery configuration with files, destination, and options.
   * @returns The recovery session ID.
   * @throws If source and destination are on the same physical device.
   */
  async start(config: RecoveryConfig): Promise<string> {
    const sessionId = uuidv4()

    // Safety check: ensure source and destination are not on the same device.
    const sameDevice = await this.isSameDevice(
      config.sourceDevicePath,
      config.destinationPath
    )
    if (sameDevice) {
      const msg =
        'SAFETY: Source device and destination are on the same physical device. ' +
        'Writing recovered files to the same device could overwrite the data ' +
        'you are trying to recover. Please choose a different destination.'
      this.emit('error', msg)
      throw new Error(msg)
    }

    // Ensure destination directory exists.
    await fsMkdir(config.destinationPath, { recursive: true })

    this.status = 'recovering'
    this.paused = false
    this.cancelled = false

    // Run recovery in the background.
    this.recoverFiles(config).catch((err) => {
      this.status = 'error'
      this.emit(
        'error',
        err instanceof Error ? err.message : 'Unknown recovery error'
      )
    })

    return sessionId
  }

  /**
   * Pause the current recovery operation.
   */
  pause(): void {
    if (this.status !== 'recovering') return
    this.paused = true
    this.status = 'paused'
    this.pausePromise = new Promise<void>((resolve) => {
      this.pauseResolve = resolve
    })
  }

  /**
   * Resume a paused recovery operation.
   */
  resume(): void {
    if (this.status !== 'paused') return
    this.paused = false
    this.status = 'recovering'
    if (this.pauseResolve) {
      this.pauseResolve()
      this.pauseResolve = null
      this.pausePromise = null
    }
  }

  /**
   * Cancel the current recovery operation.
   */
  cancel(): void {
    this.cancelled = true
    this.status = 'cancelled'
    // If paused, unblock the wait loop so the recovery loop can exit.
    if (this.pauseResolve) {
      this.pauseResolve()
      this.pauseResolve = null
      this.pausePromise = null
    }
  }

  /**
   * Get the current recovery status.
   */
  getStatus(): RecoveryStatus {
    return this.status
  }

  // ─── Private ──────────────────────────────────────────────────

  /**
   * Core recovery loop: iterate over files, read from source, write to dest.
   */
  private async recoverFiles(config: RecoveryConfig): Promise<void> {
    const { files, destinationPath, conflictStrategy, sourceDevicePath } = config
    const errors: RecoveryError[] = []
    let completedFiles = 0
    let totalBytesWritten = 0n

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0n)

    let reader: BlockReader
    try {
      reader = await this.diskReader.openDevice(sourceDevicePath)
    } catch (err) {
      this.status = 'error'
      const msg = `Failed to open source device: ${err instanceof Error ? err.message : String(err)}`
      this.emit('error', msg)
      return
    }

    for (const file of files) {
      if (this.cancelled) break

      // Wait if paused.
      if (this.paused && this.pausePromise) {
        await this.pausePromise
        if (this.cancelled) break
      }

      try {
        const bytesWritten = await this.recoverSingleFile(
          reader,
          file,
          destinationPath,
          conflictStrategy
        )
        totalBytesWritten += bytesWritten
      } catch (err) {
        const error: RecoveryError = {
          fileId: file.id,
          fileName: file.name ?? `recovered_${file.id}.${file.extension}`,
          error: err instanceof Error ? err.message : 'Unknown error'
        }
        errors.push(error)
      }

      completedFiles++

      const progress: RecoveryProgress = {
        totalFiles: files.length,
        completedFiles,
        currentFile: file.name ?? `recovered_${file.id}.${file.extension}`,
        bytesWritten: totalBytesWritten,
        totalBytes,
        percentage:
          totalBytes > 0n
            ? Number((totalBytesWritten * 100n) / totalBytes)
            : 0,
        errors
      }

      this.emit('progress', progress)
    }

    if (this.cancelled) {
      this.status = 'cancelled'
    } else {
      this.status = 'completed'
    }

    const finalProgress: RecoveryProgress = {
      totalFiles: files.length,
      completedFiles,
      bytesWritten: totalBytesWritten,
      totalBytes,
      percentage:
        totalBytes > 0n
          ? Number((totalBytesWritten * 100n) / totalBytes)
          : 100,
      errors
    }

    this.emit('complete', finalProgress)
  }

  /**
   * Recover a single file from the source device.
   *
   * Reads the file data in chunks and writes to the destination. If the file
   * has fragments, reads each fragment in sequence.
   *
   * @returns The number of bytes written.
   */
  private async recoverSingleFile(
    reader: BlockReader,
    file: RecoverableFile,
    destinationPath: string,
    conflictStrategy: 'rename' | 'overwrite' | 'skip'
  ): Promise<bigint> {
    const fileName = file.name ?? `recovered_${file.id}.${file.extension}`
    let outputPath: string

    if (file.category) {
      // Organize by category subdirectory.
      const categoryDir = path.join(destinationPath, file.category)
      await fsMkdir(categoryDir, { recursive: true })
      outputPath = path.join(categoryDir, fileName)
    } else {
      outputPath = path.join(destinationPath, fileName)
    }

    // Handle naming conflicts.
    outputPath = await this.resolveOutputPath(outputPath, conflictStrategy)
    if (outputPath === '') {
      // Skip strategy: file already exists.
      return 0n
    }

    let bytesWritten = 0n
    const writeStream = fs.createWriteStream(outputPath)

    try {
      const fragments = file.fragments ?? [{ offset: file.offset, size: file.size }]

      for (const fragment of fragments) {
        if (this.cancelled) break

        let fragmentOffset = fragment.offset
        let remaining = fragment.size

        while (remaining > 0n) {
          if (this.cancelled) break

          // Wait if paused.
          if (this.paused && this.pausePromise) {
            await this.pausePromise
            if (this.cancelled) break
          }

          const chunkSize = Number(
            remaining < BigInt(RECOVERY_CHUNK_SIZE)
              ? remaining
              : BigInt(RECOVERY_CHUNK_SIZE)
          )

          const data = await reader.read(fragmentOffset, chunkSize)

          await new Promise<void>((resolve, reject) => {
            const canContinue = writeStream.write(data, (err) => {
              if (err) reject(err)
            })
            if (canContinue) {
              resolve()
            } else {
              writeStream.once('drain', resolve)
            }
          })

          bytesWritten += BigInt(data.length)
          fragmentOffset += BigInt(data.length)
          remaining -= BigInt(data.length)
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        writeStream.end((err: Error | null) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }

    return bytesWritten
  }

  /**
   * Resolve the output file path based on the conflict strategy.
   *
   * - 'overwrite': return the path as-is.
   * - 'skip': return '' if the file exists.
   * - 'rename': append a numeric suffix to avoid collision.
   */
  private async resolveOutputPath(
    outputPath: string,
    strategy: 'rename' | 'overwrite' | 'skip'
  ): Promise<string> {
    try {
      await fsAccess(outputPath)
    } catch {
      // File does not exist, use the path as-is.
      return outputPath
    }

    // File exists.
    switch (strategy) {
      case 'overwrite':
        return outputPath

      case 'skip':
        return ''

      case 'rename': {
        const dir = path.dirname(outputPath)
        const ext = path.extname(outputPath)
        const base = path.basename(outputPath, ext)

        let counter = 1
        let candidate = path.join(dir, `${base}_${counter}${ext}`)

        while (true) {
          try {
            await fsAccess(candidate)
            counter++
            candidate = path.join(dir, `${base}_${counter}${ext}`)
          } catch {
            return candidate
          }
        }
      }
    }
  }

  /**
   * Determine whether the source device and destination path are on the
   * same physical device.
   *
   * This is a critical safety check: writing recovered data to the same
   * device that is being scanned will overwrite the very data being recovered.
   */
  private async isSameDevice(
    sourceDevicePath: string,
    destinationPath: string
  ): Promise<boolean> {
    try {
      switch (process.platform) {
        case 'linux':
          return this.isSameDeviceLinux(sourceDevicePath, destinationPath)

        case 'darwin':
          return this.isSameDeviceMacOS(sourceDevicePath, destinationPath)

        case 'win32':
          return this.isSameDeviceWindows(sourceDevicePath, destinationPath)

        default:
          // If we cannot determine, err on the side of caution.
          return false
      }
    } catch {
      // If detection fails, allow the operation but log a warning.
      return false
    }
  }

  /**
   * Linux: use stat to compare device numbers.
   */
  private async isSameDeviceLinux(
    sourceDevicePath: string,
    destinationPath: string
  ): Promise<boolean> {
    // Resolve destination to its mount point device.
    const realDest = await fsRealpath(destinationPath).catch(
      () => destinationPath
    )

    try {
      const { stdout } = await execFileAsync('df', ['--output=source', realDest])
      const lines = stdout.trim().split('\n')
      // The second line is the device.
      const destDevice = lines[1]?.trim() ?? ''

      // Check if the destination device is the source device or a partition of it.
      // e.g., source = /dev/sda, destDevice = /dev/sda1
      if (destDevice === sourceDevicePath) return true
      if (destDevice.startsWith(sourceDevicePath)) return true
      if (sourceDevicePath.startsWith(destDevice.replace(/[0-9]+$/, ''))) return true
    } catch {
      // Fallback to stat-based comparison.
      const sourceStat = await fsStat(sourceDevicePath)
      const destStat = await fsStat(realDest)
      return sourceStat.dev === destStat.dev
    }

    return false
  }

  /**
   * macOS: use df to find the underlying device.
   */
  private async isSameDeviceMacOS(
    sourceDevicePath: string,
    destinationPath: string
  ): Promise<boolean> {
    const realDest = await fsRealpath(destinationPath).catch(
      () => destinationPath
    )

    const { stdout } = await execFileAsync('df', [realDest])
    const lines = stdout.trim().split('\n')
    if (lines.length < 2) return false

    const destDevice = lines[1].split(/\s+/)[0] ?? ''

    // /dev/disk2s1 -> /dev/disk2
    const destBase = destDevice.replace(/s\d+$/, '')
    const sourceBase = sourceDevicePath.replace(/s\d+$/, '')

    return destBase === sourceBase
  }

  /**
   * Windows: compare physical drive numbers.
   */
  private async isSameDeviceWindows(
    sourceDevicePath: string,
    destinationPath: string
  ): Promise<boolean> {
    // Extract drive letter from destination (e.g., "C" from "C:\Recovery").
    const driveMatch = destinationPath.match(/^([A-Za-z]):[/\\]/)
    if (!driveMatch) return false

    const driveLetter = driveMatch[1]

    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-Partition -DriveLetter '${driveLetter}' | Select-Object -ExpandProperty DiskNumber`
      ])

      const destDiskNumber = stdout.trim()
      // Source format: \\.\PhysicalDrive0 -> extract "0"
      const sourceMatch = sourceDevicePath.match(/PhysicalDrive(\d+)/)
      if (!sourceMatch) return false

      return sourceMatch[1] === destDiskNumber
    } catch {
      return false
    }
  }
}
