/**
 * HEIC File Extractor
 *
 * HEIC uses the same ISO BMFF box structure as MP4. The key difference is the
 * ftyp brand, which should be 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis',
 * 'hevm', 'hevs', or 'mif1'.
 *
 * Because the HEIC signature header (0x00 0x00 0x00) is too generic, the
 * carving engine relies on the file extractor to differentiate HEIC from other
 * files. This extractor validates the ftyp brand before proceeding with
 * ISO BMFF box walking.
 *
 * Strategy:
 *   1. Read the ftyp box and validate the brand.
 *   2. Walk top-level boxes to determine total file size (same as MP4).
 *   3. Extract dimensions from the ispe (image spatial extents) property.
 */

import type { FileMetadata } from '../../../shared/types'
import type { ReadableDevice, FileExtractor, ExtractionResult } from './base-extractor'

/** Maximum HEIC file size to walk (200 MB). */
const MAX_SCAN_SIZE = 200n * 1024n * 1024n

/** Known HEIC ftyp brands. */
const HEIC_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx',
  'heim', 'heis', 'hevm', 'hevs',
  'mif1', 'msf1', 'avif', 'avis'
])

/** Known top-level box types. */
const KNOWN_TOP_LEVEL_BOXES = new Set([
  'ftyp', 'meta', 'mdat', 'free', 'skip', 'moov', 'wide', 'uuid'
])

export class HeicExtractor implements FileExtractor {
  readonly name = 'HEIC Extractor'
  readonly supportedTypes = ['heic'] as const

  async extract(reader: ReadableDevice, offset: bigint): Promise<ExtractionResult> {
    try {
      return await this.extractViaBoxWalk(reader, offset)
    } catch {
      return {
        size: 65536n,
        estimated: true
      }
    }
  }

  private async extractViaBoxWalk(
    reader: ReadableDevice,
    offset: bigint
  ): Promise<ExtractionResult> {
    // Read ftyp box header.
    const header = await reader.read(offset, Math.min(32, Number(reader.size - offset)))
    if (header.length < 12) {
      throw new Error('Too small for HEIC')
    }

    const ftypSize = header.readUInt32BE(0)
    const ftypType = header.subarray(4, 8).toString('ascii')

    if (ftypType !== 'ftyp') {
      throw new Error('First box is not ftyp')
    }

    // Validate brand (major brand is at bytes 8-11).
    const majorBrand = header.subarray(8, 12).toString('ascii').trim()
    if (!HEIC_BRANDS.has(majorBrand)) {
      // Also check compatible brands within the ftyp box.
      const isHeic = await this.checkCompatibleBrands(reader, offset, ftypSize)
      if (!isHeic) {
        throw new Error('Not a HEIC file (brand: ' + majorBrand + ')')
      }
    }

    let metadata: FileMetadata | undefined
    let pos = 0n
    const maxPos = bigintMin(MAX_SCAN_SIZE, reader.size - offset)

    while (pos < maxPos) {
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

      // Box to end of file.
      if (boxSize === 0n) {
        return { size: maxPos, estimated: true, metadata }
      }

      // Sanity check.
      if (boxSize < 8n) {
        if (pos > 0n) {
          return { size: pos, estimated: true, metadata }
        }
        throw new Error('Invalid box size')
      }

      // Validate box type.
      if (!this.isValidBoxType(boxType)) {
        if (pos > 0n) {
          return { size: pos, estimated: true, metadata }
        }
        throw new Error('Invalid box type')
      }

      // Try to extract metadata from the meta box.
      if (boxType === 'meta' && !metadata && boxSize <= 10n * 1024n * 1024n) {
        try {
          metadata = await this.parseMetaBox(reader, offset + pos, Number(boxSize))
        } catch {
          // Non-critical.
        }
      }

      pos += boxSize
    }

    if (pos > 0n) {
      return { size: pos, estimated: false, metadata }
    }

    throw new Error('No valid boxes found')
  }

  /**
   * Check compatible brands in the ftyp box for HEIC-related brands.
   */
  private async checkCompatibleBrands(
    reader: ReadableDevice,
    offset: bigint,
    ftypSize: number
  ): Promise<boolean> {
    if (ftypSize < 16 || ftypSize > 256) return false

    const ftypData = await reader.read(offset, ftypSize)
    // Compatible brands start at offset 16 (after size(4) + type(4) + major(4) + version(4)).
    for (let i = 16; i + 4 <= ftypData.length; i += 4) {
      const brand = ftypData.subarray(i, i + 4).toString('ascii').trim()
      if (HEIC_BRANDS.has(brand)) return true
    }
    return false
  }

  /**
   * Parse the meta box to find image spatial extents (ispe property).
   */
  private async parseMetaBox(
    reader: ReadableDevice,
    metaOffset: bigint,
    metaSize: number
  ): Promise<FileMetadata | undefined> {
    const readSize = Math.min(metaSize, 512 * 1024)
    const data = await reader.read(metaOffset + 8n, readSize - 8)

    // Search for 'ispe' property (image spatial extents).
    const ispeMarker = Buffer.from('ispe', 'ascii')
    const idx = data.indexOf(ispeMarker)
    if (idx === -1 || idx + 12 > data.length) return undefined

    // ispe: version(1) + flags(3) + width(4) + height(4)
    const dataStart = idx + 4 // after 'ispe'
    if (dataStart + 12 > data.length) return undefined

    // Skip version (1 byte) and flags (3 bytes).
    const width = data.readUInt32BE(dataStart + 4)
    const height = data.readUInt32BE(dataStart + 8)

    if (width > 0 && width <= 65535 && height > 0 && height <= 65535) {
      return { width, height }
    }

    return undefined
  }

  private isValidBoxType(type: string): boolean {
    for (let i = 0; i < type.length; i++) {
      const code = type.charCodeAt(i)
      if (code < 0x20 || code > 0x7e) return false
    }
    return true
  }
}

function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}
