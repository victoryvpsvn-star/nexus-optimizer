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

// ---------- Resolver công cụ hệ thống Windows (chống ENOENT khi PATH hỏng) ----------

/**
 * Thư mục System32 thực (không phụ thuộc PATH). Trên Windows x64 chạy process x64,
 * System32 là bản thật; nếu lỡ process 32-bit thì Sysnative mới là bản thật.
 */
export function winSysDir(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return path.join(root, 'System32')
}

/** Tìm exe hệ thống theo đường dẫn tuyệt đối trong System32 (không qua PATH) — trả về null nếu không có file */
export function findSysExe(name: string): string | null {
  if (!isWin) return null
  const candidates = [
    path.join(winSysDir(), name),
    // Sysnative chỉ có với process 32-bit trên OS 64-bit — existsSync trả false nếu không dùng được
    path.join(
      process.env.SystemRoot || process.env.windir || 'C:\\Windows',
      'Sysnative',
      name,
    ),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* bỏ qua — thử candidate kế */
    }
  }
  return null
}

// ---------- PowerShell resolver ----------

export interface PsResolveResult {
  exe: string | null
  detail: string
}

let psCache: PsResolveResult | undefined

/**
 * Tìm PowerShell theo ĐƯỜNG DẪN TUYỆT ĐỐI trước, chỉ dùng PATH làm phương án cuối.
 * Đây là bản vá gốc rễ cho lỗi "spawn powershell.exe ENOENT": máy đã tinh chỉnh sâu
 * thường mất dòng PATH của WindowsPowerShell, dù file powershell.exe vẫn nằm nguyên
 * trong System32\WindowsPowerShell\v1.0. Nếu PowerShell 5.1 bị gỡ hẳn thì thử pwsh 7.
 * - NEXUS_PS_OVERRIDE: đường dẫn PS tùy chọn (dùng khi test / máy đặc biệt).
 * - Kết quả tìm THÀNH CÔNG được cache trong process; thất bại không cache (rẻ, chỉ vài existsSync).
 */
export async function resolvePowerShellExe(force = false): Promise<PsResolveResult> {
  if (!isWin) return { exe: null, detail: 'Không phải Windows' }
  if (!force && psCache) return psCache

  // 0) Ghi đè tay qua biến môi trường
  const override = process.env.NEXUS_PS_OVERRIDE
  if (override) {
    try {
      if (fs.existsSync(override)) {
        psCache = { exe: override, detail: `NEXUS_PS_OVERRIDE=${override}` }
        return psCache
      }
    } catch {
      /* bỏ qua */
    }
  }

  const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
  const candidates: { exe: string; note: string }[] = [
    {
      exe: path.join(winSysDir(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      note: 'Windows PowerShell 5.1 (System32)',
    },
    { exe: path.join(progFiles, 'PowerShell', '7', 'pwsh.exe'), note: 'PowerShell 7 (Program Files)' },
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c.exe)) {
        psCache = { exe: c.exe, detail: c.note }
        return psCache
      }
    } catch {
      /* thử candidate kế */
    }
  }

  // 1) Tìm qua where.exe bằng đường dẫn tuyệt đối (where.exe luôn nằm trong System32)
  const where = findSysExe('where.exe')
  if (where) {
    for (const name of ['pwsh.exe', 'powershell.exe']) {
      const r = await runExe(where, [name], 8000)
      const first = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0]
      if (r.ok && first) {
        psCache = { exe: first, detail: `tìm thấy qua where.exe: ${first}` }
        return psCache
      }
    }
  }

  // 2) Phương án cuối: để OS tự tra PATH (có thể ENOENT nếu PATH hỏng)
  psCache = {
    exe: 'powershell.exe',
    detail:
      'Không tìm thấy PowerShell theo đường dẫn chuẩn (System32\\WindowsPowerShell\\v1.0 + PowerShell 7). ' +
      'Windows có thể đã bị rút gọn PowerShell — chỉ còn phương án tra PATH, có nguy cơ ENOENT.',
  }
  return psCache
}

// ---------- Runner trực tiếp cho exe hệ thống (không cần PowerShell, không cần shell) ----------

/**
 * Spawn trực tiếp một exe bằng đường dẫn tuyệt đối với mảng tham số — không shell,
 * không phụ thuộc PATH, không lo lỗi escape. Chuẩn hóa stdout/stderr UTF-8 về text.
 */
export function runExe(exePath: string, args: string[], timeoutMs = 20000): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(exePath, args, { windowsHide: true })
    const finish = (ok: boolean, code: number, extraErr = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* đã thoát sẵn */
      }
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
      if (!settled) stdout += String(d)
    })
    child.stderr?.on('data', (d) => {
      if (!settled) stderr += String(d)
    })
    child.on('error', (e) => {
      const enoent = (e as NodeJS.ErrnoException).code === 'ENOENT'
      finish(
        false,
        -1,
        enoent
          ? `\nKhông gọi được ${exePath}: file không tồn tại hoặc bị chặn (ENOENT)`
          : `\n${String(e)}`,
      )
    })
    child.on('close', (code) => {
      finish(code === 0, typeof code === 'number' ? code : -1)
    })
    child.stdin?.on('error', () => {})
  })
}

/**
 * Chạy exe hệ thống theo TÊN (reg.exe, powercfg.exe, sc.exe, ipconfig.exe, bcdedit.exe...):
 * ưu tiên đường dẫn tuyệt đối trong System32 (không phụ thuộc PATH), nếu thiếu thì
 * spawn theo tên cho OS tự tra PATH. Trả về lỗi trung thực khi exe không tồn tại.
 */
export async function runSysExe(name: string, args: string[], timeoutMs = 20000): Promise<RunResult> {
  const abs = findSysExe(name)
  if (abs) return runExe(abs, args, timeoutMs)
  // Phương án dự phòng: theo tên (PATH)
  const r = await runExe(name, args, timeoutMs)
  if (!r.ok && r.code === -1 && /ENOENT/i.test(r.stderr)) {
    return {
      ok: false,
      stdout: '',
      stderr: `Không tìm thấy ${name} trong System32 và PATH — công cụ hệ thống bị thiếu/bị chặn`,
      code: -1,
    }
  }
  return r
}

/**
 * Chạy một script PowerShell trên Windows qua file .ps1 tạm (UTF-8 + BOM):
 * - Vấn đề codepage: PS 5.1 giải mã stdin theo OEM/ANSI codepage → username/đường dẫn
 *   tiếng Việt có dấu (vd C:\Users\Phạm\...) bị lỗi font, đo/clean sai hoặc im lặng.
 *   Ghi script ra file UTF-8 có BOM giúp PS đọc script đúng 100%.
 * - Prologue đặt [Console]::OutputEncoding = UTF8 để output về Node cũng là UTF-8.
 * - Muốn trả exit code khác 0 thì kết thúc script bằng `exit <n>` (hoặc throw).
 * - Dữ liệu trả về nên Write-Output / ConvertTo-Json rồi parse phía TS.
 * - PowerShell được resolve theo đường dẫn tuyệt đối (xem resolvePowerShellExe) —
 *   không còn lỗi ENOENT do PATH hỏng trên máy đã tinh chỉnh.
 * Trên Linux/macOS luôn trả về thất bại trung thực (không giả lập).
 */
export async function psRun(script: string, timeoutMs = 30000): Promise<RunResult> {
  if (!isWin) {
    return { ok: false, stdout: '', stderr: 'PowerShell chỉ khả dụng trên Windows', code: -3 }
  }
  const resolved = await resolvePowerShellExe()
  if (!resolved.exe) {
    return {
      ok: false,
      stdout: '',
      stderr: `Không tìm thấy PowerShell trên máy này (${resolved.detail})`,
      code: -7,
    }
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
      resolved.exe as string,
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
    child.on('error', (e) => {
      const enoent = (e as NodeJS.ErrnoException).code === 'ENOENT'
      finish(
        false,
        -1,
        enoent
          ? `\nKhông gọi được PowerShell (${resolved.exe}): file không tồn tại hoặc bị chặn (ENOENT)`
          : `\n${String(e)}`,
      )
    })
    child.on('close', (code) => {
      if (settled) return
      finish(code === 0, typeof code === 'number' ? code : -1)
    })
    // stdin không dùng nhưng vẫn phải nuốt sự kiện error (EPIPE khi PS chết sớm)
    // để không làm crash toàn bộ server (unhandled 'error' trên stream)
    child.stdin?.on('error', () => {})
  })
}

// ---------- Trạng thái runtime Windows (Admin + PowerShell + công cụ) ----------

export interface WinRuntimeStatus {
  isWin: boolean
  /** PowerShell tìm được hay không (đường dẫn tuyệt đối) */
  psFound: boolean
  psPath?: string
  psDetail: string
  /** Có quyền Administrator hay không + phương pháp kiểm tra */
  admin: boolean
  adminMethod: 'hklm-write' | 'ps-isinrole' | 'unknown' | 'not-windows'
  /** reg.exe có sẵn không (công cụ registry cốt lõi) */
  regOk: boolean
}

let statusCache: WinRuntimeStatus | undefined
let statusCacheAt = 0
const STATUS_TTL_MS = 15_000

/**
 * Trạng thái runtime Windows: PS theo đường dẫn tuyệt đối; quyền Admin kiểm tra bằng
 * cách GHI THỬ một giá trị registry HKLM qua reg.exe (không phụ thuộc PowerShell —
 * sửa triệt để việc báo nhầm "Cần quyền Administrator" khi thực ra là lỗi spawn PS).
 * Kết quả cache 15s để không lặp reg.exe hàng chục lần trong 1 lần áp dụng nhiều tweak.
 */
export async function getWinStatus(force = false): Promise<WinRuntimeStatus> {
  if (!isWin) {
    return {
      isWin: false,
      psFound: false,
      psDetail: 'Không phải Windows',
      admin: false,
      adminMethod: 'not-windows',
      regOk: false,
    }
  }
  if (!force && statusCache && Date.now() - statusCacheAt < STATUS_TTL_MS) return statusCache

  const ps = await resolvePowerShellExe()
  const regOk = findSysExe('reg.exe') !== null

  let admin = false
  let adminMethod: WinRuntimeStatus['adminMethod'] = 'unknown'

  // Cách 1: ghi thử HKLM bằng reg.exe — chuẩn user không có quyền ghi HKLM nên exit code != 0
  const reg = findSysExe('reg.exe')
  if (reg) {
    const testKey = 'HKLM\\SOFTWARE\\NexusOptimizer'
    const testVal = 'AdminProbe'
    const w = await runExe(reg, ['add', testKey, '/v', testVal, '/t', 'REG_DWORD', '/d', '1', '/f'], 8000)
    if (w.ok) {
      admin = true
      adminMethod = 'hklm-write'
      // dọn probe — lỗi xóa không ảnh hưởng kết quả
      await runExe(reg, ['delete', testKey, '/v', testVal, '/f'], 8000)
    }
  }

  // Cách 2 (dự phòng khi thiếu reg.exe): PS IsInRole
  if (!admin && ps.exe) {
    const r = await psRun(
      "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator).ToString()",
      8000,
    )
    if (r.ok) {
      admin = /true/i.test(r.stdout)
      adminMethod = 'ps-isinrole'
    }
  }

  statusCache = {
    isWin: true,
    psFound: ps.exe !== null,
    psPath: ps.exe ?? undefined,
    psDetail: ps.detail,
    admin,
    adminMethod,
    regOk,
  }
  statusCacheAt = Date.now()
  return statusCache
}

/** Tương thích API cũ: true/false có quyền Administrator (dùng getWinStatus cho chi tiết) */
export async function isAdminWin(): Promise<boolean> {
  if (!isWin) return false
  return (await getWinStatus()).admin
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
