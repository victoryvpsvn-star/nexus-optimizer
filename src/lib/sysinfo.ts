import fs from 'fs/promises'
import os from 'os'
import { run, psRun, isWin } from './exec'
import type { StatsSnapshot, DiskInfo, MemInfo } from './types'

async function cpuUsage(): Promise<number> {
  if (isWin) {
    // Windows: không có /proc/stat — lấy 2 mẫu os.cpus().times cách nhau ~150ms
    // rồi tính % bận theo công thức chuẩn (total gồm cả idle), khớp nhánh Linux.
    const sample = () => {
      let total = 0
      let idle = 0
      for (const c of os.cpus()) {
        const t = c.times
        total += t.user + t.nice + t.sys + t.irq + t.idle
        idle += t.idle
      }
      return { total, idle }
    }
    const a = sample()
    await new Promise((r) => setTimeout(r, 150))
    const b = sample()
    const dTotal = b.total - a.total
    const dIdle = b.idle - a.idle
    if (dTotal <= 0) return 0
    return Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100))
  }
  const read = async () => {
    const s = await fs.readFile('/proc/stat', 'utf8')
    const line = s.split('\n').find((l) => l.startsWith('cpu ')) ?? ''
    const p = line.trim().split(/\s+/).slice(1).map(Number)
    const idle = (p[3] ?? 0) + (p[4] ?? 0)
    const total = p.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
    return { idle, total }
  }
  const a = await read()
  await new Promise((r) => setTimeout(r, 150))
  const b = await read()
  const dTotal = b.total - a.total
  const dIdle = b.idle - a.idle
  if (dTotal <= 0) return 0
  return Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100))
}

function parseMeminfo(txt: string) {
  const get = (k: string) => {
    const m = txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))
    return m ? Number(m[1]) : 0 // kB
  }
  return {
    totalKB: get('MemTotal'),
    availableKB: get('MemAvailable'),
    cachedKB: get('Cached') + get('SReclaimable'),
    swapTotalKB: get('SwapTotal'),
    swapFreeKB: get('SwapFree'),
  }
}

type LinuxMemRaw = ReturnType<typeof parseMeminfo>

async function readMemRaw(): Promise<LinuxMemRaw | null> {
  // Windows không có /proc/meminfo — trả null, RAM đọc qua os.totalmem/os.freemem
  if (isWin) return null
  return fs.readFile('/proc/meminfo', 'utf8').then(parseMeminfo)
}

/** Ép kết quả JSON của PowerShell về mảng object (ConvertTo-Json có thể trả object đơn) */
function psRecords(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) {
    return v.filter(
      (x): x is Record<string, unknown> => typeof x === 'object' && x !== null,
    )
  }
  if (typeof v === 'object' && v !== null) return [v as Record<string, unknown>]
  return []
}

/** Đọc số từ dữ liệu PowerShell — thiếu/sai thì 0, không bịa dữ liệu */
function psNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

async function netSample(): Promise<{ rx: number; tx: number }> {
  if (isWin) {
    // Windows: tổng byte RX/TX của các card mạng thật (loại isatap/Loopback).
    // Bộ đếm là giá trị tích lũy — netRate() tự lấy 2 mẫu để tính tốc độ.
    try {
      const r = await psRun(
        `@(Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface | Where-Object { $_.Name -notmatch 'isatap|Loopback' } | Select-Object BytesReceived,BytesSent) | ConvertTo-Json -Compress`,
        8000,
      )
      if (!r.ok || !r.stdout.trim()) return { rx: 0, tx: 0 }
      const arr = psRecords(JSON.parse(r.stdout.trim()))
      let rx = 0
      let tx = 0
      for (const it of arr) {
        rx += psNum(it.BytesReceived)
        tx += psNum(it.BytesSent)
      }
      return { rx, tx }
    } catch {
      return { rx: 0, tx: 0 }
    }
  }
  const s = await fs.readFile('/proc/net/dev', 'utf8')
  let rx = 0
  let tx = 0
  for (const line of s.split('\n').slice(2)) {
    const [ifc, rest] = line.split(':')
    if (!rest) continue
    const name = ifc.trim()
    if (name === 'lo' || name.startsWith('veth') || name.startsWith('docker')) continue
    const p = rest.trim().split(/\s+/).map(Number)
    rx += p[0] ?? 0
    tx += p[8] ?? 0
  }
  return { rx, tx }
}

/** Lấy 2 mẫu net cách nhau ~150ms rồi tính tốc độ từ chính 2 mẫu đó —
 *  tránh biến module-level dùng chung bị race giữa các request song song. */
async function netRate(): Promise<{
  rxKBs: number
  txKBs: number
  rx: number
  tx: number
}> {
  const t0 = Date.now()
  const a = await netSample()
  await new Promise((r) => setTimeout(r, 150))
  const b = await netSample()
  const dt = (Date.now() - t0) / 1000
  if (dt <= 0 || b.rx < a.rx || b.tx < a.tx) {
    return { rxKBs: 0, txKBs: 0, rx: b.rx, tx: b.tx }
  }
  return {
    rxKBs: Math.max(0, (b.rx - a.rx) / dt / 1024),
    txKBs: Math.max(0, (b.tx - a.tx) / dt / 1024),
    rx: b.rx,
    tx: b.tx,
  }
}

// Tên CPU gần như không đổi — cache kết quả thành công vĩnh viễn (memoized promise)
let cpuModelWinPromise: Promise<string> | null = null

function cpuModelWin(): Promise<string> {
  if (!cpuModelWinPromise) {
    cpuModelWinPromise = psRun(
      '(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)',
      8000,
    )
      .then((r) => {
        const name = r.ok ? r.stdout.trim() : ''
        if (!name) {
          // Lỗi tạm thời → không cache vĩnh viễn, lần gọi sau sẽ thử lại
          cpuModelWinPromise = null
          return 'Không xác định'
        }
        return name
      })
      .catch(() => {
        cpuModelWinPromise = null
        return 'Không xác định'
      })
  }
  return cpuModelWinPromise
}

async function cpuModel(): Promise<string> {
  if (isWin) return cpuModelWin()
  try {
    const s = await fs.readFile('/proc/cpuinfo', 'utf8')
    const m = s.match(/^model name\s*:\s*(.+)$/m)
    return m ? m[1].trim() : 'CPU ảo (container)'
  } catch {
    return 'Không xác định'
  }
}

// Swap Windows: probe PowerShell cache 10s (chỉ cache probe thành công)
let swapWinCache: { t: number; totalMB: number; usedMB: number } | null = null

async function swapUsageWin(): Promise<{ totalMB: number; usedMB: number }> {
  if (!isWin) return { totalMB: 0, usedMB: 0 }
  if (swapWinCache && Date.now() - swapWinCache.t < 10000) {
    return { totalMB: swapWinCache.totalMB, usedMB: swapWinCache.usedMB }
  }
  try {
    // AllocatedBaseSize/CurrentUsage của Win32_PageFileUsage đã tính bằng MB
    const r = await psRun(
      '@(Get-CimInstance Win32_PageFileUsage | Select-Object AllocatedBaseSize,CurrentUsage) | ConvertTo-Json -Compress',
      8000,
    )
    if (!r.ok || !r.stdout.trim()) return { totalMB: 0, usedMB: 0 }
    const arr = psRecords(JSON.parse(r.stdout.trim()))
    let totalMB = 0
    let usedMB = 0
    for (const it of arr) {
      totalMB += psNum(it.AllocatedBaseSize)
      usedMB += psNum(it.CurrentUsage)
    }
    swapWinCache = { t: Date.now(), totalMB, usedMB }
    return { totalMB, usedMB }
  } catch {
    // Lỗi probe → 0/0 trung thực, không cache để lần sau thử lại
    return { totalMB: 0, usedMB: 0 }
  }
}

let diskCache: { t: number; data: DiskInfo[] } | null = null

async function disksWin(): Promise<DiskInfo[]> {
  if (diskCache && Date.now() - diskCache.t < 30000) return diskCache.data
  try {
    const r = await psRun(
      '@(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace) | ConvertTo-Json -Compress',
      10000,
    )
    if (!r.ok || !r.stdout.trim()) return []
    const arr = psRecords(JSON.parse(r.stdout.trim()))
    const results: DiskInfo[] = []
    for (const d of arr) {
      const mount = typeof d.DeviceID === 'string' ? d.DeviceID.trim() : ''
      if (!mount) continue
      const total = psNum(d.Size)
      const free = psNum(d.FreeSpace)
      if (total <= 0) continue // bỏ qua ổ Size null/0
      const used = total - free
      results.push({
        mount,
        totalGB: +(total / 1024 ** 3).toFixed(1),
        usedGB: +(used / 1024 ** 3).toFixed(1),
        freeGB: +(free / 1024 ** 3).toFixed(1),
        usagePct: +((used / total) * 100).toFixed(1),
      })
    }
    diskCache = { t: Date.now(), data: results }
    return results
  } catch {
    return []
  }
}

async function disks(): Promise<DiskInfo[]> {
  if (isWin) return disksWin()
  if (diskCache && Date.now() - diskCache.t < 30000) return diskCache.data
  try {
    const mountsRaw = await fs.readFile('/proc/mounts', 'utf8')
    const wanted = new Set(['/', '/home', '/tmp'])
    const mounts: string[] = []
    for (const line of mountsRaw.split('\n')) {
      const parts = line.split(' ')
      if (parts.length < 3) continue
      const mnt = parts[1]
      const fstype = parts[2]
      if (!wanted.has(mnt)) continue
      if (!['ext4', 'ext3', 'xfs', 'btrfs', 'overlay', 'zfs'].includes(fstype)) continue
      if (!mounts.includes(mnt)) mounts.push(mnt)
    }
    const results: DiskInfo[] = []
    for (const mnt of mounts) {
      try {
        const st = await fs.statfs(mnt)
        const total = Number(st.blocks) * Number(st.bsize)
        const free = Number(st.bavail) * Number(st.bsize)
        const used = total - free
        if (total <= 0) continue
        results.push({
          mount: mnt,
          totalGB: +(total / 1024 ** 3).toFixed(1),
          usedGB: +(used / 1024 ** 3).toFixed(1),
          freeGB: +(free / 1024 ** 3).toFixed(1),
          usagePct: +((used / total) * 100).toFixed(1),
        })
      } catch {
        /* bỏ qua mount lỗi */
      }
    }
    diskCache = { t: Date.now(), data: results }
    return results
  } catch {
    return []
  }
}

// Số tiến trình Windows: cache 5s (chỉ cache probe thành công)
let procCountWinCache: { t: number; n: number } | null = null

async function processCountWin(): Promise<number> {
  if (procCountWinCache && Date.now() - procCountWinCache.t < 5000) {
    return procCountWinCache.n
  }
  try {
    const r = await psRun('(Get-Process | Measure-Object).Count', 8000)
    if (!r.ok) return 0
    const n = parseInt(r.stdout.trim(), 10)
    if (!Number.isFinite(n) || n < 0) return 0
    procCountWinCache = { t: Date.now(), n }
    return n
  } catch {
    return 0
  }
}

async function processCount(): Promise<number> {
  if (isWin) return processCountWin()
  try {
    const entries = await fs.readdir('/proc')
    return entries.filter((e) => /^\d+$/.test(e)).length
  } catch {
    return 0
  }
}

export async function getStats(): Promise<StatsSnapshot> {
  const now = Date.now()
  const [
    usage,
    memRaw,
    swapWin,
    net,
    model,
    diskList,
    procCount,
  ] = await Promise.all([
    cpuUsage(),
    readMemRaw(),
    swapUsageWin(),
    netRate(),
    cpuModel(),
    disks(),
    processCount(),
  ])

  const la = os.loadavg()

  let mem: MemInfo
  if (isWin) {
    // Windows: os.totalmem/os.freemem là số liệu thật của Node; "cached" là khái
    // niệm của Linux nên để 0 trung thực. Swap lấy từ probe PowerShell (cache 10s).
    const totalMB = os.totalmem() / 1048576
    const availableMB = os.freemem() / 1048576
    const usedMB = totalMB - availableMB
    mem = {
      totalMB: +totalMB.toFixed(0),
      usedMB: +usedMB.toFixed(0),
      availableMB: +availableMB.toFixed(0),
      cachedMB: 0,
      usagePct: totalMB > 0 ? +((usedMB / totalMB) * 100).toFixed(1) : 0,
      swapTotalMB: swapWin.totalMB,
      swapUsedMB: swapWin.usedMB,
    }
  } else if (memRaw) {
    const usedKB = memRaw.totalKB - memRaw.availableKB
    mem = {
      totalMB: +(memRaw.totalKB / 1024).toFixed(0),
      usedMB: +(usedKB / 1024).toFixed(0),
      availableMB: +(memRaw.availableKB / 1024).toFixed(0),
      cachedMB: +(memRaw.cachedKB / 1024).toFixed(0),
      usagePct: memRaw.totalKB > 0 ? +((usedKB / memRaw.totalKB) * 100).toFixed(1) : 0,
      swapTotalMB: +(memRaw.swapTotalKB / 1024).toFixed(0),
      swapUsedMB: +((memRaw.swapTotalKB - memRaw.swapFreeKB) / 1024).toFixed(0),
    }
  } else {
    // Không đọc được /proc/meminfo — trả 0 trung thực, không bịa dữ liệu
    mem = {
      totalMB: 0,
      usedMB: 0,
      availableMB: 0,
      cachedMB: 0,
      usagePct: 0,
      swapTotalMB: 0,
      swapUsedMB: 0,
    }
  }

  return {
    cpu: {
      usage: +usage.toFixed(1),
      cores: os.cpus().length,
      model,
      loadavg: [+la[0].toFixed(2), +la[1].toFixed(2), +la[2].toFixed(2)],
    },
    mem,
    disks: diskList,
    net: {
      rxKBs: +net.rxKBs.toFixed(1),
      txKBs: +net.txKBs.toFixed(1),
      rxTotalMB: +(net.rx / 1024 ** 2).toFixed(1),
      txTotalMB: +(net.tx / 1024 ** 2).toFixed(1),
    },
    uptimeSec: Math.floor(os.uptime()),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    processCount: procCount,
    timestamp: now,
  }
}

interface ProcRow {
  pid: number
  user: string
  name: string
  cpuPct: number
  memPct: number
  rssMB: number
}

/**
 * Windows: MỘT script PowerShell duy nhất (~10s timeout) đo CPU mỗi tiến trình
 * bằng 2 mẫu Get-Process cách nhau 300ms.
 * LƯU Ý: psRun chạy Windows PowerShell 5.1 — toán tử `??` là lỗi cú pháp trên
 * 5.1 nên dùng form `if ($null -eq ...)` tương đương.
 * Tiến trình không có ở mẫu 1 (mới khởi động giữa 2 mẫu) bị bỏ qua — không có
 * delta hợp lệ, không bịa số.
 */
const LIST_PROCESSES_WIN_SCRIPT = `$t1 = @{}
Get-Process | ForEach-Object {
  try {
    $c = $_.CPU
    if ($null -eq $c) { $c = 0 }
    $t1[$_.Id] = @([double]$c, [double]$_.WorkingSet64)
  } catch { }
}
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Milliseconds 300
$sw.Stop()
# Cửa sổ đo thật = 300ms sleep + thời gian lấy mẫu 1 + query CIM — chia theo số đo thật
# để CPU% không bị thổi phồng (trước đây chia cứng 0.3s → lệch tới ~2x)
$windowSec = [double]$sw.Elapsed.TotalSeconds
if ($windowSec -lt 0.3) { $windowSec = 0.3 }
$cores = [Environment]::ProcessorCount
$totalPhys = (Get-CimInstance Win32_Computersystem).TotalPhysicalMemory
$result = @()
foreach ($p in (Get-Process)) {
  try {
    $prev = $t1[$p.Id]
    if ($null -eq $prev) { continue }
    $c2 = $p.CPU
    if ($null -eq $c2) { $c2 = 0 }
    $delta = [double]$c2 - [double]$prev[0]
    if ($delta -lt 0) { $delta = 0 }
    $cpuPct = $delta / ($windowSec * $cores) * 100
    if ($cpuPct -gt 100) { $cpuPct = 100 }
    if ($cpuPct -lt 0) { $cpuPct = 0 }
    $memPct = 0
    if ($totalPhys -gt 0) { $memPct = $p.WorkingSet64 / $totalPhys * 100 }
    $result += [pscustomobject]@{
      pid = $p.Id
      name = $p.ProcessName
      cpuPct = [math]::Round($cpuPct, 1)
      memPct = [math]::Round($memPct, 1)
      rssMB = [math]::Round($p.WorkingSet64 / 1MB, 1)
    }
  } catch { }
}
$top = @($result | Sort-Object -Property cpuPct -Descending | Select-Object -First 30)
ConvertTo-Json -Compress -Depth 3 -InputObject $top`

async function listProcessesWin(): Promise<ProcRow[]> {
  const r = await psRun(LIST_PROCESSES_WIN_SCRIPT, 10000)
  if (!r.ok || !r.stdout.trim()) return []
  try {
    const arr = psRecords(JSON.parse(r.stdout.trim()))
    const list: ProcRow[] = []
    for (const it of arr) {
      const pid = psNum(it.pid)
      if (pid <= 0) continue
      const name = typeof it.name === 'string' && it.name.trim() ? it.name.trim() : 'unknown'
      list.push({
        pid,
        // Trung thực: để trống user — truy vấn owner trên Windows quá tốn kém cho dashboard
        user: '',
        name,
        cpuPct: psNum(it.cpuPct),
        memPct: psNum(it.memPct),
        rssMB: psNum(it.rssMB),
      })
    }
    return list.sort((a, b) => b.cpuPct - a.cpuPct)
  } catch {
    return []
  }
}

export async function listProcesses(): Promise<
  { pid: number; user: string; name: string; cpuPct: number; memPct: number; rssMB: number }[]
> {
  if (isWin) return listProcessesWin()
  // comm có thể chứa khoảng trắng (vd "next-server (v16.1.3)") — đặt comm làm
  // cột CUỐI cùng và ghép mọi trường còn lại thành tên để không lệch cột số liệu.
  const r = await run(
    'ps -eo pid,user,pcpu,pmem,rss,comm --sort=-pcpu --no-headers 2>/dev/null | head -n 30',
  )
  if (!r.stdout.trim()) return []
  const list: {
    pid: number
    user: string
    name: string
    cpuPct: number
    memPct: number
    rssMB: number
  }[] = []
  for (const line of r.stdout.trim().split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) continue
    const [pid, user, cpu, mem, rss] = parts
    if (!/^\d+$/.test(pid)) continue
    const name = parts.slice(5).join(' ').trim() || 'unknown'
    list.push({
      pid: Number(pid),
      user,
      name,
      cpuPct: parseFloat(cpu) || 0,
      memPct: parseFloat(mem) || 0,
      rssMB: +((parseInt(rss, 10) || 0) / 1024).toFixed(1),
    })
  }
  return list
}
