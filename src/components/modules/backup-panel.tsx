'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Cloud,
  DatabaseBackup,
  Download,
  Github,
  HardDrive,
  Loader2,
  PackageOpen,
  RotateCcw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UploadCloud,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import type { BackupBucketItem, BackupListResponse, BackupLocal } from '@/lib/types'
import { formatBytes, formatTime } from '@/lib/format'

type ListData = BackupListResponse & { totalLocalBytes?: number }

export function BackupPanel() {
  const [data, setData] = useState<ListData | null>(null)
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [busyLocalId, setBusyLocalId] = useState<number | null>(null)
  const [busyBucketKey, setBusyBucketKey] = useState<string | null>(null)

  const local = data?.local ?? []
  const bucket = data?.bucket ?? []
  const totalLocalBytes = data?.totalLocalBytes ?? local.reduce((s, b) => s + b.sizeBytes, 0)
  const totalBucketBytes = bucket.reduce((s, b) => s + b.sizeBytes, 0)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/backups', { cache: 'no-store' })
      const json = (await r.json().catch(() => null)) as (ListData & { error?: string }) | null
      if (!r.ok || !json || json.error) throw new Error(json?.error ?? 'Không tải được danh sách backup')
      setData(json)
    } catch (e) {
      /* giữ danh sách cũ khi lỗi — không làm trống bảng */
      toast.error((e as Error).message || 'Không tải được danh sách backup')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const create = async () => {
    setCreating(true)
    try {
      const r = await fetch('/api/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || 'backup' }),
      })
      const json = (await r.json()) as { backup?: BackupLocal; error?: string }
      if (!r.ok || json.error) throw new Error(json.error || 'Tạo backup thất bại')
      toast.success(
        `Đã tạo backup ${json.backup?.name ?? ''} (${formatBytes(json.backup?.sizeBytes ?? 0)})`,
      )
      setName('')
      await load()
    } catch (e) {
      toast.error((e as Error).message || 'Tạo backup thất bại')
    } finally {
      setCreating(false)
    }
  }

  const uploadOne = async (b: BackupLocal) => {
    setBusyLocalId(b.id)
    toast.info(`Đang tải ${b.name} lên bucket...`)
    try {
      const r = await fetch('/api/backups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upload', id: b.id }),
      })
      const json = (await r.json()) as { ok?: boolean; error?: string; key?: string }
      if (!r.ok || !json.ok) throw new Error(json.error || 'Tải lên bucket thất bại')
      toast.success(`Đã tải lên bucket: ${json.key ?? b.name}`)
      await load()
    } catch (e) {
      toast.error((e as Error).message || 'Tải lên bucket thất bại')
    } finally {
      setBusyLocalId(null)
    }
  }

  const restoreLocal = async (b: BackupLocal) => {
    setBusyLocalId(b.id)
    toast.info('Đang dùng lại backup từ file local...')
    try {
      const r = await fetch('/api/backups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore-local', id: b.id }),
      })
      const json = (await r.json()) as { ok?: boolean; message?: string; error?: string }
      if (!r.ok || !json.ok) throw new Error(json.error || 'Khôi phục thất bại')
      toast.success(json.message || 'Đã khôi phục backup từ máy chủ')
    } catch (e) {
      toast.error((e as Error).message || 'Khôi phục thất bại')
    } finally {
      setBusyLocalId(null)
    }
  }

  const downloadLocal = async (b: BackupLocal) => {
    setBusyLocalId(b.id)
    try {
      const r = await fetch('/api/backups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'presign', id: b.id }),
      })
      const json = (await r.json()) as { url?: string; error?: string }
      if (!r.ok || !json.url) throw new Error(json.error || 'Không tạo được link tải về')
      window.open(json.url, '_blank', 'noopener')
      toast.success('Đã mở link tải về (hết hạn sau 1 giờ)')
    } catch (e) {
      toast.error((e as Error).message || 'Không tạo được link tải về')
    } finally {
      setBusyLocalId(null)
    }
  }

  const downloadBucket = async (key: string) => {
    setBusyBucketKey(key)
    try {
      const r = await fetch('/api/backups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'presign', key }),
      })
      const json = (await r.json()) as { url?: string; error?: string }
      if (!r.ok || !json.url) throw new Error(json.error || 'Không tạo được link tải về')
      window.open(json.url, '_blank', 'noopener')
      toast.success('Đã mở link tải về (hết hạn sau 1 giờ)')
    } catch (e) {
      toast.error((e as Error).message || 'Không tạo được link tải về')
    } finally {
      setBusyBucketKey(null)
    }
  }

  const restoreBucket = async (key: string) => {
    setBusyBucketKey(key)
    toast.info('Đang khôi phục backup về máy chủ...')
    try {
      const r = await fetch('/api/backups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', key }),
      })
      const json = (await r.json()) as { ok?: boolean; message?: string; error?: string }
      if (!r.ok || !json.ok) throw new Error(json.error || 'Khôi phục thất bại')
      toast.success(json.message || 'Đã khôi phục backup về máy chủ')
    } catch (e) {
      toast.error((e as Error).message || 'Khôi phục thất bại')
    } finally {
      setBusyBucketKey(null)
    }
  }

  const deleteLocal = async (id: number) => {
    setBusyLocalId(id)
    try {
      const r = await fetch(`/api/backups?type=local&id=${id}`, { method: 'DELETE' })
      const json = (await r.json()) as { success?: boolean; error?: string }
      if (!r.ok || !json.success) throw new Error(json.error || 'Không xóa được bản backup')
      toast.success('Đã xóa bản backup trên máy chủ')
      await load()
    } catch (e) {
      toast.error((e as Error).message || 'Không xóa được bản backup')
    } finally {
      setBusyLocalId(null)
    }
  }

  const deleteBucket = async (key: string) => {
    setBusyBucketKey(key)
    try {
      const r = await fetch(`/api/backups?type=bucket&key=${encodeURIComponent(key)}`, {
        method: 'DELETE',
      })
      const json = (await r.json()) as { success?: boolean; error?: string }
      if (!r.ok || !json.success) throw new Error(json.error || 'Không xóa được object trên bucket')
      toast.success('Đã xóa object trên bucket')
      await load()
    } catch (e) {
      toast.error((e as Error).message || 'Không xóa được object trên bucket')
    } finally {
      setBusyBucketKey(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* Hero: tạo backup + trạng thái */}
      <Card className="glass rounded-2xl p-6">
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div
                className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10"
                style={{ background: 'color-mix(in srgb, var(--accent-1) 14%, transparent)' }}
              >
                <DatabaseBackup className="h-5 w-5" style={{ color: 'var(--accent-1)' }} />
              </div>
              <div>
                <h3 className="text-base font-semibold text-zinc-100">Tạo bản sao lưu</h3>
                <p className="text-xs text-zinc-500">
                  Nén toàn bộ mã nguồn + cấu hình thành file .tar.gz (loại trừ node_modules,
                  .next, upload, .env)
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {data ? (
                data.bucketOk ? (
                  <Badge className="rounded-full border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
                    <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                    Bucket <span className="num mx-1">{data.bucketName ?? 'vic'}</span> sẵn sàng
                  </Badge>
                ) : (
                  <Badge className="rounded-full border-rose-500/40 bg-rose-500/10 text-rose-400">
                    <TriangleAlert className="mr-1 h-3.5 w-3.5" />
                    Bucket lỗi: {data.bucketError ?? 'không kết nối được'}
                  </Badge>
                )
              ) : (
                <Skeleton className="h-6 w-44 rounded-full" />
              )}
              <Badge variant="outline" className="rounded-full border-white/10 text-zinc-300">
                <HardDrive className="mr-1 h-3.5 w-3.5" style={{ color: 'var(--accent-2)' }} />
                Dung lượng local: <span className="num ml-1">{formatBytes(totalLocalBytes)}</span>
              </Badge>
              <Badge variant="outline" className="rounded-full border-white/10 text-zinc-300">
                <Cloud className="mr-1 h-3.5 w-3.5" style={{ color: 'var(--accent-1)' }} />
                Dung lượng bucket: <span className="num ml-1">{formatBytes(totalBucketBytes)}</span>
                <span className="num ml-1 text-zinc-500">/ 30GB</span>
              </Badge>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !creating) create()
              }}
              placeholder="vd: nexus-full-2025"
              className="h-11 flex-1 rounded-xl border-white/10 bg-white/5 text-zinc-100 placeholder:text-zinc-400"
              aria-label="Tên bản sao lưu"
            />
            <Button
              onClick={create}
              disabled={creating}
              className="h-11 rounded-xl px-6 font-semibold text-black"
              style={{ background: 'var(--accent-1)' }}
            >
              {creating ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <DatabaseBackup className="mr-1.5 h-4 w-4" />
              )}
              {creating ? 'Đang tạo backup...' : 'Tạo backup ngay'}
            </Button>
          </div>
        </div>
      </Card>

      {/* Hai danh sách */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Local */}
        <Card className="glass rounded-2xl p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <HardDrive className="h-4 w-4" style={{ color: 'var(--accent-2)' }} />
            Bản sao lưu trên máy chủ
            <Badge variant="outline" className="num ml-auto rounded-full border-white/10 text-zinc-400">
              {loading ? '...' : local.length}
            </Badge>
          </h3>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full rounded-xl" />
              <Skeleton className="h-10 w-full rounded-xl" />
            </div>
          ) : local.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <PackageOpen className="h-8 w-8 text-zinc-400" />
              <p className="text-sm text-zinc-500">
                Chưa có bản backup nào trên máy chủ — tạo bản đầu tiên ở trên.
              </p>
            </div>
          ) : (
            <div className="thin-scroll max-h-96 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/10">
                    <TableHead className="text-zinc-400">Tên</TableHead>
                    <TableHead className="text-zinc-400">Dung lượng</TableHead>
                    <TableHead className="text-zinc-400">Thời gian</TableHead>
                    <TableHead className="text-zinc-400">Bucket</TableHead>
                    <TableHead className="text-right text-zinc-400">Hành động</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {local.map((b) => (
                    <TableRow key={b.id} className="border-white/5">
                      <TableCell className="max-w-[180px] truncate font-medium text-zinc-200" title={b.name}>
                        {b.name}
                      </TableCell>
                      <TableCell className="num whitespace-nowrap text-zinc-300">
                        {formatBytes(b.sizeBytes)}
                      </TableCell>
                      <TableCell className="num whitespace-nowrap text-zinc-400">
                        {formatTime(b.createdAt)}
                      </TableCell>
                      <TableCell>
                        {b.uploaded ? (
                          <Badge className="rounded-full border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
                            Đã tải lên
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="rounded-full border-white/10 text-zinc-500">
                            Chưa tải lên
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            title={b.uploaded ? 'Đã tải lên bucket' : 'Tải lên bucket'}
                            aria-label={b.uploaded ? `Bản backup ${b.name} đã tải lên bucket` : `Tải bản backup ${b.name} lên bucket`}
                            disabled={b.uploaded || busyLocalId === b.id}
                            className="h-9 rounded-lg px-2.5 text-zinc-300 hover:text-white disabled:opacity-40"
                            onClick={() => uploadOne(b)}
                          >
                            {busyLocalId === b.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <UploadCloud className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Tải về (link pre-signed)"
                            aria-label={`Tải về bản backup ${b.name}`}
                            disabled={!b.uploaded || busyLocalId === b.id}
                            className="h-9 rounded-lg px-2.5 text-zinc-300 hover:text-white disabled:opacity-40"
                            onClick={() => downloadLocal(b)}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                size="sm"
                                variant="ghost"
                                title="Dùng lại backup này (khôi phục về máy chủ)"
                                aria-label={`Dùng lại backup ${b.name}`}
                                disabled={busyLocalId === b.id}
                                className="h-9 rounded-lg px-2.5 text-zinc-300 hover:text-white disabled:opacity-40"
                              >
                                {busyLocalId === b.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RotateCcw className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent className="glass rounded-2xl border-white/10">
                              <AlertDialogHeader>
                                <AlertDialogTitle className="text-zinc-100">
                                  Dùng lại backup này?
                                </AlertDialogTitle>
                                <AlertDialogDescription className="text-zinc-400">
                                  Backup <span className="num">{b.name}</span> sẽ được giải nén và
                                  GHI ĐÈ code hiện tại (src, prisma, scripts, public). Node_modules,
                                  thư mục upload, file .env và database đang chạy KHÔNG bị ghi đè.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel className="rounded-xl border-white/10 bg-transparent text-zinc-200 hover:bg-white/10">
                                  Hủy
                                </AlertDialogCancel>
                                <AlertDialogAction
                                  className="rounded-xl text-black"
                                  style={{ background: 'var(--accent-1)' }}
                                  onClick={() => restoreLocal(b)}
                                >
                                  Khôi phục
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                size="sm"
                                variant="ghost"
                                title="Xóa bản backup này"
                                aria-label={`Xóa bản backup ${b.name}`}
                                disabled={busyLocalId === b.id}
                                className="h-9 rounded-lg px-2.5 text-rose-400 hover:text-rose-300"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent className="glass rounded-2xl border-white/10">
                              <AlertDialogHeader>
                                <AlertDialogTitle className="text-zinc-100">
                                  Xóa bản backup trên máy chủ?
                                </AlertDialogTitle>
                                <AlertDialogDescription className="text-zinc-400">
                                  File <span className="num">{b.name}</span> sẽ bị xóa vĩnh viễn khỏi
                                  máy chủ. Bản copy trên bucket (nếu đã tải lên) vẫn được giữ.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel className="rounded-xl border-white/10 bg-transparent text-zinc-200 hover:bg-white/10">
                                  Hủy
                                </AlertDialogCancel>
                                <AlertDialogAction
                                  className="rounded-xl bg-rose-600 text-white hover:bg-rose-500"
                                  onClick={() => deleteLocal(b.id)}
                                >
                                  Xóa
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>

        {/* Bucket */}
        <Card className="glass rounded-2xl p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Cloud className="h-4 w-4" style={{ color: 'var(--accent-1)' }} />
            Trên bucket (30GB)
            <Badge variant="outline" className="num ml-auto rounded-full border-white/10 text-zinc-400">
              {loading ? '...' : bucket.length}
            </Badge>
          </h3>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full rounded-xl" />
              <Skeleton className="h-10 w-full rounded-xl" />
            </div>
          ) : bucket.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Cloud className="h-8 w-8 text-zinc-400" />
              <p className="text-sm text-zinc-500">
                Chưa có backup nào trên bucket — bấm “Tải lên bucket” ở bảng bên trái.
              </p>
            </div>
          ) : (
            <div className="thin-scroll max-h-96 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/10">
                    <TableHead className="text-zinc-400">Key</TableHead>
                    <TableHead className="text-zinc-400">Dung lượng</TableHead>
                    <TableHead className="text-zinc-400">Ngày</TableHead>
                    <TableHead className="text-right text-zinc-400">Hành động</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bucket.map((item: BackupBucketItem) => {
                    const busy = busyBucketKey === item.key
                    return (
                      <TableRow key={item.key} className="border-white/5">
                        <TableCell className="max-w-[200px] truncate text-zinc-200" title={item.key}>
                          {item.key}
                        </TableCell>
                        <TableCell className="num whitespace-nowrap text-zinc-300">
                          {formatBytes(item.sizeBytes)}
                        </TableCell>
                        <TableCell className="num whitespace-nowrap text-zinc-400">
                          {formatTime(item.lastModified)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Tải về (link pre-signed)"
                              aria-label={`Tải về backup ${item.key} từ bucket`}
                              disabled={busy}
                              className="h-9 rounded-lg px-2.5 text-zinc-300 hover:text-white"
                              onClick={() => downloadBucket(item.key)}
                            >
                              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  title="Khôi phục về máy chủ"
                                  aria-label={`Khôi phục backup ${item.key} về máy chủ`}
                                  disabled={busy}
                                  className="h-9 rounded-lg px-2.5 text-zinc-300 hover:text-white"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent className="glass rounded-2xl border-white/10">
                                <AlertDialogHeader>
                                  <AlertDialogTitle className="text-zinc-100">
                                    Khôi phục từ bucket?
                                  </AlertDialogTitle>
                                  <AlertDialogDescription className="text-zinc-400">
                                    Backup <span className="num">{item.key}</span> sẽ được tải về và
                                    giải nén vào thư mục dự án. Node_modules, thư mục upload và file
                                    .env sẽ KHÔNG bị ghi đè.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel className="rounded-xl border-white/10 bg-transparent text-zinc-200 hover:bg-white/10">
                                    Hủy
                                  </AlertDialogCancel>
                                  <AlertDialogAction
                                    className="rounded-xl text-black"
                                    style={{ background: 'var(--accent-1)' }}
                                    onClick={() => restoreBucket(item.key)}
                                  >
                                    Khôi phục
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  title="Xóa object trên bucket"
                                  aria-label={`Xóa backup ${item.key} trên bucket`}
                                  disabled={busy}
                                  className="h-9 rounded-lg px-2.5 text-rose-400 hover:text-rose-300"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent className="glass rounded-2xl border-white/10">
                                <AlertDialogHeader>
                                  <AlertDialogTitle className="text-zinc-100">
                                    Xóa backup trên bucket?
                                  </AlertDialogTitle>
                                  <AlertDialogDescription className="text-zinc-400">
                                    Object <span className="num">{item.key}</span> sẽ bị xóa vĩnh
                                    viễn khỏi bucket và không thể khôi phục lại.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel className="rounded-xl border-white/10 bg-transparent text-zinc-200 hover:bg-white/10">
                                    Hủy
                                  </AlertDialogCancel>
                                  <AlertDialogAction
                                    className="rounded-xl bg-rose-600 text-white hover:bg-rose-500"
                                    onClick={() => deleteBucket(item.key)}
                                  >
                                    Xóa
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      </div>

      {/* GitHub Actions card */}
      <Card className="glass rounded-2xl p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex items-start gap-3">
            <div
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10"
              style={{ background: 'color-mix(in srgb, var(--accent-2) 14%, transparent)' }}
            >
              <Github className="h-5 w-5" style={{ color: 'var(--accent-2)' }} />
            </div>
            <div className="space-y-2">
              <h3 className="text-base font-semibold text-zinc-100">
                Tự động sao lưu bằng GitHub Actions
              </h3>
              <ul className="max-w-3xl space-y-1.5 text-sm text-zinc-400">
                <li className="flex gap-2">
                  <span style={{ color: 'var(--accent-1)' }}>•</span>
                  Repo GitHub chứa workflow chạy tự động <strong className="text-zinc-200">hằng ngày lúc 02:00 giờ Việt Nam</strong> (cron theo múi giờ Asia/Ho_Chi_Minh).
                </li>
                <li className="flex gap-2">
                  <span style={{ color: 'var(--accent-1)' }}>•</span>
                  Có thể bấm <strong className="text-zinc-200">&quot;Run workflow&quot;</strong> thủ công ngay trên GitHub để backup bất cứ lúc nào.
                </li>
                <li className="flex gap-2">
                  <span style={{ color: 'var(--accent-1)' }}>•</span>
                  Backup được nén thành file .tar.gz rồi đẩy thẳng vào bucket 30GB (nền tảng S3 tương thích), key dạng <span className="num">nexus-backups/...</span>.
                </li>
                <li className="flex gap-2">
                  <span style={{ color: 'var(--accent-1)' }}>•</span>
                  Thông tin xác thực được lưu dưới dạng GitHub Secrets — không bao giờ nằm trong mã nguồn.
                </li>
              </ul>
            </div>
          </div>
          <a href="https://github.com/" target="_blank" rel="noopener noreferrer" className="shrink-0">
            <Badge
              variant="outline"
              className="cursor-pointer rounded-full border-white/15 px-4 py-2 text-zinc-100 hover:bg-white/10"
            >
              <Github className="mr-1.5 h-3.5 w-3.5" />
              Mở GitHub Actions
            </Badge>
          </a>
        </div>
      </Card>
    </div>
  )
}

export default BackupPanel
