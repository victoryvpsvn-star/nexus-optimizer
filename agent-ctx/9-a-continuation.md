# Task 9-a — Continuation Agent (ENOENT fix + self-test + webhook + mới 19 tweak)

## Bối cảnh từ user
User chạy bản exe trên Windows và gặp lỗi hàng loạt: `Error: spawn powershell.exe ENOENT`
(Tắt Game DVR, Game Mode, fullscreen optimizations, gia tốc chuột...) và "Cần quyền
Administrator" (power plan, SystemResponsiveness, Network Throttling, SysMain, DiagTrack).
UI chưa ưng ý — agent sau có thể polish UI. Yêu cầu: chỉ EDIT, không xóa code cũ.

## NGUYÊN NHÂN GỐC (đã xác nhận bằng code)
1. `psRun()` spawn `'powershell.exe'` theo PATH → máy user (Windows đã tinh chỉnh sâu)
   không resolve được PowerShell → ENOENT với mọi tweak HKCU.
2. `isAdminWin()` chạy qua `psRun()` → spawn lỗi ⇒ trả `false` ⇒ mọi tweak requiresRoot
   bị báo nhầm "Cần quyền Administrator" dù lỗi thật là không thấy PowerShell.
   (2 hiện tượng = 1 gốc.)

## Đã sửa / thêm (không xóa gì)
1. **`src/lib/exec.ts`** (viết lại có chủ đích, giữ API cũ `run/psRun/isAdminWin/tryRoot`):
   - `resolvePowerShellExe()`: NEXUS_PS_OVERRIDE → tuyệt đối System32\WindowsPowerShell\v1.0
     → ProgramFiles\PowerShell\7\pwsh.exe → where.exe (đường dẫn tuyệt đối) → bare PATH.
     Cache kết quả tìm thấy. Đầu vào của `psRun` giờ là đường dẫn tuyệt đối.
   - `winSysDir()` + `findSysExe(name)`: tìm exe trong System32/Sysnative theo đường dẫn tuyệt đối.
   - `runExe(absPath, args)` + `runSysExe(name, args)`: spawn TRỰC TIẾP không shell, không PATH.
   - `getWinStatus()`: {psFound, psPath, admin, adminMethod, regOk} — quyền Admin kiểm tra bằng
     GHI THỬ HKLM\SOFTWARE\NexusOptimizer qua reg.exe rồi xóa probe (không phụ thuộc PowerShell);
     cache 15s. `isAdminWin()` giữ tương thích (bọc getWinStatus).
2. **`src/lib/tweaks.ts`**: `regAddValues/regDeleteValues` chạy reg.exe trực tiếp bằng EXIT CODE
   (locale-free — không parse thông báo localize; missing value khi revert không phải lỗi);
   powercfg/sc.exe/ipconfig/bcdedit chạy trực tiếp qua `runSysExe`; win-nagle/win-startup-delay
   bỏ PS; `adminGate()` dùng getWinStatus + thêm hint nút nâng quyền. **THÊM 19 TWEAK mới**
   (order 17–35, tổng catalog Windows = 35): win-cpu-priority-separation, win-cpu-core-parking-off,
   win-cpu-dynamic-tick-off (bcdedit), win-gpu-hwsch-on (HAGS), win-gpu-tdr-delay,
   win-ram-standby-clear (NtSetSystemInformation purge standby — cần PS + Admin),
   win-ram-compression-off (Disable-MMAgent), win-keyboard-fast, win-keyboard-accessibility-off,
   win-net-llmnr-off, win-net-netbios-off, win-smb1-off, win-menu-delay, win-widgets-off,
   win-copilot-off, win-background-apps-off, win-hibernation-off, win-xbox-services-off,
   win-mmcss-gaming. Export thêm `TWEAK_ACTIONS_WIN`/`TWEAK_ACTIONS_LINUX` để test.
3. **`src/lib/gaming.ts`**: preset Gaming Windows mở rộng (17 id apply / 18 id revert), export 2 preset.
4. **`src/lib/selftest.ts` (mới)**: runSelftest(mode check|full, useWebhook) — check: db/catalog/
   PowerShell/Admin/reg + capability từng tweak (dep map `tweakDeps()`); full: apply→revert từng
   tweak (Linux = skipped trung thực); `sendWebhookReport()` POST embed Discord (che URL webhook);
   webhook đọc Setting key `selftestWebhookUrl` (do user dán trong app) hoặc env `DISCORD_WEBHOOK_URL`;
   chỉ nhận domain discord.com/discordapp.com (regex DISCORD_WEBHOOK_RE).
5. **`src/app/api/selftest/route.ts` (mới)**: GET trạng thái, PUT webhook (validate+mask), POST chạy test.
6. **`src/app/api/system/route.ts` (mới)**: GET trạng thái quyền; POST relaunch-admin: ghi flag
   `relaunch-elevated.flag` vào NEXUS_DATA_DIR → spawn PS detached (`Start-Sleep 3; Start-Process
   -Verb RunAs`) → server exit(0) sau 1.5s. Windows-only, có guard trung thực.
7. **`electron/main.js`**: thêm env `NEXUS_EXE` cho server; serverProc exit code 0 → nếu có flag
   mới (<60s) thì app.quit() im lặng (PS detached sẽ mở lại app elevated qua UAC); code != 0 giữ
   error box như cũ.
8. **UI**: `types.ts` + 'selftest' vào SECTIONS/SECTION_META; sidebar thêm mục "Tự kiểm tra"
   (FlaskConical); `page.tsx` render `selftest-panel.tsx` (mới): card trạng thái (PS/Admin/reg.exe/
   catalog), nút check/full (AlertDialog xác nhận), Switch gửi Discord, input webhook + save,
   nút "Chạy lại với quyền Admin", danh sách kết quả per-item.
9. **eslint.config.mjs**: thêm "electron/**" vào ignores (main.js là CommonJS của Electron —
   lỗi no-require-imports là pre-existing từ HEAD).

## Verification (đã chạy thật trong sandbox Linux, dev server :3000)
- `bunx tsc --noEmit`: 0 lỗi ở src/** (còn examples/websocket thiếu socket.io — pre-existing).
- `bun run lint`: 0 lỗi 0 warning.
- `bun scripts/audit-catalog.ts`: WIN 35 mục + LINUX 18 mục, id/order unique, category/risk hợp lệ,
  gaming preset 17 apply + 18 revert đều khớp id, mọi id apply có trong revert (trừ 2 one-shot).
- Smoke test API 19/19 PASS (`/home/z/my-project/scripts/nexus_smoke.py` bên ngoài repo):
  GET / + /api/stats + /api/tweaks (18) + apply tmp-clean OK + drop-caches thất bại TRUNG THỰC
  (không sudo) + GET /api/system + relaunch-admin trên Linux → 400 trung thực + GET /api/selftest +
  PUT webhook domain lạ → 400 + PUT webhook hợp lệ (masked) + POST check + **webhook Discord
  gửi OK (HTTP 204)** + full mode skipped trung thực trên Linux + gaming on/off.
- `npm run build:win` (next build + post-build + stage-electron với DB template ở build/nexus.db):
  OK — 2 route mới đăng ký trong bảng ƒ.

## Chưa làm / cần agent sau
- **Chưa test được trên MÁY WINDOWS THẬT** (sandbox chỉ là Linux): cần user tải exe từ Actions
  chạy thử — đặc biệt kiểm tra: resolvePowerShellExe trên máy lỗi ENOENT, admin-gate sau khi bấm
  nút nâng quyền, 19 tweak mới apply/revert, full self-test gửi webhook.
- UI panel Tự kiểm tra viết gọn còn thô — user nói "ui chưa oke": có thể polish (gauge màu,
  animation, collapse nhóm lỗi...).
- Có thể thêm nữa: tweak Windows Update (defer), Store apps debloat (chỉ qua PowerShell Get-AppxPackage
  — cân nhắc an toàn), tray icon Electron, auto-start với Windows, dark/light toggle riêng.
- Nếu user vẫn ENOENT: kiểm tra NEXUS_PS_OVERRIDE + xem self-test runtime card sẽ báo chính xác
  psPath/psDetail (không còn mù mờ).

## Lưu ý vận hành
- Webhook Discord: KHÔNG hardcode vào repo — user dán vào UI (lưu Setting selftestWebhookUrl) hoặc
  set env DISCORD_WEBHOOK_URL. Masked hiển thị dạng .../webhooks/1234…5678/***xxxx.
- selftest full mode CHỈ chạy trên Windows; trên Linux trả skipped trung thực.
- regDeleteValues/Query dựa vào exit code của reg.exe (locale-free) — KHÔNG parse text localize.
