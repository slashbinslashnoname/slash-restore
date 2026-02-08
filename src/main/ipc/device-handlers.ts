import type { IpcMain } from 'electron'
import { IpcChannels } from '../../shared/types'
import type { DeviceInfo, PartitionInfo } from '../../shared/types'
import { enumerateDevices } from '../services/device-enumeration'

// ─── BigInt Serialization ────────────────────────────────────
// Electron's IPC uses structured clone, which does not support bigint.
// We convert every bigint field to a string before sending to the renderer.

interface SerializedPartitionInfo extends Omit<PartitionInfo, 'size' | 'offset'> {
  size: string
  offset: string
}

interface SerializedDeviceInfo extends Omit<DeviceInfo, 'size' | 'partitions'> {
  size: string
  partitions: SerializedPartitionInfo[]
}

function serializePartition(partition: PartitionInfo): SerializedPartitionInfo {
  return {
    ...partition,
    size: partition.size.toString(),
    offset: partition.offset.toString(),
  }
}

function serializeDevice(device: DeviceInfo): SerializedDeviceInfo {
  return {
    ...device,
    size: device.size.toString(),
    partitions: device.partitions.map(serializePartition),
  }
}

// ─── Handler Registration ────────────────────────────────────

export function registerDeviceHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IpcChannels.DEVICE_LIST, async () => {
    try {
      const devices = await enumerateDevices()
      return { success: true, devices: devices.map(serializeDevice) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message, devices: [] }
    }
  })

  ipcMain.handle(IpcChannels.DEVICE_REFRESH, async () => {
    try {
      // Force re-enumerate by calling the same function.
      // The underlying platform module always queries the OS fresh;
      // a future caching layer can honour a forceRefresh flag here.
      const devices = await enumerateDevices()
      return { success: true, devices: devices.map(serializeDevice) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message, devices: [] }
    }
  })
}
