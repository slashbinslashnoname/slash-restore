import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronRight,
  Grid3X3,
  List,
  Filter,
  CheckSquare,
  Square,
  Image,
  Film,
  FileText
} from 'lucide-react'
import { useAppStore } from '../store'
import type { SerializedRecoverableFile } from '../store'
import type { FileCategory } from '../../shared/types'
import FileTable from '../components/FileTable'
import FilePreview from '../components/FilePreview'

function formatBytes(sizeStr: string): string {
  const bytes = Number(sizeStr)
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

type ViewMode = 'table' | 'grid'

const categoryIcons: Record<FileCategory, typeof Image> = {
  photo: Image,
  video: Film,
  document: FileText
}

export default function FileSelectionPage() {
  const navigate = useNavigate()
  const foundFiles = useAppStore((s) => s.foundFiles)
  const selectedFileIds = useAppStore((s) => s.selectedFileIds)
  const selectAllFiles = useAppStore((s) => s.selectAllFiles)
  const deselectAllFiles = useAppStore((s) => s.deselectAllFiles)
  const toggleFileSelection = useAppStore((s) => s.toggleFileSelection)
  const setPreviewFileId = useAppStore((s) => s.setPreviewFileId)
  const previewFileId = useAppStore((s) => s.previewFileId)
  const setCurrentStep = useAppStore((s) => s.setCurrentStep)

  const [viewMode, setViewMode] = useState<ViewMode>('table')
  const [categoryFilter, setCategoryFilter] = useState<FileCategory | 'all'>(
    'all'
  )
  const [recoverabilityFilter, setRecoverabilityFilter] = useState<
    'all' | 'good' | 'partial' | 'poor'
  >('all')

  useEffect(() => {
    setCurrentStep(4)
  }, [setCurrentStep])

  const filteredFiles = useMemo(() => {
    let result = foundFiles
    if (categoryFilter !== 'all') {
      result = result.filter((f) => f.category === categoryFilter)
    }
    if (recoverabilityFilter !== 'all') {
      result = result.filter(
        (f) => f.recoverability === recoverabilityFilter
      )
    }
    return result
  }, [foundFiles, categoryFilter, recoverabilityFilter])

  // Summary of selection
  const selectedCount = selectedFileIds.size
  const totalSelectedSize = useMemo(() => {
    let total = 0
    for (const file of foundFiles) {
      if (selectedFileIds.has(file.id)) {
        total += Number(file.size)
      }
    }
    return total
  }, [foundFiles, selectedFileIds])

  const handleFileClick = (fileId: string) => {
    setPreviewFileId(fileId)
  }

  const handleRecover = () => {
    if (selectedCount === 0) return
    navigate('/recovery')
  }

  const allFilteredSelected =
    filteredFiles.length > 0 &&
    filteredFiles.every((f) => selectedFileIds.has(f.id))

  const handleToggleAll = () => {
    if (allFilteredSelected) {
      deselectAllFiles()
    } else {
      selectAllFiles()
    }
  }

  return (
    <div className="flex h-full">
      {/* Main area */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="px-6 py-4">
          {/* Header */}
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-white">Select Files</h2>
              <p className="mt-1 text-sm text-gray-400">
                {foundFiles.length} file{foundFiles.length !== 1 ? 's' : ''}{' '}
                found
              </p>
            </div>
            <div className="flex items-center gap-2">
              {/* View mode toggle */}
              <div className="flex rounded-lg bg-surface-light p-1">
                <button
                  onClick={() => setViewMode('table')}
                  className={`rounded-md p-1.5 ${
                    viewMode === 'table'
                      ? 'bg-surface-lighter text-white'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  <List className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setViewMode('grid')}
                  className={`rounded-md p-1.5 ${
                    viewMode === 'grid'
                      ? 'bg-surface-lighter text-white'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  <Grid3X3 className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Filters */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Filter className="h-4 w-4 text-gray-500" />

            {/* Category filters */}
            <FilterPill
              label="All"
              active={categoryFilter === 'all'}
              onClick={() => setCategoryFilter('all')}
            />
            {(['photo', 'video', 'document'] as FileCategory[]).map(
              (cat) => {
                const Icon = categoryIcons[cat]
                const count = foundFiles.filter(
                  (f) => f.category === cat
                ).length
                return (
                  <FilterPill
                    key={cat}
                    label={`${cat.charAt(0).toUpperCase() + cat.slice(1)} (${count})`}
                    active={categoryFilter === cat}
                    onClick={() => setCategoryFilter(cat)}
                    icon={<Icon className="h-3 w-3" />}
                  />
                )
              }
            )}

            <span className="mx-1 text-surface-lighter">|</span>

            {/* Recoverability filters */}
            {(
              ['all', 'good', 'partial', 'poor'] as const
            ).map((status) => {
              const colors = {
                all: '',
                good: 'text-green-400',
                partial: 'text-yellow-400',
                poor: 'text-red-400'
              }
              return (
                <FilterPill
                  key={status}
                  label={
                    status === 'all'
                      ? 'Any status'
                      : status.charAt(0).toUpperCase() + status.slice(1)
                  }
                  active={recoverabilityFilter === status}
                  onClick={() => setRecoverabilityFilter(status)}
                  className={colors[status]}
                />
              )
            })}
          </div>

          {/* Bulk actions */}
          <div className="mb-4 flex items-center gap-3">
            <button
              onClick={handleToggleAll}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200"
            >
              {allFilteredSelected ? (
                <CheckSquare className="h-3.5 w-3.5" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              {allFilteredSelected ? 'Deselect All' : 'Select All'}
            </button>

            {selectedCount > 0 && (
              <span className="text-xs text-gray-500">
                {selectedCount} selected ({formatBytes(String(totalSelectedSize))}
                )
              </span>
            )}
          </div>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-auto px-6 pb-4">
          {viewMode === 'table' ? (
            <FileTable
              files={filteredFiles}
              onFileClick={handleFileClick}
            />
          ) : (
            <GridView
              files={filteredFiles}
              selectedFileIds={selectedFileIds}
              toggleFileSelection={toggleFileSelection}
              onFileClick={handleFileClick}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-surface-lighter px-6 py-4">
          <button
            onClick={() => navigate('/scanning')}
            className="flex items-center gap-2 rounded-lg bg-surface-light px-4 py-2.5 text-sm text-gray-300 transition-colors hover:bg-surface-lighter"
          >
            <ChevronLeft className="h-4 w-4" />
            Back
          </button>

          <button
            onClick={handleRecover}
            disabled={selectedCount === 0}
            className="flex items-center gap-2 rounded-lg bg-primary-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Recover Selected ({selectedCount})
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Preview panel */}
      {previewFileId && (
        <div className="w-80 shrink-0 border-l border-surface-lighter bg-surface-light">
          <FilePreview />
        </div>
      )}
    </div>
  )
}

// ─── Internal components ────────────────────────────────────

function FilterPill({
  label,
  active,
  onClick,
  icon,
  className = ''
}: {
  label: string
  active: boolean
  onClick: () => void
  icon?: React.ReactNode
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs transition-colors ${
        active
          ? 'bg-primary-500/20 text-primary-300'
          : 'bg-surface-light text-gray-400 hover:bg-surface-lighter hover:text-gray-300'
      } ${className}`}
    >
      {icon}
      {label}
    </button>
  )
}

function GridView({
  files,
  selectedFileIds,
  toggleFileSelection,
  onFileClick
}: {
  files: SerializedRecoverableFile[]
  selectedFileIds: Set<string>
  toggleFileSelection: (id: string) => void
  onFileClick: (id: string) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
      {files.map((file) => {
        const isSelected = selectedFileIds.has(file.id)
        return (
          <div
            key={file.id}
            onClick={() => onFileClick(file.id)}
            className={`group relative cursor-pointer overflow-hidden rounded-lg border transition-all ${
              isSelected
                ? 'border-primary-500 bg-primary-500/10'
                : 'border-surface-lighter bg-surface-light hover:border-gray-600'
            }`}
          >
            {/* Thumbnail */}
            <div className="aspect-square overflow-hidden bg-surface">
              {file.thumbnail ? (
                <img
                  src={file.thumbnail}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-gray-600">
                  {file.category === 'photo' && (
                    <Image className="h-8 w-8" />
                  )}
                  {file.category === 'video' && (
                    <Film className="h-8 w-8" />
                  )}
                  {file.category === 'document' && (
                    <FileText className="h-8 w-8" />
                  )}
                </div>
              )}
            </div>

            {/* Checkbox overlay */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleFileSelection(file.id)
              }}
              className={`absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded border transition-all ${
                isSelected
                  ? 'border-primary-500 bg-primary-500'
                  : 'border-gray-500 bg-surface/80 opacity-0 group-hover:opacity-100'
              }`}
            >
              {isSelected && (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                >
                  <path
                    d="M1.5 5L4 7.5L8.5 2.5"
                    stroke="white"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>

            {/* Recoverability dot */}
            <div
              className={`absolute right-1.5 top-1.5 h-2 w-2 rounded-full ${
                file.recoverability === 'good'
                  ? 'bg-green-400'
                  : file.recoverability === 'partial'
                    ? 'bg-yellow-400'
                    : 'bg-red-400'
              }`}
            />

            {/* Name */}
            <div className="px-2 py-1.5">
              <p className="truncate text-[11px] text-gray-300">
                {file.name ||
                  `${file.id.slice(0, 6)}.${file.extension}`}
              </p>
              <p className="text-[10px] text-gray-600">
                {formatBytes(file.size)}
              </p>
            </div>
          </div>
        )
      })}

      {files.length === 0 && (
        <div className="col-span-full py-16 text-center text-sm text-gray-500">
          No files match current filters
        </div>
      )}
    </div>
  )
}
