// Gaming Mode — bật/tắt preset tinh chỉnh bằng cách TÁI SỬ DỤNG các hàm apply/revert của ./tweaks

import { db } from '@/lib/db'
import { isWin } from '@/lib/exec'
import { applyTweakById, TWEAK_ACTIONS, revertTweakById } from '@/lib/tweaks'
import type { GamingEffect } from '@/lib/types'

export const GAMING_NOTE = isWin
  ? 'Các tinh chỉnh HKCU áp dụng ngay cho user hiện tại; các mục HKLM/service cần quyền Administrator — nếu thiếu quyền sẽ báo lỗi trung thực.'
  : 'Các tinh chỉnh nhân Linux cần quyền root — trên VPS hiện tại không có sudo nên chúng được báo lỗi trung thực; các mục cấp user vẫn áp dụng.'

/** Preset bật Gaming Mode (Linux): xả RAM, governor hiệu năng, giảm swap, dọn cache npm + /tmp */
const GAMING_PRESET_APPLY_LINUX = ['drop-caches', 'governor-performance', 'swappiness-10', 'npm-cache-clean', 'tmp-clean']

/** Preset tắt Gaming Mode (Linux): hoàn tác các tinh chỉnh nhân đã bật */
const GAMING_PRESET_REVERT_LINUX = ['governor-performance', 'swappiness-10']

/** Preset bật Gaming Mode (Windows): HKCU áp dụng ngay; các mục Admin thiếu quyền sẽ báo trung thực */
export const GAMING_PRESET_APPLY_WIN = [
  'win-game-dvr-off',
  'win-gamemode-on',
  'win-fse-off',
  'win-mouse-accurate',
  'win-keyboard-fast',
  'win-keyboard-accessibility-off',
  'win-menu-delay',
  'win-startup-delay',
  'win-ram-clean',
  'win-flush-dns',
  'win-power-high',
  'win-cpu-priority-separation',
  'win-cpu-core-parking-off',
  'win-gpu-hwsch-on',
  'win-mmcss-gaming',
  'win-netthrottle',
  'win-background-apps-off',
]

/** Preset tắt Gaming Mode (Windows): hoàn tác mọi mục có thể đã được bật kèm */
export const GAMING_PRESET_REVERT_WIN = [
  'win-game-dvr-off',
  'win-gamemode-on',
  'win-fse-off',
  'win-mouse-accurate',
  'win-keyboard-fast',
  'win-keyboard-accessibility-off',
  'win-menu-delay',
  'win-startup-delay',
  'win-power-high',
  'win-sysresp',
  'win-cpu-priority-separation',
  'win-cpu-core-parking-off',
  'win-gpu-hwsch-on',
  'win-mmcss-gaming',
  'win-netthrottle',
  'win-background-apps-off',
  'win-sysmain-off',
  'win-diagtrack-off',
]

function nameOf(id: string): string {
  return TWEAK_ACTIONS.find((a) => a.def.id === id)?.def.name ?? id
}

async function runPreset(ids: string[], mode: 'apply' | 'revert'): Promise<GamingEffect[]> {
  const effects: GamingEffect[] = []
  for (const id of ids) {
    try {
      const r = mode === 'apply' ? await applyTweakById(id) : await revertTweakById(id)
      effects.push({ id, name: nameOf(id), success: r.success, message: r.message })
    } catch (e) {
      effects.push({ id, name: nameOf(id), success: false, message: `Lỗi khi chạy: ${(e as Error).message}` })
    }
  }
  return effects
}

/** Bật/tắt Gaming Mode: chạy preset rồi upsert GamingState (id=1) cùng effects JSON */
export async function setGaming(enabled: boolean): Promise<GamingEffect[]> {
  const effects = enabled
    ? await runPreset(isWin ? GAMING_PRESET_APPLY_WIN : GAMING_PRESET_APPLY_LINUX, 'apply')
    : await runPreset(isWin ? GAMING_PRESET_REVERT_WIN : GAMING_PRESET_REVERT_LINUX, 'revert')

  const now = new Date()
  try {
    await db.gamingState.upsert({
      where: { id: 1 },
      update: {
        enabled,
        enabledAt: enabled ? now : null,
        effects: JSON.stringify(effects),
      },
      create: { id: 1, enabled, enabledAt: enabled ? now : null, effects: JSON.stringify(effects) },
    })
  } catch (e) {
    console.error('[gaming] setGaming upsert', e)
  }
  return effects
}

/** Đọc trạng thái Gaming Mode từ DB (effects là chuỗi JSON) */
export async function getGamingStatus(): Promise<{
  enabled: boolean
  enabledAt?: string
  effects: GamingEffect[]
  note: string
}> {
  try {
    const row = await db.gamingState.findUnique({ where: { id: 1 } })
    let effects: GamingEffect[] = []
    if (row?.effects) {
      try {
        effects = JSON.parse(row.effects) as GamingEffect[]
        if (!Array.isArray(effects)) effects = []
      } catch {
        effects = []
      }
    }
    return {
      enabled: row?.enabled ?? false,
      enabledAt: row?.enabledAt ? row.enabledAt.toISOString() : undefined,
      effects,
      note: GAMING_NOTE,
    }
  } catch (e) {
    console.error('[gaming] getGamingStatus', e)
    return { enabled: false, effects: [], note: GAMING_NOTE }
  }
}
