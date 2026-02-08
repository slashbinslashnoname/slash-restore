/**
 * FAT32 Filesystem Parser
 *
 * Scans FAT32 directory entries for deleted files (first byte 0xE5) and
 * reconstructs metadata including filename, size, timestamps, and cluster
 * location to produce RecoverableFile records.
 */

import { randomUUID } from 'crypto'
import type { BlockReader } from '../../io/block-reader'
import type { RecoverableFile, FileFragment, FileType, FileCategory } from '../../../shared/types'

// ─── FAT32 BPB (BIOS Parameter Block) ──────────────────────────

interface Fat32Bpb {
  bytesPerSector: number
  sectorsPerCluster: number
  reservedSectors: number
  fatCount: number
  fatSizeSectors: number
  rootDirCluster: number
  totalSectors: number
}

// ─── Constants ──────────────────────────────────────────────────

const DIR_ENTRY_SIZE = 32
const DELETED_MARKER = 0xe5
const LAST_ENTRY_MARKER = 0x00
const LFN_ATTRIBUTE = 0x0f
const DIRECTORY_ATTRIBUTE = 0x10
const VOLUME_LABEL_ATTRIBUTE = 0x08

/** Maximum directory entries to scan per cluster chain to prevent infinite loops. */
const MAX_DIR_ENTRIES = 100_000

/** Maximum clusters to follow in a chain. */
const MAX_CHAIN_LENGTH = 1_000_000

/** FAT32 end-of-chain marker range. */
const EOC_MIN = 0x0ffffff8
const EOC_MAX = 0x0fffffff

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

export class Fat32Parser {
  private reader: BlockReader
  private bpb: Fat32Bpb | null = null
  private clusterSize = 0
  private dataRegionOffset = 0n

  constructor(reader: BlockReader) {
    this.reader = reader
  }

  async parse(): Promise<RecoverableFile[]> {
    this.bpb = await this.parseBootSector()
    if (!this.bpb) return []

    this.clusterSize = this.bpb.bytesPerSector * this.bpb.sectorsPerCluster
    this.dataRegionOffset = BigInt(this.bpb.reservedSectors + this.bpb.fatCount * this.bpb.fatSizeSectors) *
      BigInt(this.bpb.bytesPerSector)

    const results: RecoverableFile[] = []
    await this.scanDirectory(this.bpb.rootDirCluster, results)
    return results
  }

  // ─── Boot Sector Parsing ────────────────────────────────────

  private async parseBootSector(): Promise<Fat32Bpb | null> {
    let buf: Buffer
    try {
      buf = await this.reader.read(0n, 512)
    } catch {
      return null
    }
    if (buf.length < 90) return null

    const bytesPerSector = buf.readUInt16LE(11)
    const sectorsPerCluster = buf[13]
    const reservedSectors = buf.readUInt16LE(14)
    const fatCount = buf[16]
    const fatSizeSectors = buf.readUInt32LE(36)
    const rootDirCluster = buf.readUInt32LE(44)

    // Sanity checks
    if (
      bytesPerSector < 512 || bytesPerSector > 4096 ||
      (bytesPerSector & (bytesPerSector - 1)) !== 0 ||
      sectorsPerCluster === 0 ||
      (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0 ||
      reservedSectors === 0 ||
      fatCount === 0 ||
      fatSizeSectors === 0 ||
      rootDirCluster < 2
    ) {
      return null
    }

    let totalSectors = buf.readUInt16LE(19)
    if (totalSectors === 0) {
      totalSectors = buf.readUInt32LE(32)
    }

    return {
      bytesPerSector,
      sectorsPerCluster,
      reservedSectors,
      fatCount,
      fatSizeSectors,
      rootDirCluster,
      totalSectors,
    }
  }

  // ─── Directory Scanning ─────────────────────────────────────

  private async scanDirectory(startCluster: number, results: RecoverableFile[]): Promise<void> {
    const bpb = this.bpb!
    const entriesPerCluster = this.clusterSize / DIR_ENTRY_SIZE
    const clusters = await this.followClusterChain(startCluster)
    let totalEntries = 0

    // Collect LFN (Long File Name) entries for deleted files
    let lfnParts: Map<number, string> = new Map()
    let collectingDeletedLfn = false

    for (const cluster of clusters) {
      let clusterData: Buffer
      try {
        clusterData = await this.readCluster(cluster)
      } catch {
        continue
      }

      for (let i = 0; i < entriesPerCluster; i++) {
        if (++totalEntries > MAX_DIR_ENTRIES) return

        const offset = i * DIR_ENTRY_SIZE
        if (offset + DIR_ENTRY_SIZE > clusterData.length) break

        const firstByte = clusterData[offset]

        // End of directory listing
        if (firstByte === LAST_ENTRY_MARKER) return

        const attr = clusterData[offset + 11]

        // LFN entry
        if (attr === LFN_ATTRIBUTE) {
          const ordinal = clusterData[offset] & 0x3f
          const isDeleted = clusterData[offset] === DELETED_MARKER || (clusterData[offset] & 0x80) !== 0

          if (isDeleted || collectingDeletedLfn) {
            const namePart = this.extractLfnChars(clusterData, offset)
            lfnParts.set(ordinal, namePart)
            collectingDeletedLfn = true
          }
          continue
        }

        // Volume label or special - skip
        if (attr & VOLUME_LABEL_ATTRIBUTE) {
          collectingDeletedLfn = false
          lfnParts.clear()
          continue
        }

        // This is a standard 8.3 directory entry
        if (firstByte === DELETED_MARKER) {
          const file = this.parseDeletedEntry(clusterData, offset, lfnParts)
          if (file) {
            // Recursion for deleted subdirectories is not reliable, so skip
            if (!(attr & DIRECTORY_ATTRIBUTE)) {
              results.push(file)
            }
          }
        } else if (firstByte !== 0x2e) {
          // Not a dot-entry; if it's a live subdirectory, recurse into it
          if (attr & DIRECTORY_ATTRIBUTE) {
            const subCluster = this.extractStartCluster(clusterData, offset)
            if (subCluster >= 2) {
              await this.scanDirectory(subCluster, results)
            }
          }
        }

        collectingDeletedLfn = false
        lfnParts.clear()
      }
    }
  }

  // ─── Deleted Entry Parsing ──────────────────────────────────

  private parseDeletedEntry(
    buf: Buffer,
    offset: number,
    lfnParts: Map<number, string>
  ): RecoverableFile | null {
    const size = buf.readUInt32LE(offset + 28)
    if (size === 0) return null

    const startCluster = this.extractStartCluster(buf, offset)
    if (startCluster < 2) return null

    // Reconstruct short name with first-char heuristic
    const shortName = this.reconstruct83Name(buf, offset)
    const extension = shortName.ext.toLowerCase()

    // Use LFN if available, otherwise use short name
    let displayName: string
    if (lfnParts.size > 0) {
      const sorted = [...lfnParts.entries()].sort((a, b) => a[0] - b[0])
      displayName = sorted.map(([, v]) => v).join('')
      // LFN may have null padding
      displayName = displayName.replace(/\0+$/, '')
    } else {
      displayName = shortName.name.trim()
      if (extension) {
        displayName += '.' + extension
      }
    }

    // Timestamps
    const modifiedAt = this.parseDosDateTime(
      buf.readUInt16LE(offset + 24), // date
      buf.readUInt16LE(offset + 22)  // time
    )
    const createdAt = this.parseDosDateTime(
      buf.readUInt16LE(offset + 16), // date
      buf.readUInt16LE(offset + 14)  // time
    )

    // Map extension to known file type
    const mapping = EXTENSION_MAP[extension]
    const fileType: FileType = mapping?.type ?? 'jpeg' // fallback; callers can filter
    const category: FileCategory = mapping?.category ?? 'photo'

    if (!mapping) {
      // Unknown file types are still returned; consumer decides what to do
    }

    const clusterOffset = this.clusterToOffset(startCluster)

    const fragments: FileFragment[] = [{
      offset: clusterOffset,
      size: BigInt(size),
    }]

    return {
      id: randomUUID(),
      type: fileType,
      category,
      offset: clusterOffset,
      size: BigInt(size),
      sizeEstimated: false,
      name: displayName,
      extension: extension || 'bin',
      recoverability: 'good',
      source: 'metadata',
      fragments,
      metadata: {
        originalName: displayName,
        createdAt: createdAt ?? undefined,
        modifiedAt: modifiedAt ?? undefined,
      },
    }
  }

  // ─── Cluster Chain ──────────────────────────────────────────

  private async followClusterChain(startCluster: number): Promise<number[]> {
    const bpb = this.bpb!
    const chain: number[] = []
    let current = startCluster

    while (chain.length < MAX_CHAIN_LENGTH) {
      if (current < 2 || current >= EOC_MIN) break
      chain.push(current)

      // Read the FAT entry for this cluster
      const fatOffset = BigInt(bpb.reservedSectors) * BigInt(bpb.bytesPerSector) +
        BigInt(current) * 4n

      let fatBuf: Buffer
      try {
        fatBuf = await this.reader.read(fatOffset, 4)
      } catch {
        break
      }
      if (fatBuf.length < 4) break

      const next = fatBuf.readUInt32LE(0) & 0x0fffffff
      if (next === current) break // avoid infinite loop
      current = next
    }

    return chain
  }

  // ─── Helpers ────────────────────────────────────────────────

  private async readCluster(clusterNumber: number): Promise<Buffer> {
    const offset = this.clusterToOffset(clusterNumber)
    return this.reader.read(offset, this.clusterSize)
  }

  private clusterToOffset(cluster: number): bigint {
    // Cluster numbering starts at 2
    return this.dataRegionOffset + BigInt(cluster - 2) * BigInt(this.clusterSize)
  }

  private extractStartCluster(buf: Buffer, offset: number): number {
    const high = buf.readUInt16LE(offset + 20)
    const low = buf.readUInt16LE(offset + 26)
    return (high << 16) | low
  }

  private reconstruct83Name(buf: Buffer, offset: number): { name: string; ext: string } {
    // First byte is 0xE5 for deleted - use '_' as placeholder
    const nameBytes = Buffer.alloc(8)
    buf.copy(nameBytes, 0, offset, offset + 8)
    nameBytes[0] = 0x5f // '_' as first char heuristic

    const extBytes = Buffer.alloc(3)
    buf.copy(extBytes, 0, offset + 8, offset + 11)

    const name = nameBytes.toString('ascii').replace(/\x00/g, ' ')
    const ext = extBytes.toString('ascii').replace(/\x00/g, ' ').trim()

    return { name, ext }
  }

  /**
   * Extract UTF-16LE characters from an LFN directory entry.
   * Characters are stored in three separate groups within the 32-byte entry.
   */
  private extractLfnChars(buf: Buffer, offset: number): string {
    const chars: number[] = []

    // Group 1: bytes 1-10 (5 chars)
    for (let i = 0; i < 5; i++) {
      const pos = offset + 1 + i * 2
      if (pos + 1 >= buf.length) break
      const ch = buf.readUInt16LE(pos)
      if (ch === 0xffff || ch === 0x0000) break
      chars.push(ch)
    }

    // Group 2: bytes 14-25 (6 chars)
    for (let i = 0; i < 6; i++) {
      const pos = offset + 14 + i * 2
      if (pos + 1 >= buf.length) break
      const ch = buf.readUInt16LE(pos)
      if (ch === 0xffff || ch === 0x0000) break
      chars.push(ch)
    }

    // Group 3: bytes 28-31 (2 chars)
    for (let i = 0; i < 2; i++) {
      const pos = offset + 28 + i * 2
      if (pos + 1 >= buf.length) break
      const ch = buf.readUInt16LE(pos)
      if (ch === 0xffff || ch === 0x0000) break
      chars.push(ch)
    }

    return String.fromCharCode(...chars)
  }

  /**
   * Parse a DOS date/time pair into a JavaScript Date.
   * DOS date: bits 15-9 = year-1980, 8-5 = month, 4-0 = day
   * DOS time: bits 15-11 = hours, 10-5 = minutes, 4-0 = seconds/2
   */
  private parseDosDateTime(date: number, time: number): Date | null {
    if (date === 0 && time === 0) return null

    const year = ((date >> 9) & 0x7f) + 1980
    const month = ((date >> 5) & 0x0f)
    const day = date & 0x1f
    const hours = (time >> 11) & 0x1f
    const minutes = (time >> 5) & 0x3f
    const seconds = (time & 0x1f) * 2

    // Validate ranges
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    if (hours > 23 || minutes > 59 || seconds > 59) return null

    try {
      return new Date(year, month - 1, day, hours, minutes, seconds)
    } catch {
      return null
    }
  }
}
