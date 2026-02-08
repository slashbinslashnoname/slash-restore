/**
 * Metadata worker thread - Recovers file references from filesystem metadata.
 *
 * This worker attempts to read and parse filesystem structures (superblocks,
 * directory entries, inode tables, FAT, MFT) to find files that may still be
 * referenced in the filesystem metadata even after deletion.
 *
 * Communication protocol (parentPort):
 *   Worker -> Main: { type: 'progress', sessionId, data: ScanProgress }
 *   Worker -> Main: { type: 'file-found', sessionId, data: RecoverableFile }
 *   Worker -> Main: { type: 'complete', sessionId }
 *   Worker -> Main: { type: 'error', sessionId, data: { error: string } }
 *   Main -> Worker: { type: 'pause' | 'resume' | 'cancel' }
 *
 * workerData shape:
 *   {
 *     sessionId: string,
 *     devicePath: string,
 *     fileCategories: FileCategory[],
 *     filesystemType?: FilesystemType
 *   }
 */

import { parentPort, workerData } from 'worker_threads'
import * as fs from 'fs'
import { promisify } from 'util'
import { v4 as uuidv4 } from 'uuid'
import { SECTOR_SIZE } from '../../shared/constants/file-signatures'
import type {
  FileCategory,
  FileType,
  FilesystemType,
  RecoverableFile,
  ScanProgress
} from '../../shared/types'

const fsOpen = promisify(fs.open)
const fsRead = promisify(fs.read)
const fsClose = promisify(fs.close)

if (!parentPort) {
  throw new Error('metadata.worker.ts must be run as a worker thread')
}

const port = parentPort

// ─── Worker configuration from workerData ───────────────────────

interface MetadataWorkerData {
  sessionId: string
  devicePath: string
  fileCategories: FileCategory[]
  fileTypes?: FileType[]
  deviceSize: string
  filesystemType?: FilesystemType
  scanPartitions?: boolean
}

const config = workerData as MetadataWorkerData
const sessionId = config.sessionId

// ─── Control state ──────────────────────────────────────────────

let paused = false
let cancelled = false
let pauseResolve: (() => void) | null = null

port.on('message', (msg: { type: string }) => {
  switch (msg.type) {
    case 'pause':
      paused = true
      break
    case 'resume':
      paused = false
      if (pauseResolve) {
        pauseResolve()
        pauseResolve = null
      }
      break
    case 'cancel':
      cancelled = true
      paused = false
      if (pauseResolve) {
        pauseResolve()
        pauseResolve = null
      }
      break
  }
})

function waitIfPaused(): Promise<void> {
  if (!paused) return Promise.resolve()
  return new Promise<void>((resolve) => {
    pauseResolve = resolve
  })
}

// ─── Filesystem detection ───────────────────────────────────────

/** Well-known magic bytes for filesystem detection. */
const FS_SIGNATURES: Array<{
  type: FilesystemType
  offset: number
  magic: Buffer
}> = [
  // FAT32: "FAT32   " at offset 82 in the BPB
  { type: 'fat32', offset: 82, magic: Buffer.from('FAT32   ') },
  // exFAT: "EXFAT   " at offset 3
  { type: 'exfat', offset: 3, magic: Buffer.from('EXFAT   ') },
  // NTFS: "NTFS    " at offset 3
  { type: 'ntfs', offset: 3, magic: Buffer.from('NTFS    ') },
  // ext4: magic number 0xEF53 at offset 1080 (superblock at 1024 + 56)
  { type: 'ext4', offset: 1080, magic: Buffer.from([0x53, 0xef]) },
  // HFS+: magic 'H+' at offset 1024
  { type: 'hfs+', offset: 1024, magic: Buffer.from('H+') },
  // APFS: magic 'NXSB' at offset 32
  { type: 'apfs', offset: 32, magic: Buffer.from('NXSB') }
]

/**
 * Detect the filesystem type by reading signature bytes from the device.
 */
async function detectFilesystem(fd: number): Promise<FilesystemType> {
  // We need to read enough bytes to cover all possible signature offsets.
  const maxOffset = Math.max(...FS_SIGNATURES.map((s) => s.offset + s.magic.length))
  const buffer = Buffer.alloc(maxOffset + 64)

  try {
    await fsRead(fd, buffer, 0, buffer.length, 0)
  } catch {
    return 'unknown'
  }

  for (const sig of FS_SIGNATURES) {
    const slice = buffer.subarray(sig.offset, sig.offset + sig.magic.length)
    if (slice.equals(sig.magic)) {
      return sig.type
    }
  }

  return 'unknown'
}

// ─── File extension to type mapping ─────────────────────────────

const EXTENSION_TO_TYPE: Record<string, { type: FileType; category: FileCategory }> = {
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
  dat: { type: 'bdb', category: 'database' }
}

// ─── FAT32 metadata parser ──────────────────────────────────────

/**
 * Parse FAT32 directory entries to find deleted files.
 *
 * In FAT32, a deleted file's directory entry has its first byte set to 0xE5.
 * The rest of the entry (name, extension, size, start cluster) remains intact.
 */
async function parseFat32(
  fd: number,
  categories: Set<FileCategory>,
  fileTypes?: Set<FileType>
): Promise<RecoverableFile[]> {
  const files: RecoverableFile[] = []

  // Read the boot sector to get filesystem geometry.
  const bootSector = Buffer.alloc(512)
  await fsRead(fd, bootSector, 0, 512, 0)

  const bytesPerSector = bootSector.readUInt16LE(11)
  const sectorsPerCluster = bootSector[13]
  const reservedSectors = bootSector.readUInt16LE(14)
  const numberOfFats = bootSector[16]
  const fatSize32 = bootSector.readUInt32LE(36)
  const rootCluster = bootSector.readUInt32LE(44)

  if (bytesPerSector === 0 || sectorsPerCluster === 0) {
    return files
  }

  const bytesPerCluster = bytesPerSector * sectorsPerCluster
  const fatStart = reservedSectors * bytesPerSector
  const dataStart =
    (reservedSectors + numberOfFats * fatSize32) * bytesPerSector

  /**
   * Convert a cluster number to a byte offset.
   */
  function clusterToOffset(cluster: number): bigint {
    return BigInt(dataStart) + BigInt(cluster - 2) * BigInt(bytesPerCluster)
  }

  /**
   * Scan a directory cluster for deleted entries.
   */
  async function scanDirectoryCluster(clusterOffset: bigint): Promise<void> {
    const dirBuffer = Buffer.alloc(bytesPerCluster)
    try {
      await fsRead(fd, dirBuffer, 0, bytesPerCluster, Number(clusterOffset))
    } catch {
      return
    }

    // Each directory entry is 32 bytes.
    for (let i = 0; i < bytesPerCluster; i += 32) {
      if (cancelled) return
      await waitIfPaused()
      if (cancelled) return

      const firstByte = dirBuffer[i]

      // 0x00 = no more entries.
      if (firstByte === 0x00) break

      // 0xE5 = deleted entry.
      if (firstByte !== 0xe5) continue

      // Read the 8.3 filename (skip LFN entries where byte 11 == 0x0F).
      const attributes = dirBuffer[i + 11]
      if (attributes === 0x0f) continue // Long filename entry
      if (attributes & 0x10) continue // Directory
      if (attributes & 0x08) continue // Volume label

      // Extract name and extension.
      const nameBytes = dirBuffer.subarray(i + 1, i + 8)
      const extBytes = dirBuffer.subarray(i + 8, i + 11)
      const name = nameBytes.toString('ascii').trimEnd()
      const ext = extBytes.toString('ascii').trimEnd().toLowerCase()

      const mapping = EXTENSION_TO_TYPE[ext]
      if (!mapping) continue
      if (fileTypes) {
        if (!fileTypes.has(mapping.type)) continue
      } else {
        if (!categories.has(mapping.category)) continue
      }

      // File size.
      const fileSize = dirBuffer.readUInt32LE(i + 28)
      if (fileSize === 0) continue

      // Start cluster (high 16 bits at offset 20, low 16 bits at offset 26).
      const startClusterHigh = dirBuffer.readUInt16LE(i + 20)
      const startClusterLow = dirBuffer.readUInt16LE(i + 26)
      const startCluster = (startClusterHigh << 16) | startClusterLow

      if (startCluster < 2) continue

      const fileOffset = clusterToOffset(startCluster)

      files.push({
        id: uuidv4(),
        type: mapping.type,
        category: mapping.category,
        offset: fileOffset,
        size: BigInt(fileSize),
        sizeEstimated: false,
        name: `_${name}.${ext}`, // Leading underscore replaces the 0xE5 marker
        extension: ext,
        recoverability: 'partial', // Deleted files may be partially overwritten
        source: 'metadata'
      })
    }
  }

  // Read the FAT to follow cluster chains for the root directory.
  const fatBuffer = Buffer.alloc(fatSize32 * bytesPerSector)
  try {
    await fsRead(fd, fatBuffer, 0, fatBuffer.length, fatStart)
  } catch {
    // If we cannot read the FAT, just scan the root directory cluster.
    await scanDirectoryCluster(clusterToOffset(rootCluster))
    return files
  }

  // Walk the root directory cluster chain.
  let cluster = rootCluster
  const visited = new Set<number>()

  while (cluster >= 2 && cluster < 0x0ffffff8 && !visited.has(cluster)) {
    if (cancelled) break
    visited.add(cluster)

    const offset = clusterToOffset(cluster)
    await scanDirectoryCluster(offset)

    // Read next cluster from FAT.
    const fatEntryOffset = cluster * 4
    if (fatEntryOffset + 4 > fatBuffer.length) break
    cluster = fatBuffer.readUInt32LE(fatEntryOffset) & 0x0fffffff
  }

  return files
}

// ─── NTFS metadata parser ───────────────────────────────────────

/**
 * Parse NTFS MFT (Master File Table) for deleted file records.
 *
 * In NTFS, each file has an MFT record. Deleted files have their
 * in-use flag (bit 0 of the flags field) cleared but the record
 * otherwise remains intact until overwritten.
 */
async function parseNtfs(
  fd: number,
  categories: Set<FileCategory>,
  fileTypes?: Set<FileType>
): Promise<RecoverableFile[]> {
  const files: RecoverableFile[] = []

  // Read the boot sector.
  const bootSector = Buffer.alloc(512)
  await fsRead(fd, bootSector, 0, 512, 0)

  const bytesPerSector = bootSector.readUInt16LE(11)
  const sectorsPerCluster = bootSector[13]

  // MFT record size: if byte at offset 64 > 0, it is the log2 of the record size.
  const mftRecordSizeRaw = bootSector.readInt8(64)
  const mftRecordSize =
    mftRecordSizeRaw > 0
      ? mftRecordSizeRaw * bytesPerSector * sectorsPerCluster
      : 1 << -mftRecordSizeRaw

  // MFT start cluster.
  const mftClusterNumber = Number(bootSector.readBigUInt64LE(48))
  const bytesPerCluster = bytesPerSector * sectorsPerCluster
  const mftOffset = BigInt(mftClusterNumber) * BigInt(bytesPerCluster)

  // Scan the first 4096 MFT records (covers most small-to-medium volumes).
  const maxRecords = 4096
  const recordBuffer = Buffer.alloc(mftRecordSize)

  for (let i = 0; i < maxRecords; i++) {
    if (cancelled) break
    await waitIfPaused()
    if (cancelled) break

    const recordOffset = mftOffset + BigInt(i) * BigInt(mftRecordSize)

    try {
      await fsRead(fd, recordBuffer, 0, mftRecordSize, Number(recordOffset))
    } catch {
      continue
    }

    // Check MFT record magic "FILE".
    if (recordBuffer.toString('ascii', 0, 4) !== 'FILE') continue

    // Flags at offset 22: bit 0 = in-use, bit 1 = directory.
    const flags = recordBuffer.readUInt16LE(22)
    const inUse = (flags & 0x01) !== 0
    const isDirectory = (flags & 0x02) !== 0

    // We want deleted files (not in use, not directories).
    if (inUse || isDirectory) continue

    // Parse attributes to find $FILE_NAME and $DATA.
    const firstAttributeOffset = recordBuffer.readUInt16LE(20)
    let attrOffset = firstAttributeOffset
    let fileName: string | undefined
    let fileSize = 0n
    let dataOffset = 0n

    while (attrOffset + 4 < mftRecordSize) {
      const attrType = recordBuffer.readUInt32LE(attrOffset)

      // End marker.
      if (attrType === 0xffffffff || attrType === 0) break

      const attrLength = recordBuffer.readUInt32LE(attrOffset + 4)
      if (attrLength === 0 || attrOffset + attrLength > mftRecordSize) break

      // $FILE_NAME attribute (type 0x30).
      if (attrType === 0x30) {
        const nonResident = recordBuffer[attrOffset + 8]
        if (nonResident === 0) {
          // Resident attribute.
          const contentOffset = recordBuffer.readUInt16LE(attrOffset + 20)
          const nameStart = attrOffset + contentOffset + 66
          const nameLength = recordBuffer[attrOffset + contentOffset + 64]
          if (nameStart + nameLength * 2 <= mftRecordSize) {
            fileName = recordBuffer
              .subarray(nameStart, nameStart + nameLength * 2)
              .toString('utf16le')
          }
        }
      }

      // $DATA attribute (type 0x80).
      if (attrType === 0x80) {
        const nonResident = recordBuffer[attrOffset + 8]
        if (nonResident === 1) {
          // Non-resident: real size is at offset 48 within the attribute.
          fileSize = recordBuffer.readBigUInt64LE(attrOffset + 48)
          // Data run starts - first cluster can be extracted from data runs.
          const dataRunOffset = recordBuffer.readUInt16LE(attrOffset + 32)
          const runStart = attrOffset + dataRunOffset
          if (runStart + 1 < mftRecordSize) {
            const header = recordBuffer[runStart]
            const lengthSize = header & 0x0f
            const offsetSize = (header >> 4) & 0x0f
            if (offsetSize > 0 && runStart + 1 + lengthSize + offsetSize <= mftRecordSize) {
              let clusterOffset = 0n
              for (let b = 0; b < offsetSize; b++) {
                clusterOffset |= BigInt(recordBuffer[runStart + 1 + lengthSize + b]) << BigInt(b * 8)
              }
              // Sign-extend if necessary.
              if (recordBuffer[runStart + 1 + lengthSize + offsetSize - 1] & 0x80) {
                clusterOffset -= 1n << BigInt(offsetSize * 8)
              }
              dataOffset = clusterOffset * BigInt(bytesPerCluster)
            }
          }
        } else {
          // Resident data: size from content size field.
          fileSize = BigInt(recordBuffer.readUInt32LE(attrOffset + 16))
        }
      }

      attrOffset += attrLength
    }

    if (!fileName || fileSize === 0n) continue

    // Determine file type from extension.
    const extMatch = fileName.match(/\.([^.]+)$/)
    if (!extMatch) continue
    const ext = extMatch[1].toLowerCase()
    const mapping = EXTENSION_TO_TYPE[ext]
    if (!mapping) continue
    if (fileTypes) {
      if (!fileTypes.has(mapping.type)) continue
    } else {
      if (!categories.has(mapping.category)) continue
    }

    files.push({
      id: uuidv4(),
      type: mapping.type,
      category: mapping.category,
      offset: dataOffset > 0n ? dataOffset : recordOffset,
      size: fileSize,
      sizeEstimated: dataOffset === 0n,
      name: fileName,
      extension: ext,
      recoverability: dataOffset > 0n ? 'partial' : 'poor',
      source: 'metadata'
    })

    // Emit progress every 256 records.
    if (i > 0 && i % 256 === 0) {
      const progress: ScanProgress = {
        bytesScanned: BigInt(i) * BigInt(mftRecordSize),
        totalBytes: BigInt(maxRecords) * BigInt(mftRecordSize),
        percentage: Math.round((i / maxRecords) * 100),
        filesFound: files.length,
        currentSector: recordOffset / BigInt(SECTOR_SIZE),
        sectorsWithErrors: 0
      }
      port.postMessage({ type: 'progress', sessionId, data: progress })
    }
  }

  return files
}

// ─── Generic metadata scan (fallback) ───────────────────────────

/**
 * For filesystems without a dedicated parser, report that metadata scanning
 * is not available and complete immediately.
 */
async function parseGeneric(
  _fd: number,
  _categories: Set<FileCategory>
): Promise<RecoverableFile[]> {
  // No generic metadata recovery is possible without a filesystem parser.
  return []
}

// ─── Main entry point ───────────────────────────────────────────

/**
 * Discover partition device paths for a given block device.
 * E.g., /dev/nvme0n1 -> [/dev/nvme0n1p1, /dev/nvme0n1p2, ...]
 * E.g., /dev/sda -> [/dev/sda1, /dev/sda2, ...]
 */
async function discoverPartitions(devicePath: string): Promise<string[]> {
  const partitions: string[] = []
  const { readdirSync } = await import('fs')
  const { basename } = await import('path')

  const devName = basename(devicePath)
  try {
    const entries = readdirSync(`/sys/block/${devName}/`, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(devName)) {
        partitions.push(`/dev/${entry.name}`)
      }
    }
  } catch {
    // Not a block device or /sys not available. Try numbered suffixes.
    for (let i = 1; i <= 16; i++) {
      const suffix = devicePath.includes('nvme') || devicePath.includes('mmcblk')
        ? `p${i}`
        : `${i}`
      const partPath = `${devicePath}${suffix}`
      try {
        const fsStat = await import('fs')
        fsStat.accessSync(partPath, fsStat.constants.R_OK)
        partitions.push(partPath)
      } catch {
        break
      }
    }
  }
  return partitions
}

/** Filesystems that have a quick scan parser implemented. */
const SUPPORTED_QUICK_SCAN: Set<FilesystemType> = new Set(['fat32', 'ntfs'])

async function scanDevice(devicePath: string, categories: Set<FileCategory>, fileTypes?: Set<FileType>): Promise<{ files: RecoverableFile[]; fsType: FilesystemType }> {
  let fd: number
  try {
    fd = await fsOpen(devicePath, 'r')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    port.postMessage({
      type: 'error',
      sessionId,
      data: { error: `Cannot open ${devicePath}: ${msg}` }
    })
    return { files: [], fsType: 'unknown' }
  }

  let fsType = config.filesystemType
  if (!fsType) {
    fsType = await detectFilesystem(fd)
  }

  console.log(`[metadata] ${devicePath}: detected filesystem ${fsType}`)

  let files: RecoverableFile[] = []

  if (!SUPPORTED_QUICK_SCAN.has(fsType)) {
    console.log(`[metadata] ${devicePath}: quick scan not supported for ${fsType}, skipping`)
    await fsClose(fd)
    return { files: [], fsType }
  }

  try {
    switch (fsType) {
      case 'fat32':
        files = await parseFat32(fd, categories, fileTypes)
        break

      case 'ntfs':
        files = await parseNtfs(fd, categories, fileTypes)
        break

      default:
        break
    }
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Unknown metadata scan error'
    port.postMessage({
      type: 'error',
      sessionId,
      data: { error: `Metadata scan failed for ${fsType} on ${devicePath}: ${message}` }
    })
  }

  await fsClose(fd)
  return { files, fsType }
}

async function runMetadataScan(): Promise<void> {
  const categories = new Set(config.fileCategories)
  const fileTypes = config.fileTypes && config.fileTypes.length > 0
    ? new Set(config.fileTypes)
    : undefined
  let allFiles: RecoverableFile[] = []
  const detectedFilesystems: FilesystemType[] = []

  if (config.scanPartitions) {
    const partitions = await discoverPartitions(config.devicePath)
    console.log(`[metadata] Scanning ${partitions.length} partitions on ${config.devicePath}:`, partitions)

    for (const partPath of partitions) {
      if (cancelled) break
      const { files, fsType } = await scanDevice(partPath, categories, fileTypes)
      allFiles.push(...files)
      detectedFilesystems.push(fsType)
    }

    if (partitions.length === 0) {
      const { files, fsType } = await scanDevice(config.devicePath, categories, fileTypes)
      allFiles.push(...files)
      detectedFilesystems.push(fsType)
    }
  } else {
    const { files, fsType } = await scanDevice(config.devicePath, categories, fileTypes)
    allFiles.push(...files)
    detectedFilesystems.push(fsType)
  }

  // If no files found and filesystems are unsupported, send informative error
  if (allFiles.length === 0) {
    const unsupported = detectedFilesystems.filter(fs => !SUPPORTED_QUICK_SCAN.has(fs) && fs !== 'unknown')
    if (unsupported.length > 0) {
      port.postMessage({
        type: 'error',
        sessionId,
        data: {
          error: `Quick scan found ${unsupported.join(', ').toUpperCase()} filesystem(s). Quick scan only supports FAT32 and NTFS. Use Deep Scan to recover files from ${unsupported.join('/')} partitions.`
        }
      })
    }
  }

  for (const file of allFiles) {
    if (cancelled) break
    port.postMessage({ type: 'file-found', sessionId, data: file })
  }

  port.postMessage({ type: 'complete', sessionId })
}

runMetadataScan().catch((err) => {
  port.postMessage({
    type: 'error',
    sessionId,
    data: { error: err instanceof Error ? err.message : String(err) }
  })
})
