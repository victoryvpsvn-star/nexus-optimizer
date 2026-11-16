import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { applyTweakById, getTweaks, revertTweakById } from '@/lib/tweaks'
import type { TweakRunResult } from '@/lib/types'

export const dynamic = 'force-dynamic'

const schema = z.object({
  ids: z.array(z.string()).min(1).max(50),
  action: z.enum(['apply', 'revert']),
})

/** Giới hạn số tinh chỉnh mỗi lần áp dụng — chạy tuần tự nên cần chặn batch quá lớn */
const MAX_IDS_PER_REQUEST = 12
/** Hạn tổng thời gian xử lý (wall-clock) cho toàn bộ request */
const DEADLINE_MS = 90_000

export async function GET() {
  try {
    const tweaks = await getTweaks()
    return NextResponse.json({ tweaks })
  } catch (e) {
    console.error('[api/tweaks GET]', e)
    return NextResponse.json({ tweaks: [] }, { status: 500 })
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
      return NextResponse.json({ error: 'Yêu cầu không hợp lệ (cần ids[], action)' }, { status: 400 })
    }
    if (body.data.ids.length > MAX_IDS_PER_REQUEST) {
      return NextResponse.json(
        { error: 'Tối đa 12 tinh chỉnh mỗi lần áp dụng' },
        { status: 400 },
      )
    }
    const results: TweakRunResult[] = []
    const startedAt = Date.now()
    // Chạy tuần tự để tránh giẫm chân nhau giữa các tinh chỉnh hệ thống,
    // có mốc thời gian tổng 90s để request không treo quá lâu.
    for (const id of body.data.ids) {
      if (Date.now() - startedAt > DEADLINE_MS) {
        results.push({ id, success: false, message: 'Bỏ qua do vượt thời gian xử lý' })
        continue
      }
      try {
        const r =
          body.data.action === 'apply' ? await applyTweakById(id) : await revertTweakById(id)
        results.push(r)
      } catch (e) {
        results.push({ id, success: false, message: `Lỗi khi chạy: ${(e as Error).message}` })
      }
    }
    return NextResponse.json({ results })
  } catch (e) {
    console.error('[api/tweaks POST]', e)
    return NextResponse.json({ error: 'Lỗi máy chủ khi chạy tinh chỉnh' }, { status: 500 })
  }
}
