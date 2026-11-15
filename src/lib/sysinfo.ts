import fs from 'fs/promises'
import os from 'os'
import { run } from './exec'
import type { StatsSnapshot, DiskInfo } from './types'

async function cpuUsage(): Promise<number> {
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

async function netSample(): Promise<{ rx: number; tx: number }> {
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

async function cpuModel(): Promise<string> {
  try {
    const s = await fs.readFile('/proc/cpuinfo', 'utf8')
    const m = s.match(/^model name\s*:\s*(.+)$/m)
    return m ? m[1].trim() : 'CPU ảo (container)'
  } catch {
    return 'Không xác định'
  }
}

let diskCache: { t: number; data: DiskInfo[] } | null = null

async function disks(): Promise<DiskInfo[]> {
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

async function processCount(): Promise<number> {
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
    net,
    model,
    diskList,
    procCount,
  ] = await Promise.all([
    cpuUsage(),
    fs.readFile('/proc/meminfo', 'utf8').then(parseMeminfo),
    netRate(),
    cpuModel(),
    disks(),
    processCount(),
  ])

  const usedKB = memRaw.totalKB - memRaw.availableKB
  const la = os.loadavg()

  return {
    cpu: {
      usage: +usage.toFixed(1),
      cores: os.cpus().length,
      model,
      loadavg: [+la[0].toFixed(2), +la[1].toFixed(2), +la[2].toFixed(2)],
    },
    mem: {
      totalMB: +(memRaw.totalKB / 1024).toFixed(0),
      usedMB: +(usedKB / 1024).toFixed(0),
      availableMB: +(memRaw.availableKB / 1024).toFixed(0),
      cachedMB: +(memRaw.cachedKB / 1024).toFixed(0),
      usagePct: memRaw.totalKB > 0 ? +((usedKB / memRaw.totalKB) * 100).toFixed(1) : 0,
      swapTotalMB: +(memRaw.swapTotalKB / 1024).toFixed(0),
      swapUsedMB: +((memRaw.swapTotalKB - memRaw.swapFreeKB) / 1024).toFixed(0),
    },
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

export async function listProcesses(): Promise<
  { pid: number; user: string; name: string; cpuPct: number; memPct: number; rssMB: number }[]
> {
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
