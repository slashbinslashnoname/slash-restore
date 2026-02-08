/**
 * AVI File Extractor
 *
 * AVI files use the RIFF container format:
 *   [4 bytes "RIFF"] [4 bytes file size (little-endian, excludes first 8 bytes)]
 *   [4 bytes "AVI "] [data...]
 *
 * The file size is encoded directly in the RIFF header at bytes 4-7 as a
 * 32-bit little-endian integer. This gives us the exact file size without
 * needing to parse the internal structure.
 *
 * Note: For files > 4 GB, AVI uses an extension called AVIX / OpenDML
 * which adds RIFF-AVIX chunks. We handle this by also scanning for
 * subsequent RIFF-AVIX chunks after the initial RIFF-AVI chunk.
 */

import type { FileMetadata } from '../../../shared/types'
import type { ReadableDevice, FileExtractor, ExtractionResult } from './base-extractor'

/** Maximum AVI file size to consider (10 GB). */
const MAX_SCAN_SIZE = 10n * 1024n * 1024n * 1024n

export class AviExtractor implements FileExtractor {
  readonly name = 'AVI Extractor'
  readonly supportedTypes = ['avi'] as const

  async extract(reader: ReadableDevice, offset: bigint): Promise<ExtractionResult> {
    try {
      return await this.extractFromRiffHeader(reader, offset)
    } catch {
      return {
        size: 65536n,
        estimated: true
      }
    }
  }

  private async extractFromRiffHeader(
    reader: ReadableDevice,
    offset: bigint
  ): Promise<ExtractionResult> {
    // Read the RIFF header: "RIFF" + size(4) + "AVI " = 12 bytes.
    const header = await reader.read(offset, Math.min(12, Number(reader.size - offset)))
    if (header.length < 12) {
      throw new Error('Too small for AVI')
    }

    // Validate RIFF magic.
    const riffMagic = header.subarray(0, 4).toString('ascii')
    if (riffMagic !== 'RIFF') {
      throw new Error('Not a RIFF file')
    }

    // Read the file size (little-endian 32-bit).
    // This value does NOT include the 8-byte RIFF header itself.
    const riffDataSize = header.readUInt32LE(4)

    // Validate AVI form type.
    const formType = header.subarray(8, 12).toString('ascii')
    if (formType !== 'AVI ' && formType !== 'AVIX') {
      throw new Error('Not an AVI file (form type: ' + formType + ')')
    }

    // Total size = 8 (RIFF header) + riffDataSize.
    let totalSize = BigInt(riffDataSize) + 8n

    // Sanity check.
    if (totalSize < 12n || totalSize > MAX_SCAN_SIZE) {
      return {
        size: totalSize < 12n ? 65536n : MAX_SCAN_SIZE,
        estimated: true
      }
    }

    // Check for RIFF-AVIX extension chunks (OpenDML for files > 2GB).
    let metadata: FileMetadata | undefined

    // Try to extract metadata from the AVI header list.
    try {
      metadata = await this.parseAviHeader(reader, offset)
    } catch {
      // Non-critical.
    }

    // Look for AVIX chunks after the main RIFF-AVI chunk.
    try {
      totalSize = await this.scanForAvixChunks(reader, offset, totalSize)
    } catch {
      // Non-critical - just use the main chunk size.
    }

    return {
      size: totalSize,
      estimated: false,
      metadata
    }
  }

  /**
   * Scan for additional RIFF-AVIX chunks after the main RIFF-AVI chunk.
   * Each AVIX chunk has the same structure: RIFF + size(4) + AVIX.
   */
  private async scanForAvixChunks(
    reader: ReadableDevice,
    baseOffset: bigint,
    currentSize: bigint
  ): Promise<bigint> {
    let totalSize = currentSize
    const maxSize = bigintMin(MAX_SCAN_SIZE, reader.size - baseOffset)

    // Check up to 10 AVIX chunks (practical limit).
    for (let i = 0; i < 10; i++) {
      if (totalSize + 12n > maxSize) break

      const header = await reader.read(baseOffset + totalSize, 12)
      if (header.length < 12) break

      const magic = header.subarray(0, 4).toString('ascii')
      const chunkSize = header.readUInt32LE(4)
      const formType = header.subarray(8, 12).toString('ascii')

      if (magic !== 'RIFF' || formType !== 'AVIX') break

      totalSize += BigInt(chunkSize) + 8n
    }

    return totalSize
  }

  /**
   * Parse the AVI main header (avih) to extract video dimensions.
   * The avih chunk is inside the hdrl LIST chunk.
   */
  private async parseAviHeader(
    reader: ReadableDevice,
    offset: bigint
  ): Promise<FileMetadata | undefined> {
    // Read a larger chunk to find the avih header.
    // hdrl LIST is typically within the first 4KB.
    const data = await reader.read(offset + 12n, Math.min(4096, Number(reader.size - offset - 12n)))

    // Search for 'avih' chunk type.
    const avihMarker = Buffer.from('avih', 'ascii')
    const idx = data.indexOf(avihMarker)
    if (idx === -1) return undefined

    // avih structure (after the chunk header):
    //   offset 0: microseconds per frame (4)
    //   offset 4: max bytes per sec (4)
    //   ...
    //   offset 32: width (4, LE)
    //   offset 36: height (4, LE)
    const avihDataStart = idx + 8 // skip 'avih' + size(4)
    if (avihDataStart + 40 > data.length) return undefined

    const width = data.readUInt32LE(avihDataStart + 32)
    const height = data.readUInt32LE(avihDataStart + 36)

    if (width > 0 && width <= 16384 && height > 0 && height <= 16384) {
      return { width, height }
    }

    return undefined
  }
}

function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}
