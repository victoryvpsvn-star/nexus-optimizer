import { NextRequest, NextResponse } from 'next/server'

/**
 * Guard nhẹ cho tool cá nhân:
 * - Chặn request mutating (POST/PUT/DELETE/PATCH) có Origin không khớp host
 *   (ngăn cross-site drive-by). GET mở để dashboard đọc dữ liệu.
 */
export function proxy(req: NextRequest) {
  const method = req.method.toUpperCase()
  const isMutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
  if (!isMutating) return NextResponse.next()

  const origin = req.headers.get('origin')
  if (origin) {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = ''
    }
    if (originHost && originHost !== req.headers.get('host')) {
      return NextResponse.json(
        { error: 'Yêu cầu bị từ chối (origin không hợp lệ)' },
        { status: 403 },
      )
    }
  }
  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}
