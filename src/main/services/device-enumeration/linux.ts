/**
 * Linux device enumeration using lsblk.
 *
 * Runs `lsblk --json --bytes` to discover block devices and their partitions,
 * then maps the output to the DeviceInfo[] structure shared across the app.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { DeviceInfo, PartitionInfo, FilesystemType } from '../../../shared/types'

const execFileAsync = promisify(execFile)

/** Shape of individual device entries returned by lsblk --json. */
interface LsblkDevice {
  name: string
  size: number | string
  type: string
  model: string | null
  rm: boolean | number
  ro: boolean | number
  mountpoint: string | null
  fstype: string | null
  path: string
  children?: LsblkDevice[]
}

interface LsblkOutput {
  blockdevices: LsblkDevice[]
}

/**
 * Map a raw filesystem type string from lsblk to our FilesystemType union.
 */
function mapFilesystemType(fstype: string | null): FilesystemType | undefined {
  if (!fstype) return undefined

  const normalized = fstype.toLowerCase()
  const mapping: Record<string, FilesystemType> = {
    vfat: 'fat32',
    fat32: 'fat32',
    exfat: 'exfat',
    ntfs: 'ntfs',
    ext4: 'ext4',
    'hfsplus': 'hfs+',
    apfs: 'apfs'
  }

  return mapping[normalized] ?? 'unknown'
}

/**
 * Infer the device type from its path and characteristics.
 *
 * - /dev/sd* with removable flag  -> usb
 * - /dev/mmcblk*                  -> sd
 * - /dev/nvme*                    -> ssd
 * - /dev/sd* non-removable        -> hdd (default; real SSD detection would
 *                                    require reading /sys/block/<dev>/queue/rotational)
 */
function inferDeviceType(
  path: string,
  removable: boolean
): 'sd' | 'hdd' | 'ssd' | 'usb' | 'unknown' {
  if (path.includes('mmcblk')) return 'sd'
  if (path.includes('nvme')) return 'ssd'

  if (path.match(/\/dev\/sd[a-z]/)) {
    return removable ? 'usb' : 'hdd'
  }

  return 'unknown'
}

/**
 * Map an lsblk child entry (partition) to our PartitionInfo structure.
 */
function mapPartition(child: LsblkDevice): PartitionInfo {
  return {
    id: child.name,
    path: child.path,
    label: child.name,
    size: BigInt(child.size),
    offset: 0n, // lsblk does not report partition offset; consumer must resolve via sysfs if needed
    filesystem: mapFilesystemType(child.fstype),
    mountPoint: child.mountpoint ?? undefined
  }
}

/**
 * Enumerate all block devices on a Linux system.
 *
 * Executes lsblk with JSON output and maps the result to DeviceInfo[].
 * Only top-level disk devices are returned; their partitions are nested
 * inside the `partitions` array.
 */
export async function enumerateLinuxDevices(): Promise<DeviceInfo[]> {
  const { stdout } = await execFileAsync('lsblk', [
    '--json',
    '--bytes',
    '--output',
    'NAME,SIZE,TYPE,MODEL,RM,RO,MOUNTPOINT,FSTYPE,PATH'
  ])

  const parsed: LsblkOutput = JSON.parse(stdout)

  const devices: DeviceInfo[] = []

  for (const device of parsed.blockdevices) {
    // Only include top-level disk devices (type === 'disk').
    if (device.type !== 'disk') continue

    const removable = device.rm === true || device.rm === 1
    const readOnly = device.ro === true || device.ro === 1

    const partitions: PartitionInfo[] = (device.children ?? [])
      .filter((child) => child.type === 'part')
      .map(mapPartition)

    const mountPoints = partitions
      .filter((p) => p.mountPoint !== undefined)
      .map((p) => ({
        path: p.mountPoint!,
        filesystem: p.filesystem ?? 'unknown'
      }))

    devices.push({
      id: device.name,
      name: device.model?.trim() || device.name,
      path: device.path,
      size: BigInt(device.size),
      type: inferDeviceType(device.path, removable),
      model: device.model?.trim() ?? '',
      removable,
      readOnly,
      mountPoints,
      filesystem: mapFilesystemType(device.fstype),
      partitions
    })
  }

  return devices
}
