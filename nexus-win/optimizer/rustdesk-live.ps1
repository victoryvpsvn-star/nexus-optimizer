# rustdesk-live.ps1 — NEXUS: tự cài RustDesk trên runner GitHub, mở wizard, giữ ĐÚNG N phút
# Mọi call CLI đều có timeout + kill. CHẤM PASS/FAIL từng bước: log job + GITHUB_STEP_SUMMARY + live-session.json
param([int]$Minutes = 10)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

Write-Host "============================================================"
Write-Host "  NEXUS RustDesk LIVE — session giữ đúng $Minutes phut"
Write-Host "============================================================"

$script:Checks = @()
function Mark([string]$n, [bool]$ok, [string]$d) {
    $script:Checks += @{ n = $n; ok = $ok; d = $d }
    $tag = if ($ok) { 'PASS' } else { 'FAIL' }
    Write-Host "[$tag] $n — $d"
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
    # publish bằng git push (checkout đã persist credentials với GITHUB_TOKEN) — tránh 401 của contents API
    try {
        $json = $data | ConvertTo-Json -Depth 5
        $f = Join-Path $env:GITHUB_WORKSPACE 'nexus-win\optimizer\live-session.json'
        Set-Content -Path $f -Value $json -Encoding UTF8 -Force
        Push-Location $env:GITHUB_WORKSPACE
        git config user.name 'nexus-bot'
        git config user.email 'nexus-bot@users.noreply.github.com'
        git add nexus-win/optimizer/live-session.json
        git commit -m 'live-session: NEXUS RustDesk session (auto)' --no-verify | Out-Null
        git push origin HEAD:main 2>&1 | Out-Null
        Pop-Location
        Write-Host '     published live-session.json (git push)'
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

# 1) Release API
Write-Host "[1/8] Lay release moi nhat..."
$rel = $null
foreach ($try in 1..2) {
    try { $rel = Invoke-RestMethod 'https://api.github.com/repos/rustdesk/rustdesk/releases/latest' -Headers @{ 'User-Agent' = 'nexus-agent' } -TimeoutSec 60; break }
    catch { Write-Host "     release API fail (lan $try): $($_.Exception.Message)"; Start-Sleep 5 }
}
if ($rel) { Mark 'release-api' $true "tag $($rel.tag_name)" }
else { Mark 'release-api' $false 'API lỗi sau 2 lần thử' }

# 2) Tải installer
$exe = Join-Path $env:TEMP 'rustdesk-setup.exe'
$asset = $null
if ($rel) { $asset = $rel.assets | Where-Object { $_.name -match '^rustdesk-.*x86_64\.exe$' } | Select-Object -First 1 }
if ($asset) {
    Write-Host "[2/8] Tai $($asset.name)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exe -UseBasicParsing -TimeoutSec 300
    $mb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
    if ($mb -gt 5) { Mark 'download-installer' $true "$($asset.name) — $mb MB" }
    else { Mark 'download-installer' $false "file quá nhỏ ($mb MB) — download hỏng" }
} else {
    Mark 'download-installer' $false 'không tìm thấy asset x86_64.exe'
}

# 3) Cài im lặng (/S, Unblock, exit code, tìm nhiều đường dẫn)
if ($asset -and (Test-Path $exe) -and ((Get-Item $exe -ErrorAction SilentlyContinue).Length -gt 5MB)) {
    Write-Host "[3/8] Cai im lang (/S)..."
    Unblock-File $exe -ErrorAction SilentlyContinue
    $p = Start-Process $exe -ArgumentList '/S' -PassThru
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
    Publish @{ id = ''; password = ''; minutes = $Minutes; pass = ($script:Checks | Where-Object { $_.ok }).Count; total = $script:Checks.Count; checklist = $script:Checks }
    throw 'cài RustDesk thất bại — xem các dòng FAIL ở trên'
}

# 4) Service hoặc app (per-user install không có service — tự mở app để nhận kết nối)
Write-Host "[4/8] RustDesk service/app..."
Get-Service -Name 'RustDesk*' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Status -ne 'Running') { Start-Service $_.Name -ErrorAction SilentlyContinue }
}
$svc = Get-Service -Name 'RustDesk*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' }
if ($svc) {
    Start-Sleep 5
    Mark 'service/app-running' $true (($svc | ForEach-Object { "$($_.Name)=Running" }) -join ', ')
} else {
    Start-Process $script:rd -ErrorAction SilentlyContinue
    Start-Sleep 6
    $proc = Get-Process -Name 'rustdesk' -ErrorAction SilentlyContinue
    if ($proc) { Mark 'service/app-running' $true 'per-user mode — app rustdesk.exe đang chạy, nhận kết nối bình thường' }
    else { Mark 'service/app-running' $false 'không có service, không có process rustdesk' }
}

# 5) Password
Write-Host "[5/8] Dat password..."
$alnum = (48..57) + (97..122)
$pw = 'NEX-' + (-join ($alnum | Get-Random -Count 8 | ForEach-Object { [char]$_ }))
$o1 = RDC @('--password', $pw) 40
$o2 = RDC @('--password', $pw) 40
if ($null -ne $o1 -and $null -ne $o2) { Mark 'set-password' $true 'CLI trả lời 2/2 (không timeout)' }
else { Mark 'set-password' $false "CLI timeout — o1=$($null -ne $o1) o2=$($null -ne $o2)" }

# 6) ID (--get-id, fallback config service)
Write-Host "[6/8] Lay ID (toi da ~2 phut)..."
$id = $null
for ($i = 0; $i -lt 20 -and -not $id; $i++) {
    Start-Sleep 5
    $out = RDC @('--get-id') 25
    if ($out -match '(\d{9,})') { $id = $Matches[1]; break }
    foreach ($c in 'C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config\RustDesk.toml', "$env:APPDATA\RustDesk\config\RustDesk.toml") {
        if (Test-Path $c) {
            $txt = Get-Content $c -Raw -ErrorAction SilentlyContinue
            if ($txt -match "id\s*=\s*['`"]?(\d{9,})") { $id = $Matches[1]; break }
        }
    }
    if ($id) { break }
}
if ($id) { Mark 'get-id' $true "ID=$id" }
else { Mark 'get-id' $false 'không lấy được sau ~2 phút (rd-out/rd-err xem ở DIAG)' }

# 7) Publish checklist + ID
Write-Host "[7/8] Publish checklist + ID..."
if ($id) {
    $passCount = ($script:Checks | Where-Object { $_.ok }).Count
    Publish @{ id = $id; password = $pw; minutes = $Minutes; pass = $passCount; total = $script:Checks.Count; checklist = $script:Checks }
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
# ĐỔI TÊN RUN → "x/8 PASS - ID ..." hiện ngay ở DANH SÁCH run trên tab Actions (không cần mở log)
function RenameRun([string]$title) {
    try {
        $hdr = @{ Authorization = "Bearer $env:GITHUB_TOKEN"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'nexus-agent' }
        Invoke-RestMethod -Method Patch -Uri "https://api.github.com/repos/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID" -Headers $hdr -Body (@{ name = $title } | ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 30 | Out-Null
        Write-Host "     doi ten run thanh: $title"
    } catch { Write-Host ("     doi ten run lỗi: {0}" -f $_.Exception.Message) }
}
if ($id) {
    Write-Host ""
    Write-Host "  RUSTDESK_ID=$id"                    -ForegroundColor Green
    Write-Host "  PASSWORD=$pw"                    -ForegroundColor Green
    Write-Host "  Session giu DUNG $Minutes phut (bat dau SAU khi co ID)" -ForegroundColor Green
    Publish @{ id = $id; password = $pw; minutes = $Minutes; pass = $passCount; total = $total; checklist = $script:Checks }
    RenameRun ("RustDesk live - {0}/{1} PASS - ID {2} ({3} phut)" -f $passCount, $total, $id, $Minutes)
} else {
    if ($id -eq $null) { Write-Host ("     rd-out lan cuoi: {0}" -f (Get-Content "$env:TEMP\rd-out.txt" -Raw -ErrorAction SilentlyContinue)) }
    Publish @{ id = ''; password = $pw; minutes = $Minutes; pass = $passCount; total = $total; checklist = $script:Checks }
    RenameRun ("RustDesk live - {0}/{1} PASS - KHONG-CO-ID (FAIL)" -f $passCount, $total)
    throw 'RUSTDESK_ID không lấy được — xem các dòng FAIL ở trên'
}

# Giữ ĐÚNG N phút — đếm ngược từng phút (bắt đầu SAU khi có ID → bro hưởng trọn window)
for ($i = $Minutes; $i -gt 0; $i--) {
    Write-Host ("CON-LAI: {0} phut — bro ket noi bang RUSTDESK_ID + PASSWORD" -f $i)
    Start-Sleep -Seconds 60
}
Write-Host "=== HET-PHUT — session ket thuc, runner VM tu thu hoi ==="
