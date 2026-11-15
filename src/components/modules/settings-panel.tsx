'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, ImageIcon, Palette, PenTool, Save } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { useApp } from '@/lib/store'
import type { AccentKey, BackgroundKey } from '@/lib/types'

const BACKGROUNDS: { key: BackgroundKey; label: string; preview?: string }[] = [
  { key: 'gradient', label: 'Gradient tối' },
  { key: 'glow', label: 'Hồ quang neon' },
  { key: 'mesh', label: 'Lưới mesh' },
  { key: 'wall-default', label: 'Wallpaper Nebula', preview: '/img/wall-default.png' },
  { key: 'wall-gaming', label: 'Wallpaper Gaming', preview: '/img/wall-gaming.png' },
  { key: 'custom', label: 'Tùy chỉnh URL' },
]

const ACCENTS: { key: AccentKey; label: string; c1: string; c2: string }[] = [
  { key: 'cyan-violet', label: 'Cyan – Violet', c1: '#22d3ee', c2: '#a78bfa' },
  { key: 'emerald-amber', label: 'Emerald – Amber', c1: '#34d399', c2: '#fbbf24' },
  { key: 'rose-magenta', label: 'Rose – Magenta', c1: '#fb7185', c2: '#e879f9' },
  { key: 'amber-crimson', label: 'Amber – Crimson', c1: '#fbbf24', c2: '#f43f5e' },
]

export function SettingsPanel() {
  const settings = useApp((s) => s.settings)
  const saveSettings = useApp((s) => s.saveSettings)
  const [customUrl, setCustomUrl] = useState(settings.customBgUrl)

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
            Áp dụng cho toàn bộ thẻ, nút, khung nhập trong dashboard.
          </p>
        </Card>
      </div>
    </div>
  )
}
