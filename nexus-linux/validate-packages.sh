#!/usr/bin/env bash
# NEXUS — kiểm tên gói trong file .list.chroot với index Debian bookworm main
# chạy TRƯỚC khi live-build để fail fast (bài học chuỗi fix Alpine).
set -euo pipefail
LIST="${1:?cần đường dẫn file .list.chroot}"
IDX=/tmp/nexus-bookworm-packages.txt
if [ ! -s "$IDX" ]; then
  echo "Tải index bookworm main (binary-amd64)..."
  curl -fsSL --retry 3 -o /tmp/Packages.gz \
    "http://deb.debian.org/debian/dists/bookworm/main/binary-amd64/Packages.gz"
  gunzip -c /tmp/Packages.gz | grep '^Package: ' | cut -d' ' -f2 | sort -u > "$IDX"
fi
WANT=$(grep -vE '^[[:space:]]*(#|$)' "$LIST" | sort -u)
MISS=$(comm -13 "$IDX" <(printf '%s\n' "$WANT") || true)
if [ -n "$MISS" ]; then
  echo "::error::Gói KHÔNG có trong Debian bookworm main: $(echo "$MISS" | tr '\n' ' ')"
  exit 1
fi
echo "OK: $(printf '%s\n' "$WANT" | wc -l) tên gói đều có trong bookworm main"
