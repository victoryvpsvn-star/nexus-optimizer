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
- framer-motion + sonner + lucide-react
- Ảnh AI: `public/img/wall-sakura.png`, `public/img/logo-sakura.png`

> **Lưu ý:** Module Script nâng cao chạy lệnh trực tiếp trên máy chủ — chỉ dùng trên máy của bạn và chỉ chạy script bạn hiểu rõ.
