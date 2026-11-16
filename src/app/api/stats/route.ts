import { NextResponse } from 'next/server'
import { getStats } from '@/lib/sysinfo'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const stats = await getStats()
    return NextResponse.json(stats)
  } catch (e) {
    console.error('[api/stats]', e)
    return NextResponse.json(
      { error: 'Không thu thập được số liệu hệ thống' },
      { status: 500 },
    )
  }
}
