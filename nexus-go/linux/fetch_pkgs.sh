#!/bin/sh
# NEXUS Linux — fetch gói variant + tự ký repo local (chạy trong alpine docker)
# Usage: fetch_pkgs.sh <variant> <build_dir>
set -e
V="$1"; BUILD="$2"
# docker alpine mac dinh chi co repo MAIN — firefox/flatpak thuoc COMMUNITY!
cat > /etc/apk/repositories <<'EOF'
https://dl-cdn.alpinelinux.org/alpine/v3.21/main
https://dl-cdn.alpinelinux.org/alpine/v3.21/community
EOF
apk update >/dev/null
apk add --no-cache abuild >/dev/null
case "$V" in
  desktop) PKGS="xfce4 xfce4-terminal lightdm lightdm-gtk-greeter firefox font-dejavu font-noto elogind dbus" ;;
  gaming)  PKGS="xfce4 xfce4-terminal lightdm lightdm-gtk-greeter firefox font-dejavu font-noto elogind dbus flatpak htop" ;;
  rescue)  PKGS="htop" ;;
  *) echo "variant lạ: $V"; exit 1 ;;
esac
mkdir -p "$BUILD/apks/$V/x86_64"
abuild-keygen -an >/dev/null 2>&1
KEY=$(find /root/.abuild -name '*.rsa' | head -1)
mkdir -p "$BUILD/keys/$V"
cp "$KEY.pub" "$BUILD/keys/$V/"
echo "$V: apk fetch -R $PKGS"
apk fetch -R -o "$BUILD/apks/$V/x86_64" $PKGS
cd "$BUILD/apks/$V/x86_64"
apk index --quiet -o APKINDEX.apk *.apk 2>/dev/null || apk index -o APKINDEX.apk *.apk
abuild-sign -q -k "$KEY" APKINDEX.apk
echo "$V: $(ls *.apk | wc -l) gói + APKINDEX ký OK"
