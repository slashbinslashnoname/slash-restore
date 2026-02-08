/**
 * PNG File Extractor
 *
 * PNG files are chunk-based. Each chunk has the structure:
 *   [4 bytes length] [4 bytes type] [length bytes data] [4 bytes CRC]
 *
 * The file ends after the IEND chunk. We walk through chunks summing their
 * sizes to determine the total file size.
 *
 * Strategy:
 *   1. Validate the 8-byte PNG signature.
 *   2. Walk chunks: read 8-byte header (length + type), skip length + 4 (CRC).
 *   3. Stop after IEND chunk.
 *   4. Extract dimensions from the IHDR chunk.
 */

import type { FileMetadata } from '../../../shared/types'
import type { ReadableDevice, FileExtractor, ExtractionResult } from './base-extractor'

/** PNG signature: 89 50 4E 47 0D 0A 1A 0A */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Maximum PNG file size to scan (100 MB). */
const MAX_SCAN_SIZE = 100 * 1024 * 1024

/** IEND chunk type as a 4-byte string. */
const IEND_TYPE = 0x49454e44 // 'IEND'

/** IHDR chunk type. */
const IHDR_TYPE = 0x49484452 // 'IHDR'

export class PngExtractor implements FileExtractor {
  readonly name = 'PNG Extractor'
  readonly supportedTypes = ['png'] as const

  async extract(reader: ReadableDevice, offset: bigint): Promise<ExtractionResult> {
    try {
      return await this.extractViaChunkWalk(reader, offset)
    } catch {
      // Chunk walking failed - fall back to scanning for the IEND footer.
      try {
        return await this.extractViaFooterScan(reader, offset)
      } catch {
        return {
          size: 65536n,
          estimated: true
        }
      }
    }
  }

  private async extractViaChunkWalk(
    reader: ReadableDevice,
    offset: bigint
  ): Promise<ExtractionResult> {
    // Read and validate the PNG signature.
    const sigBuf = await reader.read(offset, 8)
    if (sigBuf.length < 8 || !sigBuf.equals(PNG_SIGNATURE)) {
      throw new Error('Invalid PNG signature')
    }

    let metadata: FileMetadata | undefined
    let pos = 8 // Start after the signature.
    const maxPos = Math.min(MAX_SCAN_SIZE, Number(reader.size - offset))

    while (pos < maxPos) {
      // Each chunk: 4 bytes length + 4 bytes type + data + 4 bytes CRC.
      const chunkHeader = await reader.read(offset + BigInt(pos), 8)
      if (chunkHeader.length < 8) {
        // Truncated file - return what we have.
        return {
          size: BigInt(pos),
          estimated: true,
          metadata
        }
      }

      const dataLength = chunkHeader.readUInt32BE(0)
      const chunkType = chunkHeader.readUInt32BE(4)

      // Sanity check: chunk data length shouldn't exceed remaining scan space.
      const chunkTotalSize = 4 + 4 + dataLength + 4 // length + type + data + CRC
      if (dataLength > MAX_SCAN_SIZE || pos + chunkTotalSize > maxPos + 12) {
        // Corrupted chunk length - return estimate.
        return {
          size: BigInt(pos),
          estimated: true,
          metadata
        }
      }

      // Extract IHDR metadata (first chunk, always 13 bytes of data).
      if (chunkType === IHDR_TYPE && dataLength >= 8) {
        const ihdrData = await reader.read(offset + BigInt(pos + 8), Math.min(13, dataLength))
        if (ihdrData.length >= 8) {
          const width = ihdrData.readUInt32BE(0)
          const height = ihdrData.readUInt32BE(4)
          if (width > 0 && width <= 100000 && height > 0 && height <= 100000) {
            metadata = { width, height }
          }
        }
      }

      // Advance past this chunk.
      pos += chunkTotalSize

      // IEND marks end of file.
      if (chunkType === IEND_TYPE) {
        return {
          size: BigInt(pos),
          estimated: false,
          metadata
        }
      }
    }

    // Reached max scan size without finding IEND.
    return {
      size: BigInt(pos),
      estimated: true,
      metadata
    }
  }

  /**
   * Fallback: scan for the IEND chunk footer bytes.
   * The IEND chunk is always: 00 00 00 00 49 45 4E 44 AE 42 60 82
   * (length=0, type=IEND, CRC=AE426082)
   */
  private async extractViaFooterScan(
    reader: ReadableDevice,
    offset: bigint
  ): Promise<ExtractionResult> {
    const footer = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
    const chunkSize = 64 * 1024
    const maxPos = Math.min(MAX_SCAN_SIZE, Number(reader.size - offset))
    let pos = 8 // Skip the signature.

    while (pos < maxPos) {
      const readSize = Math.min(chunkSize, maxPos - pos)
      const chunk = await reader.read(offset + BigInt(pos), readSize)
      if (chunk.length === 0) break

      const idx = chunk.indexOf(footer)
      if (idx !== -1) {
        // File ends after the IEND CRC.
        const fileSize = BigInt(pos + idx + footer.length)
        return {
          size: fileSize,
          estimated: false
        }
      }

      // Keep overlap to handle footer spanning chunks.
      pos += chunk.length - (footer.length - 1)
    }

    return {
      size: BigInt(maxPos),
      estimated: true
    }
  }
}
