import { useState, useMemo } from 'react'
import * as Checkbox from '@radix-ui/react-checkbox'
import {
  Check,
  ChevronUp,
  ChevronDown,
  Image,
  Film,
  FileText
} from 'lucide-react'
import { useAppStore } from '../store'
import type { SerializedRecoverableFile } from '../store'

type SortField = 'name' | 'type' | 'size' | 'recoverability'
type SortDir = 'asc' | 'desc'

function formatBytes(sizeStr: string): string {
  const bytes = Number(sizeStr)
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function CategoryIcon({ category }: { category: string }) {
  switch (category) {
    case 'photo':
      return <Image className="h-4 w-4 text-blue-400" />
    case 'video':
      return <Film className="h-4 w-4 text-purple-400" />
    case 'document':
      return <FileText className="h-4 w-4 text-amber-400" />
    default:
      return <FileText className="h-4 w-4 text-gray-400" />
  }
}

function RecoverabilityBadge({
  status
}: {
  status: 'good' | 'partial' | 'poor'
}) {
  const styles = {
    good: 'bg-green-500/20 text-green-400',
    partial: 'bg-yellow-500/20 text-yellow-400',
    poor: 'bg-red-500/20 text-red-400'
  }
  const labels = {
    good: 'Good',
    partial: 'Partial',
    poor: 'Poor'
  }
  return (
    <span
      className={`rounded px-2 py-0.5 text-[11px] font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  )
}

interface FileTableProps {
  files: SerializedRecoverableFile[]
  onFileClick: (fileId: string) => void
}

export default function FileTable({ files, onFileClick }: FileTableProps) {
  const selectedFileIds = useAppStore((s) => s.selectedFileIds)
  const toggleFileSelection = useAppStore((s) => s.toggleFileSelection)
  const selectAllFiles = useAppStore((s) => s.selectAllFiles)
  const deselectAllFiles = useAppStore((s) => s.deselectAllFiles)

  const [sortField, setSortField] = useState<SortField>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const allSelected =
    files.length > 0 && files.every((f) => selectedFileIds.has(f.id))

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  const sorted = useMemo(() => {
    const arr = [...files]
    const dir = sortDir === 'asc' ? 1 : -1

    arr.sort((a, b) => {
      switch (sortField) {
        case 'name': {
          const nameA = a.name || `file_${a.id}`
          const nameB = b.name || `file_${b.id}`
          return nameA.localeCompare(nameB) * dir
        }
        case 'type':
          return a.type.localeCompare(b.type) * dir
        case 'size':
          return (Number(a.size) - Number(b.size)) * dir
        case 'recoverability': {
          const order = { good: 0, partial: 1, poor: 2 }
          return (
            (order[a.recoverability] - order[b.recoverability]) * dir
          )
        }
        default:
          return 0
      }
    })

    return arr
  }, [files, sortField, sortDir])

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null
    return sortDir === 'asc' ? (
      <ChevronUp className="ml-1 inline h-3 w-3" />
    ) : (
      <ChevronDown className="ml-1 inline h-3 w-3" />
    )
  }

  return (
    <div className="overflow-auto rounded-lg border border-surface-lighter">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-surface-lighter bg-surface-light text-xs text-gray-400">
            {/* Select all */}
            <th className="w-10 px-3 py-2.5">
              <Checkbox.Root
                checked={allSelected}
                onCheckedChange={(checked) => {
                  if (checked) {
                    selectAllFiles()
                  } else {
                    deselectAllFiles()
                  }
                }}
                className="flex h-4 w-4 items-center justify-center rounded border border-gray-500 bg-surface transition-colors data-[state=checked]:border-primary-500 data-[state=checked]:bg-primary-500"
              >
                <Checkbox.Indicator>
                  <Check className="h-3 w-3 text-white" />
                </Checkbox.Indicator>
              </Checkbox.Root>
            </th>
            {/* Thumbnail */}
            <th className="w-10 px-2 py-2.5" />
            <th
              className="cursor-pointer px-3 py-2.5 hover:text-gray-200"
              onClick={() => handleSort('name')}
            >
              Name
              <SortIcon field="name" />
            </th>
            <th
              className="cursor-pointer px-3 py-2.5 hover:text-gray-200"
              onClick={() => handleSort('type')}
            >
              Type
              <SortIcon field="type" />
            </th>
            <th
              className="cursor-pointer px-3 py-2.5 hover:text-gray-200"
              onClick={() => handleSort('size')}
            >
              Size
              <SortIcon field="size" />
            </th>
            <th
              className="cursor-pointer px-3 py-2.5 hover:text-gray-200"
              onClick={() => handleSort('recoverability')}
            >
              Status
              <SortIcon field="recoverability" />
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((file) => {
            const isSelected = selectedFileIds.has(file.id)
            return (
              <tr
                key={file.id}
                className={`
                  cursor-pointer border-b border-surface-lighter transition-colors
                  ${isSelected ? 'bg-primary-500/5' : 'hover:bg-surface-light'}
                `}
                onClick={() => onFileClick(file.id)}
              >
                <td
                  className="px-3 py-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Checkbox.Root
                    checked={isSelected}
                    onCheckedChange={() => toggleFileSelection(file.id)}
                    className="flex h-4 w-4 items-center justify-center rounded border border-gray-500 bg-surface transition-colors data-[state=checked]:border-primary-500 data-[state=checked]:bg-primary-500"
                  >
                    <Checkbox.Indicator>
                      <Check className="h-3 w-3 text-white" />
                    </Checkbox.Indicator>
                  </Checkbox.Root>
                </td>
                <td className="px-2 py-2">
                  {file.thumbnail ? (
                    <img
                      src={file.thumbnail}
                      alt=""
                      className="h-8 w-8 rounded object-cover"
                    />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded bg-surface-lighter">
                      <CategoryIcon category={file.category} />
                    </div>
                  )}
                </td>
                <td className="max-w-[200px] truncate px-3 py-2 font-medium text-gray-200">
                  {file.name || `${file.id.slice(0, 8)}.${file.extension}`}
                </td>
                <td className="px-3 py-2 uppercase text-gray-400">
                  {file.extension}
                </td>
                <td className="px-3 py-2 tabular-nums text-gray-400">
                  {formatBytes(file.size)}
                  {file.sizeEstimated && (
                    <span className="ml-1 text-[10px] text-gray-600">
                      ~est
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <RecoverabilityBadge status={file.recoverability} />
                </td>
              </tr>
            )
          })}

          {sorted.length === 0 && (
            <tr>
              <td
                colSpan={6}
                className="px-3 py-8 text-center text-gray-500"
              >
                No files found
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
