# NEXUS Win11 Pro 24H2 Gaming ISO builder — pycdlib (UDF + Joliet + El Torito BIOS/UEFI)
# Input : C:\win11src (cay ISO goc, install.wim da thay bang ban Pro da tune)
# Output: C:\out\Win11Pro-NEXUS-24H2-Gaming.iso
import os, sys, subprocess
STAGE = r"C:\win11src"
OUT = r"C:\out\Win11Pro-NEXUS-24H2-Gaming.iso"

try:
    import pycdlib
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "pycdlib"])
    import pycdlib

iso = pycdlib.PyCdlib()
iso.new(interchange_level=4, joliet=True, udf=True)

# Directory tree truoc (pycdlib khong tu tao parent)
seen_dirs = set()
for root, dirs, files in os.walk(STAGE):
    rel = os.path.relpath(root, STAGE).replace("\\", "/")
    if rel == ".":
        continue
    parts = [p for p in rel.split("/") if p]
    acc = ""
    for part in parts:
        acc += "/" + part
        if acc not in seen_dirs:
            iso.add_directory(acc.upper(), joliet_path=acc, udf_path=acc)
            seen_dirs.add(acc)

count = 0
for root, dirs, files in os.walk(STAGE):
    for f in files:
        lp = os.path.join(root, f)
        rel = os.path.relpath(lp, STAGE).replace("\\", "/")
        try:
            iso.add_file(lp, "/" + rel.upper(), joliet_path="/" + rel, udf_path="/" + rel)
            count += 1
        except Exception as e:
            print("SKIP", rel, "->", e)
print("files added:", count)

# El Torito: BIOS (etfsboot.com) + UEFI (efisys.bin) - ca hai co trong cay ISO goc
for boot_rel, extra in (("boot/etfsboot.com", dict(bootable=True, platform_id=0, media_name="noemul", boot_load_size=4)),
                        ("efi/microsoft/boot/efisys.bin", dict(efi=True, bootable=False))):
    p = "/" + boot_rel.upper()
    if os.path.exists(os.path.join(STAGE, boot_rel.replace("/", os.sep))):
        try:
            iso.add_eltorito(p, **extra)
            print("el torito:", p)
        except Exception as e:
            print("WARN eltorito", p, "->", e)
    else:
        print("WARN: thieu", boot_rel)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
iso.write(OUT)
iso.close()
size = os.path.getsize(OUT)
print("ISO written:", OUT, round(size / 1048576.0, 1), "MB")
if size < 2.5 * 1024 * 1024 * 1024:
    print("ERROR: ISO qua nho - install.wim thieu?")
    sys.exit(1)
print("NEXUS-WIN11-ISO-OK")
