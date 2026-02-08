import { HardDrive, Usb, MemoryStick } from 'lucide-react'
import type { SerializedDeviceInfo } from '../store'

function formatBytes(sizeStr: string): string {
  const bytes = Number(sizeStr)
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function DeviceIcon({
  type
}: {
  type: SerializedDeviceInfo['type']
}) {
  const cls = 'h-8 w-8'
  switch (type) {
    case 'usb':
      return <Usb className={cls} />
    case 'sd':
      return <MemoryStick className={cls} />
    case 'hdd':
    case 'ssd':
    case 'unknown':
    default:
      return <HardDrive className={cls} />
  }
}

interface DeviceCardProps {
  device: SerializedDeviceInfo
  selected: boolean
  onClick: () => void
}

export default function DeviceCard({
  device,
  selected,
  onClick
}: DeviceCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        group w-full rounded-xl border p-5 text-left transition-all
        ${
          selected
            ? 'border-primary-500 bg-primary-500/10 shadow-lg shadow-primary-500/10'
            : 'border-surface-lighter bg-surface-light hover:border-gray-600 hover:bg-surface-lighter'
        }
      `}
    >
      <div className="flex items-start gap-4">
        {/* Icon */}
        <div
          className={`
            flex h-14 w-14 shrink-0 items-center justify-center rounded-lg
            ${selected ? 'bg-primary-500/20 text-primary-400' : 'bg-surface-lighter text-gray-400 group-hover:text-gray-300'}
          `}
        >
          <DeviceIcon type={device.type} />
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-white">
              {device.name || device.path}
            </h3>
            {device.removable && (
              <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                Removable
              </span>
            )}
            {device.readOnly && (
              <span className="shrink-0 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
                Read-Only
              </span>
            )}
          </div>

          <p className="mt-0.5 truncate text-xs text-gray-400">
            {device.model || 'Unknown model'}
          </p>

          <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
            <span>{formatBytes(device.size)}</span>
            <span className="text-surface-lighter">|</span>
            <span className="uppercase">{device.type}</span>
            {device.filesystem && (
              <>
                <span className="text-surface-lighter">|</span>
                <span className="uppercase">{device.filesystem}</span>
              </>
            )}
          </div>

          {/* Partitions summary */}
          {device.partitions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {device.partitions.map((p) => (
                <span
                  key={p.id}
                  className="rounded bg-surface-lighter px-2 py-0.5 text-[10px] text-gray-400"
                >
                  {p.label || p.path} ({formatBytes(p.size)})
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </button>
  )
}
