/**
 * NTFS Filesystem Parser
 *
 * Scans the Master File Table (MFT) for deleted file entries. NTFS marks
 * deleted MFT records by clearing the in-use flag (bit 0) at offset 0x16.
 *
 * For each deleted entry we parse:
 *   - $STANDARD_INFORMATION (type 0x10) for timestamps
 *   - $FILE_NAME (type 0x30) for the filename
 *   - $DATA (type 0x80) for the data run list (fragment locations)
 */

import { randomUUID } from 'crypto'
import type { BlockReader } from '../../io/block-reader'
import type {
  RecoverableFile,
  FileFragment,
  FileType,
  FileCategory,
} from '../../../shared/types'

// ─── NTFS Boot Sector Fields ────────────────────────────────────

interface NtfsBootSector {
  bytesPerSector: number
  sectorsPerCluster: number
  /** Byte offset to the start of the MFT */
  mftStartOffset: bigint
  /** Size of a single MFT entry in bytes */
  mftEntrySize: number
}

// ─── Constants ──────────────────────────────────────────────────

const MFT_SIGNATURE = 0x454c4946 // "FILE" in little-endian
const MFT_ENTRY_DEFAULT_SIZE = 1024

/** Attribute type codes */
const ATTR_STANDARD_INFORMATION = 0x10
const ATTR_FILE_NAME = 0x30
const ATTR_DATA = 0x80
const ATTR_END_MARKER = 0xffffffff

/** MFT entry flags */
const MFT_FLAG_IN_USE = 0x01
const MFT_FLAG_DIRECTORY = 0x02

/** Maximum MFT entries to scan. */
const MAX_MFT_ENTRIES = 2_000_000

/** First 16 MFT entries are system metadata files ($MFT, $MFTMirr, etc.). */
const FIRST_USER_ENTRY = 16

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

export class NtfsParser {
  private reader: BlockReader
  private bs: NtfsBootSector | null = null

  constructor(reader: BlockReader) {
    this.reader = reader
  }

  async parse(): Promise<RecoverableFile[]> {
    this.bs = await this.parseBootSector()
    if (!this.bs) return []

    return this.scanMft()
  }

  // ─── Boot Sector Parsing ────────────────────────────────────

  private async parseBootSector(): Promise<NtfsBootSector | null> {
    let buf: Buffer
    try {
      buf = await this.reader.read(0n, 512)
    } catch {
      return null
    }
    if (buf.length < 512) return null

    // Verify NTFS OEM signature at offset 3
    const oem = buf.subarray(3, 7).toString('ascii')
    if (oem !== 'NTFS') return null

    const bytesPerSector = buf.readUInt16LE(11)
    const sectorsPerCluster = buf[13]

    // Validate
    if (
      bytesPerSector < 512 || bytesPerSector > 4096 ||
      (bytesPerSector & (bytesPerSector - 1)) !== 0 ||
      sectorsPerCluster === 0
    ) {
      return null
    }

    // MFT start cluster at offset 48 (8 bytes, little-endian)
    const mftStartCluster = this.readInt64LE(buf, 48)
    if (mftStartCluster <= 0n) return null

    const mftStartOffset = mftStartCluster * BigInt(sectorsPerCluster) * BigInt(bytesPerSector)

    // MFT entry size at offset 64. If positive, it's clusters per MFT record.
    // If negative, it's 2^(-value) bytes.
    const mftEntrySizeRaw = buf.readInt8(64)
    let mftEntrySize: number
    if (mftEntrySizeRaw > 0) {
      mftEntrySize = mftEntrySizeRaw * sectorsPerCluster * bytesPerSector
    } else {
      mftEntrySize = 1 << (-mftEntrySizeRaw)
    }

    if (mftEntrySize < 256 || mftEntrySize > 65536) {
      mftEntrySize = MFT_ENTRY_DEFAULT_SIZE
    }

    return {
      bytesPerSector,
      sectorsPerCluster,
      mftStartOffset,
      mftEntrySize,
    }
  }

  // ─── MFT Scanning ──────────────────────────────────────────

  private async scanMft(): Promise<RecoverableFile[]> {
    const bs = this.bs!
    const results: RecoverableFile[] = []

    // Read MFT entries in batches for performance
    const batchSize = 64
    const batchBytes = batchSize * bs.mftEntrySize

    for (
      let entryIndex = FIRST_USER_ENTRY;
      entryIndex < MAX_MFT_ENTRIES;
      entryIndex += batchSize
    ) {
      const offset = bs.mftStartOffset + BigInt(entryIndex) * BigInt(bs.mftEntrySize)
      if (offset >= this.reader.size) break

      let batch: Buffer
      try {
        batch = await this.reader.read(offset, batchBytes)
      } catch {
        // Possibly past end of MFT; try individual reads or break
        break
      }

      for (let j = 0; j < batchSize; j++) {
        const entryOffset = j * bs.mftEntrySize
        if (entryOffset + bs.mftEntrySize > batch.length) break

        const entry = batch.subarray(entryOffset, entryOffset + bs.mftEntrySize)
        const file = this.parseMftEntry(entry, bs)
        if (file) {
          results.push(file)
        }
      }

      // If we got a short read, we've reached the end
      if (batch.length < batchBytes) break
    }

    return results
  }

  // ─── MFT Entry Parsing ─────────────────────────────────────

  private parseMftEntry(entry: Buffer, bs: NtfsBootSector): RecoverableFile | null {
    if (entry.length < 56) return null

    // Check "FILE" magic signature
    const magic = entry.readUInt32LE(0)
    if (magic !== MFT_SIGNATURE) return null

    // Flags at offset 0x16
    const flags = entry.readUInt16LE(0x16)

    // We only want deleted file entries (not in-use, not directories)
    if (flags & MFT_FLAG_IN_USE) return null
    if (flags & MFT_FLAG_DIRECTORY) return null

    // Apply fixup array to correct multi-sector entries
    const fixedEntry = this.applyFixups(entry)
    if (!fixedEntry) return null

    // Offset to first attribute (at offset 0x14)
    const firstAttrOffset = fixedEntry.readUInt16LE(0x14)
    if (firstAttrOffset < 56 || firstAttrOffset >= fixedEntry.length) return null

    // Parse attributes
    let filename: string | null = null
    let fileSize = 0n
    let fragments: FileFragment[] = []
    let createdAt: Date | undefined
    let modifiedAt: Date | undefined

    let attrOffset = firstAttrOffset

    while (attrOffset + 16 <= fixedEntry.length) {
      const attrType = fixedEntry.readUInt32LE(attrOffset)
      if (attrType === ATTR_END_MARKER || attrType === 0) break

      const attrLength = fixedEntry.readUInt32LE(attrOffset + 4)
      if (attrLength < 16 || attrLength > fixedEntry.length - attrOffset) break

      const nonResident = fixedEntry[attrOffset + 8]

      switch (attrType) {
        case ATTR_STANDARD_INFORMATION: {
          const timestamps = this.parseStandardInformation(fixedEntry, attrOffset, nonResident)
          if (timestamps) {
            createdAt = timestamps.createdAt
            modifiedAt = timestamps.modifiedAt
          }
          break
        }
        case ATTR_FILE_NAME: {
          const parsed = this.parseFileName(fixedEntry, attrOffset, nonResident)
          // Prefer Win32 or Win32+DOS namespace names over DOS-only names
          if (parsed && (!filename || parsed.namespace !== 2)) {
            filename = parsed.name
          }
          break
        }
        case ATTR_DATA: {
          const dataInfo = this.parseDataAttribute(fixedEntry, attrOffset, nonResident, bs)
          if (dataInfo) {
            fileSize = dataInfo.size
            fragments = dataInfo.fragments
          }
          break
        }
      }

      attrOffset += attrLength
    }

    if (!filename || (fileSize === 0n && fragments.length === 0)) return null

    // Extract extension
    const dotIndex = filename.lastIndexOf('.')
    const extension = dotIndex >= 0 ? filename.substring(dotIndex + 1).toLowerCase() : ''

    const mapping = EXTENSION_MAP[extension]
    const fileType: FileType = mapping?.type ?? 'jpeg'
    const category: FileCategory = mapping?.category ?? 'photo'

    const primaryOffset = fragments.length > 0 ? fragments[0].offset : 0n

    // Assess recoverability based on fragment count
    let recoverability: 'good' | 'partial' | 'poor' = 'good'
    if (fragments.length > 3) recoverability = 'partial'
    if (fragments.length > 10) recoverability = 'poor'
    if (fragments.length === 0) recoverability = 'poor'

    return {
      id: randomUUID(),
      type: fileType,
      category,
      offset: primaryOffset,
      size: fileSize,
      sizeEstimated: fileSize === 0n,
      name: filename,
      extension: extension || 'bin',
      recoverability,
      source: 'metadata',
      fragments: fragments.length > 0 ? fragments : undefined,
      metadata: {
        originalName: filename,
        createdAt,
        modifiedAt,
      },
    }
  }

  // ─── Attribute Parsers ──────────────────────────────────────

  /**
   * Parse $STANDARD_INFORMATION (0x10) attribute.
   * Always resident. Contains NTFS timestamps (Windows FILETIME: 100ns
   * intervals since 1601-01-01).
   */
  private parseStandardInformation(
    entry: Buffer,
    attrOffset: number,
    nonResident: number
  ): { createdAt?: Date; modifiedAt?: Date } | null {
    if (nonResident !== 0) return null

    // Resident attribute: content offset at attrOffset + 20 (2 bytes)
    const contentOffset = entry.readUInt16LE(attrOffset + 20)
    const contentLength = entry.readUInt32LE(attrOffset + 16)
    const absOffset = attrOffset + contentOffset

    if (contentLength < 48 || absOffset + 48 > entry.length) return null

    // Timestamps: Created (0), Modified (8), MFT Modified (16), Accessed (24)
    const createdAt = this.parseNtfsTimestamp(entry, absOffset)
    const modifiedAt = this.parseNtfsTimestamp(entry, absOffset + 8)

    return { createdAt, modifiedAt }
  }

  /**
   * Parse $FILE_NAME (0x30) attribute.
   * Always resident. Contains the filename in UTF-16LE and a namespace byte.
   */
  private parseFileName(
    entry: Buffer,
    attrOffset: number,
    nonResident: number
  ): { name: string; namespace: number } | null {
    if (nonResident !== 0) return null

    const contentOffset = entry.readUInt16LE(attrOffset + 20)
    const contentLength = entry.readUInt32LE(attrOffset + 16)
    const absOffset = attrOffset + contentOffset

    // $FILE_NAME header: parent ref (8), timestamps (32), sizes (16),
    // flags (4), reparse (4), name length (1), namespace (1), name (variable)
    if (contentLength < 66 || absOffset + 66 > entry.length) return null

    const nameLength = entry[absOffset + 64] // in characters
    const namespace = entry[absOffset + 65]

    if (nameLength === 0 || absOffset + 66 + nameLength * 2 > entry.length) return null

    // Read UTF-16LE filename
    const nameChars: string[] = []
    for (let i = 0; i < nameLength; i++) {
      const charCode = entry.readUInt16LE(absOffset + 66 + i * 2)
      nameChars.push(String.fromCharCode(charCode))
    }

    return {
      name: nameChars.join(''),
      namespace,
    }
  }

  /**
   * Parse $DATA (0x80) attribute.
   * Can be resident (small files) or non-resident (with run list).
   */
  private parseDataAttribute(
    entry: Buffer,
    attrOffset: number,
    nonResident: number,
    bs: NtfsBootSector
  ): { size: bigint; fragments: FileFragment[] } | null {
    if (nonResident === 0) {
      // Resident data: the file content is inline
      const contentLength = entry.readUInt32LE(attrOffset + 16)
      const contentOffset = entry.readUInt16LE(attrOffset + 20)
      return {
        size: BigInt(contentLength),
        fragments: [{
          offset: 0n, // Inline; offset is not meaningful on disk
          size: BigInt(contentLength),
        }],
      }
    }

    // Non-resident: parse run list
    // Real size at offset attrOffset + 48 (8 bytes)
    if (attrOffset + 56 > entry.length) return null
    const realSize = this.readUInt64LE(entry, attrOffset + 48)

    // Run list offset at attrOffset + 32 (2 bytes)
    const runListOffset = entry.readUInt16LE(attrOffset + 32)
    const runListStart = attrOffset + runListOffset

    if (runListStart >= entry.length) return null

    const fragments = this.decodeRunList(entry, runListStart, bs)

    return {
      size: realSize,
      fragments,
    }
  }

  // ─── Run List Decoder ───────────────────────────────────────

  /**
   * Decode an NTFS data run list into file fragments.
   *
   * Each run is encoded as:
   *   - Header byte: low nibble = length field size, high nibble = offset field size
   *   - Length field (variable, unsigned): number of clusters in this run
   *   - Offset field (variable, signed): LCN delta from previous run
   *
   * A header byte of 0x00 marks the end of the run list.
   */
  private decodeRunList(entry: Buffer, startOffset: number, bs: NtfsBootSector): FileFragment[] {
    const fragments: FileFragment[] = []
    let pos = startOffset
    let previousLcn = 0n
    const bytesPerCluster = BigInt(bs.bytesPerSector) * BigInt(bs.sectorsPerCluster)

    while (pos < entry.length) {
      const header = entry[pos]
      if (header === 0x00) break

      const lengthSize = header & 0x0f
      const offsetSize = (header >> 4) & 0x0f

      pos++

      if (lengthSize === 0 || pos + lengthSize + offsetSize > entry.length) break

      // Read length (unsigned)
      let runLength = 0n
      for (let i = 0; i < lengthSize; i++) {
        runLength |= BigInt(entry[pos + i]) << BigInt(i * 8)
      }
      pos += lengthSize

      if (offsetSize === 0) {
        // Sparse run (no physical location)
        pos += offsetSize
        continue
      }

      // Read offset (signed, delta from previous LCN)
      let runOffset = 0n
      for (let i = 0; i < offsetSize; i++) {
        runOffset |= BigInt(entry[pos + i]) << BigInt(i * 8)
      }
      // Sign-extend
      const signBit = 1n << BigInt(offsetSize * 8 - 1)
      if (runOffset & signBit) {
        runOffset -= 1n << BigInt(offsetSize * 8)
      }
      pos += offsetSize

      const lcn = previousLcn + runOffset
      previousLcn = lcn

      if (lcn < 0n) continue // Invalid

      fragments.push({
        offset: lcn * bytesPerCluster,
        size: runLength * bytesPerCluster,
      })
    }

    return fragments
  }

  // ─── Fixup Array ────────────────────────────────────────────

  /**
   * Apply the NTFS fixup array to correct multi-sector transfer protection.
   *
   * NTFS writes a signature value at the end of each 512-byte sector within
   * an MFT entry, and stores the original values in the fixup array. We need
   * to restore these to read the entry correctly.
   */
  private applyFixups(entry: Buffer): Buffer | null {
    if (entry.length < 48) return null

    const fixupOffset = entry.readUInt16LE(4) // offset to update sequence array
    const fixupCount = entry.readUInt16LE(6) // number of fixup entries (including signature)

    if (fixupCount < 2 || fixupOffset + fixupCount * 2 > entry.length) {
      return entry // Return as-is if fixup data looks corrupt
    }

    const result = Buffer.from(entry) // Make a copy

    const signature = result.readUInt16LE(fixupOffset)

    for (let i = 1; i < fixupCount; i++) {
      const sectorEnd = i * 512 - 2
      if (sectorEnd + 1 >= result.length) break

      // Verify the sector end contains the expected signature
      const actual = result.readUInt16LE(sectorEnd)
      if (actual !== signature) {
        // Fixup mismatch - the entry may be corrupt, but continue anyway
        // since partial data is better than none for recovery
      }

      // Restore the original value from the fixup array
      const originalValue = result.readUInt16LE(fixupOffset + i * 2)
      result.writeUInt16LE(originalValue, sectorEnd)
    }

    return result
  }

  // ─── Timestamp Helpers ──────────────────────────────────────

  /**
   * Parse an NTFS timestamp (Windows FILETIME).
   * 64-bit value counting 100-nanosecond intervals since 1601-01-01.
   */
  private parseNtfsTimestamp(buf: Buffer, offset: number): Date | undefined {
    if (offset + 8 > buf.length) return undefined

    const filetime = this.readUInt64LE(buf, offset)
    if (filetime === 0n) return undefined

    // Convert FILETIME to Unix ms: (filetime / 10000) - 11644473600000
    const EPOCH_DIFF_MS = 11644473600000n
    const unixMs = filetime / 10000n - EPOCH_DIFF_MS

    // Sanity check: reject dates before 1970 or after 2100
    if (unixMs < 0n || unixMs > 4102444800000n) return undefined

    try {
      return new Date(Number(unixMs))
    } catch {
      return undefined
    }
  }

  // ─── Integer Helpers ────────────────────────────────────────

  private readUInt64LE(buf: Buffer, offset: number): bigint {
    if (offset + 8 > buf.length) return 0n
    const low = buf.readUInt32LE(offset)
    const high = buf.readUInt32LE(offset + 4)
    return (BigInt(high) << 32n) | BigInt(low)
  }

  private readInt64LE(buf: Buffer, offset: number): bigint {
    if (offset + 8 > buf.length) return 0n
    const low = buf.readUInt32LE(offset)
    const high = buf.readInt32LE(offset + 4)
    return (BigInt(high) << 32n) | BigInt(low >>> 0)
  }
}
