/**
 * ext4 Filesystem Parser
 *
 * Scans ext4 inode tables for deleted inodes. A deleted inode in ext4
 * has its deletion_time (i_dtime, offset 0x14) set to a nonzero value
 * and link_count (i_links_count, offset 0x1A) set to 0.
 *
 * For each deleted inode we extract:
 *   - File size from i_size_lo / i_size_high
 *   - Timestamps from i_ctime, i_mtime, i_atime
 *   - Data block mapping from the extent tree (if EXT4_EXTENTS_FL is set)
 *     or from indirect block pointers
 */

import { randomUUID } from 'crypto'
import type { BlockReader } from '../../io/block-reader'
import type {
  RecoverableFile,
  FileFragment,
  FileType,
  FileCategory,
} from '../../../shared/types'

// ─── ext4 Superblock Fields ─────────────────────────────────────

interface Ext4Superblock {
  /** Total inodes in the filesystem */
  totalInodes: number
  /** Block size in bytes */
  blockSize: number
  /** Inodes per group */
  inodesPerGroup: number
  /** Size of each inode in bytes */
  inodeSize: number
  /** Number of block groups */
  blockGroupCount: number
  /** Blocks per group */
  blocksPerGroup: number
  /** First data block (0 for 4K blocks, 1 for 1K blocks) */
  firstDataBlock: number
  /** Feature flags */
  featureIncompat: number
  /** 64-bit mode? */
  is64Bit: boolean
  /** Group descriptor size (32 or 64 bytes) */
  groupDescSize: number
}

// ─── ext4 Group Descriptor Fields ───────────────────────────────

interface Ext4GroupDescriptor {
  /** Block number of the inode table */
  inodeTableBlock: bigint
}

// ─── Constants ──────────────────────────────────────────────────

const SUPERBLOCK_OFFSET = 1024
const SUPERBLOCK_SIZE = 1024
const EXT4_MAGIC = 0x53ef

/** Inode flags */
const EXT4_EXTENTS_FL = 0x00080000

/** Extent tree magic */
const EXT4_EXTENT_MAGIC = 0xf30a

/** Maximum block groups to scan (safety limit) */
const MAX_BLOCK_GROUPS = 100_000

/** Maximum inodes to scan per group (safety limit) */
const MAX_INODES_PER_BATCH = 8192

/** Regular file mode mask */
const S_IFREG = 0o100000
const S_IFMT = 0o170000

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

export class Ext4Parser {
  private reader: BlockReader
  private sb: Ext4Superblock | null = null

  constructor(reader: BlockReader) {
    this.reader = reader
  }

  async parse(): Promise<RecoverableFile[]> {
    this.sb = await this.parseSuperblock()
    if (!this.sb) return []

    const results: RecoverableFile[] = []
    await this.scanAllGroups(results)
    return results
  }

  // ─── Superblock Parsing ─────────────────────────────────────

  private async parseSuperblock(): Promise<Ext4Superblock | null> {
    let buf: Buffer
    try {
      buf = await this.reader.read(BigInt(SUPERBLOCK_OFFSET), SUPERBLOCK_SIZE)
    } catch {
      return null
    }
    if (buf.length < 256) return null

    // Verify magic at offset 0x38 (56)
    const magic = buf.readUInt16LE(0x38)
    if (magic !== EXT4_MAGIC) return null

    const totalInodes = buf.readUInt32LE(0)
    const totalBlocksLow = buf.readUInt32LE(4)
    const firstDataBlock = buf.readUInt32LE(20)
    const blockSizeLog = buf.readUInt32LE(24)
    const blocksPerGroup = buf.readUInt32LE(32)
    const inodesPerGroup = buf.readUInt32LE(40)
    const inodeSizeRaw = buf.readUInt16LE(88)
    const featureIncompat = buf.readUInt32LE(96)

    // Block size = 1024 << s_log_block_size
    const blockSize = 1024 << blockSizeLog
    if (blockSize < 1024 || blockSize > 65536) return null

    // Inode size: default 128 for older ext2/3, typically 256 for ext4
    const inodeSize = inodeSizeRaw > 0 ? inodeSizeRaw : 128
    if (inodeSize < 128 || inodeSize > 4096) return null

    if (inodesPerGroup === 0 || blocksPerGroup === 0) return null

    // Calculate number of block groups
    const blockGroupCount = Math.ceil(totalBlocksLow / blocksPerGroup)

    // 64-bit feature flag
    const is64Bit = !!(featureIncompat & 0x0080)

    // Group descriptor size (32 for 32-bit, 64 for 64-bit)
    let groupDescSize = 32
    if (is64Bit && buf.length >= 256) {
      groupDescSize = buf.readUInt16LE(254)
      if (groupDescSize < 32) groupDescSize = 32
    }

    return {
      totalInodes,
      blockSize,
      inodesPerGroup,
      inodeSize,
      blockGroupCount,
      blocksPerGroup,
      firstDataBlock,
      featureIncompat,
      is64Bit,
      groupDescSize,
    }
  }

  // ─── Group Scanning ─────────────────────────────────────────

  private async scanAllGroups(results: RecoverableFile[]): Promise<void> {
    const sb = this.sb!
    const groupCount = Math.min(sb.blockGroupCount, MAX_BLOCK_GROUPS)

    for (let g = 0; g < groupCount; g++) {
      const gd = await this.readGroupDescriptor(g)
      if (!gd) continue

      await this.scanGroupInodes(g, gd, results)
    }
  }

  private async readGroupDescriptor(groupIndex: number): Promise<Ext4GroupDescriptor | null> {
    const sb = this.sb!

    // Group descriptors start in the block after the superblock
    // For block size 1024: superblock is in block 1, GDT starts at block 2
    // For block size >= 4096: superblock is in block 0, GDT starts at block 1
    const gdtStartBlock = sb.firstDataBlock + 1
    const gdtByteOffset = BigInt(gdtStartBlock) * BigInt(sb.blockSize) +
      BigInt(groupIndex) * BigInt(sb.groupDescSize)

    let buf: Buffer
    try {
      buf = await this.reader.read(gdtByteOffset, sb.groupDescSize)
    } catch {
      return null
    }
    if (buf.length < 32) return null

    // Inode table block (low 32 bits at offset 8, high 32 bits at offset 40 for 64-bit)
    let inodeTableBlock = BigInt(buf.readUInt32LE(8))
    if (sb.is64Bit && sb.groupDescSize >= 64 && buf.length >= 44) {
      const high = BigInt(buf.readUInt32LE(40))
      inodeTableBlock |= high << 32n
    }

    if (inodeTableBlock === 0n) return null

    return { inodeTableBlock }
  }

  // ─── Inode Scanning ─────────────────────────────────────────

  private async scanGroupInodes(
    groupIndex: number,
    gd: Ext4GroupDescriptor,
    results: RecoverableFile[]
  ): Promise<void> {
    const sb = this.sb!
    const inodesInGroup = Math.min(sb.inodesPerGroup, MAX_INODES_PER_BATCH)
    const tableOffset = gd.inodeTableBlock * BigInt(sb.blockSize)

    // Read inodes in batches to reduce I/O calls
    const batchSize = Math.min(64, inodesInGroup)
    const batchBytes = batchSize * sb.inodeSize

    for (let i = 0; i < inodesInGroup; i += batchSize) {
      const count = Math.min(batchSize, inodesInGroup - i)
      const readSize = count * sb.inodeSize
      const offset = tableOffset + BigInt(i) * BigInt(sb.inodeSize)

      let buf: Buffer
      try {
        buf = await this.reader.read(offset, readSize)
      } catch {
        continue
      }

      for (let j = 0; j < count; j++) {
        const inodeOffset = j * sb.inodeSize
        if (inodeOffset + 128 > buf.length) break

        const inodeNumber = groupIndex * sb.inodesPerGroup + i + j + 1 // 1-based
        const file = this.parseInode(buf, inodeOffset, inodeNumber, sb)
        if (file) {
          results.push(file)
        }
      }
    }
  }

  // ─── Inode Parsing ──────────────────────────────────────────

  private parseInode(
    buf: Buffer,
    offset: number,
    inodeNumber: number,
    sb: Ext4Superblock
  ): RecoverableFile | null {
    // Skip inodes 0 and 1-10 (reserved)
    if (inodeNumber <= 10) return null

    // i_mode (offset 0, 2 bytes): file type and permissions
    const mode = buf.readUInt16LE(offset)
    const fileTypeBits = mode & S_IFMT

    // Only recover regular files
    if (fileTypeBits !== S_IFREG) return null

    // i_links_count (offset 0x1A, 2 bytes)
    const linkCount = buf.readUInt16LE(offset + 0x1a)

    // i_dtime (offset 0x14, 4 bytes) - deletion time
    const deletionTime = buf.readUInt32LE(offset + 0x14)

    // A deleted inode has deletion_time != 0 and link_count == 0
    if (deletionTime === 0 || linkCount !== 0) return null

    // i_size_lo (offset 0x04, 4 bytes)
    const sizeLow = buf.readUInt32LE(offset + 0x04)

    // i_size_high (offset 0x6C, 4 bytes) if inode is large enough
    let sizeHigh = 0
    if (sb.inodeSize >= 128 && offset + 0x6c + 4 <= buf.length) {
      sizeHigh = buf.readUInt32LE(offset + 0x6c)
    }
    const fileSize = (BigInt(sizeHigh) << 32n) | BigInt(sizeLow)

    if (fileSize === 0n) return null

    // Timestamps
    // i_atime (offset 0x08), i_ctime (offset 0x0C), i_mtime (offset 0x10)
    const createdAt = this.parseUnixTimestamp(buf.readUInt32LE(offset + 0x0c))
    const modifiedAt = this.parseUnixTimestamp(buf.readUInt32LE(offset + 0x10))
    const deletedAt = this.parseUnixTimestamp(deletionTime)

    // i_flags (offset 0x20, 4 bytes)
    const flags = buf.readUInt32LE(offset + 0x20)

    // Parse data block mapping
    let fragments: FileFragment[] = []

    if (flags & EXT4_EXTENTS_FL) {
      // Extent tree starts at offset 0x28 in the inode (i_block area, 60 bytes)
      fragments = this.parseExtentTree(buf, offset + 0x28, sb)
    } else {
      // Traditional indirect block pointers at offset 0x28
      fragments = this.parseIndirectBlocks(buf, offset + 0x28, sb, fileSize)
    }

    const primaryOffset = fragments.length > 0 ? fragments[0].offset : 0n

    // Generate a synthetic name since ext4 doesn't store the filename in the inode
    const name = `inode_${inodeNumber}_deleted`

    // Assess recoverability
    let recoverability: 'good' | 'partial' | 'poor' = 'good'
    if (fragments.length === 0) recoverability = 'poor'
    else if (fragments.length > 5) recoverability = 'partial'

    return {
      id: randomUUID(),
      type: 'jpeg', // Without filename we can't determine type; consumer can re-classify via carving
      category: 'photo',
      offset: primaryOffset,
      size: fileSize,
      sizeEstimated: false,
      name,
      extension: 'bin', // Unknown without directory entry
      recoverability,
      source: 'metadata',
      fragments: fragments.length > 0 ? fragments : undefined,
      metadata: {
        createdAt: createdAt ?? undefined,
        modifiedAt: modifiedAt ?? undefined,
      },
    }
  }

  // ─── Extent Tree Parsing ────────────────────────────────────

  /**
   * Parse an ext4 extent tree.
   *
   * The tree starts with a 12-byte header:
   *   - magic (2 bytes): 0xF30A
   *   - entries (2 bytes): number of valid entries
   *   - max (2 bytes): maximum entries
   *   - depth (2 bytes): 0 = leaf node, >0 = index node
   *   - generation (4 bytes)
   *
   * Leaf entries (12 bytes each):
   *   - ee_block (4 bytes): logical block
   *   - ee_len (2 bytes): number of blocks (high bit = uninitialized)
   *   - ee_start_hi (2 bytes): upper 16 bits of physical block
   *   - ee_start_lo (4 bytes): lower 32 bits of physical block
   *
   * Index entries (12 bytes each):
   *   - ei_block (4 bytes): logical block covered
   *   - ei_leaf_lo (4 bytes): lower 32 bits of child node block
   *   - ei_leaf_hi (2 bytes): upper 16 bits
   *   - ei_unused (2 bytes)
   */
  private parseExtentTree(buf: Buffer, offset: number, sb: Ext4Superblock): FileFragment[] {
    if (offset + 12 > buf.length) return []

    const magic = buf.readUInt16LE(offset)
    if (magic !== EXT4_EXTENT_MAGIC) return []

    const entries = buf.readUInt16LE(offset + 2)
    const depth = buf.readUInt16LE(offset + 6)

    const fragments: FileFragment[] = []

    if (depth === 0) {
      // Leaf node: parse extent entries
      for (let i = 0; i < entries; i++) {
        const entryOffset = offset + 12 + i * 12
        if (entryOffset + 12 > buf.length) break

        const extLen = buf.readUInt16LE(entryOffset + 4)
        const len = extLen & 0x7fff // clear uninitialized flag
        if (len === 0) continue

        const startHi = buf.readUInt16LE(entryOffset + 6)
        const startLo = buf.readUInt32LE(entryOffset + 8)
        const physicalBlock = (BigInt(startHi) << 32n) | BigInt(startLo)

        fragments.push({
          offset: physicalBlock * BigInt(sb.blockSize),
          size: BigInt(len) * BigInt(sb.blockSize),
        })
      }
    }
    // For non-zero depth we would need to read child blocks from the device,
    // but the extent tree root in the inode only has 60 bytes of space.
    // Deep trees are less common for small-to-medium files. We record what
    // we can from the inline root and mark recoverability accordingly.

    return fragments
  }

  // ─── Indirect Block Parsing ─────────────────────────────────

  /**
   * Parse traditional (pre-extent) block pointers.
   * The i_block array has 15 entries (4 bytes each):
   *   - 0-11: direct block pointers
   *   - 12: single indirect
   *   - 13: double indirect
   *   - 14: triple indirect
   *
   * For deleted file recovery we only use the direct pointers since
   * the indirect blocks may have been overwritten.
   */
  private parseIndirectBlocks(
    buf: Buffer,
    offset: number,
    sb: Ext4Superblock,
    _fileSize: bigint
  ): FileFragment[] {
    const fragments: FileFragment[] = []

    // Read 12 direct block pointers
    for (let i = 0; i < 12; i++) {
      const bpOffset = offset + i * 4
      if (bpOffset + 4 > buf.length) break

      const blockNum = buf.readUInt32LE(bpOffset)
      if (blockNum === 0) continue

      fragments.push({
        offset: BigInt(blockNum) * BigInt(sb.blockSize),
        size: BigInt(sb.blockSize),
      })
    }

    // Merge contiguous fragments
    return this.mergeContiguousFragments(fragments)
  }

  // ─── Helpers ────────────────────────────────────────────────

  /**
   * Merge contiguous file fragments to reduce the fragment list.
   */
  private mergeContiguousFragments(fragments: FileFragment[]): FileFragment[] {
    if (fragments.length <= 1) return fragments

    const merged: FileFragment[] = [fragments[0]]

    for (let i = 1; i < fragments.length; i++) {
      const prev = merged[merged.length - 1]
      const curr = fragments[i]

      if (prev.offset + prev.size === curr.offset) {
        // Contiguous: extend the previous fragment
        merged[merged.length - 1] = {
          offset: prev.offset,
          size: prev.size + curr.size,
        }
      } else {
        merged.push(curr)
      }
    }

    return merged
  }

  private parseUnixTimestamp(seconds: number): Date | null {
    if (seconds === 0) return null
    // Sanity check: reject dates before 2000 or after 2100
    // (deleted file timestamps should be recent)
    if (seconds < 946684800 || seconds > 4102444800) return null

    try {
      return new Date(seconds * 1000)
    } catch {
      return null
    }
  }
}
