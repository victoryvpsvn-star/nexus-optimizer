'use client'

import { Gamepad2, Menu, Radio } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/store'
import { SECTION_META } from '@/lib/types'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export function Topbar({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
  const section = useApp((s) => s.section)
  const gaming = useApp((s) => s.gaming)
  const gamingBusy = useApp((s) => s.gamingBusy)
  const apiHealthy = useApp((s) => s.apiHealthy)
  const applyGaming = useApp((s) => s.applyGaming)
  const setSection = useApp((s) => s.setSection)
  const meta = SECTION_META[section]

  const toggleGaming = async (v: boolean) => {
    const ok = await applyGaming(v)
    if (ok) {
      toast.success(v ? 'Gaming Mode đã BẬT' : 'Gaming Mode đã TẮT')
      if (v) setSection('gaming')
    }
  }

  return (
    <header
      className="relative flex h-16 shrink-0 items-center gap-3 border-b border-white/8 px-4 backdrop-blur-xl md:px-6"
      style={{ background: 'color-mix(in srgb, var(--surface-2) 80%, transparent)' }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px"
        style={{
          background:
            'linear-gradient(90deg, transparent, var(--accent-1), var(--accent-2), transparent)',
          opacity: 0.45,
        }}
      />
      <Button
        variant="ghost"
        size="icon"
        className="rounded-xl text-zinc-400 lg:hidden"
        onClick={onOpenMobileNav}
        aria-label="Mở điều hướng"
      >
        <Menu className="h-5 w-5" />
      </Button>
      <div className="min-w-0">
        <h1 className="truncate text-base font-bold text-zinc-100 md:text-lg">{meta.title}</h1>
        <p className="hidden truncate text-xs text-zinc-500 sm:block">{meta.subtitle}</p>
      </div>
      <div className="ml-auto flex items-center gap-2 md:gap-3">
        <Badge
          variant="outline"
          className={cn(
            'hidden rounded-full border-white/10 text-xs sm:flex',
            apiHealthy ? 'text-emerald-400' : 'text-rose-400',
          )}
          aria-live="polite"
        >
          <Radio className={cn('mr-1 h-3 w-3', apiHealthy ? 'text-emerald-400' : 'text-rose-400')} />
          {apiHealthy ? 'Hoạt động' : 'Mất kết nối'}
        </Badge>
        <div
          className="flex items-center gap-2 rounded-full border px-3 py-1.5 transition-colors"
          style={{
            borderColor: gaming ? 'color-mix(in srgb, var(--accent-1) 50%, transparent)' : 'rgba(255,255,255,0.1)',
            background: gaming ? 'color-mix(in srgb, var(--accent-1) 12%, transparent)' : 'transparent',
            animation: gaming ? 'pill-pulse 3s ease-in-out infinite' : undefined,
          }}
        >
          <Gamepad2 className="h-4 w-4" style={{ color: gaming ? 'var(--accent-1)' : '#a1a1aa' }} />
          <span className="hidden text-xs font-semibold text-zinc-300 sm:block">Gaming Mode</span>
          <Switch
            checked={gaming}
            disabled={gamingBusy}
            onCheckedChange={toggleGaming}
            aria-label="Bật tắt Gaming Mode"
          />
        </div>
      </div>
    </header>
  )
}
