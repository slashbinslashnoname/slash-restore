import type { IpcMain } from 'electron'
import { IpcChannels } from '../../shared/types'
import * as fs from 'node:fs'

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Read `length` bytes from a file descriptor starting at `offset`.
 * Returns a Buffer of the data read.
 */
async function readBytesFromDevice(
  devicePath: string,
  offset: bigint,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    fs.open(devicePath, 'r', (err, fd) => {
      if (err) {
        reject(new Error(`Failed to open device: ${err.message}`))
        return
      }

      const buffer = Buffer.alloc(length)
      // fs.read supports position as a number. For offsets beyond
      // Number.MAX_SAFE_INTEGER we would need a native addon; for now
      // we convert and guard.
      const posNumber = Number(offset)
      if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
        fs.close(fd, () => {})
        reject(new Error('Offset exceeds safe integer range. Native addon required.'))
        return
      }

      fs.read(fd, buffer, 0, length, posNumber, (readErr, bytesRead) => {
        fs.close(fd, () => {})
        if (readErr) {
          reject(new Error(`Failed to read data: ${readErr.message}`))
          return
        }
        resolve(buffer.subarray(0, bytesRead))
      })
    })
  })
}

/**
 * Format a Buffer as a hex dump string.
 * Each line: OFFSET  HEX BYTES  |ASCII|
 */
function formatHexDump(buffer: Buffer, startOffset: bigint): string {
  const lines: string[] = []
  const bytesPerLine = 16

  for (let i = 0; i < buffer.length; i += bytesPerLine) {
    const lineOffset = startOffset + BigInt(i)
    const offsetStr = lineOffset.toString(16).padStart(8, '0')

    const slice = buffer.subarray(i, Math.min(i + bytesPerLine, buffer.length))

    // Hex part
    const hexParts: string[] = []
    for (let j = 0; j < bytesPerLine; j++) {
      if (j < slice.length) {
        hexParts.push(slice[j].toString(16).padStart(2, '0'))
      } else {
        hexParts.push('  ')
      }
    }
    const hexStr = hexParts.join(' ')

    // ASCII part
    const asciiParts: string[] = []
    for (let j = 0; j < slice.length; j++) {
      const byte = slice[j]
      asciiParts.push(byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.')
    }
    const asciiStr = asciiParts.join('')

    lines.push(`${offsetStr}  ${hexStr}  |${asciiStr}|`)
  }

  return lines.join('\n')
}

// ─── Handler Registration ────────────────────────────────────

export function registerPreviewHandlers(ipcMain: IpcMain): void {
  /**
   * preview:generate
   * Reads raw bytes from the device at the given offset / size and returns
   * them as a base64-encoded string that the renderer can display as an
   * image (e.g. via a data URI with the appropriate MIME type).
   */
  ipcMain.handle(
    IpcChannels.PREVIEW_GENERATE,
    async (
      _event,
      args: { devicePath: string; fileId: string; offset: string; size: string },
    ) => {
      try {
        const offset = BigInt(args.offset)
        const size = Number(BigInt(args.size))

        // Limit preview reads to 10 MB to avoid memory pressure
        const maxPreviewSize = 10 * 1024 * 1024
        const readSize = Math.min(size, maxPreviewSize)

        const data = await readBytesFromDevice(args.devicePath, offset, readSize)
        const base64 = data.toString('base64')

        return { success: true, fileId: args.fileId, base64 }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }
    },
  )

  /**
   * preview:hex
   * Reads raw bytes and returns a formatted hex dump string.
   */
  ipcMain.handle(
    IpcChannels.PREVIEW_HEX,
    async (_event, args: { devicePath: string; offset: string; length: number }) => {
      try {
        const offset = BigInt(args.offset)
        const length = args.length

        // Limit hex dump to 64 KB
        const maxHexLength = 64 * 1024
        const readLength = Math.min(length, maxHexLength)

        const data = await readBytesFromDevice(args.devicePath, offset, readLength)
        const hexDump = formatHexDump(data, offset)

        return { success: true, hexDump }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }
    },
  )
}
