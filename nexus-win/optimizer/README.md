# NEXUS Optimizer — playbook kiểu FSOS-X / AtlasOS

Tối ưu Windows theo phong cách mod FSOS-X/Atlas: **hỏi từng module trước khi áp dụng**, không có gì bị tắt ngầm.

## Chạy

PowerShell **Run as Administrator**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\nexus-optimizer-wizard.ps1
```

## Các module (mỗi module hỏi [y/N], mặc định GIỮ)

| # | Module | Nội dung |
|---|--------|----------|
| 0 | Điểm khôi phục | Tạo System Restore point trước khi tối ưu (khuyến nghị) |
| 1 | App rác UWP | Hỏi **từng app** (Teams consumer, Clipchamp, News, Solitaire...) |
| 2 | Startup | Chỉ liệt kê — tắt tay trong Task Manager là an toàn nhất |
| 3 | Telemetry | DiagTrack + dmwappushservice tắt, AllowTelemetry = Basic (không phải Security) |
| 4 | Quyền riêng tư | Advertising ID, tailored experiences, feedback, Activity History |
| 5 | Giao diện | Trong suốt, Widgets, Copilot, Recall + chọn mức hiệu ứng 0/1/2 |
| 6 | Game | Game Mode BẬT, Game Bar/DVR TẮT, HAGS (hỏi riêng), Ultimate/High Performance |
| 7 | **Hyper-V** | **Hỏi riêng — mặc định GIỮ — phải gõ đúng `YES` (HOA) mới tắt.** Nếu đang tắt thì hỏi có muốn BẬT để test NEXUS |
| 8 | Không đụng | Defender, Windows Update, Core Isolation/VBS — in thông báo, không hành động nào (an toàn anti-cheat: Vanguard, ACE, EAC, BattlEye) |

## An toàn

- Backup registry từng key vào `%USERPROFILE%\NEXUS-Backup\<timestamp>\` trước khi sửa
- Report đầy đủ tại `%USERPROFILE%\Desktop\NEXUS-Optimizer-Report-<timestamp>.txt`
- HAGS/Hyper-V cần restart mới hiệu lực đầy đủ
- Không có module nào đụng Windows Update hay Defender — kể cả khi người dùng muốn (theo playbook)

## Test live qua RustDesk (trên runner GitHub)

Workflow **rustdesk-live.yml** (bấm Run workflow): tự cài RustDesk trên VM GitHub, mở sẵn wizard, giữ đúng **10 phút**. ID + password hiện trong log của run — kết nối bằng app RustDesk và test trực tiếp.
