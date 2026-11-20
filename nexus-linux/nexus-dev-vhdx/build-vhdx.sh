#!/bin/bash
# NEXUS Linux Dev VHDX — hệ Debian bookworm CÀI SẴN trong disk Hyper-V (ext4, boot UEFI Gen 2)
# Đặc điểm:
#   - KHÔNG cần losetup: sfdisk trên file + mke2fs -E offset -d + ESP qua mtools + qemu-img → VHDX
#   - updisk: gõ 1 lệnh là mở rộng partition + filesystem dùng hết disk còn trống (sau khi nâng disk VM)
#   - Dựng từ cùng package list v3 (nexus-dev) — giữ tool dev + Kali-style, thêm openssh-server
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)          # gốc repo (thư mục chứa nexus-linux/)
DEV="$REPO/nexus-linux/nexus-dev"
VHDXDIR="$REPO/nexus-linux/nexus-dev-vhdx"
R=/tmp/rootfs
IMG=/tmp/nexus.raw
ESP=/tmp/esp.img
OUT="$REPO/nexus-linux-dev.vhdx"
P1_START=2048        # ESP
P1_SECTORS=409600    # 200MB
P2_START=411648      # root ext4

echo "=== [1/8] deps container ==="
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    debootstrap qemu-utils dosfstools mtools uuid-runtime gpgv debian-archive-keyring \
    fdisk e2fsprogs util-linux file xz-utils curl ca-certificates >/dev/null

echo "=== [2/8] debootstrap minbase bookworm ==="
rm -rf "$R" "$IMG" "$ESP" "$OUT"
mkdir -p "$R"
debootstrap --variant=minbase --arch=amd64 bookworm "$R" http://deb.debian.org/debian

echo "=== [3/8] includes (dpkg excludes BỎ docs/man/locale + nx/nexfetch/motd/zram/earlyoom/pip.conf) ==="
cp -a "$DEV/config/includes.chroot/." "$R/"
cp -a "$VHDXDIR/includes/." "$R/"
chmod +x "$R/usr/bin/nx" "$R/usr/bin/nexfetch" "$R/usr/bin/updisk"
chmod 0440 "$R/etc/sudoers.d/nexus" 2>/dev/null || true

# dọn docs/locale mà debootstrap đã bung (path-exclude chỉ có tác dụng sau khi copy cfg)
# LƯU Ý: phải GIỮ cấu trúc dir en + en_GB — dpkg path-include cần parent dirs, thiếu → ENOENT khi bung .mo
rm -rf "$R/usr/share/doc"/* "$R/usr/share/man"/* "$R/usr/share/info"/* "$R/usr/share/icons"/* 2>/dev/null || true
find "$R/usr/share/locale" -mindepth 1 -maxdepth 1 -type d ! -name en ! -name en_GB -exec rm -rf {} + 2>/dev/null || true
rm -f "$R/usr/share/locale/en"/*/*.mo "$R/usr/share/locale/en_GB"/*/*.mo 2>/dev/null || true
mkdir -p "$R/usr/share/locale/en/LC_MESSAGES" "$R/usr/share/locale/en_GB/LC_MESSAGES"

echo "=== [4/8] config hệ thống ==="
mkdir -p "$R/etc/apt" "$R/boot/grub" "$R/boot/efi"
cat > "$R/etc/apt/sources.list" <<'EOF'
deb http://deb.debian.org/debian bookworm main contrib non-free non-free-firmware
deb http://deb.debian.org/debian bookworm-updates main contrib non-free non-free-firmware
deb http://deb.debian.org/debian-security bookworm-security main contrib non-free non-free-firmware
EOF
echo nexus > "$R/etc/hostname"
printf '127.0.0.1\tlocalhost\n127.0.1.1\tnexus nexus\n::1\t\tlocalhost ip6-localhost ip6-loopback\n' > "$R/etc/hosts"
printf 'LANG=C.UTF-8\n' > "$R/etc/default/locale"
# branding NEXUS (ID=debian + debian_version giu nguyen — apt/unattended/fail2ban an toan)
sed -i 's/^PRETTY_NAME=.*/PRETTY_NAME="NEXUS Linux Dev v4 (bookworm core)"/' "$R/usr/lib/os-release"
sed -i 's/^NAME=.*/NAME="NEXUS Linux Dev"/' "$R/usr/lib/os-release"
printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' > "$R/etc/resolv.conf"
cat > "$R/etc/sudoers.d/nexus" <<'EOF'
nexus ALL=(ALL) NOPASSWD:ALL
EOF
chmod 0440 "$R/etc/sudoers.d/nexus"
: > "$R/etc/machine-id"   # minbase chưa có systemd — để rỗng, systemd tự sinh lần boot đầu
# chặn dịch vụ khởi động trong chroot
echo exit 101 > "$R/usr/sbin/policy-rc.d"
chmod +x "$R/usr/sbin/policy-rc.d"
# motd: override gon tu includes/etc/motd (banner nexfetch chi tren console qua profile.d)

# mount proc/dev/sys cho chroot (privileged container — ssh-keygen, depmod cần /dev)
mount -t proc proc "$R/proc" 2>/dev/null || true
mount --bind /dev "$R/dev" 2>/dev/null || true
mount --bind /sys "$R/sys" 2>/dev/null || true

chroot_env() { chroot "$R" env DEBIAN_FRONTEND=noninteractive "$@"; }

echo "=== [5/8] apt run 1: grub-efi + openssh + ifupdown + growpart + toolset v3 ==="
# đọc package list v3, bỏ phần live-only
PKGS=$(grep -v '^#' "$DEV/config/package-lists/nexus-dev.list.chroot" | grep -v '^$' \
       | grep -v -x -e 'live-boot' -e 'live-config' -e 'user-setup' -e 'linux-image-cloud-amd64' -e 'initramfs-tools')
RUN1="sudo ifupdown openssh-server isc-dhcp-client nftables unattended-upgrades zram-tools libncursesw6 grub-efi-amd64 grub-efi-amd64-signed shim-signed cloud-guest-utils parted initramfs-tools zstd $PKGS"
chroot_env apt-get -y update -qq
# force-confdef/confold: file config include sẵn giữ nguyên, dpkg không bao giờ hỏi conffile (EOF = chết)
DPGOPT='-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold'
chroot_env apt-get -y $DPGOPT install --no-install-recommends $RUN1 >/dev/null
# chặn update-grub (grub.cfg viết tay ở bước 7)
rm -f "$R/etc/kernel/postinst.d/zz-update-grub" "$R/etc/kernel/postrm.d/zz-update-grub"

# BẮT BUỘC driver storage/mang vào initramfs — 'most' của initramfs-tools đã bỏ sót AHCI
# (boot test qemu bắt được: "Gave up waiting for root file system device")
cat > "$R/etc/initramfs-tools/modules" <<'EOF'
ahci
sd_mod
ata_piix
hv_storvsc
hv_netvsc
virtio_blk
virtio_scsi
virtio_net
virtio_pci
nvme
xhci_pci
ehci_pci
usb_storage
uas
EOF
sed -i 's/^MODULES=.*/MODULES=most/'  "$R/etc/initramfs-tools/initramfs.conf"
sed -i 's/^COMPRESS=.*/COMPRESS=zstd/' "$R/etc/initramfs-tools/initramfs.conf"

# hardening/tuning services: fail2ban (sshd jail) + zram swap — enable tường minh cho chac
chroot "$R" systemctl enable nftables.service zramswap.service fstrim.timer >/dev/null 2>&1 || echo "WARN: enable nftables/zramswap/fstrim loi (kiem tra log)"
# alpine-grade: chi giu getty tty1 + serial — tty2-6 la RAM ao khong can
for i in 2 3 4 5 6; do ln -sfn /dev/null "$R/etc/systemd/system/getty@tty$i.service"; done
# PAM: nhan nexus-idle hook (pam_exec) — phai sau khi libpam-runtime co mat (openssh run1)
chroot "$R" pam-auth-update --package >/dev/null 2>&1 || echo "WARN: pam-auth-update loi (hook idle khong kich hoat)"
# pam-auth-update trong chroot khong nhat dinh nhan pam-configs ngoai dpkg -> ghi truc tiep cho chac
grep -q pam_exec "$R/etc/pam.d/common-session" || \
  echo 'session optional pam_exec.so /usr/local/sbin/nexus-session.sh' >> "$R/etc/pam.d/common-session"
grep -q pam_exec "$R/etc/pam.d/common-session" && echo "pam_exec nexus-idle: DA vao common-session" || echo "WARN: pam_exec chua co trong common-session"

echo "=== [6/8] apt run 2: kernel cloud-amd64 (initramfs tự tạo) ==="
chroot_env apt-get -y $DPGOPT install --no-install-recommends linux-image-cloud-amd64 >/dev/null
KVER=$(ls "$R"/boot/vmlinuz-* | sed 's|.*/vmlinuz-||' | head -1)
echo "kernel: $KVER"
echo "--- driver trong initramfs (diagnostic):"
chroot "$R" lsinitramfs "/boot/initrd.img-$KVER" | grep -E 'ahci\.ko|sd_mod\.ko|hv_storvsc\.ko|virtio_blk\.ko' | head -6 || echo "WARN: khong thay driver storage trong initramfs!"

echo "=== [6.5/8] KERNEL NEXUS RIÊNG (kernel.org 6.1.100 → vmlinuz-*-nexus1) ==="
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends build-essential bc bison flex libelf-dev libssl-dev >/dev/null 2>&1 || true
cd /tmp
[ -f linux-6.1.100.tar.xz ] || curl -fSL --retry 3 -o linux-6.1.100.tar.xz https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.1.100.tar.xz
tar -xf linux-6.1.100.tar.xz
cd linux-6.1.100
make defconfig
while IFS= read -r line; do
    case "$line" in
        CONFIG_*=y) opt="${line#CONFIG_}"; scripts/config --enable "${opt%=y}" ;;
        CONFIG_*=n) opt="${line#CONFIG_}"; scripts/config --disable "${opt%=n}" ;;
        CONFIG_LOCALVERSION=*) raw="${line#CONFIG_LOCALVERSION=}"; raw="${raw%\\"}"; raw="${raw#\\"}"; scripts/config --set-str LOCALVERSION "$raw" ;;
        CONFIG_DEFAULT_HOSTNAME=*) raw="${line#CONFIG_DEFAULT_HOSTNAME=}"; raw="${raw%\\"}"; raw="${raw#\\"}"; scripts/config --set-str DEFAULT_HOSTNAME "$raw" ;;
    esac
done < "$VHDXDIR/kernel/nexus.config"
make olddefconfig
KVN=$(make -s kernelrelease)
echo "NEXUS kernel: $KVN ($(grep -c CONFIG_ "$VHDXDIR/kernel/nexus.config") overrides trên defconfig)"
make -j"$(nproc)" bzImage
make INSTALL_MOD_PATH="$R" INSTALL_MOD_STRIP=1 modules_install >/dev/null 2>&1
cp arch/x86/boot/bzImage "$R/boot/vmlinuz-$KVN"
chroot "$R" depmod -a "$KVN" 2>/dev/null || true
chroot "$R" mkinitramfs -o "/boot/initrd.img-$KVN" "$KVN"
cd /tmp

echo "=== [6.6/8] NPS — gói NEXUS tự build từ source (tree, htop) → .nxp → repo nội bộ ==="
chmod 755 "$R/usr/lib/nexus/nxpkg"
grep -q '^deb-src' /etc/apt/sources.list 2>/dev/null || echo "deb-src http://deb.debian.org/debian bookworm main" >> /etc/apt/sources.list
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends autoconf automake pkg-config libncurses-dev dpkg-dev >/dev/null 2>&1 || true
mkdir -p "$R/var/lib/nx/repo" "$R/var/lib/nx/db"
NPSSRC=$(mktemp -d); cd "$NPSSRC"
if apt-get source tree >/dev/null 2>&1; then
    TRDIR=$(find . -maxdepth 1 -type d -name 'tree-*' | head -1)
    make -C "$TRDIR" -j"$(nproc)" >/dev/null 2>&1 && cp "$TRDIR/tree" "$R/usr/bin/tree" && chmod 755 "$R/usr/bin/tree" && echo "tree: build OK"
fi
if apt-get source htop >/dev/null 2>&1; then
    HTDIR=$(find . -maxdepth 1 -type d -name 'htop-*' | head -1)
    ( cd "$HTDIR" && { [ -x ./configure ] || ./autogen.sh >/dev/null 2>&1; } && ./configure --prefix=/usr >/dev/null 2>&1 && make -j"$(nproc)" >/dev/null 2>&1 ) && cp "$HTDIR/htop" "$R/usr/bin/htop" && chmod 755 "$R/usr/bin/htop" && echo "htop: build OK"
fi
NPSROOT="$R" "$R/usr/lib/nexus/nxpkg" build tree 2.1.0 "NEXUS tree — liệt kê thư mục dạng cây (build từ source)" /usr/bin/tree || echo "WARN: nxp tree"
NPSROOT="$R" "$R/usr/lib/nexus/nxpkg" build htop 3.2.2 "NEXUS htop — monitor process (build từ source)" /usr/bin/htop || echo "WARN: nxp htop"
NPSROOT="$R" "$R/usr/lib/nexus/nxpkg" install tree >/dev/null 2>&1 || true
NPSROOT="$R" "$R/usr/lib/nexus/nxpkg" install htop >/dev/null 2>&1 || true
cd /tmp

echo "=== [7/8] user + UUID + grub.cfg + image ==="
chroot "$R" useradd -m -s /bin/bash -G sudo nexus
chroot "$R" bash -c 'echo nexus:nexus | chpasswd; echo root:root | chpasswd'

ROOTUUID=$(uuidgen)
ESPIMG_UUID=4E455853   # FAT UUID = 4E45-5853
cat > "$R/etc/fstab" <<EOF
UUID=$ROOTUUID  /         ext4  defaults,noatime,commit=60  0 1
UUID=4E45-5853  /boot/efi vfat  defaults,umask=0077        0 2
tmpfs           /tmp      tmpfs rw,nosuid,nodev,noexec,mode=1777,size=256M  0 0
EOF
cat > "$R/boot/grub/grub.cfg" <<EOF
set default=0
set timeout=3
menuentry 'NEXUS Linux Dev — kernel NEXUS ($KVN)' {
    linux /boot/vmlinuz-$KVN root=UUID=$ROOTUUID ro rootdelay=3 fsck.repair=yes quiet console=tty1 console=ttyS0,115200n8
    initrd /boot/initrd.img-$KVN
}
menuentry 'NEXUS Linux Dev — kernel Debian cloud (fallback)' {
    linux /boot/vmlinuz-$KVER root=UUID=$ROOTUUID ro rootdelay=3 fsck.repair=yes quiet console=tty1 console=ttyS0,115200n8
    initrd /boot/initrd.img-$KVER
}
EOF

# NPS runtime thuần NEXUS: gỡ repo Debian khỏi image (nx apt-on bật lại khi thật sự cần)
mv "$R/etc/apt/sources.list" "$R/etc/apt/sources.list.nexus-disabled" 2>/dev/null || true

# đo dung lượng → chia partition vừa đủ (+25% slack, min 2GB, max 4GB)
umount -l "$R/proc" 2>/dev/null || true; umount -l "$R/sys" 2>/dev/null || true; umount -l "$R/dev" 2>/dev/null || true
USED_MB=$(du -sm --exclude="$R/proc" --exclude="$R/sys" --exclude="$R/dev" "$R" | cut -f1)
RAW_MB=$(( (USED_MB * 13 / 10 + 500 + 255) / 256 * 256 ))
[ "$RAW_MB" -lt 2048 ] && RAW_MB=2048
[ "$RAW_MB" -gt 4096 ] && RAW_MB=4096
ROOT_SECTORS=$(( (RAW_MB - 202) * 2048 ))
ROOT_BLOCKS=$(( ROOT_SECTORS * 512 / 4096 ))
echo "rootfs dùng ${USED_MB}MB → disk ${RAW_MB}MB (p2 ${ROOT_BLOCKS} blocks)"

# file raw SPARSE — qemu-img convert sau đó sẽ bỏ vùng trống → VHDX file nhỏ gọn
truncate -s $((RAW_MB * 1024 * 1024)) "$IMG"

sfdisk --force "$IMG" <<EOF
label: dos
unit: sectors
start=$P1_START, size=$P1_SECTORS, type=ef
start=$P2_START, size=$ROOT_SECTORS, type=83
EOF

# ESP: FAT32 dựng riêng rồi dd vào vị trí p1 — KHÔNG mount
mkfs.vfat -C "$ESP" -F32 -i "$ESPIMG_UUID" -n ESP $((P1_SECTORS * 512 / 1024))
mmd -i "$ESP" ::/EFI ::/EFI/BOOT ::/EFI/debian
mcopy -i "$ESP" "$R/usr/lib/grub/x86_64-efi-signed/grubx64.efi.signed" ::/EFI/BOOT/BOOTX64.EFI
cat > /tmp/grub-stub.cfg <<EOF
search.fs_uuid $ROOTUUID root hd0,msdos2
set prefix=(\$root)'/boot/grub'
configfile \$prefix/grub.cfg
EOF
mcopy -i "$ESP" /tmp/grub-stub.cfg ::/EFI/debian/grub.cfg
mcopy -i "$ESP" /tmp/grub-stub.cfg ::/EFI/BOOT/grub.cfg
dd if="$ESP" of="$IMG" bs=512 seek=$P1_START conv=notrunc status=none

# root ext4 thẳng vào image tại offset p2,populate từ rootfs — KHÔNG mount
mke2fs -q -t ext4 -b 4096 -L NEXUS-DEV -U "$ROOTUUID" \
    -E offset=$((P2_START * 512)) -d "$R" "$IMG" "$ROOT_BLOCKS"

echo "=== [8/8] qemu-img → VHDX dynamic + kiểm tra ==="
rm -rf "$R" "$ESP"
qemu-img convert -O vhdx -o subformat=dynamic "$IMG" "$OUT"
rm -f "$IMG"
VSIZE=$(stat -c%s "$OUT")
test "$VSIZE" -gt 400000000 || { echo "::error::VHDX quá nhỏ: $VSIZE"; exit 1; }
echo "VHDX OK: $VSIZE bytes ($(numfmt --to=iec $VSIZE))"
sha256sum "$OUT"
