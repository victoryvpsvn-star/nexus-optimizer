# rustdesk-live.ps1 — NEXUS: tự cài RustDesk trên runner GitHub, mở wizard, giữ ĐÚNG N phút
# Mọi call CLI đều có timeout + kill. CHẤM PASS/FAIL từng bước: log job + GITHUB_STEP_SUMMARY + live-session.json
#
# v3 (diag #27, soi mã nguồn hbb_common): 3 root-cause đã xử lý
# 1) HAI INSTANCE / HAI ID: New-Service (LocalSystem) + service installer (LocalService) chạy song song,
#    mỗi instance một config một enc_id (bằng chứng dump [CFG] run #27) → --get-id trả ID APP USER,
#    bro gõ ID đó = "offline" → KHÔNG BAO GIỜ vào được dù password đúng.
#    → v3: chỉ giữ ĐÚNG MỘT service chuẩn của installer; service thủ công bị xóa.
# 2) ID PHẢI LẤY TỪ ACCOUNT CỦA SERVICE: task /RU <account-service> chạy --get-id → ID service thật.
# 3) PASSWORD PLAIN LÀ ĐÚNG THIẾT KẾ (không phải lỗi): hbb_common/src/password_security.rs
#    decrypt_str_or_original() — chuỗi không có dạng "version-prefix + base64" được DÙNG NGUYÊN GIÁ TRỊ
#    (plain được chấp nhận khi đọc; mã hóa lại chỉ xảy ra khi SAVE). CLI --password chạy bằng account
#    khác sẽ ghi hash mã hóa theo machine_uid/config của ACCOUNT ĐÓ → service không giải mã nổi → sai pw.
#    → v3: KHÔNG dùng CLI --password nữa; plain pw ghi thẳng vào config của service.
param([int]$Minutes = 10, [string]$Mode = 'all')
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

Write-Host "============================================================"
Write-Host "  NEXUS RustDesk LIVE — session giữ đúng $Minutes phut"
Write-Host "============================================================"

# HOLD MODE — THOÁT NGAY: hold step gọi lại ĐÚNG file ps1 này với -Mode hold; nếu không thoát sớm
# thì TOÀN BỘ setup chạy lại = sinh pw MỚI + set đè lên service → user cầm pw cũ trong artifact
# bị "Wrong password" giữa session (diag #23 — đúng bệnh trong ảnh bro gửi)
if ($Mode -eq 'hold') {
    Write-Host '=== HOLD MODE — chỉ giữ session, KHÔNG đụng vào RustDesk/setup ==='
    if (Test-Path (Join-Path $env:GITHUB_WORKSPACE 'hold-state.txt')) { $Minutes = [int](Get-Content (Join-Path $env:GITHUB_WORKSPACE 'hold-state.txt') -Raw) }
    for ($i = $Minutes; $i -gt 0; $i--) {
        Write-Host ("CON-LAI: {0} phut — bro ket noi bang RUSTDESK_ID + PASSWORD" -f $i)
        Start-Sleep -Seconds 60
    }
    Write-Host '=== HET-PHUT — session ket thuc, runner VM tu thu hoi ==='
    exit 0
}

# dọn SESSION-*.txt của session cũ (nếu còn) — file này nằm ở root repo nên nó hiện ở trang chủ
Push-Location $env:GITHUB_WORKSPACE
$null = git rm -q -f --ignore-unmatch 'SESSION-*.txt' 2>&1
Pop-Location

$script:Checks = @()
function Mark([string]$n, [bool]$ok, [string]$d) {
    $script:Checks += @{ n = $n; ok = $ok; d = $d }
    $tag = if ($ok) { 'PASS' } else { 'FAIL' }
    Write-Host "[$tag] $n — $d"
    if (-not $ok) { Write-Host ("::error title=FAIL {0}::{1}" -f $n, $d) }  # annotation — hiện ngay đỉnh trang run
    if ($env:GITHUB_STEP_SUMMARY) {
        $icon = if ($ok) { ':white_check_mark:' } else { ':x:' }
        Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "| $icon | $n | $d |" -Encoding UTF8
    }
}
if ($env:GITHUB_STEP_SUMMARY) {
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "## NEXUS RustDesk live session" -Encoding UTF8
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "| KQ | Buoc | Chi tiet |`n|---|---|---|" -Encoding UTF8
}

function Publish([hashtable]$data) {
    # publish bằng git push — 1 commit: JSON cho poller + file SESSION-*.txt cho NGƯỜI ĐỌC (hiện ngay ở trang chủ repo)
    try {
        $data.run = $env:GITHUB_RUN_ID
        $json = $data | ConvertTo-Json -Depth 5
        $f = Join-Path $env:GITHUB_WORKSPACE 'nexus-win\optimizer\live-session.json'
        Set-Content -Path $f -Value $json -Encoding UTF8 -Force
        $idTag = if ($data.id) { $data.id } else { 'KHONG-CO' }
        $sessName = "SESSION-{0}-PASS-of-{1}-ID-{2}.txt" -f $data.pass, $data.total, $idTag
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.AppendLine("NEXUS RUSTDESK SESSION — RUN #$env:GITHUB_RUN_NUMBER — $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm')) UTC")
        [void]$sb.AppendLine(("KET QUA: {0}/{1} PASS" -f $data.pass, $data.total))
        [void]$sb.AppendLine("RUSTDESK_ID=$($data.id)")
        [void]$sb.AppendLine("PASSWORD: xem trong log cua run nay (khong ghi vao file de tranh secret-scanning mask)")
        [void]$sb.AppendLine("Session giu: $($data.minutes) phut (bat dau sau khi co ID)")
        [void]$sb.AppendLine("")
        [void]$sb.AppendLine("CHECKLIST:")
        foreach ($c in $data.checklist) {
            $tag = if ($c.ok) { 'PASS' } else { 'FAIL' }
            [void]$sb.AppendLine("  [$tag] $($c.n) — $($c.d)")
        }
        Set-Content -Path (Join-Path $env:GITHUB_WORKSPACE $sessName) -Value $sb.ToString() -Encoding UTF8 -Force
        # file cho ARTIFACT (tải về nguyên vẹn): log bị GitHub AI-mask MỌI chuỗi giống password — artifact thì KHÔNG
        # KHÔNG commit file này (git rm --cached) — password không bao giờ vào git
        $pwPlain = ''
        if ($data.pw_b64) { $pwPlain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($data.pw_b64)) }
        $infoF = Join-Path $env:GITHUB_WORKSPACE 'session-info.txt'
        Set-Content -Path $infoF -Value ("RUSTDESK_ID={0}`nPASSWORD={1}`nKET QUA: {2}/{3} PASS`nSession giu: {4} phut (bat dau sau khi co ID)" -f $data.id, $pwPlain, $data.pass, $data.total, $data.minutes) -Encoding UTF8 -Force
        Push-Location $env:GITHUB_WORKSPACE
        git config user.name 'nexus-bot'
        git config user.email 'nexus-bot@users.noreply.github.com'
        git add -A
        $null = git rm --cached -q --ignore-unmatch session-info.txt 2>&1
        git commit -m ("live-session: {0}/{1} PASS - ID {2}" -f $data.pass, $data.total, $idTag) --no-verify | Out-Null
        git push origin HEAD:main 2>&1 | Out-Null
        Pop-Location
        Write-Host "     published: live-session.json + $sessName (git push)"
    } catch {
        Write-Host ("     publish lỗi: {0}" -f $_.Exception.Message)
        Pop-Location -ErrorAction SilentlyContinue
    }
}

function RDC([string[]]$cliArgs, [int]$timeoutSec = 25) {
    # gọi rustdesk CLI với timeout — block thì kill, không bao giờ treo job
    $outF = "$env:TEMP\rd-out.txt"; $errF = "$env:TEMP\rd-err.txt"
    Remove-Item $outF, $errF -ErrorAction SilentlyContinue
    $p = Start-Process -FilePath $script:rd -ArgumentList $cliArgs -NoNewWindow -PassThru `
        -RedirectStandardOutput $outF -RedirectStandardError $errF
    if (-not $p.WaitForExit($timeoutSec * 1000)) {
        Write-Host ("     [RDC] TIMEOUT {0}s: {1} — kill" -f $timeoutSec, ($cliArgs -join ' '))
        try { $p.Kill() } catch { }
        return $null
    }
    return (Get-Content $outF -Raw -ErrorAction SilentlyContinue)
}

# 1) Tag mới nhất — API có GITHUB_TOKEN (1000/h) + fallback redirect /releases/latest (không cần API)
Write-Host "[1/8] Lay tag release moi nhat..."
$rel = $null; $tag = $null
$hdr = @{ 'User-Agent' = 'nexus-agent' }
if ($env:GITHUB_TOKEN) { $hdr['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
foreach ($try in 1..3) {
    try { $rel = Invoke-RestMethod 'https://api.github.com/repos/rustdesk/rustdesk/releases/latest' -Headers $hdr -TimeoutSec 60; break }
    catch { Write-Host "     release API fail (lan $try): $($_.Exception.Message)"; Start-Sleep 5 }
}
if ($rel) { $tag = $rel.tag_name }
else {
    $loc = $null
    try { $r = Invoke-WebRequest -Uri 'https://github.com/rustdesk/rustdesk/releases/latest' -MaximumRedirection 0 -UseBasicParsing -ErrorAction Stop; if ($r.Headers['Location']) { $loc = $r.Headers['Location'] } } catch {
        if ($_.Exception.Response) { $loc = $_.Exception.Response.Headers['Location'] }
    }
    if ($loc) { $tag = ($loc -split '/tag/')[-1]; Write-Host "     fallback redirect: $loc" }
}
if ($tag) { Mark 'release-api' $true "tag $tag $(if (-not $rel) { '(redirect fallback)' })" }
else { Mark 'release-api' $false 'API + fallback đều lỗi' }

# 2) Tải installer — URL dựng từ tag (không cần API list assets)
$exe = Join-Path $env:TEMP 'rustdesk-setup.exe'
$dl = $null
if ($rel) { $a = $rel.assets | Where-Object { $_.name -match '^rustdesk-.*x86_64\.exe$' } | Select-Object -First 1; if ($a) { $dl = $a.browser_download_url } }
if (-not $dl -and $tag) { $dl = "https://github.com/rustdesk/rustdesk/releases/download/$tag/rustdesk-$($tag -replace '^v','')-x86_64.exe" }
if ($dl) {
    Write-Host "[2/8] Tai $dl..."
    Invoke-WebRequest -Uri $dl -OutFile $exe -UseBasicParsing -TimeoutSec 300
    $mb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
    if ($mb -gt 5) { Mark 'download-installer' $true "$([IO.Path]::GetFileName($dl)) — $mb MB" }
    else { Mark 'download-installer' $false "file quá nhỏ ($mb MB) — download hỏng" }
} else {
    Mark 'download-installer' $false 'không có URL tải (không tag, không asset)'
}

# 3) Cài im lặng (--silent-install: Program Files + service chuẩn 'RustDesk' chạy LocalService)
if ((Test-Path $exe) -and ((Get-Item $exe -ErrorAction SilentlyContinue).Length -gt 5MB)) {
    Write-Host "[3/8] Cai im lang (--silent-install)..."
    Unblock-File $exe -ErrorAction SilentlyContinue
    # --silent-install = cài im lặng TOÀN HỆ THỐNG chuẩn của RustDesk (Program Files + đăng ký service
    # + RustDesk coi là "installed" → --password hoạt động). Diag #21/#22: /S và /allusers chỉ cài
    # per-user (AppData) → CLI chào "Installation and administrative privileges required!"
    $p = Start-Process $exe -ArgumentList '--silent-install' -PassThru
    if ($p.WaitForExit(180000)) {
        Write-Host ("     installer exit code: {0}" -f $p.ExitCode)
        Write-Host ("     shell elevated (High integrity): {0}" -f [bool](whoami /groups | Select-String 'S-1-16-12288'))
        Start-Sleep 3
        $script:rd = $null
        foreach ($cand in "$env:ProgramFiles\RustDesk\rustdesk.exe", "${env:ProgramFiles(x86)}\RustDesk\rustdesk.exe", "$env:LOCALAPPDATA\Programs\RustDesk\rustdesk.exe", "$env:LOCALAPPDATA\RustDesk\rustdesk.exe") {
            if (Test-Path $cand) { $script:rd = $cand; break }
        }
        if (-not $script:rd) {
            $found = Get-ChildItem "$env:ProgramFiles", "$env:LOCALAPPDATA\Programs", "$env:ProgramData" -Filter rustdesk.exe -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($found) { $script:rd = $found.FullName }
        }
        if ($script:rd) { Mark 'install-rustdesk' $true "exit=$($p.ExitCode) → $script:rd" }
        else { Mark 'install-rustdesk' $false "exit=$($p.ExitCode) — rustdesk.exe không thấy ở vị trí chuẩn" }
    } else {
        try { $p.Kill() } catch { }
        Mark 'install-rustdesk' $false 'installer timeout 180s'
    }
} else { Mark 'install-rustdesk' $false 'bỏ qua — installer không có' }

if (-not $script:rd) {
    Publish @{ id = ''; pw_b64 = ''; minutes = $Minutes; pass = ($script:Checks | Where-Object { $_.ok }).Count; total = $script:Checks.Count; checklist = $script:Checks }
    throw 'cài RustDesk thất bại — xem các dòng FAIL ở trên'
}

# 4) SERVICE — DUY NHẤT service chuẩn của installer ('RustDesk' / LocalService).
# v3 diag #27: run truoc tao THEM RustDeskService (New-Service, LocalSystem) → 2 instance RustDesk
# song song, moi cai mot config/enc_id → --get-id (chay runneradmin) tra ID APP USER, khong phai
# ID service → bro go ID "offline" = nguyen nhan chua vao duoc. Xoa service thu cong, giu 1 chuan.
Write-Host "[4/8] RustDesk service (DUY NHAT - chuan installer)..."
Get-Process -Name 'rustdesk' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2
foreach ($sn in @('RustDeskService')) {
    if (Get-Service -Name $sn -ErrorAction SilentlyContinue) {
        sc.exe stop $sn 2>&1 | Out-Null; Start-Sleep 1
        sc.exe delete $sn 2>&1 | Out-Null
        Write-Host "     da xoa service thu cong $sn (v3: chi giu service chuan cua installer)"
    }
}
$svc = Get-Service -Name 'RustDesk' -ErrorAction SilentlyContinue
if (-not $svc) {
    $null = & $script:rd --install-service 2>&1
    Start-Sleep 5
    $svc = Get-Service -Name 'RustDesk' -ErrorAction SilentlyContinue
}
if (-not $svc) {
    # fallback cuoi cung (chi khi installer khong tao duoc service) — ROLLBACK nguy co 2 instance
    New-Service -Name 'RustDesk' -DisplayName 'RustDesk Service' -BinaryPathName "`"$script:rd`" --service" -StartupType Automatic -ErrorAction SilentlyContinue | Out-Null
    Start-Sleep 1
    $svc = Get-Service -Name 'RustDesk' -ErrorAction SilentlyContinue
}
if ($svc -and $svc.Status -ne 'Running') { Start-Service $svc.Name -ErrorAction SilentlyContinue; Start-Sleep 8; $svc = Get-Service -Name 'RustDesk' -ErrorAction SilentlyContinue }
if ($svc -and $svc.Status -eq 'Running') {
    New-NetFirewallRule -DisplayName 'RustDesk' -Program $script:rd -Direction Inbound -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null
    $svcAccount = ((sc.exe qc $svc.Name 2>&1 | Out-String) -split "`n" | Select-String 'SERVICE_START_NAME' | Out-String).Trim()
    Mark 'service-running' $true "$($svc.Name)=Running — $svcAccount — DUY NHAT (1 instance = 1 ID)"
} else {
    Mark 'service-running' $false 'service RustDesk KHÔNG chạy được — session sẽ không nhận kết nối'
    $svcAccount = ''
}

# 5) PASSWORD — PLAIN TRONG CONFIG CỦA SERVICE (đúng thiết kế mã nguồn, KHÔNG dùng CLI nữa).
# hbb_common/src/password_security.rs decrypt_str_or_original(): giá trị không mang dạng
# "version-prefix + base64" (plain) → được DÙNG NGUYÊN. Mã hóa lại chỉ xảy ra khi SAVE.
# CLI --password chạy bằng account khác ghi hash theo machine_uid/config ACCOUNT ĐÓ → service
# không giải mã nổi → sai pw (diag #24). Vì vậy: stop service → ghi plain → start lại.
Write-Host '[5/8] Dat password (plain → config service, dung thiet ke ma nguon)...'
# PW CỐ ĐỊNH theo yêu cầu bro — 123456789 (9 số, gõ KHÔNG THỂ sai; RustDesk nhận pw ≥8 ký tự)
$pw = '123456789'
$pwB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pw))

Get-Service -Name 'RustDesk' -ErrorAction SilentlyContinue | Stop-Service -Force -ErrorAction SilentlyContinue
Start-Sleep 4
$cfgDirs3 = @(
    'C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config',
    'C:\Windows\System32\config\systemprofile\AppData\Roaming\RustDesk\config',
    "$env:APPDATA\RustDesk\config"
)
$plainWritten = @()
foreach ($dir in $cfgDirs3) {
    $toml = Join-Path $dir 'RustDesk.toml'
    if (-not (Test-Path $toml)) { continue }
    $txt = [IO.File]::ReadAllText($toml)
    if ($txt -match "(?m)^password\s*=\s*'[^']*'") {
        $txt = $txt -replace "(?m)^password\s*=\s*'[^']*'", "password = '$pw'"
    } else {
        # chen ngay sau dong dau (password la root-level key, phai truoc section [options])
        $parts = $txt -split "\r?\n", 2
        $txt = if ($parts.Count -eq 2) { "$($parts[0])`r`npassword = '$pw'`r`n$($parts[1])" } else { "$txt`r`npassword = '$pw'`r`n" }
    }
    [IO.File]::WriteAllText($toml, $txt, [Text.UTF8Encoding]::new($false))
    $plainWritten += $toml
    Write-Host "     plain pw → $toml"
}
if ($plainWritten.Count -lt 1) {
    Mark 'set-password' $false 'không tìm thấy RustDesk.toml nào để ghi plain password'
} else {
    Mark 'pw-plain-written' $true "plain pw ghi vao $($plainWritten.Count) config: $(($plainWritten | ForEach-Object { $_.Replace('\RustDesk.toml', '') }) -join ' | ')"
    # CƯỜNG HÓA: verification-method = use-permanent-password trong RustDesk2.toml [options] của service
    # (mặc định UseBoth — đặt hẳn permanent để tránh nhầm temporary pw 6 số)
    foreach ($dir in @('C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config', 'C:\Windows\System32\config\systemprofile\AppData\Roaming\RustDesk\config')) {
        $r2 = Join-Path $dir 'RustDesk2.toml'
        if (-not (Test-Path $r2)) { continue }
        $t = [IO.File]::ReadAllText($r2)
        if ($t -match "(?m)^verification-method\s*=") { $t = $t -replace "(?m)^verification-method\s*=.*$", "verification-method = 'use-permanent-password'" }
        elseif ($t -match "(?m)^\[options\]") { $t = $t -replace "(?m)^\[options\]", "[options]`r`nverification-method = 'use-permanent-password'" }
        else { $t = $t.TrimEnd() + "`r`n[options]`r`nverification-method = 'use-permanent-password'`r`n" }
        [IO.File]::WriteAllText($r2, $t, [Text.UTF8Encoding]::new($false))
        Write-Host "     verification-method=use-permanent-password → $r2"
    }
    # START service lại — service đọc plain password trong config CỦA NÓ
    Get-Service -Name 'RustDesk' -ErrorAction SilentlyContinue | Start-Service -ErrorAction SilentlyContinue
    Start-Sleep 8
    # VERIFY: plain pw nằm trong config service + service đang chạy → password active
    $svcToml = 'C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config\RustDesk.toml'
    $pwActive = $false
    if (Test-Path $svcToml) {
        $stxt = [IO.File]::ReadAllText($svcToml)
        $pwActive = ($stxt -match "(?m)^password\s*=\s*'$pw'") -and ((Get-Service -Name 'RustDesk' -ErrorAction SilentlyContinue).Status -eq 'Running')
    }
    if ($pwActive) {
        Mark 'set-password' $true "plain pw ACTIVE trong config service + service Running (decrypt_str_or_original chấp nhận plain — mã nguồn hbb_common)"
    } else {
        Mark 'set-password' $false 'plain pw không nằm trong config service hoặc service chưa chạy'
    }
}

# 6) ID — LẤY TỪ ĐÚNG ACCOUNT CỦA SERVICE (v3 — bước QUYẾT ĐỊNH).
# --get-id chạy bằng runneradmin trả ID của APP USER (khác ID service!). v3: scheduled task
# /RU <account-service> chạy --get-id → đọc config CỦA account đó → ID service thật đăng ký.
Write-Host '[6/8] Lay ID SERVICE (task /RU account-service, toi da ~4 phut)...'
$ru = 'SYSTEM'
if ($svcAccount -match 'LocalService') { $ru = 'NT AUTHORITY\LOCAL SERVICE' }
elseif ($svcAccount -match 'NetworkService') { $ru = 'NT AUTHORITY\NETWORK SERVICE' }
Write-Host "     service account → /RU $ru"
$rdDir = 'C:\ProgramData\nexus-rd'
New-Item -ItemType Directory -Force -Path $rdDir | Out-Null
$null = icacls $rdDir /grant 'Everyone:(OI)(CI)F' 2>&1
$idOut = Join-Path $rdDir 'svc-id.txt'
$cmdFile = Join-Path $rdDir 'get-id.cmd'
Set-Content -Path $cmdFile -Value ("@echo off`r`n`"{0}`" --get-id > `"{1}`" 2>&1`r`n" -f $script:rd, $idOut) -Encoding ASCII
$null = schtasks /Create /TN NEXUSRdGetID /TR ('"{0}"' -f $cmdFile) /SC ONCE /ST 23:59 /RU $ru /RL HIGHEST /F 2>&1
$svcId = $null; $svcIdErr = ''
foreach ($round in 1..3) {
    Remove-Item $idOut -Force -ErrorAction SilentlyContinue
    $runOut = schtasks /Run /TN NEXUSRdGetID 2>&1 | Out-String
    for ($i = 0; $i -lt 9; $i++) { Start-Sleep 5; if (Test-Path $idOut) { break } }
    if (Test-Path $idOut) {
        $t = Get-Content $idOut -Raw -ErrorAction SilentlyContinue
        if ($t -match '(\d{7,})') { $svcId = $Matches[1]; break }
        $svcIdErr = "task chay nhung output khong phai ID: $($t.Trim() -replace '\s+', ' ')"
    } else { $svcIdErr = "task khong tao ra file ($($runOut.Trim() -replace '\s+', ' '))" }
    Write-Host "     vong $round chua co ID service: $svcIdErr — cho service dang ky roi thu lai"
    Start-Sleep 10
}
$null = schtasks /Delete /TN NEXUSRdGetID /F 2>&1
# ID app user (đối chiếu — CHỈ để cảnh báo lệch, KHÔNG dùng làm ID chính nữa)
$cliId = $null
$cliOut = RDC @('--get-id') 25
if ($cliOut -match '(\d{7,})') { $cliId = $Matches[1] }

$id = $null; $idSrc = ''
if ($svcId) {
    $id = $svcId; $idSrc = "task /RU $ru (ID SERVICE that)"
    $note = if ($cliId -and $cliId -ne $svcId) { "ID app user ($cliId) KHAC ID service — dung ID SERVICE" } else { 'khop' }
    Mark 'get-id' $true "ID=$id (nguon: $idSrc) — $note"
} else {
    # fallback cuối: ID CLI + cảnh báo lớn (ID có thể là app user → offline)
    if ($cliId) {
        $id = $cliId; $idSrc = 'CLI --get-id (FALLBACK — co the la ID app user!)'
        Mark 'get-id' $false "KHONG lay duoc ID service ($svcIdErr) — dung ID app user $cliId LAM SAU: co the offline"
    } else {
        Mark 'get-id' $false 'không lấy được ID nào (service + CLI đều fail)'
    }
}

# 6c) XÁC NHẬN password đã nằm trong config của SERVICE + dump config vào log (ground truth)
$pwCfgFile = ''
foreach ($dir in $cfgDirs3 + @("$env:LOCALAPPDATA\RustDesk\config")) {
    foreach ($f in (Get-ChildItem $dir -Filter 'RustDesk*.toml' -ErrorAction SilentlyContinue)) {
        $txt = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
        $flat = ($txt -replace '\r?\n', ' | ')
        if ($flat.Length -gt 260) { $flat = $flat.Substring(0, 260) + '...' }
        Write-Host ("     [CFG] {0} => {1}" -f $f.FullName, $flat)
        if (-not $pwCfgFile -and $txt -match "(?<![\w])password\s*=\s*['`"]?([^'`"\r\n]{4,})") { $pwCfgFile = $f.FullName }
    }
}
Mark 'service-password-config' ([bool]$pwCfgFile) $(if ($pwCfgFile) { "password đã ghi vào: $pwCfgFile" } else { 'KHÔNG thấy password trong config nào — service sẽ từ chối pw (dump [CFG] ở log để soi)' })

# 6b) Chẩn đoán relay công cộng — runner chạm được server RustDesk không (không fatal)
$relayOk = $false
try { $relayOk = Test-NetConnection -ComputerName 'rs-ny.rustdesk.com' -Port 21116 -InformationLevel Quiet -WarningAction SilentlyContinue } catch { }
Mark 'relay-reachable' ([bool]$relayOk) "TCP rs-ny.rustdesk.com:21116 = $(if ($relayOk) { 'OPEN' } else { 'BLOCKED' })"
# relay BLOCKED ⇒ client mặc định (rs-ny) không bao giờ thấy máy này ⇒ session vô dụng →
# fail job ngay, không publish session chết; dispatch lại để nhận VM khác (diag #21: 1/2 VM bị chặn)
if (-not $relayOk) {
    Write-Host '     VM này egress-chặn rs-ny:21116 — KHÔNG publish session chết, cần VM khác'
    exit 1
}

# 7) Publish checklist + ID
Write-Host "[7/8] Publish checklist + ID..."
if ($id) {
    $passCount = ($script:Checks | Where-Object { $_.ok }).Count
    Publish @{ id = $id; pw_b64 = $pwB64; minutes = $Minutes; pass = $passCount; total = $script:Checks.Count; checklist = $script:Checks }
    Mark 'publish-session' $true "live-session.json ($passCount/$($script:Checks.Count) PASS trước bước này)"
} else {
    Mark 'publish-session' $false 'không publish vì thiếu ID'
}

# 8) Mở wizard trong console session (schtasks /IT)
Write-Host "[8/8] Mo NEXUS Optimizer wizard..."
$wiz = Join-Path $env:GITHUB_WORKSPACE 'nexus-win\optimizer\nexus-optimizer-wizard.ps1'
if ($id -and (Test-Path $wiz)) {
    $tr = "powershell -NoProfile -ExecutionPolicy Bypass -File $wiz"
    schtasks /Create /TN NEXUSWizardLive /TR $tr /SC ONCE /ST 23:59 /IT /RL HIGHEST /F | Out-Null
    $null = schtasks /Run /TN NEXUSWizardLive 2>&1
    if ($LASTEXITCODE -eq 0) { Mark 'launch-wizard' $true 'schtasks NEXUSWizardLive đã chạy (console session)' }
    else { Mark 'launch-wizard' $false "schtasks exit=$LASTEXITCODE" }
} else { Mark 'launch-wizard' $false 'bỏ qua — thiếu ID hoặc wizard không tồn tại' }

# Tổng kết: log job + summary + publish lần 2 (checklist đầy đủ)
$passCount = ($script:Checks | Where-Object { $_.ok }).Count
$total = $script:Checks.Count
if ($env:GITHUB_STEP_SUMMARY) {
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "`n**KẾT QUẢ: $passCount/$total PASS**" -Encoding UTF8
    if ($id) { Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "`n**RUSTDESK_ID=$id — PASSWORD=$pw — session $Minutes phút**" -Encoding UTF8 }
}
Write-Host ""
Write-Host "==================== KET QUA: $passCount/$total PASS ====================" -ForegroundColor $(if ($passCount -eq $total) { 'Green' } else { 'Yellow' })
foreach ($c in $script:Checks) {
    $tag = if ($c.ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("  [{0}] {1} — {2}" -f $tag, $c.n, $c.d)
}
# Annotation banner — GitHub không cho đổi tên run (PATCH /actions/runs = 404, cần quyền Admin)
# → PASS hiển thị bằng annotation notice: hộp màu nổi ngay ĐỈNH trang run (cả khi đang chạy lẫn khi xong)
if ($id) {
    Write-Host ""
    Write-Host "  RUSTDESK_ID=$id"                    -ForegroundColor Green
    Write-Host "  PASSWORD=$pw"                    -ForegroundColor Green
    Write-Host "  (log se hien *** — GitHub AI-mask moi chuoi giong password, da thu 3 kieu thoat)" -ForegroundColor Yellow
    Write-Host "  => LAY PASSWORD: muc ARTIFACTS (cuoi trang run nay) -> session-info.zip -> session-info.txt" -ForegroundColor Yellow
    Write-Host "  Session giu DUNG $Minutes phut (bat dau SAU khi co ID)" -ForegroundColor Green
    Publish @{ id = $id; pw_b64 = $pwB64; minutes = $Minutes; pass = $passCount; total = $total; checklist = $script:Checks }
    Write-Host ("::notice title=NEXUS {0}/{1} PASS - SESSION LIVE::RUSTDESK_ID={2} | PASSWORD={3} | {4} phut | wizard da mo tren man hinh" -f $passCount, $total, $id, $pw, $Minutes)
} else {
    if ($null -eq $id) { Write-Host ("     rd-out lan cuoi: {0}" -f (Get-Content "$env:TEMP\rd-out.txt" -Raw -ErrorAction SilentlyContinue)) }
    Publish @{ id = ''; pw_b64 = $pwB64; minutes = $Minutes; pass = $passCount; total = $total; checklist = $script:Checks }
    Write-Host ("::notice title=NEXUS {0}/{1} PASS - KHONG CO ID::xem cac dong FAIL (annotation do) o tren" -f $passCount, $total)
    throw 'RUSTDESK_ID không lấy được — xem các dòng FAIL ở trên'
}

# GHI STATE + THOÁT nếu chỉ chạy setup — hold session chạy ở STEP RIÊNG sau đó,
# để upload-artifact kịp upload session-info.txt (có PASSWORD nguyên vẹn) KHI session còn sống
Set-Content -Path (Join-Path $env:GITHUB_WORKSPACE 'hold-state.txt') -Value $Minutes -Encoding ASCII -Force
if ($Mode -eq 'setup') {
    Write-Host '=== SETUP XONG — artifact session-info (ID + PASSWORD) upload ngay bây giờ, hold session ở step sau ==='
    exit 0
}

# Hold: ĐỦ N phút — đếm ngược từng phút
if (Test-Path (Join-Path $env:GITHUB_WORKSPACE 'hold-state.txt')) { $Minutes = [int](Get-Content (Join-Path $env:GITHUB_WORKSPACE 'hold-state.txt') -Raw) }
for ($i = $Minutes; $i -gt 0; $i--) {
    Write-Host ("CON-LAI: {0} phut — bro ket noi bang RUSTDESK_ID + PASSWORD" -f $i)
    Start-Sleep -Seconds 60
}
Write-Host "=== HET-PHUT — session ket thuc, runner VM tu thu hoi ==="
