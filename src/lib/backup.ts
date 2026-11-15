// Backend module Sao lưu — tar local + S3 sidecar (scripts/s3_sidecar.py)
// KHÔNG BAO GIỜ đọc/ghi thông tin xác thực trong file này — sidecar tự đọc runtime.
import { promises as fs } from 'fs'
import { randomBytes } from 'crypto'
import path from 'path'
import { db } from '@/lib/db'
import { run } from '@/lib/exec'
import type { BackupBucketItem, BackupLocal } from '@/lib/types'

/** Lỗi "không tìm thấy" — route map sang HTTP 404 */
export class NotFoundError extends Error {}

const PROJECT_ROOT = '/home/z/my-project'
export const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups')
export const S3_PREFIX = 'nexus-backups/'
const SIDECAR = 'python3 scripts/s3_sidecar.py'

export interface SidecarResult {
  ok: boolean
  error?: string
  key?: string
  sizeBytes?: number
  url?: string
  path?: string
  items?: BackupBucketItem[]
}

// ---------- helpers ----------

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

function parseSidecarStdout(stdout: string): SidecarResult {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{')) {
      try {
        const parsed = JSON.parse(lines[i]) as SidecarResult
        if (typeof parsed.ok === 'boolean') return parsed
      } catch {
        // thử dòng trước
      }
    }
  }
  return { ok: false, error: 'Sidecar không trả về JSON hợp lệ' }
}

async function sidecar(op: string, args: string[] = [], timeoutMs = 60000): Promise<SidecarResult> {
  const quoted = args.map(shellQuote).join(' ')
  const r = await run(`${SIDECAR} ${op} ${quoted}`.trim(), timeoutMs)
  if (!r.stdout.trim()) {
    return {
      ok: false,
      error: r.stderr.trim().slice(0, 200) || 'Sidecar không phản hồi',
    }
  }
  return parseSidecarStdout(r.stdout)
}

function slugifyName(raw: string): string {
  const cleaned = (raw || '')
    .replace(/[^a-zA-Z0-9\-_ ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'backup'
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function toBackupLocal(r: {
  id: number
  name: string
  sizeBytes: number
  uploaded: boolean
  s3Key?: string | null
  createdAt: Date
}): BackupLocal {
  return {
    id: r.id,
    name: r.name,
    sizeBytes: r.sizeBytes,
    uploaded: r.uploaded,
    s3Key: r.s3Key ?? undefined,
    createdAt: r.createdAt.toISOString(),
  }
}

// ---------- local backups ----------

export async function createBackup(name: string): Promise<BackupLocal> {
  const slug = slugifyName(name)
  await fs.mkdir(BACKUP_DIR, { recursive: true })
  const fileName = `${slug}-${timestamp()}.tar.gz`
  const filePath = path.join(BACKUP_DIR, fileName)

  // KHÔNG đóng gói db/ (SQLite đang chạy!), upload/ (credential!), .env*, node_modules, .next, .git, backups
  const cmd =
    `tar -czf ${shellQuote(filePath)} -C ${shellQuote(PROJECT_ROOT)}` +
    ` --exclude=node_modules --exclude=.next --exclude=backups --exclude=.git` +
    ` --exclude=upload --exclude='.env*'` +
    ` src prisma scripts public package.json next.config.ts`
  const r = await run(cmd, 120000)
  if (!r.ok) {
    try {
      await fs.unlink(filePath)
    } catch {
      // bỏ qua
    }
    throw new Error('Không tạo được file backup (tar thất bại)')
  }

  // Xác thực tính toàn vẹn của file lưu trữ TRƯỚC khi ghi nhận vào DB
  const verify = await run(`tar -tzf ${shellQuote(filePath)} >/dev/null 2>&1`)
  if (!verify.ok) {
    try {
      await fs.unlink(filePath)
    } catch {
      // bỏ qua
    }
    throw new Error('File backup tạo ra bị hỏng hoặc không đọc được (kiểm tra tar -tzf thất bại)')
  }

  let stat
  try {
    stat = await fs.stat(filePath)
  } catch {
    throw new Error('Không tạo được file backup (tar thất bại)')
  }

  const record = await db.backupRecord.create({
    data: {
      name: fileName,
      path: filePath,
      sizeBytes: stat.size,
      uploaded: false,
    },
  })
  return toBackupLocal(record)
}

export async function listLocal(): Promise<BackupLocal[]> {
  const rows = await db.backupRecord.findMany({ orderBy: { createdAt: 'desc' } })
  return rows.map(toBackupLocal)
}

export async function listBucket(): Promise<BackupBucketItem[]> {
  const r = await sidecar('list', [], 60000)
  if (!r.ok) throw new Error(r.error || 'Không liệt kê được bucket')
  return r.items ?? []
}

export async function deleteLocal(id: number): Promise<void> {
  const record = await db.backupRecord.findUnique({ where: { id } })
  if (!record) throw new NotFoundError('Không tìm thấy bản sao lưu trên máy chủ')
  const resolved = path.resolve(record.path)
  if (!resolved.startsWith(path.resolve(BACKUP_DIR) + path.sep)) {
    throw new Error('Đường dẫn backup không hợp lệ')
  }
  try {
    await fs.unlink(resolved)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw new Error('Không xóa được file backup trên máy chủ')
  }
  await db.backupRecord.delete({ where: { id } })
}

// ---------- bucket operations ----------

export async function uploadToBucket(
  id: number,
): Promise<{ ok: boolean; error?: string; key?: string }> {
  const record = await db.backupRecord.findUnique({ where: { id } })
  if (!record) return { ok: false, error: 'Không tìm thấy bản sao lưu trên máy chủ' }
  const key = `${S3_PREFIX}${path.basename(record.path)}`
  const r = await sidecar('upload', [record.path, key], 600000)
  if (!r.ok) return { ok: false, error: r.error || 'Tải lên bucket thất bại' }
  await db.backupRecord.update({ where: { id }, data: { uploaded: true, s3Key: key } })
  return { ok: true, key }
}

export async function deleteBucketObject(key: string): Promise<void> {
  if (!key.startsWith(S3_PREFIX)) throw new Error('Key bucket không hợp lệ')
  const r = await sidecar('delete', [key], 60000)
  if (!r.ok) throw new Error(r.error || 'Không xóa được object trên bucket')
}

export async function presignFor(id: number): Promise<{ url: string }> {
  const record = await db.backupRecord.findUnique({ where: { id } })
  if (!record) throw new NotFoundError('Không tìm thấy bản sao lưu trên máy chủ')
  if (!record.s3Key) throw new Error('Bản sao lưu này chưa được tải lên bucket')
  return presignKey(record.s3Key)
}

export async function presignKey(key: string): Promise<{ url: string }> {
  if (!key.startsWith(S3_PREFIX)) throw new Error('Key bucket không hợp lệ')
  const r = await sidecar('presign', [key, '3600'], 60000)
  if (!r.ok || !r.url) throw new Error(r.error || 'Không tạo được link tải về')
  return { url: r.url }
}

export async function restoreFromBucket(
  key: string,
  destDir = PROJECT_ROOT,
): Promise<{ ok: boolean; message: string }> {
  if (!key.startsWith(S3_PREFIX)) throw new Error('Key bucket không hợp lệ')
  // Tên file tạm ngẫu nhiên (crypto) — không dùng timestamp đoán được
  const tmpPath = `/tmp/restore-${randomBytes(12).toString('hex')}.tar.gz`
  try {
    const dl = await sidecar('download', [key, tmpPath], 600000)
    if (!dl.ok) {
      const errText = dl.error || ''
      if (/NoSuchKey|\(404\)|does not exist/i.test(errText)) {
        throw new NotFoundError('Không tìm thấy bản backup trên bucket')
      }
      throw new Error(dl.error || 'Tải backup từ bucket về máy thất bại')
    }

    // Kiểm tra toàn vẹn + rà soát danh sách thành viên TRƯỚC khi giải nén
    const list = await run(`tar -tzf ${shellQuote(tmpPath)}`, 60000)
    if (!list.ok) {
      return { ok: false, message: 'File backup tải về bị hỏng hoặc không đọc được — từ chối khôi phục' }
    }
    const members = list.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    const dangerous = members.find(
      (m) => m.startsWith('/') || m.split('/').includes('..'),
    )
    if (dangerous) {
      return {
        ok: false,
        message: `Backup chứa đường dẫn nguy hiểm, đã từ chối khôi phục: ${dangerous.slice(0, 120)}`,
      }
    }

    // An toàn khi giải nén: không ghi đè node_modules, upload/ (credential!), .env
    // và CƠ SỞ DỮ LIỆU đang chạy (db/custom.db + WAL) — tránh làm hỏng SQLite live.
    const extract =
      `tar -xzf ${shellQuote(tmpPath)} -C ${shellQuote(destDir)}` +
      ` --exclude='node_modules*' --exclude='upload*' --exclude='.env*'` +
      ` --exclude='db' --exclude='db/*' --exclude='*.db-wal' --exclude='*.db-shm'`
    const r = await run(extract, 120000)
    if (!r.ok) {
      return { ok: false, message: 'Giải nén backup thất bại — không khôi phục được dữ liệu' }
    }
    return {
      ok: true,
      message: 'Đã khôi phục backup từ bucket về máy chủ (không ghi đè node_modules, upload, .env, db)',
    }
  } finally {
    try {
      await fs.unlink(tmpPath)
    } catch {
      // bỏ qua nếu file tạm không tồn tại
    }
  }
}
