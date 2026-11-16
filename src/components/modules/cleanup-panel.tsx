'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  CheckCircle2,
  HardDriveDownload,
  History,
  Info,
  Loader2,
  MemoryStick,
  RefreshCw,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import type { ReactNode } from 'react'
import type {
  CleanupLogEntry,
  CleanupRunResponse,
  CleanupScanResponse,
  CleanupTargetInfo,
} from '@/lib/types'
import { formatBytes, formatTime } from '@/lib/format'

type BusyType = 'scan' | 'disk' | 'ram' | 'all' | null

const TARGET_NAMES: Record<string, string> = {
  'npm-cache': 'Bộ nhớ đệm npm',
  'pip-cache': 'Bộ nhớ đệm pip',
  'bun-cache': 'Bộ nhớ đệm Bun',
  thumbnails: 'Ảnh thu nhỏ (thumbnails)',
  'tmp-files': 'Tệp rác trong /tmp',
  screenshots: 'Ảnh chụp màn hình cũ',
  'ram-kernel': 'RAM hạt nhân (drop_caches)',
}

function nameOf(id: string): string {
  return TARGET_NAMES[id] ?? id
}

const outlineBtn =
  'rounded-xl border-white/15 font-semibold text-zinc-100 hover:bg-white/10'

export default function CleanupPanel() {
  const [busyType, setBusyType] = useState<BusyType>(null)
  const [loaded, setLoaded] = useState(false)
  const [targets, setTargets] = useState<CleanupTargetInfo[]>([])
  const [logs, setLogs] = useState<CleanupLogEntry[]>([])
  const [ramNote, setRamNote] = useState('')
  const [hasRun, setHasRun] = useState(false)
  const [lastDisk, setLastDisk] = useState(0)
  const [lastRam, setLastRam] = useState(0)

  const busy = busyType !== null

  // Nạp dữ liệu im lặng (dùng lại sau mỗi lần dọn để cập nhật bảng + lịch sử)
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/cleanup', { cache: 'no-store' })
      if (!r.ok) return
      const data = (await r.json()) as CleanupScanResponse
      setTargets(data.targets ?? [])
      setLogs(data.logs ?? [])
      setRamNote(data.ramNote ?? '')
      setLoaded(true)
    } catch {
      /* im lặng */
    }
  }, [])

  const scan = useCallback(async () => {
    setBusyType('scan')
    await load()
    setBusyType(null)
  }, [load])

  useEffect(() => {
    load()
  }, [load])

  const runAction = async (action: 'disk' | 'ram' | 'all') => {
    setBusyType(action)
    toast.info(
      action === 'all'
        ? 'Đang dọn Disk + RAM cùng lúc...'
        : action === 'disk'
          ? 'Đang dọn Disk...'
          : 'Đang dọn RAM...',
    )
    try {
      const r = await fetch('/api/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!r.ok) throw new Error('API lỗi')
      const data = (await r.json()) as CleanupRunResponse
      setLastDisk(data.totalFreedDisk ?? 0)
      setLastRam(data.totalFreedRam ?? 0)
      setHasRun(true)

      const failed = (data.results ?? []).filter((x) => !x.success)
      if (failed.length === 0) {
        toast.success(
          `Hoàn tất! Disk: ${formatBytes(data.totalFreedDisk ?? 0)} · RAM: ${formatBytes(data.totalFreedRam ?? 0)}`,
        )
      } else {
        toast.warning(
          `Hoàn tất một phần — Disk: ${formatBytes(data.totalFreedDisk ?? 0)} · RAM: ${formatBytes(data.totalFreedRam ?? 0)}`,
          {
            description: `Không thành công: ${failed.map((f) => nameOf(f.id)).join(', ')}`,
          },
        )
      }
      await load() // làm mới bảng mục tiêu + lịch sử sau khi dọn
    } catch {
      toast.error('Lỗi khi gọi API dọn dẹp — vui lòng thử lại')
    } finally {
      setBusyType(null)
    }
  }

  const busyLabel = (mine: Exclude<BusyType, null>, idle: ReactNode) => {
    if (busyType !== mine) return idle
    return (
      <>
        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        {mine === 'scan' ? 'Đang quét...' : 'Đang dọn...'}
      </>
    )
  }

  return (
    <div className="space-y-4">
      {/* Hero: tiêu đề + các nút hành động */}
      <Card className="glass rounded-2xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
              <Sparkles className="h-5 w-5" style={{ color: 'var(--accent-1)' }} />
              Dọn dẹp hệ thống
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              Giải phóng Disk và RAM cùng lúc chỉ với một cú nhấp.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={scan}
              disabled={busy}
              variant="outline"
              className={outlineBtn}
              aria-label="Quét mục tiêu dọn dẹp"
            >
              {busyLabel('scan', (
                <>
                  <RefreshCw className="mr-1 h-4 w-4" />
                  Quét mục tiêu
                </>
              ))}
            </Button>
            <Button
              onClick={() => runAction('disk')}
              disabled={busy}
              variant="outline"
              className={outlineBtn}
              aria-label="Dọn Disk"
            >
              {busyLabel('disk', (
                <>
                  <HardDriveDownload className="mr-1 h-4 w-4" style={{ color: 'var(--accent-1)' }} />
                  Dọn Disk
                </>
              ))}
            </Button>
            <Button
              onClick={() => runAction('ram')}
              disabled={busy}
              variant="outline"
              className={outlineBtn}
              aria-label="Dọn RAM"
            >
              {busyLabel('ram', (
                <>
                  <MemoryStick className="mr-1 h-4 w-4" style={{ color: 'var(--accent-2)' }} />
                  Dọn RAM
                </>
              ))}
            </Button>
            <Button
              onClick={() => runAction('all')}
              disabled={busy}
              className="rounded-xl font-semibold text-black"
              style={{ background: 'var(--accent-1)' }}
              aria-label="Dọn tất cả Disk và RAM cùng lúc"
            >
              {busyLabel('all', (
                <>
                  <Sparkles className="mr-1 h-4 w-4" />
                  Dọn tất cả (cùng lúc)
                </>
              ))}
            </Button>
          </div>
        </div>

        {/* Chip tổng kết sau khi chạy */}
        {hasRun && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge
              variant="outline"
              className="rounded-full border-white/15 bg-white/5 py-1.5 text-zinc-200"
            >
              <HardDriveDownload className="mr-1.5 h-3.5 w-3.5" style={{ color: 'var(--accent-1)' }} />
              Disk đã giải phóng: <span className="num ml-1 font-semibold">{formatBytes(lastDisk)}</span>
            </Badge>
            <Badge
              variant="outline"
              className="rounded-full border-white/15 bg-white/5 py-1.5 text-zinc-200"
            >
              <MemoryStick className="mr-1.5 h-3.5 w-3.5" style={{ color: 'var(--accent-2)' }} />
              RAM đã giải phóng: <span className="num ml-1 font-semibold">{formatBytes(lastRam)}</span>
            </Badge>
          </div>
        )}

        {ramNote && (
          <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-zinc-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-2)' }} />
            <span>{ramNote}</span>
          </p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Bảng mục tiêu dọn dẹp */}
        <Card className="glass rounded-2xl p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <HardDriveDownload className="h-4 w-4" style={{ color: 'var(--accent-1)' }} />
            Mục tiêu dọn dẹp Disk
          </h3>
          <div className="thin-scroll max-h-[340px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-white/10 hover:bg-transparent">
                  <TableHead className="text-zinc-400">Mục tiêu</TableHead>
                  <TableHead className="text-zinc-400">Đường dẫn</TableHead>
                  <TableHead className="text-right text-zinc-400">Dung lượng</TableHead>
                  <TableHead className="text-right text-zinc-400">Trạng thái</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!loaded ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <TableRow key={`sk-${i}`} className="border-white/10">
                      <TableCell colSpan={4}>
                        <Skeleton className="h-5 w-full bg-white/10" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : targets.length === 0 ? (
                  <TableRow className="border-white/10">
                    <TableCell colSpan={4} className="py-8 text-center text-sm text-zinc-500">
                      Không có mục tiêu nào — bấm &quot;Quét mục tiêu&quot; để quét lại.
                    </TableCell>
                  </TableRow>
                ) : (
                  targets.map((t) => (
                    <TableRow key={t.id} className="border-white/10">
                      <TableCell>
                        <p className="text-sm font-medium text-zinc-200">{t.name}</p>
                        {t.note && <p className="text-xs text-zinc-500">{t.note}</p>}
                      </TableCell>
                      <TableCell className="num max-w-[220px] truncate text-xs text-zinc-400">
                        {t.path ?? '—'}
                      </TableCell>
                      <TableCell className="num text-right text-sm text-zinc-200">
                        {formatBytes(t.sizeBytes)}
                      </TableCell>
                      <TableCell className="text-right">
                        {t.canClean ? (
                          <Badge
                            variant="outline"
                            className="rounded-full border-emerald-400/40 text-emerald-400"
                          >
                            Sẵn sàng
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="rounded-full border-white/10 bg-white/5 text-zinc-500"
                          >
                            Không có
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </Card>

        {/* Lịch sử dọn dẹp */}
        <Card className="glass rounded-2xl p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <History className="h-4 w-4" style={{ color: 'var(--accent-1)' }} />
            Lịch sử dọn dẹp
          </h3>
          <div className="thin-scroll max-h-[340px] space-y-2 overflow-y-auto pr-1">
            {!loaded ? (
              Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={`skl-${i}`} className="h-12 w-full rounded-xl bg-white/10" />
              ))
            ) : logs.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">
                Chưa có lần dọn dẹp nào — kết quả sẽ hiện ở đây sau khi bạn bấm dọn.
              </p>
            ) : (
              logs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/5 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge
                      variant="outline"
                      className="shrink-0 rounded-full"
                      style={
                        log.kind === 'ram'
                          ? { borderColor: 'color-mix(in srgb, var(--accent-2) 45%, transparent)', color: 'var(--accent-2)' }
                          : { borderColor: 'rgba(255,255,255,0.15)', color: 'rgb(212 212 216)' }
                      }
                    >
                      {log.kind.toUpperCase()}
                    </Badge>
                    <div className="min-w-0">
                      <p className="truncate text-sm text-zinc-200">{nameOf(log.target)}</p>
                      <p className="num truncate text-xs text-zinc-500">
                        {formatBytes(log.freedBytes)}
                        {log.message ? ` · ${log.message}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="num text-xs text-zinc-500">{formatTime(log.createdAt)}</span>
                    {log.success ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <XCircle className="h-4 w-4 text-rose-400" />
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

// Hỗ trợ cả named import (dùng bởi src/app/page.tsx) và default import
export { CleanupPanel }
