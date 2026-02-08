/**
 * MP4/MOV File Extractor (ISO Base Media File Format / BMFF)
 *
 * MP4 and MOV files are structured as a sequence of "boxes" (also called "atoms").
 * Each box has a 4-byte size followed by a 4-byte type. If size == 1, an 8-byte
 * extended size follows. If size == 0, the box extends to the end of the file.
 *
 * Strategy:
 *   1. Validate the ftyp box at the start.
 *   2. Walk top-level boxes summing their sizes.
 *   3. The file ends after the last top-level box.
 *   4. Extract metadata from moov/trak boxes if accessible.
 */

import type { FileMetadata } from '../../../shared/types'
import type { ReadableDevice, FileExtractor, ExtractionResult } from './base-extractor'

/** Maximum file size to walk (10 GB). */
const MAX_SCAN_SIZE = 10n * 1024n * 1024n * 1024n

/** Known MP4 ftyp brands. */
const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6',
  'mp41', 'mp42', 'mp71',
  'avc1', 'M4V ', 'M4A ', 'M4P ', 'f4v ', 'f4a ',
  'dash', 'msdh', 'msix'
])

/** Known MOV ftyp brands. */
const MOV_BRANDS = new Set(['qt  '])

/** Known top-level box types (for validation). */
const KNOWN_TOP_LEVEL_BOXES = new Set([
  'ftyp', 'moov', 'mdat', 'free', 'skip', 'pdin',
  'moof', 'mfra', 'meta', 'styp', 'sidx', 'ssix',
  'prft', 'wide', 'uuid'
])

export class Mp4Extractor implements FileExtractor {
  readonly name = 'MP4/MOV Extractor'
  readonly supportedTypes = ['mp4', 'mov'] as const

  async extract(reader: ReadableDevice, offset: bigint): Promise<ExtractionResult> {
    try {
      return await this.extractViaBoxWalk(reader, offset)
    } catch {
      // Box walk failed - try to estimate from ftyp box alone.
      try {
        return await this.estimateFromFtyp(reader, offset)
      } catch {
        return {
          size: 65536n,
          estimated: true
        }
      }
    }
  }

  private async extractViaBoxWalk(
    reader: ReadableDevice,
    offset: bigint
  ): Promise<ExtractionResult> {
    // Read and validate the ftyp box.
    const header = await reader.read(offset, Math.min(32, Number(reader.size - offset)))
    if (header.length < 8) {
      throw new Error('Too small for MP4')
    }

    const firstBoxSize = header.readUInt32BE(0)
    const firstBoxType = header.subarray(4, 8).toString('ascii')

    if (firstBoxType !== 'ftyp') {
      throw new Error('First box is not ftyp')
    }

    let metadata: FileMetadata | undefined
    let pos = 0n
    const maxPos = bigintMin(MAX_SCAN_SIZE, reader.size - offset)
    let consecutiveUnknown = 0

    while (pos < maxPos) {
      // Read box header.
      const remaining = Number(maxPos - pos)
      if (remaining < 8) break

      const boxHeader = await reader.read(offset + pos, Math.min(16, remaining))
      if (boxHeader.length < 8) break

      let boxSize = BigInt(boxHeader.readUInt32BE(0))
      const boxType = boxHeader.subarray(4, 8).toString('ascii')

      // Extended size.
      if (boxSize === 1n) {
        if (boxHeader.length < 16) break
        boxSize = boxHeader.readBigUInt64BE(8)
      }

      // Box extends to end of file.
      if (boxSize === 0n) {
        // This box extends to the end - we can't determine total file size
        // just from structure. Use the remaining device space up to max.
        return {
          size: maxPos,
          estimated: true,
          metadata
        }
      }

      // Sanity check: box size must be at least 8 bytes.
      if (boxSize < 8n) {
        // Corrupted - return what we have.
        if (pos > 0n) {
          return { size: pos, estimated: true, metadata }
        }
        throw new Error('Invalid box size')
      }

      // Validate box type - should be printable ASCII.
      if (!this.isValidBoxType(boxType)) {
        if (pos > 0n) {
          return { size: pos, estimated: true, metadata }
        }
        throw new Error('Invalid box type')
      }

      // Track unknown boxes to detect end of file.
      if (!KNOWN_TOP_LEVEL_BOXES.has(boxType)) {
        consecutiveUnknown++
        if (consecutiveUnknown > 2) {
          // Likely past the end of the file.
          return { size: pos, estimated: true, metadata }
        }
      } else {
        consecutiveUnknown = 0
      }

      // Try to extract metadata from moov box (just dimensions for now).
      if (boxType === 'moov' && !metadata && boxSize <= 10n * 1024n * 1024n) {
        try {
          metadata = await this.parseMovieBox(reader, offset + pos, Number(boxSize))
        } catch {
          // Non-critical - continue without metadata.
        }
      }

      pos += boxSize
    }

    if (pos > 0n) {
      return {
        size: pos,
        estimated: false,
        metadata
      }
    }

    throw new Error('No valid boxes found')
  }

  /**
   * Fallback: use just the ftyp box size as a minimum, then try to read the next
   * box to get a better estimate.
   */
  private async estimateFromFtyp(
    reader: ReadableDevice,
    offset: bigint
  ): Promise<ExtractionResult> {
    const header = await reader.read(offset, 8)
    if (header.length < 8) {
      throw new Error('Cannot read ftyp header')
    }

    const ftypSize = BigInt(header.readUInt32BE(0))
    if (ftypSize < 8n || ftypSize > 1024n) {
      throw new Error('Invalid ftyp size')
    }

    // Try to read the box after ftyp.
    const nextHeader = await reader.read(offset + ftypSize, 8)
    if (nextHeader.length >= 8) {
      const nextSize = BigInt(nextHeader.readUInt32BE(0))
      const nextType = nextHeader.subarray(4, 8).toString('ascii')

      if (nextType === 'moov' || nextType === 'mdat' || nextType === 'free') {
        return {
          size: ftypSize + nextSize,
          estimated: true
        }
      }
    }

    return {
      size: ftypSize,
      estimated: true
    }
  }

  /**
   * Attempt to parse the moov box for video dimensions.
   * We look for tkhd (track header) boxes which contain width/height.
   */
  private async parseMovieBox(
    reader: ReadableDevice,
    moovOffset: bigint,
    moovSize: number
  ): Promise<FileMetadata | undefined> {
    // Read the moov box content (skip the 8-byte box header).
    const readSize = Math.min(moovSize, 1024 * 1024) // Limit to 1MB
    const data = await reader.read(moovOffset + 8n, readSize - 8)

    // Search for 'tkhd' box within moov content.
    const tkhdMarker = Buffer.from('tkhd', 'ascii')
    const idx = data.indexOf(tkhdMarker)
    if (idx === -1 || idx + 84 > data.length) return undefined

    // tkhd version 0: width at offset 76, height at offset 80 (from box type).
    // tkhd version 1: width at offset 88, height at offset 92 (from box type).
    const version = idx >= 4 ? data[idx + 4] : 0
    const widthOffset = version === 1 ? idx + 88 : idx + 76
    const heightOffset = version === 1 ? idx + 92 : idx + 80

    if (heightOffset + 4 > data.length) return undefined

    // Width and height are 16.16 fixed-point numbers.
    const width = data.readUInt32BE(widthOffset) >> 16
    const height = data.readUInt32BE(heightOffset) >> 16

    if (width > 0 && width <= 16384 && height > 0 && height <= 16384) {
      return { width, height }
    }

    return undefined
  }

  private isValidBoxType(type: string): boolean {
    for (let i = 0; i < type.length; i++) {
      const code = type.charCodeAt(i)
      // Printable ASCII: 0x20 (space) through 0x7E (~).
      if (code < 0x20 || code > 0x7e) return false
    }
    return true
  }
}

function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}
