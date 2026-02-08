/**
 * Windows device enumeration using PowerShell.
 *
 * Runs two PowerShell commands to gather disk and partition information,
 * then merges the results into DeviceInfo[].
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { DeviceInfo, PartitionInfo, FilesystemType } from '../../../shared/types'

const execFileAsync = promisify(execFile)

/** Shape of PowerShell Get-Disk output. */
interface PSDisk {
  Number: number
  FriendlyName: string
  Size: number
  MediaType: string | null // SSD, HDD, Unspecified
  BusType: string | null // USB, SATA, NVMe, etc.
  IsReadOnly: boolean
}

/** Shape of PowerShell Get-Partition output. */
interface PSPartition {
  DiskNumber: number
  PartitionNumber: number
  DriveLetter: string | null
  Size: number
  Type: string | null
}

/**
 * Run a PowerShell command and parse JSON output.
 *
 * The `-NoProfile` and `-NonInteractive` flags ensure we get clean output
 * without user profile scripts interfering.
 */
async function runPowerShell<T>(command: string): Promise<T> {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command
  ])

  const trimmed = stdout.trim()

  // PowerShell wraps single-element arrays as plain objects. We normalize
  // to always return an array.
  if (!trimmed || trimmed === '') {
    return [] as unknown as T
  }

  const parsed = JSON.parse(trimmed)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/**
 * Map PowerShell MediaType and BusType to our device type.
 */
function inferDeviceType(
  mediaType: string | null,
  busType: string | null
): 'sd' | 'hdd' | 'ssd' | 'usb' | 'unknown' {
  const bus = (busType ?? '').toLowerCase()

  if (bus === 'usb') return 'usb'
  if (bus === 'sd') return 'sd'

  const media = (mediaType ?? '').toLowerCase()
  if (media === 'ssd') return 'ssd'
  if (media === 'hdd') return 'hdd'

  return 'unknown'
}

/**
 * Attempt to resolve the filesystem type for a partition by querying
 * the Win32_Volume WMI class via its drive letter.
 */
async function getPartitionFilesystem(
  driveLetter: string | null
): Promise<FilesystemType | undefined> {
  if (!driveLetter) return undefined

  try {
    const command =
      `Get-Volume -DriveLetter '${driveLetter}' | ` +
      `Select-Object -ExpandProperty FileSystemType`

    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command
    ])

    const fsType = stdout.trim().toLowerCase()

    const mapping: Record<string, FilesystemType> = {
      fat32: 'fat32',
      exfat: 'exfat',
      ntfs: 'ntfs',
      refs: 'unknown'
    }

    return mapping[fsType] ?? 'unknown'
  } catch {
    return undefined
  }
}

/**
 * Enumerate all physical disks on Windows.
 *
 * Runs two PowerShell pipelines in sequence: one for disks and one for
 * partitions, then joins partitions to their parent disk by DiskNumber.
 */
export async function enumerateWindowsDevices(): Promise<DeviceInfo[]> {
  const [disks, partitions] = await Promise.all([
    runPowerShell<PSDisk[]>(
      'Get-Disk | Select-Object Number,FriendlyName,Size,MediaType,BusType,IsReadOnly | ConvertTo-Json'
    ),
    runPowerShell<PSPartition[]>(
      'Get-Partition | Select-Object DiskNumber,PartitionNumber,DriveLetter,Size,Type | ConvertTo-Json'
    )
  ])

  // Group partitions by disk number for O(1) lookup.
  const partitionsByDisk = new Map<number, PSPartition[]>()
  for (const part of partitions) {
    const existing = partitionsByDisk.get(part.DiskNumber) ?? []
    existing.push(part)
    partitionsByDisk.set(part.DiskNumber, existing)
  }

  const devices: DeviceInfo[] = []

  for (const disk of disks) {
    const diskPartitions = partitionsByDisk.get(disk.Number) ?? []
    const devicePath = `\\\\.\\PhysicalDrive${disk.Number}`

    const isRemovable =
      (disk.BusType ?? '').toLowerCase() === 'usb' ||
      (disk.BusType ?? '').toLowerCase() === 'sd'

    // Resolve partition info with filesystem detection.
    const mappedPartitions: PartitionInfo[] = await Promise.all(
      diskPartitions.map(async (part) => {
        const driveLetter =
          part.DriveLetter && part.DriveLetter.trim()
            ? part.DriveLetter.trim()
            : null

        const filesystem = await getPartitionFilesystem(driveLetter)

        return {
          id: `disk${disk.Number}s${part.PartitionNumber}`,
          path: driveLetter ? `${driveLetter}:\\` : `\\\\.\\Harddisk${disk.Number}Partition${part.PartitionNumber}`,
          label: driveLetter ? `${driveLetter}:` : `Partition ${part.PartitionNumber}`,
          size: BigInt(part.Size),
          offset: 0n, // PowerShell Get-Partition does not return offset by default
          filesystem,
          mountPoint: driveLetter ? `${driveLetter}:\\` : undefined
        }
      })
    )

    const mountPoints = mappedPartitions
      .filter((p) => p.mountPoint !== undefined)
      .map((p) => ({
        path: p.mountPoint!,
        filesystem: p.filesystem ?? 'unknown'
      }))

    devices.push({
      id: `PhysicalDrive${disk.Number}`,
      name: disk.FriendlyName ?? `Disk ${disk.Number}`,
      path: devicePath,
      size: BigInt(disk.Size),
      type: inferDeviceType(disk.MediaType, disk.BusType),
      model: disk.FriendlyName ?? '',
      removable: isRemovable,
      readOnly: disk.IsReadOnly,
      mountPoints,
      partitions: mappedPartitions
    })
  }

  return devices
}
