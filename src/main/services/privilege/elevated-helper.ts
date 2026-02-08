/**
 * Elevated helper process for performing raw disk reads with root/admin privileges.
 *
 * This script is spawned by the PrivilegeManager and communicates over
 * stdin/stdout using newline-delimited JSON (JSON Lines). It is deliberately
 * minimal and restricted to read-only operations.
 *
 * Protocol:
 *   stdin  -> { type: 'read', path: string, offset: string, length: number }
 *   stdout <- { type: 'data', data: string }        // base64 encoded
 *   stdout <- { type: 'error', message: string }
 *   stdout <- { type: 'ready' }                      // sent once on startup
 *
 * The helper keeps file descriptors open across reads for the same path to
 * avoid the overhead of re-opening on every request. Descriptors are closed
 * when the process exits.
 */

import * as fs from 'fs'
import { promisify } from 'util'
import { createInterface } from 'readline'

const fsOpen = promisify(fs.open)
const fsRead = promisify(fs.read)
const fsClose = promisify(fs.close)

/** Maximum allowed read length per request (16 MB). */
const MAX_READ_LENGTH = 16 * 1024 * 1024

/** Cache of open file descriptors keyed by device path. */
const openFds = new Map<string, number>()

/** Command received from the parent process. */
interface ReadCommand {
  type: 'read'
  path: string
  offset: string
  length: number
}

/**
 * Write a JSON response line to stdout.
 */
function respond(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/**
 * Get (or open) a file descriptor for the given path.
 * Only opens in read-only mode - no writes are ever performed.
 */
async function getOrOpenFd(devicePath: string): Promise<number> {
  const cached = openFds.get(devicePath)
  if (cached !== undefined) return cached

  const fd = await fsOpen(devicePath, 'r')
  openFds.set(devicePath, fd)
  return fd
}

/**
 * Handle a single read command.
 */
async function handleRead(command: ReadCommand): Promise<void> {
  // Validate the command shape.
  if (typeof command.path !== 'string' || !command.path) {
    respond({ type: 'error', message: 'Missing or invalid "path" field' })
    return
  }

  if (typeof command.offset !== 'string') {
    respond({ type: 'error', message: 'Missing or invalid "offset" field (expected string)' })
    return
  }

  if (typeof command.length !== 'number' || command.length <= 0) {
    respond({ type: 'error', message: 'Missing or invalid "length" field (expected positive number)' })
    return
  }

  if (command.length > MAX_READ_LENGTH) {
    respond({
      type: 'error',
      message: `Read length ${command.length} exceeds maximum of ${MAX_READ_LENGTH} bytes`
    })
    return
  }

  // Security: only allow paths that look like block devices or image files.
  // Reject obvious attempts to read arbitrary system files.
  const allowedPatterns = [
    /^\/dev\//, // Linux/macOS device paths
    /^\\\\\.\\/, // Windows PhysicalDrive paths
    /\.(img|raw|dd|iso)$/i // Common disk image extensions
  ]

  const pathAllowed = allowedPatterns.some((p) => p.test(command.path))
  if (!pathAllowed) {
    respond({
      type: 'error',
      message: `Path "${command.path}" is not an allowed device or image path`
    })
    return
  }

  try {
    const fd = await getOrOpenFd(command.path)
    const offset = BigInt(command.offset)
    const buffer = Buffer.alloc(command.length)

    const result = await fsRead(fd, buffer, 0, command.length, Number(offset))

    const data =
      result.bytesRead < command.length
        ? buffer.subarray(0, result.bytesRead).toString('base64')
        : buffer.toString('base64')

    respond({ type: 'data', data })
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Unknown error during read'
    respond({ type: 'error', message })
  }
}

/**
 * Process a single line of input.
 */
async function processLine(line: string): Promise<void> {
  const trimmed = line.trim()
  if (!trimmed) return

  let command: Record<string, unknown>
  try {
    command = JSON.parse(trimmed)
  } catch {
    respond({ type: 'error', message: 'Invalid JSON input' })
    return
  }

  if (command.type === 'read') {
    await handleRead(command as unknown as ReadCommand)
  } else {
    respond({
      type: 'error',
      message: `Unknown command type: ${String(command.type)}`
    })
  }
}

/**
 * Clean up all open file descriptors on exit.
 */
async function cleanup(): Promise<void> {
  const closePromises = Array.from(openFds.values()).map((fd) =>
    fsClose(fd).catch(() => {
      /* best effort */
    })
  )
  openFds.clear()
  await Promise.allSettled(closePromises)
}

// ─── Main entry point ─────────────────────────────────────────

function main(): void {
  // Signal that the helper is ready to accept commands.
  respond({ type: 'ready' })

  const rl = createInterface({ input: process.stdin })

  rl.on('line', (line) => {
    processLine(line).catch((err) => {
      respond({
        type: 'error',
        message: `Internal error: ${err instanceof Error ? err.message : String(err)}`
      })
    })
  })

  rl.on('close', () => {
    cleanup().finally(() => {
      process.exit(0)
    })
  })

  // Handle unexpected termination.
  process.on('SIGTERM', () => {
    cleanup().finally(() => {
      process.exit(0)
    })
  })

  process.on('SIGINT', () => {
    cleanup().finally(() => {
      process.exit(0)
    })
  })
}

main()
