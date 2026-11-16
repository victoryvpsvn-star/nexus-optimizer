import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getTweaks } from '@/lib/tweaks'
import { isWin, getWinStatus } from '@/lib/exec'
import {
  runSelftest,
  getWebhookUrl,
  setWebhookUrl,
  maskWebhook,
  isValidWebhook,
  WEBHOOK_SETTING_KEY,
} from '@/lib/selftest'

export const dynamic = 'force-dynamic'

const postSchema = z.object({
  mode: z.enum(['check', 'full']),
  webhook: z.boolean().optional().default(false),
})

const putSchema = z.object({
  webhookUrl: z.string().max(500),
})

/** GET: trạng thái runtime + catalog + cấu hình webhook (che token) */
export async function GET() {
  try {
    const [tweaks, webhookUrl] = await Promise.all([getTweaks(), getWebhookUrl()])
    let runtime: Record<string, unknown>
    if (!isWin) {
      runtime = {
        isWin: false,
        platform: process.platform,
        note: 'App đang chạy ngoài Windows — các tinh chỉnh Windows chỉ chạy được trong bản .exe',
      }
    } else {
      const st = await getWinStatus()
      runtime = {
        isWin: true,
        powershellFound: st.psFound,
        powershellPath: st.psPath,
        powershellDetail: st.psDetail,
        admin: st.admin,
        adminMethod: st.adminMethod,
        regOk: st.regOk,
      }
    }
    return NextResponse.json({
      runtime,
      catalog: {
        total: tweaks.length,
        recommended: tweaks.filter((t) => t.recommended).length,
        applied: tweaks.filter((t) => t.applied).length,
      },
      webhook: {
        configured: webhookUrl !== '',
        masked: maskWebhook(webhookUrl),
      },
    })
  } catch (e) {
    console.error('[api/selftest GET]', e)
    return NextResponse.json({ error: 'Lỗi máy chủ khi đọc trạng thái self-test' }, { status: 500 })
  }
}

/** PUT: lưu URL Discord webhook (dùng cho báo cáo self-test) */
export async function PUT(req: NextRequest) {
  try {
    const raw: unknown = await req.json().catch(() => null)
    if (raw === null) {
      return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
    }
    const body = putSchema.safeParse(raw)
    if (!body.success) {
      return NextResponse.json({ error: 'Cần trường webhookUrl (string ≤500)' }, { status: 400 })
    }
    const url = body.data.webhookUrl.trim()
    if (url !== '' && !isValidWebhook(url)) {
      return NextResponse.json(
        { error: 'URL webhook không hợp lệ — chỉ chấp nhận https://discord.com/api/webhooks/…' },
        { status: 400 },
      )
    }
    await setWebhookUrl(url)
    return NextResponse.json({
      ok: true,
      webhook: { configured: url !== '', masked: maskWebhook(url) },
    })
  } catch (e) {
    console.error('[api/selftest PUT]', e)
    return NextResponse.json({ error: 'Không lưu được cấu hình webhook' }, { status: 500 })
  }
}

/** POST: chạy self-test. mode=check không đụng vào hệ thống; mode=full áp dụng rồi hoàn tác từng tweak */
export async function POST(req: NextRequest) {
  try {
    const raw: unknown = await req.json().catch(() => null)
    if (raw === null) {
      return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
    }
    const body = postSchema.safeParse(raw)
    if (!body.success) {
      return NextResponse.json({ error: 'Cần trường mode: check|full' }, { status: 400 })
    }
    const report = await runSelftest(body.data.mode, body.data.webhook)
    return NextResponse.json({ report })
  } catch (e) {
    console.error('[api/selftest POST]', e)
    return NextResponse.json({ error: `Lỗi máy chủ khi chạy self-test: ${(e as Error).message}` }, { status: 500 })
  }
}

// Ghi chú cho bảo trì: WEBHOOK_SETTING_KEY được re-export để test/ops tìm key trong DB
export { WEBHOOK_SETTING_KEY }
