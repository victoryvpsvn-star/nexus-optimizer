'use client'

import { Activity, HardDrive, MemoryStick, Network, Radio, Zap, Camera, Sparkles } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Gauge } from '@/components/dashboard/gauge'
import { StatCard } from '@/components/dashboard/stat-card'
import { LiveChart } from '@/components/dashboard/live-chart'
import { useStats } from '@/hooks/use-stats'
import { useApp } from '@/lib/store'
import { formatBytes, formatUptime } from '@/lib/format'
import { toast } from 'sonner'
import { useEffect, useState } from 'react'
import type { CleanupRunResponse } from '@/lib/types'

interface NetExtra {
  ifaces: { name: string; ipv4: string[]; mac?: string }[]
  ports: { port: number; proto: string }[]
  fqdn: string
}

export function OverviewPanel() {
  const { stats, history, error } = useStats(2000)
  const setSection = useApp((s) => s.setSection)
  const applyGaming = useApp((s) => s.applyGaming)
  const [cleaning, setCleaning] = useState(false)
  const [netInfo, setNetInfo] = useState<NetExtra | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/network', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: NetExtra | null) => {
        if (alive && d) setNetInfo(d)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const disk = stats?.disks?.[0]

  const cleanAll = async () => {
    setCleaning(true)
    toast.info('Đang dọn dẹp RAM + Disk cùng lúc...')
    try {
      const r = await fetch('/api/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'all' }),
      })
      const data = (await r.json()) as CleanupRunResponse & { error?: string }
      if (!r.ok || data.error) throw new Error(data.error ?? 'Lỗi API')
      toast.success(
        `Hoàn tất! Disk: ${formatBytes(data.totalFreedDisk ?? 0)} · RAM: ${formatBytes(data.totalFreedRam ?? 0)}`,
      )
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Lỗi khi dọn dẹp')
    } finally {
      setCleaning(false)
    }
  }

  const gamingOn = async () => {
    const ok = await applyGaming(true)
    if (ok) {
      toast.success('Đã bật Gaming Mode')
      setSection('gaming')
    }
  }

  return (
    <div className="space-y-4">
      {/* Gauges */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="glass glow-hover rounded-2xl p-6 flex justify-center">
          <Gauge value={stats?.cpu.usage ?? 0} label="CPU" sub={`${stats?.cpu.cores ?? '–'} nhân · load ${stats?.cpu.loadavg[0] ?? '–'}`} />
        </Card>
        <Card className="glass glow-hover rounded-2xl p-6 flex justify-center">
          <Gauge value={stats?.mem.usagePct ?? 0} label="RAM" sub={`${((stats?.mem.usedMB ?? 0) / 1024).toFixed(1)}/${((stats?.mem.totalMB ?? 0) / 1024).toFixed(1)} GB`} />
        </Card>
        <Card className="glass glow-hover rounded-2xl p-6 flex justify-center">
          <Gauge value={disk?.usagePct ?? 0} label="DISK" sub={`${disk?.usedGB ?? '–'}/${disk?.totalGB ?? '–'} GB trên ${disk?.mount ?? '/'}`} />
        </Card>
      </div>

      {/* Chart + system info */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="glass rounded-2xl p-4 lg:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-200">Biểu đồ realtime (3 phút gần nhất)</h3>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: 'var(--accent-1)' }} /> CPU
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: 'var(--accent-2)' }} /> RAM
              </span>
            </div>
          </div>
          {error ? (
            <div className="flex h-[240px] items-center justify-center text-sm text-zinc-500">
              Mất kết nối tới API thống kê — đang thử lại...
            </div>
          ) : (
            <LiveChart history={history} />
          )}
        </Card>

        <div className="grid grid-cols-1 gap-4">
          <StatCard icon={Network} title="Mạng" accent="2">
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-400">Tải xuống</span>
                <span className="num font-semibold text-emerald-400">↓ {stats?.net.rxKBs ?? 0} KB/s</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Tải lên</span>
                <span className="num font-semibold" style={{ color: 'var(--accent-2)' }}>↑ {stats?.net.txKBs ?? 0} KB/s</span>
              </div>
              <div className="flex justify-between text-xs text-zinc-500">
                <span>Tổng RX / TX</span>
                <span className="num">
                  {(stats?.net.rxTotalMB ?? 0) / 1024 > 1
                    ? `${((stats?.net.rxTotalMB ?? 0) / 1024).toFixed(2)} GB`
                    : `${stats?.net.rxTotalMB ?? 0} MB`}{' '}
                  /{' '}
                  {(stats?.net.txTotalMB ?? 0) / 1024 > 1
                    ? `${((stats?.net.txTotalMB ?? 0) / 1024).toFixed(2)} GB`
                    : `${stats?.net.txTotalMB ?? 0} MB`}
                </span>
              </div>
            </div>
          </StatCard>

          <StatCard icon={Activity} title="Hệ thống" accent="1">
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-400">Uptime</span>
                <span className="num font-semibold">{formatUptime(stats?.uptimeSec ?? 0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Tiến trình</span>
                <span className="num font-semibold">{stats?.processCount ?? '–'}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="shrink-0 text-zinc-400">Host</span>
                <span className="truncate text-right text-xs text-zinc-300">{stats?.hostname ?? '–'}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="shrink-0 text-zinc-400">Swap đã dùng</span>
                <span className="num text-xs">{stats?.mem.swapUsedMB ?? 0} MB</span>
              </div>
            </div>
          </StatCard>

          <StatCard icon={Radio} title="Cổng & giao diện" accent="2">
            <div className="space-y-1.5 text-sm">
              {netInfo ? (
                <>
                  <div className="flex justify-between">
                    <span className="text-zinc-400">Giao diện mạng</span>
                    <span className="num font-semibold">{netInfo.ifaces.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400">Cổng đang lắng nghe</span>
                    <span className="num font-semibold">{netInfo.ports.length}</span>
                  </div>
                  <div className="thin-scroll mt-1 max-h-20 overflow-y-auto rounded-lg border border-white/5 bg-black/20 px-2 py-1.5">
                    <p className="num text-[11px] leading-relaxed text-zinc-400">
                      {netInfo.ports.length > 0
                        ? netInfo.ports.slice(0, 10).map((p) => `:${p.port}`).join('  ')
                        : 'Không có cổng nào mở'}
                    </p>
                  </div>
                </>
              ) : (
                <p className="py-2 text-xs text-zinc-500">Đang tải thông tin mạng...</p>
              )}
            </div>
          </StatCard>
        </div>
      </div>

      {/* Quick actions */}
      <Card className="glass rounded-2xl p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="outline" className="rounded-full border-white/10 text-zinc-400">
            Hành động nhanh
          </Badge>
          <Button
            onClick={cleanAll}
            disabled={cleaning}
            className="rounded-xl font-semibold text-black"
            style={{ background: 'var(--accent-1)' }}
          >
            <Sparkles className="mr-1 h-4 w-4" />
            {cleaning ? 'Đang dọn...' : 'Dọn RAM + Disk'}
          </Button>
          <Button
            onClick={gamingOn}
            variant="outline"
            className="rounded-xl border-white/15 font-semibold text-zinc-100 hover:bg-white/10"
          >
            <Zap className="mr-1 h-4 w-4" style={{ color: 'var(--accent-1)' }} />
            Bật Gaming Mode
          </Button>
          <Button
            onClick={() => setSection('screenshot')}
            variant="outline"
            className="rounded-xl border-white/15 text-zinc-100 hover:bg-white/10"
          >
            <Camera className="mr-1 h-4 w-4" />
            Chụp màn hình
          </Button>
        </div>
      </Card>
    </div>
  )
}
