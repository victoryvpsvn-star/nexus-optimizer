'use client'

import { useCallback, useEffect, useState } from 'react'
import { Activity, Skull } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { thresholdColor } from '@/components/dashboard/gauge'
import type { ProcessInfo } from '@/lib/types'

export function ProcessesPanel() {
  const [list, setList] = useState<ProcessInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [target, setTarget] = useState<ProcessInfo | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/processes', { cache: 'no-store' })
      const data = (await r.json()) as { list?: ProcessInfo[] }
      setList(data.list ?? [])
    } catch {
      toast.error('Không tải được tiến trình')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [load])

  const kill = async (p: ProcessInfo) => {
    try {
      const r = await fetch(`/api/processes?pid=${p.pid}`, { method: 'DELETE' })
      const data = (await r.json()) as { success: boolean; message: string }
      if (data.success) toast.success(data.message)
      else toast.warning(data.message)
      load()
    } catch {
      toast.error('Lỗi khi dừng tiến trình')
    }
    setTarget(null)
  }

  return (
    <Card className="glass rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <Activity className="h-4 w-4" style={{ color: 'var(--accent-1)' }} />
          Top tiến trình theo CPU (làm mới 5 giây)
        </h3>
        <Badge variant="outline" className="rounded-full border-white/10 text-zinc-400">
          {list.length} tiến trình
        </Badge>
      </div>
      <div className="thin-scroll max-h-[560px] overflow-y-auto rounded-xl border border-white/5">
        <Table>
          <TableHeader>
            <TableRow className="border-white/5 hover:bg-transparent">
              <TableHead className="text-zinc-400">PID</TableHead>
              <TableHead className="text-zinc-400">Tên</TableHead>
              <TableHead className="text-zinc-400">Người dùng</TableHead>
              <TableHead className="text-right text-zinc-400">CPU %</TableHead>
              <TableHead className="text-right text-zinc-400">RAM %</TableHead>
              <TableHead className="text-right text-zinc-400">RSS</TableHead>
              <TableHead className="text-right text-zinc-400">Hành động</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && list.length === 0 ? (
              Array.from({ length: 3 }, (_, i) => (
                <TableRow key={i} className="border-white/5">
                  <TableCell colSpan={7} className="py-2.5">
                    <Skeleton className="h-5 w-full rounded-lg" />
                  </TableCell>
                </TableRow>
              ))
            ) : list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-zinc-500">
                  Không đọc được danh sách tiến trình
                </TableCell>
              </TableRow>
            ) : (
              list.map((p) => (
                <TableRow key={p.pid} className="border-white/5 hover:bg-white/5">
                  <TableCell className="num text-zinc-400">{p.pid}</TableCell>
                  <TableCell className="font-medium text-zinc-100">{p.name}</TableCell>
                  <TableCell className="text-zinc-400">{p.user}</TableCell>
                  <TableCell
                    className="num text-right font-semibold"
                    style={{ color: thresholdColor(p.cpuPct) }}
                  >
                    {p.cpuPct.toFixed(1)}
                  </TableCell>
                  <TableCell className="num text-right text-zinc-300">{p.memPct.toFixed(1)}</TableCell>
                  <TableCell className="num text-right text-zinc-300">{p.rssMB} MB</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 rounded-lg text-rose-400 hover:bg-rose-500/15 hover:text-rose-300"
                      onClick={() => setTarget(p)}
                      aria-label={`Dừng tiến trình ${p.name}`}
                      title={`Dừng tiến trình ${p.name}`}
                    >
                      <Skull className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={target !== null} onOpenChange={(v) => !v && setTarget(null)}>
        <AlertDialogContent className="glass rounded-2xl border-white/10">
          <AlertDialogHeader>
            <AlertDialogTitle>Dừng tiến trình {target?.name}?</AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              PID {target?.pid} sẽ nhận tín hiệu SIGTERM. Tiến trình của user khác có thể bị từ
              chối do thiếu quyền.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Hủy</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-xl bg-rose-500 text-white hover:bg-rose-600"
              onClick={() => target && kill(target)}
            >
              Dừng tiến trình
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
