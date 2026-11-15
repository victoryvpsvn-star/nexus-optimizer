// Logic dọn dẹp Disk + RAM cho NEXUS OPTIMIZER (chỉ chạy phía máy chủ)
import { readFile } from 'fs/promises'
import { run, tryRoot } from '@/lib/exec'
import { db } from '@/lib/db'
import { formatBytes } from '@/lib/format'
import type { CleanupResult, CleanupTargetInfo } from '@/lib/types'

const HOME = '/home/z'
const SHOTS_DIR = '/home/z/my-project/public/screenshots'
const INT32_MAX = 2147483647

export const RAM_NOTE =
  'Dọn RAM hạt nhân cần sudo; đã dùng sync + đo MemAvailable. Trên VPS không có sudo, phần lớn bộ nhớ đệm được giải phóng khi các tiến trình thoát.'

interface TargetDef {
  id: string
  name: string
  pathLabel: string
  note?: string
  paths?: string[] // đo + clean trực tiếp các thư mục này
  special?: 'tmp' // xử lý riêng bằng find trong /tmp
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

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

// Prisma Int giới hạn 32-bit — kẹp giá trị khi ghi log
function clampInt(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Math.round(n), INT32_MAX)
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

// Dọn RAM: sync + drop_caches (cần sudo), đo MemAvailable trước/sau
export async function cleanupRam(): Promise<{
  results: CleanupResult[]
  totalFreedDisk: number
  totalFreedRam: number
}> {
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
