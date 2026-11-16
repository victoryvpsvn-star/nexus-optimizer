// Catalog tinh chỉnh (Tweaks) — xếp hạng theo độ tác động, chuẩn Chris Titus WinUtil style
// Linux: mọi tinh chỉnh root đều dùng tryRoot() — KHÔNG giả lập thành công khi thiếu sudo.
// Windows: TWEAK_ACTIONS_WIN chạy qua PowerShell (psRun) với reg.exe/sc.exe/powercfg/ipconfig;
// các mục requiresRoot bị chặn TRƯỚC khi chạy nếu thiếu quyền Administrator (adminGate).

import fs from 'fs/promises'
import { db } from '@/lib/db'
import {
  run,
  tryRoot,
  psRun,
  isWin,
  getWinStatus,
  runExe,
  runSysExe,
  findSysExe,
} from '@/lib/exec'
import type { RiskLevel, Tweak, TweakRunResult } from '@/lib/types'

const GOV_ORIG_FILE = '/tmp/nexus-gov-orig'
/** Chỉ chấp nhận governor là token an toàn (a-z, 0-9, _, -) — không bao giờ nội suy chuỗi lạ vào shell */
const SAFE_TOKEN = /^[a-z0-9_-]+$/

export interface TweakActionResult {
  success: boolean
  message: string
}

export interface TweakAction {
  def: {
    id: string
    name: string
    description: string
    category: 'Hiệu năng' | 'Mạng' | 'Bộ nhớ' | 'Bảo mật & riêng tư' | 'Gaming'
    risk: RiskLevel
    requiresRoot: boolean
    recommended: boolean
    order: number
  }
  apply: () => Promise<TweakActionResult>
  revert: () => Promise<TweakActionResult>
}

const ROOT_FAIL = 'Cần quyền root (sudo) — máy chủ hiện không cho phép'

/** Cắt ngắn thông báo để lưu DB an toàn */
function short(msg: string, max = 220): string {
  const clean = msg.replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}

async function saveState(id: string, applied: boolean, message: string): Promise<void> {
  try {
    const now = new Date()
    await db.tweakState.upsert({
      where: { id },
      update: { applied, appliedAt: applied ? now : null, lastResult: short(message) },
      create: { id, applied, appliedAt: applied ? now : null, lastResult: short(message) },
    })
  } catch (e) {
    console.error('[tweaks] saveState', id, e)
  }
}

/** sysctl qua root, trả về thông báo trung thực (kèm stderr của kernel nếu có) */
async function sysctlRoot(key: string, value: string): Promise<TweakActionResult> {
  const r = await tryRoot(`sysctl -w ${key}=${value}`)
  if (!r.ok) {
    return { success: false, message: r.stderr || ROOT_FAIL }
  }
  return { success: true, message: short(r.stdout || r.stderr || `${key}=${value} OK`) }
}

// ---------- Helpers nhánh Windows (registry / dịch vụ / powercfg qua PowerShell) ----------

const ADMIN_FAIL =
  'Cần quyền Administrator — hãy chạy NEXUS Optimizer với quyền Admin (hoặc bấm nút "Chạy lại với quyền Admin" trong tab Tự kiểm tra)'

/**
 * Cổng quyền Administrator cho các mục requiresRoot trên Windows: chặn TRƯỚC khi chạy
 * bất kỳ lệnh nào nếu thiếu quyền — không bao giờ chạy nửa vời hay giả lập thành công.
 * Quyền được kiểm tra bằng getWinStatus() (ghi thử HKLM qua reg.exe, không phụ thuộc
 * PowerShell) — hết cảnh báo nhầm "Cần quyền Admin" khi thực ra là lỗi spawn PowerShell.
 */
async function adminGate(): Promise<TweakActionResult | null> {
  if (!isWin) return null
  const st = await getWinStatus()
  if (st.admin) return null
  if (!st.regOk && !st.psFound) {
    return {
      success: false,
      message: short(
        `Không kiểm tra được quyền Administrator (thiếu cả reg.exe và PowerShell: ${st.psDetail}) — ${ADMIN_FAIL}`,
      ),
    }
  }
  return { success: false, message: ADMIN_FAIL }
}

interface RegValue {
  name: string
  type: 'REG_DWORD' | 'REG_SZ'
  data: string
}

const NO_REG_EXE = 'Không tìm thấy reg.exe trong System32 — không thao tác được registry'

/**
 * reg.exe add lần lượt từng giá trị — spawn TRỰC TIẾP theo đường dẫn tuyệt đối
 * (không cần PowerShell, không phụ thuộc PATH — sửa gốc lỗi "spawn powershell.exe
 * ENOENT" trên máy đã tinh chỉnh). Thoát với exit code thật ngay khi một lệnh lỗi.
 */
async function regAddValues(key: string, values: RegValue[], okMsg: string): Promise<TweakActionResult> {
  const reg = findSysExe('reg.exe')
  if (!reg) return { success: false, message: NO_REG_EXE }
  for (const v of values) {
    const r = await runExe(reg, ['add', key, '/v', v.name, '/t', v.type, '/d', v.data, '/f'], 15000)
    if (!r.ok) {
      return {
        success: false,
        message: short(
          `reg.exe add ${key}\\${v.name} thất bại (exit ${r.code}): ${r.stderr || r.stdout || 'không rõ lý do'}`,
        ),
      }
    }
  }
  return { success: true, message: okMsg }
}

/**
 * Xóa nhiều giá trị registry trong cùng key — dùng reg.exe trực tiếp với EXIT CODE
 * thay vì parse thông báo (reg.exe bị LOCALIZED trên Windows vi-VN):
 * - `reg query <key> /v <name>` exit != 0 → giá trị chưa từng set (missing, không phải lỗi).
 * - `reg delete ... /f` exit != 0 → lỗi thật (Access denied...) → thất bại trung thực.
 * Không cần PowerShell nên hoạt động cả trên Windows bị rút gọn PowerShell.
 */
async function regDeleteValues(key: string, names: string[], okMsg: string): Promise<TweakActionResult> {
  const reg = findSysExe('reg.exe')
  if (!reg) return { success: false, message: NO_REG_EXE }
  let missing = 0
  const failed: string[] = []
  for (const n of names) {
    const q = await runExe(reg, ['query', key, '/v', n], 15000)
    if (!q.ok) {
      // Giá trị không tồn tại cũng là kết quả hợp lệ của revert (đã ở trạng thái mặc định)
      missing++
      continue
    }
    const d = await runExe(reg, ['delete', key, '/v', n, '/f'], 15000)
    if (!d.ok) {
      failed.push(`${n} (exit ${d.code}: ${d.stderr || d.stdout || 'không rõ lý do'})`)
    }
  }
  if (failed.length > 0) {
    return { success: false, message: short(`reg.exe delete thất bại tại: ${failed.join('; ')}`) }
  }
  return { success: true, message: okMsg }
}

export const TWEAK_ACTIONS_LINUX: TweakAction[] = [  {
    def: {
      id: 'drop-caches',
      name: 'Xả bộ nhớ đệm nhân (drop caches)',
      description: 'Đồng bộ hệ thống và giải phóng RAM đệm của nhân Linux để lấy lại bộ nhớ trống ngay lập tức.',
      category: 'Hiệu năng',
      risk: 'low',
      requiresRoot: true,
      recommended: true,
      order: 1,
    },
    apply: async () => {
      const r = await tryRoot('sh -c "sync && echo 3 > /proc/sys/vm/drop_caches"')
      if (!r.ok) return { success: false, message: r.stderr || ROOT_FAIL }
      return { success: true, message: 'Đã đồng bộ và xả pagecache/dentries/inodes của nhân' }
    },
    revert: async () => ({
      success: true,
      message: 'Tinh chỉnh xả cache là hành động tức thời — không cần hoàn tác',
    }),
  },
  {
    def: {
      id: 'governor-performance',
      name: 'CPU governor: hiệu năng tối đa',
      description: 'Chuyển CPU scaling governor sang "performance" để tắt hạ xung động, giữ xung cao nhất khi cần.',
      category: 'Gaming',
      risk: 'medium',
      requiresRoot: true,
      recommended: true,
      order: 2,
    },
    apply: async () => {
      const cur = await run('cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null')
      const orig = cur.stdout.trim()
      // Chỉ lưu governor gốc nếu là token hợp lệ; file ghi với quyền 0600 (fs, không qua shell)
      if (orig && SAFE_TOKEN.test(orig)) {
        try {
          await fs.rm(GOV_ORIG_FILE, { force: true })
          const fh = await fs.open(GOV_ORIG_FILE, 'w', 0o600)
          try {
            await fh.writeFile(orig, 'utf8')
          } finally {
            await fh.close()
          }
        } catch {
          // không lưu được state hoàn tác — vẫn tiếp tục áp dụng
        }
      } else {
        await run(`rm -f ${GOV_ORIG_FILE}`)
      }
      const r = await tryRoot(
        `sh -c 'for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo performance > "$f" 2>/dev/null; done'`,
      )
      if (!r.ok) return { success: false, message: r.stderr || ROOT_FAIL }
      return {
        success: true,
        message: orig
          ? `Đã đặt governor=performance (gốc "${orig}" đã lưu để hoàn tác)`
          : 'Đã đặt governor=performance (không đọc được governor gốc — hoàn tác sẽ dùng schedutil)',
      }
    },
    revert: async () => {
      const saved = await run(`cat ${GOV_ORIG_FILE} 2>/dev/null`)
      const stored = saved.stdout.trim()
      // CHỈ dùng giá trị đã lưu nếu khớp whitelist token — không bao giờ nội suy nội dung chưa kiểm chứng
      let target = stored && SAFE_TOKEN.test(stored) ? stored : ''
      if (!target) {
        const avail = await run(
          'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors 2>/dev/null',
        )
        const list = avail.stdout.split(/\s+/).filter((g) => SAFE_TOKEN.test(g))
        target = list.includes('schedutil')
          ? 'schedutil'
          : list.includes('powersave')
            ? 'powersave'
            : 'schedutil'
      }
      const r = await tryRoot(
        `sh -c 'for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo ${target} > "$f" 2>/dev/null; done'`,
      )
      if (!r.ok) return { success: false, message: r.stderr || ROOT_FAIL }
      return { success: true, message: `Đã hoàn tác governor về "${target}"` }
    },
  },
  {
    def: {
      id: 'swappiness-10',
      name: 'Giảm swappiness xuống 10',
      description: 'Hạn chế hệ thống đẩy RAM ra swap trừ khi thực sự cần, giảm độ trễ ứng dụng.',
      category: 'Hiệu năng',
      risk: 'medium',
      requiresRoot: true,
      recommended: true,
      order: 3,
    },
    apply: () => sysctlRoot('vm.swappiness', '10'),
    revert: () => sysctlRoot('vm.swappiness', '60'),
  },
  {
    def: {
      id: 'tmp-clean',
      name: 'Dọn file cũ trong /tmp',
      description: 'Xóa các file/thư mục trong /tmp cũ hơn 24 giờ, luôn bỏ qua an toàn các mục next*/render*.',
      category: 'Bộ nhớ',
      risk: 'low',
      requiresRoot: false,
      recommended: true,
      order: 4,
    },
    apply: async () => {
      const cmd =
        `n=$(find /tmp -mindepth 1 -maxdepth 1 ! -name 'next*' ! -name 'render*' -mtime +0 2>/dev/null | wc -l); ` +
        `find /tmp -mindepth 1 -maxdepth 1 ! -name 'next*' ! -name 'render*' -mtime +0 -exec rm -rf -- {} + 2>/dev/null; ` +
        `echo cleaned=$n`
      const r = await run(cmd)
      if (!r.ok) return { success: false, message: r.stderr || 'Không dọn được /tmp' }
      const n = r.stdout.match(/cleaned=(\d+)/)?.[1] ?? '0'
      return {
        success: true,
        message: `Đã dọn ${n} mục cũ trong /tmp (bỏ qua an toàn next*/render*)`,
      }
    },
    revert: async () => ({
      success: true,
      message: 'Dọn /tmp không thể hoàn tác — file đã xóa không thể lấy lại',
    }),
  },
  {
    def: {
      id: 'npm-cache-clean',
      name: 'Dọn cache npm',
      description: 'Xóa toàn bộ cache của npm để giải phóng dung lượng ổ đĩa.',
      category: 'Bộ nhớ',
      risk: 'low',
      requiresRoot: false,
      recommended: true,
      order: 5,
    },
    apply: async () => {
      const r = await run('npm cache clean --force 2>&1')
      if (!r.ok) return { success: false, message: r.stderr || 'npm cache clean thất bại' }
      return { success: true, message: 'Đã dọn sạch cache npm (~/.npm/_cacache)' }
    },
    revert: async () => ({
      success: true,
      message: 'Dọn cache không cần hoàn tác — cache sẽ tự hồi phục khi cài package',
    }),
  },
  {
    def: {
      id: 'fstrim',
      name: 'TRIM toàn bộ ổ SSD',
      description: 'Chạy fstrim trên mọi mount điểm để SSD giữ hiệu suất ghi ổn định.',
      category: 'Bộ nhớ',
      risk: 'low',
      requiresRoot: true,
      recommended: true,
      order: 6,
    },
    apply: async () => {
      const r = await tryRoot('fstrim -a')
      if (!r.ok) return { success: false, message: r.stderr || ROOT_FAIL }
      return { success: true, message: short(r.stdout) || 'Đã TRIM toàn bộ filesystem hỗ trợ discard' }
    },
    revert: async () => ({
      success: true,
      message: 'TRIM là hành động tức thời — không cần hoàn tác',
    }),
  },
  {
    def: {
      id: 'inotify-watches',
      name: 'Tăng giới hạn inotify watches',
      description: 'Nâng fs.inotify.max_user_watches lên 524288 để dev server/IDE theo dõi file không báo lỗi.',
      category: 'Hiệu năng',
      risk: 'low',
      requiresRoot: true,
      recommended: true,
      order: 7,
    },
    apply: () => sysctlRoot('fs.inotify.max_user_watches', '524288'),
    revert: () => sysctlRoot('fs.inotify.max_user_watches', '8192'),
  },
  {
    def: {
      id: 'flush-dns',
      name: 'Xả cache DNS',
      description: 'Xóa cache DNS của systemd-resolved giúp phân giải tên miền cập nhật mới nhất.',
      category: 'Mạng',
      risk: 'low',
      requiresRoot: false,
      recommended: true,
      order: 8,
    },
    apply: async () => {
      const r = await run(
        'resolvectl flush-caches 2>/dev/null || systemd-resolve --flush-caches 2>/dev/null || echo flush-skip',
      )
      if (!r.ok || r.stdout.includes('flush-skip')) {
        return {
          success: false,
          message:
            'Không tìm thấy resolvectl/systemd-resolve — máy chủ này không dùng systemd-resolved nên không có cache DNS để xả',
        }
      }
      return { success: true, message: 'Đã xả cache DNS của systemd-resolved' }
    },
    revert: async () => ({
      success: true,
      message: 'Xả cache DNS là hành động tức thời — không cần hoàn tác',
    }),
  },
  {
    def: {
      id: 'bun-cache-clean',
      name: 'Dọn cache bun',
      description: 'Xóa thư mục cache cài đặt package của bun để giải phóng dung lượng.',
      category: 'Bộ nhớ',
      risk: 'low',
      requiresRoot: false,
      recommended: true,
      order: 9,
    },
    apply: async () => {
      const chk = await run('test -d ~/.bun/install/cache && echo yes || echo no')
      const existed = chk.stdout.trim() === 'yes'
      const r = await run('rm -rf ~/.bun/install/cache')
      if (!r.ok) return { success: false, message: r.stderr || 'Không xóa được cache bun' }
      return {
        success: true,
        message: existed ? 'Đã xóa ~/.bun/install/cache' : 'Không có cache bun nào để dọn',
      }
    },
    revert: async () => ({
      success: true,
      message: 'Dọn cache không cần hoàn tác — cache sẽ tự tạo lại khi cài package',
    }),
  },
  {
    def: {
      id: 'dirty-writeback',
      name: 'Giãn chu kỳ ghi dữ liệu bẩn',
      description: 'Tăng vm.dirty_writeback_centisecs lên 1500 để nhân ghi đĩa thưa hơn, tiết kiệm IO.',
      category: 'Hiệu năng',
      risk: 'medium',
      requiresRoot: true,
      recommended: false,
      order: 10,
    },
    apply: () => sysctlRoot('vm.dirty_writeback_centisecs', '1500'),
    revert: () => sysctlRoot('vm.dirty_writeback_centisecs', '500'),
  },
  {
    def: {
      id: 'tcp-fastopen',
      name: 'Bật TCP Fast Open',
      description: 'Cho phép mở kết nối TCP kèm dữ liệu đầu tiên, giảm 1 RTT cho kết nối mới.',
      category: 'Mạng',
      risk: 'medium',
      requiresRoot: true,
      recommended: false,
      order: 11,
    },
    apply: () => sysctlRoot('net.ipv4.tcp_fastopen', '3'),
    revert: () => sysctlRoot('net.ipv4.tcp_fastopen', '1'),
  },
  {
    def: {
      id: 'bbr-fq',
      name: 'TCP BBR + qdisc fq',
      description: 'Đổi thuật toán tắc nghẽn TCP sang BBR và qdisc sang fq để băng thông và độ trễ tốt hơn.',
      category: 'Mạng',
      risk: 'high',
      requiresRoot: true,
      recommended: false,
      order: 12,
    },
    apply: async () => {
      const c1 = await sysctlRoot('net.ipv4.tcp_congestion_control', 'bbr')
      if (!c1.success) {
        return {
          success: false,
          message: `Không bật được BBR — ${c1.message}`,
        }
      }
      const c2 = await sysctlRoot('net.core.default_qdisc', 'fq')
      if (!c2.success) {
        return { success: false, message: `BBR OK nhưng qdisc fq thất bại — ${c2.message}` }
      }
      return { success: true, message: 'Đã bật tcp_congestion_control=bbr + default_qdisc=fq' }
    },
    revert: async () => {
      const c = await sysctlRoot('net.ipv4.tcp_congestion_control', 'cubic')
      return c.success
        ? { success: true, message: 'Đã hoàn tác congestion control về cubic' }
        : { success: false, message: c.message }
    },
  },
  {
    def: {
      id: 'font-cache-rebuild',
      name: 'Dựng lại cache font',
      description: 'Chạy fc-cache -f để quét và dựng lại toàn bộ cache font hệ thống.',
      category: 'Hiệu năng',
      risk: 'low',
      requiresRoot: false,
      recommended: false,
      order: 13,
    },
    apply: async () => {
      const r = await run('fc-cache -f 2>&1 | tail -1', 60000)
      if (!r.ok) return { success: false, message: r.stderr || 'fc-cache thất bại' }
      return { success: true, message: 'Đã dựng lại cache font hệ thống (fc-cache -f)' }
    },
    revert: async () => ({
      success: true,
      message: 'Cache font tự quản lý — không cần hoàn tác',
    }),
  },
  {
    def: {
      id: 'thumbnails-clean',
      name: 'Dọn thumbnail đã lưu',
      description: 'Xóa ảnh thu nhỏ trong ~/.cache/thumbnails và ~/.thumbnails để giải phóng dung lượng.',
      category: 'Bộ nhớ',
      risk: 'low',
      requiresRoot: false,
      recommended: false,
      order: 14,
    },
    apply: async () => {
      const r = await run('rm -rf ~/.cache/thumbnails ~/.thumbnails')
      if (!r.ok) return { success: false, message: r.stderr || 'Không xóa được thumbnail' }
      return { success: true, message: 'Đã xóa ~/.cache/thumbnails và ~/.thumbnails' }
    },
    revert: async () => ({
      success: true,
      message: 'Thumbnail sẽ tự tạo lại khi bạn duyệt file ảnh/video',
    }),
  },
  {
    def: {
      id: 'pip-cache-clean',
      name: 'Dọn cache pip',
      description: 'Xóa cache wheel của pip (thử pip cache purge, nếu thiếu thì xóa ~/.cache/pip).',
      category: 'Bộ nhớ',
      risk: 'low',
      requiresRoot: false,
      recommended: false,
      order: 15,
    },
    apply: async () => {
      const r = await run('pip cache purge 2>/dev/null || rm -rf ~/.cache/pip')
      if (!r.ok) return { success: false, message: r.stderr || 'Không dọn được cache pip' }
      return { success: true, message: short(r.stdout) || 'Đã dọn cache pip' }
    },
    revert: async () => ({
      success: true,
      message: 'Dọn cache không cần hoàn tác — cache sẽ tự tạo lại khi cài package',
    }),
  },
  {
    def: {
      id: 'apt-clean',
      name: 'Dọn cache + gói thừa của apt',
      description: 'apt-get clean xóa kho .deb đã tải và apt-get autoremove gỡ bỏ dependency không còn dùng.',
      category: 'Bộ nhớ',
      risk: 'low',
      requiresRoot: true,
      recommended: false,
      order: 16,
    },
    apply: async () => {
      const r = await tryRoot(`sh -c 'apt-get clean && apt-get autoremove -y'`)
      if (!r.ok) return { success: false, message: r.stderr || ROOT_FAIL }
      return { success: true, message: short(r.stdout) || 'Đã apt-get clean + autoremove' }
    },
    revert: async () => ({
      success: true,
      message: 'Dọn apt không cần hoàn tác — cache .deb sẽ tải lại khi cần',
    }),
  },
  {
    def: {
      id: 'journal-vacuum',
      name: 'Cắt nhỏ journal hệ thống (50M)',
      description: 'Giới hạn nhật ký systemd xuống tối đa 50MB bằng journalctl --vacuum-size.',
      category: 'Bộ nhớ',
      risk: 'low',
      requiresRoot: true,
      recommended: false,
      order: 17,
    },
    apply: async () => {
      const r = await tryRoot('journalctl --vacuum-size=50M')
      if (!r.ok) return { success: false, message: r.stderr || ROOT_FAIL }
      return { success: true, message: short(r.stdout) || 'Đã cắt journal xuống tối đa 50M' }
    },
    revert: async () => ({
      success: true,
      message: 'Journal đã cắt không thể phục hồi — đây là hành động một chiều',
    }),
  },
  {
    def: {
      id: 'suid-dumpable',
      name: 'Tắt core dump cho binary SUID',
      description: 'Đặt fs.suid_dumpable=0 để không tạo file core dump từ chương trình đặt quyền SUID.',
      category: 'Bảo mật & riêng tư',
      risk: 'medium',
      requiresRoot: true,
      recommended: false,
      order: 18,
    },
    apply: () => sysctlRoot('fs.suid_dumpable', '0'),
    revert: () => sysctlRoot('fs.suid_dumpable', '2'),
  },
]

// ---------- Catalog Windows (WinUtil style) — requiresRoot = cần Administrator ----------

const REG_GAME_CONFIG = 'HKCU\\System\\GameConfigStore'
const REG_GAMEDVR = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR'
const REG_GAMEBAR = 'HKCU\\Software\\Microsoft\\GameBar'
const REG_SYSMULTI = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile'
const REG_MOUSE = 'HKCU\\Control Panel\\Mouse'
const REG_VISUALFX = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer'
const REG_PERSONALIZE = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
const REG_SERIALIZE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize'
const REG_CDM = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager'
// ---- Hằng phục vụ các tweak bổ sung (CPU/GPU/RAM/bàn phím/mạng/Windows) ----
const REG_KEYBOARD = 'HKCU\\Control Panel\\Keyboard'
const REG_ACCESS = 'HKCU\\Control Panel\\Accessibility'
const REG_DESKTOP = 'HKCU\\Control Panel\\Desktop'
const REG_ADVANCED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'
const REG_PRIORITY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\PriorityControl'
const REG_GRAPHICS = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers'
const REG_MMCSS_GAMING = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Gaming'
const REG_DNS_POLICY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient'
const REG_COPRO = 'HKCU\\Software\\Policies\\Microsoft\\Windows\\WindowsCopilot'
const REG_BGAPPS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications'
const REG_LANMANSRV = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\LanmanServer\\Parameters'
const REG_NETBT_IF = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\NetBT\\Parameters\\Interfaces'
const POWERCFG_GUID_CURRENT = 'scheme_current'
const BCD_TICK_NAME = 'disabledynamictick'

export const TWEAK_ACTIONS_WIN: TweakAction[] = [
  {
    def: {
      id: 'win-game-dvr-off',
      name: 'Tắt Game DVR / ghi hình nền',
      description: 'Tắt ghi hình nền Xbox Game DVR/AppCapture để giảm overhead GPU và ổ đĩa khi chơi game.',
      category: 'Gaming',
      risk: 'medium',
      requiresRoot: false,
      recommended: true,
      order: 1,
    },
    apply: async () => {
      const a = await regAddValues(REG_GAME_CONFIG, [{ name: 'GameDVR_Enabled', type: 'REG_DWORD', data: '0' }], '')
      if (!a.success) return a
      const b = await regAddValues(REG_GAMEDVR, [{ name: 'AppCaptureEnabled', type: 'REG_DWORD', data: '0' }], '')
      if (!b.success) return b
      return { success: true, message: 'Đã tắt Game DVR (GameDVR_Enabled=0 + AppCaptureEnabled=0)' }
    },
    revert: async () => {
      const a = await regAddValues(REG_GAME_CONFIG, [{ name: 'GameDVR_Enabled', type: 'REG_DWORD', data: '1' }], '')
      if (!a.success) return a
      const b = await regAddValues(REG_GAMEDVR, [{ name: 'AppCaptureEnabled', type: 'REG_DWORD', data: '1' }], '')
      if (!b.success) return b
      return { success: true, message: 'Đã bật lại Game DVR (GameDVR_Enabled=1 + AppCaptureEnabled=1)' }
    },
  },
  {
    def: {
      id: 'win-gamemode-on',
      name: 'Bật Windows Game Mode',
      description: 'Bật Game Mode để Windows ưu tiên tài nguyên cho game và hoãn các tác vụ nền/cập nhật khi chơi.',
      category: 'Gaming',
      risk: 'low',
      requiresRoot: false,
      recommended: true,
      order: 2,
    },
    apply: () =>
      regAddValues(
        REG_GAMEBAR,
        [
          { name: 'AutoGameModeEnabled', type: 'REG_DWORD', data: '1' },
          { name: 'AllowAutoGameMode', type: 'REG_DWORD', data: '1' },
        ],
        'Đã bật Windows Game Mode (AutoGameModeEnabled + AllowAutoGameMode=1)',
      ),
    revert: () =>
      regDeleteValues(
        REG_GAMEBAR,
        ['AutoGameModeEnabled', 'AllowAutoGameMode'],
        'Đã xóa giá trị Game Mode — Windows trở về mặc định',
      ),
  },
  {
    def: {
      id: 'win-fse-off',
      name: 'Tắt fullscreen optimizations',
      description: 'Tắt fullscreen optimizations để game chiếm exclusive fullscreen thật, giảm độ trễ hiển thị và stutter.',
      category: 'Gaming',
      risk: 'medium',
      requiresRoot: false,
      recommended: true,
      order: 3,
    },
    apply: () =>
      regAddValues(
        REG_GAME_CONFIG,
        [
          { name: 'GameDVR_FSEBehaviorMode', type: 'REG_DWORD', data: '2' },
          { name: 'GameDVR_HonorUserFSEBehaviorMode', type: 'REG_DWORD', data: '1' },
          { name: 'GameDVR_DXGIHonorFSEWindowsCompatible', type: 'REG_DWORD', data: '1' },
          { name: 'GameDVR_EFSEFeatureFlags', type: 'REG_DWORD', data: '0' },
        ],
        'Đã tắt fullscreen optimizations (GameDVR_FSEBehaviorMode=2)',
      ),
    revert: () =>
      regDeleteValues(
        REG_GAME_CONFIG,
        [
          'GameDVR_FSEBehaviorMode',
          'GameDVR_HonorUserFSEBehaviorMode',
          'GameDVR_DXGIHonorFSEWindowsCompatible',
          'GameDVR_EFSEFeatureFlags',
        ],
        'Đã xóa 4 giá trị FSE — trả về mặc định của Windows',
      ),
  },
  {
    def: {
      id: 'win-power-high',
      name: 'Chuyển kế hoạch nguồn Hiệu năng cao',
      description: 'powercfg /setactive sang High performance; nếu máy chưa có kế hoạch này sẽ tự nhân bản từ mẫu ẩn rồi bật.',
      category: 'Hiệu năng',
      risk: 'medium',
      requiresRoot: true,
      recommended: true,
      order: 4,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      // powercfg chạy TRỰC TIẾP theo đường dẫn tuyệt đối (không cần PowerShell)
      const direct = await runSysExe('powercfg.exe', ['/setactive', '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'], 30000)
      if (direct.ok) {
        return { success: true, message: 'Đã bật kế hoạch nguồn Hiệu năng cao (High performance)' }
      }
      const dup = await runSysExe(
        'powercfg.exe',
        ['-duplicatescheme', 'e9a42b02-d5df-448d-aa00-03f14749eb61'],
        30000,
      )
      // GUID trong output không phụ thuộc ngôn ngữ Windows (thông báo xung quanh bị localize)
      const guid = dup.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]
      if (!dup.ok || !guid) {
        return {
          success: false,
          message: short(
            `Không bật được kế hoạch Hiệu năng cao (exit ${direct.code}): ${direct.stderr || direct.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      const act = await runSysExe('powercfg.exe', ['/setactive', guid], 30000)
      if (!act.ok) {
        return {
          success: false,
          message: short(`Không kích hoạt được kế hoạch mới ${guid}: ${act.stderr || 'không rõ lý do'}`),
        }
      }
      return { success: true, message: `Đã tạo mới và bật kế hoạch nguồn Hiệu năng cao (${guid})` }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const r = await runSysExe('powercfg.exe', ['/setactive', '381b4222-f694-41f0-9685-ff5bb260df2e'], 30000)
      if (!r.ok) {
        return {
          success: false,
          message: short(
            `Không hoàn tác được kế hoạch nguồn (exit ${r.code}): ${r.stderr || r.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      return { success: true, message: 'Đã hoàn tác kế hoạch nguồn về Balanced (mặc định)' }
    },
  },
  {
    def: {
      id: 'win-sysresp',
      name: 'SystemResponsiveness = 0 (ưu tiên app foreground)',
      description: 'Đặt SystemResponsiveness=0 để MMCSS ưu tiên CPU cho ứng dụng foreground thay vì dịch vụ nền.',
      category: 'Hiệu năng',
      risk: 'medium',
      requiresRoot: true,
      recommended: true,
      order: 5,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regAddValues(
        REG_SYSMULTI,
        [{ name: 'SystemResponsiveness', type: 'REG_DWORD', data: '0' }],
        'Đã đặt SystemResponsiveness=0 — ưu tiên ứng dụng foreground',
      )
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regAddValues(
        REG_SYSMULTI,
        [{ name: 'SystemResponsiveness', type: 'REG_DWORD', data: '20' }],
        'Đã hoàn tác SystemResponsiveness về 20 (mặc định)',
      )
    },
  },
  {
    def: {
      id: 'win-netthrottle',
      name: 'Tắt Network Throttling',
      description: 'Đặt NetworkThrottlingIndex=0xFFFFFFFF để tắt giới hạn băng thông nền khi có multimedia đang phát.',
      category: 'Mạng',
      risk: 'medium',
      requiresRoot: true,
      recommended: true,
      order: 6,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regAddValues(
        REG_SYSMULTI,
        [{ name: 'NetworkThrottlingIndex', type: 'REG_DWORD', data: '4294967295' }],
        'Đã tắt Network Throttling (NetworkThrottlingIndex=0xFFFFFFFF)',
      )
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regAddValues(
        REG_SYSMULTI,
        [{ name: 'NetworkThrottlingIndex', type: 'REG_DWORD', data: '10' }],
        'Đã hoàn tác NetworkThrottlingIndex về 10 (mặc định)',
      )
    },
  },
  {
    def: {
      id: 'win-nagle',
      name: 'Tắt Nagle (giảm ping game online)',
      description: 'Đặt TcpAckFrequency=1 + TCPNoDelay=1 trên mọi interface TCP/IP để tắt thuật toán Nagle, giảm độ trễ mạng.',
      category: 'Mạng',
      risk: 'medium',
      requiresRoot: true,
      recommended: false,
      order: 7,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const reg = findSysExe('reg.exe')
      if (!reg) return { success: false, message: NO_REG_EXE }
      const base = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces'
      const q = await runExe(reg, ['query', base], 15000)
      if (!q.ok) {
        return {
          success: false,
          message: short(
            `Không liệt kê được interface mạng (reg.exe query exit ${q.code}): ${q.stderr || q.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      // reg query in tên subkey dạng dòng "HKEY_LOCAL_MACHINE\...\Interfaces\Tcpip_{GUID}"
      // (không phụ thuộc locale) — chỉ lấy các key Tcpip_{GUID} thật sự
      const keys = q.stdout
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/^HKEY_LOCAL_MACHINE\\/i, 'HKLM\\'))
        .filter((l) => /^HKLM\\/i.test(l) && /\\Tcpip_\{[0-9a-f-]{36}\}$/i.test(l))
      if (keys.length === 0) {
        return { success: false, message: 'Không tìm thấy interface TCP/IP nào trong registry' }
      }
      let n = 0
      const failed: string[] = []
      for (const k of keys) {
        const a = await runExe(reg, ['add', k, '/v', 'TcpAckFrequency', '/t', 'REG_DWORD', '/d', '1', '/f'], 10000)
        const b = await runExe(reg, ['add', k, '/v', 'TCPNoDelay', '/t', 'REG_DWORD', '/d', '1', '/f'], 10000)
        if (a.ok && b.ok) n++
        else failed.push(k)
      }
      if (n === 0) {
        return {
          success: false,
          message: short(`Không đặt được TcpAckFrequency/TCPNoDelay trên interface nào: ${failed.join('; ')}`),
        }
      }
      const extra = failed.length > 0 ? ` (${failed.length} interface lỗi: bỏ qua)` : ''
      return {
        success: true,
        message: `Đã tắt Nagle trên ${n} interface mạng (TcpAckFrequency=1 + TCPNoDelay=1)${extra}`,
      }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const reg = findSysExe('reg.exe')
      if (!reg) return { success: false, message: NO_REG_EXE }
      const base = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces'
      const q = await runExe(reg, ['query', base], 15000)
      if (!q.ok) {
        return {
          success: false,
          message: short(`Không liệt kê được interface mạng (exit ${q.code}): ${q.stderr || 'không rõ lý do'}`),
        }
      }
      const keys = q.stdout
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/^HKEY_LOCAL_MACHINE\\/i, 'HKLM\\'))
        .filter((l) => /^HKLM\\/i.test(l) && /\\Tcpip_\{[0-9a-f-]{36}\}$/i.test(l))
      const failed: string[] = []
      for (const k of keys) {
        // query trước — thiếu giá trị (chưa từng set) không phải lỗi
        for (const v of ['TcpAckFrequency', 'TCPNoDelay']) {
          const has = await runExe(reg, ['query', k, '/v', v], 10000)
          if (!has.ok) continue
          const d = await runExe(reg, ['delete', k, '/v', v, '/f'], 10000)
          if (!d.ok) failed.push(`${k}\\${v}`)
        }
      }
      if (failed.length > 0) {
        return { success: false, message: short(`Không xóa được giá trị Nagle tại: ${failed.join('; ')}`) }
      }
      return { success: true, message: 'Đã xóa TcpAckFrequency/TCPNoDelay khỏi mọi interface mạng' }
    },
  },
  {
    def: {
      id: 'win-mouse-accurate',
      name: 'Tắt gia tốc chuột (aim chính xác)',
      description: 'MouseSpeed=0 và hai ngưỡng =0 để tắt hoàn toàn gia tốc con trỏ — chuyển động chuột 1:1 trong game FPS.',
      category: 'Gaming',
      risk: 'low',
      requiresRoot: false,
      recommended: true,
      order: 8,
    },
    apply: () =>
      regAddValues(
        REG_MOUSE,
        [
          { name: 'MouseSpeed', type: 'REG_SZ', data: '0' },
          { name: 'MouseThreshold1', type: 'REG_SZ', data: '0' },
          { name: 'MouseThreshold2', type: 'REG_SZ', data: '0' },
        ],
        'Đã tắt gia tốc chuột (MouseSpeed=0, Threshold 0/0)',
      ),
    revert: () =>
      regAddValues(
        REG_MOUSE,
        [
          { name: 'MouseSpeed', type: 'REG_SZ', data: '1' },
          { name: 'MouseThreshold1', type: 'REG_SZ', data: '6' },
          { name: 'MouseThreshold2', type: 'REG_SZ', data: '10' },
        ],
        'Đã hoàn tác gia tốc chuột về mặc định (1/6/10)',
      ),
  },
  {
    def: {
      id: 'win-visualfx',
      name: 'Hiệu ứng trực quan: hiệu năng tốt nhất',
      description: 'Đặt VisualFXSetting=2 để Windows tắt các hiệu ứng trực quan nặng, dành tài nguyên cho hiệu năng.',
      category: 'Hiệu năng',
      risk: 'low',
      requiresRoot: false,
      recommended: false,
      order: 9,
    },
    apply: () =>
      regAddValues(
        REG_VISUALFX,
        [{ name: 'VisualFXSetting', type: 'REG_DWORD', data: '2' }],
        'Đã đặt hiệu ứng trực quan = hiệu năng tốt nhất (VisualFXSetting=2)',
      ),
    revert: () =>
      regAddValues(
        REG_VISUALFX,
        [{ name: 'VisualFXSetting', type: 'REG_DWORD', data: '0' }],
        'Đã hoàn tác VisualFXSetting về 0 (để Windows tự chọn)',
      ),
  },
  {
    def: {
      id: 'win-transparency-off',
      name: 'Tắt hiệu ứng trong suốt',
      description: 'Tắt hiệu ứng acrylic/transparent của Windows để giảm tải GPU và tăng độ mượt của giao diện.',
      category: 'Hiệu năng',
      risk: 'low',
      requiresRoot: false,
      recommended: false,
      order: 10,
    },
    apply: () =>
      regAddValues(
        REG_PERSONALIZE,
        [{ name: 'EnableTransparency', type: 'REG_DWORD', data: '0' }],
        'Đã tắt hiệu ứng trong suốt (EnableTransparency=0)',
      ),
    revert: () =>
      regAddValues(
        REG_PERSONALIZE,
        [{ name: 'EnableTransparency', type: 'REG_DWORD', data: '1' }],
        'Đã bật lại hiệu ứng trong suốt (mặc định)',
      ),
  },
  {
    def: {
      id: 'win-startup-delay',
      name: 'Xóa delay khởi động app',
      description: 'Đặt StartupDelayInMSec=0 (tự tạo key Serialize nếu thiếu) để Windows không trì hoãn khởi chạy app sau đăng nhập.',
      category: 'Hiệu năng',
      risk: 'low',
      requiresRoot: false,
      recommended: true,
      order: 11,
    },
    apply: async () => {
      // reg.exe add tự tạo key Serialize nếu thiếu (không cần New-Item qua PowerShell)
      const r = await regAddValues(
        REG_SERIALIZE,
        [{ name: 'StartupDelayInMSec', type: 'REG_DWORD', data: '0' }],
        'Đã đặt StartupDelayInMSec=0 — app khởi động không bị trì hoãn',
      )
      return r
    },
    revert: () =>
      regDeleteValues(REG_SERIALIZE, ['StartupDelayInMSec'], 'Đã xóa StartupDelayInMSec — Windows dùng delay mặc định'),
  },
  {
    def: {
      id: 'win-ram-clean',
      name: 'Xả RAM tiến trình (EmptyWorkingSet)',
      description: 'Gọi EmptyWorkingSet (psapi.dll) cho mọi tiến trình dùng >50MB RAM (trừ chính app) để ép Windows xả working set.',
      category: 'Bộ nhớ',
      risk: 'low',
      requiresRoot: false,
      recommended: true,
      order: 12,
    },
    apply: async () => {
      const r = await psRun(
        `try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NexusPsApi {
  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool EmptyWorkingSet(IntPtr hProc);
}
'@ -ErrorAction Stop
} catch {
  Write-Output $_.Exception.Message
  exit 1
}
$me = $PID
$n = 0
$procs = Get-Process | Where-Object { $_.Id -ne $me -and $_.WorkingSet64 -gt 50MB }
foreach ($p in $procs) {
  try {
    if ([NexusPsApi]::EmptyWorkingSet($p.Handle)) { $n++ }
  } catch { }
}
Write-Output "trimmed=$n"
exit 0`,
        30000,
      )
      if (!r.ok) {
        return {
          success: false,
          message: short(r.stderr || r.stdout || 'Không nạp được EmptyWorkingSet (psapi.dll)'),
        }
      }
      return { success: true, message: 'Đã yêu cầu giải phóng working set của các tiến trình nặng' }
    },
    revert: async () => ({
      success: true,
      message: 'Hành động tức thời — không cần hoàn tác',
    }),
  },
  {
    def: {
      id: 'win-flush-dns',
      name: 'Xả cache DNS (ipconfig /flushdns)',
      description: 'ipconfig /flushdns xóa cache DNS resolver của Windows, giúp phân giải tên miền theo bản ghi mới nhất.',
      category: 'Mạng',
      risk: 'low',
      requiresRoot: false,
      recommended: true,
      order: 13,
    },
    apply: async () => {
      const r = await runSysExe('ipconfig.exe', ['/flushdns'], 30000)
      if (!r.ok) {
        return {
          success: false,
          message: short(
            `ipconfig /flushdns thất bại (exit ${r.code}): ${r.stderr || r.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      return { success: true, message: 'Đã xả cache DNS của Windows (ipconfig /flushdns)' }
    },
    revert: async () => ({
      success: true,
      message: 'Hành động tức thời — không cần hoàn tác',
    }),
  },
  {
    def: {
      id: 'win-sysmain-off',
      name: 'Tắt SysMain (Superfetch) — chỉ nên dùng khi ổ SSD',
      description: 'sc.exe stop + start=disabled cho SysMain; giảm tải nền nhưng làm HDD chậm hơn khi mở app — chỉ dùng khi ổ SSD.',
      category: 'Hiệu năng',
      risk: 'high',
      requiresRoot: true,
      recommended: false,
      order: 14,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      // sc.exe chạy trực tiếp (exit code 1062 = dịch vụ chưa chạy — vẫn coi là OK)
      const stop = await runSysExe('sc.exe', ['stop', 'SysMain'], 20000)
      if (!stop.ok && stop.code !== 1062) {
        return {
          success: false,
          message: short(
            `sc.exe stop SysMain thất bại (exit ${stop.code}): ${stop.stderr || stop.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      const cfg = await runSysExe('sc.exe', ['config', 'SysMain', 'start=', 'disabled'], 20000)
      if (!cfg.ok) {
        return {
          success: false,
          message: short(
            `sc.exe config SysMain start=disabled thất bại (exit ${cfg.code}): ${cfg.stderr || cfg.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      return { success: true, message: 'Đã tắt dịch vụ SysMain (Superfetch) — start=disabled' }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const cfg = await runSysExe('sc.exe', ['config', 'SysMain', 'start=', 'auto'], 20000)
      if (!cfg.ok) {
        return {
          success: false,
          message: short(
            `sc.exe config SysMain start=auto thất bại (exit ${cfg.code}): ${cfg.stderr || cfg.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      await runSysExe('sc.exe', ['start', 'SysMain'], 20000) // lỗi start được bỏ qua (đã chạy sẵn)
      return { success: true, message: 'Đã hoàn tác SysMain về start=auto (+ thử start — lỗi start được bỏ qua)' }
    },
  },
  {
    def: {
      id: 'win-diagtrack-off',
      name: 'Tắt telemetry (DiagTrack + dmwappushservice)',
      description: 'Disable + stop dịch vụ DiagTrack (Connected User Experiences) và dmwappushservice để dừng gửi dữ liệu chẩn đoán.',
      category: 'Bảo mật & riêng tư',
      risk: 'medium',
      requiresRoot: true,
      recommended: false,
      order: 15,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      // exit 1060 = dịch vụ không tồn tại (máy đã rút gọn) — vẫn OK; 1062 = chưa chạy
      const cfg1 = await runSysExe('sc.exe', ['config', 'DiagTrack', 'start=', 'disabled'], 20000)
      if (!cfg1.ok) {
        return {
          success: false,
          message: short(
            `sc.exe config DiagTrack thất bại (exit ${cfg1.code}): ${cfg1.stderr || cfg1.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      const cfg2 = await runSysExe('sc.exe', ['config', 'dmwappushservice', 'start=', 'disabled'], 20000)
      if (!cfg2.ok && cfg2.code !== 1060) {
        return {
          success: false,
          message: short(
            `sc.exe config dmwappushservice thất bại (exit ${cfg2.code}): ${cfg2.stderr || cfg2.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      const stop1 = await runSysExe('sc.exe', ['stop', 'DiagTrack'], 20000)
      if (!stop1.ok && stop1.code !== 1062 && stop1.code !== 1060) {
        return {
          success: false,
          message: short(
            `sc.exe stop DiagTrack thất bại (exit ${stop1.code}): ${stop1.stderr || stop1.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      await runSysExe('sc.exe', ['stop', 'dmwappushservice'], 20000) // lỗi stop được bỏ qua (1060/1062)
      return { success: true, message: 'Đã tắt telemetry: DiagTrack + dmwappushservice (start=disabled)' }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const cfg1 = await runSysExe('sc.exe', ['config', 'DiagTrack', 'start=', 'auto'], 20000)
      if (!cfg1.ok) {
        return {
          success: false,
          message: short(
            `sc.exe config DiagTrack start=auto thất bại (exit ${cfg1.code}): ${cfg1.stderr || cfg1.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      const cfg2 = await runSysExe('sc.exe', ['config', 'dmwappushservice', 'start=', 'demand'], 20000)
      if (!cfg2.ok && cfg2.code !== 1060) {
        return {
          success: false,
          message: short(
            `sc.exe config dmwappushservice start=demand thất bại (exit ${cfg2.code}): ${cfg2.stderr || cfg2.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      return { success: true, message: 'Đã hoàn tác telemetry: DiagTrack start=auto, dmwappushservice start=demand' }
    },
  },
  {
    def: {
      id: 'win-tips-off',
      name: 'Tắt gợi ý/quảng cáo Windows',
      description: 'Tắt SystemPaneSuggestions + SubscribedContent 338388/338389/338393 để loại bỏ gợi ý và quảng cáo trong Start.',
      category: 'Bảo mật & riêng tư',
      risk: 'low',
      requiresRoot: false,
      recommended: false,
      order: 16,
    },
    apply: () =>
      regAddValues(
        REG_CDM,
        [
          { name: 'SystemPaneSuggestionsEnabled', type: 'REG_DWORD', data: '0' },
          { name: 'SubscribedContent-338388Enabled', type: 'REG_DWORD', data: '0' },
          { name: 'SubscribedContent-338389Enabled', type: 'REG_DWORD', data: '0' },
          { name: 'SubscribedContent-338393Enabled', type: 'REG_DWORD', data: '0' },
        ],
        'Đã tắt gợi ý/quảng cáo Windows (ContentDeliveryManager)',
      ),
    revert: () =>
      regAddValues(
        REG_CDM,
        [
          { name: 'SystemPaneSuggestionsEnabled', type: 'REG_DWORD', data: '1' },
          { name: 'SubscribedContent-338388Enabled', type: 'REG_DWORD', data: '1' },
          { name: 'SubscribedContent-338389Enabled', type: 'REG_DWORD', data: '1' },
          { name: 'SubscribedContent-338393Enabled', type: 'REG_DWORD', data: '1' },
        ],
        'Đã bật lại gợi ý/quảng cáo Windows (mặc định)',
      ),
  },
  // ================== Bổ sung: CPU / GPU / RAM / bàn phím / mạng / Windows ==================
  {
    def: {
      id: 'win-cpu-priority-separation',
      name: 'Win32PrioritySeparation=38 (ưu tiên foreground)',
      description:
        'Đặt Win32PrioritySeparation=0x26 (38) — quantum ngắn + tăng ưu tiên ứng dụng foreground mạnh, CPU dành trước cho game/app đang mở.',
      category: 'Hiệu năng',
      risk: 'medium',
      requiresRoot: true,
      recommended: false,
      order: 17,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regAddValues(
        REG_PRIORITY,
        [{ name: 'Win32PrioritySeparation', type: 'REG_DWORD', data: '38' }],
        'Đã đặt Win32PrioritySeparation=38 (0x26) — ưu tiên ứng dụng foreground',
      )
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regAddValues(
        REG_PRIORITY,
        [{ name: 'Win32PrioritySeparation', type: 'REG_DWORD', data: '2' }],
        'Đã hoàn tác Win32PrioritySeparation về 2 (mặc định)',
      )
    },
  },
  {
    def: {
      id: 'win-cpu-core-parking-off',
      name: 'Tắt core parking CPU',
      description:
        'powercfg đặt CPMINCORES=100 cho kế hoạch hiện hành: Windows không "giam giữ" lõi CPU ở trạng thái park, giảm micro-stutter. Áp cho nguồn cắm điện (AC); nên dùng kèm kế hoạch Hiệu năng cao.',
      category: 'Hiệu năng',
      risk: 'medium',
      requiresRoot: true,
      recommended: false,
      order: 18,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const set = await runSysExe(
        'powercfg.exe',
        ['-setacvalueindex', POWERCFG_GUID_CURRENT, 'sub_processor', 'CPMINCORES', '100'],
        30000,
      )
      if (!set.ok) {
        return {
          success: false,
          message: short(
            `powercfg setacvalueindex CPMINCORES thất bại (exit ${set.code}): ${set.stderr || 'không rõ lý do'}`,
          ),
        }
      }
      const act = await runSysExe('powercfg.exe', ['/setactive', POWERCFG_GUID_CURRENT], 30000)
      if (!act.ok) {
        return {
          success: false,
          message: short(`powercfg setactive scheme_current thất bại (exit ${act.code}): ${act.stderr || 'không rõ lý do'}`),
        }
      }
      return { success: true, message: 'Đã tắt core parking (CPMINCORES=100, AC) và kích hoạt lại kế hoạch hiện hành' }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const set = await runSysExe(
        'powercfg.exe',
        ['-setacvalueindex', POWERCFG_GUID_CURRENT, 'sub_processor', 'CPMINCORES', '5'],
        30000,
      )
      if (!set.ok) {
        return { success: false, message: short(`powercfg hoàn tác CPMINCORES thất bại: ${set.stderr || 'không rõ lý do'}`) }
      }
      await runSysExe('powercfg.exe', ['/setactive', POWERCFG_GUID_CURRENT], 30000)
      return { success: true, message: 'Đã hoàn tác core parking về CPMINCORES=5 (mặc định)' }
    },
  },
  {
    def: {
      id: 'win-cpu-dynamic-tick-off',
      name: 'Tắt dynamic tick (bcdedit) — cần khởi động lại',
      description:
        'bcdedit /set disabledynamictick yes — buộc bộ định thời dùng tick liên tục, giảm jitter độ trễ DPC cho game. Cần khởi động lại Windows để có hiệu lực; một số máy main cũ có thể không tương thích.',
      category: 'Hiệu năng',
      risk: 'high',
      requiresRoot: true,
      recommended: false,
      order: 19,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const r = await runSysExe('bcdedit.exe', ['/set', BCD_TICK_NAME, 'yes'], 30000)
      if (!r.ok) {
        return {
          success: false,
          message: short(
            `bcdedit /set disabledynamictick yes thất bại (exit ${r.code}): ${r.stderr || r.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      return { success: true, message: 'Đã đặt disabledynamictick=yes — hãy khởi động lại Windows để có hiệu lực' }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const r = await runSysExe('bcdedit.exe', ['/deletevalue', BCD_TICK_NAME], 30000)
      // deletevalue lỗi khi giá trị không còn trong BCD — đó chính là trạng thái mặc định
      return {
        success: true,
        message: r.ok
          ? 'Đã xóa disabledynamictick khỏi BCD — quay về tick động mặc định (khởi động lại để có hiệu lực)'
          : `Đã ở trạng thái mặc định (disabledynamictick không còn trong BCD — exit ${r.code}); khởi động lại để có hiệu lực`,
      }
    },
  },
  {
    def: {
      id: 'win-gpu-hwsch-on',
      name: 'Bật GPU Hardware Scheduling (HAGS)',
      description:
        'Đặt HwSchMode=2 (Hardware-Accelerated GPU Scheduling) giảm overhead CPU khi render, cần GPU + driver hỗ trợ và khởi động lại. Driver/OS cũ không hỗ trợ sẽ bỏ qua giá trị này.',
      category: 'Gaming',
      risk: 'medium',
      requiresRoot: true,
      recommended: false,
      order: 20,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regAddValues(
        REG_GRAPHICS,
        [{ name: 'HwSchMode', type: 'REG_DWORD', data: '2' }],
        'Đã đặt HwSchMode=2 (HAGS bật) — khởi động lại Windows để áp dụng',
      )
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regDeleteValues(REG_GRAPHICS, ['HwSchMode'], 'Đã xóa HwSchMode — GPU scheduling trở về mặc định của driver')
    },
  },
  {
    def: {
      id: 'win-gpu-tdr-delay',
      name: 'Gia hạn thời gian chờ TDR của GPU',
      description:
        'Đặt TdrDelay=10 + TdrDdiDelay=10 giây — giảm nguy cơ driver GPU bị reset ("Display driver stopped responding") khi overclock/đẩy nặng. Chỉ dùng khi thực sự cần; mặc định là 2 giây.',
      category: 'Hiệu năng',
      risk: 'high',
      requiresRoot: true,
      recommended: false,
      order: 21,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regAddValues(
        REG_GRAPHICS,
        [
          { name: 'TdrDelay', type: 'REG_DWORD', data: '10' },
          { name: 'TdrDdiDelay', type: 'REG_DWORD', data: '10' },
        ],
        'Đã đặt TdrDelay=10 + TdrDdiDelay=10 — khởi động lại để áp dụng',
      )
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regDeleteValues(REG_GRAPHICS, ['TdrDelay', 'TdrDdiDelay'], 'Đã xóa TdrDelay/TdrDdiDelay — trở về mặc định 2 giây')
    },
  },
  {
    def: {
      id: 'win-ram-standby-clear',
      name: 'Xả standby list RAM (NtSetSystemInformation)',
      description:
        'Gọi MemoryPurgeStandbyList qua ntdll để ép Windows xả toàn bộ trang RAM standby (kỹ thuật của EmptyStandbyList/ISLC), trả RAM trống về available ngay. Cần Administrator và PowerShell.',
      category: 'Bộ nhớ',
      risk: 'medium',
      requiresRoot: true,
      recommended: false,
      order: 22,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const r = await psRun(
        `$sig = @'
using System;
using System.Runtime.InteropServices;
public static class NexusStandby {
  [DllImport("ntdll.dll")] public static extern uint NtSetSystemInformation(int InfoClass, ref int Info, int Length);
  [DllImport("ntdll.dll")] public static extern uint RtlAdjustPrivilege(int Privilege, bool Enable, bool CurrentThread, ref bool Enabled);
}
'@
try {
  Add-Type -TypeDefinition $sig -ErrorAction Stop
} catch {
  Write-Output $_.Exception.Message
  exit 1
}
$en = $false
[void][NexusStandby]::RtlAdjustPrivilege(19, $true, $false, [ref]$en)
$freeBefore = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024, 1)
# 5 = MemoryPurgeStandbyList, 4 = MemoryPurgeLowMemoryStandbyList (SystemMemoryListInformation = 80)
$r1 = [NexusStandby]::NtSetSystemInformation(80, [ref]5, 4)
$r2 = [NexusStandby]::NtSetSystemInformation(80, [ref]4, 4)
$freeAfter = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024, 1)
Write-Output "freeMB=$freeBefore -> $freeAfter nts1=$r1 nts2=$r2"
if ($r1 -ne 0 -and $r2 -ne 0) { exit 1 }
exit 0`,
        30000,
      )
      if (!r.ok) {
        return {
          success: false,
          message: short(
            `Xả standby list thất bại: ${r.stdout || r.stderr || 'không rõ lý do'} (cần Administrator + PowerShell)`,
          ),
        }
      }
      const m = r.stdout.match(/freeMB=([\d.]+) -> ([\d.]+)/)
      return {
        success: true,
        message: m
          ? `Đã xả standby list — RAM trống ${m[1]}MB → ${m[2]}MB (giải phóng ~${Math.max(0, Math.round(Number(m[2]) - Number(m[1])))}MB)`
          : 'Đã yêu cầu xả standby list RAM',
      }
    },
    revert: async () => ({
      success: true,
      message: 'Hành động tức thời — không cần hoàn tác',
    }),
  },
  {
    def: {
      id: 'win-ram-compression-off',
      name: 'Tắt Memory Compression (nén RAM)',
      description:
        'Disable-MMAgent -MemoryCompression: tắt tiến trình nén bộ nhớ để tiết kiệm CPU, đổi lại dùng nhiều pagefile hơn khi RAM đầy. Chỉ nên dùng khi RAM dư nhiều; cần PowerShell.',
      category: 'Bộ nhớ',
      risk: 'high',
      requiresRoot: true,
      recommended: false,
      order: 23,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const r = await psRun('Disable-MMAgent -MemoryCompression\nif ($?) { exit 0 } else { exit 1 }', 30000)
      if (!r.ok) {
        return {
          success: false,
          message: short(
            `Disable-MMAgent -MemoryCompression thất bại: ${r.stderr || r.stdout || 'không rõ lý do'} (cần PowerShell)`,
          ),
        }
      }
      return { success: true, message: 'Đã tắt Memory Compression — khởi động lại để áp dụng hoàn toàn' }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const r = await psRun('Enable-MMAgent -MemoryCompression\nif ($?) { exit 0 } else { exit 1 }', 30000)
      if (!r.ok) {
        return {
          success: false,
          message: short(`Enable-MMAgent -MemoryCompression thất bại: ${r.stderr || r.stdout || 'không rõ lý do'}`),
        }
      }
      return { success: true, message: 'Đã bật lại Memory Compression (mặc định)' }
    },
  },
  {
    def: {
      id: 'win-keyboard-fast',
      name: 'Bàn phím phản hồi cực nhanh',
      description:
        'KeyboardDelay=0 (delay ngắn nhất) + KeyboardSpeed=31 (lặp nhanh nhất) — phím lặp tức thì khi giữ, lợi cho game nhấn nhá nhanh.',
      category: 'Gaming',
      risk: 'low',
      requiresRoot: false,
      recommended: true,
      order: 24,
    },
    apply: () =>
      regAddValues(
        REG_KEYBOARD,
        [
          { name: 'KeyboardDelay', type: 'REG_SZ', data: '0' },
          { name: 'KeyboardSpeed', type: 'REG_SZ', data: '31' },
        ],
        'Đã đặt bàn phím delay=0, tốc độ lặp 31 (nhanh nhất)',
      ),
    revert: () =>
      regAddValues(
        REG_KEYBOARD,
        [
          { name: 'KeyboardDelay', type: 'REG_SZ', data: '1' },
          { name: 'KeyboardSpeed', type: 'REG_SZ', data: '31' },
        ],
        'Đã hoàn tác bàn phím về mặc định (delay=1)',
      ),
  },
  {
    def: {
      id: 'win-keyboard-accessibility-off',
      name: 'Tắt Sticky/Filter/Toggle Keys',
      description:
        'Tắt StickyKeys, FilterKeys, ToggleKeys và hộp thoại "bạn có muốn bật..." hiện ra khi giữ Shift/Num Lock lâu — hết phiền phức khi chơi game FPS.',
      category: 'Gaming',
      risk: 'low',
      requiresRoot: false,
      recommended: false,
      order: 25,
    },
    apply: () =>
      regAddValues(
        REG_ACCESS,
        [
          { name: 'StickyKeys', type: 'REG_SZ', data: '506' },
          { name: 'ToggleKeys', type: 'REG_SZ', data: '58' },
          { name: 'FilterKeys', type: 'REG_SZ', data: '26' },
        ],
        'Đã tắt StickyKeys/ToggleKeys/FilterKeys (flags=506/58/26)',
      ),
    revert: () =>
      regAddValues(
        REG_ACCESS,
        [
          { name: 'StickyKeys', type: 'REG_SZ', data: '510' },
          { name: 'ToggleKeys', type: 'REG_SZ', data: '58' },
          { name: 'FilterKeys', type: 'REG_SZ', data: '126' },
        ],
        'Đã hoàn tác StickyKeys/ToggleKeys/FilterKeys về mặc định (510/58/126)',
      ),
  },
  {
    def: {
      id: 'win-net-llmnr-off',
      name: 'Tắt LLMNR (giảm nhiễu mạng LAN)',
      description:
        'Tắt multicast name resolution (LLMNR) qua policy DNSClient — giảm traffic phát sóng trong LAN, tránh truy vấn tên máy rác; an toàn cho mạng gia đình/văn phòng chuẩn.',
      category: 'Mạng',
      risk: 'low',
      requiresRoot: true,
      recommended: false,
      order: 26,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regAddValues(
        REG_DNS_POLICY,
        [{ name: 'EnableMulticast', type: 'REG_DWORD', data: '0' }],
        'Đã tắt LLMNR (EnableMulticast=0)',
      )
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regDeleteValues(REG_DNS_POLICY, ['EnableMulticast'], 'Đã xóa policy LLMNR — trở về mặc định')
    },
  },
  {
    def: {
      id: 'win-net-netbios-off',
      name: 'Tắt NetBIOS over TCP/IP',
      description:
        'Đặt NetbiosOptions=2 trên mọi interface Tcpip_* — tắt NetBIOS khỏi mạng TCP/IP, giảm packet broadcast rác và lỗ hổng NetBIOS; có thể ảnh hưởng chia sẻ file kiểu máy cũ trong LAN.',
      category: 'Mạng',
      risk: 'medium',
      requiresRoot: true,
      recommended: false,
      order: 27,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const reg = findSysExe('reg.exe')
      if (!reg) return { success: false, message: NO_REG_EXE }
      const q = await runExe(reg, ['query', REG_NETBT_IF], 15000)
      if (!q.ok) {
        return {
          success: false,
          message: short(
            `Không liệt kê được interface NetBT (exit ${q.code}): ${q.stderr || q.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      const keys = q.stdout
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/^HKEY_LOCAL_MACHINE\\/i, 'HKLM\\'))
        .filter((l) => /^HKLM\\/i.test(l) && /\\Tcpip_/i.test(l))
      if (keys.length === 0) {
        return { success: false, message: 'Không tìm thấy interface Tcpip_* trong NetBT\\Parameters\\Interfaces' }
      }
      let n = 0
      const failed: string[] = []
      for (const k of keys) {
        const a = await runExe(reg, ['add', k, '/v', 'NetbiosOptions', '/t', 'REG_DWORD', '/d', '2', '/f'], 10000)
        if (a.ok) n++
        else failed.push(k)
      }
      if (n === 0) {
        return { success: false, message: short(`Không đặt được NetbiosOptions trên interface nào: ${failed.join('; ')}`) }
      }
      const extra = failed.length > 0 ? ` (${failed.length} interface lỗi)` : ''
      return { success: true, message: `Đã tắt NetBIOS over TCP/IP trên ${n} interface${extra}` }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const reg = findSysExe('reg.exe')
      if (!reg) return { success: false, message: NO_REG_EXE }
      const q = await runExe(reg, ['query', REG_NETBT_IF], 15000)
      if (!q.ok) {
        return { success: false, message: short(`Không liệt kê được interface NetBT (exit ${q.code})`) }
      }
      const keys = q.stdout
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/^HKEY_LOCAL_MACHINE\\/i, 'HKLM\\'))
        .filter((l) => /^HKLM\\/i.test(l) && /\\Tcpip_/i.test(l))
      const failed: string[] = []
      for (const k of keys) {
        const has = await runExe(reg, ['query', k, '/v', 'NetbiosOptions'], 10000)
        if (!has.ok) continue
        const d = await runExe(reg, ['delete', k, '/v', 'NetbiosOptions', '/f'], 10000)
        if (!d.ok) failed.push(k)
      }
      if (failed.length > 0) {
        return { success: false, message: short(`Không xóa được NetbiosOptions tại: ${failed.join('; ')}`) }
      }
      return { success: true, message: 'Đã xóa NetbiosOptions khỏi mọi interface — NetBIOS về mặc định (DHCP)' }
    },
  },
  {
    def: {
      id: 'win-smb1-off',
      name: 'Tắt SMBv1 (bảo mật)',
      description:
        'Đặt SMB1=0 cho LanmanServer — tắt phiên bản SMB 1.0 lỗi thời (EternalBlue/Ransomware hay lợi dụng); thiết bị NAS/tự in ấn rất cũ dùng SMB1 có thể ngắt kết nối.',
      category: 'Bảo mật & riêng tư',
      risk: 'medium',
      requiresRoot: true,
      recommended: false,
      order: 28,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regAddValues(
        REG_LANMANSRV,
        [{ name: 'SMB1', type: 'REG_DWORD', data: '0' }],
        'Đã tắt SMBv1 (LanmanServer SMB1=0)',
      )
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regDeleteValues(REG_LANMANSRV, ['SMB1'], 'Đã xóa SMB1=0 — máy chủ SMB trở về cấu hình mặc định')
    },
  },
  {
    def: {
      id: 'win-menu-delay',
      name: 'Menu hiện tức thời (MenuShowDelay=0)',
      description: 'Đặt MenuShowDelay=0 để menu Start/menu chuột phải hiện ngay không trễ 400ms.',
      category: 'Hiệu năng',
      risk: 'low',
      requiresRoot: false,
      recommended: false,
      order: 29,
    },
    apply: () =>
      regAddValues(REG_DESKTOP, [{ name: 'MenuShowDelay', type: 'REG_SZ', data: '0' }], 'Đã đặt MenuShowDelay=0'),
    revert: () =>
      regAddValues(
        REG_DESKTOP,
        [{ name: 'MenuShowDelay', type: 'REG_SZ', data: '400' }],
        'Đã hoàn tác MenuShowDelay về 400ms (mặc định)',
      ),
  },
  {
    def: {
      id: 'win-widgets-off',
      name: 'Tắt Widgets/News trên taskbar',
      description: 'Đặt TaskbarDa=0 để tắt widget thời tiết/tin tức trên taskbar (Win11) — bớt process nền + RSS đọc tin.',
      category: 'Hiệu năng',
      risk: 'low',
      requiresRoot: false,
      recommended: false,
      order: 30,
    },
    apply: () =>
      regAddValues(REG_ADVANCED, [{ name: 'TaskbarDa', type: 'REG_DWORD', data: '0' }], 'Đã tắt Widgets trên taskbar'),
    revert: () =>
      regDeleteValues(REG_ADVANCED, ['TaskbarDa'], 'Đã xóa TaskbarDa — Widgets về trạng thái mặc định của Windows'),
  },
  {
    def: {
      id: 'win-copilot-off',
      name: 'Tắt Copilot (khỏi chạy nền AI)',
      description:
        'Đặt TurnOffWindowsCopilot=1 (policy) + ShowCopilotButton=0 để tắt Copilot khỏi taskbar — bớt tiến trình AI nền và traffic mạng.',
      category: 'Bảo mật & riêng tư',
      risk: 'low',
      requiresRoot: false,
      recommended: false,
      order: 31,
    },
    apply: () =>
      regAddValues(
        REG_COPRO,
        [{ name: 'TurnOffWindowsCopilot', type: 'REG_DWORD', data: '1' }],
        '',
      ).then(async (a) => {
        if (!a.success) return a
        const b = await regAddValues(
          REG_ADVANCED,
          [{ name: 'ShowCopilotButton', type: 'REG_DWORD', data: '0' }],
          '',
        )
        if (!b.success) return b
        return { success: true, message: 'Đã tắt Copilot (policy TurnOff + ẩn nút taskbar)' }
      }),
    revert: async () => {
      const a = await regDeleteValues(REG_COPRO, ['TurnOffWindowsCopilot'], '')
      const b = await regDeleteValues(REG_ADVANCED, ['ShowCopilotButton'], '')
      if (!a.success || !b.success) {
        const errs = [a.success ? null : a.message, b.success ? null : b.message].filter(Boolean).join(' | ')
        return { success: false, message: short(errs || 'Xóa giá trị Copilot thất bại') }
      }
      return { success: true, message: 'Đã xóa policy Copilot — Windows trở về mặc định' }
    },
  },
  {
    def: {
      id: 'win-background-apps-off',
      name: 'Tắt app chạy nền (UWP)',
      description:
        'Đặt GlobalUserDisabled=1 — chặn các app Microsoft Store chạy nền (lấy vị trí, thông báo, làm mới tile) để bớt ăn RAM/CPU.',
      category: 'Hiệu năng',
      risk: 'low',
      requiresRoot: false,
      recommended: false,
      order: 32,
    },
    apply: () =>
      regAddValues(
        REG_BGAPPS,
        [{ name: 'GlobalUserDisabled', type: 'REG_DWORD', data: '1' }],
        'Đã tắt app UWP chạy nền (GlobalUserDisabled=1)',
      ),
    revert: () =>
      regAddValues(
        REG_BGAPPS,
        [{ name: 'GlobalUserDisabled', type: 'REG_DWORD', data: '0' }],
        'Đã bật lại app chạy nền (mặc định)',
      ),
  },
  {
    def: {
      id: 'win-hibernation-off',
      name: 'Tắt hibernation (giải phóng hiberfil.sys)',
      description:
        'powercfg /hibernate off — xóa file hiberfil.sys lớn gần bằng RAM, giải phóng ổ đĩa đáng kể; đổi lại mất tính năng Hibernate/Windows Fast Startup.',
      category: 'Bộ nhớ',
      risk: 'medium',
      requiresRoot: true,
      recommended: false,
      order: 33,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const r = await runSysExe('powercfg.exe', ['/hibernate', 'off'], 30000)
      if (!r.ok) {
        return {
          success: false,
          message: short(
            `powercfg /hibernate off thất bại (exit ${r.code}): ${r.stderr || r.stdout || 'không rõ lý do'}`,
          ),
        }
      }
      return { success: true, message: 'Đã tắt hibernation — hiberfil.sys sẽ được giải phóng' }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const r = await runSysExe('powercfg.exe', ['/hibernate', 'on'], 30000)
      if (!r.ok) {
        return { success: false, message: short(`powercfg /hibernate on thất bại (exit ${r.code})`) }
      }
      return { success: true, message: 'Đã bật lại hibernation (mặc định)' }
    },
  },
  {
    def: {
      id: 'win-xbox-services-off',
      name: 'Tắt dịch vụ Xbox (không chơi Xbox/Game Bar)',
      description:
        'Disable + stop XblAuthManager, XblGameSave, XboxNetApiSvc, XboxGipSvc — bớt dịch vụ nền. CHỈ dùng khi không đăng nhập Xbox/Game Bar; muốn chơi game Xbox Store phải hoàn tác.',
      category: 'Gaming',
      risk: 'high',
      requiresRoot: true,
      recommended: false,
      order: 34,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const services = ['XblAuthManager', 'XblGameSave', 'XboxNetApiSvc', 'XboxGipSvc']
      const failed: string[] = []
      for (const s of services) {
        const cfg = await runSysExe('sc.exe', ['config', s, 'start=', 'disabled'], 20000)
        if (!cfg.ok && cfg.code !== 1060) failed.push(`${s} (config exit ${cfg.code})`)
        await runSysExe('sc.exe', ['stop', s], 20000) // lỗi stop được bỏ qua (1060/1062)
      }
      if (failed.length === services.length) {
        return { success: false, message: short(`Không tắt được dịch vụ Xbox nào: ${failed.join('; ')}`) }
      }
      if (failed.length > 0) {
        return {
          success: true,
          message: `Đã tắt dịch vụ Xbox (một số mục lỗi: ${failed.join('; ')} — có thể dịch vụ không tồn tại)`,
        }
      }
      return { success: true, message: `Đã tắt + disable ${services.length} dịch vụ Xbox` }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const services = ['XblAuthManager', 'XblGameSave', 'XboxNetApiSvc', 'XboxGipSvc']
      const failed: string[] = []
      for (const s of services) {
        const cfg = await runSysExe('sc.exe', ['config', s, 'start=', 'demand'], 20000)
        if (!cfg.ok && cfg.code !== 1060) failed.push(`${s} (exit ${cfg.code})`)
      }
      if (failed.length > 0) {
        return { success: false, message: short(`Hoàn tác dịch vụ Xbox lỗi tại: ${failed.join('; ')}`) }
      }
      return { success: true, message: 'Đã hoàn tác dịch vụ Xbox về start=demand (mặc định)' }
    },
  },
  {
    def: {
      id: 'win-mmcss-gaming',
      name: 'MMCSS: ưu tiên đa nhiệm cho Gaming',
      description:
        'Đặt task "Gaming" trong MMCSS: Priority=6, Scheduling Category=High, SFIO Priority=High — CPU/disk/network scheduler ưu tiên luồng audio/render của game hơn các dịch vụ nền.',
      category: 'Gaming',
      risk: 'medium',
      requiresRoot: true,
      recommended: false,
      order: 35,
    },
    apply: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regAddValues(
        REG_MMCSS_GAMING,
        [
          { name: 'Priority', type: 'REG_DWORD', data: '6' },
          { name: 'Scheduling Category', type: 'REG_SZ', data: 'High' },
          { name: 'SFIO Priority', type: 'REG_SZ', data: 'High' },
        ],
        'Đã đặt MMCSS Gaming task: Priority=6, Scheduling=High, SFIO=High',
      )
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      return regAddValues(
        REG_MMCSS_GAMING,
        [
          { name: 'Priority', type: 'REG_DWORD', data: '2' },
          { name: 'Scheduling Category', type: 'REG_SZ', data: 'Medium' },
          { name: 'SFIO Priority', type: 'REG_SZ', data: 'Normal' },
        ],
        'Đã hoàn tác MMCSS Gaming task về mặc định (2/Medium/Normal)',
      )
    },
  },
]

function findAction(id: string): TweakAction | undefined {
  return TWEAK_ACTIONS.find((a) => a.def.id === id)
}

/** Áp dụng 1 tinh chỉnh theo id — luôn upsert TweakState với kết quả trung thực */
export async function applyTweakById(id: string): Promise<TweakRunResult> {
  const action = findAction(id)
  if (!action) return { id, success: false, message: `Không tìm thấy tinh chỉnh "${id}"` }
  try {
    const r = await action.apply()
    await saveState(id, r.success, r.message)
    return { id, success: r.success, message: r.message }
  } catch (e) {
    const msg = `Lỗi khi áp dụng: ${(e as Error).message}`
    await saveState(id, false, msg)
    return { id, success: false, message: msg }
  }
}

/** Hoàn tác 1 tinh chỉnh theo id — luôn upsert applied:false theo đặc tả */
export async function revertTweakById(id: string): Promise<TweakRunResult> {
  const action = findAction(id)
  if (!action) return { id, success: false, message: `Không tìm thấy tinh chỉnh "${id}"` }
  try {
    const r = await action.revert()
    await saveState(id, false, r.message)
    return { id, success: r.success, message: r.message }
  } catch (e) {
    const msg = `Lỗi khi hoàn tác: ${(e as Error).message}`
    await saveState(id, false, msg)
    return { id, success: false, message: msg }
  }
}

/** Catalog gộp với trạng thái TweakState, sắp xếp theo order (khuyến nghị đứng trước) */
export async function getTweaks(): Promise<Tweak[]> {
  let rows: { id: string; applied: boolean; appliedAt: Date | null; lastResult: string | null }[] = []
  try {
    rows = await db.tweakState.findMany()
  } catch (e) {
    console.error('[tweaks] getTweaks', e)
  }
  const stateMap = new Map(rows.map((r) => [r.id, r]))
  return TWEAK_ACTIONS.map((a) => {
    const s = stateMap.get(a.def.id)
    return {
      ...a.def,
      applied: s?.applied ?? false,
      appliedAt: s?.appliedAt ? s.appliedAt.toISOString() : undefined,
      lastResult: s?.lastResult ?? undefined,
    }
  }).sort((x, y) => x.order - y.order)
}

/** Catalog đang hiệu lực theo nền tảng — findAction/applyTweakById/revertTweakById/getTweaks đều dùng catalog này */
export const TWEAK_ACTIONS: TweakAction[] = isWin ? TWEAK_ACTIONS_WIN : TWEAK_ACTIONS_LINUX
