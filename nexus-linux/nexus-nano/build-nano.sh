#!/bin/bash
# build-nano.sh — NEXUS NANO v1: kernel mini (allnoconfig, builtin, không modules/initramfs) + busybox + dropbear + NPS
# Mục tiêu: VHDX file ~<=160MB · RAM idle ~20-50MB · CPU ~0 (0.25 vCPU vẫn dư)
set -euo pipefail
cd "$(dirname "$0")"
NANODIR="$(pwd)"
R=/tmp/nano-rootfs
IMG=/tmp/nano.raw
ESP=/tmp/nano-esp.img
OUT="$NANODIR/../../nexus-linux-nano.vhdx"

echo "=== [1/6] deps container ==="
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  build-essential bc bison flex libelf-dev libssl-dev kmod xz-utils curl ca-certificates \
  qemu-utils dosfstools mtools uuid-runtime e2fsprogs fdisk file \
  busybox-static dropbear-bin nftables bash openssl >/dev/null
grep -q '^deb-src' /etc/apt/sources.list 2>/dev/null || echo "deb-src http://deb.debian.org/debian bookworm main" >> /etc/apt/sources.list
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends dpkg-dev grub-efi-amd64-signed grub-efi-amd64-bin shim-signed >/dev/null

echo "=== [2/6] KERNEL NEXUS MINI (allnoconfig + builtin — không modules, không initramfs) ==="
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
for k in VIRTIO_MENU VIRTIO VIRTIO_PCI VIRTIO_BLK VIRTIO_NET EXT4_FS DEVTMPFS SERIAL_8250_CONSOLE BINFMT_ELF ACPI PCI HYPERV SCSI BLK_DEV_SD NF_TABLES_INET ZRAM; do
    grep -q "^CONFIG_${k}=y" .config || { echo "::error::CONFIG_${k} mat trong .config (guard menuconfig bi allnoconfig cat)"; grep "CONFIG_${k}[= ]" .config || true; exit 1; }
done
echo "CONFIG assert OK"
make -j"$(nproc)"
KVN=$(make -s kernelrelease)
echo "NANO kernel release: $KVN"
rm -rf "$R"
mkdir -p "$R"/{boot/grub,bin,sbin,usr/bin,usr/sbin,usr/lib/nexus,usr/share/udhcpc,etc/dropbear,var/lib/nx/repo,var/lib/nx/db,var/log,var/run,root,home/nexus,dev,proc,sys,tmp,run,lib64}
cp arch/x86/boot/bzImage "$R/boot/vmlinuz-$KVN"
cp .config "$R/boot/config-$KVN"
cd /tmp

echo "=== [3/6] userland: busybox + dropbear + nft + bash + users ==="
cp /bin/busybox "$R/bin/busybox"
chroot "$R" /bin/busybox --install -s /bin >/dev/null 2>&1
ln -sf /bin/busybox "$R/sbin/init"
ln -sf /bin/busybox "$R/sbin/reboot"
ln -sf /bin/busybox "$R/sbin/poweroff"
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
mount -t proc proc /proc 2>/dev/null
mount -t sysfs sysfs /sys 2>/dev/null
mkdir -p /dev/pts /dev/shm /var/run /var/log /tmp
mount -t devpts devpts /dev/pts 2>/dev/null
mount -t tmpfs -o mode=1777 tmpfs /tmp 2>/dev/null
mount -o remount,rw / 2>/dev/null
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
NEXUS NANO v8 — kernel 6.1.100-nexus1 · busybox + dropbear · NPS (nx)
  SSH    : root@<ip> (mk: root) | console serial sh
  PKG    : nx install|remove|search|info|list|verify — repo nội bộ NEXUS
  Nhe    : ~0 daemon nền — RAM idle ~20-50MB · disk VHDX ~<=160MB
  Bao mat: SSH rate-limit nftables (kernel) — 0 RAM
EOF

echo "=== [4/6] NPS — tree build từ source → .nxp → repo nội bộ ==="
NPSSRC=$(mktemp -d); cd "$NPSSRC"
apt-get source tree >/dev/null 2>&1 || true
TRDIR=$(find . -maxdepth 1 -type d -name 'tree-*' | head -1 || true)
if [ -n "$TRDIR" ]; then
    make -C "$TRDIR" -j"$(nproc)" >/dev/null 2>&1 && cp "$TRDIR/tree" "$R/usr/bin/tree" && chmod 755 "$R/usr/bin/tree" && echo "tree: build OK"
fi
NPSROOT="$R" "$R/usr/lib/nexus/nxpkg" build tree 2.1.0 "NEXUS tree — cây thư mục (build từ source)" /usr/bin/tree || echo "WARN: nxp tree"
NPSROOT="$R" "$R/usr/lib/nexus/nxpkg" install tree >/dev/null 2>&1 || true
test -x "$R/usr/bin/tree" && echo "[nx] tree co trong rootfs" || echo "[nx] WARN: tree khong co trong rootfs"
ls "$R"/var/lib/nx/repo/*.nxp >/dev/null 2>&1 && echo "[nx] repo nxp OK: $(ls "$R"/var/lib/nx/repo/ | tr '\n' ' ')" || echo "[nx] WARN: repo khong co nxp ($REPO trong VM la /var/lib/nx/repo)"
chroot "$R" /usr/bin/tree --version >/dev/null 2>&1 && echo "[nx] tree --version OK (rootfs)" || echo "[nx] WARN: tree khong chay trong rootfs"
cd /tmp

echo "=== [5/6] ESP + grub (không initramfs — all builtin) ==="
P1_START=2048
P1_SECTORS=131072
P2_START=$((P1_START + P1_SECTORS))
IMG_SECTORS=327680
ROOT_SECTORS=$((IMG_SECTORS - P2_START))
ROOT_BLOCKS=$((ROOT_SECTORS * 512 / 4096))
ROOTUUID=$(uuidgen)
ESPIMG_UUID=4E455853
truncate -s $((IMG_SECTORS * 512)) "$IMG"
sfdisk --force "$IMG" <<EOF
label: dos
label-id: 0x4e455853
unit: sectors
start=$P1_START, size=$P1_SECTORS, type=ef
start=$P2_START, size=$ROOT_SECTORS, type=83
EOF
mkfs.vfat -C "$ESP" -F32 -i "$ESPIMG_UUID" -n ESP $((P1_SECTORS * 512 / 1024))
mmd -i "$ESP" ::/EFI ::/EFI/BOOT ::/EFI/debian
mcopy -i "$ESP" /usr/lib/grub/x86_64-efi-signed/grubx64.efi.signed ::/EFI/BOOT/BOOTX64.EFI
cat > /tmp/nano-grub-stub.cfg <<EOF
search.fs_uuid $ROOTUUID root hd0,msdos2
set prefix=(\$root)'/boot/grub'
configfile \$prefix/grub.cfg
EOF
mcopy -i "$ESP" /tmp/nano-grub-stub.cfg ::/EFI/debian/grub.cfg
mcopy -i "$ESP" /tmp/nano-grub-stub.cfg ::/EFI/BOOT/grub.cfg
dd if="$ESP" of="$IMG" bs=512 seek=$P1_START conv=notrunc status=none
cat > "$R/boot/grub/grub.cfg" <<EOF
set default=0
set timeout=1
menuentry 'NEXUS NANO (kernel nexus)' {
    linux /boot/vmlinuz-$KVN root=PARTUUID=4e455853-02 ro rootwait loglevel=7 panic=10 console=ttyS0,115200n8
}
EOF
# fs standalone de -U chac chan ap dung (quirk mke2fs -E offset) + verify doc lai + dd vao vi tri
truncate -s $((ROOT_SECTORS * 512)) /tmp/nano-root.img
mke2fs -q -t ext4 -b 4096 -L NEXUS-NANO -U "$ROOTUUID" -d "$R" /tmp/nano-root.img "$ROOT_BLOCKS"
U=$(blkid -o value -s UUID -p /tmp/nano-root.img 2>/dev/null || true)
[ "$U" = "$ROOTUUID" ] || { echo "::error::UUID ext4 khong khop: build=$ROOTUUID fs=$U"; exit 1; }
echo "[nx] rootfs UUID verify OK: $U"
dd if=/tmp/nano-root.img of="$IMG" bs=512 seek=$P2_START conv=notrunc status=none
rm -f /tmp/nano-root.img
rm -rf "$R" "$ESP"

echo "=== [6/6] qemu-img → VHDX dynamic ==="
qemu-img convert -O vhdx -o subformat=dynamic "$IMG" "$OUT"
rm -f "$IMG"
VSIZE=$(stat -c%s "$OUT")
test "$VSIZE" -lt 200000000 || { echo "::error::NANO quá nặng: $VSIZE (mục tiêu <= ~160MB)"; exit 1; }
echo "NANO VHDX OK: $VSIZE bytes"
sha256sum "$OUT"
