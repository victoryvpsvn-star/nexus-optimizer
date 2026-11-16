// Kiểm tra tĩnh catalog NEXUS trên cả 2 nền tảng — chạy bằng bun (resolve @/ qua tsconfig)
import { TWEAK_ACTIONS_WIN, TWEAK_ACTIONS_LINUX } from '../src/lib/tweaks'
import { GAMING_PRESET_APPLY_WIN, GAMING_PRESET_REVERT_WIN } from '../src/lib/gaming'

let bad = 0
const err = (m: string) => {
  console.log('FAIL -', m)
  bad++
}
const ok = (m: string) => console.log('PASS -', m)

function audit(name: string, arr: typeof TWEAK_ACTIONS_WIN, expect: number) {
  console.log(`\n=== ${name} ===`)
  const n = arr.length
  if (n !== expect) err(`${name}: số lượng ${n} != ${expect}`)
  else ok(`${name}: ${n} mục`)
  const ids = arr.map((a) => a.def.id)
  if (new Set(ids).size !== n) err(`${name}: có id trùng`)
  else ok(`${name}: id unique`)
  const orders = arr.map((a) => a.def.order)
  if (new Set(orders).size !== n) err(`${name}: có order trùng`)
  else ok(`${name}: order unique`)
  for (const a of arr) {
    if (!a.apply || !a.revert) err(`${a.def.id}: thiếu apply/revert`)
    if (!['Hiệu năng', 'Mạng', 'Bộ nhớ', 'Bảo mật & riêng tư', 'Gaming'].includes(a.def.category))
      err(`${a.def.id}: category lạ "${a.def.category}"`)
    if (!['low', 'medium', 'high'].includes(a.def.risk)) err(`${a.def.id}: risk lạ`)
    if (!a.def.description || a.def.description.length < 20) err(`${a.def.id}: description quá ngắn`)
  }
  const rec = arr.filter((a) => a.def.recommended).length
  console.log(`${name}: recommended = ${rec}`)
}

audit('WINDOWS', TWEAK_ACTIONS_WIN, 35)
audit('LINUX', TWEAK_ACTIONS_LINUX, 18)

// Gaming preset phải trỏ tới id thật trong catalog Windows
const winIds = new Set(TWEAK_ACTIONS_WIN.map((a) => a.def.id))
for (const id of GAMING_PRESET_APPLY_WIN) if (!winIds.has(id)) err(`GAMING_PRESET_APPLY_WIN: id lạ "${id}"`)
for (const id of GAMING_PRESET_REVERT_WIN) if (!winIds.has(id)) err(`GAMING_PRESET_REVERT_WIN: id lạ "${id}"`)
ok(`Gaming preset WIN: apply ${GAMING_PRESET_APPLY_WIN.length} id + revert ${GAMING_PRESET_REVERT_WIN.length} id đều tồn tại trong catalog`)
// Mọi id apply phải có trong revert (để tắt gaming luôn dọn sạch)
const miss = GAMING_PRESET_APPLY_WIN.filter(
  (id) => !GAMING_PRESET_REVERT_WIN.includes(id) && !['win-ram-clean', 'win-flush-dns'].includes(id),
)
if (miss.length > 0) err(`Preset apply thiếu trong revert: ${miss.join(', ')}`)
else ok('Mọi id apply đều có trong revert (trừ 2 mục one-shot)')

console.log(bad === 0 ? '\n===== CATALOG OK =====' : `\n===== ${bad} LỖI =====`)
process.exit(bad === 0 ? 0 : 1)
