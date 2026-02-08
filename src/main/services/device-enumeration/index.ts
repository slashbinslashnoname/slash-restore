/**
 * Cross-platform device enumeration.
 *
 * Delegates to the platform-specific implementation based on process.platform.
 * This is the single entry point for the rest of the application.
 */

import type { DeviceInfo } from '../../../shared/types'

/**
 * Enumerate all block devices on the current platform.
 *
 * @returns An array of DeviceInfo objects representing physical disks and
 *   their partitions.
 * @throws If the platform is not supported or the underlying system command fails.
 */
export async function enumerateDevices(): Promise<DeviceInfo[]> {
  switch (process.platform) {
    case 'linux': {
      const { enumerateLinuxDevices } = await import('./linux')
      return enumerateLinuxDevices()
    }

    case 'darwin': {
      const { enumerateMacOSDevices } = await import('./macos')
      return enumerateMacOSDevices()
    }

    case 'win32': {
      const { enumerateWindowsDevices } = await import('./windows')
      return enumerateWindowsDevices()
    }

    default:
      throw new Error(
        `Unsupported platform for device enumeration: ${process.platform}`
      )
  }
}
