import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomBytes } from 'crypto'

const execAsync = promisify(exec)

/** Đang chạy trên Windows hay không — quyết định nhánh lệnh hệ thống */
export const isWin = process.platform === 'win32'

const MAX_PS_OUTPUT = 400_000
const MAX_PS_STDERR = 60_000

export interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

export async function run(cmd: string, timeoutMs = 20000): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: timeoutMs })
    return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '', code: 0 }
  } catch (e) {
    const err = e as {
      code?: number
      stdout?: string
      stderr?: string
      message?: string
      killed?: boolean
    }
    return {
      ok: false,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? 'Lỗi thực thi lệnh',
      code: typeof err.code === 'number' ? err.code : -1,
    }
  }
}

/**
 * Chạy một script PowerShell trên Windows qua file .ps1 tạm (UTF-8 + BOM):
 * - Vấn đề codepage: PS 5.1 giải mã stdin theo OEM/ANSI codepage → username/đường dẫn
 *   tiếng Việt có dấu (vd C:\Users\Phạm\...) bị lỗi font, đo/clean sai hoặc im lặng.
 *   Ghi script ra file UTF-8 có BOM giúp PS đọc script đúng 100%.
 * - Prologue đặt [Console]::OutputEncoding = UTF8 để output về Node cũng là UTF-8.
 * - Muốn trả exit code khác 0 thì kết thúc script bằng `exit <n>` (hoặc throw).
 * - Dữ liệu trả về nên Write-Output / ConvertTo-Json rồi parse phía TS.
 * Trên Linux/macOS luôn trả về thất bại trung thực (không giả lập).
 */
export async function psRun(script: string, timeoutMs = 30000): Promise<RunResult> {
  if (!isWin) {
    return { ok: false, stdout: '', stderr: 'PowerShell chỉ khả dụng trên Windows', code: -3 }
  }
  // File tạm có tên ngẫu nhiên — nhiều psRun song song không đụng nhau
  const psFile = path.join(os.tmpdir(), `nexus-ps-${Date.now()}-${randomBytes(4).toString('hex')}.ps1`)
  const prologue = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n'
  try {
    fs.writeFileSync(psFile, '\uFEFF' + prologue + script, 'utf8')
  } catch (e) {
    return { ok: false, stdout: '', stderr: `Không ghi được file PS tạm: ${String(e)}`, code: -6 }
  }
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { windowsHide: true },
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const cleanupFile = () => {
      try {
        fs.unlink(psFile, () => {})
      } catch {
        /* ignore */
      }
    }
    const finish = (ok: boolean, code: number, extraErr = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Ngừng nhận data để stream không ghi tiếp vào biến đã resolve
      child.stdout?.removeAllListeners()
      child.stderr?.removeAllListeners()
      try {
        child.kill()
      } catch {
        /* đã thoát sẵn */
      }
      cleanupFile()
      resolve({ ok, stdout, stderr: (stderr + extraErr).trim().slice(0, MAX_PS_STDERR), code })
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* đã thoát sẵn */
      }
      finish(false, -4, '\nQuá thời gian chờ (timeout)')
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      if (settled) return
      stdout += String(d)
      if (stdout.length > MAX_PS_OUTPUT) {
        finish(false, -5, '\nOutput vượt giới hạn an toàn')
      }
    })
    child.stderr?.on('data', (d) => {
      if (settled) return
      stderr += String(d)
      if (stderr.length > MAX_PS_STDERR) stderr = stderr.slice(0, MAX_PS_STDERR)
    })
    child.on('error', (e) => finish(false, -1, `\n${String(e)}`))
    child.on('close', (code) => {
      if (settled) return
      finish(code === 0, typeof code === 'number' ? code : -1)
    })
    // stdin không dùng nhưng vẫn phải nuốt sự kiện error (EPIPE khi PS chết sớm)
    // để không làm crash toàn bộ server (unhandled 'error' trên stream)
    child.stdin?.on('error', () => {})
  })
}

/** Có đang chạy với quyền Administrator trên Windows hay không */
export async function isAdminWin(): Promise<boolean> {
  if (!isWin) return false
  const r = await psRun(
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator).ToString()",
    8000,
  )
  return /true/i.test(r.stdout)
}

export async function hasSudo(): Promise<boolean> {
  const r = await run('sudo -n true', 5000)
  return r.ok
}

export async function tryRoot(cmd: string): Promise<RunResult> {
  const sudo = await hasSudo()
  if (!sudo) {
    return {
      ok: false,
      stdout: '',
      stderr: 'Cần quyền root (sudo) — máy chủ hiện không cho phép',
      code: -2,
    }
  }
  return run(`sudo -n ${cmd}`, 25000)
}
