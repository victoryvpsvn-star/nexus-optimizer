import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'
import { randomBytes } from 'crypto'
import type { ScreenshotInfo } from '@/lib/types'

export const dynamic = 'force-dynamic'

const SHOT_DIR = path.join(process.cwd(), 'public', 'screenshots')
const MAX_BYTES = 15 * 1024 * 1024
/** Ngưỡng chặn sớm theo Content-Length (hơi rộng hơn MAX_BYTES cho phần bao JSON) */
const HARD_BYTES = 16 * 1024 * 1024

export async function POST(req: NextRequest) {
  try {
    // Chặn sớm theo Content-Length TRƯỚC khi parse JSON — tránh tốn bộ nhớ với payload khổng lồ (DoS)
    const contentLength = Number(req.headers.get('content-length') ?? '0')
    if (Number.isFinite(contentLength) && contentLength > HARD_BYTES) {
      return NextResponse.json({ error: 'Ảnh quá lớn (tối đa 16MB)' }, { status: 413 })
    }
    const body = (await req.json().catch(() => null)) as { dataUrl?: string } | null
    if (body === null) {
      return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
    }
    const dataUrl = body?.dataUrl ?? ''
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
      return NextResponse.json({ error: 'Dữ liệu ảnh không hợp lệ' }, { status: 400 })
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const buf = Buffer.from(base64, 'base64')
    // Kiểm tra kích thước THỰC của ảnh đã decode (không tin content-length)
    if (buf.length > MAX_BYTES) {
      return NextResponse.json({ error: 'Ảnh quá lớn (>15MB)' }, { status: 413 })
    }
    await fs.mkdir(SHOT_DIR, { recursive: true })
    const file = `shot-${Date.now()}-${randomBytes(4).toString('hex')}.png`
    await fs.writeFile(path.join(SHOT_DIR, file), buf)
    return NextResponse.json({
      file,
      url: `/screenshots/${file}`,
      createdAt: new Date().toISOString(),
      sizeBytes: buf.length,
    } satisfies ScreenshotInfo)
  } catch (e) {
    console.error('[api/screenshot POST]', e)
    return NextResponse.json({ error: 'Không lưu được ảnh chụp' }, { status: 500 })
  }
}

export async function GET() {
  try {
    await fs.mkdir(SHOT_DIR, { recursive: true })
    const files = await fs.readdir(SHOT_DIR)
    const shots: ScreenshotInfo[] = []
    for (const f of files.filter((f) => f.endsWith('.png')).sort().reverse()) {
      const st = await fs.stat(path.join(SHOT_DIR, f))
      shots.push({
        file: f,
        url: `/screenshots/${f}`,
        createdAt: st.mtime.toISOString(),
        sizeBytes: st.size,
      })
    }
    return NextResponse.json({ shots })
  } catch (e) {
    console.error('[api/screenshot GET]', e)
    return NextResponse.json({ shots: [] })
  }
}

export async function DELETE(req: NextRequest) {
  const file = req.nextUrl.searchParams.get('file') ?? ''
  // Chấp nhận cả tên cũ (shot-<ts>.png) và tên mới có thêm suffix ngẫu nhiên (shot-<ts>-<hex8>.png)
  if (!/^shot-\d+(?:-[0-9a-f]{8})?\.png$/.test(file)) {
    return NextResponse.json({ error: 'Tên file không hợp lệ' }, { status: 400 })
  }
  try {
    await fs.unlink(path.join(SHOT_DIR, file))
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Không xóa được file' }, { status: 500 })
  }
}
