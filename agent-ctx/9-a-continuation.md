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

## Bổ sung 9-b: fix "Server nội bộ không trả lời sau 45 giây — cổng 32123" (main.js)
- User screenshot lỗi khởi động Electron: server nội bộ không bind/đáp ứng được cổng 32123.
  Chẩn đoán khả năng cao nhất: tiến trình NEXUS cũ bị kill mạnh (Task Manager/đóng app khi đang
  lỗi đợt trước) còn chạy nền giữ cổng → server mới bị EADDRINUSE, ready-check không bao giờ thấy
  phản hồi. (Cổng 32123 là cổng nội bộ 127.0.0.1 của app — không phải thứ user cần cấu hình.)
- main.js giờ: (1) `sweepZombieServers()` quét Win32_Process Name LIKE 'NEXUS%' + CommandLine có
  'server.js' và pid khác mình → Stop-Process (best-effort qua PowerShell, fail thì bỏ qua);
  (2) `pickPort()` bind-test 32123..32132 chọn cổng trống → PORT/BASE_URL động; (3) output server
  ghi vào `%APPDATA%/NEXUS Optimizer/data/server.log` + ring buffer `srvTail`; (4) dialog lỗi
  khởi động/server-chết giờ kèm 8 dòng output cuối của server + đường dẫn log đầy đủ;
  (5) waitReady 45s→75s, poll 500ms→400ms (chống AV quét chậm lần đầu chạy exe mới);
  (6) `node --check` main.js OK, `npm run build:win` OK (post-build + stage-electron).
- LƯU Ý: dialog "45 giây" trong screenshot có thể là bản CŨ đang cài trên máy (v4/v5/v6 đều dùng
  text cũ) — user cần cài/chạy lại bản ≥ v7; bản mới tự dọn cổng nên không cần can thiệp tay.

## Bổ sung 9-c: Go edition — viết lại toàn bộ app (nexus-go/)
- User feedback: bản Electron vẫn lỗi khởi động + mở RẤT LÂU (portable 140MB giải nén mỗi lần + AV
  quét node_modules). User yêu cầu Rust/Tauri/Go. Chọn GO (lý do): build + verify được ngay trong
  sandbox Linux (cross-compile GOOS=windows — thuần Go, không CGO), Rust/Tauri phải build mù trên CI.
- Kiến trúc MỚI (nexus-go/): 1 tiến trình duy nhất — HTTP server bind `127.0.0.1:0` (cổng trống do
  OS cấp → HẾT lỗi kẹt cổng/zombie 32123), UI tĩnh nhúng (embed.FS), cửa sổ WebView2 qua
  jchv/go-webview2 (thuần Go), fallback mở browser nếu thiếu runtime WebView2. Exe ~8.9MB
  (-ldflags "-s -w -H windowsgui"). Cờ: --web (chế độ web), --port N (cố định cổng).
- Thư mục module: nexus-go/ trong repo. Deps: shirou/gopsutil/v4 (stats — thay toàn bộ PowerShell
  sysinfo), jchv/go-webview2. GOATH cache trong sandbox: /home/z/my-project/.tools (go1.27.4).
- File: main.go (entry+dataDir), store.go (config.json nguyên tử thay Prisma: settings/webhook/
  tweakStates/gaming/cleanupLogs/scripts), exec.go (port exec.ts: runExe/runSysExe/psRun BOM UTF-8/
  resolvePowerShellExe/getWinStatus HKLM probe/adminGate), tweaks.go (35 tweaks WIN port 1:1 —
  id/name/description/message giữ nguyên), ram.go (EmptyWorkingSet + NtSetSystemInformation standby
  purge), stats.go (stats/processes/kill taskkill /T /F/network ports qua gopsutil), cleanup.go
  (11 target Windows, đo size bằng Go WalkDir thay PS, recyclebin/deliveryopt qua PS), gaming.go
  (preset apply/revert), selftest.go (check/full + Discord embed như cũ), system.go (relaunch-admin
  Start-Process -Verb RunAs; backup registry .reg 20 key), script.go (powershell/bash/python + 
  screenshots), api.go (mux cùng đường dẫn API cũ + static), ui_windows.go / ui_other.go (build tags).
- UI mới: static/index.html + style.css + app.js — vanilla JS SPA dark theme, cùng sections
  (overview/cleanup/gaming/tweaks/processes/network/script/selftest/screenshot/backup/settings).
- VERIFY trong sandbox: go vet OK; linux build OK; GOOS=windows build OK (8.9MB); smoke test curl:
  35 tweaks unique ids/orders, stats/gaming/network/settings OK, apply tweak trên Linux trả lỗi
  trung thực "Không tìm thấy reg.exe", selftest check: pass 2 / skip 36 / ok=true (trung thực),
  UI 200 cho index/app.js/style.css, config.json persist đúng.
- CI: .github/workflows/build-go.yml — ubuntu-latest (go vet + linux build + GOOS=windows exe),
  release tag `go-v<run_number>` khi workflow_dispatch. Bản Electron cũ vẫn giữ ở win-x64-v*.
- Cleanup target filePattern (thumbcache) + browser cache (Default|Profile N → Cache/Code Cache/
  GPUCache) port đúng từ cleanup.ts. RAM_NOTE/gaming note giữ nguyên text.


## Bổ sung 10-a: Go edition v2 — fit màn hình + 215 tweaks
- User feedback: cửa sổ 1440x920 fixed → laptop màn nhỏ bị thanh tiêu đề văng khỏi màn (không bấm
  được X, phải Task Manager). Fix: ui_windows.go thêm screenMetrics() (user32 GetSystemMetrics) +
  fitToScreen() — cap w=min(1360, sw-24), h=min(860, sh-72), min 640x480, + SetSize sau khi tạo.
  Sidebar overflow-y:auto.
- Catalog mở rộng 35 → 215: tweaks_table.go (framework step + Bảo mật & riêng tư 34 + Bloatware 44)
  và tweaks_table2.go (Dịch vụ 50 + Hiệu năng 19 + Gaming 2 + Mạng 4 + Giao diện 27). Data-driven:
  step {reg add/del, reg key ve, sc config (+stop/start), powercfg setacvalueindex, schtasks
  Query+Change, appx Get-AppxPackage Remove/re-register, ps, exe}. runSteps tuần tự, fail dừng
  ngay với message trung thực; sc 1060/missing-task = bỏ qua hợp lệ; appx revert thử AllUsers rồi
  per-user, hết package → lỗi trung thực kèm hướng dẫn cài Store.
- Mọi key/lệnh đều thật (WinUtil style): AllowTelemetry, Siuf, SQM CEIP, AppCompat AIT, WER,
  Tailored, AdvertisingID, ActivityFeed, WiFi Sense, OnlineSpeech, InputPersonalization,
  DisableSearchBoxSuggestions, BingSearchEnabled, AllowCortana, DisableLocation, FindMyDevice,
  DisableAIDataAnalysis (Recall 24H2), Clipboard history/cloud, Device Metadata, CDM 353698/
  SilentInstalled/SoftLanding/RotatingLockSpotlight, 6 schtasks telemetry, NvTelemetryContainer,
  NoDriveTypeAutoRun, RunAsPPL, fAllowToGetHelp, FeatureSettingsOverride (Spectre), SMB guest/
  mrxsmb10, EnableMDNS; 44 appx (3DBuilder→Realtek); 50 dịch vụ (WSearch/Spooler/BT/biometric/
  geo/RemoteRegistry/WerSvc/MapsBroker/RetailDemo/Phone/Tapi/WpcMon/PcaSvc/TrkWks/wisvc/Wpn/DoSvc/
  Wdi x2/stisvc/TabSvc/SCardSvr/SCPolicy/SNMPTrap/Hyper-V x2/RemoteAccess/Wecsvc/Netlogon/WwanSvc/
  UPnP/CDP+CDPUserSvc(reg)/DPS/EmbeddedMode/fhsvc/iphlpsvc/MSiSCSI/PNRP x3/QWAVE/WebClient/WinRM/
  RpcLocator/Sensors/MSDTC/WorkFolders/EntAppSvc/defragsvc/SmsRouter/LanmanServer); perf (Ultimate
  plan, USB suspend, PROCTHROTTLEMIN, Hiberboot, SvchostSplitThreshold, NtfsMemoryUsage, 8dot3,
  fsutil lastaccess, GlobalTimerResolutionRequests, CompactOS, Reserved Storage DISM, ForegroundLock,
  WaitToKill, bcdedit timeout, CrashDump/AutoReboot, NoAutoReboot/ExcludeWUDrivers/Store AutoDownload);
  net (Tcpip6 DisabledComponents=32, netsh timestamps/rsc/autotune-normal); UI (classic menu CLSID
  86ca1aa0, dark x2, TaskView, TaskbarMn, SearchboxTaskbarMode x2 key, TaskbarAl, HideFileExt,
  ShowSeconds, Feeds ShellFeedsTaskbarViewMode, SearchSettings IsDynamicSearchBox,
  Start_IrisRecommendations, Start_TrackDocs, Start_TrackProgs, ShowSyncProviderNotifications,
  LaunchTo, MinAnimate, InitialKeyboardIndicators, Spotlight CloudContent policy, DisableThumbnailCache,
  HideSCAMeetNow, ShowPeopleBand, MouseHoverTime, ẩn 3D Objects/Gallery khỏi This PC, OneDrive pin
  CLSID 018D5C66, restart Explorer).
- Merge: categoryOrder 8 nhóm → đánh order liên tục 1..215; tableMap id→steps để selftest suy deps
  (deriveTableDeps: reg/sc/powercfg/schtasks/exe theo Args[0]; appx/ps → needsPs).
- UI: filter chips sinh động đếm theo nhóm (renderTweakFilters); sidebar scroll.
- Verify: go vet OK; linux build OK; exe Windows 9.16MB; smoke test: 215 tweaks, order 1..215,
  unique ids, apply trên Linux báo lỗi trung thực 3 loại (reg/PS/adminGate), selftest 2 pass +
  216 skip đúng, deps suy đúng cho từng loại step.
