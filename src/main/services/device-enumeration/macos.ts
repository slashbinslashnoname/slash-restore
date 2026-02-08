/**
 * macOS device enumeration using diskutil.
 *
 * Runs `diskutil list -plist` to discover disk devices and their partitions,
 * then maps the output to DeviceInfo[]. Uses the `plist` npm package for
 * parsing Apple property list XML.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as plist from 'plist'
import type { DeviceInfo, PartitionInfo, FilesystemType } from '../../../shared/types'

const execFileAsync = promisify(execFile)

/** Partial shape of the plist output from `diskutil list -plist`. */
interface DiskutilPlist {
  AllDisksAndPartitions: DiskutilDisk[]
  AllDisks: string[]
  VolumesFromDisks: string[]
  WholeDisks: string[]
}

interface DiskutilDisk {
  DeviceIdentifier: string
  Size: number
  Content: string
  APFSPhysicalStores?: Array<{ DeviceIdentifier: string }>
  Partitions?: DiskutilPartition[]
  APFSVolumes?: DiskutilPartition[]
  MountPoint?: string
  VolumeName?: string
}

interface DiskutilPartition {
  DeviceIdentifier: string
  Size: number
  Content: string
  MountPoint?: string
  VolumeName?: string
  DiskUUID?: string
}

/** Shape of `diskutil info -plist <device>` output (subset). */
interface DiskutilInfo {
  DeviceIdentifier: string
  DeviceNode: string
  MediaName?: string
  MediaType?: string
  Size: number
  Ejectable?: boolean
  Internal?: boolean
  Removable?: boolean
  RemovableMedia?: boolean
  WritableMedia?: boolean
  SolidState?: boolean
  BusProtocol?: string
  IORegistryEntryName?: string
  VirtualOrPhysical?: string
}

/**
 * Map diskutil content type string to our FilesystemType union.
 */
function mapFilesystemType(content: string): FilesystemType | undefined {
  if (!content) return undefined

  const normalized = content.toLowerCase()

  if (normalized.includes('fat32') || normalized.includes('dos_fat_32')) return 'fat32'
  if (normalized.includes('exfat') || normalized.includes('ef_system')) return 'exfat'
  if (normalized.includes('ntfs') || normalized.includes('windows_ntfs')) return 'ntfs'
  if (normalized.includes('hfs') || normalized.includes('apple_hfs')) return 'hfs+'
  if (normalized.includes('apfs') || normalized.includes('apple_apfs')) return 'apfs'
  if (normalized.includes('ext4') || normalized.includes('linux')) return 'ext4'

  return 'unknown'
}

/**
 * Get detailed info for a specific device identifier.
 */
async function getDeviceInfo(deviceIdentifier: string): Promise<DiskutilInfo> {
  const { stdout } = await execFileAsync('diskutil', [
    'info',
    '-plist',
    `/dev/${deviceIdentifier}`
  ])
  return plist.parse(stdout) as unknown as DiskutilInfo
}

/**
 * Determine device type from diskutil info.
 */
function inferDeviceType(
  info: DiskutilInfo
): 'sd' | 'hdd' | 'ssd' | 'usb' | 'unknown' {
  const bus = (info.BusProtocol ?? '').toLowerCase()

  if (bus === 'usb') return 'usb'
  if (bus === 'secure digital' || bus === 'sd') return 'sd'

  if (info.SolidState === true) return 'ssd'

  // Internal non-SSD drives default to HDD.
  if (info.Internal === true) return 'hdd'

  return 'unknown'
}

/**
 * Enumerate all disk devices on macOS.
 *
 * Calls `diskutil list -plist` for the overview, then `diskutil info -plist`
 * for each whole disk to obtain detailed attributes (bus type, SSD flag, etc.).
 */
export async function enumerateMacOSDevices(): Promise<DeviceInfo[]> {
  const { stdout } = await execFileAsync('diskutil', ['list', '-plist'])

  const parsed = plist.parse(stdout) as unknown as DiskutilPlist

  const devices: DeviceInfo[] = []

  for (const disk of parsed.AllDisksAndPartitions) {
    const deviceId = disk.DeviceIdentifier // e.g. "disk0"
    const devicePath = `/dev/${deviceId}`

    let info: DiskutilInfo
    try {
      info = await getDeviceInfo(deviceId)
    } catch {
      // If we cannot get detailed info, build what we can from the list.
      info = {
        DeviceIdentifier: deviceId,
        DeviceNode: devicePath,
        Size: disk.Size
      }
    }

    const isRemovable =
      info.Removable === true ||
      info.RemovableMedia === true ||
      info.Ejectable === true

    const isReadOnly = info.WritableMedia === false

    // Gather partitions from both HFS/FAT-style partitions and APFS volumes.
    const rawPartitions: DiskutilPartition[] = [
      ...(disk.Partitions ?? []),
      ...(disk.APFSVolumes ?? [])
    ]

    const partitions: PartitionInfo[] = rawPartitions.map((part) => ({
      id: part.DeviceIdentifier,
      path: `/dev/${part.DeviceIdentifier}`,
      label: part.VolumeName ?? part.DeviceIdentifier,
      size: BigInt(part.Size),
      offset: 0n, // diskutil list does not report partition offsets
      filesystem: mapFilesystemType(part.Content),
      mountPoint: part.MountPoint ?? undefined
    }))

    const mountPoints = partitions
      .filter((p) => p.mountPoint !== undefined)
      .map((p) => ({
        path: p.mountPoint!,
        filesystem: p.filesystem ?? 'unknown'
      }))

    devices.push({
      id: deviceId,
      name: info.MediaName ?? info.IORegistryEntryName ?? deviceId,
      path: devicePath,
      size: BigInt(info.Size ?? disk.Size),
      type: inferDeviceType(info),
      model: info.MediaName ?? '',
      removable: isRemovable,
      readOnly: isReadOnly,
      mountPoints,
      filesystem: mapFilesystemType(disk.Content),
      partitions
    })
  }

  return devices
}
