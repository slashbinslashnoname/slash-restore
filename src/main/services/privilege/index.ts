/**
 * PrivilegeManager - Cross-platform privilege elevation for raw device access.
 *
 * On most operating systems, reading raw block devices requires root/admin
 * privileges. This service detects whether the current process has sufficient
 * access and, if not, spawns an elevated helper process that performs the
 * actual I/O.
 *
 * The elevated helper communicates over stdin/stdout using JSON lines (newline-
 * delimited JSON). It is kept alive for the duration of the scanning session
 * and killed after 30 minutes of inactivity.
 */

import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { promisify } from 'util'
import type { PrivilegeStatus } from '../../../shared/types'

const fsAccess = promisify(fs.access)
const execFileAsync = promisify(execFile)

/**
 * PrivilegeManager - Cross-platform privilege elevation for raw device access.
 *
 * On Linux, uses pkexec to grant the current user read access to specific
 * block devices via ACL (setfacl) for the duration of the session.
 * On macOS, uses osascript with administrator privileges.
 * On Windows, uses PowerShell Start-Process -Verb RunAs.
 */
export class PrivilegeManager {
  private elevated = false
  /** Devices that have been granted read access via ACL. */
  private grantedDevices = new Set<string>()

  /**
   * Check whether the current process has sufficient privileges to read
   * raw block devices.
   */
  async checkPrivilege(): Promise<boolean> {
    if (this.elevated) return true

    switch (process.platform) {
      case 'linux':
      case 'darwin':
        return process.getuid?.() === 0

      case 'win32':
        try {
          await fsAccess('\\\\.\\PhysicalDrive0', fs.constants.R_OK)
          return true
        } catch {
          return false
        }

      default:
        return false
    }
  }

  /**
   * Request privilege elevation via the platform's authentication mechanism.
   *
   * @returns true if the user successfully authenticated.
   */
  async requestElevation(): Promise<boolean> {
    if (this.elevated) return true

    try {
      switch (process.platform) {
        case 'linux':
          await execFileAsync('pkexec', ['true'])
          this.elevated = true
          return true

        case 'darwin':
          await execFileAsync('osascript', [
            '-e',
            'do shell script "true" with administrator privileges'
          ])
          this.elevated = true
          return true

        case 'win32':
          await execFileAsync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c exit 0' -Verb RunAs -Wait"
          ])
          this.elevated = true
          return true

        default:
          return false
      }
    } catch {
      return false
    }
  }

  /**
   * Discover partition paths for a block device.
   * E.g., /dev/nvme0n1 -> [/dev/nvme0n1p1, /dev/nvme0n1p2]
   */
  private discoverPartitionPaths(devicePath: string): string[] {
    const devName = path.basename(devicePath)
    const partitions: string[] = []
    try {
      const entries = fs.readdirSync(`/sys/block/${devName}/`, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith(devName)) {
          partitions.push(`/dev/${entry.name}`)
        }
      }
    } catch {
      // Not a block device or /sys not available
    }
    return partitions
  }

  /**
   * Grant the current user read access to a block device and all its partitions.
   * Uses pkexec + setfacl on Linux, osascript + chmod on macOS.
   *
   * @param devicePath - The block device path (e.g., /dev/nvme0n1)
   * @returns true if access was granted.
   */
  async grantDeviceAccess(devicePath: string): Promise<boolean> {
    // Collect all paths to grant: the device itself + all partitions
    const paths = [devicePath, ...this.discoverPartitionPaths(devicePath)]
    const toGrant: string[] = []

    for (const p of paths) {
      if (this.grantedDevices.has(p)) continue
      try {
        await fsAccess(p, fs.constants.R_OK)
        this.grantedDevices.add(p)
      } catch {
        toGrant.push(p)
      }
    }

    if (toGrant.length === 0) return true

    try {
      const uid = process.getuid?.()
      switch (process.platform) {
        case 'linux':
          // Grant read ACL to all paths in a single pkexec call
          await execFileAsync('pkexec', [
            'bash', '-c',
            toGrant.map(p => `setfacl -m u:${uid}:r '${p}'`).join(' && ')
          ])
          for (const p of toGrant) this.grantedDevices.add(p)
          return true

        case 'darwin':
          await execFileAsync('osascript', [
            '-e',
            `do shell script "chmod o+r ${toGrant.join(' ')}" with administrator privileges`
          ])
          for (const p of toGrant) this.grantedDevices.add(p)
          return true

        default:
          return false
      }
    } catch (err) {
      console.error(`[privilege] Failed to grant access:`, err)
      return false
    }
  }

  /**
   * Revoke previously granted device access.
   */
  async revokeDeviceAccess(devicePath: string): Promise<void> {
    if (!this.grantedDevices.has(devicePath)) return

    try {
      const uid = process.getuid?.()
      switch (process.platform) {
        case 'linux':
          await execFileAsync('pkexec', [
            'setfacl', '-x', `u:${uid}`, devicePath
          ])
          break
        case 'darwin':
          await execFileAsync('osascript', [
            '-e',
            `do shell script "chmod o-r ${devicePath}" with administrator privileges`
          ])
          break
      }
    } catch {
      // Best effort - don't fail if revoke doesn't work
    }
    this.grantedDevices.delete(devicePath)
  }

  /**
   * Get the current privilege status.
   */
  async getStatus(): Promise<PrivilegeStatus> {
    const isElevated = await this.checkPrivilege()
    return {
      elevated: isElevated,
      platform: process.platform as 'linux' | 'darwin' | 'win32',
      helperPid: undefined
    }
  }

  /**
   * Revoke all granted device access and clean up.
   */
  async dispose(): Promise<void> {
    for (const device of this.grantedDevices) {
      await this.revokeDeviceAccess(device)
    }
    this.elevated = false
  }
}
