# NEXUS OPTIMIZER — Bộ công cụ hệ thống đa năng (Sakura Edition)

Dashboard giám sát + tối ưu hệ thống tất-cả-trong-một với giao diện **Sakura hồng dịu**, bo góc mềm, không còn góc nhọn nào. Mở app lên là sakura màu hồng với cánh hoa rơi.

## Tính năng

| Module | Mô tả |
| --- | --- |
| **Tổng quan** | Giám sát CPU / RAM / Disk / Network realtime (biểu đồ 3 phút, gauge tròn) |
| **Dọn dẹp** | Dọn Disk + RAM **cùng lúc** chỉ với 1 nút, kèm lịch sử logs |
| **Gaming Mode** | Bật 1 công tắc — ép nền đen neon, áp bộ tinh chỉnh hiệu năng, danh sách hiệu ứng minh bạch thành công/thất bại |
| **Tinh chỉnh** | Danh sách tweak xếp hạng theo độ ưu tiên, badge mức rủi ro, áp dụng/khôi phục từng mục hoặc bộ khuyến nghị |
| **Script nâng cao** (mới) | Tự viết script **Bash / Python / PowerShell** chạy trực tiếp: editor + console output, lưu thư viện script, timeout 90s, output tự cắt an toàn |
| **Tiến trình** | Xem + dừng tiến trình, sắp xếp CPU/RAM |
| **Sao lưu** | 1) **Tạo backup** file .tar.gz, tải lên bucket 30GB; 2) **Dùng lại backup** từ local hoặc bucket (restore có xác nhận, chặn symlink/path traversal, không ghi đè .env / db / node_modules) |
| **Ảnh chụp** | Chụp màn hình dashboard, quản lý + xóa |
| **Cài đặt** | Đổi nền (Sakura / Wallpaper AI / tối / URL tùy chỉnh), màu nhấn, **slider bo góc**, toggle cánh hoa rơi, **Xuất / Nhập cấu hình (JSON)** |

## Giao diện Sakura

- Mở app mặc định nền **Sakura hồng** (wallpaper AI + cánh hoa rơi, tắt/bật được)
- Nút "Gaming Mode" tự chuyển toàn bộ sang theme đen neon tím
- Mọi thẻ/nút/khung đều bo tròn theo slider trong Cài đặt (8–24px)

## Chạy dự án

```bash
bun install        # hoặc npm install
bunx prisma db push
bun run dev        # mở http://localhost:3000
```

## Build Windows x64 (bản .exe thật)

App được đóng gói bằng **Electron + electron-builder**: mở lên là cửa sổ riêng chạy server Next.js standalone nội bộ (cổng 127.0.0.1:32123), dữ liệu (SQLite, backup) nằm trong `%APPDATA%/NEXUS Optimizer/data`.

### Cách 1 — Bấm nút trên GitHub (khuyến nghị)
1. Vào tab **Actions** → chọn **Build Windows x64 (exe)** → **Run workflow**
2. Chờ ~10–15 phút → tải kết quả ở 2 chỗ:
   - **Artifacts**: `NEXUS-Optimizer-win-x64-<số build>`
   - **Releases** (khi chạy workflow_dispatch): file exe đính kèm release
3. Sản phẩm: `NEXUS-Optimizer-Setup-*-x64.exe` (installer) + `NEXUS-Optimizer-Portable-*-x64.exe` (chạy trực tiếp)

> File chưa ký số — SmartScreen hiện "Windows protected your PC" thì bấm **More info → Run anyway**.

### Cách 2 — Build trên máy Windows

```powershell
npm install
npm run dist:win   # kết quả nằm trong release/
```

Quy trình: `next build` → `post-build.mjs` (copy static/public/prisma engine vào standalone) → `stage-electron.mjs` (dựng build/electron-app) → `electron-builder --win --x64`.

### Lưu ý quyền trên Windows
- Các tinh chỉnh **HKCU** (Game DVR, Game Mode, chuột, hiệu ứng...) áp dụng ngay không cần Admin
- Các mục **HKLM / service / powercfg** (SystemResponsiveness, SysMain, DiagTrack, Nagle, power plan...) cần chạy app với **quyền Administrator** — thiếu quyền sẽ được báo lỗi trung thực, không giả lập thành công
- Dọn dẹp mục Temp Windows / Prefetch / Windows Update cache cũng cần Admin

## GitHub Workflow (tự động sao lưu)

- `.github/workflows/backup.yml` — đóng gói backup .tar.gz:
  - Lưu artifact GitHub (giữ 30 ngày)
  - Đẩy lên bucket S3 30GB (`nexus-backups/`) qua Secrets
  - Thông báo Discord (nếu cấu hình webhook)
  - Chạy hằng ngày 02:00 + bấm "Run workflow" thủ công được
- Secrets cần thiết: `S3_ACCESS_KEY_ID`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `DISCORD_WEBHOOK_URL` (tùy chọn)

## Kỹ thuật

- Next.js 16 (App Router, Turbopack) + TypeScript + Tailwind CSS v4 + shadcn/ui
- Prisma + SQLite (`Setting`, `TweakState`, `CleanupLog`, `BackupRecord`, `GamingState`, `SavedScript`)
- **Electron 33 + electron-builder** (NSIS + portable, x64) cho bản Windows; server Next standalone chạy bằng `ELECTRON_RUN_AS_NODE`
- **Đa nền tảng**: Linux dùng /proc + sysctl + sudo; Windows dùng PowerShell (`psRun` qua stdin) + registry (`reg.exe`) + `sc.exe`/`powercfg` — mọi lệnh đều báo lỗi trung thực khi thiếu quyền
- framer-motion + sonner + lucide-react
- Ảnh AI: `public/img/wall-sakura.png`, `public/img/logo-sakura.png`

> **Lưu ý:** Module Script nâng cao chạy lệnh trực tiếp trên máy chủ — chỉ dùng trên máy của bạn và chỉ chạy script bạn hiểu rõ.
