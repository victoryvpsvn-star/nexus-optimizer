'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Check,
  Download,
  FileJson,
  ImageIcon,
  Palette,
  PenTool,
  Save,
  Upload,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { useApp } from '@/lib/store'
import type { AccentKey, BackgroundKey, ConfigExport, UISettings } from '@/lib/types'

const BACKGROUNDS: { key: BackgroundKey; label: string; preview?: string }[] = [
  { key: 'sakura', label: 'Sakura (mặc định)' },
  { key: 'wall-sakura', label: 'Wallpaper Sakura', preview: '/img/wall-sakura.png' },
  { key: 'gradient', label: 'Gradient tối' },
  { key: 'glow', label: 'Hồ quang neon' },
  { key: 'mesh', label: 'Lưới mesh' },
  { key: 'wall-default', label: 'Wallpaper Nebula', preview: '/img/wall-default.png' },
  { key: 'wall-gaming', label: 'Wallpaper Gaming', preview: '/img/wall-gaming.png' },
  { key: 'custom', label: 'Tùy chỉnh URL' },
]

const ACCENTS: { key: AccentKey; label: string; c1: string; c2: string }[] = [
  { key: 'sakura-pink', label: 'Sakura Pink', c1: '#f06ba8', c2: '#b990e8' },
  { key: 'sakura-lavender', label: 'Sakura Lavender', c1: '#a86ee8', c2: '#f47fb1' },
  { key: 'cyan-violet', label: 'Cyan – Violet', c1: '#22d3ee', c2: '#a78bfa' },
  { key: 'emerald-amber', label: 'Emerald – Amber', c1: '#34d399', c2: '#fbbf24' },
  { key: 'rose-magenta', label: 'Rose – Magenta', c1: '#fb7185', c2: '#e879f9' },
  { key: 'amber-crimson', label: 'Amber – Crimson', c1: '#fbbf24', c2: '#f43f5e' },
]

const ACCENT_KEYS: AccentKey[] = ACCENTS.map((a) => a.key)
const BACKGROUND_KEYS: BackgroundKey[] = BACKGROUNDS.map((b) => b.key)

export function SettingsPanel() {
  const settings = useApp((s) => s.settings)
  const saveSettings = useApp((s) => s.saveSettings)
  const gaming = useApp((s) => s.gaming)
  const [customUrl, setCustomUrl] = useState(settings.customBgUrl)
  const importFileRef = useRef<HTMLInputElement>(null)

  // Giá trị bo góc cục bộ (px): kéo slider chỉ cập nhật local, PUT lên server được debounce 400ms
  const [radiusPx, setRadiusPx] = useState(settings.radius * 16)
  const [prevRadius, setPrevRadius] = useState(settings.radius)
  const radiusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Đồng bộ khi settings.radius đổi từ nguồn ngoài (hydrate, reload) — điều chỉnh state khi render
  if (prevRadius !== settings.radius) {
    setPrevRadius(settings.radius)
    setRadiusPx(settings.radius * 16)
  }

  useEffect(() => {
    return () => {
      if (radiusTimer.current) clearTimeout(radiusTimer.current)
    }
  }, [])

  const persistRadiusNow = (px: number) => {
    if (radiusTimer.current) {
      clearTimeout(radiusTimer.current)
      radiusTimer.current = null
    }
    saveSettings({ radius: px / 16 })
  }

  const pickBg = (key: BackgroundKey) => {
    saveSettings({ background: key })
    toast.success('Đã đổi nền')
  }

  const pickAccent = (key: AccentKey) => {
    saveSettings({ accent: key })
    toast.success('Đã đổi màu nhấn')
  }

  /** Xuất cấu hình ra file JSON tải về máy */
  const exportConfig = async () => {
    try {
      const tr = await fetch('/api/tweaks', { cache: 'no-store' })
      const tj = (await tr.json().catch(() => null)) as
        | { tweaks?: { id: string; applied: boolean }[] }
        | null
      const appliedTweakIds = (tj?.tweaks ?? []).filter((t) => t.applied).map((t) => t.id)
      const data: ConfigExport = {
        app: 'nexus-optimizer',
        type: 'config',
        version: 1,
        exportedAt: new Date().toISOString(),
        settings,
        gaming,
        appliedTweakIds,
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `nexus-config-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 10000)
      toast.success('Đã xuất file cấu hình')
    } catch {
      toast.error('Xuất cấu hình thất bại')
    }
  }

  /** Nhập cấu hình từ file JSON (chỉ áp giao diện, không tự động áp tweak) */
  const importConfig = async (file: File) => {
    try {
      const text = await file.text()
      const data = JSON.parse(text) as Partial<ConfigExport>
      if (data.app !== 'nexus-optimizer' || !data.settings || data.type !== 'config') {
        throw new Error('File không phải cấu hình của NEXUS OPTIMIZER')
      }
      const s = data.settings
      const patch: Partial<UISettings> = {}
      if (typeof s.accent === 'string' && ACCENT_KEYS.includes(s.accent as AccentKey)) {
        patch.accent = s.accent as AccentKey
      }
      if (typeof s.background === 'string' && BACKGROUND_KEYS.includes(s.background as BackgroundKey)) {
        patch.background = s.background as BackgroundKey
      }
      if (
        typeof s.customBgUrl === 'string' &&
        s.customBgUrl.length <= 500 &&
        !/["'\\]/.test(s.customBgUrl) &&
        (s.customBgUrl === '' || /^https?:\/\//i.test(s.customBgUrl) || s.customBgUrl.startsWith('/'))
      ) {
        patch.customBgUrl = s.customBgUrl
      }
      if (typeof s.radius === 'number' && Number.isFinite(s.radius) && s.radius >= 0.5 && s.radius <= 1.5) {
        patch.radius = s.radius
      }
      if (typeof s.petals === 'boolean') {
        patch.petals = s.petals
      }
      await saveSettings(patch)
      if (typeof patch.radius === 'number') setRadiusPx(patch.radius * 16)
      setCustomUrl(typeof patch.customBgUrl === 'string' ? patch.customBgUrl : settings.customBgUrl)
      const tweakNote = data.appliedTweakIds?.length
        ? ` · File có ${data.appliedTweakIds.length} tinh chỉnh — vào tab Tinh chỉnh để áp dụng nếu muốn`
        : ''
      toast.success(`Đã nhập cấu hình${tweakNote}`)
    } catch (e) {
      toast.error((e as Error).message || 'File cấu hình không hợp lệ')
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card className="glass rounded-2xl p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <ImageIcon className="h-4 w-4" style={{ color: 'var(--accent-1)' }} />
          Nền dashboard
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {BACKGROUNDS.map((b) => {
            const active = settings.background === b.key
            return (
              <button
                key={b.key}
                onClick={() => pickBg(b.key)}
                className={`group relative overflow-hidden rounded-xl border p-0 text-left transition ${
                  active ? 'glow-1 border-transparent' : 'border-white/10 hover:border-white/25'
                }`}
                style={active ? { boxShadow: '0 0 18px color-mix(in srgb, var(--accent-1) 30%, transparent)' } : undefined}
              >
                <div className="flex aspect-[16/9] items-center justify-center overflow-hidden bg-black/40">
                  {b.preview ? (
                    <img src={b.preview} alt={b.label} className="h-full w-full object-cover" />
                  ) : b.key === 'sakura' ? (
                    <div
                      className="h-full w-full"
                      style={{
                        background:
                          'linear-gradient(165deg, #fff7fa 0%, #ffe9f2 42%, #ffdcec 100%), radial-gradient(circle at 70% 20%, rgba(255,183,210,0.8), transparent 55%)',
                      }}
                    />
                  ) : b.key === 'gradient' ? (
                    <div className="h-full w-full bg-gradient-to-br from-[#101018] via-[#09090b] to-[#1a1030]" />
                  ) : b.key === 'glow' ? (
                    <div
                      className="h-full w-full"
                      style={{
                        background:
                          'radial-gradient(circle at 20% 20%, color-mix(in srgb, var(--accent-1) 25%, transparent), transparent 50%), radial-gradient(circle at 80% 80%, color-mix(in srgb, var(--accent-2) 25%, transparent), transparent 50%), #09090b',
                      }}
                    />
                  ) : b.key === 'mesh' ? (
                    <div
                      className="h-full w-full"
                      style={{
                        background:
                          'conic-gradient(from 210deg at 60% 40%, #09090b, color-mix(in srgb, var(--accent-1) 22%, #09090b), color-mix(in srgb, var(--accent-2) 20%, #09090b), #09090b)',
                      }}
                    />
                  ) : (
                    <span className="text-xs text-zinc-500">Dán URL bên dưới</span>
                  )}
                </div>
                <div className="flex items-center justify-between px-2.5 py-2">
                  <span className="text-xs text-zinc-300">{b.label}</span>
                  {active && <Check className="h-3.5 w-3.5" style={{ color: 'var(--accent-1)' }} />}
                </div>
              </button>
            )
          })}
        </div>
        {settings.background === 'custom' && (
          <div className="mt-3 flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs text-zinc-400">URL hình nền (jpg/png/webp)</Label>
              <Input
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://..."
                className="rounded-xl border-white/10 bg-white/5"
              />
            </div>
            <Button
              onClick={() => {
                saveSettings({ customBgUrl: customUrl, background: 'custom' })
                toast.success('Đã áp dụng nền tùy chỉnh')
              }}
              className="rounded-xl font-semibold text-black"
              style={{ background: 'var(--accent-1)' }}
            >
              <Save className="mr-1 h-4 w-4" />
              Lưu
            </Button>
          </div>
        )}
      </Card>

      <div className="space-y-4">
        <Card className="glass rounded-2xl p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Palette className="h-4 w-4" style={{ color: 'var(--accent-2)' }} />
            Màu nhấn
          </h3>
          <div className="grid grid-cols-2 gap-3">
            {ACCENTS.map((a) => {
              const active = settings.accent === a.key
              return (
                <button
                  key={a.key}
                  onClick={() => pickAccent(a.key)}
                  className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 transition ${
                    active ? 'border-transparent glow-1 bg-white/10' : 'border-white/10 hover:bg-white/5'
                  }`}
                >
                  <span className="h-5 w-9 shrink-0 rounded-full" style={{ background: `linear-gradient(90deg, ${a.c1}, ${a.c2})` }} />
                  <span className="text-xs text-zinc-200">{a.label}</span>
                  {active && <Check className="ml-auto h-3.5 w-3.5" style={{ color: a.c1 }} />}
                </button>
              )
            })}
          </div>
        </Card>

        <Card className="glass rounded-2xl p-4">
          <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <PenTool className="h-4 w-4" style={{ color: 'var(--accent-1)' }} />
            Độ bo góc
          </h3>
          <div className="flex items-center gap-4">
            <Slider
              value={[radiusPx]}
              min={8}
              max={24}
              step={2}
              onValueChange={(v) => {
                setRadiusPx(v[0])
                if (radiusTimer.current) clearTimeout(radiusTimer.current)
                radiusTimer.current = setTimeout(() => {
                  radiusTimer.current = null
                  saveSettings({ radius: v[0] / 16 })
                }, 400)
              }}
              onValueCommit={(v) => persistRadiusNow(v[0])}
              className="flex-1"
            />
            <span className="num w-14 text-right text-sm text-zinc-300">
              {radiusPx.toFixed(0)}px
            </span>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Áp dụng cho toàn bộ thẻ, nút, khung nhập trong dashboard — không còn góc nhọn nào.
          </p>
          <div className="mt-3 flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-3.5 py-3">
            <div>
              <p className="text-xs font-medium text-zinc-200">Cánh hoa sakura rơi</p>
              <p className="text-[11px] text-zinc-500">Hiệu ứng cánh hoa trên nền Sakura</p>
            </div>
            <Switch
              checked={settings.petals}
              onCheckedChange={(v) => {
                saveSettings({ petals: v })
                toast.success(v ? 'Đã bật cánh hoa sakura' : 'Đã tắt cánh hoa sakura')
              }}
              aria-label="Bật tắt cánh hoa sakura"
            />
          </div>
        </Card>
      </div>

      {/* Xuất / Nhập cấu hình */}
      <Card className="glass rounded-2xl p-5 lg:col-span-2">
        <div className="mb-3 flex items-center gap-2.5">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10"
            style={{ background: 'color-mix(in srgb, var(--accent-2) 14%, transparent)' }}
          >
            <FileJson className="h-5 w-5" style={{ color: 'var(--accent-2)' }} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Cấu hình (Config)</h3>
            <p className="text-xs text-zinc-500">
              Xuất toàn bộ cài đặt giao diện + danh sách tinh chỉnh ra file JSON, hoặc nhập lại từ
              file đã xuất trước đó
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={exportConfig}
            className="h-10 rounded-xl px-5 font-semibold text-black"
            style={{ background: 'var(--accent-1)' }}
            aria-label="Xuất cấu hình ra file JSON"
          >
            <Download className="mr-1.5 h-4 w-4" />
            Xuất cấu hình
          </Button>
          <Button
            onClick={() => importFileRef.current?.click()}
            variant="outline"
            className="h-10 rounded-xl border-white/10 bg-transparent text-zinc-200 hover:bg-white/10"
            aria-label="Nhập cấu hình từ file JSON"
          >
            <Upload className="mr-1.5 h-4 w-4" />
            Nhập cấu hình
          </Button>
          <input
            ref={importFileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) importConfig(f)
              e.target.value = ''
            }}
          />
          <p className="text-xs text-zinc-500">
            File mẫu: <span className="num">nexus-config-2025-11-15.json</span>
          </p>
        </div>
      </Card>
    </div>
  )
}
