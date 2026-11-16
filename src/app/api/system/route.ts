import { NextRequest, NextResponse } from 'next/server'
import os from 'os'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { z } from 'zod'
import { isWin, getWinStatus, resolvePowerShellExe } from '@/lib/exec'

export const dynamic = 'force-dynamic'

const postSchema = z.object({ action: z.enum(['relaunch-admin']) })

function dataDir(): string {
  return process.env.NEXUS_DATA_DIR || os.tmpdir()
}

/** GET: trạng thái quyền + PowerShell + hệ thống cho UI */
export async function GET() {
  try {
    if (!isWin) {
      return NextResponse.json({
        isWin: false,
        platform: process.platform,
        osRelease: os.release(),
        note: 'Nâng quyền chỉ dùng được trong bản Windows .exe',
      })
    }
    const st = await getWinStatus()
    return NextResponse.json({
      isWin: true,
      platform: process.platform,
      osRelease: os.release(),
      admin: st.admin,
      adminMethod: st.adminMethod,
      powershellFound: st.psFound,
      powershellPath: st.psPath,
      powershellDetail: st.psDetail,
      regOk: st.regOk,
      appExe: path.basename(process.env.NEXUS_EXE || process.execPath),
    })
  } catch (e) {
    console.error('[api/system GET]', e)
    return NextResponse.json({ error: 'Lỗi máy chủ khi đọc trạng thái hệ thống' }, { status: 500 })
  }
}

/**
 * POST relaunch-admin: ghi flag và yêu cầu Electron thoát SẠCH (exit 0);
 * main.js đọc flag rồi thoát im lặng, tiến trình PS detached đã spawn trước đó
 * sẽ Start-Process -Verb RunAs ứng dụng sau 3 giây → UAC hỏi xác nhận.
 */
export async function POST(req: NextRequest) {
  try {
    const raw: unknown = await req.json().catch(() => null)
    if (raw === null) {
      return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
    }
    const body = postSchema.safeParse(raw)
    if (!body.success || body.data.action !== 'relaunch-admin') {
      return NextResponse.json({ error: 'Cần { action: "relaunch-admin" }' }, { status: 400 })
    }
    if (!isWin) {
      return NextResponse.json({ error: 'Nâng quyền chỉ dùng được trên Windows' }, { status: 400 })
    }
    const st = await getWinStatus()
    if (st.admin) {
      return NextResponse.json({ alreadyAdmin: true, message: 'App đang chạy với quyền Administrator sẵn rồi' })
    }
    const ps = await resolvePowerShellExe()
    if (!ps.exe) {
      return NextResponse.json(
        {
          error: `Không tìm thấy PowerShell nên không tự nâng quyền được (${ps.detail}) — hãy nhấp chuột phải vào NEXUS Optimizer và chọn "Run as administrator"`,
        },
        { status: 500 },
      )
    }
    const exe = process.env.NEXUS_EXE || process.execPath
    if (!fs.existsSync(exe)) {
      return NextResponse.json(
        { error: `Không tìm thấy file ứng dụng: ${exe} — hãy chạy lại bằng quyền Admin thủ công` },
        { status: 500 },
      )
    }
    // Flag file: main.js đọc khi server thoát với code 0 để thoát im lặng (hợp lệ < 60s)
    const flagPath = path.join(dataDir(), 'relaunch-elevated.flag')
    fs.writeFileSync(flagPath, JSON.stringify({ at: Date.now(), pid: process.pid }), 'utf8')
    // Tiến trình PS detached sống sót sau khi server + electron đóng; chờ 3s để app cũ thoát hết
    const inner = `Start-Sleep -Seconds 3; Start-Process -FilePath '${exe.replace(/'/g, "''")}' -Verb RunAs`
    const child = spawn(ps.exe, ['-NoProfile', '-Command', inner], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    child.unref()
    // Đợi response kịp tới UI rồi mới thoát server sạch (main.js sẽ đóng app im lặng)
    setTimeout(() => {
      process.exit(0)
    }, 1500)
    return NextResponse.json({
      ok: true,
      message:
        'Đã yêu cầu Windows mở lại NEXUS Optimizer với quyền Admin — hộp thoại UAC sẽ hiện sau vài giây; app hiện tại sẽ tự đóng.',
    })
  } catch (e) {
    console.error('[api/system POST]', e)
    return NextResponse.json({ error: `Không nâng quyền được: ${(e as Error).message}` }, { status: 500 })
  }
}
