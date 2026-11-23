# 18-a: FIX CHUYÊN SÂU TOÀN DỰ ÁN (23-11-2026, phiên này)

## Trạng thái workflows khi bắt đầu phiên
- RustDesk live #24: 12/12 PASS — ID 316050794 / pw 123456789 — HOLD-BUG ĐÃ FIX (hold re-run setup → pw đổi giữa session). Mọi thứ xanh.
- Windows exe #165 xanh, Backup #11 xanh, Linux Dev #58 xanh (VHDX job run #57 fail NPS flaky — ĐÃ FIX: boot-test.exp retry 2 lần, commit 9cb6131).
- build-go #85 xanh (Win11 + WinPE bị skip vì chỉ chạy khi dispatch).

## Các fix đã push phiên này (nếu phiên sau cần soi lại)
1. **9cb6131**: win11-iso đổi tên 24H2→26H2 (MS chỉ còn phát 26H2 26300.9457), ms_connector.py làm CHÍNH (test REAL OK trên sandbox: URL prss chính chủ), Fido chỉ backup (-Lang English); timeout 55→90→150; merge.bat + upload ĐỘNG theo số phần thật (hardcode .001+.002+.003 là bug); WinPE: choco → adkwinpesetup.exe fwlink 2289981; boot-test retry.
2. **3bfb457**: adkwinpesetup = Burn bundle web-installer 1.86MB → /quiet /norestart + log, bỏ check 10MB sai.
3. **977cb8e**: /layout + msiexec /a bung MSI — **PHÁT HIỆN NGÕ CỤT**: layout chỉ bung "Windows PE Boot Files" MSI 0.6MB (chỉ bootmgr + ngôn ngữ), KHÔNG có MSI WinPE ~500MB. ADK route bỏ hoàn toàn.
4. **2c443fe**: WinPE v4.6 — boot.wim = **WinSE lấy từ ISO Win11 chính chủ** (job win11-iso export C:\win11src\sources\boot.wim → artifact `win11-boot-wim`, retention 1 ngày; job build-windows-pe download artifact qua gh api). WinSE có sẵn PowerShell+WMI+.NET → bỏ hết Add-Package OCs. Mount index 2 (Setup đầy đủ; fallback index 1 nếu không có powershell.exe), inject NEXUS, Export-Image index đã inject /Compress:recovery. needs: [release, win11-iso]. Test pycdlib dual El Torito (BIOS 0x88 + UEFI 0xEF) PASS trên sandbox — scripts/test_pycdlib_eltorito.py.
5. **f259b0d**: Run #93 fail vì **ISO 26H2 = 8.43GB, install.wim = 7.6GB** (24H2 cũ chỉ 5.5GB) → dism trọn bộ hết 35' step timeout lúc đang Export [9]. FIX: step tune timeout 35→75'; tách bước 9 (Export re-compress 7.6→~3GB) vẫn nằm trong ps1 nhưng ps1 có skip nếu file đã có; thêm step guard riêng 60'; job timeout 150'.

## Run đang chạy khi phiên này KẾT THÚC
- **Run #94 (id 45287258322, sha f259b0d)** — dispatch lúc 23:15 UTC, đang ở bước tune install.wim. Ước tính: connector+download ~8', tune ~50-70', export ~15-25', pycdlib ISO ~15', split ~5', upload ~10'. Job timeout 150'.
- Run #95 (id 45287258984) bị cancel — push-trigger đè lên (lưu ý: MỖI PUSH lên main đều trigger build-go; dispatch thủ công + push-trigger cancel lẫn nhau do concurrency group cancel-in-progress).

## PHIÊN SAU CẦN LÀM
1. Poll run #94: `GET /repos/victoryvpsvn-star/nexus-optimizer/actions/runs/45287258322/jobs` — job 'Build Win11 Pro 26H2' + 'Build Windows NEXUS ISO'.
2. Nếu Win11 job fail: đọc blob log từng bước (patterns như phiên này: ##[error], throw, TUNE-INSTALL-WIM-OK, install.wim GB). Các điểm rủi ro còn lại:
   - Export /Compress:recovery 7.6GB→<3.9GB: nếu >3.9GB sau recovery (khả năng thấp nhưng có) → phải đổi sang max rồi check; hoặc bỏ /CheckIntegrity cho nhanh.
   - pycdlib make ISO với cây 8GB gốc nhưng install.wim đã thay 3GB → ISO ~4.5-5GB > 4GB ISO9660 interchange_level=4? PyCdlib UDF 2.60 cho phép nhưng Joliet level... nếu add_file lỗi >4GB single file → cần mslevel/interchange level thấp hơn hoặc chỉ UDF. TEST TRƯỚC trên sandbox nếu fail (scripts/test_pycdlib_eltorito.py làm mẫu).
   - WinPE job: artifact win11-boot-wim chỉ tồn tại 1 NGÀY + phải cùng run; nếu #94 Win11 fail thì WinPE skipped (needs). gh api download artifact zip trong step "Lay boot.wim goc" — script powershell pipe `gh api ... --jq` có thể có bug cú pháp — SOI KỸ nếu fail (đơn giản hơn: dùng actions/download-artifact@v4 với name: win11-boot-wim + github-token;Artifact cùng run luôn download được).
3. Nếu #94 XANH: verify release go-v95 có: Win11NEXUS-26H2.7z.00N + merge.bat + README + SHA256 + windows-nexus.iso; tải SHA256.txt + README về download/ làm bằng chứng; Discord full báo cáo.
4. Bài học concurrency: sau này khi muốn dispatch build-go mà không bị push-trigger cancel → hoặc đợi run push xong (~12'), hoặc dispatch bằng API sau khi push-trigger run đã vào queued (chỉ 1 run của workflow này chạy 1 lúc).

## File liên quan
- scripts/live8.py — push + dispatch + poll RustDesk (pw 123456789 cố định từ #24).
- scripts/verify_artifact.py <run_number> — tải + in artifact session-info (ID+PW RustDesk).
- scripts/verify_log.py — đọc blob log các run RustDesk.
- scripts/test_pycdlib_eltorito.py — test pycdlib dual El Torito (PASS).
- nexus-go/rescue/win11/{ms_connector.py,tune-install-wim.ps1,make_win11_iso.py,FirstBoot.ps1,unattend.xml}
- .github/workflows/build-go.yml (win11-iso + build-windows-pe v4.6), build-linux-dev.yml (retry).
- Discord webhook: lấy từ upload/work.txt (grep 'https://discord.com/api/webhooks').
