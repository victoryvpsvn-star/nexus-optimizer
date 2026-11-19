#!/usr/bin/env python3
"""NEXUS Rescue ISO builder — v4.4.0.
Chèn NEXUS overlay (apkovl) vào Alpine virt ISO bằng pycdlib (thuần Python,
không cần xorriso). El Torito boot records được pycdlib giữ nguyên khi copy ISO.

Usage: make_iso.py <base.iso> <apkovl.tar.gz> <out.iso>
"""
import sys
import os

import pycdlib


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: make_iso.py <base.iso> <apkovl.tar.gz> <out.iso>", file=sys.stderr)
        return 2
    base, overlay, out = sys.argv[1:4]
    for p in (base, overlay):
        if not os.path.isfile(p) or os.path.getsize(p) == 0:
            print(f"::error::file rỗng/thiếu: {p}", file=sys.stderr)
            return 1
    iso = pycdlib.PyCdlib()
    iso.open(base)
    # ISO9660 name phải D1-safe (A-Z,0-9,_); Linux mount dùng Rock Ridge → tên thật là
    # 'nexus.apkovl.tar.gz' — Alpine boot sẽ tự tìm và áp apkovl ở root media
    iso.add_file(overlay, iso_path='/NEXUS_APK.;1', rr_name='nexus.apkovl.tar.gz')
    iso.write(out)
    iso.close()
    size = os.path.getsize(out)
    if size < 10 * 1024 * 1024:
        print(f"::error::ISO xuất quá nhỏ: {size} bytes", file=sys.stderr)
        return 1
    # verify readback — không xuất ISO mà không đọc được overlay ra
    chk = pycdlib.PyCdlib()
    chk.open(out)
    probe = out + '.probe'
    chk.get_file_from_iso(probe, rr_path='/nexus.apkovl.tar.gz')
    chk.close()
    ok = os.path.getsize(probe) == os.path.getsize(overlay)
    os.remove(probe)
    if not ok:
        print("::error::overlay chèn xong nhưng đọc ra không khớp kích thước", file=sys.stderr)
        return 1
    print(f"OK: {out} — {size} bytes, overlay verify readback đạt")
    return 0


if __name__ == '__main__':
    sys.exit(main())
