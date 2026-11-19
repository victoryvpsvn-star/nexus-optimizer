// Self-test NEXUS — tự kiểm tra môi trường + toàn bộ catalog tinh chỉnh,
// gửi báo cáo về Discord webhook (URL cấu hình trong app hoặc env DISCORD_WEBHOOK_URL).
// Trên Windows có 2 chế độ: 'check' (chỉ kiểm tra capability, KHÔNG đổi hệ thống)
// và 'full' (áp dụng rồi hoàn tác từng tinh chỉnh, báo trung thực từng bước).

import os from 'os'
import { db } from '@/lib/db'
import { isWin, getWinStatus, resolvePowerShellExe, findSysExe } from '@/lib/exec'
import { TWEAK_ACTIONS, applyTweakById, revertTweakById } from '@/lib/tweaks'

export const WEBHOOK_SETTING_KEY = 'selftestWebhookUrl'

/** Chỉ chấp nhận URL webhook Discord chính thức — không gửi dữ liệu tới domain lạ */
const DISCORD_WEBHOOK_RE = /^https:\/\/([a-z0-9-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/

export function isValidWebhook(url: string): boolean {
  return DISCORD_WEBHOOK_RE.test(url)
}

/** Đọc webhook ưu tiên từ Setting (do người dùng tự cấu hình trong app), dự phòng env */
export async function getWebhookUrl(): Promise<string> {
  try {
    const row = await db.setting.findUnique({ where: { key: WEBHOOK_SETTING_KEY } })
    if (row?.value && isValidWebhook(row.value)) return row.value
  } catch (e) {
    console.error('[selftest] getWebhookUrl', e)
  }
  const env = process.env.DISCORD_WEBHOOK_URL
  if (env && isValidWebhook(env)) return env
  return ''
}

export async function setWebhookUrl(url: string): Promise<void> {
  await db.setting.upsert({
    where: { key: WEBHOOK_SETTING_KEY },
    update: { value: url },
    create: { key: WEBHOOK_SETTING_KEY, value: url },
  })
}

/** Che URL webhook khi hiển thị trong UI/log — không bao giờ lộ token đầy đủ */
export function maskWebhook(url: string): string {
  if (!url) return ''
  const m = url.match(/^(https:\/\/[^/]+\/api\/webhooks\/)(\d+)\/(.+)$/)
  if (!m) return '***'
  const id = m[2]
  return `${m[1]}${id.slice(0, 4)}…${id.slice(-4)}/***${m[3].slice(-4)}`
}

export interface SelftestItem {
  id: string
  name: string
  group: string
  ok: boolean
  skipped: boolean
  detail: string
}

export interface SelftestFullEntry {
  id: string
  name: string
  applyOk: boolean
  applyMsg: string
  revertOk: boolean
  revertMsg: string
  skipped: boolean
}

export interface SelftestReport {
  mode: 'check' | 'full'
  startedAt: string
  finishedAt: string
  durationMs: number
  hostname: string
  platform: string
  osRelease: string
  arch: string
  runtime: {
    powershellFound: boolean
    powershellPath?: string
    powershellDetail: string
    admin: boolean
    adminMethod: string
    regOk: boolean
  }
  catalog: { total: number; recommended: number; uniqueIds: boolean; uniqueOrders: boolean }
  items: SelftestItem[]
  full?: SelftestFullEntry[]
  counts: { pass: number; fail: number; skipped: number }
  webhook: { requested: boolean; ok: boolean; detail: string }
  ok: boolean
}

/** Công cụ/thuộc tính mà từng tweak cần để chạy được trên Windows (dùng ở chế độ check) */
function tweakDeps(id: string): { tools: string[]; needsPs: boolean } {
  switch (id) {
    case 'win-power-high':
    case 'win-cpu-core-parking-off':
    case 'win-hibernation-off':
      return { tools: ['powercfg.exe'], needsPs: false }
    case 'win-sysmain-off':
    case 'win-diagtrack-off':
    case 'win-xbox-services-off':
      return { tools: ['sc.exe'], needsPs: false }
    case 'win-flush-dns':
      return { tools: ['ipconfig.exe'], needsPs: false }
    case 'win-cpu-dynamic-tick-off':
      return { tools: ['bcdedit.exe'], needsPs: false }
    case 'win-ram-clean':
    case 'win-ram-standby-clear':
    case 'win-ram-compression-off':
      return { tools: [], needsPs: true }
    default:
      return { tools: ['reg.exe'], needsPs: false }
  }
}

const TOOL_LABEL: Record<string, string> = {
  'reg.exe': 'reg.exe (registry)',
  'powercfg.exe': 'powercfg.exe (nguồn/điện)',
  'sc.exe': 'sc.exe (dịch vụ)',
  'ipconfig.exe': 'ipconfig.exe (mạng)',
  'bcdedit.exe': 'bcdedit.exe (boot config)',
}

function shortDetail(msg: string, max = 160): string {
  const clean = msg.replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}

async function runCheck(): Promise<SelftestItem[]> {
  const items: SelftestItem[] = []
  const add = (id: string, name: string, group: string, ok: boolean, detail: string, skipped = false) =>
    items.push({ id, name, group, ok, skipped, detail: shortDetail(detail) })

  // 1) Database
  try {
    await db.setting.count()
    add('db', 'Database (Prisma + SQLite)', 'Hạ tầng', true, 'Đọc được bảng Setting — DB hoạt động')
  } catch (e) {
    add('db', 'Database (Prisma + SQLite)', 'Hạ tầng', false, `DB lỗi: ${(e as Error).message}`)
  }

  // 2) Catalog
  const ids = TWEAK_ACTIONS.map((a) => a.def.id)
  const orders = TWEAK_ACTIONS.map((a) => a.def.order)
  const uniqueIds = new Set(ids).size === ids.length
  const uniqueOrders = new Set(orders).size === orders.length
  add(
    'catalog',
    'Catalog tinh chỉnh',
    'Hạ tầng',
    uniqueIds && uniqueOrders && ids.length > 0,
    `${ids.length} tinh chỉnh (unique id: ${uniqueIds ? 'OK' : 'TRÙNG'}, unique order: ${uniqueOrders ? 'OK' : 'TRÙNG'})`,
  )

  // 3) Runtime Windows
  if (!isWin) {
    add(
      'runtime',
      'Môi trường Windows',
      'Runtime',
      false,
      `Đang chạy trên ${os.platform()} — các tinh chỉnh Windows cần chạy trong app .exe trên Windows`,
      true,
    )
  } else {
    const st = await getWinStatus()
    add(
      'runtime-powershell',
      'PowerShell',
      'Runtime',
      st.psFound,
      st.psFound ? `${st.psPath} (${st.psDetail})` : `Không tìm thấy PowerShell — ${st.psDetail}`,
    )
    add(
      'runtime-admin',
      'Quyền Administrator',
      'Runtime',
      st.admin,
      st.admin
        ? `Có quyền Admin (kiểm tra qua ${st.adminMethod === 'hklm-write' ? 'ghi thử HKLM bằng reg.exe' : 'PowerShell IsInRole'})`
        : 'Không có quyền Admin — các mục HKLM/dịch vụ/powercfg sẽ báo cần Admin (trung thực)',
    )
    add(
      'runtime-reg',
      'reg.exe (registry)',
      'Runtime',
      st.regOk,
      st.regOk ? 'reg.exe sẵn sàng trong System32 — registry tweaks chạy không cần PowerShell' : 'Thiếu reg.exe — registry không thao tác được',
    )
  }

  // 4) Capability từng tinh chỉnh
  for (const a of TWEAK_ACTIONS) {
    if (!isWin) {
      add(a.def.id, a.def.name, a.def.category, false, 'Chỉ kiểm tra được trên Windows (bỏ qua)', true)
      continue
    }
    const deps = tweakDeps(a.def.id)
    const missing = deps.tools.filter((t) => findSysExe(t) === null)
    if (missing.length > 0) {
      add(a.def.id, a.def.name, a.def.category, false, `Thiếu công cụ: ${missing.map((t) => TOOL_LABEL[t] ?? t).join(', ')}`)
      continue
    }
    if (deps.needsPs) {
      const ps = await resolvePowerShellExe()
      add(
        a.def.id,
        a.def.name,
        a.def.category,
        ps.exe !== null,
        ps.exe ? `Cần PowerShell — OK (${ps.exe})` : `Cần PowerShell nhưng máy không có — ${ps.detail}`,
      )
      continue
    }
    add(
      a.def.id,
      a.def.name,
      a.def.category,
      true,
      `Sẵn sàng: ${deps.tools.map((t) => TOOL_LABEL[t] ?? t).join(' + ')}${a.def.requiresRoot ? ' + cần Administrator' : ''}`,
    )
  }
  return items
}

async function runFull(deadlineMs = 120_000): Promise<SelftestFullEntry[]> {
  const entries: SelftestFullEntry[] = []
  const t0 = Date.now()
  for (const a of TWEAK_ACTIONS) {
    if (Date.now() - t0 > deadlineMs) {
      entries.push({
        id: a.def.id,
        name: a.def.name,
        applyOk: false,
        applyMsg: 'Bỏ qua do vượt thời gian kiểm tra',
        revertOk: false,
        revertMsg: 'Bỏ qua do vượt thời gian kiểm tra',
        skipped: true,
      })
      continue
    }
    try {
      const ap = await applyTweakById(a.def.id)
      // v4.4.0 (B-08, port từ Go shouldRevertAfterApply): apply thất bại KHÔNG revert —
      // tránh ghi giá trị mặc định đoán lên cấu hình thật; apply OK mới revert
      let rv: Awaited<ReturnType<typeof revertTweakById>> | null = null
      if (ap.success) {
        rv = await revertTweakById(a.def.id)
      }
      entries.push({
        id: a.def.id,
        name: a.def.name,
        applyOk: ap.success,
        applyMsg: shortDetail(ap.message),
        revertOk: rv ? rv.success : false,
        revertMsg: rv ? shortDetail(rv.message) : 'Apply thất bại — KHÔNG revert (tránh ghi giá trị đoán lên cấu hình thật)',
        skipped: false,
      })
    } catch (e) {
      entries.push({
        id: a.def.id,
        name: a.def.name,
        applyOk: false,
        applyMsg: `Lỗi khi chạy: ${(e as Error).message}`,
        revertOk: false,
        revertMsg: 'Chưa chạy (lỗi ở bước áp dụng)',
        skipped: false,
      })
    }
  }
  return entries
}

/** Gửi báo cáo lên Discord webhook — trả về {ok, detail} KHÔNG chứa URL webhook */
export async function sendWebhookReport(report: SelftestReport): Promise<{ ok: boolean; detail: string }> {
  const url = await getWebhookUrl()
  if (!url) {
    return { ok: false, detail: 'Chưa cấu hình webhook Discord (dán URL webhook trong tab Tự kiểm tra)' }
  }
  const fails = report.items.filter((i) => !i.ok && !i.skipped)
  const skipped = report.items.filter((i) => i.skipped)
  const lines: string[] = []
  if (fails.length > 0) {
    lines.push(
      '**Lỗi:**',
      ...fails.slice(0, 12).map((f) => `• ${f.name}: ${f.detail}`),
      fails.length > 12 ? `• …và ${fails.length - 12} mục lỗi khác` : '',
    )
  }
  if (skipped.length > 0) {
    lines.push(`*Bỏ qua (không áp dụng được trên môi trường này): ${skipped.length} mục*`)
  }
  if (report.full) {
    const fullFails = report.full.filter((f) => !f.skipped && (!f.applyOk || !f.revertOk))
    lines.push(
      '**Chế độ full (áp dụng → hoàn tác):**',
      ...fullFails.slice(0, 12).map(
        (f) =>
          `• ${f.name}: ${f.applyOk ? 'apply ✅' : 'apply ❌'} / ${f.revertOk ? 'revert ✅' : 'revert ❌'} — ${shortDetail(f.applyMsg || f.revertMsg, 80)}`,
      ),
      fullFails.length > 12 ? `• …và ${fullFails.length - 12} mục khác` : '',
    )
  }
  const description = lines.filter(Boolean).join('\n').slice(0, 1800) || 'Tất cả mục đã kiểm tra đều đạt ✅'

  const payload = {
    username: 'NEXUS Optimizer',
    embeds: [
      {
        title: `🧪 NEXUS Self-test — chế độ ${report.mode === 'full' ? 'FULL' : 'CHECK'} — ${report.ok ? 'ĐẠT' : 'CÓ LỖI'}`,
        color: report.ok ? 3066993 : 15158332,
        description,
        fields: [
          {
            name: 'Máy',
            value: `${report.hostname} — ${report.platform} ${report.osRelease} (${report.arch})`,
            inline: false,
          },
          {
            name: 'Runtime',
            value: [
              `PowerShell: ${report.runtime.powershellFound ? '✅' : '❌'}`,
              `Admin: ${report.runtime.admin ? '✅' : '❌'}`,
              `reg.exe: ${report.runtime.regOk ? '✅' : '❌'}`,
            ].join(' | '),
            inline: false,
          },
          {
            name: 'Kết quả',
            value: `✅ ${report.counts.pass} | ❌ ${report.counts.fail} | ⏭ ${report.counts.skipped} (trên ${report.catalog.total} tweak)`,
            inline: true,
          },
          { name: 'Thời lượng', value: `${report.durationMs}ms`, inline: true },
          {
            name: 'Webhook',
            value: report.webhook.ok ? '✅ đã gửi báo cáo này' : `❌ ${report.webhook.detail}`,
            inline: false,
          },
        ],
        timestamp: report.finishedAt,
        footer: { text: 'NEXUS Optimizer — tự kiểm tra tự động' },
      },
    ],
  }

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (r.status === 204 || r.ok) {
      return { ok: true, detail: `Đã gửi báo cáo lên Discord (HTTP ${r.status})` }
    }
    const body = (await r.text().catch(() => '')).slice(0, 120)
    return { ok: false, detail: `Discord trả về HTTP ${r.status}: ${body || 'không có nội dung'}` }
  } catch (e) {
    return { ok: false, detail: `Không gửi được webhook: ${(e as Error).message}` }
  }
}

export async function runSelftest(mode: 'check' | 'full', useWebhook: boolean): Promise<SelftestReport> {
  const startedAt = new Date()
  const items = await runCheck()
  let full: SelftestFullEntry[] | undefined
  if (mode === 'full') {
    if (!isWin) {
      // Trung thực: trên Linux/VPS không áp dụng được tinh chỉnh Windows — đánh dấu bỏ qua
      full = TWEAK_ACTIONS.map((a) => ({
        id: a.def.id,
        name: a.def.name,
        applyOk: false,
        applyMsg: 'Chỉ chạy được trên Windows (app .exe)',
        revertOk: false,
        revertMsg: 'Chỉ chạy được trên Windows (app .exe)',
        skipped: true,
      }))
    } else {
      full = await runFull()
    }
  }
  const finishedAt = new Date()
  const st = isWin ? await getWinStatus() : null
  const runtime = {
    powershellFound: st?.psFound ?? false,
    powershellPath: st?.psPath,
    powershellDetail: st?.psDetail ?? 'Không phải Windows',
    admin: st?.admin ?? false,
    adminMethod: st?.adminMethod ?? 'not-windows',
    regOk: st?.regOk ?? false,
  }
  const counts = {
    pass: items.filter((i) => i.ok).length,
    fail: items.filter((i) => !i.ok && !i.skipped).length,
    skipped: items.filter((i) => i.skipped).length + (full ? full.filter((f) => f.skipped).length : 0),
  }
  const report: SelftestReport = {
    mode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    hostname: os.hostname(),
    platform: os.platform(),
    osRelease: os.release(),
    arch: os.arch(),
    runtime,
    catalog: {
      total: TWEAK_ACTIONS.length,
      recommended: TWEAK_ACTIONS.filter((a) => a.def.recommended).length,
      uniqueIds: new Set(TWEAK_ACTIONS.map((a) => a.def.id)).size === TWEAK_ACTIONS.length,
      uniqueOrders: new Set(TWEAK_ACTIONS.map((a) => a.def.order)).size === TWEAK_ACTIONS.length,
    },
    items,
    full,
    counts,
    webhook: { requested: useWebhook, ok: false, detail: useWebhook ? '' : 'Không yêu cầu gửi' },
    ok: false,
  }
  // v4.4.0 (B-16, đối xứng Go B-09): FULL failures + FULL skipped phải ảnh hưởng tổng —
  // không còn "ĐẠT" giả khi FULL có mục lỗi
  const fullFailsAll = report.full.filter((f) => !f.skipped && (!f.applyOk || !f.revertOk))
  const fullSkippedAll = report.full.filter((f) => f.skipped)
  counts.fail += fullFailsAll.length
  counts.skipped += fullSkippedAll.length
  report.ok = counts.fail === 0 && report.catalog.uniqueIds && report.catalog.uniqueOrders

  if (useWebhook) {
    const wh = await sendWebhookReport(report)
    report.webhook = { requested: true, ok: wh.ok, detail: wh.detail }
  }
  return report
}
