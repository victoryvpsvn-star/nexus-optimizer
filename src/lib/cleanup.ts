// Logic dọn dẹp Disk + RAM cho NEXUS OPTIMIZER (chỉ chạy phía máy chủ)
// Hỗ trợ cả Linux (dev sandbox) và Windows (Electron build) — chọn nhánh theo isWin
import { readFile } from 'fs/promises'
import path from 'path'
import os from 'os'
import { run, tryRoot, psRun, isWin, isAdminWin } from '@/lib/exec'
import { db } from '@/lib/db'
import { formatBytes } from '@/lib/format'
import type { CleanupResult, CleanupTargetInfo } from '@/lib/types'

const HOME = '/home/z'
const SHOTS_DIR = path.join(process.cwd(), 'public', 'screenshots')
const INT32_MAX = 2147483647

export const RAM_NOTE = isWin
  ? 'Dọn RAM dùng EmptyWorkingSet API cho các tiến trình nặng — không cần quyền Admin, hệ điều hành tự quản lý trang bộ nhớ sau đó.'
  : 'Dọn RAM hạt nhân cần sudo; đã dùng sync + đo MemAvailable. Trên VPS không có sudo, phần lớn bộ nhớ đệm được giải phóng khi các tiến trình thoát.'

interface TargetDef {
  id: string
  name: string
  pathLabel: string
  note?: string
  paths?: string[] // đo + clean trực tiếp các thư mục này
  special?: 'tmp' | 'recyclebin' | 'deliveryopt' | 'browser-cache'
  admin?: boolean // (Windows) cần quyền Administrator mới được dọn
  filePattern?: string // (Windows) chỉ đo/xóa file khớp regex này theo Name
}

// Danh sách mục tiêu dọn disk (tmp-old-mount trùng với tmp-files nên đã gộp lại)
const TARGETS: TargetDef[] = [
  {
    id: 'npm-cache',
    name: 'Bộ nhớ đệm npm',
    paths: [`${HOME}/.npm/_cacache`, `${HOME}/.npm/_logs`],
    pathLabel: '~/.npm/_cacache · ~/.npm/_logs',
    note: 'Cache gói npm (cấp người dùng)',
  },
  {
    id: 'pip-cache',
    name: 'Bộ nhớ đệm pip',
    paths: [`${HOME}/.cache/pip`],
    pathLabel: '~/.cache/pip',
    note: 'Cache gói Python pip (cấp người dùng)',
  },
  {
    id: 'bun-cache',
    name: 'Bộ nhớ đệm Bun',
    paths: [`${HOME}/.bun/install/cache`],
    pathLabel: '~/.bun/install/cache',
    note: 'Cache cài đặt gói Bun (cấp người dùng)',
  },
  {
    id: 'thumbnails',
    name: 'Ảnh thu nhỏ (thumbnails)',
    paths: [`${HOME}/.cache/thumbnails`],
    pathLabel: '~/.cache/thumbnails',
    note: 'Thumbnail do ứng dụng tạo ra (cấp người dùng)',
  },
  {
    id: 'tmp-files',
    name: 'Tệp rác trong /tmp',
    pathLabel: '/tmp (tệp cũ hơn 6 giờ)',
    note: 'Tệp tạm của user z, loại trừ next* và render* của app',
    special: 'tmp',
  },
  {
    id: 'screenshots',
    name: 'Ảnh chụp màn hình cũ',
    pathLabel: '/home/z/my-project/public/screenshots',
    note: 'Toàn bộ file ảnh chụp đã lưu (giữ nguyên thư mục)',
  },
]

// ---------- Windows ----------

// Đường dẫn môi trường Windows (fallback hợp lý nếu thiếu biến môi trường)
const WIN_LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
const WIN_SYSTEMROOT = process.env.SystemRoot ?? 'C:\\Windows'

// Pattern lọc file thumbnail/icon cache — PS -match mặc định không phân biệt hoa/thường
const WIN_THUMB_RX = /^thumbcache_.*\.db$|^iconcache_.*\.db$/i
const WIN_THUMB_PS_RX = WIN_THUMB_RX.source
// Chỉ quét profile thật của Chrome/Edge: Default và Profile N (bỏ System Profile, Guest...)
const WIN_PROFILE_PS_RX = '^(Default|Profile \\d+)$'

// Danh sách mục tiêu dọn disk trên Windows (thứ tự = thứ tự hiển thị UI);
// 2 mục tiêu special (recyclebin, deliveryopt) nằm cuối — scan báo sizeBytes 0, canClean true
const TARGETS_WIN: TargetDef[] = [
  {
    id: 'win-user-temp',
    name: 'File tạm người dùng (Temp)',
    paths: [os.tmpdir()],
    pathLabel: '%TEMP%',
    note: 'Thư mục TEMP của user hiện tại',
  },
  {
    id: 'win-win-temp',
    name: 'File tạm Windows',
    paths: [path.join(WIN_SYSTEMROOT, 'Temp')],
    pathLabel: `${WIN_SYSTEMROOT}\\Temp`,
    admin: true,
    note: 'Cần quyền Administrator',
  },
  {
    id: 'win-prefetch',
    name: 'Prefetch Windows',
    paths: [path.join(WIN_SYSTEMROOT, 'Prefetch')],
    pathLabel: `${WIN_SYSTEMROOT}\\Prefetch`,
    admin: true,
    note: 'An toàn — Windows tự dựng lại',
  },
  {
    id: 'win-wu-cache',
    name: 'Cache Windows Update',
    paths: [path.join(WIN_SYSTEMROOT, 'SoftwareDistribution', 'Download')],
    pathLabel: `${WIN_SYSTEMROOT}\\SoftwareDistribution\\Download`,
    admin: true,
    note: 'Cần quyền Administrator — Windows tự tải lại khi Update',
  },
  {
    id: 'win-d3dscache',
    name: 'DirectX Shader Cache',
    paths: [path.join(WIN_LOCAL, 'D3DSCache')],
    pathLabel: '%LOCALAPPDATA%\\D3DSCache',
  },
  {
    id: 'win-thumbcache',
    name: 'Thumbnail + icon cache',
    paths: [path.join(WIN_LOCAL, 'Microsoft', 'Windows', 'Explorer')],
    pathLabel: '%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer',
    filePattern: WIN_THUMB_PS_RX,
    note: 'Chỉ xóa file thumbcache_*.db / iconcache_*.db (Windows tự dựng lại)',
  },
  {
    id: 'win-chrome-cache',
    name: 'Cache Chrome',
    paths: [path.join(WIN_LOCAL, 'Google', 'Chrome', 'User Data')],
    pathLabel: '%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Cache · *\\Code Cache',
    special: 'browser-cache',
  },
  {
    id: 'win-edge-cache',
    name: 'Cache Edge',
    paths: [path.join(WIN_LOCAL, 'Microsoft', 'Edge', 'User Data')],
    pathLabel: '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\*\\Cache · *\\Code Cache',
    special: 'browser-cache',
  },
  {
    id: 'win-crash-dumps',
    name: 'Crash dumps',
    paths: [path.join(WIN_LOCAL, 'CrashDumps')],
    pathLabel: '%LOCALAPPDATA%\\CrashDumps',
  },
  {
    id: 'win-recycle-bin',
    name: 'Thùng rác (Recycle Bin)',
    pathLabel: 'Tất cả các ổ đĩa',
    special: 'recyclebin',
    note: 'Xóa vĩnh viễn các file đang nằm trong Thùng rác',
  },
  {
    id: 'win-delivery-opt',
    name: 'Cache Delivery Optimization',
    pathLabel: 'Do Windows quản lý (Delivery Optimization)',
    special: 'deliveryopt',
    admin: true,
    note: 'Cần quyền Administrator — dung lượng giải phóng không đo được chính xác',
  },
]

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

// Quote một chuỗi thành literal PowerShell (single-quote, nhân đôi quote bên trong)
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

// Prisma Int giới hạn 32-bit — kẹp giá trị khi ghi log
function clampInt(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Math.round(n), INT32_MAX)
}

// Cache kết quả isAdminWin — chỉ cache true 60s; false chỉ cache 5s để hiccup
// PowerShell tạm thời không khiến user elevated bị chặn quyền cả 1 phút
let winAdminCache: { value: boolean; at: number } | null = null
async function isAdminCached(): Promise<boolean> {
  if (!isWin) return false
  const now = Date.now()
  if (winAdminCache) {
    const ttl = winAdminCache.value ? 60_000 : 5_000
    if (now - winAdminCache.at < ttl) return winAdminCache.value
  }
  const v = await isAdminWin()
  winAdminCache = { value: v, at: now }
  return v
}

// Đo dung lượng (bytes) của các thư mục: tổng các dòng `du -sk`
async function duBytesDirs(paths: string[]): Promise<number> {
  if (!paths.length) return 0
  const r = await run(`du -sk ${paths.map(shellQuote).join(' ')} 2>/dev/null`)
  let kb = 0
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^(\d+)\s/)
    if (m) kb += parseInt(m[1], 10)
  }
  return kb * 1024
}

// Đo dung lượng (bytes) của danh sách file: dòng "total" của `du -ck`
async function duBytesFiles(files: string[]): Promise<number> {
  if (!files.length) return 0
  const r = await run(`du -ck ${files.map(shellQuote).join(' ')} 2>/dev/null | tail -1`)
  const m = r.stdout.trim().match(/^(\d+)/)
  return m ? parseInt(m[1], 10) * 1024 : 0
}

// Liệt kê tệp/tệp con trong /tmp cũ hơn 6 giờ của user z,
// loại trừ dotfile và các thư mục app đang dùng (next*, render*)
async function listTmpFiles(): Promise<string[]> {
  const r = await run(
    "find /tmp -maxdepth 1 -user z -mmin +360 -not -name '.*' -not -name 'next*' -not -name 'render*' 2>/dev/null | head -50",
  )
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((p) => p.startsWith('/tmp/') && p.length > 5)
    .filter((p) => {
      const base = p.slice(5) // lọc thêm lần nữa để an toàn tuyệt đối
      return !base.startsWith('.') && !base.startsWith('next') && !base.startsWith('render')
    })
}

// Đo dung lượng các file ảnh chụp (chỉ đếm file, giữ thư mục)
async function screenshotBytes(): Promise<number> {
  const r = await run(
    `find ${shellQuote(SHOTS_DIR)} -maxdepth 1 -type f -print0 2>/dev/null | xargs -0 -r du -ck 2>/dev/null | tail -1`,
  )
  const m = r.stdout.trim().match(/^(\d+)/)
  return m ? parseInt(m[1], 10) * 1024 : 0
}

// Chạy script PowerShell trả về JSON {"bytes":N} — trả về:
//  - number >= 0: đo thành công (0 = thực sự trống/không có gì)
//  - null: KHÔNG đo được (PowerShell lỗi, timeout, parse lỗi) — không được ngụy trang thành 0
async function winPsBytes(script: string): Promise<number | null> {
  // 120s — Chrome cache / Temp trên HDD chậm có thể rất lớn, 60s dễ timeout oan
  const r = await psRun(script, 120_000)
  if (!r.ok) return null
  try {
    const obj = JSON.parse(r.stdout.trim()) as { bytes?: number } | null
    return typeof obj?.bytes === 'number' && Number.isFinite(obj.bytes) && obj.bytes > 0
      ? obj.bytes
      : 0
  } catch {
    return null
  }
}

// Đo dung lượng các thư mục trên Windows — MỘT psRun cho cả danh sách.
// filePattern (nếu có): chỉ đếm file khớp regex theo Name (vd thumbcache/iconcache).
async function winDirBytes(paths: string[], filePattern?: string): Promise<number | null> {
  if (!paths.length) return 0
  const lines: string[] = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$total = [long]0',
  ]
  if (filePattern) lines.push(`$rx = ${psQuote(filePattern)}`)
  lines.push(`$paths = @(${paths.map(psQuote).join(',')})`)
  lines.push('foreach ($p in $paths) {')
  lines.push('  if (-not (Test-Path -LiteralPath $p -PathType Container)) { continue }')
  const gci =
    'Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue'
  lines.push(
    filePattern
      ? `  $sum = (${gci} | Where-Object { $_.Name -match $rx } | Measure-Object Length -Sum).Sum`
      : `  $sum = (${gci} | Measure-Object Length -Sum).Sum`,
  )
  lines.push('  if ($sum) { $total += $sum }')
  lines.push('}')
  lines.push('@{ bytes = $total } | ConvertTo-Json -Compress')
  lines.push('exit 0')
  return winPsBytes(lines.join('\n'))
}

// Đo cache Chrome/Edge: resolve thư mục profile (Default | Profile N) rồi cộng
// dung lượng 2 thư mục con Cache + Code Cache của từng profile
function winBrowserBytesScript(base: string): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$total = [long]0',
    `$base = ${psQuote(base)}`,
    'if (Test-Path -LiteralPath $base -PathType Container) {',
    `  $dirs = @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | Where-Object Name -match ${psQuote(WIN_PROFILE_PS_RX)})`,
    '  foreach ($d in $dirs) {',
    "    foreach ($sub in @('Cache','Code Cache')) {",
    '      $p = Join-Path $d.FullName $sub',
    '      if (Test-Path -LiteralPath $p -PathType Container) {',
    '        $sum = (Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum',
    '        if ($sum) { $total += $sum }',
    '      }',
    '    }',
    '  }',
    '}',
    '@{ bytes = $total } | ConvertTo-Json -Compress',
    'exit 0',
  ].join('\n')
}

// Đo dung lượng một mục tiêu Windows (trả null nếu không đo được — không ngụy 0)
async function winMeasureTarget(t: TargetDef): Promise<number | null> {
  if (t.special === 'browser-cache') {
    const base = t.paths?.[0]
    return base ? winPsBytes(winBrowserBytesScript(base)) : 0
  }
  return winDirBytes(t.paths ?? [], t.filePattern)
}

// Script xóa NỘI DUNG các path (giữ lại thư mục cha), bỏ qua path không tồn tại
function winCleanScript(t: TargetDef): string {
  const REMOVE_CONTENTS =
    'Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue'
  if (t.special === 'browser-cache') {
    return [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$base = ${psQuote(t.paths?.[0] ?? '')}`,
      'if (Test-Path -LiteralPath $base -PathType Container) {',
      `  $dirs = @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | Where-Object Name -match ${psQuote(WIN_PROFILE_PS_RX)})`,
      '  foreach ($d in $dirs) {',
      "    foreach ($sub in @('Cache','Code Cache')) {",
      '      $p = Join-Path $d.FullName $sub',
      '      if (Test-Path -LiteralPath $p -PathType Container) {',
      `        ${REMOVE_CONTENTS}`,
      '      }',
      '    }',
      '  }',
      '}',
      'exit 0',
    ].join('\n')
  }
  const lines: string[] = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$paths = @(${(t.paths ?? []).map(psQuote).join(',')})`,
    'foreach ($p in $paths) {',
    '  if (-not (Test-Path -LiteralPath $p -PathType Container)) { continue }',
  ]
  if (t.filePattern) {
    // Chỉ xóa file khớp pattern (vd thumbcache_*.db / iconcache_*.db)
    lines.push(`  $rx = ${psQuote(t.filePattern)}`)
    lines.push(
      '  Get-ChildItem -LiteralPath $p -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $rx } | Remove-Item -Force -ErrorAction SilentlyContinue',
    )
  } else {
    lines.push(`  ${REMOVE_CONTENTS}`)
  }
  lines.push('}')
  lines.push('exit 0')
  return lines.join('\n')
}

// Dọn một mục tiêu disk trên Windows — trung thực: không giả số liệu, không giả thành công
async function winCleanTarget(t: TargetDef): Promise<CleanupResult> {
  const base = { id: t.id, name: t.name, kind: 'disk' as const }
  const failMsg = (stderr: string) =>
    `Lỗi khi xóa: ${(stderr || 'không rõ nguyên nhân').slice(0, 160)}`

  // Cần quyền Administrator mà tiến trình không elevated → báo thất bại, KHÔNG thử
  if (t.admin && !(await isAdminCached())) {
    return {
      ...base,
      freedBytes: 0,
      success: false,
      message: 'Cần quyền Administrator — hãy chạy NEXUS Optimizer với quyền Admin',
    }
  }

  if (t.special === 'recyclebin') {
    const r = await psRun(
      [
        "if (-not (Get-Command Clear-RecycleBin -ErrorAction SilentlyContinue)) { exit 1 }",
        'Clear-RecycleBin -Force -ErrorAction SilentlyContinue',
        'exit 0',
      ].join('\n'),
      60_000,
    )
    return {
      ...base,
      freedBytes: 0,
      success: r.ok,
      message: r.ok
        ? 'Đã dọn thùng rác (Recycle Bin)'
        : `Không dọn được thùng rác: ${(r.stderr || 'Clear-RecycleBin không khả dụng trên bản Windows này').slice(0, 160)}`,
    }
  }

  if (t.special === 'deliveryopt') {
    const r = await psRun(
      [
        "if (-not (Get-Command Delete-DeliveryOptimizationCache -ErrorAction SilentlyContinue)) { exit 1 }",
        'Delete-DeliveryOptimizationCache -Force -ErrorAction SilentlyContinue',
        'exit 0',
      ].join('\n'),
      60_000,
    )
    return {
      ...base,
      freedBytes: 0,
      success: r.ok,
      message: r.ok
        ? 'Đã gọi lệnh xóa cache Delivery Optimization — dung lượng giải phóng do Windows quản lý, không đo được chính xác'
        : `Không dọn được cache Delivery Optimization: ${(r.stderr || 'cmdlet không khả dụng trên bản Windows này').slice(0, 160)}`,
    }
  }

  const before = await winMeasureTarget(t)
  if (before === 0) {
    return {
      ...base,
      freedBytes: 0,
      success: true,
      message: 'Đường dẫn không tồn tại hoặc trống — không cần dọn',
    }
  }
  // before === null: không đo được (thư mục quá lớn/timeout) — vẫn chạy dọn, freed = 0 trung thực
  const r = await psRun(winCleanScript(t), 180_000)
  const after = await winMeasureTarget(t)
  const freed =
    before !== null && after !== null ? Math.max(0, before - after) : 0
  const measureNote =
    before === null || after === null
      ? ' (không đo được dung lượng — thư mục quá lớn hoặc bị khóa, kết quả vẫn thực hiện)'
      : ''
  return {
    ...base,
    freedBytes: freed,
    success: r.ok,
    message: r.ok
      ? `Đã dọn xong, giải phóng ${formatBytes(freed)}${measureNote}`
      : failMsg(r.stderr),
  }
}

async function measureTarget(t: TargetDef, tmpFiles: string[]): Promise<number> {
  if (t.special === 'tmp') return duBytesFiles(tmpFiles)
  if (t.id === 'screenshots') return screenshotBytes()
  return duBytesDirs(t.paths ?? [])
}

function cleanCommand(t: TargetDef, tmpFiles: string[]): string {
  if (t.special === 'tmp') {
    if (!tmpFiles.length) return 'true'
    return `rm -rf ${tmpFiles.map(shellQuote).join(' ')} 2>/dev/null`
  }
  if (t.id === 'screenshots') {
    // Chỉ xóa file bên trong, giữ lại thư mục cho app
    return `find ${shellQuote(SHOTS_DIR)} -maxdepth 1 -type f -exec rm -f {} + 2>/dev/null`
  }
  const paths = t.paths ?? []
  if (!paths.length) return 'true'
  return `rm -rf ${paths.map(shellQuote).join(' ')} 2>/dev/null`
}

// Quét mục tiêu dọn dẹp (không xóa gì) — dùng cho GET /api/cleanup
export async function scanTargets(): Promise<CleanupTargetInfo[]> {
  if (isWin) {
    const out: CleanupTargetInfo[] = []
    for (const t of TARGETS_WIN) {
      if (t.special === 'recyclebin' || t.special === 'deliveryopt') {
        // Special không đo trước được — báo 0 bytes nhưng vẫn cho phép dọn
        out.push({
          id: t.id,
          name: t.name,
          path: t.pathLabel,
          sizeBytes: 0,
          canClean: true,
          note: t.note,
        })
        continue
      }
      const sizeBytes = await winMeasureTarget(t)
      out.push({
        id: t.id,
        name: t.name,
        path: t.pathLabel,
        sizeBytes: sizeBytes ?? 0,
        canClean: (sizeBytes ?? 0) > 0,
        note: t.note,
      })
    }
    return out
  }
  const tmpFiles = await listTmpFiles()
  const out: CleanupTargetInfo[] = []
  for (const t of TARGETS) {
    const sizeBytes = await measureTarget(t, tmpFiles)
    out.push({
      id: t.id,
      name: t.name,
      path: t.pathLabel,
      sizeBytes,
      canClean: sizeBytes > 0,
      note: t.note,
    })
  }
  return out
}

async function cleanOne(t: TargetDef, tmpFiles: string[]): Promise<CleanupResult> {
  const before = await measureTarget(t, tmpFiles)
  if (before <= 0) {
    return {
      id: t.id,
      name: t.name,
      kind: 'disk',
      freedBytes: 0,
      success: true,
      message: 'Đường dẫn không tồn tại hoặc trống — không cần dọn',
    }
  }
  const res = await run(cleanCommand(t, tmpFiles), 30000)
  const after = await measureTarget(t, tmpFiles)
  const freed = Math.max(0, before - after)
  return {
    id: t.id,
    name: t.name,
    kind: 'disk',
    freedBytes: freed,
    success: res.ok,
    message: res.ok
      ? `Đã dọn xong, giải phóng ${formatBytes(freed)}`
      : `Lỗi khi xóa: ${(res.stderr || 'không rõ nguyên nhân').slice(0, 160)}`,
  }
}

async function logToDb(kind: string, target: string, freedBytes: number, success: boolean, message: string) {
  try {
    await db.cleanupLog.create({
      data: { kind, target, freedBytes: clampInt(freedBytes), success, message },
    })
  } catch {
    // Ghi log lỗi không chặn quá trình dọn dẹp
  }
}

// Dọn toàn bộ mục tiêu disk, trả về kết quả từng mục tiêu
export async function cleanupDisk(): Promise<{
  results: CleanupResult[]
  totalFreedDisk: number
  totalFreedRam: number
}> {
  if (isWin) {
    const results: CleanupResult[] = []
    let totalFreedDisk = 0
    for (const t of TARGETS_WIN) {
      const r = await winCleanTarget(t)
      results.push(r)
      totalFreedDisk += r.freedBytes
      await logToDb('disk', r.id, r.freedBytes, r.success, r.message)
    }
    return { results, totalFreedDisk, totalFreedRam: 0 }
  }
  const tmpFiles = await listTmpFiles()
  const results: CleanupResult[] = []
  let totalFreedDisk = 0
  for (const t of TARGETS) {
    const r = await cleanOne(t, tmpFiles)
    results.push(r)
    totalFreedDisk += r.freedBytes
    await logToDb('disk', r.id, r.freedBytes, r.success, r.message)
  }
  return { results, totalFreedDisk, totalFreedRam: 0 }
}

// Đọc MemAvailable (kB) từ /proc/meminfo
async function readMemAvailableKB(): Promise<number> {
  try {
    const txt = await readFile('/proc/meminfo', 'utf8')
    const m = txt.match(/^MemAvailable:\s+(\d+)\s+kB/m)
    return m ? parseInt(m[1], 10) : 0
  } catch {
    return 0
  }
}

// Script dọn RAM Windows: EmptyWorkingSet (psapi.dll) cho các tiến trình nặng.
// Có kiểm tra Add-Type thật sự tạo được class — AppLocker/WDAC chặn Csc thì phải
// báo thất bại thay vì "thành công" âm thầm không làm gì cả.
function winRamScript(): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class WinRamClean {',
    '  [DllImport("psapi.dll", SetLastError = true)]',
    '  public static extern bool EmptyWorkingSet(IntPtr hProcess);',
    '}',
    '"@',
    "if (-not ('WinRamClean' -as [type])) { Write-Output 'ADDTYPE_FAIL'; exit 1 }",
    'Get-Process | Where-Object { $_.WorkingSet64 -gt 50MB -and $_.Id -ne $PID } | ForEach-Object { try { [WinRamClean]::EmptyWorkingSet($_.Handle) | Out-Null } catch {} }',
    'exit 0',
  ].join('\n')
}

// Dọn RAM: Windows dùng EmptyWorkingSet; Linux dùng sync + drop_caches (cần sudo)
export async function cleanupRam(): Promise<{
  results: CleanupResult[]
  totalFreedDisk: number
  totalFreedRam: number
}> {
  if (isWin) {
    const availBefore = os.freemem()
    const r = await psRun(winRamScript(), 120_000)
    if (!r.ok) {
      // THẤT BẠI → KHÔNG được báo "giải phóng X MB" từ nhiễu tự nhiên của os.freemem()
      const message = `Không chạy được PowerShell để dọn RAM: ${(r.stderr || r.stdout || 'không rõ nguyên nhân').slice(0, 160)}`
      await logToDb('ram', 'win-ram-clean', 0, false, message)
      return {
        results: [
          {
            id: 'win-ram-clean',
            name: 'RAM tiến trình (EmptyWorkingSet)',
            kind: 'ram',
            freedBytes: 0,
            success: false,
            message,
          },
        ],
        totalFreedDisk: 0,
        totalFreedRam: 0,
      }
    }
    // Chờ hệ điều hành cập nhật số liệu bộ nhớ trước khi đo lại
    await new Promise<void>((resolve) => setTimeout(resolve, 1200))
    const availAfter = os.freemem()
    const freed = Math.max(0, availAfter - availBefore)
    const toMB = (n: number) => `${(n / 1048576).toFixed(0)} MB`
    const message = `Đã gọi EmptyWorkingSet cho các tiến trình >50MB; RAM available ${toMB(availBefore)} → ${toMB(availAfter)} (giải phóng ~${formatBytes(freed)})`
    await logToDb('ram', 'win-ram-clean', freed, true, message)
    return {
      results: [
        {
          id: 'win-ram-clean',
          name: 'RAM tiến trình (EmptyWorkingSet)',
          kind: 'ram',
          freedBytes: freed,
          success: true,
          message,
        },
      ],
      totalFreedDisk: 0,
      totalFreedRam: freed,
    }
  }

  const beforeKB = await readMemAvailableKB()
  await run('sync') // sync hoạt động không cần root
  const rootRes = await tryRoot('sh -c "sync; echo 3 > /proc/sys/vm/drop_caches"')
  const afterKB = await readMemAvailableKB()

  // Nếu không đọc được meminfo trước/sau thì báo 0 để trung thực
  const totalFreedRam =
    beforeKB > 0 && afterKB > 0 ? Math.max(0, (afterKB - beforeKB) * 1024) : 0

  const success = rootRes.ok
  const message = success
    ? `Đã chạy sync + drop_caches; MemAvailable ${beforeKB} → ${afterKB} kB (giải phóng ~${formatBytes(totalFreedRam)})`
    : `${rootRes.stderr || 'Cần quyền root (sudo) — máy chủ hiện không cho phép'}. Đã chạy sync thường; bộ nhớ đệm sẽ giải phóng dần khi các tiến trình thoát.`

  await logToDb('ram', 'ram-kernel', totalFreedRam, success, message)
  return {
    results: [
      {
        id: 'ram-kernel',
        name: 'RAM hạt nhân (drop_caches)',
        kind: 'ram',
        freedBytes: totalFreedRam,
        success,
        message,
      },
    ],
    totalFreedDisk: 0,
    totalFreedRam,
  }
}

// Dọn Disk + RAM CÙNG LÚC (song song) — yêu cầu chính của người dùng
export async function cleanupAll(): Promise<{
  results: CleanupResult[]
  totalFreedDisk: number
  totalFreedRam: number
}> {
  const [disk, ram] = await Promise.all([cleanupDisk(), cleanupRam()])
  return {
    results: [...disk.results, ...ram.results],
    totalFreedDisk: disk.totalFreedDisk,
    totalFreedRam: ram.totalFreedRam,
  }
}
