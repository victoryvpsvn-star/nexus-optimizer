'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, CheckCircle2, Download, RefreshCw, Stethoscope, Trash2, Wrench } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import type { ScreenshotInfo } from '@/lib/types'
import { formatBytes, formatTime } from '@/lib/format'

interface Diagnostic {
  id: string
  name: string
  ok: boolean
  detail: string
}

export function ScreenshotPanel() {
  const [busy, setBusy] = useState(false)
  const [shots, setShots] = useState<ScreenshotInfo[]>([])
  const [diag, setDiag] = useState<Diagnostic[]>([])
  const [lastError, setLastError] = useState<string>('')
  const rootRef = useRef<HTMLElement | null>(null)

  const loadShots = useCallback(async () => {
    try {
      const r = await fetch('/api/screenshot', { cache: 'no-store' })
      const data = (await r.json()) as { shots?: ScreenshotInfo[] }
      setShots(data.shots ?? [])
    } catch {
      /* im lặng */
    }
  }, [])

  useEffect(() => {
    loadShots()
  }, [loadShots])

  const runDiagnostics = useCallback(async (): Promise<Diagnostic[]> => {
    const results: Diagnostic[] = []
    // 1. Canvas API
    try {
      const c = document.createElement('canvas')
      c.width = 8
      c.height = 8
      const ok = c.toDataURL('image/png').startsWith('data:image/png')
      results.push({ id: 'canvas', name: 'Canvas API hoạt động', ok, detail: ok ? 'toDataURL bình thường' : 'toDataURL trả về dữ liệu sai' })
    } catch (e) {
      results.push({ id: 'canvas', name: 'Canvas API hoạt động', ok: false, detail: `Lỗi: ${(e as Error).message}` })
    }
    // 2. Thư viện chụp
    let libOk = false
    try {
      const mod = await import('html-to-image')
      libOk = typeof mod.toPng === 'function'
    } catch {
      libOk = false
    }
    results.push({
      id: 'lib',
      name: 'Thư viện html-to-image',
      ok: libOk,
      detail: libOk ? 'Đã nạp được module' : 'Không nạp được module',
    })
    // 3. Kích thước trang
    const tooBig = document.documentElement.scrollWidth > 8000
    results.push({
      id: 'size',
      name: 'Kích thước trang trong giới hạn',
      ok: !tooBig,
      detail: `${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}px`,
    })
    // 4. API máy chủ
    let apiOk = false
    try {
      const r = await fetch('/api/screenshot', { cache: 'no-store' })
      apiOk = r.ok
    } catch {
      apiOk = false
    }
    results.push({
      id: 'api',
      name: 'API lưu ảnh máy chủ',
      ok: apiOk,
      detail: apiOk ? 'Phản hồi bình thường' : 'API không phản hồi',
    })
    setDiag(results)
    return results
  }, [])

  useEffect(() => {
    runDiagnostics()
  }, [runDiagnostics])

  const capture = async (recoveryMode = false) => {
    setBusy(true)
    setLastError('')
    try {
      const { toPng } = await import('html-to-image')
      const node = document.getElementById('app-root')
      if (!node) throw new Error('Không tìm thấy vùng chụp (#app-root)')
      const opts: Record<string, unknown> = {
        backgroundColor: '#09090b',
        pixelRatio: recoveryMode ? 1 : Math.min(window.devicePixelRatio || 1, 2),
        skipFonts: recoveryMode,
        cacheBust: true,
        filter: (n: HTMLElement) => !(n?.dataset?.html2canvasSkip === '1'),
      }
      if (recoveryMode) {
        opts.width = Math.min(node.scrollWidth, 1920)
        opts.height = Math.min(node.scrollHeight, 4000)
      }
      const dataUrl = await toPng(node, opts)
      const r = await fetch('/api/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      })
      const data = (await r.json()) as ScreenshotInfo & { error?: string }
      if (data.error) throw new Error(data.error)
      toast.success('Đã chụp và lưu ảnh chụp màn hình')
      loadShots()
    } catch (e) {
      const msg = (e as Error).message || 'Chụp màn hình thất bại'
      setLastError(msg)
      if (!recoveryMode) {
        toast.warning(`Chụp lỗi (${msg}) — đang thử chế độ khôi phục...`)
        await capture(true)
      } else {
        toast.error(`Chụp màn hình vẫn lỗi: ${msg}. Hãy bấm "Tự động sửa" và thử lại.`)
      }
    } finally {
      setBusy(false)
    }
  }

  const autoFix = async () => {
    const results = await runDiagnostics()
    const bad = results.filter((d) => !d.ok)
    if (bad.length === 0) {
      toast.success('Mọi thứ bình thường! Thử lại lần chụp với chế độ nhẹ (bỏ font, tỉ lệ 1x).')
      await capture(true)
      return
    }
    // Sửa lỗi thường gặp: nén trang quá dài, tắt filter/backdrop tạm thời trong lúc chụp
    toast.info(`Phát hiện ${bad.length} vấn đề — đang áp dụng khắc phục...`)
    document.documentElement.classList.add('fix-capture')
    await capture(true)
    document.documentElement.classList.remove('fix-capture')
    await runDiagnostics()
  }

  const removeShot = async (f: string) => {
    try {
      await fetch(`/api/screenshot?file=${encodeURIComponent(f)}`, { method: 'DELETE' })
      loadShots()
      toast.success('Đã xóa ảnh')
    } catch {
      toast.error('Không xóa được ảnh')
    }
  }

  return (
    <div className="space-y-4">
      <Card className="glass rounded-2xl p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => capture(false)}
            disabled={busy}
            className="rounded-xl font-semibold text-black"
            style={{ background: 'var(--accent-1)' }}
          >
            <Camera className="mr-1 h-4 w-4" />
            {busy ? 'Đang chụp...' : 'Chụp màn hình dashboard'}
          </Button>
          <Button
            onClick={autoFix}
            disabled={busy}
            variant="outline"
            className="rounded-xl border-white/15 text-zinc-100 hover:bg-white/10"
          >
            <Wrench className="mr-1 h-4 w-4" />
            Tự động sửa lỗi chụp
          </Button>
          <Button
            onClick={() => runDiagnostics().then(() => toast.success('Đã chạy lại chẩn đoán'))}
            variant="outline"
            className="rounded-xl border-white/15 text-zinc-100 hover:bg-white/10"
          >
            <Stethoscope className="mr-1 h-4 w-4" />
            Chẩn đoán
          </Button>
          {lastError && (
            <Badge variant="outline" className="rounded-full border-rose-500/40 text-rose-400">
              Lỗi cuối: {lastError}
            </Badge>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="glass rounded-2xl p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Stethoscope className="h-4 w-4" style={{ color: 'var(--accent-2)' }} />
            Chẩn đoán hệ thống chụp
          </h3>
          <div className="space-y-2">
            {diag.map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded-xl border border-white/5 bg-white/5 px-3 py-2">
                <div>
                  <p className="text-sm text-zinc-200">{d.name}</p>
                  <p className="num text-xs text-zinc-500">{d.detail}</p>
                </div>
                {d.ok ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                ) : (
                  <RefreshCw className="h-4 w-4 shrink-0 text-amber-400" />
                )}
              </div>
            ))}
          </div>
        </Card>

        <Card className="glass rounded-2xl p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Camera className="h-4 w-4" style={{ color: 'var(--accent-1)' }} />
            Thư viện ảnh chụp ({shots.length})
          </h3>
          {shots.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">
              Chưa có ảnh nào — bấm &quot;Chụp màn hình dashboard&quot; để tạo ảnh đầu tiên.
            </p>
          ) : (
            <div className="thin-scroll grid max-h-[420px] grid-cols-2 gap-3 overflow-y-auto">
              {shots.map((s) => (
                <div key={s.file} className="group relative overflow-hidden rounded-xl border border-white/10">
                  <img src={s.url} alt={`Ảnh chụp ${formatTime(s.createdAt)}`} className="w-full object-cover" />
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/70 px-2 py-1.5 opacity-100 transition lg:opacity-0 lg:group-hover:opacity-100">
                    <span className="num text-[10px] text-zinc-300">
                      {formatTime(s.createdAt)} · {formatBytes(s.sizeBytes)}
                    </span>
                    <span className="flex gap-1">
                      <a href={s.url} download={s.file} aria-label={`Tải xuống ${s.file}`}>
                        <Button size="sm" variant="ghost" className="h-7 rounded-lg px-1.5 text-zinc-300 hover:text-white">
                          <Download className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </a>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 rounded-lg px-1.5 text-rose-400 hover:text-rose-300"
                        onClick={() => removeShot(s.file)}
                        aria-label={`Xóa ảnh ${s.file}`}
                        title={`Xóa ảnh ${s.file}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
