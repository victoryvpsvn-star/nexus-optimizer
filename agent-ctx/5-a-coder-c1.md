# Task 5-a — Coder Agent C-1: Module "Dọn dẹp" (Disk + RAM cùng lúc)

## Files written (only owned files touched)
1. `src/lib/cleanup.ts` — backend logic: 6 disk targets (npm-cache, pip-cache, bun-cache, thumbnails, tmp-files, screenshots), du-based measuring, safe rm, /proc/meminfo RAM flow, Prisma log writes (Int32-clamped), `cleanupAll()` with `Promise.all` (disk + RAM song song), exported `RAM_NOTE`.
2. `src/app/api/cleanup/route.ts` — `export const dynamic = 'force-dynamic'`; GET = scan + 15 logs (createdAt ISO) + ramNote; POST `{action:'disk'|'ram'|'all'}` → `CleanupRunResponse`; 400 cho action sai, 500 tiếng Việt khi throw.
3. `src/components/modules/cleanup-panel.tsx` — `CleanupPanel` (default + named export), hero card 4 nút (accent = "Dọn tất cả (cùng lúc)"), spinner "Đang dọn.../Đang quét...", chips tổng kết Disk/RAM, bảng mục tiêu (badge "Sẵn sàng"/"Không có"), lịch sử logs (badge DISK/RAM, formatBytes, formatTime, icon success), glass + thin-scroll, toast sonner success/warning (liệt kê target thất bại).

## API contract verified bằng curl trên dev server
- GET 200: targets đúng schema, bun-cache đo được 1.16GB, logs[], ramNote.
- POST disk 200: freed thật 1,216,815,104 bytes; messages trung thực ("Đường dẫn không tồn tại..." khi size 0); 6 row CleanupLog kind 'disk'.
- POST ram 200: success:false, message đúng spec "Cần quyền root (sudo) — máy chủ hiện không cho phép..."; totalFreedRam đo MemAvailable trước/sau (0 nếu không đọc được).
- POST all 200: disk + RAM chạy Promise.all, results gộp, tổng đúng.
- Logs persist: GET sau đó trả 14 logs mới nhất.

## Verification
- `bunx tsc --noEmit`: 0 lỗi trong 3 file của tôi. Còn lỗi ngoài phạm vi (không đụng): `examples/websocket/*` (thiếu module socket.io), `skills/image-edit/scripts/image-edit.ts`.
- `bunx eslint` trên 3 file: sạch.
- dev.log: mọi request /api/cleanup trả 200, Prisma INSERT/SELECT CleanupLog bình thường.

## Cross-file notes
- `src/app/page.tsx` (không thuộc quyền tôi) import `{ CleanupPanel }` (named) — spec yêu cầu default export; tôi giữ default export VÀ thêm `export { CleanupPanel }` trong file của mình để cả hai cách import đều chạy, không cần sửa page.tsx.
- `types.ts`, `exec.ts`, `db.ts`, `format.ts`, `schema.prisma` chỉ đọc, không sửa.
