'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Sidebar } from '@/components/shell/sidebar'
import { Topbar } from '@/components/shell/topbar'
import { OverviewPanel } from '@/components/modules/overview-panel'
import { CleanupPanel } from '@/components/modules/cleanup-panel'
import { GamingPanel } from '@/components/modules/gaming-panel'
import { TweaksPanel } from '@/components/modules/tweaks-panel'
import { SelftestPanel } from '@/components/modules/selftest-panel'
import { ProcessesPanel } from '@/components/modules/processes-panel'
import { BackupPanel } from '@/components/modules/backup-panel'
import { ScreenshotPanel } from '@/components/modules/screenshot-panel'
import { ScriptPanel } from '@/components/modules/script-panel'
import { SettingsPanel } from '@/components/modules/settings-panel'
import { Petals } from '@/components/shell/petals'
import { useApp } from '@/lib/store'

function BackgroundLayer() {
  const background = useApp((s) => s.settings.background)
  const customBgUrl = useApp((s) => s.settings.customBgUrl)
  const petals = useApp((s) => s.settings.petals)
  const gaming = useApp((s) => s.gaming)

  // Chỉ chấp nhận URL http(s) hoặc đường dẫn nội bộ; chặn ký tự phá vỡ cú pháp url("...")
  const safeCustomUrl =
    background === 'custom' &&
    customBgUrl &&
    !/["'\\]/.test(customBgUrl) &&
    (/^https?:\/\//i.test(customBgUrl) || customBgUrl.startsWith('/'))
      ? encodeURI(customBgUrl)
      : null

  /* ====== Gaming Mode: luôn nền tối bất kể chọn nền gì — đặt TRƯỚC mọi nhánh nền ====== */
  if (gaming && background !== 'wall-gaming') {
    return (
      <div
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background: 'linear-gradient(160deg, #000000 0%, #0a0a12 55%, #17061f 100%)',
        }}
      />
    )
  }

  if (safeCustomUrl) {
    return (
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url("${safeCustomUrl}")`, filter: 'brightness(0.35)' }}
        />
        <div className="absolute inset-0 bg-black/40" />
      </div>
    )
  }

  /* ====== Nền Sakura (mặc định khi mở app) ====== */
  if (background === 'sakura') {
    return (
      <div
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            'linear-gradient(165deg, #fff7fa 0%, #ffe9f2 42%, #ffdcec 100%)',
        }}
      >
        <div
          className="absolute inset-0 bg-cover bg-center opacity-70"
          style={{
            backgroundImage: 'url(/img/wall-sakura.png)',
            maskImage:
              'linear-gradient(180deg, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.25) 55%, transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(180deg, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.25) 55%, transparent 100%)',
          }}
        />
        {!gaming && petals && <Petals />}
      </div>
    )
  }
  if (background === 'wall-sakura') {
    return (
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: 'url(/img/wall-sakura.png)' }}
        />
        <div className="absolute inset-0 bg-white/35" />
        {!gaming && petals && <Petals />}
      </div>
    )
  }

  /* ====== Nền tối truyền thống (khi gaming tắt) ====== */
  if (background === 'wall-default') {
    return (
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: 'url(/img/wall-default.png)', filter: 'brightness(0.5)' }}
        />
        <div className="absolute inset-0 bg-black/45" />
      </div>
    )
  }
  if (background === 'wall-gaming') {
    return (
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: 'url(/img/wall-gaming.png)', filter: 'brightness(0.45)' }}
        />
        <div className="absolute inset-0 bg-black/50" />
      </div>
    )
  }
  if (background === 'mesh') {
    return (
      <div
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            'conic-gradient(from 220deg at 65% 35%, #09090b, color-mix(in srgb, var(--accent-1) 14%, #09090b), color-mix(in srgb, var(--accent-2) 12%, #09090b), #09090b)',
        }}
      />
    )
  }
  if (background === 'glow') {
    return (
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 15% 15%, color-mix(in srgb, var(--accent-1) 12%, transparent), transparent 45%), radial-gradient(circle at 85% 80%, color-mix(in srgb, var(--accent-2) 12%, transparent), transparent 45%), #09090b',
          }}
        />
      </div>
    )
  }
  if (background === 'gradient') {
    // Gaming Mode: gradient đen + tím thay vì màu mặc định
    return (
      <div
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background: gaming
            ? 'linear-gradient(160deg, #000000 0%, #0a0a12 55%, #17061f 100%)'
            : 'linear-gradient(160deg, #09090b 0%, #101018 55%, #14101f 100%)',
        }}
      />
    )
  }
  // Dự phòng (URL tùy chỉnh không hợp lệ hoặc giá trị lạ): gradient mặc định
  return (
    <div
      className="pointer-events-none fixed inset-0 -z-10"
      style={{ background: 'linear-gradient(160deg, #09090b 0%, #101018 55%, #14101f 100%)' }}
    />
  )
}

export default function Page() {
  const section = useApp((s) => s.section)
  const settings = useApp((s) => s.settings)
  const gaming = useApp((s) => s.gaming)
  const hydrated = useApp((s) => s.hydrated)
  const hydrate = useApp((s) => s.hydrate)
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)

  useEffect(() => {
    hydrate()
  }, [hydrate])

  // Áp theme lên <html> để biến CSS ảnh hưởng toàn trang (kể cả body)
  useEffect(() => {
    document.documentElement.dataset.gaming = gaming ? 'on' : 'off'
  }, [gaming])

  // Theme sáng Sakura chỉ khi nền là sakura; nền tối/gaming dùng bảng màu tối
  useEffect(() => {
    const light = !gaming && (settings.background === 'sakura' || settings.background === 'wall-sakura')
    document.documentElement.dataset.theme = light ? 'sakura' : 'dark'
  }, [settings.background, gaming])

  useEffect(() => {
    document.documentElement.dataset.accent = settings.accent
  }, [settings.accent])

  useEffect(() => {
    document.documentElement.style.setProperty('--user-radius', `${settings.radius}rem`)
  }, [settings.radius])

  const styleVars = {
    '--user-radius': `${settings.radius}rem`,
  } as React.CSSProperties

  return (
    <div
      id="app-root"
      data-gaming={gaming ? 'on' : 'off'}
      data-accent={settings.accent}
      className="flex min-h-screen"
      style={styleVars}
    >
      <BackgroundLayer />

      {/* Sidebar desktop */}
      <div className="sticky top-0 hidden h-screen lg:block">
        <Sidebar collapsed={collapsed} onToggleCollapsed={() => setCollapsed((v) => !v)} />
      </div>

      {/* Sidebar mobile */}
      <Sheet open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent side="left" className="border-white/10 bg-[color:var(--surface)] p-0">
          <SheetTitle className="sr-only">Điều hướng</SheetTitle>
          <Sidebar
            collapsed={false}
            sheetMode
            onToggleCollapsed={() => setMobileNav(false)}
            onNavigate={() => setMobileNav(false)}
          />
        </SheetContent>
      </Sheet>

      <div className="flex min-h-screen flex-1 flex-col">
        <Topbar onOpenMobileNav={() => setMobileNav(true)} />
        <main className="flex-1 px-4 py-5 md:px-6">
          {!hydrated ? (
            <div className="grid h-[60vh] place-items-center text-sm text-zinc-500">
              Đang khởi động NEXUS OPTIMIZER...
            </div>
          ) : (
            <motion.div
              key={section}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
            >
              {section === 'overview' && <OverviewPanel />}
              {section === 'cleanup' && <CleanupPanel />}
              {section === 'gaming' && <GamingPanel />}
              {section === 'tweaks' && <TweaksPanel />}
              {section === 'selftest' && <SelftestPanel />}
              {section === 'script' && <ScriptPanel />}
              {section === 'processes' && <ProcessesPanel />}
              {section === 'backup' && <BackupPanel />}
              {section === 'screenshot' && <ScreenshotPanel />}
              {section === 'settings' && <SettingsPanel />}
            </motion.div>
          )}
        </main>
      </div>
    </div>
  )
}
