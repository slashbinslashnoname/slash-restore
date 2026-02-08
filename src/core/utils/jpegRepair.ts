// @ts-ignore Module import issue with sharp/esModuleInterop
import sharp from "sharp";
import type { ReadableDevice } from "../carving/file-extractors/base-extractor";

/**
 * Repairs a potentially corrupted JPEG buffer by re-decoding and re-encoding with Sharp.
 * Sharp handles corruption gracefully, ignoring bad data.
 */
export async function repairJpeg(buffer: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(buffer, { failOn: "none" })
      .jpeg({ quality: 95, progressive: true })
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * Repairs JPEG from device using reader.
 */
export async function repairJpegFromDevice(
  reader: ReadableDevice,
  offset: bigint,
  size: bigint,
): Promise<Buffer | null> {
  if (Number(size) > 104857600) {
    // Limit to 100MB
    return null;
  }
  try {
    const buffer = await reader.read(offset, Number(size));
    return await repairJpeg(buffer);
  } catch {
    return null;
  }
}

/**
 * Validates JPEG by metadata extraction.
 */
export async function isValidJpeg(buffer: Buffer): Promise<boolean> {
  try {
    await sharp(buffer, { failOn: "none" }).metadata();
    return true;
  } catch {
    return false;
  }
}
