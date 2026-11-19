#!/usr/bin/env python3
"""NEXUS Linux apkovl builder — tạo overlay tar.gz cho từng variant.

Variants: desktop (XFCE) / gaming (XFCE + flatpak + tune) / rescue (CLI).
Mọi variant: OS = NEXUS Linux, lệnh nx thay apt (backend apk), neofetch
hiện tên hệ điều hành riêng, mạng DHCP eth0 (Hyper-V default switch OK).

Usage: make_apkovl.py <desktop|gaming|rescue> <keys_dir> <out.apkovl.tar.gz>
"""
import io
import os
import sys
import tarfile

VARIANTS = {
    # packages ngoài virt ISO — boot offline từ /media/cdrom/apks (ISO tự bake)
    'desktop': {
        'pretty': 'NEXUS Linux 1.0 Desktop Lite (Alpine base)',
        'world': ['xfce4', 'xfce4-terminal', 'lightdm', 'lightdm-gtk-greeter',
                  'firefox', 'font-dejavu', 'font-noto', 'elogind', 'dbus'],
        'runlevels': ['dbus', 'lightdm', 'networking', 'local'],
    },
    'gaming': {
        'pretty': 'NEXUS Linux 1.0 Gaming (Alpine base)',
        'world': ['xfce4', 'xfce4-terminal', 'lightdm', 'lightdm-gtk-greeter',
                  'firefox', 'font-dejavu', 'font-noto', 'elogind', 'dbus',
                  'flatpak', 'htop'],
        'runlevels': ['dbus', 'lightdm', 'networking', 'local'],
    },
    'rescue': {
        'pretty': 'NEXUS Linux 1.0 Rescue CLI (Alpine base)',
        'world': ['htop'],
        'runlevels': ['networking', 'local'],
    },
}

NX_SCRIPT = r"""#!/bin/sh
# NEXUS nx — trình quản lý gói của NEXUS Linux (thay apt, backend apk)
case "$1" in
  install|add) shift; exec apk add "$@" ;;
  remove|uninstall) shift; exec apk del "$@" ;;
  update) exec apk update ;;
  upgrade) shift; exec apk upgrade "$@" ;;
  search) shift; exec apk search "$@" ;;
  info) shift; exec apk info "$@" ;;
  list) apk info -vv ;;
  *) cat <<'EOF'
NEXUS nx — dùng như apt trên NEXUS Linux:
  nx install <gói>    cài gói        (thay: apt install)
  nx remove <gói>     gỡ gói         (thay: apt remove)
  nx update           cập nhật chỉ mục gói
  nx upgrade          nâng cấp toàn bộ hệ thống
  nx search <từ>      tìm gói
  nx info <gói>       thông tin gói
  nx list             liệt kê gói đã cài
EOF
 ;;
esac
"""

NEXFETCH = r'''#!/bin/sh
# NEXUS nexfetch — info hệ thống + logo NEXUS (thuần shell, không cần gói ngoài)
G='\033[1;36m'; P='\033[1;35m'; R='\033[0m'
os=$(sed -n 's/^PRETTY_NAME="\(.*\)"$/\1/p' /etc/os-release 2>/dev/null || echo NEXUS)
k=$(uname -r); a=$(uname -m)
up=$(cut -d. -f1 /proc/uptime | awk '{d=int($1/86400);h=int($1%86400/3600);m=int($1%3600/60); if(d)printf "%dd %dh",d,h; else if(h)printf "%dh %dm",h,m; else printf "%dm",m}')
pk=$(apk info 2>/dev/null | wc -l)
mem=$(free -m 2>/dev/null | awk '/^Mem:/{printf "%d/%d MB",$3,$2}')
cpu=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ //')
vm='máy thật'; grep -qsi 'hypervisor' /proc/cpuinfo && vm='Hyper-V guest'
shell=$(ps -p $$ -o comm= 2>/dev/null || echo sh)
printf "%b\n" \
" $G    /\\\\      $R $P${os}$R" \
" $G   /  \\     $R Kernel : $k ($a)" \
" $G  /|/|\\    $R Uptime : $up" \
" $G  |__|      $R Shell  : $shell" \
" $G   ||       $R CPU    : $cpu" \
" $G   ||       $R RAM    : $mem" \
" $G NEXUS      $R Gói    : $pk" \
" $G  /\\\\      $R Runtime: $vm" \
" $G NEXUS Linux $R Cài gói: nx install <tên gói>$R"
'''

WELCOME = """#!/bin/sh
# NEXUS Linux — nexfetch khi login (TTY / SSH)
[ -x /usr/bin/nexfetch ] && /usr/bin/nexfetch
"""

NEXUS_START = """#!/bin/sh
# NEXUS Linux — boot banner + kiểm tra Hyper-V
echo "=============================================================="
echo "  NEXUS Linux 1.0 — hệ điều hành riêng của bạn (Alpine base)"
echo "  Lệnh cài gói: nx install <gói>   — thay cho apt"
echo "=============================================================="
if grep -qsi 'Hyper-V' /proc/cpuinfo 2>/dev/null || grep -qsi 'hypervisor' /proc/cpuinfo 2>/dev/null; then
  echo "  Hyper-V guest: phát hiện đúng — các driver hv của kernel LTS đã sẵn sàng"
fi
if [ -x /usr/sbin/setup-xorg-base ] && ! [ -d /sys/class/graphics/fb0 ]; then :; fi
exit 0
"""

TUNE = """#!/bin/sh
# NEXUS Gaming — tuning hiệu năng cho VM (chạy ở runlevel local)
sysctl -w vm.swappiness=10 2>/dev/null || true
sysctl -w vm.vfs_cache_pressure=50 2>/dev/null || true
modprobe zram 2>/dev/null || true
if [ -w /sys/block/zram0/disksize ]; then
  echo 2G > /sys/block/zram0/disksize 2>/dev/null || true
  mkswap /dev/zram0 2>/dev/null || true
  swapon -p 10 /dev/zram0 2>/dev/null || true
fi
exit 0
"""


def add_text(tf: tarfile.TarFile, name: str, data: str, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(name)
    payload = data.encode('utf-8')
    info.size = len(payload)
    info.mode = mode
    tf.addfile(info, io.BytesIO(payload))


def add_symlink(tf: tarfile.TarFile, name: str, target: str) -> None:
    info = tarfile.TarInfo(name)
    info.type = tarfile.SYMTYPE
    info.linkname = target
    info.mode = 0o777
    tf.addfile(info)


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    variant, keys_dir, out = sys.argv[1:4]
    spec = VARIANTS.get(variant)
    if not spec:
        print(f"::error::variant lạ: {variant} (desktop|gaming|rescue)", file=sys.stderr)
        return 1
    if not os.path.isdir(keys_dir):
        print(f"::error::thiếu keys_dir: {keys_dir}", file=sys.stderr)
        return 1

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tf:
        # 1) Bản sắc hệ điều hành — neofetch/lsb đọc từ đây → "NEXUS Linux"
        add_text(tf, 'etc/os-release', (
            'NAME="NEXUS Linux"\n'
            f'PRETTY_NAME="{spec["pretty"]}"\n'
            'ID=nexus\nID_LIKE=alpine\n'
            'VERSION_ID="1.0"\n'
            'HOME_URL="https://github.com/victoryvpsvn-star/nexus-optimizer"\n'
            'SUPPORT_URL="https://github.com/victoryvpsvn-star/nexus-optimizer"\n'
            'DEFAULT_ASCII_ART="nexus"\n'))
        add_text(tf, 'etc/hostname', 'nexus\n')
        add_text(tf, 'etc/motd', (
            'NEXUS Linux 1.0 — chào mừng bro!\n'
            '  Cài gói   : nx install <gói>\n'
            '  Xem giúp  : nx\n'))
        # 2) nx — trình quản lý gói thay apt
        add_text(tf, 'usr/bin/nx', NX_SCRIPT, mode=0o755)
        add_text(tf, 'usr/bin/nexfetch', NEXFETCH, mode=0o755)
        # 3) neofetch khi login
        add_text(tf, 'etc/profile.d/00-nexus-welcome.sh', WELCOME, mode=0o755)
        # 4) Mạng DHCP — Hyper-V Default Switch cấp IP tự động
        add_text(tf, 'etc/network/interfaces', (
            'auto lo\niface lo inet loopback\n\n'
            'auto eth0\niface eth0 inet dhcp\n'))
        # 5) apk repositories — ưu tiên repo local trên ISO (offline), CDN dự phòng
        add_text(tf, 'etc/apk/repositories', (
            '/media/cdrom/nxapks\n'
            '# muốn cài thêm online: bỏ dấu # dòng dưới\n'
            '# https://dl-cdn.alpinelinux.org/alpine/v3.21/main\n'
            '# https://dl-cdn.alpinelinux.org/alpine/v3.21/community\n'))
        # 6) world — danh sách gói variant; Alpine boot tự cài từ /media/cdrom/apks
        add_text(tf, 'etc/apk/world', '\n'.join(spec['world']) + '\n')
        # 7) Public key ký repo local (tránh --allow-untrusted)
        for fn in sorted(os.listdir(keys_dir)):
            if fn.endswith('.rsa.pub'):
                with open(os.path.join(keys_dir, fn), 'rb') as f:
                    add_text(tf, f'etc/apk/keys/{fn}', f.read().decode('utf-8'))
        # 8) Runlevels: service tự bật khi boot
        for svc in spec['runlevels']:
            add_symlink(tf, f'etc/runlevels/default/{svc}', f'/etc/init.d/{svc}')
        # 9) Banner + (gaming) tuning script
        add_text(tf, 'etc/local.d/nexus.start', NEXUS_START, mode=0o755)
        if variant == 'gaming':
            add_text(tf, 'etc/local.d/nexus-tune.start', TUNE, mode=0o755)

    with open(out, 'wb') as f:
        f.write(buf.getvalue())
    print(f'OK: {out} — variant={variant}, world={len(spec["world"])} gói, '
          f'{os.path.getsize(out)} bytes')
    return 0


if __name__ == '__main__':
    sys.exit(main())
