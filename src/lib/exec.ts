import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

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
