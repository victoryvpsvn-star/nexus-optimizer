'use client'

import { useEffect, useState } from 'react'
import { useApp } from '@/lib/store'
import type { StatsSnapshot } from '@/lib/types'

export interface HistoryPoint {
  t: number
  cpu: number
  ram: number
  rx: number
  tx: number
}

export function useStats(intervalMs = 2000) {
  const [stats, setStats] = useState<StatsSnapshot | null>(null)
  const [history, setHistory] = useState<HistoryPoint[]>([])
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let failures = 0

    // Tự xếp lịch poll bằng setTimeout sau khi fetch hoàn tất:
    // không bao giờ chồng chéo request khi mạng chậm, và interval giữ nguyên ngữ nghĩa.
    const tick = async () => {
      try {
        const r = await fetch('/api/stats', { cache: 'no-store' })
        if (!r.ok) throw new Error('bad status')
        const s = (await r.json()) as StatsSnapshot
        if (!alive) return
        failures = 0
        setError(false)
        useApp.getState().setApiHealthy(true)
        setStats(s)
        setHistory((h) => [
          ...h.slice(-89),
          {
            t: s.timestamp,
            cpu: s.cpu.usage,
            ram: s.mem.usagePct,
            rx: s.net.rxKBs,
            tx: s.net.txKBs,
          },
        ])
      } catch {
        if (!alive) return
        failures += 1
        setError(true)
        // Chỉ báo mất kết nối cho Topbar sau 2 lần lỗi liên tiếp
        if (failures >= 2) useApp.getState().setApiHealthy(false)
      } finally {
        if (alive) timer = setTimeout(tick, intervalMs)
      }
    }

    tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [intervalMs])

  return { stats, history, error }
}
