import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import * as Checkbox from '@radix-ui/react-checkbox'
import * as Tabs from '@radix-ui/react-tabs'
import {
  Check,
  Zap,
  Search,
  ChevronLeft,
  ChevronRight,
  Image,
  Film,
  FileText,
  Music,
  Archive,
  Database
} from 'lucide-react'
import { useAppStore } from '../store'
import { ALL_FILE_TYPES, type FileCategory, type FileType, type ScanType } from '../../shared/types'

interface FileTypeGroup {
  category: FileCategory
  label: string
  icon: typeof Image
  types: { ext: string; label: string }[]
}

const fileTypeGroups: FileTypeGroup[] = [
  {
    category: 'photo',
    label: 'Photos',
    icon: Image,
    types: [
      { ext: 'jpeg', label: 'JPEG' },
      { ext: 'png', label: 'PNG' },
      { ext: 'heic', label: 'HEIC' },
      { ext: 'gif', label: 'GIF' },
      { ext: 'webp', label: 'WebP' },
      { ext: 'psd', label: 'PSD (Photoshop)' },
      { ext: 'cr2', label: 'CR2 (Canon RAW)' },
      { ext: 'nef', label: 'NEF (Nikon RAW)' },
      { ext: 'arw', label: 'ARW (Sony RAW)' }
    ]
  },
  {
    category: 'video',
    label: 'Videos',
    icon: Film,
    types: [
      { ext: 'mp4', label: 'MP4' },
      { ext: 'mov', label: 'MOV' },
      { ext: 'avi', label: 'AVI' },
      { ext: 'mkv', label: 'MKV / WebM' },
      { ext: 'flv', label: 'FLV' },
      { ext: 'wmv', label: 'WMV' }
    ]
  },
  {
    category: 'document',
    label: 'Documents',
    icon: FileText,
    types: [
      { ext: 'pdf', label: 'PDF' },
      { ext: 'docx', label: 'DOCX' },
      { ext: 'xlsx', label: 'XLSX' },
      { ext: 'pptx', label: 'PPTX' },
      { ext: 'rtf', label: 'RTF' }
    ]
  },
  {
    category: 'audio',
    label: 'Audio',
    icon: Music,
    types: [
      { ext: 'mp3', label: 'MP3' },
      { ext: 'wav', label: 'WAV' },
      { ext: 'flac', label: 'FLAC' },
      { ext: 'ogg', label: 'OGG' },
      { ext: 'm4a', label: 'M4A' }
    ]
  },
  {
    category: 'archive',
    label: 'Archives',
    icon: Archive,
    types: [
      { ext: 'zip', label: 'ZIP' },
      { ext: 'rar', label: 'RAR' },
      { ext: '7z', label: '7-Zip' },
      { ext: 'gz', label: 'Gzip' },
      { ext: 'bz2', label: 'Bzip2' },
      { ext: 'xz', label: 'XZ' },
      { ext: 'tar', label: 'TAR' }
    ]
  },
  {
    category: 'database',
    label: 'Database',
    icon: Database,
    types: [
      { ext: 'sqlite', label: 'SQLite' },
      { ext: 'bdb', label: 'BDB (wallet.dat)' }
    ]
  }
]

export default function ScanConfigPage() {
  const navigate = useNavigate()
  const selectedDevice = useAppStore((s) => s.selectedDevice)
  const scanType = useAppStore((s) => s.scanType)
  const selectedFileTypes = useAppStore((s) => s.selectedFileTypes)
  const selectedPartition = useAppStore((s) => s.selectedPartition)
  const setScanType = useAppStore((s) => s.setScanType)
  const toggleFileCategory = useAppStore((s) => s.toggleFileCategory)
  const toggleFileType = useAppStore((s) => s.toggleFileType)
  const setSelectedPartition = useAppStore((s) => s.setSelectedPartition)
  const setCurrentStep = useAppStore((s) => s.setCurrentStep)

  useEffect(() => {
    setCurrentStep(2)
  }, [setCurrentStep])

  // Redirect if no device selected
  useEffect(() => {
    if (!selectedDevice) {
      navigate('/')
    }
  }, [selectedDevice, navigate])

  if (!selectedDevice) return null

  const partitions = selectedDevice.partitions

  const handleStart = () => {
    navigate('/scanning')
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white">Configure Scan</h2>
        <p className="mt-1 text-sm text-gray-400">
          Scanning{' '}
          <span className="font-medium text-gray-300">
            {selectedDevice.name || selectedDevice.path}
          </span>
        </p>
      </div>

      {/* Scan type selector */}
      <section className="mb-8">
        <h3 className="mb-3 text-sm font-semibold text-gray-300">
          Scan Type
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <ScanTypeCard
            type="quick"
            selected={scanType === 'quick'}
            onClick={() => setScanType('quick')}
            icon={<Zap className="h-6 w-6" />}
            title="Quick Scan"
            description="Recovers files from filesystem metadata. Fast but may miss deleted files that have been overwritten."
          />
          <ScanTypeCard
            type="deep"
            selected={scanType === 'deep'}
            onClick={() => setScanType('deep')}
            icon={<Search className="h-6 w-6" />}
            title="Deep Scan"
            description="File carving scans every sector. Slower but can recover files even after formatting."
          />
        </div>
      </section>

      {/* Partition selector */}
      {partitions.length > 1 && (
        <section className="mb-8">
          <h3 className="mb-3 text-sm font-semibold text-gray-300">
            Partition
          </h3>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setSelectedPartition(null)}
              className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
                !selectedPartition
                  ? 'border-primary-500 bg-primary-500/10 text-primary-300'
                  : 'border-surface-lighter bg-surface-light text-gray-400 hover:border-gray-600'
              }`}
            >
              Entire Device
            </button>
            {partitions.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedPartition(p)}
                className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
                  selectedPartition?.id === p.id
                    ? 'border-primary-500 bg-primary-500/10 text-primary-300'
                    : 'border-surface-lighter bg-surface-light text-gray-400 hover:border-gray-600'
                }`}
              >
                {p.label || p.path}
                <span className="ml-2 text-xs text-gray-600">
                  {formatBytes(p.size)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* File type filter */}
      <section className="mb-8">
        <h3 className="mb-3 text-sm font-semibold text-gray-300">
          File Types
        </h3>
        <Tabs.Root defaultValue="photo">
          <Tabs.List className="mb-4 flex gap-1 rounded-lg bg-surface-light p-1">
            {fileTypeGroups.map((group) => {
              const Icon = group.icon
              return (
                <Tabs.Trigger
                  key={group.category}
                  value={group.category}
                  className="flex items-center gap-1.5 rounded-md px-4 py-2 text-sm text-gray-400 transition-colors data-[state=active]:bg-surface-lighter data-[state=active]:text-white"
                >
                  <Icon className="h-4 w-4" />
                  {group.label}
                </Tabs.Trigger>
              )
            })}
          </Tabs.List>

          {fileTypeGroups.map((group) => {
            const selectedInCategory = group.types.filter((ft) =>
              selectedFileTypes.includes(ft.ext as FileType)
            )
            const allSelected = selectedInCategory.length === group.types.length
            const someSelected = selectedInCategory.length > 0 && !allSelected
            return (
              <Tabs.Content key={group.category} value={group.category}>
                <div className="rounded-lg border border-surface-lighter bg-surface-light p-4">
                  {/* Category toggle (select/deselect all) */}
                  <label className="mb-3 flex items-center gap-3">
                    <Checkbox.Root
                      checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                      onCheckedChange={() =>
                        toggleFileCategory(group.category)
                      }
                      className="flex h-5 w-5 items-center justify-center rounded border border-gray-500 bg-surface transition-colors data-[state=checked]:border-primary-500 data-[state=checked]:bg-primary-500 data-[state=indeterminate]:border-primary-500 data-[state=indeterminate]:bg-primary-500"
                    >
                      <Checkbox.Indicator>
                        {someSelected ? (
                          <div className="h-2 w-2 rounded-sm bg-white" />
                        ) : (
                          <Check className="h-3.5 w-3.5 text-white" />
                        )}
                      </Checkbox.Indicator>
                    </Checkbox.Root>
                    <span className="text-sm font-medium text-white">
                      All {group.label.toLowerCase()}
                    </span>
                  </label>

                  {/* Individual type checkboxes */}
                  <div className="ml-8 grid grid-cols-2 gap-2">
                    {group.types.map((ft) => {
                      const isChecked = selectedFileTypes.includes(ft.ext as FileType)
                      return (
                        <label
                          key={ft.ext}
                          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-surface-lighter"
                        >
                          <Checkbox.Root
                            checked={isChecked}
                            onCheckedChange={() =>
                              toggleFileType(ft.ext as FileType)
                            }
                            className="flex h-4 w-4 items-center justify-center rounded border border-gray-500 bg-surface transition-colors data-[state=checked]:border-primary-500 data-[state=checked]:bg-primary-500"
                          >
                            <Checkbox.Indicator>
                              <Check className="h-3 w-3 text-white" />
                            </Checkbox.Indicator>
                          </Checkbox.Root>
                          <span className="font-mono uppercase text-gray-500">
                            .{ft.ext}
                          </span>
                          <span className={isChecked ? 'text-gray-300' : 'text-gray-600'}>
                            {ft.label}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              </Tabs.Content>
            )
          })}
        </Tabs.Root>
      </section>

      {/* Summary */}
      <section className="mb-8 rounded-lg border border-surface-lighter bg-surface-light p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Summary
        </h3>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">Device</span>
            <span className="text-gray-200">
              {selectedDevice.name || selectedDevice.path}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Scan Type</span>
            <span className="text-gray-200">
              {scanType === 'quick' ? 'Quick Scan' : 'Deep Scan'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Partition</span>
            <span className="text-gray-200">
              {selectedPartition
                ? selectedPartition.label || selectedPartition.path
                : 'Entire Device'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">File Types</span>
            <span className="text-gray-200">
              {selectedFileTypes.length === 0
                ? 'None selected'
                : selectedFileTypes.length === ALL_FILE_TYPES.length
                  ? 'All types'
                  : `${selectedFileTypes.length} types selected`}
            </span>
          </div>
        </div>
      </section>

      {/* Actions */}
      <div className="flex justify-between">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 rounded-lg bg-surface-light px-4 py-2.5 text-sm text-gray-300 transition-colors hover:bg-surface-lighter"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </button>
        <button
          onClick={handleStart}
          disabled={selectedFileTypes.length === 0}
          className="flex items-center gap-2 rounded-lg bg-primary-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Start Scan
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

// ─── Internal components ────────────────────────────────────

function ScanTypeCard({
  selected,
  onClick,
  icon,
  title,
  description
}: {
  type: ScanType
  selected: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        rounded-xl border p-5 text-left transition-all
        ${
          selected
            ? 'border-primary-500 bg-primary-500/10'
            : 'border-surface-lighter bg-surface-light hover:border-gray-600'
        }
      `}
    >
      <div
        className={`mb-3 ${selected ? 'text-primary-400' : 'text-gray-400'}`}
      >
        {icon}
      </div>
      <h4 className="text-sm font-semibold text-white">{title}</h4>
      <p className="mt-1 text-xs leading-relaxed text-gray-400">
        {description}
      </p>
    </button>
  )
}

function formatBytes(sizeStr: string): string {
  const bytes = Number(sizeStr)
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
