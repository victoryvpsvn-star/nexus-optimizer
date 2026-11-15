'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Eraser,
  FileCode2,
  Loader2,
  Play,
  Save,
  SquareTerminal,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import { useApp } from '@/lib/store'
import type { ScriptLanguage, ScriptRecord, ScriptRunResponse } from '@/lib/types'

const LANG_LABEL: Record<ScriptLanguage, string> = {
  bash: 'Bash / Shell',
  python: 'Python',
  powershell: 'PowerShell',
}

const EXAMPLES: { lang: ScriptLanguage; label: string; code: string }[] = [
  {
    lang: 'bash',
    label: 'Ví dụ Bash',
    code: `# Kiểm tra disk + RAM nhanh\nuptime\ndf -h /\nfree -h\n`,
  },
  {
    lang: 'python',
    label: 'Ví dụ Python',
    code: `import platform, os\nprint("Máy chủ:", platform.node())\nprint("Python:", platform.python_version())\nprint("CPU cores:", os.cpu_count())\n`,
  },
  {
    lang: 'powershell',
    label: 'Ví dụ PowerShell',
    code: `Get-ComputerInfo | Select-Object CsName, OsName\nGet-Process | Sort-Object CPU -Descending | Select-Object -First 5 Name, CPU\n`,
  },
]

export function ScriptPanel() {
  const hydrated = useApp((s) => s.hydrated)
  const [scripts, setScripts] = useState<ScriptRecord[]>([])
  const [name, setName] = useState('')
  const [language, setLanguage] = useState<ScriptLanguage>('bash')
  const [code, setCode] = useState(EXAMPLES[0].code)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ScriptRunResponse | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/script', { cache: 'no-store' })
      const json = (await r.json().catch(() => null)) as
        | { scripts?: ScriptRecord[]; error?: string }
        | null
      if (!r.ok || !json || json.error) {
        throw new Error(json?.error ?? 'Không tải được danh sách script')
      }
      setScripts(json.scripts ?? [])
      setLoadFailed(false)
    } catch (e) {
      setLoadFailed(true)
      toast.error((e as Error).message || 'Không tải được danh sách script')
    }
  }, [])

  useEffect(() => {
    if (hydrated) load()
  }, [hydrated, load])

  const runDirect = async () => {
    if (!code.trim()) {
      toast.warning('Chưa có nội dung script để chạy')
      return
    }
    setRunning(true)
    setResult(null)
    try {
      const r = await fetch('/api/script', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run-direct', language, code }),
      })
      const json = (await r.json().catch(() => null)) as (ScriptRunResponse & { error?: string }) | null
      if (!r.ok || !json) throw new Error(json?.error ?? 'Chạy script thất bại')
      setResult(json)
      if (json.success) toast.success(`Chạy thành công (${(json.durationMs / 1000).toFixed(1)}s)`)
      else if (json.timedOut) toast.error('Script bị dừng do vượt quá thời gian cho phép')
      else toast.warning(`Script kết thúc với mã lỗi ${json.exitCode}`)
    } catch (e) {
      toast.error((e as Error).message || 'Chạy script thất bại')
    } finally {
      setRunning(false)
    }
  }

  const save = async () => {
    if (!name.trim()) {
      toast.warning('Đặt tên cho script trước khi lưu')
      return
    }
    if (!code.trim()) {
      toast.warning('Chưa có nội dung script để lưu')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), language, code }),
      })
      const json = (await r.json().catch(() => null)) as { script?: ScriptRecord; error?: string }
      if (!r.ok || !json.script) throw new Error(json.error ?? 'Không lưu được script')
      toast.success(`Đã lưu script "${json.script.name}"`)
      await load()
    } catch (e) {
      toast.error((e as Error).message || 'Không lưu được script')
    } finally {
      setSaving(false)
    }
  }

  const runSaved = async (s: ScriptRecord) => {
    setBusyId(s.id)
    setResult(null)
    toast.info(`Đang chạy "${s.name}"...`)
    try {
      const r = await fetch('/api/script', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run', id: s.id }),
      })
      const json = (await r.json().catch(() => null)) as (ScriptRunResponse & { error?: string }) | null
      if (!r.ok || !json) throw new Error(json?.error ?? 'Chạy script thất bại')
      setResult(json)
      if (json.success) toast.success(`"${s.name}" chạy thành công`)
      else if (json.timedOut) toast.error(`"${s.name}" vượt quá thời gian cho phép`)
      else toast.warning(`"${s.name}" kết thúc với mã lỗi ${json.exitCode}`)
    } catch (e) {
      toast.error((e as Error).message || 'Chạy script thất bại')
    } finally {
      setBusyId(null)
    }
  }

  const loadIntoEditor = (s: ScriptRecord) => {
    setCode(s.code ?? '')
    setLanguage(s.language)
    setName(s.name)
    toast.info(`Đã nạp "${s.name}" vào trình soạn thảo`)
  }

  const deleteScript = async (id: number) => {
    setBusyId(id)
    try {
      const r = await fetch(`/api/script?id=${id}`, { method: 'DELETE' })
      const json = (await r.json().catch(() => null)) as { success?: boolean; error?: string }
      if (!r.ok || !json.success) throw new Error(json.error ?? 'Không xóa được script')
      toast.success('Đã xóa script')
      await load()
    } catch (e) {
      toast.error((e as Error).message || 'Không xóa được script')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* Cảnh báo Advanced */}
      <div
        className="flex items-start gap-3 rounded-2xl border px-4 py-3"
        style={{
          borderColor: 'color-mix(in srgb, #f59e0b 40%, transparent)',
          background: 'color-mix(in srgb, #f59e0b 10%, transparent)',
        }}
      >
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <p className="text-xs leading-relaxed text-zinc-600">
          <strong className="font-semibold text-zinc-700">Chế độ Advanced:</strong> script được chạy
          trực tiếp trên máy chủ bằng Bash, Python hoặc PowerShell. Chỉ chạy script bạn hiểu rõ —
          công cụ không chịu trách nhiệm với script do người dùng tự viết.
        </p>
      </div>

      {/* Trình soạn thảo */}
      <Card className="glass rounded-2xl p-5">
        <div className="mb-3 flex items-center gap-2.5">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10"
            style={{ background: 'color-mix(in srgb, var(--accent-1) 14%, transparent)' }}
          >
            <SquareTerminal className="h-5 w-5" style={{ color: 'var(--accent-1)' }} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Trình soạn thảo script</h3>
            <p className="text-xs text-zinc-500">Viết code, chọn ngôn ngữ rồi bấm chạy</p>
          </div>
          <div className="ml-auto hidden gap-1.5 sm:flex">
            {EXAMPLES.map((ex) => (
              <Button
                key={ex.label}
                size="sm"
                variant="ghost"
                className="h-8 rounded-full px-3 text-xs text-zinc-400 hover:text-zinc-200"
                onClick={() => {
                  setLanguage(ex.lang)
                  setCode(ex.code)
                }}
                aria-label={`Chèn ${ex.label} vào trình soạn thảo`}
              >
                <FileCode2 className="mr-1 h-3.5 w-3.5" />
                {ex.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400" htmlFor="script-name">
              Tên script (để lưu)
            </label>
            <Input
              id="script-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="vd: kiem-tra-disk"
              className="h-10 rounded-xl border-white/10 bg-white/5 text-zinc-100 placeholder:text-zinc-400"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400" htmlFor="script-lang">
              Ngôn ngữ
            </label>
            <Select value={language} onValueChange={(v) => setLanguage(v as ScriptLanguage)}>
              <SelectTrigger id="script-lang" className="h-10 rounded-xl border-white/10 bg-white/5 text-zinc-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-xl">
                {(Object.keys(LANG_LABEL) as ScriptLanguage[]).map((l) => (
                  <SelectItem key={l} value={l} className="rounded-lg">
                    {LANG_LABEL[l]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          className="num min-h-[240px] rounded-2xl border-white/10 bg-white/5 text-[13px] leading-relaxed text-zinc-100 placeholder:text-zinc-400 focus-visible:ring-[color:var(--accent-1)]"
          placeholder="# Dán script của bạn vào đây..."
          aria-label="Nội dung script"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            onClick={runDirect}
            disabled={running}
            className="h-10 rounded-xl px-6 font-semibold text-black"
            style={{ background: 'var(--accent-1)' }}
            aria-label="Chạy script"
          >
            {running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
            {running ? 'Đang chạy...' : 'Chạy script'}
          </Button>
          <Button
            onClick={save}
            disabled={saving}
            variant="outline"
            className="h-10 rounded-xl border-white/10 bg-transparent text-zinc-200 hover:bg-white/10"
            aria-label="Lưu script"
          >
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
            Lưu script
          </Button>
          <Button
            onClick={() => {
              setCode('')
              setResult(null)
            }}
            variant="ghost"
            className="h-10 rounded-xl px-3 text-zinc-400 hover:text-zinc-200"
            aria-label="Xóa nội dung trình soạn thảo"
          >
            <Eraser className="mr-1.5 h-4 w-4" />
            Xóa Editor
          </Button>
          <span className="num ml-auto text-xs text-zinc-400">{code.length.toLocaleString('vi-VN')} ký tự</span>
        </div>
      </Card>

      {/* Kết quả chạy */}
      {result && (
        <Card className="glass rounded-2xl p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-100">Kết quả</h3>
            <Badge
              className={
                result.success
                  ? 'rounded-full border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                  : 'rounded-full border-rose-500/40 bg-rose-500/10 text-rose-500'
              }
            >
              {result.success ? 'Thành công' : 'Có lỗi'}
            </Badge>
            <Badge variant="outline" className="num rounded-full border-white/10 text-zinc-400">
              exit {result.exitCode}
            </Badge>
            <Badge variant="outline" className="num rounded-full border-white/10 text-zinc-400">
              {(result.durationMs / 1000).toFixed(2)}s
            </Badge>
            {result.timedOut && (
              <Badge className="rounded-full border-amber-500/40 bg-amber-500/10 text-amber-500">
                Vượt thời gian chờ
              </Badge>
            )}
          </div>
          {result.message && (
            <p className="mb-2 text-xs text-rose-500">{result.message}</p>
          )}
          <pre className="thin-scroll max-h-96 overflow-auto whitespace-pre-wrap rounded-2xl border border-white/10 bg-white/5 p-4 text-xs leading-relaxed text-zinc-200">
            {result.output || '(Trống)'}
          </pre>
        </Card>
      )}

      {/* Script đã lưu */}
      <Card className="glass rounded-2xl p-5">
        <div className="mb-3 flex items-center gap-2.5">
          <h3 className="text-sm font-semibold text-zinc-100">Script đã lưu</h3>
          <Badge variant="outline" className="num ml-auto rounded-full border-white/10 text-zinc-400">
            {loadFailed ? '!' : scripts.length}
          </Badge>
          {loadFailed && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 rounded-full px-3 text-xs text-zinc-400"
              onClick={load}
            >
              Thử lại
            </Button>
          )}
        </div>
        {scripts.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-500">
            Chưa có script nào được lưu — viết code ở trên rồi bấm “Lưu script”.
          </p>
        ) : (
          <div className="thin-scroll max-h-80 space-y-2 overflow-y-auto">
            {scripts.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-200">{s.name}</p>
                  <p className="num text-[11px] text-zinc-400">
                    {LANG_LABEL[s.language]} · cập nhật {new Date(s.updatedAt).toLocaleString('vi-VN')}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Nạp vào trình soạn thảo"
                    aria-label={`Nạp script ${s.name} vào trình soạn thảo`}
                    className="h-9 rounded-lg px-2.5 text-zinc-300 hover:text-zinc-200"
                    onClick={() => loadIntoEditor(s)}
                  >
                    <FileCode2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Chạy script này"
                    aria-label={`Chạy script ${s.name}`}
                    disabled={busyId === s.id}
                    className="h-9 rounded-lg px-2.5 text-zinc-300 hover:text-zinc-200"
                    onClick={() => runSaved(s)}
                  >
                    {busyId === s.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Xóa script này"
                        aria-label={`Xóa script ${s.name}`}
                        disabled={busyId === s.id}
                        className="h-9 rounded-lg px-2.5 text-rose-500 hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="glass rounded-2xl border-white/10">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="text-zinc-100">
                          Xóa script “{s.name}”?
                        </AlertDialogTitle>
                        <AlertDialogDescription className="text-zinc-400">
                          Script sẽ bị xóa vĩnh viễn khỏi danh sách đã lưu.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="rounded-xl border-white/10 bg-transparent text-zinc-200 hover:bg-white/10">
                          Hủy
                        </AlertDialogCancel>
                        <AlertDialogAction
                          className="rounded-xl bg-rose-600 text-white hover:bg-rose-500"
                          onClick={() => deleteScript(s.id)}
                        >
                          Xóa
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

export default ScriptPanel
