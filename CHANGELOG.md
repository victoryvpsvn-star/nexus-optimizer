# Changelog — NEXUS Optimizer

## v4.6.0 (2026-11-25)

### CI / Build (Windows ISO)
- **Win11 ISO download fix (run #114)**: prss.microsoft.com ngắt giữa chừng khi tải 5.5GB (curl exit 18) — vòng lặp tải 6 lần với `-C -` (resume từ vị trí đã tải) + `--retry-all-errors`; kiểm tra size thật sau khi tải.
- **MS connector Python làm chính** (chain 17-i/17-j/17-k): flow vlscppe → ov-df → GetSkuInformation → GetProductDownloadLinksBySku, đã chạy thật trong CI lấy link prss 26300.9457 (Win11 26H2 en-US). Fido chỉ còn là backup (exit 1 silent trên runner: `-Lang` không hợp lệ cho 26H2).
- **DownloadType là INT** (1 = x64) — fix crash line 112; URL prss có token `?t=` — match `.iso` IN uri thay vì endswith.
- **Khoá TargetReleaseVersionInfo = 26H2**: MS đã rút 24H2 consumer khỏi catalog; muốn 24H2 thật phải qua UUP dump.
- **Export boot.wim FAIL-NHẸ**: job chính fail trước đó thì export chỉ warning (không giết job), job WinPE tự skip vì thiếu artifact.

### WinPE (windows-nexus.iso)
- **v4.6 — PowerShell 7.4.6 portable (self-contained, kèm .NET runtime) nhúng vào boot.wim**: boot.wim 26H2 (WinSE) KHÔNG còn powershell.exe trong bất kỳ index nào (MS loại khỏi WinSE từ Win11) — dashboard/menu/apps PS scripts giờ chạy qua `X:\NEXUS\pwsh\pwsh.exe`, fallback web-only nếu pwsh lỗi runtime.
- `startnet.cmd` v4.6: check pwsh tồn tại trước khi chạy dashboard; menu [1] offline tune / [2] app installer chỉ hiện khi có pwsh.

### Playbook AME Wizard (.apbx)
- **v1.0.2 — fix "Playbook Name is too long"**: `<Name>` rút từ "NEXUS Optimizer" (15 ký tự) xuống "NEXUS" (1 từ, soánh chuẩn UltraOS/Atlas); Description/Details/ProgressText trim về 180–240 ký tự.
- **v1.0.1 — thêm Windows 11 Pro 21H2 (build 22000)**: SupportedBuilds + precheck regex; pattern không tồn tại trên 21H2 (Copilot, DevHome, AI stubs) là no-op vô hại.

### App (Go, Sakura Edition)
- AppVersion 4.5.0 → **4.6.0** (đồng bộ với WinPE v4.6).

## v4.5.0 (2026-11-24)

- RustDesk live v3 (root-cause từ dump CFG #27 + mã nguồn hbb_common): 1 SERVICE duy nhất chuẩn installer; ID lấy qua task `/RU` đúng account service; password PLAIN đúng thiết kế (`decrypt_str_or_original` chấp nhận plain) — 11/11 PASS.
- Playbook NEXUS v1.0.0 cho AME Wizard (.apbx): 126 pattern AppX (Atlas + FSOS-X merged), deprovision diff, reinstall-blockers, OneDrive strip, gaming registry, telemetry lockdown, install report HTML.
- Win11 ISO tune: 55' trọn vẹn trong CI (mount + debloat + registry offline + LabConfig + export recovery + split .swm).
- pycdlib ISO UDF 2.60 (bỏ Joliet 64-char limit), BOM UTF-8 toàn bộ script PS, OneDriveSetup bỏ attribute trước khi xóa.
