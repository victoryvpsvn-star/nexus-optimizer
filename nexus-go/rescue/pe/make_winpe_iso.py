# NEXUS WinPE ISO builder — pycdlib (khong can oscdimg/ADK base)
# Stage dir: C:\iso-stage (media template WinPE da inject boot.wim + NEXUS)
# Output: C:\out\windows-nexus.iso (El Torito hybrid BIOS + UEFI)
import os, sys, subprocess
STAGE = r"C:\winpe\media"
OUT = r"C:\out\windows-nexus.iso"

# pip pycdlib (chay 1 lan)
try:
    import pycdlib
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "pycdlib"])
    import pycdlib

iso = pycdlib.PyCdlib()
iso.new(interchange_level=4, joliet=True)

count = 0
for root, dirs, files in os.walk(STAGE):
    for f in files:
        lp = os.path.join(root, f)
        rel = os.path.relpath(lp, STAGE).replace("\\", "/")
        iso_path = "/" + rel.upper()
        jol_path = "/" + rel
        try:
            iso.add_file(lp, iso_path, joliet_path=jol_path)
            count += 1
        except Exception as e:
            print("SKIP", rel, "->", e)

print("files added:", count)

# El Torito: BIOS (etfsboot.com) + UEFI (efisys.bin)
bios_boot = os.path.join(STAGE, "boot", "etfsboot.com")
efi_boot = os.path.join(STAGE, "efi", "microsoft", "boot", "efisys.bin")
if os.path.exists(bios_boot):
    try:
        iso.add_eltorito("/BOOT/ETFSBOOT.COM", bootable=True, platform_id=0, media_name="noemul", boot_load_size=4)
    except Exception as e:
        print("WARN eltorito BIOS:", e)
    print("el torito BIOS: etfsboot.com")
else:
    print("WARN: etfsboot.com thieu - ISO chi boot UEFI")
if os.path.exists(efi_boot):
    try:
        iso.add_eltorito("/EFI/MICROSOFT/BOOT/EFISYS.BIN", efi=True, bootable=False)
    except Exception as e:
        print("WARN eltorito EFI:", e)
    print("el torito EFI: efisys.bin")
else:
    print("WARN: efisys.bin thieu - ISO chi boot BIOS")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
iso.write(OUT)
iso.close()
size = os.path.getsize(OUT)
print("ISO written:", OUT, size, "bytes", "=>", round(size / 1048576.0, 1), "MB")
if size < 150 * 1048576:
    print("ERROR: ISO qua nho - boot.wim chua duoc inject?")
    sys.exit(1)
print("NEXUS-WINPE-ISO-OK")
