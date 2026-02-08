/**
 * exFAT Filesystem Parser
 *
 * Scans exFAT directory entries for deleted files. In exFAT, directory
 * entries are 32-byte records with the high bit (bit 7) of the entry
 * type indicating InUse status. Deleted entries have InUse = 0.
 *
 * Each file is represented by a set of directory entries:
 *   - File Directory Entry (type 0x85 when in-use, 0x05 when deleted)
 *   - Stream Extension Entry (type 0xC0 when in-use, 0x40 when deleted)
 *   - File Name Entry(ies) (type 0xC1 when in-use, 0x41 when deleted)
 */

import { randomUUID } from 'crypto'
import type { BlockReader } from '../../io/block-reader'
import type {
  RecoverableFile,
  FileFragment,
  FileType,
  FileCategory,
} from '../../../shared/types'

// ─── exFAT Boot Sector Fields ───────────────────────────────────

interface ExfatBootSector {
  /** Bytes per sector as a power of 2 (actual = 2^sectorSizeShift) */
  bytesPerSector: number
  /** Bytes per cluster */
  bytesPerCluster: number
  /** Sector offset to the cluster heap (data region) */
  clusterHeapOffset: number
  /** Total clusters in the cluster heap */
  clusterCount: number
  /** Cluster number of the root directory */
  rootDirCluster: number
  /** Sector size shift (log2) */
  sectorSizeShift: number
  /** Cluster size shift (log2, relative to sector) */
  clusterSizeShift: number
  /** FAT offset in sectors */
  fatOffset: number
  /** FAT length in sectors */
  fatLength: number
}

// ─── Entry Type Constants ───────────────────────────────────────

/** Base type values (without InUse bit) */
const ENTRY_TYPE_FILE = 0x05
const ENTRY_TYPE_STREAM = 0x40
const ENTRY_TYPE_FILENAME = 0x41

/** InUse bit mask (bit 7) */
const INUSE_BIT = 0x80

/** End of directory marker */
const END_OF_DIRECTORY = 0x00

/** Maximum entries to scan to prevent runaway reads. */
const MAX_ENTRIES = 500_000

/** Maximum cluster chain length. */
const MAX_CHAIN_LENGTH = 1_000_000

// ─── Extension to FileType mapping ──────────────────────────────

const EXTENSION_MAP: Record<string, { type: FileType; category: FileCategory }> = {
  jpg: { type: 'jpeg', category: 'photo' },
  jpeg: { type: 'jpeg', category: 'photo' },
  png: { type: 'png', category: 'photo' },
  heic: { type: 'heic', category: 'photo' },
  cr2: { type: 'cr2', category: 'photo' },
  nef: { type: 'nef', category: 'photo' },
  arw: { type: 'arw', category: 'photo' },
  mp4: { type: 'mp4', category: 'video' },
  mov: { type: 'mov', category: 'video' },
  avi: { type: 'avi', category: 'video' },
  pdf: { type: 'pdf', category: 'document' },
  docx: { type: 'docx', category: 'document' },
  xlsx: { type: 'xlsx', category: 'document' },
  rtf: { type: 'rtf', category: 'document' },
  pptx: { type: 'pptx', category: 'document' },
  gif: { type: 'gif', category: 'photo' },
  webp: { type: 'webp', category: 'photo' },
  psd: { type: 'psd', category: 'photo' },
  mkv: { type: 'mkv', category: 'video' },
  webm: { type: 'mkv', category: 'video' },
  flv: { type: 'flv', category: 'video' },
  wmv: { type: 'wmv', category: 'video' },
  mp3: { type: 'mp3', category: 'audio' },
  wav: { type: 'wav', category: 'audio' },
  flac: { type: 'flac', category: 'audio' },
  ogg: { type: 'ogg', category: 'audio' },
  m4a: { type: 'm4a', category: 'audio' },
  zip: { type: 'zip', category: 'archive' },
  rar: { type: 'rar', category: 'archive' },
  '7z': { type: '7z', category: 'archive' },
  gz: { type: 'gz', category: 'archive' },
  bz2: { type: 'bz2', category: 'archive' },
  xz: { type: 'xz', category: 'archive' },
  tar: { type: 'tar', category: 'archive' },
  sqlite: { type: 'sqlite', category: 'database' },
  db: { type: 'sqlite', category: 'database' },
  dat: { type: 'bdb', category: 'database' },
}

// ─── Public API ─────────────────────────────────────────────────

export class ExfatParser {
  private reader: BlockReader
  private bs: ExfatBootSector | null = null

  constructor(reader: BlockReader) {
    this.reader = reader
  }

  async parse(): Promise<RecoverableFile[]> {
    this.bs = await this.parseBootSector()
    if (!this.bs) return []

    const results: RecoverableFile[] = []
    await this.scanDirectory(this.bs.rootDirCluster, results)
    return results
  }

  // ─── Boot Sector Parsing ────────────────────────────────────

  private async parseBootSector(): Promise<ExfatBootSector | null> {
    let buf: Buffer
    try {
      buf = await this.reader.read(0n, 512)
    } catch {
      return null
    }
    if (buf.length < 120) return null

    // Verify exFAT OEM signature at offset 3
    const oem = buf.subarray(3, 11).toString('ascii')
    if (!oem.startsWith('EXFAT')) return null

    // Partition offset (8 bytes at offset 64) - not directly needed but useful for validation
    const fatOffset = buf.readUInt32LE(80)
    const fatLength = buf.readUInt32LE(84)
    const clusterHeapOffset = buf.readUInt32LE(88)
    const clusterCount = buf.readUInt32LE(92)
    const rootDirCluster = buf.readUInt32LE(96)

    const sectorSizeShift = buf[108]
    const clusterSizeShift = buf[109]

    // Validate ranges
    if (sectorSizeShift < 9 || sectorSizeShift > 12) return null // 512..4096
    if (clusterSizeShift > 25) return null
    if (rootDirCluster < 2) return null
    if (fatOffset === 0 || clusterHeapOffset === 0) return null

    const bytesPerSector = 1 << sectorSizeShift
    const bytesPerCluster = bytesPerSector << clusterSizeShift

    return {
      bytesPerSector,
      bytesPerCluster,
      clusterHeapOffset,
      clusterCount,
      rootDirCluster,
      sectorSizeShift,
      clusterSizeShift,
      fatOffset,
      fatLength,
    }
  }

  // ─── Directory Scanning ─────────────────────────────────────

  private async scanDirectory(startCluster: number, results: RecoverableFile[]): Promise<void> {
    const bs = this.bs!
    const entriesPerCluster = bs.bytesPerCluster / 32
    const clusters = await this.followClusterChain(startCluster)
    let totalEntries = 0

    for (const cluster of clusters) {
      let clusterData: Buffer
      try {
        clusterData = await this.readCluster(cluster)
      } catch {
        continue
      }

      let i = 0
      while (i < entriesPerCluster) {
        if (++totalEntries > MAX_ENTRIES) return

        const offset = i * 32
        if (offset + 32 > clusterData.length) break

        const entryType = clusterData[offset]

        // End of directory
        if (entryType === END_OF_DIRECTORY) return

        // Check for deleted File Directory Entry
        // Deleted file entry type: 0x05 (0x85 minus InUse bit)
        if (entryType === ENTRY_TYPE_FILE) {
          const file = await this.parseDeletedFileSet(
            clusterData,
            offset,
            i,
            entriesPerCluster,
            clusters,
            cluster
          )
          if (file) {
            results.push(file)
          }
        }

        // Live directory entry - check if it's a subdirectory to recurse into
        if (entryType === (ENTRY_TYPE_FILE | INUSE_BIT)) {
          const attr = clusterData.readUInt16LE(offset + 4)
          if (attr & 0x10) {
            // This is a live subdirectory; look ahead for its stream extension
            // to get the start cluster
            const nextOffset = offset + 32
            if (nextOffset + 32 <= clusterData.length) {
              const nextType = clusterData[nextOffset]
              if (nextType === (ENTRY_TYPE_STREAM | INUSE_BIT)) {
                const subCluster = clusterData.readUInt32LE(nextOffset + 20)
                if (subCluster >= 2 && subCluster !== startCluster) {
                  await this.scanDirectory(subCluster, results)
                }
              }
            }
          }
        }

        i++
      }
    }
  }

  /**
   * Parse a deleted file entry set: File Dir Entry + Stream Extension + File Name entries.
   * Returns null if the entry set is incomplete or invalid.
   */
  private async parseDeletedFileSet(
    clusterData: Buffer,
    fileEntryOffset: number,
    entryIndex: number,
    entriesPerCluster: number,
    _clusters: number[],
    _currentCluster: number
  ): Promise<RecoverableFile | null> {
    const bs = this.bs!

    // The File Directory Entry contains a secondary count at offset 1
    const secondaryCount = clusterData[fileEntryOffset + 1]
    if (secondaryCount < 2 || secondaryCount > 18) return null

    // File attributes at offset 4 (2 bytes)
    const attributes = clusterData.readUInt16LE(fileEntryOffset + 4)
    const isDirectory = !!(attributes & 0x10)
    if (isDirectory) return null

    // Timestamps from File Directory Entry
    const createTimestamp = clusterData.readUInt32LE(fileEntryOffset + 8)
    const modifyTimestamp = clusterData.readUInt32LE(fileEntryOffset + 12)

    // Parse secondary entries (must follow immediately)
    let streamExt: Buffer | null = null
    const nameEntries: Buffer[] = []
    let pos = fileEntryOffset + 32

    for (let s = 0; s < secondaryCount; s++) {
      if (pos + 32 > clusterData.length) break

      const sType = clusterData[pos]

      if (sType === ENTRY_TYPE_STREAM) {
        streamExt = clusterData.subarray(pos, pos + 32)
      } else if (sType === ENTRY_TYPE_FILENAME) {
        nameEntries.push(clusterData.subarray(pos, pos + 32))
      }
      // Also accept in-use versions in case only the primary was marked deleted
      else if (sType === (ENTRY_TYPE_STREAM | INUSE_BIT)) {
        streamExt = clusterData.subarray(pos, pos + 32)
      } else if (sType === (ENTRY_TYPE_FILENAME | INUSE_BIT)) {
        nameEntries.push(clusterData.subarray(pos, pos + 32))
      }

      pos += 32
    }

    if (!streamExt || nameEntries.length === 0) return null

    // Stream Extension: valid data length (8 bytes at offset 8), data length at offset 16
    // First cluster at offset 20 (4 bytes)
    const validDataLength = this.readUInt64LE(streamExt, 8)
    const dataLength = this.readUInt64LE(streamExt, 16)
    const firstCluster = streamExt.readUInt32LE(20)
    const nameLen = streamExt[3] // NameLength in characters

    if (firstCluster < 2 || dataLength === 0n) return null

    // Reconstruct filename from File Name entries (UTF-16LE, 15 chars per entry at offset 2)
    let filename = ''
    let charsRemaining = nameLen

    for (const nameEntry of nameEntries) {
      const charsInEntry = Math.min(15, charsRemaining)
      for (let c = 0; c < charsInEntry; c++) {
        const charOffset = 2 + c * 2
        if (charOffset + 1 >= nameEntry.length) break
        const charCode = nameEntry.readUInt16LE(charOffset)
        if (charCode === 0) break
        filename += String.fromCharCode(charCode)
      }
      charsRemaining -= charsInEntry
      if (charsRemaining <= 0) break
    }

    if (!filename) return null

    // Extract extension
    const dotIndex = filename.lastIndexOf('.')
    const extension = dotIndex >= 0 ? filename.substring(dotIndex + 1).toLowerCase() : ''

    // Map to known file type
    const mapping = EXTENSION_MAP[extension]
    const fileType: FileType = mapping?.type ?? 'jpeg'
    const category: FileCategory = mapping?.category ?? 'photo'

    const fileSize = validDataLength > 0n ? validDataLength : dataLength
    const clusterOffset = this.clusterToOffset(firstCluster)

    const fragments: FileFragment[] = [{
      offset: clusterOffset,
      size: fileSize,
    }]

    const createdAt = this.parseExfatTimestamp(createTimestamp)
    const modifiedAt = this.parseExfatTimestamp(modifyTimestamp)

    return {
      id: randomUUID(),
      type: fileType,
      category,
      offset: clusterOffset,
      size: fileSize,
      sizeEstimated: false,
      name: filename,
      extension: extension || 'bin',
      recoverability: 'good',
      source: 'metadata',
      fragments,
      metadata: {
        originalName: filename,
        createdAt: createdAt ?? undefined,
        modifiedAt: modifiedAt ?? undefined,
      },
    }
  }

  // ─── Cluster Chain ──────────────────────────────────────────

  private async followClusterChain(startCluster: number): Promise<number[]> {
    const bs = this.bs!
    const chain: number[] = []
    let current = startCluster

    while (chain.length < MAX_CHAIN_LENGTH) {
      if (current < 2 || current > bs.clusterCount + 1) break
      chain.push(current)

      // Read FAT entry (4 bytes per cluster)
      const fatByteOffset = BigInt(bs.fatOffset) * BigInt(bs.bytesPerSector) +
        BigInt(current) * 4n

      let fatBuf: Buffer
      try {
        fatBuf = await this.reader.read(fatByteOffset, 4)
      } catch {
        break
      }
      if (fatBuf.length < 4) break

      const next = fatBuf.readUInt32LE(0)

      // End of chain markers
      if (next === 0xffffffff || next === 0x00000000) break
      if (next === current) break // avoid loop
      current = next
    }

    return chain
  }

  // ─── Helpers ────────────────────────────────────────────────

  private readCluster(cluster: number): Promise<Buffer> {
    const offset = this.clusterToOffset(cluster)
    return this.reader.read(offset, this.bs!.bytesPerCluster)
  }

  private clusterToOffset(cluster: number): bigint {
    const bs = this.bs!
    // Cluster 2 is the first cluster in the heap
    return BigInt(bs.clusterHeapOffset) * BigInt(bs.bytesPerSector) +
      BigInt(cluster - 2) * BigInt(bs.bytesPerCluster)
  }

  /**
   * Read a 64-bit unsigned integer from a buffer as BigInt (little-endian).
   * Node.js Buffer doesn't have readBigUInt64LE in all environments,
   * so we construct it manually for maximum portability.
   */
  private readUInt64LE(buf: Buffer, offset: number): bigint {
    if (offset + 8 > buf.length) return 0n
    const low = buf.readUInt32LE(offset)
    const high = buf.readUInt32LE(offset + 4)
    return (BigInt(high) << 32n) | BigInt(low)
  }

  /**
   * Parse an exFAT timestamp (32-bit packed).
   * Format: same as DOS date/time but packed into a single 32-bit value.
   * Bits 31-25: year-1980, 24-21: month, 20-16: day,
   *      15-11: hour, 10-5: minute, 4-0: seconds/2
   */
  private parseExfatTimestamp(ts: number): Date | null {
    if (ts === 0) return null

    const seconds = (ts & 0x1f) * 2
    const minutes = (ts >> 5) & 0x3f
    const hours = (ts >> 11) & 0x1f
    const day = (ts >> 16) & 0x1f
    const month = (ts >> 21) & 0x0f
    const year = ((ts >> 25) & 0x7f) + 1980

    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    if (hours > 23 || minutes > 59 || seconds > 59) return null

    try {
      return new Date(year, month - 1, day, hours, minutes, seconds)
    } catch {
      return null
    }
  }
}
