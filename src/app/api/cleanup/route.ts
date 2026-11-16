import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { scanTargets, cleanupDisk, cleanupRam, cleanupAll, RAM_NOTE } from '@/lib/cleanup'
import type { CleanupResult, CleanupScanResponse, CleanupRunResponse } from '@/lib/types'

type RunOutput = { results: CleanupResult[]; totalFreedDisk: number; totalFreedRam: number }

export const dynamic = 'force-dynamic'

// GET /api/cleanup — quét mục tiêu dọn dẹp + lịch sử 15 log gần nhất
export async function GET() {
  try {
    const targets = await scanTargets()
    const rows = await db.cleanupLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 15,
    })
    const res: CleanupScanResponse = {
      targets,
      logs: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        target: r.target,
        freedBytes: r.freedBytes,
        success: r.success,
        message: r.message ?? undefined,
        createdAt: r.createdAt.toISOString(),
      })),
      ramNote: RAM_NOTE,
    }
    return NextResponse.json(res)
  } catch (e) {
    console.error('[api/cleanup GET]', e)
    return NextResponse.json(
      { error: 'Không quét được mục tiêu dọn dẹp. Vui lòng thử lại sau.' },
      { status: 500 },
    )
  }
}

// POST /api/cleanup body { action: 'disk' | 'ram' | 'all' }
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string }
    const action = body.action
    if (action !== 'disk' && action !== 'ram' && action !== 'all') {
      return NextResponse.json(
        { error: 'Hành động không hợp lệ — chỉ nhận "disk", "ram" hoặc "all".' },
        { status: 400 },
      )
    }

    // "all" chạy dọn Disk + RAM SONG SONG (Promise.all) bên trong cleanupAll
    const out: RunOutput =
      action === 'disk'
        ? await cleanupDisk()
        : action === 'ram'
          ? await cleanupRam()
          : await cleanupAll()

    const res: CleanupRunResponse = {
      results: out.results,
      totalFreedDisk: out.totalFreedDisk,
      totalFreedRam: out.totalFreedRam,
    }
    return NextResponse.json(res)
  } catch (e) {
    console.error('[api/cleanup POST]', e)
    return NextResponse.json(
      { error: 'Đã xảy ra lỗi khi dọn dẹp. Vui lòng thử lại sau.' },
      { status: 500 },
    )
  }
}
