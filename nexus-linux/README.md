# NEXUS Linux Dev — bản terminal cho dev (Debian base)

Bản **NEXUS OS** dành cho dev: chỉ terminal, cực nhẹ (mục tiêu VM 1GB RAM / 0.25 core / disk 2GB), base **Debian bookworm**
(không Alpine), đội tool security/dev kiểu Kali. Boot UEFI + BIOS → Hyper-V Gen 2 OK.

## Bản sắc
- `/etc/os-release` → `NEXUS Linux 1.0 Dev Terminal` (neofetch/fastfetch đọc tên này)
- `/usr/bin/nexfetch` — info hệ thống + logo NEXUS, tự chạy khi login (`/etc/profile.d/00-nexus.sh`)
- `/usr/bin/nx` — lệnh thay apt: `nx install|remove|update|upgrade|search|info|list|tools` (backend apt-get)
- Login: user `nexus` (auto tty1, mật khẩu `nexus`, sudo NOPASSWD) — root mật khẩu `root`

## Thêm tool cho ISO
Sửa `nexus-dev/config/package-lists/nexus-dev.list.chroot` (1 gói/dòng) → push →
CI build lại tự động. Tên gói được `../validate-packages.sh` kiểm với index
bookworm main trước khi live-build chạy (fail fast).

## Build cục bộ (máy có root)
```
cd nexus-linux/nexus-dev
sudo sh ./auto/config
sudo lb build        # ra live-image-amd64.iso → đổi tên nexus-linux-dev.iso
```

## Cấu trúc
- `auto/config` — tham số live-build (bookworm, iso-hybrid, volume NEXUS-Linux-Dev)
- `config/package-lists/nexus-dev.list.chroot` — danh sách ~80 gói dev + Kali-style
- `config/includes.chroot/` — overlay thả thẳng vào hệ thống (nx, nexfetch, os-release, motd, sudoers, tools.txt)
- `config/hooks/live/0100-nexus-root.hook.chroot` — set mật khẩu root + dọn apt cache
