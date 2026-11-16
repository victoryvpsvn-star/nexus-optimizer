import { NextRequest, NextResponse } from 'next/server'
import { listProcesses } from '@/lib/sysinfo'
import { run } from '@/lib/exec'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const list = await listProcesses()
    return NextResponse.json({ list })
  } catch (e) {
    console.error('[api/processes GET]', e)
    return NextResponse.json({ error: 'Không đọc được danh sách tiến trình' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const pid = Number(req.nextUrl.searchParams.get('pid'))
  if (!Number.isInteger(pid) || pid <= 1) {
    return NextResponse.json({ success: false, message: 'PID không hợp lệ' }, { status: 400 })
  }
  // Chặn tuyệt đối việc tự kills máy chủ API hoặc tiến trình cha của nó
  if (pid === process.pid) {
    return NextResponse.json(
      { success: false, message: 'Không thể dừng tiến trình của chính máy chủ API' },
      { status: 400 },
    )
  }
  const ppid = Number(process.ppid)
  if (Number.isInteger(ppid) && pid === ppid) {
    return NextResponse.json(
      { success: false, message: 'Không thể dừng tiến trình cha của máy chủ API' },
      { status: 400 },
    )
  }
  try {
    process.kill(pid, 'SIGTERM')
    return NextResponse.json({
      success: true,
      message: `Đã gửi tín hiệu dừng tới tiến trình ${pid}`,
    })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    const message =
      err.code === 'EPERM'
        ? `Không đủ quyền để dừng tiến trình ${pid} (thuộc user khác)`
        : err.code === 'ESRCH'
          ? `Tiến trình ${pid} không tồn tại`
          : `Lỗi: ${err.message}`
    return NextResponse.json({ success: false, message }, { status: 200 })
  }
}
