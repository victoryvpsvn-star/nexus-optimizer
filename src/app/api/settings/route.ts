import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { z } from 'zod'
import type { UISettings } from '@/lib/types'

export const dynamic = 'force-dynamic'

const DEFAULTS: UISettings = {
  accent: 'cyan-violet',
  background: 'glow',
  customBgUrl: '',
  radius: 1.0,
}

const ACCENT_KEYS = ['cyan-violet', 'emerald-amber', 'rose-magenta', 'amber-crimson'] as const
const BACKGROUND_KEYS = ['gradient', 'glow', 'mesh', 'wall-default', 'wall-gaming', 'custom'] as const

const schema = z.object({
  accent: z.enum(ACCENT_KEYS),
  background: z.enum(BACKGROUND_KEYS),
  customBgUrl: z
    .string()
    .max(500)
    .refine((v) => v === '' || /^https?:\/\//i.test(v) || v.startsWith('/'), {
      message: 'URL nền chỉ chấp nhận http(s) hoặc đường dẫn nội bộ',
    }),
  radius: z.number().min(0.5).max(1.5),
})

/** Kiểm tra từng trường sau khi gộp — hàng DB cũ/hỏng sẽ rơi về giá trị mặc định, không bao giờ trả accent sai enum hay radius NaN */
function sanitizeSettings(map: Record<string, string | undefined>): UISettings {
  const rawAccent = map.accent
  const rawBackground = map.background
  const rawRadius = Number(map.radius)
  return {
    accent: ACCENT_KEYS.includes(rawAccent as UISettings['accent'])
      ? (rawAccent as UISettings['accent'])
      : DEFAULTS.accent,
    background: BACKGROUND_KEYS.includes(rawBackground as UISettings['background'])
      ? (rawBackground as UISettings['background'])
      : DEFAULTS.background,
    customBgUrl:
      typeof map.customBgUrl === 'string' ? map.customBgUrl.slice(0, 500) : DEFAULTS.customBgUrl,
    radius:
      Number.isFinite(rawRadius) && rawRadius >= 0.5 && rawRadius <= 1.5
        ? rawRadius
        : DEFAULTS.radius,
  }
}

export async function GET() {
  try {
    const rows = await db.setting.findMany()
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    const settings = sanitizeSettings(map)
    return NextResponse.json(settings)
  } catch (e) {
    console.error('[api/settings GET]', e)
    return NextResponse.json(DEFAULTS)
  }
}

export async function PUT(req: NextRequest) {
  try {
    const raw: unknown = await req.json().catch(() => null)
    if (raw === null) {
      return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
    }
    const body = schema.safeParse(raw)
    if (!body.success) {
      return NextResponse.json({ error: 'Cài đặt không hợp lệ' }, { status: 400 })
    }
    const s = body.data
    for (const [key, value] of Object.entries(s)) {
      await db.setting.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) },
      })
    }
    return NextResponse.json(s satisfies UISettings)
  } catch (e) {
    console.error('[api/settings PUT]', e)
    return NextResponse.json({ error: 'Không lưu được cài đặt' }, { status: 500 })
  }
}
