/**
 * Base interface and types for file extractors.
 *
 * Each extractor is responsible for determining the size of a file found at a
 * given offset by parsing its internal structure. Extractors must be resilient
 * to corrupted or truncated data - when exact parsing fails, they should return
 * a best-effort size estimate.
 */

import type { FileMetadata } from '../../../shared/types'

/**
 * Simplified reader interface used by file extractors.
 *
 * The carving engine adapts the real {@link BlockReader} (which has a richer
 * API with sector alignment, retry logic, etc.) to this minimal interface so
 * that extractors remain simple and easily testable.
 */
export interface ReadableDevice {
  /** Read `length` bytes starting at absolute byte `offset`. */
  read(offset: bigint, length: number): Promise<Buffer>
  /** Total device size in bytes. */
  readonly size: bigint
}

/** Result returned by a file extractor. */
export interface ExtractionResult {
  /** Total file size in bytes. */
  size: bigint
  /** Whether the size is an estimate (true) or exact (false). */
  estimated: boolean
  /** Optional metadata extracted from the file structure. */
  metadata?: FileMetadata
}

/** Interface that all file extractors must implement. */
export interface FileExtractor {
  /** Human-readable name of this extractor (for logging). */
  readonly name: string

  /** The file types this extractor handles. */
  readonly supportedTypes: readonly string[]

  /**
   * Attempt to determine the size and metadata of a file starting at `offset`.
   *
   * @param reader - Readable device for accessing raw bytes.
   * @param offset - Absolute byte offset where the file begins.
   * @returns Extraction result with size and optional metadata.
   * @throws Never - implementations must catch all errors and return estimates.
   */
  extract(reader: ReadableDevice, offset: bigint): Promise<ExtractionResult>
}
