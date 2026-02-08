/**
 * Filesystem type detector.
 *
 * Reads the boot sector / superblock from a block device and identifies
 * the filesystem by checking well-known magic byte sequences.
 */

import type { BlockReader } from '../io/block-reader'
import type { FilesystemType } from '../../shared/types'

/** Minimum read size needed to cover all magic locations (superblock at 1024 + up to 256 bytes). */
const DETECTION_READ_SIZE = 1024 + 256

/**
 * Detect the filesystem type present on a block device or partition.
 *
 * The detection order matters: more specific signatures are tested first
 * to avoid false positives (e.g. exFAT before FAT32 since both share
 * similar boot sector layouts).
 */
export async function detectFilesystem(reader: BlockReader): Promise<FilesystemType> {
  let bootSector: Buffer
  try {
    bootSector = await reader.read(0n, DETECTION_READ_SIZE)
  } catch {
    return 'unknown'
  }

  if (bootSector.length < 512) {
    return 'unknown'
  }

  // ── exFAT ──────────────────────────────────────────────────
  // OEM name at bytes 3-10 must be "EXFAT   " (padded with spaces).
  if (matchesAscii(bootSector, 3, 'EXFAT   ')) {
    return 'exfat'
  }

  // ── NTFS ───────────────────────────────────────────────────
  // OEM ID at bytes 3-6 is "NTFS".
  if (matchesAscii(bootSector, 3, 'NTFS')) {
    return 'ntfs'
  }

  // ── FAT32 ──────────────────────────────────────────────────
  // BS_FilSysType at offset 82 (for FAT32) should read "FAT32   ".
  // As a fallback, also check the OEM field and FAT32-specific BPB fields.
  if (matchesAscii(bootSector, 82, 'FAT32   ')) {
    return 'fat32'
  }
  // Fallback: BPB_FATSz16 (offset 22) == 0 indicates FAT32 when combined
  // with a valid BPB_BytsPerSec and BPB_SecPerClus.
  if (isFat32Fallback(bootSector)) {
    return 'fat32'
  }

  // ── ext4 ───────────────────────────────────────────────────
  // Superblock starts at byte offset 1024. Magic number at relative
  // offset 0x38 (absolute 1024 + 56 = 1080) is 0x53EF (little-endian).
  if (bootSector.length >= 1024 + 58) {
    const magic = bootSector.readUInt16LE(1024 + 0x38)
    if (magic === 0x53ef) {
      return 'ext4'
    }
  }

  // ── HFS+ / HFSX ───────────────────────────────────────────
  // Volume header at offset 1024. Signature is the first two bytes:
  //   0x482B ('H+') for HFS+
  //   0x4858 ('HX') for HFSX
  if (bootSector.length >= 1024 + 2) {
    const sig = bootSector.readUInt16BE(1024)
    if (sig === 0x482b || sig === 0x4858) {
      return 'hfs+'
    }
  }

  return 'unknown'
}

// ─── Helpers ──────────────────────────────────────────────────

/** Check whether the buffer contains the given ASCII string at `offset`. */
function matchesAscii(buf: Buffer, offset: number, expected: string): boolean {
  if (offset + expected.length > buf.length) {
    return false
  }
  for (let i = 0; i < expected.length; i++) {
    if (buf[offset + i] !== expected.charCodeAt(i)) {
      return false
    }
  }
  return true
}

/**
 * Heuristic fallback for FAT32 detection when the BS_FilSysType field
 * is not populated. We check:
 *   - BPB_BytsPerSec (offset 11, 2 bytes) is a power of 2 between 512..4096
 *   - BPB_SecPerClus (offset 13, 1 byte) is a power of 2
 *   - BPB_FATSz16 (offset 22, 2 bytes) is 0 (indicating FAT32 extended BPB)
 *   - BPB_FATSz32 (offset 36, 4 bytes) is nonzero
 *   - Boot signature 0x55AA at offset 510
 */
function isFat32Fallback(buf: Buffer): boolean {
  if (buf.length < 512) return false

  const bytesPerSec = buf.readUInt16LE(11)
  if (bytesPerSec < 512 || bytesPerSec > 4096 || (bytesPerSec & (bytesPerSec - 1)) !== 0) {
    return false
  }

  const secPerClus = buf[13]
  if (secPerClus === 0 || (secPerClus & (secPerClus - 1)) !== 0) {
    return false
  }

  const fatSz16 = buf.readUInt16LE(22)
  if (fatSz16 !== 0) return false

  const fatSz32 = buf.readUInt32LE(36)
  if (fatSz32 === 0) return false

  const bootSig = buf.readUInt16LE(510)
  return bootSig === 0xaa55
}
