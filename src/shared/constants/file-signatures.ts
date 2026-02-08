import type { FileType, FileCategory } from '../types'

export interface FileSignature {
  type: FileType
  category: FileCategory
  extension: string
  displayName: string
  /** Magic bytes at the start of the file */
  header: Buffer
  /** Optional offset from start of match to look for header */
  headerOffset: number
  /** Optional footer magic bytes */
  footer?: Buffer
  /** Maximum expected file size (for heuristic boundary detection) */
  maxSize: bigint
  /** Minimum expected file size */
  minSize: bigint
}

// Helper to create a Buffer from hex string
function hex(s: string): Buffer {
  return Buffer.from(s.replace(/\s+/g, ''), 'hex')
}

export const FILE_SIGNATURES: FileSignature[] = [
  // ─── Photos ───────────────────────────────────────────
  {
    type: 'jpeg',
    category: 'photo',
    extension: 'jpg',
    displayName: 'JPEG Image',
    header: hex('FF D8 FF'),
    headerOffset: 0,
    footer: hex('FF D9'),
    maxSize: 50n * 1024n * 1024n, // 50 MB
    minSize: 100n
  },
  {
    type: 'png',
    category: 'photo',
    extension: 'png',
    displayName: 'PNG Image',
    header: hex('89 50 4E 47 0D 0A 1A 0A'),
    headerOffset: 0,
    footer: hex('49 45 4E 44 AE 42 60 82'), // IEND + CRC
    maxSize: 100n * 1024n * 1024n,
    minSize: 67n
  },
  {
    type: 'heic',
    category: 'photo',
    extension: 'heic',
    displayName: 'HEIC Image',
    // ftyp box with heic/heix brand: offset 4 = "ftyp"
    header: hex('00 00 00'),
    headerOffset: 0,
    maxSize: 200n * 1024n * 1024n,
    minSize: 100n
  },
  {
    type: 'cr2',
    category: 'photo',
    extension: 'cr2',
    displayName: 'Canon RAW',
    // TIFF header (little-endian) II + magic 42 + CR2 magic at offset 8
    header: hex('49 49 2A 00'),
    headerOffset: 0,
    maxSize: 100n * 1024n * 1024n,
    minSize: 1024n
  },
  {
    type: 'nef',
    category: 'photo',
    extension: 'nef',
    displayName: 'Nikon RAW',
    // TIFF header (little-endian) with Nikon magic
    header: hex('4D 4D 00 2A'),
    headerOffset: 0,
    maxSize: 150n * 1024n * 1024n,
    minSize: 1024n
  },
  {
    type: 'arw',
    category: 'photo',
    extension: 'arw',
    displayName: 'Sony RAW',
    // TIFF header (little-endian)
    header: hex('49 49 2A 00'),
    headerOffset: 0,
    maxSize: 150n * 1024n * 1024n,
    minSize: 1024n
  },

  // ─── Videos ───────────────────────────────────────────
  {
    type: 'mp4',
    category: 'video',
    extension: 'mp4',
    displayName: 'MP4 Video',
    // ftyp box: offset 4 = "ftyp"
    header: hex('66 74 79 70'),
    headerOffset: 4,
    maxSize: 10n * 1024n * 1024n * 1024n, // 10 GB
    minSize: 100n
  },
  {
    type: 'mov',
    category: 'video',
    extension: 'mov',
    displayName: 'QuickTime Video',
    // ftyp box with qt brand or moov/mdat atoms
    header: hex('66 74 79 70 71 74'),
    headerOffset: 4,
    maxSize: 10n * 1024n * 1024n * 1024n,
    minSize: 100n
  },
  {
    type: 'avi',
    category: 'video',
    extension: 'avi',
    displayName: 'AVI Video',
    // RIFF....AVI
    header: hex('52 49 46 46'),
    headerOffset: 0,
    maxSize: 10n * 1024n * 1024n * 1024n,
    minSize: 100n
  },

  // ─── Documents ────────────────────────────────────────
  {
    type: 'pdf',
    category: 'document',
    extension: 'pdf',
    displayName: 'PDF Document',
    header: hex('25 50 44 46'), // %PDF
    headerOffset: 0,
    footer: hex('25 25 45 4F 46'), // %%EOF
    maxSize: 500n * 1024n * 1024n,
    minSize: 50n
  },
  {
    type: 'docx',
    category: 'document',
    extension: 'docx',
    displayName: 'Word Document',
    // PK zip header (also used by xlsx)
    header: hex('50 4B 03 04'),
    headerOffset: 0,
    maxSize: 200n * 1024n * 1024n,
    minSize: 100n
  },
  {
    type: 'xlsx',
    category: 'document',
    extension: 'xlsx',
    displayName: 'Excel Spreadsheet',
    // PK zip header (same as docx, differentiated by content)
    header: hex('50 4B 03 04'),
    headerOffset: 0,
    maxSize: 200n * 1024n * 1024n,
    minSize: 100n
  }
]

/** Map file type to its signatures for quick lookup */
export const SIGNATURE_MAP = new Map<FileType, FileSignature>(
  FILE_SIGNATURES.map(sig => [sig.type, sig])
)

/** Get signatures filtered by category */
export function getSignaturesByCategory(category: FileCategory): FileSignature[] {
  return FILE_SIGNATURES.filter(s => s.category === category)
}

/** Sector size constant */
export const SECTOR_SIZE = 512

/** Default chunk size for reading (1 MB) */
export const CHUNK_SIZE = 1024 * 1024

/** Overlap between chunks to catch headers at boundaries */
export const CHUNK_OVERLAP = 64

/** Maximum retries for bad sector reads */
export const MAX_READ_RETRIES = 3

/** Backoff delay base in ms */
export const RETRY_BACKOFF_MS = 100
