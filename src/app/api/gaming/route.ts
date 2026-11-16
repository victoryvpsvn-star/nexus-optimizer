import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { GAMING_NOTE, getGamingStatus, setGaming } from '@/lib/gaming'
import type { GamingEffect } from '@/lib/types'

export const dynamic = 'force-dynamic'

const schema = z.object({ enabled: z.boolean() })

export async function GET() {
  try {
    const status = await getGamingStatus()
    return NextResponse.json(status)
  } catch (e) {
    console.error('[api/gaming GET]', e)
    return NextResponse.json({ enabled: false, effects: [], note: GAMING_NOTE }, { status: 200 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const raw: unknown = await req.json().catch(() => null)
    if (raw === null) {
      return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
    }
    const body = schema.safeParse(raw)
    if (!body.success) {
      return NextResponse.json({ error: 'Cần trường enabled:boolean' }, { status: 400 })
    }
    const effects: GamingEffect[] = await setGaming(body.data.enabled)
    // Hợp đồng bắt buộc: luôn trả về `enabled` boolean (store.ts phụ thuộc vào nó)
    return NextResponse.json({ enabled: body.data.enabled, effects, note: GAMING_NOTE })
  } catch (e) {
    console.error('[api/gaming POST]', e)
    return NextResponse.json(
      { enabled: false, effects: [], note: GAMING_NOTE, error: 'Lỗi máy chủ khi bật/tắt Gaming Mode' },
      { status: 500 },
    )
  }
}
