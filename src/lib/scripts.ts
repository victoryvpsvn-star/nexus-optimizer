// Engine chạy script tùy chỉnh (Advanced) — spawn an toàn với timeout + giới hạn output
import { spawn } from 'child_process'
import os from 'os'
import type { ScriptLanguage, ScriptRunResponse } from '@/lib/types'

/** Giới hạn ký tự output trả về client */
export const MAX_OUTPUT_CHARS = 60000
export const MAX_CODE_CHARS = 20000
export const DEFAULT_TIMEOUT_MS = 90_000
export const MAX_TIMEOUT_MS = 180_000

export function isWindows(): boolean {
  return process.platform === 'win32'
}

/** Ngôn ngữ khả dụng theo hệ điều hành (thứ tự gợi ý hiển thị) */
export function supportedLanguages(): ScriptLanguage[] {
  if (isWindows()) return ['powershell', 'python', 'bash']
  return ['bash', 'python', 'powershell']
}

export const LANG_LABELS: Record<ScriptLanguage, string> = {
  bash: 'Bash / Shell',
  python: 'Python',
  powershell: 'PowerShell',
}

interface SpawnSpec {
  file: string
  args: string[]
  hint: string // gợi ý lỗi khi thiếu chương trình
}

function specFor(lang: ScriptLanguage): SpawnSpec {
  if (lang === 'bash') {
    if (isWindows()) {
      return { file: 'bash', args: ['-lc', 'PLACEHOLDER'], hint: 'Trên Windows cần Git Bash đã cài và có trong PATH' }
    }
    return { file: 'bash', args: ['-lc', 'PLACEHOLDER'], hint: 'Không tìm thấy bash trên máy này' }
  }
  if (lang === 'python') {
    return isWindows()
      ? { file: 'python', args: ['-X', 'utf8', '-c', 'PLACEHOLDER'], hint: 'Không tìm thấy python trên máy này (cần cài Python)' }
      : { file: 'python3', args: ['-u', '-c', 'PLACEHOLDER'], hint: 'Không tìm thấy python3 trên máy này' }
  }
  return isWindows()
    ? {
        file: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', 'PLACEHOLDER'],
        hint: 'Không tìm thấy powershell trên máy này',
      }
    : {
        file: 'pwsh',
        args: ['-NoProfile', '-NonInteractive', '-Command', 'PLACEHOLDER'],
        hint: 'Trên Linux/macOS cần PowerShell Core (pwsh) đã cài',
      }
}

/**
 * Chạy code trực tiếp bằng ngôn ngữ chọn. Output bị cắt ở MAX_OUTPUT_CHARS.
 * Đây là tool admin cục bộ — người dùng tự chịu trách nhiệm với script của mình.
 */
export function runScriptCode(
  code: string,
  language: ScriptLanguage,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ScriptRunResponse> {
  const spec = specFor(language)
  // PowerShell trên Windows dùng OEM codepage khi stdout bị pipe → ép UTF-8 đầu Command
  const finalCode =
    language === 'powershell'
      ? '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + code
      : code
  const args = spec.args.map((a) => (a === 'PLACEHOLDER' ? finalCode : a))
  const timeout = Math.min(Math.max(timeoutMs || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS)
  const started = Date.now()

  return new Promise<ScriptRunResponse>((resolve) => {
    let child
    try {
      child = spawn(spec.file, args, {
        cwd: process.cwd(),
        env: { ...process.env, NEXUS_SCRIPT: '1' },
        windowsHide: true,
      })
    } catch {
      resolve({
        success: false,
        exitCode: -1,
        durationMs: 0,
        output: '',
        message: spec.hint,
      })
      return
    }

    let timedOut = false
    let spawnError: string | null = null
    const chunksOut: Buffer[] = []
    const chunksErr: Buffer[] = []
    let outLen = 0
    let errLen = 0
    const CAP = MAX_OUTPUT_CHARS * 4 // giữ tối đa ~4x rồi cắt khi ghép

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // bỏ qua
      }
    }, timeout)

    child.stdout?.on('data', (d: Buffer) => {
      if (outLen < CAP) {
        chunksOut.push(d)
        outLen += d.length
      }
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (errLen < CAP) {
        chunksErr.push(d)
        errLen += d.length
      }
    })
    child.on('error', (e: NodeJS.ErrnoException) => {
      spawnError = e.code === 'ENOENT' ? spec.hint : e.message
    })

    const finish = (exitCode: number) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(chunksOut).toString('utf8')
      const stderr = Buffer.concat(chunksErr).toString('utf8')
      let output = stdout
      if (stderr.trim()) {
        output += (output ? '\n' : '') + '── stderr ──\n' + stderr
      }
      let truncatedNote = ''
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS)
        truncatedNote = `\n── (output bị cắt tại ${MAX_OUTPUT_CHARS.toLocaleString('vi-VN')} ký tự) ──`
      }
      resolve({
        success: !timedOut && !spawnError && exitCode === 0,
        exitCode,
        durationMs: Date.now() - started,
        output: (output + truncatedNote) || (timedOut ? '(Không có output — script bị dừng do vượt thời gian)' : '(Không có output)'),
        timedOut,
        message: spawnError ?? undefined,
      })
    }

    child.on('close', (code, signal) => {
      if (signal) {
        finish(timedOut ? 124 : -1)
        return
      }
      finish(typeof code === 'number' ? code : -1)
    })
  })
}

export function osLabel(): string {
  return os.type() + ' · ' + os.arch()
}
