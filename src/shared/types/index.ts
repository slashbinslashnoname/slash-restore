// ─── Device Types ─────────────────────────────────────────────

export interface DeviceInfo {
  id: string
  name: string
  path: string
  size: bigint
  type: 'sd' | 'hdd' | 'ssd' | 'usb' | 'unknown'
  model: string
  removable: boolean
  readOnly: boolean
  mountPoints: MountPoint[]
  filesystem?: FilesystemType
  partitions: PartitionInfo[]
}

export interface PartitionInfo {
  id: string
  path: string
  label: string
  size: bigint
  offset: bigint
  filesystem?: FilesystemType
  mountPoint?: string
}

export interface MountPoint {
  path: string
  filesystem: string
}

export type FilesystemType = 'fat32' | 'exfat' | 'ntfs' | 'ext4' | 'hfs+' | 'apfs' | 'unknown'

// ─── Scan Types ───────────────────────────────────────────────

export type ScanType = 'quick' | 'deep'

export type FileCategory = 'photo' | 'video' | 'document' | 'audio' | 'archive' | 'database'

export interface ScanConfig {
  devicePath: string
  partitionPath?: string
  scanType: ScanType
  fileCategories: FileCategory[]
  /** When provided, only these specific file types are scanned (overrides fileCategories). */
  fileTypes?: FileType[]
  /** Known device/partition size in bytes. */
  deviceSize?: bigint
  startOffset?: bigint
  endOffset?: bigint
}

export interface ScanSession {
  id: string
  config: ScanConfig
  status: ScanStatus
  progress: ScanProgress
  foundFiles: RecoverableFile[]
  startedAt: number
  completedAt?: number
  error?: string
}

export type ScanStatus = 'idle' | 'scanning' | 'paused' | 'completed' | 'cancelled' | 'error'

export interface ScanProgress {
  bytesScanned: bigint
  totalBytes: bigint
  percentage: number
  filesFound: number
  currentSector: bigint
  estimatedTimeRemaining?: number
  sectorsWithErrors: number
}

// ─── File Types ───────────────────────────────────────────────

export type FileType =
  | 'jpeg' | 'png' | 'heic' | 'cr2' | 'nef' | 'arw' | 'gif' | 'webp' | 'psd'
  | 'mp4' | 'mov' | 'avi' | 'mkv' | 'flv' | 'wmv'
  | 'pdf' | 'docx' | 'xlsx' | 'rtf' | 'pptx'
  | 'mp3' | 'wav' | 'flac' | 'ogg' | 'm4a'
  | 'zip' | 'rar' | '7z' | 'gz' | 'bz2' | 'xz' | 'tar'
  | 'sqlite' | 'bdb'

/** All known file types. Defined here (not in file-signatures.ts) so the
 *  renderer can import it without pulling in Node's Buffer. */
export const ALL_FILE_TYPES: FileType[] = [
  'jpeg', 'png', 'heic', 'cr2', 'nef', 'arw', 'gif', 'webp', 'psd',
  'mp4', 'mov', 'avi', 'mkv', 'flv', 'wmv',
  'pdf', 'docx', 'xlsx', 'rtf', 'pptx',
  'mp3', 'wav', 'flac', 'ogg', 'm4a',
  'zip', 'rar', '7z', 'gz', 'bz2', 'xz', 'tar',
  'sqlite', 'bdb'
]

/** All known file categories */
export const ALL_FILE_CATEGORIES: FileCategory[] = [
  'photo', 'video', 'document', 'audio', 'archive', 'database'
]

export interface RecoverableFile {
  id: string
  type: FileType
  category: FileCategory
  offset: bigint
  size: bigint
  sizeEstimated: boolean
  name?: string
  extension: string
  thumbnail?: string // base64 data URI
  metadata?: FileMetadata
  recoverability: 'good' | 'partial' | 'poor'
  source: 'carving' | 'metadata'
  fragments?: FileFragment[]
}

export interface FileFragment {
  offset: bigint
  size: bigint
}

export interface FileMetadata {
  width?: number
  height?: number
  duration?: number
  createdAt?: Date
  modifiedAt?: Date
  cameraModel?: string
  originalName?: string
}

// ─── Recovery Types ───────────────────────────────────────────

export interface RecoveryConfig {
  files: RecoverableFile[]
  destinationPath: string
  conflictStrategy: 'rename' | 'overwrite' | 'skip'
  preserveStructure: boolean
  sourceDevicePath: string
}

export interface RecoveryProgress {
  totalFiles: number
  completedFiles: number
  currentFile?: string
  bytesWritten: bigint
  totalBytes: bigint
  percentage: number
  errors: RecoveryError[]
}

export interface RecoveryError {
  fileId: string
  fileName: string
  error: string
}

export type RecoveryStatus = 'idle' | 'recovering' | 'paused' | 'completed' | 'cancelled' | 'error'

// ─── Privilege Types ──────────────────────────────────────────

export interface PrivilegeStatus {
  elevated: boolean
  platform: 'linux' | 'darwin' | 'win32'
  helperPid?: number
}

// ─── IPC Channel Names ───────────────────────────────────────

export const IpcChannels = {
  // Device
  DEVICE_LIST: 'device:list',
  DEVICE_REFRESH: 'device:refresh',

  // Scan
  SCAN_START: 'scan:start',
  SCAN_PAUSE: 'scan:pause',
  SCAN_RESUME: 'scan:resume',
  SCAN_CANCEL: 'scan:cancel',
  SCAN_PROGRESS: 'scan:progress',
  SCAN_FILE_FOUND: 'scan:file-found',
  SCAN_COMPLETE: 'scan:complete',
  SCAN_ERROR: 'scan:error',

  // Recovery
  RECOVERY_START: 'recovery:start',
  RECOVERY_PAUSE: 'recovery:pause',
  RECOVERY_RESUME: 'recovery:resume',
  RECOVERY_CANCEL: 'recovery:cancel',
  RECOVERY_PROGRESS: 'recovery:progress',
  RECOVERY_COMPLETE: 'recovery:complete',
  RECOVERY_ERROR: 'recovery:error',

  // Privilege
  PRIVILEGE_CHECK: 'privilege:check',
  PRIVILEGE_REQUEST: 'privilege:request',
  PRIVILEGE_STATUS: 'privilege:status',

  // Preview
  PREVIEW_GENERATE: 'preview:generate',
  PREVIEW_HEX: 'preview:hex',

  // Dialog
  DIALOG_SELECT_DIRECTORY: 'dialog:select-directory',
  DIALOG_DEFAULT_RECOVERY_PATH: 'dialog:default-recovery-path'
} as const

// ─── IPC Payload Types ────────────────────────────────────────

export interface IpcPayloads {
  [IpcChannels.DEVICE_LIST]: { devices: DeviceInfo[] }
  [IpcChannels.SCAN_START]: ScanConfig
  [IpcChannels.SCAN_PROGRESS]: ScanProgress
  [IpcChannels.SCAN_FILE_FOUND]: RecoverableFile
  [IpcChannels.SCAN_COMPLETE]: { sessionId: string; filesFound: number }
  [IpcChannels.RECOVERY_START]: RecoveryConfig
  [IpcChannels.RECOVERY_PROGRESS]: RecoveryProgress
  [IpcChannels.PRIVILEGE_STATUS]: PrivilegeStatus
  [IpcChannels.PREVIEW_GENERATE]: { fileId: string; offset: bigint; size: bigint }
  [IpcChannels.PREVIEW_HEX]: { offset: bigint; length: number }
}
