/**
 * Filesystem Allocation Bitmap
 *
 * Reads block/cluster allocation state from ext4, NTFS, or FAT32 so
 * the carving worker can skip allocated (live) regions and only scan
 * free (potentially deleted) space.
 *
 * A unified `AllocationBitmap` interface is returned regardless of the
 * underlying filesystem type. `loadAllocationBitmap` auto-detects the
 * filesystem by trying ext4, NTFS, then FAT32 in order.
 */

import * as fs from 'fs'
import { promisify } from 'util'

const fsRead = promisify(fs.read)

// ─── Common interface ────────────────────────────────────────

export interface AllocationBitmap {
  /** Filesystem: 'ext4' | 'ntfs' | 'fat32' */
  fsType: string
  /** Block/cluster size in bytes */
  blockSize: number
  /** Total number of blocks/clusters tracked */
  totalBlocks: number
  /** Check if a single block/cluster is allocated (by block number) */
  isBlockAllocated(blockNumber: number): boolean
  /** Check if a raw device byte offset falls in an allocated block */
  isByteAllocated(byteOffset: bigint): boolean
  /** Check if every block in a byte range is allocated (fast-path skip) */
  isChunkFullyAllocated(byteOffset: bigint, chunkSize: number): boolean
}

// ─── Safety caps ─────────────────────────────────────────────

const MAX_BLOCK_GROUPS = 100_000
/** Cap the total bitmap buffer to 64 MB to avoid OOM. */
const MAX_BITMAP_BYTES = 64 * 1024 * 1024
/** Maximum FAT entries (clusters) to read — ~500 MB of FAT table. */
const MAX_FAT_CLUSTERS = 128_000_000

// ═══════════════════════════════════════════════════════════════
//  ext4
// ═══════════════════════════════════════════════════════════════

const EXT4_SB_OFFSET = 1024
const EXT4_SB_SIZE = 1024
const EXT4_MAGIC = 0x53ef

interface Ext4SbInfo {
  blockSize: number
  blocksPerGroup: number
  blockGroupCount: number
  firstDataBlock: number
  is64Bit: boolean
  groupDescSize: number
}

async function parseExt4Superblock(fd: number): Promise<Ext4SbInfo | null> {
  const buf = Buffer.alloc(EXT4_SB_SIZE)
  try {
    const r = await fsRead(fd, buf, 0, EXT4_SB_SIZE, EXT4_SB_OFFSET)
    if (r.bytesRead < 256) return null
  } catch {
    return null
  }

  if (buf.readUInt16LE(0x38) !== EXT4_MAGIC) return null

  const totalBlocksLow = buf.readUInt32LE(4)
  const firstDataBlock = buf.readUInt32LE(20)
  const blockSizeLog = buf.readUInt32LE(24)
  const blocksPerGroup = buf.readUInt32LE(32)
  const featureIncompat = buf.readUInt32LE(96)

  const blockSize = 1024 << blockSizeLog
  if (blockSize < 1024 || blockSize > 65536) return null
  if (blocksPerGroup === 0) return null

  const blockGroupCount = Math.ceil(totalBlocksLow / blocksPerGroup)
  const is64Bit = !!(featureIncompat & 0x0080)

  let groupDescSize = 32
  if (is64Bit) {
    groupDescSize = buf.readUInt16LE(254)
    if (groupDescSize < 32) groupDescSize = 32
  }

  return { blockSize, blocksPerGroup, blockGroupCount, firstDataBlock, is64Bit, groupDescSize }
}

async function loadExt4(fd: number): Promise<AllocationBitmap | null> {
  const sb = await parseExt4Superblock(fd)
  if (!sb) return null

  const groupCount = Math.min(sb.blockGroupCount, MAX_BLOCK_GROUPS)
  const gdtStartByte = BigInt(sb.firstDataBlock + 1) * BigInt(sb.blockSize)
  const bitmaps: Buffer[] = []

  for (let g = 0; g < groupCount; g++) {
    const gdOffset = Number(gdtStartByte) + g * sb.groupDescSize

    const gdBuf = Buffer.alloc(sb.groupDescSize)
    let gdBytesRead: number
    try {
      const r = await fsRead(fd, gdBuf, 0, sb.groupDescSize, gdOffset)
      gdBytesRead = r.bytesRead
    } catch {
      bitmaps.push(Buffer.alloc(sb.blockSize, 0xff))
      continue
    }

    if (gdBytesRead < 8) {
      bitmaps.push(Buffer.alloc(sb.blockSize, 0xff))
      continue
    }

    let bitmapBlock = BigInt(gdBuf.readUInt32LE(0))
    if (sb.is64Bit && sb.groupDescSize >= 36 && gdBytesRead >= 36) {
      bitmapBlock |= BigInt(gdBuf.readUInt32LE(32)) << 32n
    }

    if (bitmapBlock === 0n) {
      bitmaps.push(Buffer.alloc(sb.blockSize, 0xff))
      continue
    }

    const bitmapBuf = Buffer.alloc(sb.blockSize)
    try {
      const r = await fsRead(fd, bitmapBuf, 0, sb.blockSize, Number(bitmapBlock * BigInt(sb.blockSize)))
      if (r.bytesRead < sb.blockSize) bitmapBuf.fill(0xff, r.bytesRead)
    } catch {
      bitmapBuf.fill(0xff)
    }

    bitmaps.push(bitmapBuf)
  }

  const totalBlocks = groupCount * sb.blocksPerGroup
  const { blockSize, blocksPerGroup } = sb

  return {
    fsType: 'ext4',
    blockSize,
    totalBlocks,
    isBlockAllocated(blockNumber: number): boolean {
      const gi = Math.floor(blockNumber / blocksPerGroup)
      if (gi >= groupCount) return true
      const bitIdx = blockNumber % blocksPerGroup
      const byteIdx = bitIdx >> 3
      const bitOff = bitIdx & 7
      const buf = bitmaps[gi]
      if (byteIdx >= buf.length) return true
      return (buf[byteIdx] & (1 << bitOff)) !== 0
    },
    isByteAllocated(byteOffset: bigint): boolean {
      return this.isBlockAllocated(Number(byteOffset / BigInt(blockSize)))
    },
    isChunkFullyAllocated(byteOffset: bigint, chunkSize: number): boolean {
      const startBlock = Number(byteOffset / BigInt(blockSize))
      const endBlock = Number((byteOffset + BigInt(chunkSize) - 1n) / BigInt(blockSize))
      for (let b = startBlock; b <= endBlock; b++) {
        if (!this.isBlockAllocated(b)) return false
      }
      return true
    },
  }
}

// ═══════════════════════════════════════════════════════════════
//  NTFS
// ═══════════════════════════════════════════════════════════════

const MFT_SIGNATURE = 0x454c4946 // "FILE"
const ATTR_DATA = 0x80
const ATTR_END = 0xffffffff
/** MFT entry #6 is $Bitmap — the cluster allocation bitmap. */
const BITMAP_MFT_INDEX = 6

interface NtfsBootInfo {
  bytesPerSector: number
  sectorsPerCluster: number
  clusterSize: number
  mftStartOffset: bigint
  mftEntrySize: number
  totalClusters: number
}

async function parseNtfsBoot(fd: number): Promise<NtfsBootInfo | null> {
  const buf = Buffer.alloc(512)
  try {
    const r = await fsRead(fd, buf, 0, 512, 0)
    if (r.bytesRead < 512) return null
  } catch {
    return null
  }

  const oem = buf.subarray(3, 7).toString('ascii')
  if (oem !== 'NTFS') return null

  const bytesPerSector = buf.readUInt16LE(11)
  const sectorsPerCluster = buf[13]
  if (
    bytesPerSector < 512 || bytesPerSector > 4096 ||
    (bytesPerSector & (bytesPerSector - 1)) !== 0 ||
    sectorsPerCluster === 0
  ) return null

  const clusterSize = bytesPerSector * sectorsPerCluster

  // Total sectors (8 bytes at offset 40)
  const totalSectorsLow = buf.readUInt32LE(40)
  const totalSectorsHigh = buf.readUInt32LE(44)
  const totalSectors = (BigInt(totalSectorsHigh) << 32n) | BigInt(totalSectorsLow)
  const totalClusters = Number(totalSectors / BigInt(sectorsPerCluster))

  // MFT start cluster (8 bytes at offset 48)
  const mftClusterLow = buf.readUInt32LE(48)
  const mftClusterHigh = buf.readInt32LE(52)
  const mftStartCluster = (BigInt(mftClusterHigh) << 32n) | BigInt(mftClusterLow >>> 0)
  if (mftStartCluster <= 0n) return null
  const mftStartOffset = mftStartCluster * BigInt(clusterSize)

  // MFT entry size (offset 64, signed byte)
  const raw = buf.readInt8(64)
  let mftEntrySize: number
  if (raw > 0) {
    mftEntrySize = raw * clusterSize
  } else {
    mftEntrySize = 1 << (-raw)
  }
  if (mftEntrySize < 256 || mftEntrySize > 65536) mftEntrySize = 1024

  return { bytesPerSector, sectorsPerCluster, clusterSize, mftStartOffset, mftEntrySize, totalClusters }
}

/**
 * Apply NTFS fixup array to an MFT entry buffer (in-place copy).
 */
function applyNtfsFixups(entry: Buffer): Buffer | null {
  if (entry.length < 48) return null
  const fixupOffset = entry.readUInt16LE(4)
  const fixupCount = entry.readUInt16LE(6)
  if (fixupCount < 2 || fixupOffset + fixupCount * 2 > entry.length) return entry
  const result = Buffer.from(entry)
  const signature = result.readUInt16LE(fixupOffset)
  for (let i = 1; i < fixupCount; i++) {
    const sectorEnd = i * 512 - 2
    if (sectorEnd + 1 >= result.length) break
    // Ignore signature mismatch — partial data is acceptable for bitmap loading
    void signature
    const original = result.readUInt16LE(fixupOffset + i * 2)
    result.writeUInt16LE(original, sectorEnd)
  }
  return result
}

/**
 * Decode an NTFS data run list into an array of { lcn, length } in clusters.
 */
function decodeNtfsRunList(buf: Buffer, startOffset: number): Array<{ lcn: bigint; clusters: bigint }> {
  const runs: Array<{ lcn: bigint; clusters: bigint }> = []
  let pos = startOffset
  let prevLcn = 0n

  while (pos < buf.length) {
    const header = buf[pos]
    if (header === 0) break

    const lenSize = header & 0x0f
    const offSize = (header >> 4) & 0x0f
    pos++

    if (lenSize === 0 || pos + lenSize + offSize > buf.length) break

    let runLength = 0n
    for (let i = 0; i < lenSize; i++) runLength |= BigInt(buf[pos + i]) << BigInt(i * 8)
    pos += lenSize

    if (offSize === 0) { pos += offSize; continue } // sparse

    let runOffset = 0n
    for (let i = 0; i < offSize; i++) runOffset |= BigInt(buf[pos + i]) << BigInt(i * 8)
    const signBit = 1n << BigInt(offSize * 8 - 1)
    if (runOffset & signBit) runOffset -= 1n << BigInt(offSize * 8)
    pos += offSize

    const lcn = prevLcn + runOffset
    prevLcn = lcn
    if (lcn < 0n) continue

    runs.push({ lcn, clusters: runLength })
  }

  return runs
}

async function loadNtfs(fd: number): Promise<AllocationBitmap | null> {
  const boot = await parseNtfsBoot(fd)
  if (!boot) return null

  // Read MFT entry #6 ($Bitmap)
  const entryOffset = boot.mftStartOffset + BigInt(BITMAP_MFT_INDEX) * BigInt(boot.mftEntrySize)
  const rawEntry = Buffer.alloc(boot.mftEntrySize)
  try {
    const r = await fsRead(fd, rawEntry, 0, boot.mftEntrySize, Number(entryOffset))
    if (r.bytesRead < boot.mftEntrySize) return null
  } catch {
    return null
  }

  if (rawEntry.readUInt32LE(0) !== MFT_SIGNATURE) return null

  const entry = applyNtfsFixups(rawEntry)
  if (!entry) return null

  // Walk attributes to find $DATA (0x80) — the cluster bitmap data
  const firstAttr = entry.readUInt16LE(0x14)
  if (firstAttr < 56 || firstAttr >= entry.length) return null

  let attrOff = firstAttr
  let runs: Array<{ lcn: bigint; clusters: bigint }> = []

  while (attrOff + 16 <= entry.length) {
    const attrType = entry.readUInt32LE(attrOff)
    if (attrType === ATTR_END || attrType === 0) break
    const attrLen = entry.readUInt32LE(attrOff + 4)
    if (attrLen < 16 || attrLen > entry.length - attrOff) break

    if (attrType === ATTR_DATA) {
      const nonResident = entry[attrOff + 8]
      if (nonResident !== 0) {
        // Non-resident $DATA — parse run list
        const rlOff = entry.readUInt16LE(attrOff + 32)
        runs = decodeNtfsRunList(entry, attrOff + rlOff)
      }
      // Resident $Bitmap would be tiny (impossible for real volumes), skip
      break
    }

    attrOff += attrLen
  }

  if (runs.length === 0) return null

  // Read the bitmap data from the runs.
  // Each bit = 1 cluster. bit=1 → allocated, bit=0 → free.
  const totalClusters = boot.totalClusters
  const bitmapBytes = Math.ceil(totalClusters / 8)
  if (bitmapBytes > MAX_BITMAP_BYTES) return null // Too large

  const bitmap = Buffer.alloc(bitmapBytes, 0xff) // default allocated
  let bitmapPos = 0

  for (const run of runs) {
    const runBytes = Number(run.clusters) * boot.clusterSize
    const readLen = Math.min(runBytes, bitmapBytes - bitmapPos)
    if (readLen <= 0) break

    try {
      const r = await fsRead(fd, bitmap, bitmapPos, readLen, Number(run.lcn * BigInt(boot.clusterSize)))
      bitmapPos += r.bytesRead
    } catch {
      // Leave the rest as 0xFF (allocated = conservative)
      bitmapPos += readLen
    }
  }

  const clusterSize = boot.clusterSize

  return {
    fsType: 'ntfs',
    blockSize: clusterSize,
    totalBlocks: totalClusters,
    isBlockAllocated(clusterNumber: number): boolean {
      if (clusterNumber < 0 || clusterNumber >= totalClusters) return true
      const byteIdx = clusterNumber >> 3
      const bitOff = clusterNumber & 7
      if (byteIdx >= bitmap.length) return true
      return (bitmap[byteIdx] & (1 << bitOff)) !== 0
    },
    isByteAllocated(byteOffset: bigint): boolean {
      return this.isBlockAllocated(Number(byteOffset / BigInt(clusterSize)))
    },
    isChunkFullyAllocated(byteOffset: bigint, chunkSize: number): boolean {
      const startCluster = Number(byteOffset / BigInt(clusterSize))
      const endCluster = Number((byteOffset + BigInt(chunkSize) - 1n) / BigInt(clusterSize))
      for (let c = startCluster; c <= endCluster; c++) {
        if (!this.isBlockAllocated(c)) return false
      }
      return true
    },
  }
}

// ═══════════════════════════════════════════════════════════════
//  FAT32
// ═══════════════════════════════════════════════════════════════

interface Fat32BootInfo {
  bytesPerSector: number
  sectorsPerCluster: number
  clusterSize: number
  reservedSectors: number
  fatCount: number
  fatSizeSectors: number
  totalClusters: number
}

async function parseFat32Boot(fd: number): Promise<Fat32BootInfo | null> {
  const buf = Buffer.alloc(512)
  try {
    const r = await fsRead(fd, buf, 0, 512, 0)
    if (r.bytesRead < 512) return null
  } catch {
    return null
  }

  // FAT32 has no single magic number. Check for plausible BPB fields.
  const bytesPerSector = buf.readUInt16LE(11)
  const sectorsPerCluster = buf[13]
  const reservedSectors = buf.readUInt16LE(14)
  const fatCount = buf[16]
  const fatSizeSectors = buf.readUInt32LE(36)

  // Root entry count must be 0 for FAT32
  const rootEntryCount = buf.readUInt16LE(17)
  if (rootEntryCount !== 0) return null

  if (
    bytesPerSector < 512 || bytesPerSector > 4096 ||
    (bytesPerSector & (bytesPerSector - 1)) !== 0 ||
    sectorsPerCluster === 0 ||
    (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0 ||
    reservedSectors === 0 ||
    fatCount === 0 || fatCount > 4 ||
    fatSizeSectors === 0
  ) return null

  // Total sectors
  let totalSectors = buf.readUInt16LE(19)
  if (totalSectors === 0) totalSectors = buf.readUInt32LE(32)
  if (totalSectors === 0) return null

  const clusterSize = bytesPerSector * sectorsPerCluster
  const dataStart = reservedSectors + fatCount * fatSizeSectors
  const dataSectors = totalSectors - dataStart
  const totalClusters = Math.floor(dataSectors / sectorsPerCluster)

  // FAT32 requires >= 65525 clusters
  if (totalClusters < 65525) return null

  return { bytesPerSector, sectorsPerCluster, clusterSize, reservedSectors, fatCount, fatSizeSectors, totalClusters }
}

async function loadFat32(fd: number): Promise<AllocationBitmap | null> {
  const boot = await parseFat32Boot(fd)
  if (!boot) return null

  const clusterCount = Math.min(boot.totalClusters + 2, MAX_FAT_CLUSTERS) // +2 for reserved entries 0 and 1

  // Build a compact 1-bit-per-cluster bitmap from the FAT table.
  // FAT entry: 4 bytes per cluster (28 bits used). 0 = free, non-zero = allocated.
  const bitmapBytes = Math.ceil(clusterCount / 8)
  if (bitmapBytes > MAX_BITMAP_BYTES) return null

  const bitmap = Buffer.alloc(bitmapBytes, 0xff) // default allocated

  const fatByteOffset = boot.reservedSectors * boot.bytesPerSector
  const fatByteSize = clusterCount * 4

  // Read FAT in 1 MB chunks to avoid a single huge allocation
  const FAT_READ_CHUNK = 1024 * 1024
  const fatBuf = Buffer.alloc(FAT_READ_CHUNK)

  for (let pos = 0; pos < fatByteSize; pos += FAT_READ_CHUNK) {
    const readLen = Math.min(FAT_READ_CHUNK, fatByteSize - pos)
    let bytesRead: number
    try {
      const r = await fsRead(fd, fatBuf, 0, readLen, fatByteOffset + pos)
      bytesRead = r.bytesRead
    } catch {
      // Leave the rest as allocated
      break
    }

    // Process 4-byte FAT entries in this chunk
    const entriesInChunk = Math.floor(bytesRead / 4)
    const firstCluster = pos / 4

    for (let i = 0; i < entriesInChunk; i++) {
      const cluster = firstCluster + i
      if (cluster >= clusterCount) break

      const entry = fatBuf.readUInt32LE(i * 4) & 0x0fffffff
      if (entry === 0) {
        // Free cluster — clear the bit
        const byteIdx = cluster >> 3
        const bitOff = cluster & 7
        bitmap[byteIdx] &= ~(1 << bitOff)
      }
      // Non-zero entries stay as 1 (allocated)
    }
  }

  // Clusters 0 and 1 are reserved, always mark allocated
  bitmap[0] |= 0x03

  const clusterSize = boot.clusterSize
  const totalClusters = boot.totalClusters

  const dataStartByte = BigInt(boot.reservedSectors + boot.fatCount * boot.fatSizeSectors) * BigInt(boot.bytesPerSector)

  return {
    fsType: 'fat32',
    blockSize: clusterSize,
    totalBlocks: totalClusters,
    isBlockAllocated(clusterNumber: number): boolean {
      if (clusterNumber < 0 || clusterNumber >= clusterCount) return true
      const byteIdx = clusterNumber >> 3
      const bitOff = clusterNumber & 7
      if (byteIdx >= bitmap.length) return true
      return (bitmap[byteIdx] & (1 << bitOff)) !== 0
    },
    isByteAllocated(byteOffset: bigint): boolean {
      // Bytes before the data region (boot sector, FAT tables) → allocated
      if (byteOffset < dataStartByte) return true
      const cluster = Number((byteOffset - dataStartByte) / BigInt(clusterSize)) + 2
      return this.isBlockAllocated(cluster)
    },
    isChunkFullyAllocated(byteOffset: bigint, chunkSize: number): boolean {
      // If the chunk is before the data region (boot/FAT area), treat as allocated
      if (byteOffset + BigInt(chunkSize) <= dataStartByte) return true

      // Convert byte offsets to cluster numbers (clusters 2+ map to data region)
      const effectiveStart = byteOffset > dataStartByte ? byteOffset - dataStartByte : 0n
      const effectiveEnd = byteOffset + BigInt(chunkSize) - 1n - dataStartByte
      if (effectiveEnd < 0n) return true

      const startCluster = Number(effectiveStart / BigInt(clusterSize)) + 2
      const endCluster = Number(effectiveEnd / BigInt(clusterSize)) + 2

      for (let c = startCluster; c <= endCluster; c++) {
        if (!this.isBlockAllocated(c)) return false
      }
      return true
    },
  }
}

// ═══════════════════════════════════════════════════════════════
//  Unified loader
// ═══════════════════════════════════════════════════════════════

/**
 * Auto-detect the filesystem and load its allocation bitmap.
 * Tries ext4 → NTFS → FAT32 in order.
 * Returns `null` if no supported filesystem is detected or on error.
 */
export async function loadAllocationBitmap(fd: number): Promise<AllocationBitmap | null> {
  // Try ext4 first (superblock at 1024, distinct magic)
  try {
    const ext4 = await loadExt4(fd)
    if (ext4) return ext4
  } catch { /* not ext4 */ }

  // Try NTFS (boot sector "NTFS" at offset 3)
  try {
    const ntfs = await loadNtfs(fd)
    if (ntfs) return ntfs
  } catch { /* not NTFS */ }

  // Try FAT32 (BPB heuristic)
  try {
    const fat32 = await loadFat32(fd)
    if (fat32) return fat32
  } catch { /* not FAT32 */ }

  return null
}
