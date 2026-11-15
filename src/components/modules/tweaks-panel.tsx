'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  CircleSlash,
  Layers,
  ListChecks,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Zap,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import type { RiskLevel, Tweak, TweakRunResult } from '@/lib/types'

const CATEGORIES = ['Hiệu năng', 'Mạng', 'Bộ nhớ', 'Bảo mật & riêng tư', 'Gaming'] as const

const RISK_META: Record<RiskLevel, { label: string; cls: string }> = {
  low: { label: 'Thấp', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' },
  medium: { label: 'Trung bình', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
  high: { label: 'Cao', cls: 'border-rose-500/40 bg-transparent text-rose-400' },
}

export function TweaksPanel() {
  const [tweaks, setTweaks] = useState<Tweak[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState<string>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [rowBusy, setRowBusy] = useState<string>('')

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/tweaks', { cache: 'no-store' })
      const data = (await r.json().catch(() => null)) as { tweaks?: Tweak[]; error?: string } | null
      if (!r.ok || !data || data.error) throw new Error(data?.error ?? 'Không tải được danh sách tinh chỉnh')
      setTweaks(data.tweaks ?? [])
    } catch (e) {
      /* giữ danh sách cũ khi lỗi — chỉ báo lỗi trung thực */
      toast.error((e as Error).message || 'Không tải được danh sách tinh chỉnh')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(
    () => (category === 'all' ? tweaks : tweaks.filter((t) => t.category === category)),
    [tweaks, category],
  )

  const recommendedIds = useMemo(() => tweaks.filter((t) => t.recommended).map((t) => t.id), [tweaks])

  const toggleSelect = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const runIds = useCallback(
    async (ids: string[], action: 'apply' | 'revert') => {
      if (ids.length === 0) {
        toast.warning('Chưa chọn tinh chỉnh nào')
        return
      }
      setBusy(true)
      const actionLabel = action === 'apply' ? 'Áp dụng' : 'Khôi phục'
      toast.info(`${actionLabel} ${ids.length} tinh chỉnh...`)
      try {
        const r = await fetch('/api/tweaks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, action }),
        })
        const data = (await r.json().catch(() => null)) as { results?: TweakRunResult[]; error?: string } | null
        if (!r.ok || !data || data.error) throw new Error(data?.error ?? 'Lỗi API')
        const results = data.results ?? []
        if (results.length === 0) {
          toast.warning(`${actionLabel}: máy chủ không trả về kết quả nào`)
        } else {
          const ok = results.filter((x) => x.success).length
          const fail = results.length - ok
          if (fail === 0) {
            toast.success(`${actionLabel}: ${ok}/${results.length} thành công`)
          } else {
            toast.warning(`${actionLabel}: ${ok} thành công, ${fail} lỗi (xem kết quả từng dòng)`)
          }
        }
        await load()
      } catch (e) {
        toast.error((e as Error).message || `Lỗi khi ${actionLabel.toLowerCase()} tinh chỉnh`)
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const runOne = useCallback(
    async (id: string, action: 'apply' | 'revert') => {
      setRowBusy(id)
      try {
        const r = await fetch('/api/tweaks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [id], action }),
        })
        const data = (await r.json().catch(() => null)) as { results?: TweakRunResult[]; error?: string } | null
        if (!r.ok || !data || data.error) throw new Error(data?.error ?? 'Lỗi API')
        const res = data.results?.[0]
        if (res?.success) {
          toast.success(`${action === 'apply' ? 'Áp dụng' : 'Khôi phục'} thành công: ${res.message}`)
        } else {
          toast.warning(`${action === 'apply' ? 'Áp dụng' : 'Khôi phục'} chưa hoàn tất: ${res?.message ?? 'Lỗi không rõ'}`)
        }
        await load()
      } catch (e) {
        toast.error((e as Error).message || 'Lỗi kết nối tới máy chủ')
      } finally {
        setRowBusy('')
      }
    },
    [load],
  )

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <Card className="glass rounded-2xl p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="outline" className="rounded-full border-white/10 text-zinc-400">
            <ListChecks className="mr-1 h-3.5 w-3.5" />
            {tweaks.length} tinh chỉnh · {recommendedIds.length} khuyến nghị
          </Badge>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger
              size="sm"
              className="w-[220px] rounded-xl border-white/15 bg-white/5 text-zinc-100"
              aria-label="Lọc theo danh mục"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-xl border-white/10 bg-zinc-900/95 text-zinc-100">
              <SelectItem value="all">Tất cả danh mục</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              onClick={() => runIds(recommendedIds, 'apply')}
              disabled={busy}
              className="rounded-xl font-semibold text-black"
              style={{ background: 'var(--accent-1)' }}
            >
              <Sparkles className="mr-1 h-4 w-4" />
              {busy ? 'Đang chạy...' : `Áp dụng bộ khuyến nghị (${recommendedIds.length})`}
            </Button>
            <Button
              onClick={() => runIds([...selected], 'apply')}
              disabled={busy || selected.size === 0}
              variant="outline"
              className="rounded-xl border-white/15 font-semibold text-zinc-100 hover:bg-white/10"
            >
              <Zap className="mr-1 h-4 w-4" style={{ color: 'var(--accent-2)' }} />
              Áp dụng đã chọn ({selected.size})
            </Button>
            <Button
              onClick={() => runIds([...selected], 'revert')}
              disabled={busy || selected.size === 0}
              variant="outline"
              className="rounded-xl border-white/15 font-semibold text-zinc-100 hover:bg-white/10"
            >
              <RotateCcw className="mr-1 h-4 w-4" />
              Khôi phục đã chọn ({selected.size})
            </Button>
          </div>
        </div>
      </Card>

      {/* Danh sách xếp hạng */}
      <Card className="glass rounded-2xl p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <Layers className="h-4 w-4" style={{ color: 'var(--accent-1)' }} />
          Bảng xếp hạng tinh chỉnh (theo độ tác động)
        </h3>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-xl bg-white/5" />
            ))}
          </div>
        ) : (
          <div className="thin-scroll max-h-[560px] space-y-2 overflow-y-auto pr-1">
            {filtered.map((t) => {
              const risk = RISK_META[t.risk as RiskLevel]
              const isRowBusy = rowBusy === t.id
              return (
                <div
                  key={t.id}
                  className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/5 px-3 py-2.5 transition hover:border-white/15"
                >
                  <span className="num w-8 shrink-0 text-center text-sm font-bold text-zinc-500" title={`Thứ hạng ${t.order}`}>
                    #{t.order}
                  </span>
                  <Checkbox
                    checked={selected.has(t.id)}
                    onCheckedChange={(v) => toggleSelect(t.id, v === true)}
                    aria-label={`Chọn ${t.name}`}
                    className="size-5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-sm font-semibold text-zinc-100">{t.name}</p>
                      <Badge variant="outline" className={`h-5 rounded-full px-2 text-[10px] ${risk.cls}`}>
                        Rủi ro {risk.label}
                      </Badge>
                      {t.requiresRoot && (
                        <Badge
                          variant="outline"
                          className="h-5 rounded-full border-white/10 bg-transparent px-2 text-[10px] text-zinc-500"
                        >
                          <ShieldAlert className="mr-0.5 h-3 w-3" />
                          Cần root
                        </Badge>
                      )}
                      {t.recommended && (
                        <Badge
                          variant="outline"
                          className="h-5 rounded-full border-white/10 bg-transparent px-2 text-[10px] text-zinc-400"
                        >
                          Khuyến nghị
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-zinc-500">{t.description}</p>
                    <p className="num truncate text-[11px] text-zinc-400" title={t.lastResult || undefined}>
                      {t.category} · {t.lastResult ? `Kết quả: ${t.lastResult}` : 'Chưa chạy lần nào'}
                    </p>
                  </div>
                  {t.applied ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-emerald-400">
                          <CheckCircle2 className="h-4 w-4" />
                          Đã áp dụng
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[320px] border-white/10 bg-zinc-900/95 text-zinc-200">
                        {t.lastResult ?? 'Đã áp dụng'}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-zinc-400">
                      <CircleSlash className="h-4 w-4" />
                      Chưa áp dụng
                    </span>
                  )}
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || isRowBusy}
                      onClick={() => runOne(t.id, 'apply')}
                      className="h-9 rounded-lg border-white/15 px-3 text-xs font-semibold text-zinc-100 hover:bg-white/10"
                      aria-label={`Áp dụng tinh chỉnh ${t.name}`}
                      title={`Áp dụng: ${t.name}`}
                    >
                      {isRowBusy ? '...' : 'Áp dụng'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || isRowBusy}
                      onClick={() => runOne(t.id, 'revert')}
                      className="h-9 rounded-lg px-3 text-xs text-zinc-400 hover:text-white"
                      aria-label={`Khôi phục tinh chỉnh ${t.name}`}
                      title={`Khôi phục: ${t.name}`}
                    >
                      Khôi phục
                    </Button>
                  </div>
                </div>
              )
            })}
            {filtered.length === 0 && (
              <p className="py-8 text-center text-sm text-zinc-500">Không có tinh chỉnh nào trong danh mục này.</p>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}

export default TweaksPanel
