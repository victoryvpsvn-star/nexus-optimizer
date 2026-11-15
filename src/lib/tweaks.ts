// Catalog tinh chỉnh (Tweaks) — xếp hạng theo độ tác động, chuẩn Chris Titus WinUtil style
// Mọi tinh chỉnh root đều dùng tryRoot() — KHÔNG giả lập thành công khi thiếu sudo.

import fs from 'fs/promises'
import { db } from '@/lib/db'
import { run, tryRoot } from '@/lib/exec'
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

export const TWEAK_ACTIONS: TweakAction[] = [
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
