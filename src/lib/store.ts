'use client'

import { create } from 'zustand'
import { toast } from 'sonner'
import type { Section, UISettings } from './types'

const DEFAULT_SETTINGS: UISettings = {
  accent: 'cyan-violet',
  background: 'glow',
  customBgUrl: '',
  radius: 1.0,
}

interface AppState {
  section: Section
  setSection: (s: Section) => void
  gaming: boolean
  gamingBusy: boolean
  settings: UISettings
  hydrated: boolean
  /** Sức khoẻ API thống kê (do use-stats cập nhật) */
  apiHealthy: boolean
  setApiHealthy: (v: boolean) => void
  hydrate: () => Promise<void>
  saveSettings: (patch: Partial<UISettings>) => Promise<void>
  applyGaming: (v: boolean) => Promise<boolean>
}
export const useApp = create<AppState>((set, get) => ({
  section: 'overview',
  setSection: (s) => set({ section: s }),
  gaming: false,
  gamingBusy: false,
  settings: DEFAULT_SETTINGS,
  hydrated: false,
  apiHealthy: true,
  setApiHealthy: (v) => set({ apiHealthy: v }),
  hydrate: async () => {
    try {
      const [sr, gr] = await Promise.all([
        fetch('/api/settings', { cache: 'no-store' }),
        fetch('/api/gaming', { cache: 'no-store' }),
      ])
      const settings = sr.ok ? ((await sr.json()) as UISettings) : DEFAULT_SETTINGS
      // Chỉ ghi đè `gaming` khi GET /api/gaming thành công — giữ giá trị cũ khi lỗi để không lệch trạng thái DB.
      const patch: Partial<AppState> = { settings, hydrated: true }
      if (gr.ok) {
        const g = (await gr.json()) as { enabled?: boolean }
        patch.gaming = Boolean(g?.enabled)
      }
      set(patch)
    } catch {
      set({ hydrated: true })
    }
  },
  saveSettings: async (patch) => {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!r.ok) throw new Error('bad response')
    } catch {
      toast.error('Không lưu được cài đặt lên máy chủ')
    }
  },
  applyGaming: async (v) => {
    set({ gamingBusy: true })
    try {
      const r = await fetch('/api/gaming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: v }),
      })
      if (!r.ok) throw new Error(`API trả về HTTP ${r.status}`)
      const data = (await r.json()) as { enabled?: boolean; error?: string }
      if (data?.error) throw new Error(data.error)
      if (Boolean(data?.enabled) !== v) throw new Error('Phản hồi không khớp trạng thái yêu cầu')
      set({ gaming: v })
      return true
    } catch {
      toast.error('Gaming Mode chưa được áp dụng')
      return false
    } finally {
      set({ gamingBusy: false })
    }
  },
}))
