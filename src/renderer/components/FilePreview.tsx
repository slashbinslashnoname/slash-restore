import { useState, useEffect } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { Image, Binary, Info } from 'lucide-react'
import { useAppStore } from '../store'
import type { SerializedRecoverableFile } from '../store'

function formatBytes(sizeStr: string): string {
  const bytes = Number(sizeStr)
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function HexViewer({ file }: { file: SerializedRecoverableFile }) {
  const [hexData, setHexData] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setHexData(null)

    window.api.preview
      .hex(file.offset, 256)
      .then((data) => {
        if (!cancelled) setHexData(data)
      })
      .catch(() => {
        if (!cancelled) setHexData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [file.id, file.offset])

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-gray-500">
        Loading hex data...
      </div>
    )
  }

  if (!hexData) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-gray-500">
        Unable to load hex data
      </div>
    )
  }

  return (
    <pre className="max-h-64 overflow-auto rounded bg-surface p-3 font-mono text-[11px] leading-relaxed text-gray-300">
      {hexData}
    </pre>
  )
}

function ImagePreview({ file }: { file: SerializedRecoverableFile }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (file.thumbnail) {
      setPreview(file.thumbnail)
      return
    }

    let cancelled = false
    setLoading(true)

    window.api.preview
      .generate(file.id, file.offset, file.size)
      .then((data) => {
        if (!cancelled) setPreview(data)
      })
      .catch(() => {
        if (!cancelled) setPreview(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [file.id, file.offset, file.size, file.thumbnail])

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-gray-500">
        Generating preview...
      </div>
    )
  }

  if (!preview) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-gray-500">
        No preview available
      </div>
    )
  }

  return (
    <div className="flex justify-center rounded bg-surface p-4">
      <img
        src={preview}
        alt="Preview"
        className="max-h-64 max-w-full rounded object-contain"
      />
    </div>
  )
}

export default function FilePreview() {
  const previewFileId = useAppStore((s) => s.previewFileId)
  const foundFiles = useAppStore((s) => s.foundFiles)
  const setPreviewFileId = useAppStore((s) => s.setPreviewFileId)

  const file = foundFiles.find((f) => f.id === previewFileId)

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-gray-500">
        Select a file to preview
      </div>
    )
  }

  const isImage = file.category === 'photo'
  const defaultTab = isImage ? 'preview' : 'hex'

  return (
    <div className="flex h-full flex-col p-4">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h3 className="truncate text-sm font-semibold text-white">
          {file.name || `${file.id.slice(0, 8)}.${file.extension}`}
        </h3>
        <button
          onClick={() => setPreviewFileId(null)}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          Close
        </button>
      </div>

      <Tabs.Root defaultValue={defaultTab} className="flex flex-1 flex-col">
        <Tabs.List className="mb-3 flex gap-1 rounded-lg bg-surface p-1">
          {isImage && (
            <Tabs.Trigger
              value="preview"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-gray-400 transition-colors data-[state=active]:bg-surface-lighter data-[state=active]:text-white"
            >
              <Image className="h-3.5 w-3.5" />
              Preview
            </Tabs.Trigger>
          )}
          <Tabs.Trigger
            value="hex"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-gray-400 transition-colors data-[state=active]:bg-surface-lighter data-[state=active]:text-white"
          >
            <Binary className="h-3.5 w-3.5" />
            Hex
          </Tabs.Trigger>
          <Tabs.Trigger
            value="info"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-gray-400 transition-colors data-[state=active]:bg-surface-lighter data-[state=active]:text-white"
          >
            <Info className="h-3.5 w-3.5" />
            Info
          </Tabs.Trigger>
        </Tabs.List>

        {isImage && (
          <Tabs.Content value="preview" className="flex-1 overflow-auto">
            <ImagePreview file={file} />
          </Tabs.Content>
        )}

        <Tabs.Content value="hex" className="flex-1 overflow-auto">
          <HexViewer file={file} />
        </Tabs.Content>

        <Tabs.Content value="info" className="flex-1 overflow-auto">
          <div className="space-y-2 text-xs">
            <InfoRow label="Type" value={file.extension.toUpperCase()} />
            <InfoRow label="Category" value={file.category} />
            <InfoRow label="Size" value={formatBytes(file.size)} />
            <InfoRow
              label="Estimated"
              value={file.sizeEstimated ? 'Yes' : 'No'}
            />
            <InfoRow label="Offset" value={file.offset} />
            <InfoRow label="Source" value={file.source} />
            <InfoRow label="Recoverability" value={file.recoverability} />
            {file.fragments && (
              <InfoRow
                label="Fragments"
                value={String(file.fragments.length)}
              />
            )}
            {file.metadata?.width && file.metadata?.height && (
              <InfoRow
                label="Dimensions"
                value={`${file.metadata.width} x ${file.metadata.height}`}
              />
            )}
            {file.metadata?.duration && (
              <InfoRow
                label="Duration"
                value={`${file.metadata.duration}s`}
              />
            )}
            {file.metadata?.cameraModel && (
              <InfoRow label="Camera" value={file.metadata.cameraModel} />
            )}
            {file.metadata?.originalName && (
              <InfoRow
                label="Original Name"
                value={file.metadata.originalName}
              />
            )}
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded bg-surface px-3 py-2">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-300">{value}</span>
    </div>
  )
}
