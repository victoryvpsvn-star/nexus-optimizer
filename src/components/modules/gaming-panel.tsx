'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Gamepad2, PowerOff, RefreshCw, Rocket, XCircle } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { useApp } from '@/lib/store'
import { formatTime } from '@/lib/format'
import type { GamingEffect, GamingStatus } from '@/lib/types'

export function GamingPanel() {
  const [status, setStatus] = useState<GamingStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const storeGaming = useApp((s) => s.gaming)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/gaming', { cache: 'no-store' })
      const data = (await r.json().catch(() => null)) as (GamingStatus & { error?: string }) | null
      if (!r.ok || !data || data.error) throw new Error(data?.error ?? 'Lỗi API')
      setStatus({
        enabled: Boolean(data.enabled),
        enabledAt: data.enabledAt,
        effects: Array.isArray(data.effects) ? data.effects : [],
        note: data.note ?? '',
      })
      setLoadFailed(false)
    } catch {
      /* giữ trạng thái cũ khi lỗi — không đưa UI về disabled; cho phép thử lại */
      setLoadFailed(true)
      toast.error('Không tải được trạng thái Gaming Mode')
    }
  }, [])

  // Gọi GET khi mount và khi công tắc toàn cục (topbar) đổi trạng thái — giữ đồng bộ
  useEffect(() => {
    load()
  }, [load, storeGaming])

  const toggle = async (next: boolean) => {
    setBusy(true)
    try {
      const r = await fetch('/api/gaming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const data = (await r.json().catch(() => null)) as (GamingStatus & { error?: string }) | null
      if (!r.ok || !data || data.error) throw new Error(data?.error ?? 'Không bật/tắt được Gaming Mode')
      setStatus({
        enabled: Boolean(data.enabled),
        enabledAt: data.enabledAt,
        effects: Array.isArray(data.effects) ? data.effects : [],
        note: data.note ?? '',
      })
      // Đồng bộ công tắc Gaming toàn cục ở topbar + làm mới hiệu ứng và enabledAt
      useApp.setState({ gaming: next })
      if (next) toast.success('Đã bật Gaming Mode — kiểm tra danh sách hiệu ứng bên dưới')
      else toast.success('Đã tắt Gaming Mode — các tinh chỉnh đã hoàn tác')
      await load()
    } catch (e) {
      toast.error((e as Error).message || 'Không bật/tắt được Gaming Mode — vui lòng thử lại')
    } finally {
      setBusy(false)
    }
  }

  const enabled = status?.enabled ?? false
  const effects: GamingEffect[] = status?.effects ?? []
  const okCount = effects.filter((e) => e.success).length
  const failCount = effects.length - okCount

  return (
    <div className="space-y-4">
      {/* Hero card */}
      <Card className="glass gaming-rgb glow-hover rounded-2xl p-6">
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:justify-between">
          <div className="flex items-center gap-4">
            <div
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl"
              style={{
                background: enabled ? 'var(--accent-1)' : 'rgba(255,255,255,0.08)',
                boxShadow: enabled ? '0 0 32px var(--accent-1)' : 'none',
                transition: 'all .3s',
              }}
            >
              <Gamepad2
                className="h-9 w-9"
                style={{ color: enabled ? '#000' : 'var(--accent-1)' }}
              />
            </div>
            <div>
              <h2 className="text-lg font-bold text-zinc-100">Gaming Mode</h2>
              <p
                className="text-2xl font-extrabold tracking-wide"
                style={{ color: enabled ? 'var(--accent-1)' : 'rgb(113 113 122)' }}
              >
                {enabled ? 'ĐANG BẬT' : 'ĐANG TẮT'}
              </p>
              <p className="mt-0.5 text-xs text-zinc-500">
                {enabled && status?.enabledAt
                  ? `Bật từ ${formatTime(status.enabledAt)} · ${okCount} mục thành công / ${failCount} lỗi`
                  : 'Bật để xả RAM, đẩy CPU governor về hiệu năng tối đa, giảm swap và dọn cache'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {!status && loadFailed ? (
              <Button
                onClick={() => load()}
                variant="outline"
                className="h-11 min-w-40 rounded-xl border-white/15 font-bold text-zinc-100 hover:bg-white/10"
                aria-label="Thử tải lại trạng thái Gaming Mode"
                title="Thử tải lại trạng thái Gaming Mode"
              >
                <RefreshCw className="h-5 w-5" />
                Thử lại
              </Button>
            ) : (
              <>
                <Switch
                  checked={enabled}
                  onCheckedChange={(v) => toggle(v)}
                  disabled={busy || !status}
                  aria-label="Công tắc Gaming Mode"
                  className="h-9 w-16 border-2 data-[state=checked]:bg-[var(--accent-1)] [&_[data-slot=switch-thumb]]:size-7"
                />
                <Button
                  onClick={() => toggle(!enabled)}
                  disabled={busy || !status}
                  className="h-12 min-w-36 rounded-xl text-base font-bold text-black"
                  style={{ background: enabled ? 'transparent' : 'var(--accent-1)', color: enabled ? '#fb7185' : '#000' }}
                  variant={enabled ? 'outline' : 'default'}
                  aria-label={enabled ? 'Tắt Gaming Mode' : 'Bật Gaming Mode'}
                >
                  {busy ? (
                    <span className="flex items-center gap-2">
                      <Rocket className="h-5 w-5 animate-pulse" />
                      Đang xử lý...
                    </span>
                  ) : enabled ? (
                    <span className="flex items-center gap-2">
                      <PowerOff className="h-5 w-5" />
                      TẮT Gaming
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Rocket className="h-5 w-5" />
                      BẬT Gaming
                    </span>
                  )}
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>

      {/* Banner lưu ý trung thực */}
      <Alert className="rounded-2xl border-amber-500/30 bg-amber-500/10 text-amber-300">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle className="text-amber-300">Lưu ý về quyền root</AlertTitle>
        <AlertDescription className="text-amber-200/80">
          {status?.note ||
            'Các tinh chỉnh nhân Linux cần quyền root — trên VPS hiện tại không có sudo nên chúng được báo lỗi trung thực; các mục cấp user vẫn áp dụng.'}
        </AlertDescription>
      </Alert>

      {/* Checklist hiệu ứng */}
      <Card className="glass rounded-2xl p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Rocket className="h-4 w-4" style={{ color: 'var(--accent-2)' }} />
            Hiệu ứng đã thực hiện ({effects.length})
          </h3>
          {effects.length > 0 && (
            <Badge variant="outline" className="rounded-full border-white/10 text-zinc-400">
              {okCount} thành công · {failCount} lỗi
            </Badge>
          )}
        </div>
        {!status ? (
          loadFailed ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <p className="text-sm text-zinc-400">Không tải được trạng thái Gaming Mode — vui lòng thử lại.</p>
              <Button
                onClick={() => load()}
                variant="outline"
                className="h-9 rounded-xl border-white/15 px-4 text-zinc-100 hover:bg-white/10"
                aria-label="Thử tải lại trạng thái Gaming Mode"
                title="Thử tải lại trạng thái Gaming Mode"
              >
                <RefreshCw className="mr-1 h-4 w-4" />
                Thử lại
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-xl bg-white/5" />
              ))}
            </div>
          )
        ) : effects.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">
            Chưa chạy lần nào — gạt công tắc hoặc bấm “BẬT Gaming” để áp dụng bộ tinh chỉnh.
          </p>
        ) : (
          <div className="thin-scroll max-h-72 space-y-2 overflow-y-auto pr-1">
            {effects.map((e) => (
              <div
                key={e.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/5 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-zinc-100">{e.name}</p>
                  <p className="num truncate text-xs text-zinc-500">{e.message}</p>
                </div>
                {e.success ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
                ) : (
                  <XCircle className="h-5 w-5 shrink-0 text-rose-400" />
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

export default GamingPanel
