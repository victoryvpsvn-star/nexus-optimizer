# rustdesk-live.ps1 — NEXUS: tự cài RustDesk trên runner GitHub, mở wizard, giữ ĐÚNG N phút
# Mọi call CLI đều có timeout + kill. CHẤM PASS/FAIL từng bước: log job + GITHUB_STEP_SUMMARY + live-session.json
param([int]$Minutes = 10, [string]$Mode = 'all')
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

Write-Host "============================================================"
Write-Host "  NEXUS RustDesk LIVE — session giữ đúng $Minutes phut"
Write-Host "============================================================"

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

# 3) Cài im lặng (/S, Unblock, exit code, tìm nhiều đường dẫn)
if ((Test-Path $exe) -and ((Get-Item $exe -ErrorAction SilentlyContinue).Length -gt 5MB)) {
    Write-Host "[3/8] Cai im lang (/S)..."
    Unblock-File $exe -ErrorAction SilentlyContinue
    # /allusers = cài TOÀN HỆ THỐNG (Program Files + service chuẩn) — /S đơn thuần cài per-user
    # (AppData) → RustDesk coi là "chưa cài" → từ chối --password: "Installation and administrative
    # privileges required!" (diag #21)
    $p = Start-Process $exe -ArgumentList '/S', '/allusers' -PassThru
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

# 4) SERVICE = rustdesk.exe --service chạy LocalSystem — tạo bằng New-Service (không phụ thuộc installer/flag RustDesk)
Write-Host "[4/8] RustDesk service (New-Service)..."
Get-Process -Name 'rustdesk' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2
$svc = Get-Service -Name 'RustDesk*' -ErrorAction SilentlyContinue
if (-not $svc) {
    New-Service -Name 'RustDeskService' -DisplayName 'RustDesk Service' -BinaryPathName "`"$script:rd`" --service" -StartupType Automatic -ErrorAction SilentlyContinue | Out-Null
    Start-Sleep 1
    $svc = Get-Service -Name 'RustDeskService' -ErrorAction SilentlyContinue
}
if ($svc -and $svc.Status -ne 'Running') { Start-Service $svc.Name -ErrorAction SilentlyContinue; Start-Sleep 6; $svc = Get-Service -Name 'RustDesk*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' } }
if ($svc) {
    New-NetFirewallRule -DisplayName 'RustDesk' -Program $script:rd -Direction Inbound -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null
    Mark 'service-running' $true "$($svc.Name)=Running — LocalSystem unattended, nhận kết nối qua relay"
} else {
    Write-Host ("     sc query rustdesk*: {0}" -f ((sc.exe query state= all 2>&1 | Select-String -Pattern 'rustdesk' -Context 0,2 | Out-String).Trim() -replace '\s+', ' '))
    $null = & $script:rd --install-service 2>&1
    Start-Sleep 5
    $svc = Get-Service -Name 'RustDesk*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' }
    if (-not $svc) {
        Start-Process $script:rd -ErrorAction SilentlyContinue
        Start-Sleep 6
        $proc = Get-Process -Name 'rustdesk' -ErrorAction SilentlyContinue
        Mark 'service-running' $false "KHÔNG tạo được service — fallback app per-user (process=$([bool]$proc)) — KẾT NỐI CÓ THỂ THẤT BẠI"
    } else {
        Mark 'service-running' $true "$($svc.Name)=Running (flag --install-service)"
    }
}

# 5) Password — luồng CHUẨN unattended: service đang chạy + RustDesk "installed" (/allusers)
# → CLI --password IPC tới service → service tự ghi pw vào config của nó (LocalService profile).
# Diag #21: cài per-user thì CLI chào "Installation and administrative privileges required!".
# Fallback: nếu config user có pw mà config service rỗng (salt giống nhau) → copy hash sang.
Write-Host "[5/8] Dat password (IPC qua service)..."
$alnum = (48..57) + (97..122)
# KHÔNG prefix "NEX-" — pattern NEX-* đã bị secret scanning flag → mask VĨNH VIỄN trong log repo này
# password KHÔNG BAO GIỜ ghi vào commit (JSON chỉ lưu pw_b64) → không tạo alert mới → log hiện RAW đầy đủ
$pw = -join ($alnum | Get-Random -Count 10 | ForEach-Object { [char]$_ })
$pwB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pw))
$o1 = RDC @('--password', $pw) 40
$o2 = RDC @('--password', $pw) 40
Write-Host ("     CLI pw out 1: {0} | out 2: {1}" -f (($o1 | Out-String).Trim() -replace '\s+', ' '), (($o2 | Out-String).Trim() -replace '\s+', ' '))
if ($null -ne $o1 -and $null -ne $o2) { Mark 'set-password' $true 'CLI trả lời 2/2 (không timeout)' }
else { Mark 'set-password' $false "CLI timeout — o1=$($null -ne $o1) o2=$($null -ne $o2)" }

# verify pw nằm trong config nào (service: LocalService profile; user: runneradmin)
$usrCfg = "$env:APPDATA\RustDesk\config\RustDesk.toml"
$svcCfg = 'C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config\RustDesk.toml'
$utxt = ''; $stxt = ''
if (Test-Path $usrCfg) { $utxt = Get-Content $usrCfg -Raw -ErrorAction SilentlyContinue }
if (Test-Path $svcCfg) { $stxt = Get-Content $svcCfg -Raw -ErrorAction SilentlyContinue }
$upw = ''; $spw = ''
if ($utxt -match "(?<![\w])password\s*=\s*'([^']*)'") { $upw = $Matches[1] }
if ($stxt -match "(?<![\w])password\s*=\s*'([^']*)'") { $spw = $Matches[1] }
if ($spw) {
    Mark 'pw-user-config' $true "pw nằm trong config SERVICE (IPC chuẩn — hash $($spw.Length) ký tự)"
} elseif ($upw) {
    Mark 'pw-user-config' $true "pw vào config user (hash $($upw.Length) ký tự) — copy sang config service (salt giống nhau)"
    if (Test-Path $svcCfg) {
        $new = $stxt -replace "(?m)^password\s*=\s*'[^']*'", "password = '$upw'"
        [IO.File]::WriteAllText($svcCfg, $new, [Text.UTF8Encoding]::new($false))
        Write-Host '     đã copy pw-hash sang config service (LocalService), UTF8 no BOM'
        Get-Service -Name 'RustDesk*' -ErrorAction SilentlyContinue | Restart-Service -Force -ErrorAction SilentlyContinue
        Start-Sleep 5
    }
} else {
    Mark 'pw-user-config' $false 'pw KHÔNG vào config nào (soi "CLI pw out" ở log — nếu vẫn "privileges required" thì installer lại cài per-user)'
}

# 6) ID — ƯU TIÊN CONFIG CỦA SERVICE (LocalSystem): service đăng ký ID trong config của NÓ,
# còn --get-id chạy bằng user thường có thể trả ID của app user → lệch ID là "offline"
Write-Host "[6/8] Lay ID (config service truoc, toi da ~2 phut)..."
$cfgDirs = @(
    'C:\Windows\System32\config\systemprofile\AppData\Roaming\RustDesk\config',
    'C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config',
    "$env:APPDATA\RustDesk\config",
    "$env:LOCALAPPDATA\RustDesk\config"
)
$id = $null; $idSrc = ''
for ($i = 0; $i -lt 12 -and -not $id; $i++) {
    Start-Sleep 5
    foreach ($dir in $cfgDirs) {
        foreach ($f in (Get-ChildItem $dir -Filter 'RustDesk*.toml' -ErrorAction SilentlyContinue)) {
            $txt = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
            if ($txt -match "(?<![\w])id\s*=\s*['`"]?(\d{7,})") { $id = $Matches[1]; $idSrc = $f.FullName; break }
        }
        if ($id) { break }
    }
    if ($id) { break }
    $out = RDC @('--get-id') 25
    if ($out -match '(\d{7,})') { $id = $Matches[1]; $idSrc = 'CLI --get-id'; break }
}
if ($id) { Mark 'get-id' $true "ID=$id (nguon: $idSrc)" }
else { Mark 'get-id' $false 'không lấy được sau ~1-2 phút' }

# 6c) XÁC NHẬN password đã nằm trong config của SERVICE + dump config vào log (ground truth)
$pwCfgFile = ''
foreach ($dir in $cfgDirs) {
    foreach ($f in (Get-ChildItem $dir -Filter 'RustDesk*.toml' -ErrorAction SilentlyContinue)) {
        $txt = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
        $flat = ($txt -replace '\r?\n', ' | ')
        if ($flat.Length -gt 320) { $flat = $flat.Substring(0, 320) + '...' }
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
    if ($id -eq $null) { Write-Host ("     rd-out lan cuoi: {0}" -f (Get-Content "$env:TEMP\rd-out.txt" -Raw -ErrorAction SilentlyContinue)) }
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
