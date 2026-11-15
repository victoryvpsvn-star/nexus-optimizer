// Catalog tinh chỉnh (Tweaks) — xếp hạng theo độ tác động, chuẩn Chris Titus WinUtil style
// Linux: mọi tinh chỉnh root đều dùng tryRoot() — KHÔNG giả lập thành công khi thiếu sudo.
// Windows: TWEAK_ACTIONS_WIN chạy qua PowerShell (psRun) với reg.exe/sc.exe/powercfg/ipconfig;
// các mục requiresRoot bị chặn TRƯỚC khi chạy nếu thiếu quyền Administrator (adminGate).

import fs from 'fs/promises'
import { db } from '@/lib/db'
import { run, tryRoot, psRun, isWin, isAdminWin } from '@/lib/exec'
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

const ADMIN_FAIL = 'Cần quyền Administrator — hãy chạy NEXUS Optimizer với quyền Admin'

/**
 * Cổng quyền Administrator cho các mục requiresRoot trên Windows: chặn TRƯỚC khi chạy
 * bất kỳ lệnh nào nếu thiếu quyền — không bao giờ chạy nửa vời hay giả lập thành công.
 */
async function adminGate(): Promise<TweakActionResult | null> {
  if (!isWin) return null
  const admin = await isAdminWin()
  if (!admin) return { success: false, message: ADMIN_FAIL }
  return null
}

/** Chuỗi an toàn nhúng vào script PowerShell: single-quoted literal, escape ' thành '' */
function psStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

interface RegValue {
  name: string
  type: 'REG_DWORD' | 'REG_SZ'
  data: string
}

/** reg.exe add lần lượt từng giá trị — thoát với exit code thật ngay khi một lệnh lỗi */
async function regAddValues(key: string, values: RegValue[], okMsg: string): Promise<TweakActionResult> {
  const k = psStr(key)
  const script =
    values
      .map(
        (v) =>
          `reg.exe add ${k} /v ${v.name} /t ${v.type} /d ${v.data} /f | Out-Null\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
      )
      .join('\n') + '\nexit $LASTEXITCODE'
  const r = await psRun(script, 30000)
  if (!r.ok) return { success: false, message: short(r.stderr || r.stdout || 'reg.exe add thất bại') }
  return { success: true, message: okMsg }
}

/**
 * Xóa nhiều giá trị registry trong cùng key — dùng PowerShell registry provider
 * (Get-ItemProperty + Remove-ItemProperty) thay vì reg.exe delete, vì:
 * - reg.exe bị LOCALIZED: trên Windows vi-VN thông báo "unable to find" là tiếng Việt
 *   → không match được regex, revert giá trị chưa từng set bị báo lỗi ầm ĩ.
 * - Per-value honesty: kiểm tra tồn tại trước khi xóa; thiếu → đếm missing (không phải lỗi);
 *   Remove-ItemProperty -ErrorAction Stop → lỗi thật (Access denied...) vẫn thất bại trung thực.
 */
async function regDeleteValues(key: string, names: string[], okMsg: string): Promise<TweakActionResult> {
  const k = psStr(key)
  const script =
    '$missing = 0\n' +
    '$failed = 0\n' +
    `$props = (Get-ItemProperty -LiteralPath ${k} -ErrorAction SilentlyContinue)\n` +
    'foreach ($n in @(' + names.map((n) => `'${n.replace(/'/g, "''")}'`).join(',') + ')) {\n' +
    '  if ($null -eq $props -or -not ($props.PSObject.Properties.Name -contains $n)) { $missing++; continue }\n' +
    '  try {\n' +
    '    Remove-ItemProperty -LiteralPath ' + k + ' -Name $n -ErrorAction Stop\n' +
    '  } catch {\n' +
    '    $failed++\n' +
    '    Write-Output $_.Exception.Message\n' +
    '  }\n' +
    '}\n' +
    'if ($failed -gt 0) { exit 1 }\n' +
    'exit 0'
  const r = await psRun(script, 30000)
  if (!r.ok) {
    return { success: false, message: short(r.stderr || r.stdout || 'Xóa giá trị registry thất bại') }
  }
  // Giá trị không tồn tại cũng là kết quả hợp lệ của revert (đã ở trạng thái mặc định)
  return { success: true, message: okMsg }
}

const TWEAK_ACTIONS_LINUX: TweakAction[] = [
  {
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
const PS_SERIALIZE = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize'
const REG_CDM = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager'

const TWEAK_ACTIONS_WIN: TweakAction[] = [
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
      const direct = await psRun(
        'powercfg.exe /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c\nexit $LASTEXITCODE',
        60000,
      )
      if (direct.ok) {
        return { success: true, message: 'Đã bật kế hoạch nguồn Hiệu năng cao (High performance)' }
      }
      const dup = await psRun(
        `$out = powercfg.exe -duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$m = [regex]::Match(($out -join ' '), '[0-9a-f-]{36}')
if (-not $m.Success) { Write-Output 'NoGuid'; exit 1 }
powercfg.exe /setactive $m.Value
exit $LASTEXITCODE`,
        60000,
      )
      if (!dup.ok) {
        return {
          success: false,
          message: short(dup.stderr || dup.stdout || direct.stderr || 'Không bật được kế hoạch nguồn Hiệu năng cao'),
        }
      }
      return { success: true, message: 'Đã tạo mới và bật kế hoạch nguồn Hiệu năng cao (nhân bản từ mẫu ẩn)' }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const r = await psRun(
        'powercfg.exe /setactive 381b4222-f694-41f0-9685-ff5bb260df2e\nexit $LASTEXITCODE',
        60000,
      )
      if (!r.ok) {
        return { success: false, message: short(r.stderr || r.stdout || 'Không hoàn tác được kế hoạch nguồn') }
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
      const r = await psRun(
        `$base = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces'
$keys = Get-ChildItem -Path $base -ErrorAction SilentlyContinue
if (-not $keys -or @($keys).Count -eq 0) { Write-Output 'NoNic'; exit 1 }
$n = 0
foreach ($k in @($keys)) {
  try {
    New-ItemProperty -Path $k.PSPath -Name TcpAckFrequency -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
    New-ItemProperty -Path $k.PSPath -Name TCPNoDelay -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
    $n++
  } catch { }
}
Write-Output "set=$n"
if ($n -eq 0) { exit 1 }
exit 0`,
        60000,
      )
      if (!r.ok) {
        return {
          success: false,
          message: short(r.stderr || r.stdout || 'Không đặt được TcpAckFrequency/TCPNoDelay trên interface nào'),
        }
      }
      const n = r.stdout.match(/set=(\d+)/)?.[1]
      return {
        success: true,
        message: n
          ? `Đã tắt Nagle trên ${n} interface mạng (TcpAckFrequency=1 + TCPNoDelay=1)`
          : 'Đã tắt Nagle trên các interface mạng',
      }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const r = await psRun(
        `$base = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces'
$keys = Get-ChildItem -Path $base -ErrorAction SilentlyContinue
if (-not $keys) { Write-Output 'NoNic'; exit 0 }
foreach ($k in @($keys)) {
  Remove-ItemProperty -Path $k.PSPath -Name TcpAckFrequency -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $k.PSPath -Name TCPNoDelay -ErrorAction SilentlyContinue
}
Write-Output 'cleaned'
exit 0`,
        60000,
      )
      if (!r.ok) {
        return { success: false, message: short(r.stderr || 'Không xóa được giá trị Nagle trên các interface') }
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
      const r = await psRun(
        `New-Item -Path ${psStr(PS_SERIALIZE)} -Force | Out-Null
reg.exe add ${psStr(REG_SERIALIZE)} /v StartupDelayInMSec /t REG_DWORD /d 0 /f | Out-Null
exit $LASTEXITCODE`,
        30000,
      )
      if (!r.ok) return { success: false, message: short(r.stderr || 'Không đặt được StartupDelayInMSec=0') }
      return { success: true, message: 'Đã đặt StartupDelayInMSec=0 — app khởi động không bị trì hoãn' }
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
      const r = await psRun('ipconfig.exe /flushdns | Out-Null\nexit $LASTEXITCODE', 30000)
      if (!r.ok) return { success: false, message: short(r.stderr || 'ipconfig /flushdns thất bại') }
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
      const r = await psRun(
        `sc.exe stop SysMain | Out-Null
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1062) { exit $LASTEXITCODE }
sc.exe config SysMain start= disabled | Out-Null
exit $LASTEXITCODE`,
        30000,
      )
      if (!r.ok) return { success: false, message: short(r.stderr || r.stdout || 'Không tắt được dịch vụ SysMain') }
      return { success: true, message: 'Đã tắt dịch vụ SysMain (Superfetch) — start=disabled' }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const r = await psRun(
        `sc.exe config SysMain start= auto | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
sc.exe start SysMain | Out-Null
exit 0`,
        30000,
      )
      if (!r.ok) return { success: false, message: short(r.stderr || r.stdout || 'Không hoàn tác được dịch vụ SysMain') }
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
      const r = await psRun(
        `sc.exe config DiagTrack start= disabled | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
sc.exe config dmwappushservice start= disabled | Out-Null
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1060) { exit $LASTEXITCODE }
sc.exe stop DiagTrack | Out-Null
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1062) { exit $LASTEXITCODE }
sc.exe stop dmwappushservice | Out-Null
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1060 -and $LASTEXITCODE -ne 1062) { exit $LASTEXITCODE }
exit 0`,
        30000,
      )
      if (!r.ok) return { success: false, message: short(r.stderr || r.stdout || 'Không tắt được dịch vụ telemetry') }
      return { success: true, message: 'Đã tắt telemetry: DiagTrack + dmwappushservice (start=disabled)' }
    },
    revert: async () => {
      const gate = await adminGate()
      if (gate) return gate
      const r = await psRun(
        `sc.exe config DiagTrack start= auto | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
sc.exe config dmwappushservice start= demand | Out-Null
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1060) { exit $LASTEXITCODE }
exit 0`,
        30000,
      )
      if (!r.ok) {
        return { success: false, message: short(r.stderr || r.stdout || 'Không hoàn tác được dịch vụ telemetry') }
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
