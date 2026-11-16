'use client'

import Image from 'next/image'
import {
  Activity,
  Camera,
  DatabaseBackup,
  FlaskConical,
  Gamepad2,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { motion } from 'framer-motion'
import { useApp } from '@/lib/store'
import type { Section } from '@/lib/types'
import { Badge } from '@/components/ui/badge'

const NAV: { key: Section; label: string; icon: typeof LayoutDashboard }[] = [
  { key: 'overview', label: 'Tổng quan', icon: LayoutDashboard },
  { key: 'cleanup', label: 'Dọn dẹp', icon: Sparkles },
  { key: 'gaming', label: 'Gaming Mode', icon: Gamepad2 },
  { key: 'tweaks', label: 'Tinh chỉnh', icon: SlidersHorizontal },
  { key: 'selftest', label: 'Tự kiểm tra', icon: FlaskConical },
  { key: 'script', label: 'Script nâng cao', icon: Terminal },
  { key: 'processes', label: 'Tiến trình', icon: Activity },
  { key: 'backup', label: 'Sao lưu', icon: DatabaseBackup },
  { key: 'screenshot', label: 'Ảnh chụp', icon: Camera },
  { key: 'settings', label: 'Cài đặt', icon: Settings2 },
]

interface SidebarProps {
  collapsed: boolean
  onToggleCollapsed: () => void
  onNavigate?: () => void
  /** Bật khi sidebar chạy trong Sheet di động: ẩn nút thu gọn, hiển thị nút đóng drawer */
  sheetMode?: boolean
}

export function Sidebar({ collapsed, onToggleCollapsed, onNavigate, sheetMode = false }: SidebarProps) {
  const section = useApp((s) => s.section)
  const setSection = useApp((s) => s.setSection)
  const gaming = useApp((s) => s.gaming)

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r border-white/8 bg-[color:var(--surface)] backdrop-blur-xl transition-[width] duration-300',
        !sheetMode && (collapsed ? 'w-[72px]' : 'w-60'),
      )}
    >
      {/* Logo */}
      <div className={cn('flex items-center gap-2.5 px-3.5 py-4', collapsed && 'justify-center px-0')}>
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-xl border border-white/10">
          <Image src="/img/logo-sakura.png" alt="NEXUS OPTIMIZER" fill className="object-cover" sizes="40px" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold tracking-wide text-zinc-100">
              NEXUS <span style={{ color: 'var(--accent-1)' }}>OPTIMIZER</span>
            </p>
            <p className="text-[10px] uppercase tracking-widest text-zinc-500">Bộ công cụ đa năng</p>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="thin-scroll flex-1 space-y-1 overflow-y-auto px-2.5 py-2">
        {NAV.map((item) => {
          const active = section === item.key
          const Icon = item.icon
          return (
            <button
              key={item.key}
              onClick={() => {
                setSection(item.key)
                onNavigate?.()
              }}
              className={cn(
                'group relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all',
                active
                  ? 'font-semibold text-zinc-100'
                  : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
                collapsed && 'justify-center px-0',
              )}
              style={
                active
                  ? {
                      background:
                        'linear-gradient(90deg, color-mix(in srgb, var(--accent-1) 18%, transparent), transparent)',
                      boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--accent-1) 30%, transparent)',
                    }
                  : undefined
              }
              title={collapsed ? item.label : undefined}
            >
              {active && (
                <motion.span
                  layoutId={sheetMode ? 'nav-active-pill-sheet' : 'nav-active-pill'}
                  className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full"
                  style={{
                    background: 'var(--accent-1)',
                    boxShadow: '0 0 12px var(--accent-1)',
                  }}
                  transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                />
              )}
              <Icon
                className="h-4.5 w-4.5 shrink-0"
                style={active ? { color: 'var(--accent-1)' } : undefined}
              />
              {!collapsed && <span className="truncate">{item.label}</span>}
              {!collapsed && item.key === 'gaming' && gaming && (
                <Badge className="ml-auto rounded-full bg-transparent px-1.5 text-[10px] text-white" style={{ background: 'var(--accent-1)' }}>
                  BẬT
                </Badge>
              )}
            </button>
          )
        })}
      </nav>

      {/* Footer */}
      <div className={cn('border-t border-white/8 px-2.5 py-3', collapsed && 'px-0')}>
        {sheetMode ? (
          <button
            onClick={onToggleCollapsed}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-xs text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300"
          >
            <X className="h-4 w-4" />
            Đóng điều hướng
          </button>
        ) : (
          <button
            onClick={onToggleCollapsed}
            className={cn(
              'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-xs text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300',
              collapsed && 'justify-center px-0',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <>
                <PanelLeftClose className="h-4 w-4" />
                Thu gọn
              </>
            )}
          </button>
        )}
        {!collapsed && (
          <p className="px-3 pt-2 text-[10px] text-zinc-600">NEXUS OPTIMIZER v1.0 · GameFn</p>
        )}
      </div>
    </aside>
  )
}
