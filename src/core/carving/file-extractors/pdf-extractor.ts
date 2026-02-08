/**
 * PDF File Extractor
 *
 * PDF files start with "%PDF-" and end with "%%EOF". A PDF may contain multiple
 * "%%EOF" markers (one per incremental update). We scan for the last "%%EOF"
 * within a reasonable range to determine the true end of the file.
 *
 * Strategy:
 *   1. Validate the %PDF- header.
 *   2. Scan forward for %%EOF markers, recording the position of each.
 *   3. Use the last %%EOF found plus any trailing whitespace/newlines.
 *   4. If no %%EOF is found, estimate based on maximum scan size.
 */

import type { ReadableDevice, FileExtractor, ExtractionResult } from './base-extractor'

/** Maximum PDF file size to scan (500 MB). */
const MAX_SCAN_SIZE = 500 * 1024 * 1024

/** Read chunk size for scanning. */
const SCAN_CHUNK_SIZE = 256 * 1024

/** %%EOF as a byte sequence. */
const EOF_MARKER = Buffer.from('%%EOF', 'ascii')

/** %PDF header. */
const PDF_HEADER = Buffer.from('%PDF', 'ascii')

export class PdfExtractor implements FileExtractor {
  readonly name = 'PDF Extractor'
  readonly supportedTypes = ['pdf'] as const

  async extract(reader: ReadableDevice, offset: bigint): Promise<ExtractionResult> {
    try {
      // Validate header.
      const header = await reader.read(offset, Math.min(8, Number(reader.size - offset)))
      if (header.length < 4 || header.indexOf(PDF_HEADER) !== 0) {
        throw new Error('Invalid PDF header')
      }

      return await this.scanForEOFMarkers(reader, offset)
    } catch {
      // Return a conservative estimate.
      return {
        size: BigInt(SCAN_CHUNK_SIZE),
        estimated: true
      }
    }
  }

  private async scanForEOFMarkers(
    reader: ReadableDevice,
    offset: bigint
  ): Promise<ExtractionResult> {
    const maxPos = Math.min(MAX_SCAN_SIZE, Number(reader.size - offset))
    let pos = 0
    let lastEofEnd = -1

    while (pos < maxPos) {
      const readSize = Math.min(SCAN_CHUNK_SIZE, maxPos - pos)
      if (readSize <= 0) break

      const chunk = await reader.read(offset + BigInt(pos), readSize)
      if (chunk.length === 0) break

      // Search for all %%EOF occurrences in this chunk.
      let searchStart = 0
      while (searchStart < chunk.length) {
        const idx = chunk.indexOf(EOF_MARKER, searchStart)
        if (idx === -1) break

        // %%EOF is 5 bytes. The file may have trailing newlines/whitespace.
        let endPos = pos + idx + EOF_MARKER.length

        // Skip trailing whitespace and newlines after %%EOF.
        // Read a few more bytes to check for trailing content.
        if (endPos < maxPos) {
          const tailSize = Math.min(16, maxPos - endPos)
          try {
            const tail = await reader.read(offset + BigInt(endPos), tailSize)
            let trailingBytes = 0
            for (let i = 0; i < tail.length; i++) {
              const b = tail[i]
              if (b === 0x0a || b === 0x0d || b === 0x20) {
                trailingBytes++
              } else {
                break
              }
            }
            endPos += trailingBytes
          } catch {
            // Ignore read errors for trailing bytes.
          }
        }

        lastEofEnd = endPos
        searchStart = idx + EOF_MARKER.length
      }

      // Advance with overlap to handle %%EOF spanning chunk boundaries.
      pos += chunk.length - (EOF_MARKER.length - 1)
    }

    if (lastEofEnd > 0) {
      return {
        size: BigInt(lastEofEnd),
        estimated: false
      }
    }

    // No %%EOF found - return estimate.
    return {
      size: BigInt(Math.min(maxPos, SCAN_CHUNK_SIZE)),
      estimated: true
    }
  }
}
