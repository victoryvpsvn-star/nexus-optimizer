#!/bin/bash
# build-nano-iso.sh — NEXUS NANO v2: LIVE ISO (kernel nexus + rootfs initramfs trong RAM)
# Mục đích: boot từ DVD Hyper-V Gen 2 KHÔNG cần driver disk nào (storvsc/ahci/virtio không cần
# để lên hệ) — dùng để chẩn đoán: nếu ISO boot trong khi VHDX đứng im sau GRUB thì vấn đề nằm
# ở đường disk, không phải kernel. Nếu ISO cũng đứng im → đọc log serial COM để thấy kernel chết ở đâu.
# Boot: El Torito UEFI (grub unsigned tự build bằng grub-mkimage — kernel unsigned nên vẫn phải
# tắt Secure Boot). KHÔNG BIOS/Gen 1 — nhắm đúng Gen 2 UEFI, giảm số biến thể phải test.
set -euo pipefail
cd "$(dirname "$0")"
NANODIR="$(pwd)"
R=/tmp/nano-iso-rootfs
ESP=/tmp/nano-iso-esp.img
OUT="$NANODIR/../../nexus-v2.iso"

echo "=== [1/7] deps container ==="
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  build-essential bc bison flex libelf-dev libssl-dev kmod xz-utils curl ca-certificates \
  dosfstools mtools uuid-runtime cpio gzip file bash openssl xorriso >/dev/null
grep -q '^deb-src' /etc/apt/sources.list 2>/dev/null || echo "deb-src http://deb.debian.org/debian bookworm main" >> /etc/apt/sources.list
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends dpkg-dev grub-efi-amd64-bin busybox-static dropbear-bin nftables >/dev/null

echo "=== [2/7] KERNEL NEXUS MINI (cùng nexus-mini.config — có initrd cho ISO) ==="
cd /tmp
[ -f linux-6.1.100.tar.xz ] || curl -fSL --retry 3 -o linux-6.1.100.tar.xz https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.1.100.tar.xz
[ -d linux-6.1.100 ] || tar -xf linux-6.1.100.tar.xz
cd linux-6.1.100
make allnoconfig
while IFS= read -r line; do
    case "$line" in
        CONFIG_*=y) opt="${line#CONFIG_}"; scripts/config --enable "${opt%=y}" ;;
        CONFIG_*=n) opt="${line#CONFIG_}"; scripts/config --disable "${opt%=n}" ;;
    esac
done < "$NANODIR/nexus-mini.config"
make olddefconfig
sed -i 's/^CONFIG_LOCALVERSION=.*/CONFIG_LOCALVERSION="-nexus1"/' .config
grep -q '^CONFIG_LOCALVERSION=' .config || echo 'CONFIG_LOCALVERSION="-nexus1"' >> .config
make olddefconfig
for k in VIRTIO_MENU VIRTIO VIRTIO_PCI VIRTIO_BLK VIRTIO_NET EXT4_FS DEVTMPFS SERIAL_8250_CONSOLE BINFMT_ELF ACPI PCI HYPERV SCSI BLK_DEV_SD NF_TABLES_INET ZRAM BLK_DEV_INITRD RD_GZIP ISO9660_FS BLK_DEV_SR ATA ATA_PIIX SATA_AHCI MSDOS_PARTITION EFI_PARTITION; do
    grep -q "^CONFIG_${k}=y" .config || { echo "::error::CONFIG_${k} mat trong .config (guard menuconfig bi allnoconfig cat)"; grep "CONFIG_${k}[= ]" .config || true; exit 1; }
done
echo "CONFIG assert OK"
make -j"$(nproc)"
KVN=$(make -s kernelrelease)
echo "NANO ISO kernel release: $KVN"

echo "=== [3/7] userland: giống VHDX (busybox + dropbear + nft + bash + users) ==="
rm -rf "$R"
mkdir -p "$R"/{boot,bin,sbin,usr/bin,usr/sbin,usr/lib/nexus,usr/share/udhcpc,etc/dropbear,var/lib/nx/repo,var/lib/nx/db,var/log,var/run,root,home/nexus,dev,proc,sys,tmp,run,mnt,lib64}
cp /bin/busybox "$R/bin/busybox"
chroot "$R" /bin/busybox --install -s /bin >/dev/null 2>&1
ln -sf /bin/busybox "$R/sbin/init"
ln -sf /sbin/init "$R/init"
ln -sf /bin/busybox "$R/bin/sh"
cp -L /bin/bash "$R/bin/bash"
cp /usr/sbin/dropbear "$R/usr/sbin/dropbear"
cp /usr/bin/dropbearkey "$R/usr/bin/dropbearkey"
cp /usr/sbin/nft "$R/usr/sbin/nft"
copy_libs() {
    for b in "$@"; do
        ldd "$b" | awk '/=> \//{print $3} !/=> \// && /^\t/{print $1}' | while read -r l; do
            [ -f "$l" ] || continue
            mkdir -p "$R$(dirname "$l")"
            cp -L "$l" "$R$l"
        done
    done
}
copy_libs /bin/bash /usr/sbin/dropbear /usr/bin/dropbearkey /usr/sbin/nft
cp "$NANODIR/../nexus-dev/config/includes.chroot/usr/bin/nx" "$R/usr/bin/nx"
cp "$NANODIR/../nexus-dev-vhdx/includes/usr/lib/nexus/nxpkg" "$R/usr/lib/nexus/nxpkg"
cp "$NANODIR/../nexus-dev-vhdx/includes/etc/nftables.conf" "$R/etc/nftables.conf"
chmod 755 "$R/usr/bin/nx" "$R/usr/lib/nexus/nxpkg" "$R/usr/sbin/dropbear" "$R/usr/sbin/nft"
/usr/bin/dropbearkey -t rsa -s 2048 -f "$R/etc/dropbear/dropbear_rsa_host_key" >/dev/null 2>&1
RH=$(openssl passwd -6 -salt nx1 root)
NH=$(openssl passwd -6 -salt nx1 nexus)
cat > "$R/etc/passwd" <<EOF
root:x:0:0:root:/root:/bin/bash
nexus:x:1000:1000:nexus:/home/nexus:/bin/sh
EOF
cat > "$R/etc/shadow" <<EOF
root:$RH:20000:0:99999:7:::
nexus:$NH:20000:0:99999:7:::
EOF
cat > "$R/etc/group" <<EOF
root:x:0:
nexus:x:1000:
EOF
chmod 644 "$R/etc/passwd" "$R/etc/group"
chmod 600 "$R/etc/shadow"
cat > "$R/etc/inittab" <<'EOF'
::sysinit:/etc/rcS
::respawn:/usr/sbin/dropbear -F -p 22
ttyS0::respawn:/bin/sh -i
::ctrlaltdel:/bin/reboot
EOF
cat > "$R/etc/rcS" <<'EOF'
#!/bin/sh
# initramfs KHONG duoc kernel auto-mount devtmpfs (prepare_namespace chi chay cho root= device)
# — phải tự mount để có /dev/ttyS0 (shell serial + dropbear) và /dev/urandom
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
[ -c /dev/ttyS0 ] || mknod /dev/ttyS0 c 4 64 2>/dev/null || true
[ -c /dev/console ] || mknod /dev/console c 5 1 2>/dev/null || true
[ -c /dev/null ] || mknod /dev/null c 1 3 2>/dev/null || true
[ -c /dev/urandom ] || mknod /dev/urandom c 1 9 2>/dev/null || true
mount -t proc proc /proc 2>/dev/null
mount -t sysfs sysfs /sys 2>/dev/null
mkdir -p /dev/pts /dev/shm /var/run /var/log /tmp
mount -t devpts devpts /dev/pts 2>/dev/null
mount -t tmpfs -o mode=1777 tmpfs /tmp 2>/dev/null
hostname nexus
IF=$(ls /sys/class/net 2>/dev/null | grep -v lo | head -1)
ip link set lo up 2>/dev/null
[ -n "$IF" ] && ip link set "$IF" up 2>/dev/null && udhcpc -b -i "$IF" >/dev/null 2>&1
nft -f /etc/nftables.conf 2>/dev/null || echo "[nexus] nft ruleset fail (bo qua)"
if [ -e /dev/zram0 ]; then
    echo 33554432 > /sys/block/zram0/disksize 2>/dev/null || true
    mkswap /dev/zram0 >/dev/null 2>&1 && swapon /dev/zram0 >/dev/null 2>&1 || true
fi
echo NANO-READY
EOF
chmod +x "$R/etc/rcS"
cp /usr/share/udhcpc/default.script "$R/usr/share/udhcpc/default.script" 2>/dev/null || true
chmod +x "$R/usr/share/udhcpc/default.script" 2>/dev/null || true
cat > "$R/etc/motd" <<'EOF'
NEXUS NANO v2 LIVE — kernel 6.1.100-nexus1 · rootfs nằm trong RAM (initramfs) · busybox + dropbear · NPS (nx)
  SSH    : root@<ip> (mk: root) | console serial sh trực tiếp
  PKG    : nx install|remove|search|info|list|verify — repo nội bộ NEXUS
  CD     : mount -t iso9660 /dev/sr0 /mnt (driver CD builtin)
  Dùng để: chẩn đoán Hyper-V (boot DVD không cần disk driver) + cứu hộ
EOF

echo "=== [4/7] NPS — tree build từ source → .nxp → repo nội bộ ==="
NPSSRC=$(mktemp -d); cd "$NPSSRC"
apt-get source tree >/dev/null 2>&1 || true
TRDIR=$(find . -maxdepth 1 -type d -name 'tree-*' | head -1 || true)
if [ -n "$TRDIR" ]; then
    make -C "$TRDIR" -j"$(nproc)" >/dev/null 2>&1 && cp "$TRDIR/tree" "$R/usr/bin/tree" && chmod 755 "$R/usr/bin/tree" && echo "tree: build OK"
fi
NPSROOT="$R" "$R/usr/lib/nexus/nxpkg" build tree 2.1.0 "NEXUS tree — cây thư mục (build từ source)" /usr/bin/tree || echo "WARN: nxp tree"
NPSROOT="$R" "$R/usr/lib/nexus/nxpkg" install tree >/dev/null 2>&1 || true
test -x "$R/usr/bin/tree" && echo "[nx] tree co trong rootfs" || echo "[nx] WARN: tree khong co trong rootfs"
chroot "$R" /usr/bin/tree --version >/dev/null 2>&1 && echo "[nx] tree --version OK (rootfs)" || echo "[nx] WARN: tree khong chay trong rootfs"
cd /tmp

echo "=== [5/7] initramfs (rootfs trong RAM) ==="
( cd "$R" && find . -print0 | cpio --null -o -H newc --quiet ) | gzip -9 > /tmp/nano-initrd.gz
IRSIZE=$(stat -c%s /tmp/nano-initrd.gz)
KIMG=/tmp/linux-6.1.100/arch/x86/boot/bzImage
KSIZE=$(stat -c%s "$KIMG")
echo "initramfs: $IRSIZE bytes · bzImage: $KSIZE bytes"
test "$IRSIZE" -lt 60000000 || { echo "::error::initramfs quá lớn: $IRSIZE bytes"; exit 1; }

echo "=== [6/7] ESP FAT16 16MB (chỉ grub) + grub unsigned có iso9660 — grub.cfg/kernel/initrd nằm trên ISO9660 ==="
cat > /tmp/nano-early.cfg <<'EOF'
search --no-floppy --file --set=root /boot/grub/grub.cfg
set prefix=($root)/boot/grub
normal
EOF
grub-mkimage -O x86_64-efi -o /tmp/grubx64.efi -p '/EFI/BOOT' -c /tmp/nano-early.cfg \
  search search_fs_file fat iso9660 linux normal echo boot ls part_gpt part_msdos efi_gop
cat > /tmp/nano-grub.cfg <<'EOF'
set default=0
set timeout=3
menuentry 'NEXUS NANO v2 — live (kernel nexus, rootfs trong RAM)' {
    search --no-floppy --file --set=root /boot/vmlinuz-nexus
    linux /boot/vmlinuz-nexus console=ttyS0,115200n8 loglevel=7 panic=10
    initrd /boot/initrd.gz
}
menuentry 'NEXUS NANO v2 — rescue sh trực tiếp' {
    search --no-floppy --file --set=root /boot/vmlinuz-nexus
    linux /boot/vmlinuz-nexus console=ttyS0,115200n8 loglevel=7 panic=10 init=/bin/sh
    initrd /boot/initrd.gz
}
EOF
cat > /tmp/nano-readme.txt <<'EOF'
NEXUS NANO v2 — LIVE ISO (kernel 6.1.100-nexus1 + rootfs trong RAM)

Hyper-V Gen 2:
1. Set-VMDvdDrive -VMName nexus -Path .\nexus-v2.iso   (GIỮ disk VHDX cũ)
2. TẮT SECURE BOOT (kernel unsigned): VM Settings → Security → bỏ tick
   hoặc: Set-VMFirmware -VMName nexus -EnableSecureBoot Off
3. COM để đọc log serial (màn hình video sẽ KHÔNG bao giờ in gì sau GRUB
   — kernel này không có framebuffer console, output chỉ đi COM1):
   Set-VMComPort -VMName nexus -Number 1 -Path \\.\pipe\nexus
   → PuTTY: Connection type = Serial, Serial line = \\.\pipe\nexus, Speed = 115200
4. Start VM → chờ ~20-60s → thấy "NANO-READY" trên COM
5. SSH: root@<ip> mật khẩu root  (hoặc sh trực tiếp trên COM)
6. Trong hệ: mount -t iso9660 /dev/sr0 /mnt để đọc lại CD này

Kernel + config nằm sẵn trên CD: /boot/vmlinuz-nexus, /boot/config-nexus.txt (đọc bằng mount -t iso9660)
EOF
mkfs.vfat -C "$ESP" -F16 -n NEXUSBOOT 16384
mmd -i "$ESP" ::/EFI ::/EFI/BOOT ::/EFI/debian
mcopy -i "$ESP" /tmp/grubx64.efi ::/EFI/BOOT/BOOTX64.EFI
mcopy -i "$ESP" /tmp/nano-grub.cfg ::/EFI/BOOT/grub.cfg
mcopy -i "$ESP" /tmp/nano-grub.cfg ::/EFI/debian/grub.cfg

echo "=== [7/7] ISO El Torito UEFI (xorriso) ==="
rm -rf /tmp/isodir && mkdir -p /tmp/isodir/boot/grub
cp "$ESP" /tmp/isodir/efiboot.img
cp "$KIMG" /tmp/isodir/boot/vmlinuz-nexus
cp /tmp/nano-initrd.gz /tmp/isodir/boot/initrd.gz
cp /tmp/linux-6.1.100/.config /tmp/isodir/boot/config-nexus.txt
cp /tmp/nano-grub.cfg /tmp/isodir/boot/grub/grub.cfg
cp /tmp/nano-readme.txt /tmp/isodir/README.txt
xorriso -as mkisofs -V NEXUS_NANO_V2 -r -J -joliet-long \
  -e efiboot.img -no-emul-boot \
  -o "$OUT" /tmp/isodir
ISOSIZE=$(stat -c%s "$OUT")
test "$ISOSIZE" -lt 150000000 || { echo "::error::ISO quá nặng: $ISOSIZE (mục tiêu <= ~150MB)"; exit 1; }
rm -rf "$R"
echo "NANO ISO OK: $ISOSIZE bytes"
sha256sum "$OUT"
file "$OUT"
