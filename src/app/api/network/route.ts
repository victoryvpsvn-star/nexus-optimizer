import { NextResponse } from 'next/server'
import os from 'os'
import fs from 'fs/promises'
import { run } from '@/lib/exec'

export const dynamic = 'force-dynamic'

interface IfaceInfo {
  name: string
  ipv4: string[]
  mac?: string
}

interface PortInfo {
  port: number
  proto: string
}

/** Đọc cổng LISTEN từ /proc/net/tcp + tcp6 (state 0A), không cần quyền đặc biệt. */
async function listeningPorts(): Promise<PortInfo[]> {
  const ports: PortInfo[] = []
  const seen = new Set<string>()
  for (const [file, proto] of [
    ['/proc/net/tcp', 'tcp'],
    ['/proc/net/tcp6', 'tcp6'],
  ] as const) {
    try {
      const raw = await fs.readFile(file, 'utf8')
      for (const line of raw.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 10) continue
        const state = cols[3]
        const local = cols[1]
        if (state !== '0A' || !local.includes(':')) continue
        const portHex = local.split(':').pop() ?? ''
        const port = parseInt(portHex, 16)
        if (!Number.isFinite(port) || port <= 0) continue
        const key = `${proto}:${port}`
        if (seen.has(key)) continue
        seen.add(key)
        ports.push({ port, proto })
      }
    } catch {
      /* tcp6 có thể không tồn tại */
    }
  }
  return ports.sort((a, b) => a.port - b.port).slice(0, 40)
}

export async function GET() {
  try {
    const raw = os.networkInterfaces()
    const ifaces: IfaceInfo[] = []
    for (const [name, addrs] of Object.entries(raw)) {
      if (!addrs) continue
      const ipv4 = addrs
        .filter((a) => a.family === 'IPv4' && !a.internal)
        .map((a) => a.address)
      const mac = addrs.find((a) => a.mac && a.mac !== '00:00:00:00:00:00')?.mac
      if (ipv4.length > 0 || mac) {
        ifaces.push({ name, ipv4, mac })
      }
    }
    const [ports, hostnameRes] = await Promise.all([
      listeningPorts(),
      run('hostname -f 2>/dev/null', 3000),
    ])
    return NextResponse.json({
      ifaces,
      ports,
      fqdn: hostnameRes.ok ? hostnameRes.stdout.trim() : os.hostname(),
      timestamp: Date.now(),
    })
  } catch (e) {
    console.error('[api/network]', e)
    return NextResponse.json({ error: 'Không đọc được thông tin mạng' }, { status: 500 })
  }
}
