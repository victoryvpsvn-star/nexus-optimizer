// Kiểu dữ liệu dùng chung giữa client và server (NEXUS OPTIMIZER)

export interface CpuInfo {
  usage: number
  cores: number
  model: string
  loadavg: [number, number, number]
}

export interface MemInfo {
  totalMB: number
  usedMB: number
  availableMB: number
  cachedMB: number
  usagePct: number
  swapTotalMB: number
  swapUsedMB: number
}

export interface DiskInfo {
  mount: string
  totalGB: number
  usedGB: number
  freeGB: number
  usagePct: number
}

export interface NetInfo {
  rxKBs: number
  txKBs: number
  rxTotalMB: number
  txTotalMB: number
}

export interface StatsSnapshot {
  cpu: CpuInfo
  mem: MemInfo
  disks: DiskInfo[]
  net: NetInfo
  uptimeSec: number
  hostname: string
  platform: string
  processCount: number
  timestamp: number
}

export type CleanupKind = 'disk' | 'ram'

export interface CleanupTargetInfo {
  id: string
  name: string
  path?: string
  sizeBytes: number
  canClean: boolean
  note?: string
}

export interface CleanupResult {
  id: string
  name: string
  kind: CleanupKind
  freedBytes: number
  success: boolean
  message: string
}

export interface CleanupLogEntry {
  id: number
  kind: string
  target: string
  freedBytes: number
  success: boolean
  message?: string
  createdAt: string
}

export interface CleanupScanResponse {
  targets: CleanupTargetInfo[]
  logs: CleanupLogEntry[]
  ramNote: string
}

export interface CleanupRunResponse {
  results: CleanupResult[]
  totalFreedDisk: number
  totalFreedRam: number
}

export type RiskLevel = 'low' | 'medium' | 'high'

export interface Tweak {
  id: string
  name: string
  description: string
  category: string
  risk: RiskLevel
  requiresRoot: boolean
  recommended: boolean
  order: number
  applied: boolean
  appliedAt?: string
  lastResult?: string
}

export interface TweakRunResult {
  id: string
  success: boolean
  message: string
}

export interface GamingEffect {
  id: string
  name: string
  success: boolean
  message: string
}

export interface GamingStatus {
  enabled: boolean
  enabledAt?: string
  effects: GamingEffect[]
  note: string
}

export interface ProcessInfo {
  pid: number
  user: string
  name: string
  cpuPct: number
  memPct: number
  rssMB: number
}

export interface BackupLocal {
  id: number
  name: string
  sizeBytes: number
  uploaded: boolean
  s3Key?: string
  createdAt: string
}

export interface BackupBucketItem {
  key: string
  sizeBytes: number
  lastModified: string
}

export interface BackupListResponse {
  local: BackupLocal[]
  bucket: BackupBucketItem[]
  bucketOk: boolean
  bucketName?: string
  bucketError?: string
}

export type AccentKey =
  | 'sakura-pink'
  | 'sakura-lavender'
  | 'cyan-violet'
  | 'emerald-amber'
  | 'rose-magenta'
  | 'amber-crimson'
export type BackgroundKey =
  | 'sakura'
  | 'wall-sakura'
  | 'gradient'
  | 'glow'
  | 'mesh'
  | 'wall-default'
  | 'wall-gaming'
  | 'custom'

export interface UISettings {
  accent: AccentKey
  background: BackgroundKey
  customBgUrl: string
  radius: number // đơn vị rem
  /** Hiệu ứng cánh hoa sakura rơi trên nền sáng */
  petals: boolean
}

export interface ScreenshotInfo {
  file: string
  url: string
  createdAt: string
  sizeBytes: number
}

// ---------- Script nâng cao (Advanced) ----------

export type ScriptLanguage = 'bash' | 'python' | 'powershell'

export interface ScriptRecord {
  id: number
  name: string
  language: ScriptLanguage
  code?: string
  updatedAt: string
}

export interface ScriptRunResponse {
  success: boolean
  exitCode: number
  durationMs: number
  output: string
  timedOut?: boolean
  message?: string
}

export interface ConfigExport {
  app: 'nexus-optimizer'
  type: 'config'
  version: 1
  exportedAt: string
  settings: UISettings
  gaming: boolean
  appliedTweakIds: string[]
}

export const SECTIONS = [
  'overview',
  'cleanup',
  'gaming',
  'tweaks',
  'script',
  'processes',
  'backup',
  'screenshot',
  'settings',
] as const

export type Section = (typeof SECTIONS)[number]

export const SECTION_META: Record<Section, { title: string; subtitle: string }> = {
  overview: { title: 'Tổng quan', subtitle: 'Giám sát CPU, RAM, Disk realtime' },
  cleanup: { title: 'Dọn dẹp', subtitle: 'Giải phóng RAM + Disk chỉ với một cú nhấp' },
  gaming: { title: 'Gaming Mode', subtitle: 'Tăng hiệu năng tối đa khi chơi game' },
  tweaks: { title: 'Tinh chỉnh', subtitle: 'Danh sách tối ưu xếp hạng theo độ ưu tiên' },
  script: {
    title: 'Script nâng cao',
    subtitle: 'Tự viết và chạy script tùy chỉnh — dành cho người biết code (Advanced)',
  },
  processes: { title: 'Tiến trình', subtitle: 'Quản lý tiến trình đang chạy' },
  backup: { title: 'Sao lưu', subtitle: 'Tạo file backup, lưu lên bucket 30GB' },
  screenshot: { title: 'Ảnh chụp', subtitle: 'Chụp & sửa lỗi chụp màn hình dashboard' },
  settings: { title: 'Cài đặt', subtitle: 'Tùy chỉnh nền, màu nhấn, bo góc' },
}
