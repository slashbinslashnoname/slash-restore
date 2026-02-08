/**
 * HFS+ / HFSX Filesystem Parser
 *
 * Scans the HFS+ catalog B-tree for deleted file entries. HFS+ stores
 * its file metadata in a B-tree structure within the catalog file.
 *
 * Recovery strategy:
 *   1. Read the volume header at offset 1024 to locate the catalog file
 *   2. Parse the B-tree header node to understand the tree structure
 *   3. Traverse leaf nodes looking for:
 *      a. Slack space between the last record and the next node (residual data)
 *      b. Journal entries referencing deleted catalog records
 *   4. Extract file metadata from catalog file records (type 0x0200 = file record)
 *
 * Note: HFS+ is big-endian throughout. All multi-byte values use BE reads.
 */

import { randomUUID } from 'crypto'
import type { BlockReader } from '../../io/block-reader'
import type {
  RecoverableFile,
  FileFragment,
  FileType,
  FileCategory,
} from '../../../shared/types'

// ─── HFS+ Volume Header Fields ──────────────────────────────────

interface HfsPlusVolumeHeader {
  /** Volume signature: 0x482B (H+) or 0x4858 (HX for HFSX) */
  signature: number
  /** Block size in bytes */
  blockSize: number
  /** Total blocks on the volume */
  totalBlocks: number
  /** Catalog file extents (first 8 extent descriptors) */
  catalogExtents: HfsPlusExtent[]
  /** Catalog file total size in bytes */
  catalogFileSize: bigint
  /** Journal info block offset (0 if no journal) */
  journalInfoBlock: number
}

interface HfsPlusExtent {
  startBlock: number
  blockCount: number
}

// ─── B-tree Structures ──────────────────────────────────────────

interface BTreeHeaderRecord {
  /** Size of tree nodes in bytes */
  nodeSize: number
  /** Total number of nodes */
  totalNodes: number
  /** Number of leaf records */
  leafRecords: number
  /** Root node index */
  rootNode: number
  /** First leaf node index */
  firstLeafNode: number
  /** Last leaf node index */
  lastLeafNode: number
}

// ─── Constants ──────────────────────────────────────────────────

const VOLUME_HEADER_OFFSET = 1024
const VOLUME_HEADER_SIZE = 512

/** HFS+ signature values */
const HFSPLUS_SIGNATURE = 0x482b // 'H+'
const HFSX_SIGNATURE = 0x4858    // 'HX'

/** Catalog record types (big-endian) */
const CATALOG_FILE_RECORD = 0x0200
const CATALOG_FOLDER_RECORD = 0x0100
const CATALOG_FILE_THREAD = 0x0400
const CATALOG_FOLDER_THREAD = 0x0300

/** Node types in B-tree */
const NODE_TYPE_LEAF = 0xff
const NODE_TYPE_INDEX = 0x00
const NODE_TYPE_HEADER = 0x01

/** Maximum nodes to scan (safety limit) */
const MAX_NODES_TO_SCAN = 500_000

/** Minimum valid catalog record size */
const MIN_RECORD_SIZE = 248

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
}

// ─── HFS+ Date Epoch ───────────────────────────────────────────

/** HFS+ timestamps are seconds since 1904-01-01 00:00:00 UTC */
const HFSPLUS_EPOCH_OFFSET = Date.UTC(1904, 0, 1, 0, 0, 0) // ms since Unix epoch

// ─── Public API ─────────────────────────────────────────────────

export class HfsPlusParser {
  private reader: BlockReader
  private vh: HfsPlusVolumeHeader | null = null

  constructor(reader: BlockReader) {
    this.reader = reader
  }

  async parse(): Promise<RecoverableFile[]> {
    this.vh = await this.parseVolumeHeader()
    if (!this.vh) return []

    const results: RecoverableFile[] = []

    // Strategy 1: Scan catalog B-tree leaf node slack space
    await this.scanCatalogBTree(results)

    // Strategy 2: Check journal for deleted entries
    await this.scanJournal(results)

    return results
  }

  // ─── Volume Header Parsing ──────────────────────────────────

  private async parseVolumeHeader(): Promise<HfsPlusVolumeHeader | null> {
    let buf: Buffer
    try {
      buf = await this.reader.read(BigInt(VOLUME_HEADER_OFFSET), VOLUME_HEADER_SIZE)
    } catch {
      return null
    }
    if (buf.length < VOLUME_HEADER_SIZE) return null

    // Signature at offset 0 (2 bytes, big-endian)
    const signature = buf.readUInt16BE(0)
    if (signature !== HFSPLUS_SIGNATURE && signature !== HFSX_SIGNATURE) return null

    // Block size at offset 40 (4 bytes, big-endian)
    const blockSize = buf.readUInt32BE(40)
    if (blockSize < 512 || blockSize > 1048576 || (blockSize & (blockSize - 1)) !== 0) return null

    // Total blocks at offset 44 (4 bytes)
    const totalBlocks = buf.readUInt32BE(44)

    // Journal info block at offset 124 (4 bytes)
    const journalInfoBlock = buf.readUInt32BE(124)

    // Catalog file size: at offset 240 in the catalog fork data
    // The catalog fork starts at offset 272:
    //   - logical size (8 bytes, offset 272)
    //   - clump size (4 bytes, offset 280)
    //   - total blocks (4 bytes, offset 284)
    //   - extents (8 extent records, each 8 bytes, offset 288)
    const catalogFileSize = this.readUInt64BE(buf, 272)

    // Parse catalog extents (8 entries, each 8 bytes: startBlock(4) + blockCount(4))
    const catalogExtents: HfsPlusExtent[] = []
    for (let i = 0; i < 8; i++) {
      const extOffset = 288 + i * 8
      if (extOffset + 8 > buf.length) break

      const startBlock = buf.readUInt32BE(extOffset)
      const blockCount = buf.readUInt32BE(extOffset + 4)

      if (blockCount > 0) {
        catalogExtents.push({ startBlock, blockCount })
      }
    }

    if (catalogExtents.length === 0) return null

    return {
      signature,
      blockSize,
      totalBlocks,
      catalogExtents,
      catalogFileSize,
      journalInfoBlock,
    }
  }

  // ─── Catalog B-Tree Scanning ────────────────────────────────

  private async scanCatalogBTree(results: RecoverableFile[]): Promise<void> {
    const vh = this.vh!

    // Read the first node (header node) of the catalog B-tree
    const catalogStart = this.extentToOffset(vh.catalogExtents[0])
    let headerNodeBuf: Buffer
    try {
      // First read a reasonable default node size to get the header
      headerNodeBuf = await this.reader.read(catalogStart, 512)
    } catch {
      return
    }
    if (headerNodeBuf.length < 14) return

    // Parse B-tree node descriptor (14 bytes)
    const nodeType = headerNodeBuf[8]
    if (nodeType !== NODE_TYPE_HEADER) return

    const numRecords = headerNodeBuf.readUInt16BE(10)
    if (numRecords < 1) return

    // The header record starts right after the node descriptor (offset 14)
    // B-tree header record (offset 14, 106 bytes):
    if (headerNodeBuf.length < 120) {
      try {
        headerNodeBuf = await this.reader.read(catalogStart, 4096)
      } catch {
        return
      }
    }
    if (headerNodeBuf.length < 120) return

    const headerRecord = this.parseBTreeHeader(headerNodeBuf, 14)
    if (!headerRecord) return

    // Now re-read the header node with the correct node size
    if (headerRecord.nodeSize < 512 || headerRecord.nodeSize > 65536) return

    // Traverse leaf nodes
    await this.traverseLeafNodes(headerRecord, results)
  }

  private parseBTreeHeader(buf: Buffer, offset: number): BTreeHeaderRecord | null {
    if (offset + 106 > buf.length) return null

    // treeDepth (2), rootNode (4), leafRecords (4), firstLeafNode (4),
    // lastLeafNode (4), nodeSize (2), maxKeyLength (2), totalNodes (4), freeNodes (4)
    const rootNode = buf.readUInt32BE(offset + 2)
    const leafRecords = buf.readUInt32BE(offset + 6)
    const firstLeafNode = buf.readUInt32BE(offset + 10)
    const lastLeafNode = buf.readUInt32BE(offset + 14)
    const nodeSize = buf.readUInt16BE(offset + 18)
    const totalNodes = buf.readUInt32BE(offset + 22)

    if (nodeSize === 0 || totalNodes === 0) return null

    return {
      nodeSize,
      totalNodes,
      leafRecords,
      rootNode,
      firstLeafNode,
      lastLeafNode,
    }
  }

  /**
   * Traverse leaf nodes of the catalog B-tree looking for deleted records
   * in the slack space between valid records and the end of the node.
   */
  private async traverseLeafNodes(
    header: BTreeHeaderRecord,
    results: RecoverableFile[]
  ): Promise<void> {
    const vh = this.vh!
    let nodeIndex = header.firstLeafNode
    let nodesScanned = 0

    while (nodeIndex !== 0 && nodesScanned < MAX_NODES_TO_SCAN) {
      nodesScanned++

      const nodeOffset = this.catalogNodeOffset(nodeIndex, header.nodeSize)
      if (nodeOffset < 0n) break

      let nodeBuf: Buffer
      try {
        nodeBuf = await this.reader.read(nodeOffset, header.nodeSize)
      } catch {
        break
      }
      if (nodeBuf.length < header.nodeSize) break

      // Node descriptor (14 bytes)
      const fLink = nodeBuf.readUInt32BE(0) // forward link to next node
      const nodeType = nodeBuf[8]

      if (nodeType !== NODE_TYPE_LEAF) {
        nodeIndex = fLink
        continue
      }

      const numRecords = nodeBuf.readUInt16BE(10)

      // Record offsets are stored at the END of the node, growing backwards
      // Each offset is 2 bytes. The first offset (for record 0) is at
      // nodeSize - 2, the second at nodeSize - 4, etc.

      // Find the end of the last valid record to identify slack space
      let lastRecordEnd = 14 // After node descriptor
      for (let r = 0; r < numRecords; r++) {
        const offsetPos = header.nodeSize - (r + 1) * 2
        if (offsetPos < 0 || offsetPos + 2 > nodeBuf.length) break

        const recordOffset = nodeBuf.readUInt16BE(offsetPos)

        // Also get the next record offset (or free space offset) to determine size
        const nextOffsetPos = header.nodeSize - (r + 2) * 2
        let recordEnd: number
        if (r + 1 < numRecords && nextOffsetPos >= 0) {
          recordEnd = nodeBuf.readUInt16BE(nextOffsetPos)
        } else {
          // The free space offset follows the last record offset
          const freeSpacePos = header.nodeSize - (numRecords + 1) * 2
          if (freeSpacePos >= 0 && freeSpacePos + 2 <= nodeBuf.length) {
            recordEnd = nodeBuf.readUInt16BE(freeSpacePos)
          } else {
            recordEnd = recordOffset + MIN_RECORD_SIZE
          }
        }

        if (recordEnd > lastRecordEnd) {
          lastRecordEnd = recordEnd
        }
      }

      // Scan slack space for residual catalog file records
      const slackStart = lastRecordEnd
      const slackEnd = header.nodeSize - (numRecords + 1) * 2

      if (slackEnd > slackStart + MIN_RECORD_SIZE) {
        this.scanSlackSpace(nodeBuf, slackStart, slackEnd, results)
      }

      nodeIndex = fLink
    }
  }

  /**
   * Scan node slack space for remnants of deleted catalog records.
   * We look for the catalog file record type signature (0x0200) and
   * attempt to parse valid-looking records.
   */
  private scanSlackSpace(
    nodeBuf: Buffer,
    start: number,
    end: number,
    results: RecoverableFile[]
  ): void {
    for (let pos = start; pos + MIN_RECORD_SIZE <= end; pos += 2) {
      // A catalog key starts with keyLength (2 bytes) followed by parentID (4 bytes)
      // The record data follows the key. Look for file record type after the key.
      const keyLength = nodeBuf.readUInt16BE(pos)
      if (keyLength < 6 || keyLength > 512) continue

      const recordDataOffset = pos + 2 + keyLength
      // Align to 2-byte boundary
      const alignedOffset = recordDataOffset + (recordDataOffset % 2)

      if (alignedOffset + MIN_RECORD_SIZE > end) continue

      const recordType = nodeBuf.readUInt16BE(alignedOffset)
      if (recordType !== CATALOG_FILE_RECORD) continue

      // Try to extract the filename from the catalog key
      const filename = this.parseCatalogKeyName(nodeBuf, pos)
      if (!filename) continue

      // Parse the file record
      const file = this.parseCatalogFileRecord(nodeBuf, alignedOffset, filename)
      if (file) {
        results.push(file)
      }
    }
  }

  // ─── Journal Scanning ──────────────────────────────────────

  /**
   * Scan the HFS+ journal for deleted catalog entries.
   * The journal contains copies of modified blocks before they were committed.
   * Deleted file records may still be present in journal transactions.
   */
  private async scanJournal(results: RecoverableFile[]): Promise<void> {
    const vh = this.vh!
    if (vh.journalInfoBlock === 0) return

    const journalInfoOffset = BigInt(vh.journalInfoBlock) * BigInt(vh.blockSize)

    let jiBuf: Buffer
    try {
      jiBuf = await this.reader.read(journalInfoOffset, 180)
    } catch {
      return
    }
    if (jiBuf.length < 180) return

    // Journal info block structure (big-endian):
    //   flags (4), device_signature (32*4=128 bytes... actually simpler)
    //   We look for the journal header magic 0x4A4E4C78 ('JNLx')
    // The journal info block at offset 0:
    //   flags (4 bytes)
    //   device_signature (4*8 = 32 bytes)
    //   offset (8 bytes) - offset to journal header
    //   size (8 bytes) - journal size

    // Actually, the journal info block is:
    //   flags: UInt32BE
    //   device_signature: 32 bytes
    //   offset: UInt64BE
    //   size: UInt64BE

    const journalOffset = this.readUInt64BE(jiBuf, 36)
    const journalSize = this.readUInt64BE(jiBuf, 44)

    if (journalOffset === 0n || journalSize === 0n || journalSize > BigInt(256 * 1024 * 1024)) {
      return
    }

    // Read journal header to find transaction locations
    let journalHeader: Buffer
    try {
      journalHeader = await this.reader.read(journalOffset, 512)
    } catch {
      return
    }
    if (journalHeader.length < 48) return

    // Journal header magic: 0x4A4E4C78 ('JNLx')
    const jhMagic = journalHeader.readUInt32BE(0)
    if (jhMagic !== 0x4a4e4c78) return

    // Journal header fields:
    //   magic (4), endian (4), start (8), end (8), size (8), blhdr_size (4), checksum (4), jhdr_size (4)
    const jhStart = this.readUInt64BE(journalHeader, 8)
    const jhEnd = this.readUInt64BE(journalHeader, 16)
    const blhdrSize = journalHeader.readUInt32BE(32)

    if (blhdrSize === 0 || blhdrSize > 65536) return

    // Scan journal blocks looking for catalog file record patterns
    // This is a heuristic search through the circular journal buffer
    const scanSize = Number(journalSize < 2n * 1024n * 1024n ? journalSize : 2n * 1024n * 1024n)
    const chunkSize = Math.min(65536, scanSize)

    for (let off = 0; off < scanSize; off += chunkSize) {
      const readOffset = journalOffset + BigInt(off)
      let chunk: Buffer
      try {
        chunk = await this.reader.read(readOffset, chunkSize)
      } catch {
        continue
      }

      // Search for catalog file record signatures in the journal data
      for (let pos = 0; pos + MIN_RECORD_SIZE <= chunk.length; pos += 2) {
        const recordType = chunk.readUInt16BE(pos)
        if (recordType !== CATALOG_FILE_RECORD) continue

        // Heuristic: check if this looks like a valid file record
        // A file record starts with recordType (2), flags (2), reserved (4),
        // fileID (4), createDate (4), contentModDate (4), ...
        if (pos + 88 > chunk.length) continue

        const fileId = chunk.readUInt32BE(pos + 8)
        if (fileId < 16) continue // System file IDs are 1-15

        const createDate = chunk.readUInt32BE(pos + 12)
        const modDate = chunk.readUInt32BE(pos + 16)

        // Sanity: dates should be after 2000 in HFS+ epoch
        // HFS+ epoch is 1904, so year 2000 = ~3029529600 seconds
        if (createDate < 3029529600 || createDate > 4500000000) continue

        const file = this.parseJournalFileRecord(chunk, pos, fileId)
        if (file) {
          results.push(file)
        }
      }
    }
  }

  // ─── Catalog Record Parsers ─────────────────────────────────

  /**
   * Parse the filename from a catalog B-tree key.
   * Key format: keyLength (2), parentID (4), name (HFSUniStr255: length(2) + chars)
   */
  private parseCatalogKeyName(buf: Buffer, keyOffset: number): string | null {
    if (keyOffset + 8 > buf.length) return null

    const keyLength = buf.readUInt16BE(keyOffset)
    if (keyLength < 6) return null

    const nameOffset = keyOffset + 2 + 4 // skip keyLength + parentID
    if (nameOffset + 2 > buf.length) return null

    const nameLength = buf.readUInt16BE(nameOffset) // in Unicode characters
    if (nameLength === 0 || nameLength > 255) return null
    if (nameOffset + 2 + nameLength * 2 > buf.length) return null

    const chars: string[] = []
    for (let i = 0; i < nameLength; i++) {
      const charCode = buf.readUInt16BE(nameOffset + 2 + i * 2)
      if (charCode === 0) break
      chars.push(String.fromCharCode(charCode))
    }

    const name = chars.join('')
    return name.length > 0 ? name : null
  }

  /**
   * Parse a catalog file record (type 0x0200) from the B-tree.
   *
   * HFS+ Catalog File Record structure (big-endian):
   *   recordType (2): 0x0200
   *   flags (2)
   *   reserved (4)
   *   fileID (4)
   *   createDate (4)
   *   contentModDate (4)
   *   attrModDate (4)
   *   accessDate (4)
   *   backupDate (4)
   *   permissions (16)
   *   userInfo (16) - Finder info
   *   finderInfo (16) - extended Finder info
   *   textEncoding (4)
   *   reserved2 (4)
   *   dataFork: forkData (80)
   *   resourceFork: forkData (80)
   *
   * ForkData structure:
   *   logicalSize (8)
   *   clumpSize (4)
   *   totalBlocks (4)
   *   extents (8 records of 8 bytes each = 64 bytes)
   */
  private parseCatalogFileRecord(
    buf: Buffer,
    offset: number,
    filename: string
  ): RecoverableFile | null {
    if (offset + MIN_RECORD_SIZE > buf.length) return null

    const recordType = buf.readUInt16BE(offset)
    if (recordType !== CATALOG_FILE_RECORD) return null

    const fileId = buf.readUInt32BE(offset + 8)
    if (fileId === 0) return null

    const createDate = buf.readUInt32BE(offset + 12)
    const modDate = buf.readUInt32BE(offset + 16)

    // Data fork starts at offset 88
    const dataForkOffset = offset + 88
    if (dataForkOffset + 80 > buf.length) return null

    return this.buildRecoverableFile(buf, dataForkOffset, filename, createDate, modDate)
  }

  /**
   * Parse a file record found in the journal.
   * Since we don't have the catalog key, the filename is unknown.
   */
  private parseJournalFileRecord(
    buf: Buffer,
    offset: number,
    fileId: number
  ): RecoverableFile | null {
    // Data fork at offset + 88
    const dataForkOffset = offset + 88
    if (dataForkOffset + 80 > buf.length) return null

    const createDate = buf.readUInt32BE(offset + 12)
    const modDate = buf.readUInt32BE(offset + 16)
    const filename = `hfsplus_${fileId}_recovered`

    return this.buildRecoverableFile(buf, dataForkOffset, filename, createDate, modDate)
  }

  private buildRecoverableFile(
    buf: Buffer,
    dataForkOffset: number,
    filename: string,
    createDate: number,
    modDate: number
  ): RecoverableFile | null {
    const vh = this.vh!
    const logicalSize = this.readUInt64BE(buf, dataForkOffset)
    if (logicalSize === 0n) return null

    // Parse data fork extents (up to 8)
    const fragments: FileFragment[] = []
    for (let i = 0; i < 8; i++) {
      const extOffset = dataForkOffset + 16 + i * 8
      if (extOffset + 8 > buf.length) break

      const startBlock = buf.readUInt32BE(extOffset)
      const blockCount = buf.readUInt32BE(extOffset + 4)

      if (blockCount === 0) break

      fragments.push({
        offset: BigInt(startBlock) * BigInt(vh.blockSize),
        size: BigInt(blockCount) * BigInt(vh.blockSize),
      })
    }

    if (fragments.length === 0) return null

    // Extract extension
    const dotIndex = filename.lastIndexOf('.')
    const extension = dotIndex >= 0 ? filename.substring(dotIndex + 1).toLowerCase() : ''

    const mapping = EXTENSION_MAP[extension]
    const fileType: FileType = mapping?.type ?? 'jpeg'
    const category: FileCategory = mapping?.category ?? 'photo'

    const createdAt = this.parseHfsPlusTimestamp(createDate)
    const modifiedAt = this.parseHfsPlusTimestamp(modDate)

    let recoverability: 'good' | 'partial' | 'poor' = 'good'
    if (fragments.length > 3) recoverability = 'partial'
    if (fragments.length > 6) recoverability = 'poor'

    return {
      id: randomUUID(),
      type: fileType,
      category,
      offset: fragments[0].offset,
      size: logicalSize,
      sizeEstimated: false,
      name: filename,
      extension: extension || 'bin',
      recoverability,
      source: 'metadata',
      fragments,
      metadata: {
        originalName: filename,
        createdAt: createdAt ?? undefined,
        modifiedAt: modifiedAt ?? undefined,
      },
    }
  }

  // ─── Helpers ────────────────────────────────────────────────

  /**
   * Calculate the byte offset of a catalog B-tree node.
   * The catalog file is described by its extent records in the volume header.
   */
  private catalogNodeOffset(nodeIndex: number, nodeSize: number): bigint {
    const vh = this.vh!
    const byteOffset = BigInt(nodeIndex) * BigInt(nodeSize)

    // Find which extent contains this offset
    let extentStart = 0n
    for (const ext of vh.catalogExtents) {
      const extentSize = BigInt(ext.blockCount) * BigInt(vh.blockSize)
      if (byteOffset >= extentStart && byteOffset < extentStart + extentSize) {
        const relativeOffset = byteOffset - extentStart
        return BigInt(ext.startBlock) * BigInt(vh.blockSize) + relativeOffset
      }
      extentStart += extentSize
    }

    return -1n
  }

  private extentToOffset(extent: HfsPlusExtent): bigint {
    return BigInt(extent.startBlock) * BigInt(this.vh!.blockSize)
  }

  /**
   * Parse an HFS+ timestamp.
   * HFS+ uses seconds since 1904-01-01 00:00:00 UTC.
   */
  private parseHfsPlusTimestamp(seconds: number): Date | null {
    if (seconds === 0) return null

    const ms = HFSPLUS_EPOCH_OFFSET + seconds * 1000
    // Sanity: reject dates before 2000 or after 2100
    const date2000 = Date.UTC(2000, 0, 1)
    const date2100 = Date.UTC(2100, 0, 1)
    if (ms < date2000 || ms > date2100) return null

    try {
      return new Date(ms)
    } catch {
      return null
    }
  }

  /**
   * Read a 64-bit unsigned integer (big-endian) from a buffer as BigInt.
   */
  private readUInt64BE(buf: Buffer, offset: number): bigint {
    if (offset + 8 > buf.length) return 0n
    const high = buf.readUInt32BE(offset)
    const low = buf.readUInt32BE(offset + 4)
    return (BigInt(high) << 32n) | BigInt(low)
  }
}
