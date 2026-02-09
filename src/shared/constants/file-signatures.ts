import type { FileType, FileCategory } from "../types";

export interface FileSignature {
  type: FileType;
  category: FileCategory;
  extension: string;
  displayName: string;
  /** Magic bytes at the start of the file */
  header: Buffer;
  /** Optional offset from start of match to look for header */
  headerOffset: number;
  /** Optional footer magic bytes */
  footer?: Buffer;
  /** Maximum expected file size (for heuristic boundary detection) */
  maxSize: bigint;
  /** Minimum expected file size */
  minSize: bigint;
}

// Helper to create a Buffer from hex string
function hex(s: string): Buffer {
  return Buffer.from(s.replace(/\s+/g, ""), "hex");
}

export const FILE_SIGNATURES: FileSignature[] = [
  // ─── Photos ───────────────────────────────────────────
  {
    type: "jpeg",
    category: "photo",
    extension: "jpg",
    displayName: "JPEG Image",
    // JFIF marker (most common JPEG)
    header: hex("FF D8 FF E0"),
    headerOffset: 0,
    footer: hex("FF D9"),
    maxSize: 500n * 1024n * 1024n, // 500 MB
    minSize: 100n,
  },
  {
    type: "jpeg",
    category: "photo",
    extension: "jpg",
    displayName: "JPEG Image",
    // Exif marker (cameras, phones)
    header: hex("FF D8 FF E1"),
    headerOffset: 0,
    footer: hex("FF D9"),
    maxSize: 500n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "jpeg",
    category: "photo",
    extension: "jpg",
    displayName: "JPEG Image",
    // Quantization table marker (raw JPEG without JFIF/Exif)
    header: hex("FF D8 FF DB"),
    headerOffset: 0,
    footer: hex("FF D9"),
    maxSize: 500n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "jpeg",
    category: "photo",
    extension: "jpg",
    displayName: "JPEG Image",
    // Adobe JPEG marker
    header: hex("FF D8 FF EE"),
    headerOffset: 0,
    footer: hex("FF D9"),
    maxSize: 50n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "png",
    category: "photo",
    extension: "png",
    displayName: "PNG Image",
    header: hex("89 50 4E 47 0D 0A 1A 0A"),
    headerOffset: 0,
    footer: hex("49 45 4E 44 AE 42 60 82"), // IEND + CRC
    maxSize: 100n * 1024n * 1024n,
    minSize: 67n,
  },
  {
    type: "heic",
    category: "photo",
    extension: "heic",
    displayName: "HEIC Image",
    // ftyp box with "heic" brand
    header: hex("66 74 79 70 68 65 69 63"),
    headerOffset: 4,
    maxSize: 200n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "heic",
    category: "photo",
    extension: "heic",
    displayName: "HEIC Image",
    // ftyp box with "mif1" brand (HEIF container)
    header: hex("66 74 79 70 6D 69 66 31"),
    headerOffset: 4,
    maxSize: 200n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "heic",
    category: "photo",
    extension: "heic",
    displayName: "HEIC Image",
    // ftyp box with "heix" brand
    header: hex("66 74 79 70 68 65 69 78"),
    headerOffset: 4,
    maxSize: 200n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "cr2",
    category: "photo",
    extension: "cr2",
    displayName: "Canon RAW",
    // TIFF header (little-endian) II + magic 42 + CR2 magic at offset 8
    header: hex("49 49 2A 00"),
    headerOffset: 0,
    maxSize: 100n * 1024n * 1024n,
    minSize: 1024n,
  },
  {
    type: "nef",
    category: "photo",
    extension: "nef",
    displayName: "Nikon RAW",
    // TIFF header (little-endian) with Nikon magic
    header: hex("4D 4D 00 2A"),
    headerOffset: 0,
    maxSize: 150n * 1024n * 1024n,
    minSize: 1024n,
  },
  {
    type: "arw",
    category: "photo",
    extension: "arw",
    displayName: "Sony RAW",
    // TIFF header (little-endian)
    header: hex("49 49 2A 00"),
    headerOffset: 0,
    maxSize: 150n * 1024n * 1024n,
    minSize: 1024n,
  },
  {
    type: "gif",
    category: "photo",
    extension: "gif",
    displayName: "GIF Image",
    // GIF89a
    header: hex("47 49 46 38 39 61"),
    headerOffset: 0,
    footer: hex("00 3B"),
    maxSize: 50n * 1024n * 1024n,
    minSize: 6n,
  },
  {
    type: "gif",
    category: "photo",
    extension: "gif",
    displayName: "GIF Image",
    // GIF87a
    header: hex("47 49 46 38 37 61"),
    headerOffset: 0,
    footer: hex("00 3B"),
    maxSize: 50n * 1024n * 1024n,
    minSize: 6n,
  },
  {
    type: "webp",
    category: "photo",
    extension: "webp",
    displayName: "WebP Image",
    // RIFF container with "WEBP" at offset 8
    header: hex("57 45 42 50"),
    headerOffset: 8,
    maxSize: 100n * 1024n * 1024n,
    minSize: 12n,
  },
  {
    type: "psd",
    category: "photo",
    extension: "psd",
    displayName: "Photoshop Document",
    // "8BPS"
    header: hex("38 42 50 53"),
    headerOffset: 0,
    maxSize: 2n * 1024n * 1024n * 1024n, // 2 GB
    minSize: 100n,
  },

  // ─── Videos ───────────────────────────────────────────
  {
    type: "mp4",
    category: "video",
    extension: "mp4",
    displayName: "MP4 Video",
    // ftyp box with "isom" brand (most common MP4)
    header: hex("66 74 79 70 69 73 6F 6D"),
    headerOffset: 4,
    maxSize: 10n * 1024n * 1024n * 1024n, // 10 GB
    minSize: 100n,
  },
  {
    type: "mp4",
    category: "video",
    extension: "mp4",
    displayName: "MP4 Video",
    // ftyp box with "iso2" brand
    header: hex("66 74 79 70 69 73 6F 32"),
    headerOffset: 4,
    maxSize: 10n * 1024n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "mp4",
    category: "video",
    extension: "mp4",
    displayName: "MP4 Video",
    // ftyp box with "mp41" brand
    header: hex("66 74 79 70 6D 70 34 31"),
    headerOffset: 4,
    maxSize: 10n * 1024n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "mp4",
    category: "video",
    extension: "mp4",
    displayName: "MP4 Video",
    // ftyp box with "mp42" brand
    header: hex("66 74 79 70 6D 70 34 32"),
    headerOffset: 4,
    maxSize: 10n * 1024n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "mp4",
    category: "video",
    extension: "mp4",
    displayName: "MP4 Video",
    // ftyp box with "avc1" brand (H.264)
    header: hex("66 74 79 70 61 76 63 31"),
    headerOffset: 4,
    maxSize: 10n * 1024n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "mp4",
    category: "video",
    extension: "mp4",
    displayName: "MP4 Video",
    // ftyp box with "MSNV" brand (Sony)
    header: hex("66 74 79 70 4D 53 4E 56"),
    headerOffset: 4,
    maxSize: 10n * 1024n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "mp4",
    category: "video",
    extension: "mp4",
    displayName: "MP4 Video",
    // ftyp box with "3gp5" brand (mobile video)
    header: hex("66 74 79 70 33 67 70 35"),
    headerOffset: 4,
    maxSize: 10n * 1024n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "mov",
    category: "video",
    extension: "mov",
    displayName: "QuickTime Video",
    // ftyp box with qt brand or moov/mdat atoms
    header: hex("66 74 79 70 71 74"),
    headerOffset: 4,
    maxSize: 10n * 1024n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "avi",
    category: "video",
    extension: "avi",
    displayName: "AVI Video",
    // RIFF....AVI
    header: hex("52 49 46 46"),
    headerOffset: 0,
    maxSize: 10n * 1024n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "mkv",
    category: "video",
    extension: "mkv",
    displayName: "Matroska Video",
    // EBML header (Matroska/WebM container)
    header: hex("1A 45 DF A3"),
    headerOffset: 0,
    maxSize: 10n * 1024n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "flv",
    category: "video",
    extension: "flv",
    displayName: "Flash Video",
    // "FLV\x01"
    header: hex("46 4C 56 01"),
    headerOffset: 0,
    maxSize: 4n * 1024n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "wmv",
    category: "video",
    extension: "wmv",
    displayName: "Windows Media Video",
    // ASF header GUID
    header: hex("30 26 B2 75 8E 66 CF 11"),
    headerOffset: 0,
    maxSize: 10n * 1024n * 1024n * 1024n,
    minSize: 100n,
  },

  // ─── Documents ────────────────────────────────────────
  {
    type: "pdf",
    category: "document",
    extension: "pdf",
    displayName: "PDF Document",
    header: hex("25 50 44 46"), // %PDF
    headerOffset: 0,
    footer: hex("25 25 45 4F 46"), // %%EOF
    maxSize: 500n * 1024n * 1024n,
    minSize: 50n,
  },
  {
    type: "docx",
    category: "document",
    extension: "docx",
    displayName: "Word Document",
    // PK zip header (also used by xlsx)
    header: hex("50 4B 03 04"),
    headerOffset: 0,
    maxSize: 200n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "xlsx",
    category: "document",
    extension: "xlsx",
    displayName: "Excel Spreadsheet",
    // PK zip header (same as docx, differentiated by content)
    header: hex("50 4B 03 04"),
    headerOffset: 0,
    maxSize: 200n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "rtf",
    category: "document",
    extension: "rtf",
    displayName: "Rich Text Format",
    // "{\rtf"
    header: hex("7B 5C 72 74 66"),
    headerOffset: 0,
    maxSize: 200n * 1024n * 1024n,
    minSize: 10n,
  },
  {
    type: "pptx",
    category: "document",
    extension: "pptx",
    displayName: "PowerPoint Presentation",
    // PK zip header (same as docx/xlsx, differentiated by content)
    header: hex("50 4B 03 04"),
    headerOffset: 0,
    maxSize: 500n * 1024n * 1024n,
    minSize: 100n,
  },

  // ─── Audio ─────────────────────────────────────────────
  {
    type: "mp3",
    category: "audio",
    extension: "mp3",
    displayName: "MP3 Audio",
    // ID3v2 tag header
    header: hex("49 44 33"),
    headerOffset: 0,
    maxSize: 500n * 1024n * 1024n,
    minSize: 128n,
  },
  {
    type: "wav",
    category: "audio",
    extension: "wav",
    displayName: "WAV Audio",
    // RIFF container with "WAVE" at offset 8
    header: hex("57 41 56 45"),
    headerOffset: 8,
    maxSize: 2n * 1024n * 1024n * 1024n,
    minSize: 44n,
  },
  {
    type: "flac",
    category: "audio",
    extension: "flac",
    displayName: "FLAC Audio",
    // "fLaC"
    header: hex("66 4C 61 43"),
    headerOffset: 0,
    maxSize: 2n * 1024n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "ogg",
    category: "audio",
    extension: "ogg",
    displayName: "OGG Audio",
    // "OggS"
    header: hex("4F 67 67 53"),
    headerOffset: 0,
    maxSize: 500n * 1024n * 1024n,
    minSize: 100n,
  },
  {
    type: "m4a",
    category: "audio",
    extension: "m4a",
    displayName: "M4A Audio",
    // ftyp box with "M4A " brand
    header: hex("66 74 79 70 4D 34 41 20"),
    headerOffset: 4,
    maxSize: 1n * 1024n * 1024n * 1024n,
    minSize: 100n,
  },

  // ─── Archives ──────────────────────────────────────────
  {
    type: "zip",
    category: "archive",
    extension: "zip",
    displayName: "ZIP Archive",
    // PK local file header
    header: hex("50 4B 03 04"),
    headerOffset: 0,
    maxSize: 4n * 1024n * 1024n * 1024n,
    minSize: 22n,
  },
  {
    type: "rar",
    category: "archive",
    extension: "rar",
    displayName: "RAR Archive",
    // "Rar!\x1a\x07\x00" (RAR 4.x)
    header: hex("52 61 72 21 1A 07 00"),
    headerOffset: 0,
    maxSize: 4n * 1024n * 1024n * 1024n,
    minSize: 20n,
  },
  {
    type: "rar",
    category: "archive",
    extension: "rar",
    displayName: "RAR Archive",
    // "Rar!\x1a\x07\x01\x00" (RAR 5.x)
    header: hex("52 61 72 21 1A 07 01 00"),
    headerOffset: 0,
    maxSize: 4n * 1024n * 1024n * 1024n,
    minSize: 20n,
  },
  {
    type: "7z",
    category: "archive",
    extension: "7z",
    displayName: "7-Zip Archive",
    // 7z signature
    header: hex("37 7A BC AF 27 1C"),
    headerOffset: 0,
    maxSize: 4n * 1024n * 1024n * 1024n,
    minSize: 32n,
  },
  {
    type: "gz",
    category: "archive",
    extension: "gz",
    displayName: "Gzip Archive",
    // gzip magic + deflate method
    header: hex("1F 8B 08"),
    headerOffset: 0,
    maxSize: 4n * 1024n * 1024n * 1024n,
    minSize: 20n,
  },
  {
    type: "bz2",
    category: "archive",
    extension: "bz2",
    displayName: "Bzip2 Archive",
    // "BZh"
    header: hex("42 5A 68"),
    headerOffset: 0,
    maxSize: 4n * 1024n * 1024n * 1024n,
    minSize: 14n,
  },
  {
    type: "xz",
    category: "archive",
    extension: "xz",
    displayName: "XZ Archive",
    // XZ magic
    header: hex("FD 37 7A 58 5A 00"),
    headerOffset: 0,
    maxSize: 4n * 1024n * 1024n * 1024n,
    minSize: 32n,
  },
  {
    type: "tar",
    category: "archive",
    extension: "tar",
    displayName: "TAR Archive",
    // "ustar" magic at offset 257
    header: hex("75 73 74 61 72"),
    headerOffset: 257,
    maxSize: 4n * 1024n * 1024n * 1024n,
    minSize: 512n,
  },

  // ─── Database / Crypto ─────────────────────────────────
  {
    type: "sqlite",
    category: "database",
    extension: "sqlite",
    displayName: "SQLite Database",
    // "SQLite format 3\0"
    header: hex("53 51 4C 69 74 65 20 66 6F 72 6D 61 74 20 33 00"),
    headerOffset: 0,
    maxSize: 10n * 1024n * 1024n * 1024n,
    minSize: 512n,
  },
  {
    type: "bdb",
    category: "database",
    extension: "dat",
    displayName: "Berkeley DB (wallet.dat)",
    // BDB btree magic at offset 12 (little-endian, x86)
    header: hex("62 31 05 00"),
    headerOffset: 12,
    maxSize: 1n * 1024n * 1024n * 1024n,
    minSize: 512n,
  },
  {
    type: "bdb",
    category: "database",
    extension: "dat",
    displayName: "Berkeley DB (wallet.dat)",
    // BDB btree magic at offset 12 (big-endian)
    header: hex("00 05 31 62"),
    headerOffset: 12,
    maxSize: 1n * 1024n * 1024n * 1024n,
    minSize: 512n,
  },
];

/** Map file type to its signatures for quick lookup */
export const SIGNATURE_MAP = new Map<FileType, FileSignature>(
  FILE_SIGNATURES.map((sig) => [sig.type, sig]),
);

/** Get signatures filtered by category */
export function getSignaturesByCategory(
  category: FileCategory,
): FileSignature[] {
  return FILE_SIGNATURES.filter((s) => s.category === category);
}

/** Get signatures filtered by specific file types */
export function getSignaturesByTypes(types: FileType[]): FileSignature[] {
  const typeSet = new Set(types);
  return FILE_SIGNATURES.filter((s) => typeSet.has(s.type));
}

/** Sector size constant */
export const SECTOR_SIZE = 512;

/** Default chunk size for reading (1 MB) */
export const CHUNK_SIZE = 1024 * 1024;

/** Overlap between chunks to catch headers at boundaries */
export const CHUNK_OVERLAP = 64;

/** Maximum retries for bad sector reads */
export const MAX_READ_RETRIES = 3;

/** Backoff delay base in ms */
export const RETRY_BACKOFF_MS = 100;
