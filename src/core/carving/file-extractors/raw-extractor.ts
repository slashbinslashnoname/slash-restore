/**
 * RAW Image File Extractor (CR2 / NEF / ARW)
 *
 * RAW camera files are based on the TIFF format. They use Image File Directory
 * (IFD) structures to describe image data locations and sizes. The approach:
 *
 *   1. Parse the TIFF header to determine byte order and first IFD offset.
 *   2. Walk IFD entries to find StripOffsets/StripByteCounts or
 *      TileOffsets/TileByteCounts tags.
 *   3. Compute file size as max(offset + length) across all strips/tiles and
 *      across all IFDs (including sub-IFDs).
 *
 * For CR2: The TIFF header is little-endian (II), followed by a CR2-specific
 * magic at offset 8 (CR, version).
 * For NEF: The TIFF header is big-endian (MM).
 * For ARW: Similar to CR2 (little-endian TIFF).
 */

import type { FileMetadata } from '../../../shared/types'
import type { ReadableDevice, FileExtractor, ExtractionResult } from './base-extractor'

/** Maximum RAW file size to scan (150 MB). */
const MAX_SCAN_SIZE = 150 * 1024 * 1024

/** TIFF tag IDs relevant to size computation. */
const enum TiffTag {
  ImageWidth = 0x0100,
  ImageLength = 0x0101,
  StripOffsets = 0x0111,
  StripByteCounts = 0x0117,
  TileOffsets = 0x0144,
  TileByteCounts = 0x0145,
  SubIFDs = 0x014a,
  ExifIFD = 0x8769,
  DateTimeOriginal = 0x9003,
  Make = 0x010f,
  Model = 0x0110
}

export class RawExtractor implements FileExtractor {
  readonly name = 'RAW Image Extractor'
  readonly supportedTypes = ['cr2', 'nef', 'arw'] as const

  async extract(reader: ReadableDevice, offset: bigint): Promise<ExtractionResult> {
    try {
      return await this.extractViaTiffParsing(reader, offset)
    } catch {
      // TIFF parsing failed - return a conservative estimate.
      return {
        size: BigInt(10 * 1024 * 1024), // 10 MB estimate
        estimated: true
      }
    }
  }

  private async extractViaTiffParsing(
    reader: ReadableDevice,
    offset: bigint
  ): Promise<ExtractionResult> {
    // Read TIFF header: byte order (2) + magic (2) + first IFD offset (4) = 8 bytes.
    const header = await reader.read(offset, Math.min(16, Number(reader.size - offset)))
    if (header.length < 8) {
      throw new Error('Too small for TIFF')
    }

    // Determine byte order.
    const byteOrder = header.subarray(0, 2).toString('ascii')
    let littleEndian: boolean
    if (byteOrder === 'II') {
      littleEndian = true
    } else if (byteOrder === 'MM') {
      littleEndian = false
    } else {
      throw new Error('Invalid TIFF byte order: ' + byteOrder)
    }

    // Validate TIFF magic number (42).
    const magic = littleEndian ? header.readUInt16LE(2) : header.readUInt16BE(2)
    if (magic !== 42) {
      throw new Error('Invalid TIFF magic: ' + magic)
    }

    // Get first IFD offset.
    const firstIfdOffset = littleEndian ? header.readUInt32LE(4) : header.readUInt32BE(4)

    if (firstIfdOffset === 0 || firstIfdOffset > MAX_SCAN_SIZE) {
      throw new Error('Invalid first IFD offset: ' + firstIfdOffset)
    }

    let maxExtent = BigInt(firstIfdOffset)
    let metadata: FileMetadata | undefined

    // Track visited IFD offsets to prevent infinite loops.
    const visitedIfds = new Set<number>()

    // Walk IFD chain.
    let ifdOffset = firstIfdOffset
    let ifdCount = 0
    const maxIfds = 20 // Reasonable limit.

    while (ifdOffset > 0 && ifdOffset < MAX_SCAN_SIZE && ifdCount < maxIfds) {
      if (visitedIfds.has(ifdOffset)) break
      visitedIfds.add(ifdOffset)

      const result = await this.parseIFD(
        reader,
        offset,
        ifdOffset,
        littleEndian,
        visitedIfds
      )

      if (result.maxExtent > maxExtent) {
        maxExtent = result.maxExtent
      }

      if (!metadata && result.metadata) {
        metadata = result.metadata
      }

      ifdOffset = result.nextIfdOffset
      ifdCount++
    }

    // The file size is at least maxExtent bytes from the start.
    if (maxExtent <= 8n) {
      throw new Error('Could not determine file extent')
    }

    return {
      size: maxExtent,
      estimated: true, // TIFF-based sizes are inherently estimates.
      metadata
    }
  }

  private async parseIFD(
    reader: ReadableDevice,
    fileOffset: bigint,
    ifdOffset: number,
    littleEndian: boolean,
    visitedIfds: Set<number>
  ): Promise<{
    maxExtent: bigint
    nextIfdOffset: number
    metadata?: FileMetadata
  }> {
    // Read IFD entry count.
    const countBuf = await reader.read(fileOffset + BigInt(ifdOffset), 2)
    if (countBuf.length < 2) {
      return { maxExtent: BigInt(ifdOffset + 2), nextIfdOffset: 0 }
    }

    const entryCount = littleEndian ? countBuf.readUInt16LE(0) : countBuf.readUInt16BE(0)

    if (entryCount === 0 || entryCount > 500) {
      return { maxExtent: BigInt(ifdOffset + 2), nextIfdOffset: 0 }
    }

    // Each IFD entry is 12 bytes. Read all entries + 4 bytes for next IFD pointer.
    const ifdSize = entryCount * 12 + 4
    const ifdData = await reader.read(fileOffset + BigInt(ifdOffset + 2), ifdSize)
    if (ifdData.length < ifdSize) {
      return { maxExtent: BigInt(ifdOffset + 2 + ifdData.length), nextIfdOffset: 0 }
    }

    let maxExtent = BigInt(ifdOffset + 2 + ifdSize)
    let width = 0
    let height = 0
    let cameraModel: string | undefined
    const subIfdOffsets: number[] = []
    const stripOffsets: number[] = []
    const stripByteCounts: number[] = []
    const tileOffsets: number[] = []
    const tileByteCounts: number[] = []

    for (let i = 0; i < entryCount; i++) {
      const entryBase = i * 12
      const tag = littleEndian
        ? ifdData.readUInt16LE(entryBase)
        : ifdData.readUInt16BE(entryBase)
      const type = littleEndian
        ? ifdData.readUInt16LE(entryBase + 2)
        : ifdData.readUInt16BE(entryBase + 2)
      const count = littleEndian
        ? ifdData.readUInt32LE(entryBase + 4)
        : ifdData.readUInt32BE(entryBase + 4)

      // For values that fit in 4 bytes, the value is inline; otherwise it's an offset.
      const valueOrOffset = littleEndian
        ? ifdData.readUInt32LE(entryBase + 8)
        : ifdData.readUInt32BE(entryBase + 8)

      const typeSize = this.getTypeSize(type)
      const totalValueSize = count * typeSize

      switch (tag) {
        case TiffTag.ImageWidth:
          width = valueOrOffset
          break

        case TiffTag.ImageLength:
          height = valueOrOffset
          break

        case TiffTag.Model:
          if (totalValueSize > 4 && totalValueSize < 256) {
            try {
              const modelBuf = await reader.read(
                fileOffset + BigInt(valueOrOffset),
                totalValueSize
              )
              cameraModel = modelBuf
                .toString('ascii')
                .replace(/\0+$/, '')
                .trim()
            } catch {
              // Non-critical.
            }
          }
          break

        case TiffTag.StripOffsets:
          this.readOffsetArray(
            stripOffsets, ifdData, entryBase, count, type, littleEndian, valueOrOffset,
            reader, fileOffset, totalValueSize
          )
          break

        case TiffTag.StripByteCounts:
          this.readOffsetArray(
            stripByteCounts, ifdData, entryBase, count, type, littleEndian, valueOrOffset,
            reader, fileOffset, totalValueSize
          )
          break

        case TiffTag.TileOffsets:
          this.readOffsetArray(
            tileOffsets, ifdData, entryBase, count, type, littleEndian, valueOrOffset,
            reader, fileOffset, totalValueSize
          )
          break

        case TiffTag.TileByteCounts:
          this.readOffsetArray(
            tileByteCounts, ifdData, entryBase, count, type, littleEndian, valueOrOffset,
            reader, fileOffset, totalValueSize
          )
          break

        case TiffTag.SubIFDs:
          if (count === 1) {
            subIfdOffsets.push(valueOrOffset)
          } else if (totalValueSize > 4) {
            try {
              const offsetBuf = await reader.read(
                fileOffset + BigInt(valueOrOffset),
                Math.min(count * 4, 64)
              )
              for (let j = 0; j < count && j * 4 + 4 <= offsetBuf.length; j++) {
                const subOff = littleEndian
                  ? offsetBuf.readUInt32LE(j * 4)
                  : offsetBuf.readUInt32BE(j * 4)
                if (subOff > 0 && subOff < MAX_SCAN_SIZE) {
                  subIfdOffsets.push(subOff)
                }
              }
            } catch {
              // Non-critical.
            }
          }
          break

        default:
          // Track data that lives outside the IFD for extent calculation.
          if (totalValueSize > 4 && valueOrOffset > 0 && valueOrOffset < MAX_SCAN_SIZE) {
            const extent = BigInt(valueOrOffset) + BigInt(totalValueSize)
            if (extent > maxExtent) {
              maxExtent = extent
            }
          }
          break
      }
    }

    // Resolve strip/tile offsets and counts that needed async reads.
    await this.resolveAsyncArrays(stripOffsets, reader, fileOffset)
    await this.resolveAsyncArrays(stripByteCounts, reader, fileOffset)
    await this.resolveAsyncArrays(tileOffsets, reader, fileOffset)
    await this.resolveAsyncArrays(tileByteCounts, reader, fileOffset)

    // Compute max extent from strips.
    for (let i = 0; i < stripOffsets.length && i < stripByteCounts.length; i++) {
      const extent = BigInt(stripOffsets[i]) + BigInt(stripByteCounts[i])
      if (extent > maxExtent && extent < BigInt(MAX_SCAN_SIZE)) {
        maxExtent = extent
      }
    }

    // Compute max extent from tiles.
    for (let i = 0; i < tileOffsets.length && i < tileByteCounts.length; i++) {
      const extent = BigInt(tileOffsets[i]) + BigInt(tileByteCounts[i])
      if (extent > maxExtent && extent < BigInt(MAX_SCAN_SIZE)) {
        maxExtent = extent
      }
    }

    // Recursively parse sub-IFDs.
    for (const subOffset of subIfdOffsets) {
      if (!visitedIfds.has(subOffset) && subOffset < MAX_SCAN_SIZE) {
        try {
          const subResult = await this.parseIFD(
            reader,
            fileOffset,
            subOffset,
            littleEndian,
            visitedIfds
          )
          if (subResult.maxExtent > maxExtent) {
            maxExtent = subResult.maxExtent
          }
        } catch {
          // Non-critical.
        }
      }
    }

    // Get next IFD offset.
    const nextIfdOffset = littleEndian
      ? ifdData.readUInt32LE(entryCount * 12)
      : ifdData.readUInt32BE(entryCount * 12)

    const metadata: FileMetadata | undefined =
      width > 0 && height > 0
        ? { width, height, cameraModel }
        : cameraModel
          ? { cameraModel }
          : undefined

    return {
      maxExtent,
      nextIfdOffset: nextIfdOffset < MAX_SCAN_SIZE ? nextIfdOffset : 0,
      metadata
    }
  }

  /**
   * Read an array of LONG/SHORT values from an IFD entry.
   * If the data fits in 4 bytes, read inline; otherwise it's stored at an offset.
   */
  private readOffsetArray(
    target: number[],
    ifdData: Buffer,
    entryBase: number,
    count: number,
    type: number,
    littleEndian: boolean,
    valueOrOffset: number,
    _reader: ReadableDevice,
    _fileOffset: bigint,
    totalValueSize: number
  ): void {
    if (count === 1) {
      target.push(valueOrOffset)
    } else if (totalValueSize <= 4) {
      // Values packed inline.
      const typeSize = this.getTypeSize(type)
      for (let j = 0; j < count; j++) {
        const val =
          typeSize === 2
            ? littleEndian
              ? ifdData.readUInt16LE(entryBase + 8 + j * 2)
              : ifdData.readUInt16BE(entryBase + 8 + j * 2)
            : littleEndian
              ? ifdData.readUInt32LE(entryBase + 8 + j * 4)
              : ifdData.readUInt32BE(entryBase + 8 + j * 4)
        target.push(val)
      }
    } else {
      // Values stored at external offset - mark for async resolution.
      // Store a negative sentinel: -offset, -count, -type, -littleEndian.
      // We will resolve these in resolveAsyncArrays.
      target.push(-valueOrOffset - 1, -count - 1, -type - 1, littleEndian ? -1 : -2)
    }
  }

  /**
   * Resolve arrays that contain sentinel values for externally-stored data.
   */
  private async resolveAsyncArrays(
    arr: number[],
    reader: ReadableDevice,
    fileOffset: bigint
  ): Promise<void> {
    // Check for sentinel pattern.
    if (arr.length === 4 && arr[0] < 0 && arr[1] < 0 && arr[2] < 0 && arr[3] < 0) {
      const externalOffset = -(arr[0] + 1)
      const count = -(arr[1] + 1)
      const type = -(arr[2] + 1)
      const littleEndian = arr[3] === -1

      arr.length = 0 // Clear the sentinels.

      if (count > 1000 || externalOffset >= MAX_SCAN_SIZE) return

      const typeSize = this.getTypeSize(type)
      const readSize = count * typeSize

      try {
        const data = await reader.read(fileOffset + BigInt(externalOffset), readSize)
        for (let i = 0; i < count && i * typeSize + typeSize <= data.length; i++) {
          const val =
            typeSize === 2
              ? littleEndian
                ? data.readUInt16LE(i * 2)
                : data.readUInt16BE(i * 2)
              : littleEndian
                ? data.readUInt32LE(i * 4)
                : data.readUInt32BE(i * 4)
          arr.push(val)
        }
      } catch {
        // Non-critical.
      }
    }
  }

  /**
   * Get the byte size of a TIFF data type.
   */
  private getTypeSize(type: number): number {
    switch (type) {
      case 1: return 1  // BYTE
      case 2: return 1  // ASCII
      case 3: return 2  // SHORT
      case 4: return 4  // LONG
      case 5: return 8  // RATIONAL
      case 6: return 1  // SBYTE
      case 7: return 1  // UNDEFINED
      case 8: return 2  // SSHORT
      case 9: return 4  // SLONG
      case 10: return 8 // SRATIONAL
      case 11: return 4 // FLOAT
      case 12: return 8 // DOUBLE
      default: return 1
    }
  }
}
