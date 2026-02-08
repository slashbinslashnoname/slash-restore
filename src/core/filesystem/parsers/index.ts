/**
 * Filesystem Parsers - Unified interface and registry.
 *
 * Each parser scans a specific filesystem's on-disk structures for
 * deleted file entries and returns RecoverableFile records that the
 * scan engine can use for metadata-based recovery.
 */

import type { BlockReader } from '../../io/block-reader'
import type { RecoverableFile, FilesystemType } from '../../../shared/types'

import { Fat32Parser } from './fat32-parser'
import { ExfatParser } from './exfat-parser'
import { NtfsParser } from './ntfs-parser'
import { Ext4Parser } from './ext4-parser'
import { HfsPlusParser } from './hfsplus-parser'

// ─── Parser Interface ───────────────────────────────────────────

/**
 * Common interface for all filesystem parsers.
 *
 * Each implementation reads filesystem-specific metadata structures
 * (directory entries, MFT, inodes, catalog B-tree, etc.) to locate
 * deleted files and reconstruct their metadata.
 */
export interface FilesystemParser {
  /**
   * Scan the filesystem for deleted/recoverable files.
   *
   * @param reader - Block-level reader for the device or partition.
   * @returns Array of recoverable file descriptors found via metadata analysis.
   */
  parse(reader: BlockReader): Promise<RecoverableFile[]>
}

// ─── Parser Adapters ────────────────────────────────────────────

/**
 * Wrap each concrete parser class into the FilesystemParser interface.
 * The concrete parsers take the reader in their constructor and expose
 * a `parse()` method, so the adapters just wire the two together.
 */

class Fat32ParserAdapter implements FilesystemParser {
  async parse(reader: BlockReader): Promise<RecoverableFile[]> {
    const parser = new Fat32Parser(reader)
    return parser.parse()
  }
}

class ExfatParserAdapter implements FilesystemParser {
  async parse(reader: BlockReader): Promise<RecoverableFile[]> {
    const parser = new ExfatParser(reader)
    return parser.parse()
  }
}

class NtfsParserAdapter implements FilesystemParser {
  async parse(reader: BlockReader): Promise<RecoverableFile[]> {
    const parser = new NtfsParser(reader)
    return parser.parse()
  }
}

class Ext4ParserAdapter implements FilesystemParser {
  async parse(reader: BlockReader): Promise<RecoverableFile[]> {
    const parser = new Ext4Parser(reader)
    return parser.parse()
  }
}

class HfsPlusParserAdapter implements FilesystemParser {
  async parse(reader: BlockReader): Promise<RecoverableFile[]> {
    const parser = new HfsPlusParser(reader)
    return parser.parse()
  }
}

// ─── Parser Registry ────────────────────────────────────────────

const PARSER_REGISTRY: ReadonlyMap<FilesystemType, FilesystemParser> = new Map([
  ['fat32', new Fat32ParserAdapter()],
  ['exfat', new ExfatParserAdapter()],
  ['ntfs', new NtfsParserAdapter()],
  ['ext4', new Ext4ParserAdapter()],
  ['hfs+', new HfsPlusParserAdapter()],
])

/**
 * Get a filesystem parser for the given filesystem type.
 *
 * @param fsType - The detected filesystem type.
 * @returns A parser instance, or null if the filesystem type is not supported.
 */
export function getParser(fsType: FilesystemType): FilesystemParser | null {
  return PARSER_REGISTRY.get(fsType) ?? null
}

// ─── Re-exports ─────────────────────────────────────────────────

export { Fat32Parser } from './fat32-parser'
export { ExfatParser } from './exfat-parser'
export { NtfsParser } from './ntfs-parser'
export { Ext4Parser } from './ext4-parser'
export { HfsPlusParser } from './hfsplus-parser'
