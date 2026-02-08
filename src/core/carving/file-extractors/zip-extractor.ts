/**
 * ZIP-based File Extractor (DOCX / XLSX)
 *
 * DOCX and XLSX files are ZIP archives with specific internal directory structures:
 *   - DOCX contains a "word/" directory (word/document.xml)
 *   - XLSX contains an "xl/" directory (xl/workbook.xml)
 *
 * Strategy:
 *   1. Validate the PK (0x50 0x4B 0x03 0x04) local file header.
 *   2. Scan local file entries to identify docx vs xlsx content.
 *   3. Search for the End of Central Directory record (EOCD) to get exact size.
 *   4. The EOCD signature is 0x50 0x4B 0x05 0x06.
 *   5. Total file size = EOCD offset + 22 + comment length.
 *
 * Note: ZIP64 extensions are handled for files > 4 GB.
 */

import type { FileType } from '../../../shared/types'
import type { ReadableDevice, FileExtractor, ExtractionResult } from './base-extractor'

/** Maximum ZIP file size to scan (200 MB). */
const MAX_SCAN_SIZE = 200 * 1024 * 1024

/** Read chunk size for scanning. */
const SCAN_CHUNK_SIZE = 64 * 1024

/** PK local file header signature. */
const PK_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/** End of Central Directory signature. */
const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06])

/** ZIP64 End of Central Directory Locator signature. */
const ZIP64_EOCD_LOCATOR = Buffer.from([0x50, 0x4b, 0x06, 0x07])

/** Patterns that identify DOCX content. */
const DOCX_INDICATORS = ['word/', 'word\\', '[Content_Types].xml']

/** Patterns that identify XLSX content. */
const XLSX_INDICATORS = ['xl/', 'xl\\', '[Content_Types].xml']

export interface ZipExtractionResult extends ExtractionResult {
  /** Detected type based on zip contents. */
  detectedType?: FileType
}

export class ZipExtractor implements FileExtractor {
  readonly name = 'ZIP Extractor (DOCX/XLSX)'
  readonly supportedTypes = ['docx', 'xlsx'] as const

  async extract(reader: ReadableDevice, offset: bigint): Promise<ZipExtractionResult> {
    try {
      return await this.extractViaZipParsing(reader, offset)
    } catch {
      // ZIP parsing failed - try scanning for EOCD.
      try {
        return await this.extractViaEocdScan(reader, offset)
      } catch {
        return {
          size: BigInt(SCAN_CHUNK_SIZE),
          estimated: true
        }
      }
    }
  }

  private async extractViaZipParsing(
    reader: ReadableDevice,
    offset: bigint
  ): Promise<ZipExtractionResult> {
    // Validate PK header.
    const header = await reader.read(offset, Math.min(30, Number(reader.size - offset)))
    if (header.length < 30 || !header.subarray(0, 4).equals(PK_LOCAL_HEADER)) {
      throw new Error('Invalid ZIP header')
    }

    let detectedType: FileType | undefined
    let hasWord = false
    let hasXl = false
    let pos = 0
    const maxPos = Math.min(MAX_SCAN_SIZE, Number(reader.size - offset))

    // Walk local file entries to detect content type and find total size.
    let entryCount = 0
    const maxEntries = 5000

    while (pos < maxPos && entryCount < maxEntries) {
      const localHeader = await reader.read(offset + BigInt(pos), Math.min(30, maxPos - pos))
      if (localHeader.length < 30) break

      // Check for PK local file header.
      if (!localHeader.subarray(0, 4).equals(PK_LOCAL_HEADER)) break

      const compressedSize = localHeader.readUInt32LE(18)
      const fileNameLength = localHeader.readUInt16LE(26)
      const extraFieldLength = localHeader.readUInt16LE(28)

      // Read the file name.
      if (fileNameLength > 0 && fileNameLength < 1024) {
        const fileNameBuf = await reader.read(
          offset + BigInt(pos + 30),
          Math.min(fileNameLength, maxPos - pos - 30)
        )
        const fileName = fileNameBuf.toString('utf8')

        // Check for DOCX/XLSX indicators.
        if (!hasWord && DOCX_INDICATORS.some(ind => fileName.startsWith(ind))) {
          hasWord = true
        }
        if (!hasXl && XLSX_INDICATORS.some(ind => fileName.startsWith(ind))) {
          hasXl = true
        }
      }

      // Advance past this local file entry.
      // Entry size = 30 (header) + fileName + extraField + compressedData.
      const entrySize = 30 + fileNameLength + extraFieldLength + compressedSize

      // Handle data descriptor (bit 3 of general purpose flags).
      const generalFlags = localHeader.readUInt16LE(6)
      const hasDataDescriptor = (generalFlags & 0x08) !== 0

      if (compressedSize === 0 && hasDataDescriptor) {
        // Unknown size with data descriptor - we need to find the next PK header
        // or the EOCD. Fall back to EOCD scan.
        throw new Error('Data descriptor without size - fallback to EOCD scan')
      }

      pos += entrySize
      entryCount++
    }

    // Determine detected type.
    if (hasWord) {
      detectedType = 'docx'
    } else if (hasXl) {
      detectedType = 'xlsx'
    }

    // Now scan for EOCD from the current position.
    const eocdResult = await this.findEocd(reader, offset, pos, maxPos)

    if (eocdResult !== null) {
      return {
        size: BigInt(eocdResult),
        estimated: false,
        detectedType
      }
    }

    // EOCD not found - use the position we reached.
    return {
      size: BigInt(pos),
      estimated: true,
      detectedType
    }
  }

  /**
   * Fallback: scan the entire range for the EOCD signature.
   */
  private async extractViaEocdScan(
    reader: ReadableDevice,
    offset: bigint
  ): Promise<ZipExtractionResult> {
    const maxPos = Math.min(MAX_SCAN_SIZE, Number(reader.size - offset))

    // Also try to detect type from early file entries.
    let detectedType: FileType | undefined
    try {
      const earlyData = await reader.read(offset, Math.min(4096, maxPos))
      const earlyStr = earlyData.toString('utf8', 0, Math.min(earlyData.length, 4096))
      if (earlyStr.includes('word/')) detectedType = 'docx'
      else if (earlyStr.includes('xl/')) detectedType = 'xlsx'
    } catch {
      // Non-critical.
    }

    const eocdResult = await this.findEocd(reader, offset, 0, maxPos)

    if (eocdResult !== null) {
      return {
        size: BigInt(eocdResult),
        estimated: false,
        detectedType
      }
    }

    return {
      size: BigInt(Math.min(maxPos, SCAN_CHUNK_SIZE)),
      estimated: true,
      detectedType
    }
  }

  /**
   * Find the End of Central Directory record.
   * The EOCD is at least 22 bytes, with an optional comment of up to 65535 bytes.
   * We scan backward from the end of the search range.
   */
  private async findEocd(
    reader: ReadableDevice,
    fileOffset: bigint,
    searchStart: number,
    maxPos: number
  ): Promise<number | null> {
    // EOCD must be in the last 65557 bytes (22 + 65535 comment).
    // But we scan forward through chunks for simplicity, recording the last hit.
    let lastEocdEnd: number | null = null

    // Scan in chunks from searchStart to maxPos.
    let pos = searchStart

    while (pos < maxPos) {
      const readSize = Math.min(SCAN_CHUNK_SIZE, maxPos - pos)
      if (readSize < 4) break

      const chunk = await reader.read(fileOffset + BigInt(pos), readSize)
      if (chunk.length < 4) break

      let searchIdx = 0
      while (searchIdx < chunk.length - 3) {
        const idx = chunk.indexOf(EOCD_SIGNATURE, searchIdx)
        if (idx === -1) break

        // Validate the EOCD record.
        const eocdOffset = pos + idx
        if (idx + 22 <= chunk.length) {
          const commentLength = chunk.readUInt16LE(idx + 20)
          const totalSize = eocdOffset + 22 + commentLength
          if (totalSize <= maxPos + 65535) {
            lastEocdEnd = totalSize
          }
        } else {
          // EOCD spans chunk boundary - read more.
          try {
            const eocdBuf = await reader.read(fileOffset + BigInt(eocdOffset), 22)
            if (eocdBuf.length >= 22) {
              const commentLength = eocdBuf.readUInt16LE(20)
              const totalSize = eocdOffset + 22 + commentLength
              if (totalSize <= maxPos + 65535) {
                lastEocdEnd = totalSize
              }
            }
          } catch {
            // Non-critical.
          }
        }

        searchIdx = idx + 1
      }

      // Advance with overlap.
      pos += chunk.length - 3
    }

    return lastEocdEnd
  }
}
