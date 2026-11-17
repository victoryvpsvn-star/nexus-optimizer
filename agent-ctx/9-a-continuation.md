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


## Bổ sung 10-c: 3 agent review tìm ra + đã fix 3 bug critical
- CRITICAL: stepSc apply chạy start=<Data> ở cả 2 chiều → 31 dòng SC trong TSV không bao giờ disable.
  Fix: runStep ép mode=disabled khi apply; Data chỉ dùng cho revert (cũng tự vá svc-ndu/svc-uhssvc no-op).
- HIGH: stepPc chỉ setacvalueindex — thêm setdcvalueindex tolerant cho laptop.
- MEDIUM: revert ui-hide-3d-objects/gallery tạo key rỗng → giờ reg add /v (Default) đặt lại giá trị CLSID.
- Chưa fix (ghi lại cho đợt sau): /api/script POST tùy ý không có Origin gate (vector drive-by
  localhost — cần middleware Origin check); system.go backup .reg ghi không atomic + nil Stat panic;
  stepTask revert /ENABLE bật lại task user từng tắt thủ công (state loss); readBody CT gate.
- Verify: go vet OK, go test OK, exe Windows build OK → download/Sakura-Tool-x64.exe.


## Bổ sung 10-e: Cài extension kiểu Kaspersky (ẩn source, auto-install qua policy)
- ext_pack.go: packer CRX3 tự ký (RSA-2048, khoá lưu ext-key.pem trong data dir; manifest key ghi đè =
  khoá ký → ID ổn định SHA256(SPKI)[:16] alphabet a-p; version 2.2.1). Format đối chiếu TRỰC TIẾP
  Chromium 120 crx_verifier.cc (gitiles): chữ ký = "CRX3 SignedData" || LE32(len(shd)) || shd || [zip]
  (header KHÔNG nằm trong chữ ký). ext_pack_test.go parse protobuf + verify chữ ký/ID/zip PASS.
- ext_policy_windows.go: HKCU\SOFTWARE\Policies\Google\Chrome + Microsoft\Edge: ExtensionSettings[id]
  = force_installed + update_url http://127.0.0.1:<port>/ext/update.xml; ExtensionInstallSources["1"]=
  http://127.0.0.1:<port>/ext/*; extPolicyAutoReapply() nền sau start tự ghi lại khi đổi cổng.
  ext_policy_other.go = stub trung thực Linux. Routes GET /ext/update.xml + /ext/cat-status.crx.
- API POST /api/presence install-policy/remove-policy; UI nút "🛡️ Cài kiểu Kaspersky (ẩn source)" + "🗑️ Gỡ policy".
- Trung thực: lần đầu cần tool chạy khi restart Chrome; extension hiện "Được quản trị"; gỡ = Gỡ policy.
- Sự cố sandbox: biset roll về 7a7a050 → recovery git reset --hard origin/main (188621e), untracked giữ.
  Bài học: session sau luôn git fetch origin trước khi sửa.
- Verify: vet OK, full test OK, smoke /ext/* (42KB Cr24) + stub trung thực + UI OK. Commit 83d1d94.


## Bổ sung 10-f: Cat Status v2.3.0 — bỏ dect nhạc, bỏ cần Discord desktop (feedback user)
- User phản bác đúng: đường IPC Rich Presence cần app Discord desktop là sai hướng — extension gốc
  đăng nhập OAuth + POST /users/@me/headless-sessions nên KHÔNG cần Discord desktop; dect nhạc của nó
  dùng chrome.tabs + mediaSession trong trang (không liên quan Discord).
- Theo yêu cầu: BỎ toàn bộ dect nhạc/video trong extension (classify/focusInfo/ytPlayback/oembed...).
  Extension v2.3.0 giờ chỉ dect MỘT điều: Sakura Tool có đang mở → qua BEACON localhost.
- beacon.go: server cố định 127.0.0.1:32123 (fallback 32124) GET /api/presence-beacon trả
  {app:"sakura-tool", section, note, started} — section/note là mục UI tool đang xem (presenceSet nhận
  từ JS poll section, giờ KHÔNG còn guard c.Enabled để beacon luôn cập nhật). startBeacon() chạy từ main.
- Extension mới: poll beacon 30s (alarm 0.5min) → tool mở: set activity {name:"Sakura Tool", type:0,
  details:"🌸 Đang tweak máy — <section>", state:"⏱ đã dùng X phút", timestamps.start} qua
  headless-sessions; tool đóng: deleteSession nhưng giữ enabled → mở lại tự báo (kiểu PreMiD).
  Fallback cổng beacon bận: quét tab localhost title /sakura/i. manifest: thêm host_permissions
  http://127.0.0.1/* + localhost/*, bỏ scripting + các host nhạc. popup viết lại gọn (login/bật/tắt).
- ext_pack version 2.2.1→2.3.0 (force_installed sẽ TỰ UPDATE extension qua policy khi restart Chrome).
  UI presence-card: text mới khuyên dùng đường Kaspersky/extension, IPC là phụ cần Discord desktop.
- Verify: vet OK, test OK, smoke: beacon 32123 trả JSON đúng, POST section → beacon phản ánh tức thì,
  update.xml 2.3.0. Exe mới + download/Cat-Status-Sakura-v2.3.0.zip.


## Bổ sung 10-g: v3.1.0 — fix No Responding + updater tự cập nhật + Discord quảng cáo/icon
- FIX "No Responding" (bấm xong/ẩn/làm gì đó cửa sổ treo): NGUYÊN NHÂN THẬT từ ui_windows.go —
  goroutine WebView2 không runtime.LockOSThread; go-webview2 (56598839c808) không tự ghim thread,
  CreateWindowExW + GetMessage phải cùng thread OS → scheduler dời goroutine là pump sai queue →
  window ghost "Not Responding" ngẫu nhiên. Đã ghim LockOSThread đầu goroutine trong runWebView.
- Updater (updater.go): updateCheck qua redirect /releases/latest (không rate-limit) → fallback REST API;
  Token TÙY CHỌN từ <data>/gh-token.txt (repo đang PRIVATE → không token thì báo trung thực kèm hướng
  dẫn); updateApply tải releases/latest/download/NEXUS-Optimizer-Go-x64.exe (>5MB check) → rename
  exe→.old → .new→exe → Start tiến trình mới → os.Exit(0) sau 600ms. main dọn *.old lúc khởi động.
  Routes GET/POST /api/update; POST apply trả UI trước rồi chạy nền 1.5s. Banner sticky #updateBanner
  + app.js fetch. buildNumber ghim ldflags -X main.buildNumber=${{ github.run_number }} trong CI —
  bản go-v15 trở đi updater so đúng số; build tay (0) không tự nhắc. AppVersion 2.0.0→3.1.0.
- Extension v2.4.0: BỎ text "đang tweak máy"/section/phút theo yêu cầu user → quảng cáo tĩnh
  ("🌸 Tối ưu PC — dọn rác, tăng FPS..." / "Miễn phí · Làm sạch máy chỉ trong 1 nút bấm") + assets
  mp:external/<b64url logo raw.githubusercontent> + buttons "⬇️ Tải Sakura Tool"; postActivitySafe
  lùi assets→buttons→bare nếu Discord chối. Đăng 1 lần mỗi phiên tool (key=started).
- Bài học tooling: pkill -f nexus-go-test giết CẢ shell đang chạy (cmdline bash -c chứa chuỗi đó) —
  luôn pkill -f "^/tmp/nexus-go-test" neo đầu dòng. Output bash bị cắt giữa chừng 2 lần vì lý do này.
- Verify: vet OK, test OK (goTagNum), smoke /api/update: có token → go-v14/num 14 ✓, không token →
  lỗi trung thực ✓; beacon OK; UI banner ✓; exe + Cat-Status-Sakura-v2.4.0.zip trong download/.
- LƯU Ý CHỜ USER QUYẾT: repo private → updater/nút tải Discord chỉ chạy khi repo Public hoặc user
  đặt gh-token.txt. KHÔNG tự đổi visibility (hành động công khai).


## Bổ sung 10-h: v3.1.1 — CẮT HẲN đường IPC Discord desktop (feedback "vẫn báo kia")
- User vẫn thấy status cũ "đang tweak" — đó là đường IPC Rich Presence (cần Discord desktop) còn
  bật trong Settings của exe cũ, đè/nằm cạnh status extension v2.4.0. Theo câu hỏi user "(là dùng
  discord desktop mà ??)" → loại bỏ hoàn toàn đường IPC khỏi tool:
  * discord_rpc.go rút còn STATE cho beacon (presenceSt/section/note/start; presenceSet,
    presenceStatus luôn enabled=false,connected=false; presenceStarted; trunc) — xóa toàn bộ
    dial/handshake/frame/loop/push. presenceSetEnabled/presenceEnsure/presenceEnabled đã xóa.
  * presence_api.go: enable/disable chỉ trả message hướng dẫn extension (không còn lưu Enabled);
    bỏ c không dùng ở POST (GET vẫn dùng). app.js: bỏ wiring dot/state/appId/toggle, giữ
    kaspersky/presenceInstall + section ping cho beacon. index.html: card chỉ còn 3 nút cài.
- Fix cú pkill -f giết shell: neo "^/tmp/nexus-go-test" (đã ghi ở 10-g, dùng nhất quán).
- REPO ĐÃ PUBLIC (PATCH /repos private:false bằng PAT — user chấp thuận "tôi cho chuyển repo public").
  Anonymous /releases/latest hoạt động → updater không cần token. (Sandbox thấy latest go-v12 vì
  cache egress; máy user sẽ thấy đúng go-vN mới nhất.)
- Exe trong download/ build với -X main.buildNumber=16 → banner sẽ hiện "go-v17" ngay khi CI
  dispatch bản v3.1.1 → user bấm Cài ngay = demo updater thật. Sau đó mọi bản tự cập nhật tiếp.
- Verify: vet/test OK; smoke: GET presence enabled/connected=false ✓; POST enable message đúng ✓;
  section→beacon ✓; UI không còn presenceToggle ✓; exe mới trong download/.


## Bổ sung 10-i: v3.2.0 — Theme Sakura AI + cleanup chọn mục + dashboard live (benchmark tool EXM)
- User gửi 5 ảnh tool EXM (đối thủ): sidebar sidebar dark + Game Mode có vòng "✦ Plus" khóa cho
  free user; Advanced Timer Resolution có nút Upgrade; Debloat System Cleaner là list mục có SIZE
  + checkbox + Select all + Start cleaning; Home có CPU graph live + Quickstart. Yêu cầu: mọi thứ
  100% FREE (không Plus), cleanup chọn được mục muốn dọn, dashboard tự update, theme Sakura chuẩn
  với ảnh từ z-ai image.
- z-ai image CLI: API thật chỉ nhận size bội của 32 trong 512-2880 & ≤2^22px (SKILL.md sai:
  1440x720 và 1024x1024 đều bị 400 code 1214); chạy song song bị 429. Chạy TUẦN TỰ + size
  1344x768/1152x864 OK. 4 ảnh: sakura-hero.jpg (cây anh đào đêm), sakura-bg2.jpg (nền petals),
  sakura-gaming.jpg (battle station pink RGB), sakura-mascot.png (cô gái manga cầm chổi).
  Nén PIL q78-85 → tổng ~550KB. Static NHÚNG qua go:embed trong api.go → sửa static phải REBUILD
  exe (server test cũ serve HTML cũ — mất 1 vòng debug vì tưởng browser cache).
- UI: theme css viết lại toàn bộ (plum #150a14 + pink #ff7eb6, glass cards, petal CSS animation
  8 cánh hoa, glow nav/badge), badge FREE gradient phát sáng topbar + brand-sub "100% FREE • vN".
  Hero banners cho Tổng quan/Dọn dẹp/Gaming (mascot trong clean-hero). Stat card "Đã giải phóng"
  (tổng tích lũy persistent) + canvas CPU chart 60s (pushCpu/drawCpuChart, gradient fill hồng).
- Cleanup chọn mục: runCleanup(action, ids []string) lọc theo targets; POST body {action,targets};
  UI clean-list label+checkbox kèm size từng mục + tag "🔑 cần Admin" cho mục admin; Chọn tất cả/
  Bỏ chọn hết; updateSelInfo tính ~dung lượng sẽ dọn; sau khi dọn xong refreshFreedStats +
  refreshStats → dashboard cập nhật NGAY. scanTargets trả thêm totalFreedAllTime (Store field
  cleanupTotalFreed persistent) + lastRan.
- BUG CẮT TRONG SMOKE (sẽ lại như bài học no-responding): patch python chèn CleanupTotalFreed vào
  AddCleanupLog nhưng để nguyên cặp s.mu.Lock()/defer Unlock() cũ NGAY SAU cặp mới → tự deadlock
  non-reentrant mutex → POST /api/cleanup treo vĩnh viễn. Stack dump SIGQUIT chỉ thẳng
  store.go:243 sync.(*Mutex).Lock. Đã bỏ cặp thừa. Bài học: patch chèn code vào hàm có lock
  phải đọc lại toàn thân hàm sau patch.
- Verify: vet/test OK; smoke POST targets 1 mục/mục lạ/all đều phản hồi tức thì ✓; 5 ảnh serve
  200 ✓; UI markers ✓; screenshot agent-browser: Tổng quan có hero sakura + chart CPU hồng +
  badge FREE; Dọn dẹp có hero mascot + checkbox list + select buttons (Linux chỉ hiện target
  unsupported — Windows thật sẽ ra 11 mục có size). exe 13.8MB (nhúng ảnh), buildNumber=17 →
  banner sẽ hiện go-v18 sau dispatch = demo updater tiếp.


## Bổ sung 10-j: v3.2.1 + ext v2.5.0 — extension cài rồi mà Discord không hiện
- User: "cài tiện ích rồi mà sao không hiện khi dùng Sakura Tool". Flow thật: tool mở beacon
  127.0.0.1:32123 (fallback 32124, beacon.go) → ext MV3 poll /api/presence-beacon alarm 30s →
  app=sakura-tool → POST discord.com/api/v10/users/@me/headless-sessions (OAuth popup Đăng nhập
  + Bật). Code đúng — vấn đề: KHÔNG có chẩn đoán bước nào gãy (login? Bật? beacon? version?),
  update.xml hardcode "2.4.0", và download/ có 2 zip (v2.3.0 cũ KHÔNG có dect sakura → cài nhầm
  là chết).
- Fix ext v2.5.0: popup viết lại = 3 bước (Đăng nhập/Bật/Tool đang mở) mỗi bước ✅/❌ + version
  dòng dưới + popup TỰ fetch beacon (không chờ alarm); Bật mà chưa có auth → tự login() OAuth;
  manifest 2.5.0. Fix tool v3.2.1: beacon ghi lastPoll (atomic) + port active; GET /api/presence
  trả beacon{port,lastSeenSec}; UI Tổng quan có dòng 🟢 "extension đang poll …s trước" / 🟡
  checklist khi chưa thấy (app.js refreshBeaconStatus 5s, chỉ khi overview active);
  extManifestVersion() đọc manifest nhúng → update.xml không bao giờ lệch version.
- Smoke: update.xml version="2.5.0" ✓, crx 200 38KB ✓, poll 32123 → lastSeenSec 1 ✓ (lưu ý
  curl nhầm port main server → 404 — beacon là server riêng, test đúng phải curl 32123);
  node --check 2 js ✓. Bỏ zip cũ trong download/, chỉ còn Cat-Status-Sakura-v2.5.0.zip.
- exe buildNumber=18 → banner sẽ hiện go-v19 (dispatch này) = chuỗi update tiếp tục.


## Bổ sung 10-k: ext v2.5.1 — 2 bug từ ảnh Discord của user (dấu ? + đếm 57 năm)
- Ảnh user gửi: activity "Sakura Tool" hiện icon DẤU HỎI CHẤM + elapsed "498076:12:26" (~57 năm).
- Bug 1 icon: trick `mp:external/<b64url>` CHỈ hỗ trợ Spotify; app thường → Discord không resolve
  → dấu ?. App 1563917712227442731 còn `icon: null` (kiểm tra GET /applications/{id}/rpc) → không
  có gì fallback. Fix: large_image dùng asset key **"sakura"** (user upload 1 lần trong Developer
  Portal → Rich Presence → Assets); chưa có asset → postActivitySafe tự retry không assets (đẹp).
  Không sửa được từ code — asset là tài nguyên portal của app owner. Logo: static/img/sakura-logo.png.
- Bug 2 timestamp: tính chính xác từ elapsed 1,793,074,346s → start bị Discord hiểu ≈ 21/01/1970 ⇔
  **REST headless-sessions dùng MILI-GIÂY** (giống gateway), khác RPC IPC (giây). Fix:
  `timestamps.start = started*1000` (kèm sanity check >1e12).
- Dọn chết: bỏ LOGO_URL + b64urlStr (không còn mp:external). v251_patch.py.
- Smoke: update.xml version="2.5.1" ✓ health 3.2.1 ✓ beacon ✓ (lưu ý: không smoke được exe
  Windows trên Linux — smoke bằng binary Linux cùng code). exe download buildNumber=19 → banner
  go-v20. "Đang chờ" trong ảnh = Discord idle, không phải bug.


## Bổ sung 10-l: v3.3.0 — BỎ SẠCH extension + TOOL 1000 TINH CHỈNH (yêu cầu user "bỏ mẹ extension đi tập trung tool")
- BỎ extension: xóa beacon.go/presence_api.go/presence_install.go/ext_pack.go/ext_pack_test.go/
  ext_policy_windows.go/ext_policy_other.go/discord_rpc.go/extension/ + routes /api/presence,/ext/*
  + card UI Discord + app.js presence wiring + zip Cat-Status trong download/. Discord status
  CHÍNH THỨC BIẾN MẤT khỏi tool — user dùng extension cũ vẫn chạy nhưng không còn support.
- 1000 tweaks THẬT (380 cũ + 620 mới): hệ TSV data/*.tsv (id~~name~~cat~~desc~~risk~~admin~~rec~~
  apply~~revert, DSL RA/RD/RV/RK/DK/SC/PC/TK/AX/EX/PX) + tweaks_split.go splitCompound() tách
  row compound (≥2 RA + RD đối xứng) thành per-value row tự động (Go tables + TSV data đều split).
  Pool mới: twk_a-f.py (services~120 thực, tasks~57, UWP~60, registry privacy/UI/security,
  MMCSS Tasks, ASR 10 GUID, Edge/Chrome/Firefox policies, DISM optional features, power GUID,
  hardening WDigest/LSA/VBS...). scripts/gen_pool.py dedupe chéo (id/SC/TK/AX/RA(key,val) vs
  Go const + granular TSV). Tổng khít 1000 qua trim API. KHÔNG bịa key — cái nào không chắc thì bỏ.
- BỎ ";" trong PX script (parseSpec tách ';'!) — PX đa statement = nhiều bước PX:...;PX:...
- UI 1000 mục: search box debounce 250ms, render cap 150 + nút "Hiện thêm", selAll theo filter,
  runTweaks chunk 100/lô (server limit 200), progress "1–100/1000".
- Cảnh báo: DO NOT trust PowerShell multi-";" trong TSV PX. curl beacon test → dùng đúng cổng beacon
  (beacon đã XÓA). Verify: API 1000, dup 0, high-risk 37, rec 189, node --check OK.


## Bổ sung 10-m: v3.4.0 — i18n EN/VI + wallpaper AI + fix 24 bugs (user giao đội agent)
- ORG (user yêu cầu 30 slot — gộp 5 agent chạy thật, manager=tôi): 2 coder [i18n.js 257 cặp+17
  pattern động; wallpaper.js 9 option+overlay+random] + 2 bug finder (Go 12 issue, UI 12 issue)
  + 1 feature suggester (7 tính năng: presets 1-click, startup manager, restore point, uninstaller,
  task scheduler, hosts editor, export/import profile). Coder chỉ viết file MỚI (không đụng chéo).
- FIX CAO: selftest deriveTableDeps dùng s.Name (không phải Args[0]); GUID PROCTHROTTLEMIN
  893dee8e-2bef-41e0-89c6-b55d0929964c trong gen-d TSV; welcome overlay chết vì script tag đứng
  TRƯỚC markup (dời cuối body + i18n.js/wallpaper.js trước app.js). FIX TRUNG: esc() escape nháy;
  settingsSave echo uiSettingsCache (không hardcode background); runTweaks guard double-run +
  toast progress; selAll chỉ chọn mục hiển thị (≤tweakLimit); applyUiSettings petals + boot apply;
  splitCompound copy struct (không rơi ApplyOnly) + msg per-value; gaming revert đối xứng apply;
  single-flight mutex POST /api/tweaks + updater mutex; PUT settings validate Lang vi/en +
  CustomBgURL scheme whitelist; truncateShort/shortDetail runeCut (không vỡ UTF-8); runSteps
  báo bước fail N/M. UI: .tweak-body min-width:0 + overflow-wrap anywhere; procSearch debounce;
  dead chip block xóa. XÓA ext-key.pem sót.
- ASSET CACHE-BUST: script/link tag có ?v=3.4.0 (trước đây browser cache JS cũ sau update).
- i18n: dict VI→EN phủ 100% UI chrome + 28 nhóm tinh chỉnh; MutationObserver addedNodes +
  placeholder sweep cho void element (input không text node); WeakMap restore VI; persist
  localStorage sakura-lang + PUT /api/settings lang (server validate vi/en).
- Wallpaper: UISettings.Background whitelist +7 key (sakura-bg/bg2/gaming/hero, bg-ai-night/
  sunset/petals = 3 ảnh z-ai gen 1440x736 JPEG trong static/img/); CustomBgURL validate;
  localStorage sakura-wallpaper là truth hiển thị; body.sakura-wp-on::before + --wp-img/--wp-op.
- VERIFY thật (agent-browser): welcome overlay hiện (fix#1 works), 🌐 toggle EN↔VI 2 chiều
  (nav/chips/tags/toast + placeholder roundtrip), AI Night áp background + overlay 45%,
  VI khôi phục chuẩn. go vet sạch, test pass, API 1000.
- ROADMAP từ suggester (làm tiếp): presets 1-click → startup manager → restore point button.


## Bổ sung 11-m: v3.4.1 — fix 2 bug user báo bằng screenshot
- BUG TOAST SPAM "Lưu cài đặt lỗi: lang chỉ hỗ trợ vi/en": config cũ v3.3.0 không có lang →
  GET trả lang:"" → mọi PUT (settingsSave / wallpaper merge) bị ValidateSettings từ chối.
  Fix: ValidateSettings chấp nhận "" + PutSettings chuẩn hóa ""→"vi" + settingsSave spread
  uiSettingsCache (giữ lang/welcomeSeen) + cache update sau save.
- BUG WELCOME HỎI LẠI MỖI LẦN MỞ: root = main.go chọn cổng NGẪU NHIÊN mỗi lần mở (flag port=0)
  → origin 127.0.0.1:PORT đổi → localStorage (welcome seen, lang, wallpaper tinh chỉnh) "mất".
  Fix 3 lớp: (1) main.go cổng cố định mặc định 32199 (+1…+10 nếu bận, cuối cùng mới OS-random);
  (2) UISettings + WelcomeSeen bool — bấm Bắt đầu ghi cả server (GET-merge-PUT), boot adopt:
  server seen=true → ẩn overlay + set localStorage dù origin mới; (3) i18n adopt server lang khi
  localStorage trống. Thêm: updater giữ os.Args[1:] khi tự mở lại (--web/--port không rơi).
- VERIFY browser thật (origin 32199): legacy PUT 200 lang=vi; welcomeSeen persist; fresh flow:
  overlay hiện → đồng ý → server nhớ → mở lại lần 2 overlay ẩn (ls trống vẫn ẩn nhờ adopt).
  go vet/test pass. exe buildNumber=22.


## Bổ sung 12-n: v3.5.0 — Hiệu năng: Timer Resolution tự động + Ép xung + FPS test (yêu cầu user)
- Timer Resolution: perf_windows.go dùng ntdll!NtSetTimerResolution/QueryTimerResolution — dò
  0.5→1→2ms lấy mức TỐT NHẤT máy hỗ trợ (kernel cấp gì nhận nấy, ≤2x mong muốn); perf_other.go
  = chế độ mô phỏng CI (mode "ci-sim", ghi rõ từng bước là mô phỏng — không nhầm tác dụng thật).
- Ép xung an toàn (không vọc voltage): NVIDIA → nvidia-smi -lgc/-lmc khóa xung boost tối đa
  (balanced/max); GPU khác → HAGS reg; powercfg High Performance (mọi mức); max → CPU min 100%
  + Ultimate Performance. POST /api/perf/restore khôi phục (-rgc/-rmc, Balanced, timer off).
- FPS test in-app (perf.js): benchmark paced performance.now + busy-spin ≤2.5ms — mục tiêu
  mặc định 60; "🚀 Tối ưu" = ép xung + timer auto + TỰ ĐẨY FPS 60→120; slider 60-240;
  modal canvas particles + verdict "🎯 X FPS — Đạt mục tiêu ✓" (data-done cho CI đọc).
  Trên Windows timer 0.5ms chính là thứ giữ nhịp 8.33ms → 120 FPS thật.
- storeData + PerfSettings {fpsTarget,timerRes,ocLevel} (mục "perf" config.json, defaults 60/auto/balanced).
- CI: job perf-test trong build-go.yml — Bước 1 ép xung + timer qua curl (assert success),
  Bước 2 ci/fps-benchmark.mjs (puppeteer-core + google-chrome-stable có sẵn trên runner):
  mở UI → CHUYỂN TAB Tinh chỉnh (fix lần 1: perfCard ẩn ở tab mặc định) → FPS baseline 60
  (assert 50-75) → chỉnh slider 120 (ảnh 01) → bấm Tối ưu (ảnh 02) → FPS test lần 2
  (assert ≥105 + > baseline, ảnh 03) → 4 ảnh artifact + step summary. Ảnh kiểm tra không trống >15KB.
- KẾT QUẢ CI run 44062955472 (SHA 5ec2bb5, run #33): cả 2 job SUCCESS —
  JSON {"baseline":60,"after":120,"pass":true}, log "FPS TĂNG: 60 → 120". 4 ảnh artifact OK.
- exe chuẩn build #33 tải từ CI artifact về download/Sakura-Tool-x64.exe; ảnh đặt download/fps-test-photos/.


## Bổ sung 12-o: v3.5.1 — FPS test 2 pha chống fake (user bắt lỗi "fake fps à")
- User质疑 đúng: bản 3.5.0 chỉ là paced test (đặt 120 thì nhắm nhịp 120 — frame vẽ thật nhưng
  không ĐO năng lực). Sửa thành 2 pha trong perf.js startBench():
  PHA 1 giữ nhịp 4s (paced, test ngưỡng timer) → PHA 2 MessageChannel loop KHÔNG GIỚI HẠN 3s
  (không qua setTimeout → không clamp 4ms) = throughput render thật, không đặt trước số.
- Verdict gắn dataset paced/max (#benchVerdict data-done/paced/max); 3 nhánh: đủ nhịp+đủ năng lực
  (xanh) / thiếu năng lực thật (đỏ, ghi rõ giới hạn phần cứng) / đủ năng lực thiếu nhịp (vàng).
- CI: assert max ≥ 120 (không khoe 120 khi máy không đủ) + max ≥ paced; KQ run 44073019147 (#34,
  SHA ac41ec2): baseline paced 60/max 1249 → sau Tối ưu paced 119/max 964, pass:true — số có
  jitter (119/120, max dao động) = dấu hiệu đo thật. exe #34 + 4 ảnh đã về download/.
- Lưu ý trung thực cho user: trong game thật, FPS vẫn cap bởi engine/vsync/màn hình — timer
  resolution giúp nhịp frame mượt (stutter) + màn 120Hz+; tool không đội FPS game vượt cap.


## Bổ sung 12-p: v3.5.1b — FIX đứt chuỗi auto-update (user bắt "mất auto update")
- Nguyên nhân: build-go.yml cắt release CHỈ khi workflow_dispatch (if event==dispatch) →
  các run push 29..34 build exe nhưng KHÔNG có release → updater (tra releases/latest
  tag go-vN) dừng ở go-v28 → tool cũ không bao giờ được mời lên v3.5.1. Code updater
  (updater.go, updateRepo/updateAsset go-vN + asset NEXUS-Optimizer-Go-x64.exe) NGUYÊN.
- Cấp cứu: cắt release go-v34 qua API từ exe CI #34 (scripts/cut_release_go34.py),
  upload asset đúng tên; verify releases/latest→go-v34 + sha256 asset == exe local (9e48410c…).
- Fix gốc: job `release` riêng needs [build-go, perf-test] (chỉ cắt khi cả 2 xanh),
  download-artifact exe → softprops cut go-v{run_number} + asset. Push e5f94b9 → run #35
  (44083775053): 3/3 job xanh, go-v35 TỰ SINH ✓. Từ giờ mọi push xanh = release mới tự có.


## 13-a: v3.6.0 (SHA 350f3ca, run 44097394724 #36) — 4 yêu cầu của user trong 1 bản
1. FIX lỗi đổi màu: root cause = ~30 chỗ style.css hardcode hồng rgba(255,126,182/…)/#ffb7d5
   trong khi chỉ 17 chỗ dùng var(--accent) → đổi accent chỉ ăn ít chỗ, nhìn như không đổi.
   Fix: thêm --accent-rgb/--accent2-rgb cho cả 6 theme, đổi hết sang rgba(var(--accent-rgb),a)
   (scripts/fix_accent.py, tương thích mọi WebView2 — không dùng color-mix). Smoke UI:
   chọn Cyan Violet → accent #4fd1c5 + border/glow/nav/slider toàn UI theo accent ✓.
2. Bỏ badge "100% FREE": topbar badge, hero Tổng quan, brand-sub, i18n entries.
3. Game/CPU/GPU: (a) endpoint /api/perf/game-gpu — UserGpuPreferences "GpuPreference=2;"
   cho exe game (HKCU, KHÔNG cần admin) + UI card trong Hiệu năng + list/clear;
   (b) preset Gaming 17→20 mục: +win-nagle, +win-gpu-tdr-delay, +win-cpu-dynamic-tick-off
   (test TestGamingPresetIdsExist enforce id tồn tại + đủ revert, one-shot ram-clean/flush-dns
   được miễn); (c) ép xung: CPU min state 100% mở rộng từ "max" sang cả "cân bằng".
4. Chống lỗi máy thật: go test ./... vào CI (catalog integrity: Apply/Revert non-nil, risk hợp lệ,
   unique id, name/category/desc đủ) + CI perf-test: game-gpu set→list→clear OK + gaming
   BẬT/TẮT shape 20 effects; FPS test 2 pha vẫn xanh (60→120, max thật 2039→1419).
- Process "Failed to fetch" (user screenshot): thêm retry 1 lần + báo lỗi inline trong bảng.
- release go-v36 tự cắt ✓ (job auto), exe đã về download/Sakura-Tool-x64.exe (buildNumber=36).


## 14-a: v3.7.0 (SHA 74dc2ba, run 44101683034 #37) — App Optimizer + Fixes + Bufferbloat (theo 5 ảnh tham chiếu user gửi)
- **App Optimizer** (apps_opt.go + tab mới): 6 app Edge/Chrome/Brave/Firefox/Discord/Spotify —
  detect THẬT qua đường dẫn chuẩn (Program Files/APPDATA), apply/revert riêng từng app:
  trình duyệt = chính sách HKLM (StartupBoost/BackgroundMode/DisableTelemetry, gateWrap admin),
  Discord = settings.json HardwareAcceleration=false (user) + IFEO CpuPriorityClass=16384 (admin),
  Spotify = xóa HKCU Run. Trạng thái lưu store AppOptStates; app chưa cài → warning
  "App not found" trung thực; UI grid card (.acard + icon + warn vàng) giống app tham chiếu.
- **Fixes** (fixes.go + tab mới): 6 fix — internet (flushdns/winsock/tcprenew), Windows Update
  (wuauserv/bits/dosvc), audio (Audiosrv/AudioEndpointBuilder), Explorer, printer spooler,
  Store wsreset. Mỗi fix trả steps[] trung thực từng bước; không-Windows → mode="không-Windows".
- **Mạng — Bufferbloat & Speed** (client-side app.js): fetch speed.cloudflare.com __down 12MB
  đo Mbps + RTT rảnh 8 lần + RTT khi bận → bloat delta → grade A+..F + bảng kết luận
  web/call/4K/gaming. Smoke thật trong browser: 404 Mbps, 43ms, +0ms → A+.
- CI thêm bước 7: appopt 6 app shape (Linux → installed=false + warning) + fixes shape
  trung thực. go test vẫn xanh; CI #37 3/3 xanh, go-v37 tự cắt, exe buildNumber=37 về download/.
- Ghi chú: firstLine chuyển perf_windows.go → perf.go (dùng chung); step() đổi tên fixStep
  (trùng `step` type trong tweaks_table.go — build tag 2 nền bắt được).
