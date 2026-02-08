/**
 * File Extractors - barrel export.
 *
 * Each extractor knows how to parse a specific file format and determine
 * the file's boundaries (size) given a starting offset on a raw device.
 */

export type { ReadableDevice, ExtractionResult, FileExtractor } from './base-extractor'

export { JpegExtractor } from './jpeg-extractor'
export { PngExtractor } from './png-extractor'
export { PdfExtractor } from './pdf-extractor'
export { Mp4Extractor } from './mp4-extractor'
export { AviExtractor } from './avi-extractor'
export { HeicExtractor } from './heic-extractor'
export { RawExtractor } from './raw-extractor'
export { ZipExtractor } from './zip-extractor'

import type { FileExtractor } from './base-extractor'
import type { FileType } from '../../../shared/types'

import { JpegExtractor } from './jpeg-extractor'
import { PngExtractor } from './png-extractor'
import { PdfExtractor } from './pdf-extractor'
import { Mp4Extractor } from './mp4-extractor'
import { AviExtractor } from './avi-extractor'
import { HeicExtractor } from './heic-extractor'
import { RawExtractor } from './raw-extractor'
import { ZipExtractor } from './zip-extractor'

/**
 * Create the default set of file extractors, one per supported file format.
 *
 * @returns A map from FileType to the extractor instance that handles it.
 */
export function createExtractorMap(): Map<FileType, FileExtractor> {
  const extractors: FileExtractor[] = [
    new JpegExtractor(),
    new PngExtractor(),
    new PdfExtractor(),
    new Mp4Extractor(),
    new AviExtractor(),
    new HeicExtractor(),
    new RawExtractor(),
    new ZipExtractor()
  ]

  const map = new Map<FileType, FileExtractor>()

  for (const extractor of extractors) {
    for (const type of extractor.supportedTypes) {
      map.set(type as FileType, extractor)
    }
  }

  return map
}
