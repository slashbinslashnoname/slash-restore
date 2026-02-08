/**
 * JPEG File Extractor
 *
 * Determines JPEG file boundaries by scanning for the FFD9 (End Of Image) marker.
 * JPEG files consist of a series of markers, each starting with 0xFF followed by
 * a marker type byte. Most markers have a 2-byte length field following them.
 *
 * Strategy:
 *   1. Validate the FFD8FF header.
 *   2. Walk through JPEG markers to advance quickly through the file.
 *   3. Look for the FFD9 end-of-image marker.
 *   4. If marker parsing fails, fall back to brute-force scanning for FFD9.
 */

import type { FileMetadata } from '../../../shared/types'
import type { ReadableDevice, FileExtractor, ExtractionResult } from './base-extractor'

/** Maximum JPEG file size to scan (50 MB). */
const MAX_SCAN_SIZE = 50 * 1024 * 1024

/** Read chunk size for scanning. */
const SCAN_CHUNK_SIZE = 64 * 1024

/**
 * Standalone markers (no length field follows them).
 * These are markers 0xD0-0xD9 (RST0-RST7, SOI, EOI) and 0x01 (TEM).
 */
function isStandaloneMarker(markerByte: number): boolean {
  return (markerByte >= 0xd0 && markerByte <= 0xd9) || markerByte === 0x01
}

export class JpegExtractor implements FileExtractor {
  readonly name = 'JPEG Extractor'
  readonly supportedTypes = ['jpeg'] as const

  async extract(reader: ReadableDevice, offset: bigint): Promise<ExtractionResult> {
    try {
      return await this.extractViaMarkerWalk(reader, offset)
    } catch {
      // Marker walk failed, try brute-force scan for FFD9.
      try {
        return await this.extractViaBruteForceScan(reader, offset)
      } catch {
        // Total failure - return a conservative estimate.
        return {
          size: BigInt(SCAN_CHUNK_SIZE),
          estimated: true
        }
      }
    }
  }

  private async extractViaMarkerWalk(
    reader: ReadableDevice,
    offset: bigint
  ): Promise<ExtractionResult> {
    // Read initial header to validate.
    const header = await reader.read(offset, Math.min(16, Number(reader.size - offset)))

    if (header.length < 3 || header[0] !== 0xff || header[1] !== 0xd8 || header[2] !== 0xff) {
      throw new Error('Invalid JPEG header')
    }

    let metadata: FileMetadata | undefined
    let pos = 2 // Skip FFD8, now pointing at the first marker.
    const maxPos = Math.min(MAX_SCAN_SIZE, Number(reader.size - offset))

    while (pos < maxPos) {
      // Read a small chunk to parse the next marker.
      const readSize = Math.min(SCAN_CHUNK_SIZE, maxPos - pos)
      if (readSize < 2) break

      const chunk = await reader.read(offset + BigInt(pos), readSize)
      if (chunk.length < 2) break

      // Find the next 0xFF marker byte.
      let i = 0
      while (i < chunk.length && chunk[i] !== 0xff) {
        i++
      }
      if (i >= chunk.length) {
        pos += chunk.length
        continue
      }

      // Skip padding 0xFF bytes.
      while (i + 1 < chunk.length && chunk[i + 1] === 0xff) {
        i++
      }

      if (i + 1 >= chunk.length) {
        pos += i
        continue
      }

      const markerByte = chunk[i + 1]

      // End of Image marker found.
      if (markerByte === 0xd9) {
        const fileSize = BigInt(pos + i + 2)
        return { size: fileSize, estimated: false, metadata }
      }

      // SOS (Start Of Scan) - after this, entropy-coded data follows.
      // We need to scan byte-by-byte for FFD9 within the scan data.
      if (markerByte === 0xda) {
        if (i + 3 < chunk.length) {
          const sosLength = (chunk[i + 2] << 8) | chunk[i + 3]
          const scanDataStart = pos + i + 2 + sosLength
          return await this.scanForEOI(reader, offset, scanDataStart, metadata)
        }
        // Chunk too small, re-read.
        return await this.scanForEOI(reader, offset, pos + i + 2, metadata)
      }

      if (isStandaloneMarker(markerByte)) {
        pos += i + 2
        continue
      }

      // Regular marker with length field.
      if (i + 3 < chunk.length) {
        const segmentLength = (chunk[i + 2] << 8) | chunk[i + 3]

        // Try to extract EXIF dimensions from SOF markers.
        if (
          !metadata &&
          markerByte >= 0xc0 &&
          markerByte <= 0xcf &&
          markerByte !== 0xc4 &&
          markerByte !== 0xcc
        ) {
          metadata = this.parseSOFMarker(chunk, i + 2, segmentLength)
        }

        pos += i + 2 + segmentLength
      } else {
        // Not enough data to read length; advance and retry.
        pos += i + 2
      }
    }

    // Reached max scan size without finding EOI.
    return {
      size: BigInt(maxPos),
      estimated: true,
      metadata
    }
  }

  /**
   * Scan entropy-coded data for the FFD9 (End Of Image) marker.
   * In JPEG scan data, 0xFF bytes are stuffed: 0xFF 0x00 is a literal 0xFF in
   * the data stream, while 0xFF followed by a non-zero byte is a marker.
   */
  private async scanForEOI(
    reader: ReadableDevice,
    fileOffset: bigint,
    scanStart: number,
    metadata?: FileMetadata
  ): Promise<ExtractionResult> {
    const maxPos = Math.min(MAX_SCAN_SIZE, Number(reader.size - fileOffset))
    let pos = scanStart

    while (pos < maxPos) {
      const readSize = Math.min(SCAN_CHUNK_SIZE, maxPos - pos)
      if (readSize <= 0) break

      const chunk = await reader.read(fileOffset + BigInt(pos), readSize)
      if (chunk.length === 0) break

      for (let i = 0; i < chunk.length - 1; i++) {
        if (chunk[i] === 0xff && chunk[i + 1] === 0xd9) {
          return {
            size: BigInt(pos + i + 2),
            estimated: false,
            metadata
          }
        }
      }

      // Advance, but keep the last byte in case FFD9 spans chunks.
      pos += chunk.length - 1
    }

    return {
      size: BigInt(maxPos),
      estimated: true,
      metadata
    }
  }

  /**
   * Brute-force scan for FFD9 when marker walking fails.
   */
  private async extractViaBruteForceScan(
    reader: ReadableDevice,
    offset: bigint
  ): Promise<ExtractionResult> {
    return this.scanForEOI(reader, offset, 2)
  }

  /**
   * Parse a Start Of Frame marker to extract image dimensions.
   */
  private parseSOFMarker(
    chunk: Buffer,
    markerDataOffset: number,
    length: number
  ): FileMetadata | undefined {
    // SOF structure: length(2) + precision(1) + height(2) + width(2)
    if (length < 7 || markerDataOffset + 7 > chunk.length) {
      return undefined
    }

    const base = markerDataOffset + 2 // skip the length field itself
    if (base + 5 > chunk.length) return undefined

    const height = (chunk[base + 1] << 8) | chunk[base + 2]
    const width = (chunk[base + 3] << 8) | chunk[base + 4]

    if (width > 0 && height > 0 && width <= 65535 && height <= 65535) {
      return { width, height }
    }
    return undefined
  }
}
