import { create } from 'zustand'
import type {
  FileCategory,
  FileType,
  PrivilegeStatus,
  RecoveryError,
  RecoveryStatus,
  ScanStatus,
  ScanType
} from '../../shared/types'

// ─── Renderer-side types (bigint fields as strings) ─────────

/** DeviceInfo with bigint fields serialized as strings across IPC */
export interface SerializedDeviceInfo {
  id: string
  name: string
  path: string
  size: string
  type: 'sd' | 'hdd' | 'ssd' | 'usb' | 'unknown'
  model: string
  removable: boolean
  readOnly: boolean
  mountPoints: { path: string; filesystem: string }[]
  filesystem?: string
  partitions: SerializedPartitionInfo[]
}

export interface SerializedPartitionInfo {
  id: string
  path: string
  label: string
  size: string
  offset: string
  filesystem?: string
  mountPoint?: string
}

export interface SerializedRecoverableFile {
  id: string
  type: FileType
  category: FileCategory
  offset: string
  size: string
  sizeEstimated: boolean
  name?: string
  extension: string
  thumbnail?: string
  metadata?: {
    width?: number
    height?: number
    duration?: number
    createdAt?: string
    modifiedAt?: string
    cameraModel?: string
    originalName?: string
  }
  recoverability: 'good' | 'partial' | 'poor'
  source: 'carving' | 'metadata'
  fragments?: { offset: string; size: string }[]
}

export interface SerializedScanProgress {
  bytesScanned: string
  totalBytes: string
  percentage: number
  filesFound: number
  currentSector: string
  estimatedTimeRemaining?: number
  sectorsWithErrors: number
}

export interface SerializedRecoveryProgress {
  totalFiles: number
  completedFiles: number
  currentFile?: string
  bytesWritten: string
  totalBytes: string
  percentage: number
  errors: RecoveryError[]
}

// ─── Store state ─────────────────────────────────────────────

interface DeviceSlice {
  devices: SerializedDeviceInfo[]
  selectedDevice: SerializedDeviceInfo | null
  devicesLoading: boolean
}

interface ScanSlice {
  scanType: ScanType
  fileCategories: FileCategory[]
  selectedPartition: SerializedPartitionInfo | null
  scanStatus: ScanStatus
  scanProgress: SerializedScanProgress | null
  foundFiles: SerializedRecoverableFile[]
  scanSessionId: string | null
  scanStartedAt: number | null
  scanError: string | null
}

interface RecoverySlice {
  destinationPath: string
  conflictStrategy: 'rename' | 'overwrite' | 'skip'
  preserveStructure: boolean
  recoveryStatus: RecoveryStatus
  recoveryProgress: SerializedRecoveryProgress | null
  recoveryErrors: RecoveryError[]
}

interface PrivilegeSlice {
  privilege: PrivilegeStatus | null
}

interface UiSlice {
  currentStep: number
  errors: string[]
  selectedFileIds: Set<string>
  previewFileId: string | null
}

export interface AppState
  extends DeviceSlice,
    ScanSlice,
    RecoverySlice,
    PrivilegeSlice,
    UiSlice {
  // Device actions
  setDevices: (devices: SerializedDeviceInfo[]) => void
  setDevicesLoading: (loading: boolean) => void
  selectDevice: (device: SerializedDeviceInfo | null) => void

  // Scan config actions
  setScanType: (type: ScanType) => void
  setFileCategories: (categories: FileCategory[]) => void
  toggleFileCategory: (category: FileCategory) => void
  setSelectedPartition: (partition: SerializedPartitionInfo | null) => void

  // Scan lifecycle actions
  setScanStatus: (status: ScanStatus) => void
  updateScanProgress: (progress: SerializedScanProgress) => void
  addFoundFiles: (files: SerializedRecoverableFile[]) => void
  setScanSessionId: (id: string) => void
  setScanStartedAt: (ts: number) => void
  setScanError: (error: string | null) => void
  resetScan: () => void

  // Recovery actions
  setDestinationPath: (path: string) => void
  setConflictStrategy: (strategy: 'rename' | 'overwrite' | 'skip') => void
  setPreserveStructure: (preserve: boolean) => void
  setRecoveryStatus: (status: RecoveryStatus) => void
  updateRecoveryProgress: (progress: SerializedRecoveryProgress) => void
  addRecoveryError: (error: RecoveryError) => void
  resetRecovery: () => void

  // Privilege actions
  setPrivilege: (status: PrivilegeStatus) => void

  // UI actions
  setCurrentStep: (step: number) => void
  addError: (error: string) => void
  clearErrors: () => void
  dismissError: (index: number) => void
  toggleFileSelection: (fileId: string) => void
  selectAllFiles: () => void
  deselectAllFiles: () => void
  setPreviewFileId: (id: string | null) => void
}

const initialScanState: ScanSlice = {
  scanType: 'quick',
  fileCategories: ['photo', 'video', 'document'],
  selectedPartition: null,
  scanStatus: 'idle',
  scanProgress: null,
  foundFiles: [],
  scanSessionId: null,
  scanStartedAt: null,
  scanError: null
}

const initialRecoveryState: RecoverySlice = {
  destinationPath: '',
  conflictStrategy: 'rename',
  preserveStructure: false,
  recoveryStatus: 'idle',
  recoveryProgress: null,
  recoveryErrors: []
}

export const useAppStore = create<AppState>((set, get) => ({
  // ─── Initial state ───────────────────────────────────────
  devices: [],
  selectedDevice: null,
  devicesLoading: false,

  ...initialScanState,

  ...initialRecoveryState,

  privilege: null,

  currentStep: 1,
  errors: [],
  selectedFileIds: new Set(),
  previewFileId: null,

  // ─── Device actions ──────────────────────────────────────
  setDevices: (devices) => set({ devices }),
  setDevicesLoading: (loading) => set({ devicesLoading: loading }),
  selectDevice: (device) => set({ selectedDevice: device }),

  // ─── Scan config actions ─────────────────────────────────
  setScanType: (scanType) => set({ scanType }),
  setFileCategories: (fileCategories) => set({ fileCategories }),
  toggleFileCategory: (category) => {
    const current = get().fileCategories
    if (current.includes(category)) {
      set({ fileCategories: current.filter((c) => c !== category) })
    } else {
      set({ fileCategories: [...current, category] })
    }
  },
  setSelectedPartition: (partition) => set({ selectedPartition: partition }),

  // ─── Scan lifecycle actions ──────────────────────────────
  setScanStatus: (scanStatus) => set({ scanStatus }),
  updateScanProgress: (scanProgress) => set({ scanProgress }),
  addFoundFiles: (files) =>
    set((state) => ({ foundFiles: [...state.foundFiles, ...files] })),
  setScanSessionId: (scanSessionId) => set({ scanSessionId }),
  setScanStartedAt: (scanStartedAt) => set({ scanStartedAt }),
  setScanError: (scanError) => set({ scanError }),
  resetScan: () =>
    set({
      ...initialScanState,
      selectedFileIds: new Set(),
      previewFileId: null
    }),

  // ─── Recovery actions ────────────────────────────────────
  setDestinationPath: (destinationPath) => set({ destinationPath }),
  setConflictStrategy: (conflictStrategy) => set({ conflictStrategy }),
  setPreserveStructure: (preserveStructure) => set({ preserveStructure }),
  setRecoveryStatus: (recoveryStatus) => set({ recoveryStatus }),
  updateRecoveryProgress: (recoveryProgress) => set({ recoveryProgress }),
  addRecoveryError: (error) =>
    set((state) => ({
      recoveryErrors: [...state.recoveryErrors, error]
    })),
  resetRecovery: () => set(initialRecoveryState),

  // ─── Privilege actions ───────────────────────────────────
  setPrivilege: (privilege) => set({ privilege }),

  // ─── UI actions ──────────────────────────────────────────
  setCurrentStep: (currentStep) => set({ currentStep }),
  addError: (error) =>
    set((state) => ({ errors: [...state.errors, error] })),
  clearErrors: () => set({ errors: [] }),
  dismissError: (index) =>
    set((state) => ({
      errors: state.errors.filter((_, i) => i !== index)
    })),
  toggleFileSelection: (fileId) =>
    set((state) => {
      const next = new Set(state.selectedFileIds)
      if (next.has(fileId)) {
        next.delete(fileId)
      } else {
        next.add(fileId)
      }
      return { selectedFileIds: next }
    }),
  selectAllFiles: () =>
    set((state) => ({
      selectedFileIds: new Set(state.foundFiles.map((f) => f.id))
    })),
  deselectAllFiles: () => set({ selectedFileIds: new Set() }),
  setPreviewFileId: (previewFileId) => set({ previewFileId })
}))
