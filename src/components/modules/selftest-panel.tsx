'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  CheckCircle2,
  CircleSlash,
  FlaskConical,
  Loader2,
  PlayCircle,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
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
import type { SelftestItem, SelftestReport } from '@/lib/selftest'

interface RuntimeInfo {
  isWin: boolean
  platform: string
  powershellFound?: boolean
  powershellPath?: string
  powershellDetail?: string
  admin?: boolean
  adminMethod?: string
  regOk?: boolean
  note?: string
}

interface SelftestInfo {
  runtime: RuntimeInfo
  catalog: { total: number; recommended: number; applied: number }
  webhook: { configured: boolean; masked: string }
}

function StatusDot({ ok, skipped }: { ok: boolean; skipped?: boolean }) {
  if (skipped) return <CircleSlash className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
  return ok ? (
    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
  ) : (
    <XCircle className="h-4 w-4 shrink-0 text-rose-400" aria-hidden />
  )
}

export function SelftestPanel() {
  const [info, setInfo] = useState<SelftestInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [webhookInput, setWebhookInput] = useState('')
  const [sendWebhook, setSendWebhook] = useState(false)
  const [running, setRunning] = useState<'check' | 'full' | null>(null)
  const [report, setReport] = useState<SelftestReport | null>(null)
  const [elevating, setElevating] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/selftest', { cache: 'no-store' })
      const data = (await r.json().catch(() => null)) as SelftestInfo & { error?: string } | null
      if (!r.ok || !data || data.error) throw new Error(data?.error ?? 'Không tải được trạng thái self-test')
      setInfo(data)
    } catch (e) {
      toast.error((e as Error).message || 'Không tải được trạng thái self-test')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const runTest = useCallback(
    async (mode: 'check' | 'full') => {
      setRunning(mode)
      try {
        const r = await fetch('/api/selftest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, webhook: sendWebhook }),
        })
        const data = (await r.json().catch(() => null)) as { report?: SelftestReport; error?: string } | null
        if (!r.ok || !data?.report) throw new Error(data?.error ?? `API trả về HTTP ${r.status}`)
        setReport(data.report)
        const wh = data.report.webhook.requested
          ? data.report.webhook.ok
            ? ' — báo cáo đã gửi về Discord ✅'
            : ` — webhook lỗi: ${data.report.webhook.detail}`
          : ''
        if (data.report.ok) {
          toast.success(
            `Self-test ${mode === 'full' ? 'FULL' : 'CHECK'} đạt: ${data.report.counts.pass} OK / ${data.report.counts.fail} lỗi${wh}`,
          )
        } else {
          toast.warning(
            `Self-test ${mode === 'full' ? 'FULL' : 'CHECK'} hoàn tất với ${data.report.counts.fail} mục lỗi${wh}`,
          )
        }
        load()
      } catch (e) {
        toast.error((e as Error).message || 'Self-test thất bại')
      } finally {
        setRunning(null)
      }
    },
    [sendWebhook, load],
  )

  const saveWebhook = useCallback(async () => {
    try {
      const r = await fetch('/api/selftest', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl: webhookInput.trim() }),
      })
      const data = (await r.json().catch(() => null)) as
        | { ok?: boolean; error?: string; webhook?: { configured: boolean; masked: string } }
        | null
      if (!r.ok || !data?.ok) throw new Error(data?.error ?? 'Không lưu được webhook')
      toast.success(
        data.webhook?.configured
          ? `Đã lưu webhook (${data.webhook.masked})`
          : 'Đã xóa cấu hình webhook',
      )
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [webhookInput, load])

  const relaunchAdmin = useCallback(async () => {
    setElevating(true)
    try {
      const r = await fetch('/api/system', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'relaunch-admin' }),
      })
      const data = (await r.json().catch(() => null)) as
        | { ok?: boolean; alreadyAdmin?: boolean; message?: string; error?: string }
        | null
      if (!r.ok || (!data?.ok && !data?.alreadyAdmin)) {
        throw new Error(data?.error ?? 'Không nâng quyền được')
      }
      toast.success(data.message ?? 'Đang khởi động lại với quyền Admin…')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setElevating(false)
    }
  }, [])

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    )
  }

  const isWin = info?.runtime.isWin === true
  const admin = info?.runtime.admin === true

  return (
    <div className="space-y-4">
      {/* Trạng thái hệ thống */}
      <Card className="rounded-2xl border-white/10 bg-white/5 p-5 backdrop-blur">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" style={{ color: 'var(--accent-1)' }} aria-hidden />
          <h2 className="text-base font-bold text-zinc-100">Trạng thái hệ thống</h2>
          {isWin ? (
            admin ? (
              <Badge className="rounded-full border-emerald-500/40 bg-emerald-500/10 text-[11px] text-emerald-400">
                Administrator ✅
              </Badge>
            ) : (
              <Badge className="rounded-full border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-400">
                User thường
              </Badge>
            )
          ) : (
            <Badge className="rounded-full border-zinc-500/40 bg-zinc-500/10 text-[11px] text-zinc-400">
              Không phải Windows
            </Badge>
          )}
        </div>
        <div className="grid gap-2 text-sm text-zinc-300 md:grid-cols-2">
          <div className="flex items-center gap-2">
            <StatusDot ok={info?.runtime.powershellFound === true} skipped={!isWin} />
            <span>
              PowerShell:{' '}
              {info?.runtime.powershellFound
                ? info.runtime.powershellPath
                : isWin
                  ? (info?.runtime.powershellDetail ?? 'không rõ')
                  : 'chỉ kiểm tra được trên Windows'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <StatusDot ok={info?.runtime.regOk === true} skipped={!isWin} />
            <span>reg.exe (registry — chạy không cần PowerShell)</span>
          </div>
          <div className="flex items-center gap-2">
            <StatusDot ok={admin} skipped={!isWin} />
            <span>
              Quyền Administrator:{' '}
              {admin
                ? 'có (kiểm tra bằng ghi thử HKLM, không phụ thuộc PowerShell)'
                : isWin
                  ? 'thiếu — các mục HKLM/service/powercfg sẽ báo trung thực'
                  : '—'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <StatusDot ok={(info?.catalog.total ?? 0) > 0} />
            <span>
              Catalog: {info?.catalog.total} tinh chỉnh ({info?.catalog.recommended} khuyến nghị,{' '}
              {info?.catalog.applied} đang bật)
            </span>
          </div>
        </div>
        {isWin && !admin && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-300">
            <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
            <span className="flex-1">
              Muốn áp dụng các mục HKLM/dịch vụ/powercfg? Nâng quyền Admin cho app (UAC sẽ hỏi xác nhận, app tự khởi
              động lại).
            </span>
            <Button
              onClick={relaunchAdmin}
              disabled={elevating}
              size="sm"
              className="rounded-xl"
              aria-label="Chạy lại NEXUS Optimizer với quyền Administrator"
            >
              {elevating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              Chạy lại với quyền Admin
            </Button>
          </div>
        )}
      </Card>

      {/* Chạy self-test */}
      <Card className="rounded-2xl border-white/10 bg-white/5 p-5 backdrop-blur">
        <div className="mb-3 flex items-center gap-2">
          <FlaskConical className="h-5 w-5" style={{ color: 'var(--accent-1)' }} aria-hidden />
          <h2 className="text-base font-bold text-zinc-100">Tự kiểm tra</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => runTest('check')}
            disabled={running !== null}
            className="rounded-xl"
            aria-label="Chạy kiểm tra nhanh (không đổi hệ thống)"
          >
            {running === 'check' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <PlayCircle className="h-4 w-4" aria-hidden />
            )}
            Kiểm tra nhanh (không đổi hệ thống)
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                disabled={running !== null || !isWin}
                title={!isWin ? 'Chỉ chạy được trong bản Windows .exe' : undefined}
                className="rounded-xl"
                aria-label="Chạy tự kiểm tra đầy đủ (áp dụng rồi hoàn tác từng tinh chỉnh)"
              >
                {running === 'full' ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <FlaskConical className="h-4 w-4" aria-hidden />
                )}
                Tự kiểm tra đầy đủ (apply → revert từng mục)
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Chạy self-test FULL?</AlertDialogTitle>
                <AlertDialogDescription>
                  Chế độ FULL sẽ lần lượt <b>áp dụng rồi hoàn tác</b> từng tinh chỉnh trong catalog ({info?.catalog.total}{' '}
                  mục) để xác nhận mỗi mục chạy thật được trên máy này. Hệ thống sẽ quay về trạng thái ban đầu sau mỗi
                  mục; các mục một-lần (dọn DNS/RAM) không có hoàn tác. Không nên dùng khi đang chơi game hoặc chạy tác
                  vụ quan trọng.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Để sau</AlertDialogCancel>
                <AlertDialogAction onClick={() => runTest('full')}>Chạy full test</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <Switch checked={sendWebhook} onCheckedChange={setSendWebhook} aria-label="Gửi báo cáo về Discord webhook" />
            Gửi báo cáo về Discord
          </label>
          {info?.webhook.configured ? (
            <Badge className="rounded-full border-emerald-500/40 bg-emerald-500/10 text-[11px] text-emerald-400">
              webhook: {info.webhook.masked}
            </Badge>
          ) : (
            <Badge className="rounded-full border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-400">
              chưa cấu hình webhook
            </Badge>
          )}
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          Kiểm tra nhanh chỉ đo capability (PowerShell/reg.exe/powercfg/sc.exe/bcdedit + quyền Admin), không đụng vào hệ
          thống. FULL thì áp dụng rồi hoàn tác từng mục và báo trung thực từng bước.
        </p>
      </Card>

      {/* Cấu hình webhook */}
      <Card className="rounded-2xl border-white/10 bg-white/5 p-5 backdrop-blur">
        <div className="mb-3 flex items-center gap-2">
          <Send className="h-5 w-5" style={{ color: 'var(--accent-1)' }} aria-hidden />
          <h2 className="text-base font-bold text-zinc-100">Discord webhook (báo cáo test)</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={webhookInput}
            onChange={(e) => setWebhookInput(e.target.value)}
            placeholder="https://discord.com/api/webhooks/…"
            className="max-w-xl rounded-xl border-white/10 bg-black/20 text-sm"
            aria-label="URL Discord webhook"
          />
          <Button onClick={saveWebhook} size="sm" className="rounded-xl" aria-label="Lưu webhook">
            Lưu
          </Button>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          URL chỉ chấp nhận domain discord.com/discordapp.com; token được che khi hiển thị. Báo cáo gồm trạng thái
          PowerShell/Admin/reg.exe và kết quả từng mục.
        </p>
      </Card>

      {/* Kết quả */}
      {report && (
        <Card className="rounded-2xl border-white/10 bg-white/5 p-5 backdrop-blur">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-zinc-100">
              Kết quả self-test ({report.mode === 'full' ? 'FULL' : 'CHECK'})
            </h2>
            <Badge className="rounded-full border-white/20 bg-white/5 text-[11px] text-zinc-300">
              ✅ {report.counts.pass} · ❌ {report.counts.fail} · ⏭ {report.counts.skipped}
            </Badge>
            <Badge className="rounded-full border-white/20 bg-white/5 text-[11px] text-zinc-400">
              {report.durationMs}ms
            </Badge>
            {report.webhook.requested && (
              <Badge
                className={
                  'rounded-full border text-[11px] ' +
                  (report.webhook.ok
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                    : 'border-rose-500/40 bg-rose-500/10 text-rose-400')
                }
              >
                webhook {report.webhook.ok ? 'đã gửi ✅' : 'lỗi'}
              </Badge>
            )}
          </div>
          <div className="thin-scroll max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
            {report.items.map((it: SelftestItem) => (
              <div
                key={it.id}
                className="flex items-start gap-2 rounded-xl border border-white/5 bg-black/10 px-3 py-2 text-sm"
              >
                <StatusDot ok={it.ok} skipped={it.skipped} />
                <div className="min-w-0">
                  <p className="font-medium text-zinc-200">{it.name}</p>
                  <p className="break-words text-xs text-zinc-500">{it.detail}</p>
                </div>
              </div>
            ))}
            {report.full && (
              <>
                <p className="pt-3 text-sm font-semibold text-zinc-300">Chế độ FULL — apply → revert từng mục:</p>
                {report.full.map((f) => (
                  <div
                    key={`full-${f.id}`}
                    className="flex items-start gap-2 rounded-xl border border-white/5 bg-black/10 px-3 py-2 text-sm"
                  >
                    <StatusDot ok={f.applyOk && f.revertOk} skipped={f.skipped} />
                    <div className="min-w-0">
                      <p className="font-medium text-zinc-200">
                        {f.name}{' '}
                        <span className="text-xs text-zinc-500">
                          (apply {f.applyOk ? '✅' : '❌'} / revert {f.revertOk ? '✅' : '❌'})
                        </span>
                      </p>
                      <p className="break-words text-xs text-zinc-500">{f.applyMsg || f.revertMsg}</p>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}

export default SelftestPanel
