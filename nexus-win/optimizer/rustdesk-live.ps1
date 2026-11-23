# rustdesk-live.ps1 — NEXUS: tự cài RustDesk trên runner GitHub, mở wizard, giữ ĐÚNG N phút
# Mọi call CLI đều có timeout + kill (CLI rustdesk có thể block vô hạn khi service chưa sẵn sàng)
# ID lấy qua --get-id, fallback đọc config file của service (LocalService profile)
param([int]$Minutes = 10)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

Write-Host "============================================================"
Write-Host "  NEXUS RustDesk LIVE — session giữ đúng $Minutes phut"
Write-Host "============================================================"

function Publish([hashtable]$data) {
    $hdr = @{ Authorization = "Bearer $env:GITHUB_TOKEN"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'nexus-agent' }
    $api = "https://api.github.com/repos/$env:GITHUB_REPOSITORY/contents/nexus-win/optimizer/live-session.json"
    $sha = $null
    try { $g = Invoke-RestMethod -Uri ($api + '?ref=main') -Headers $hdr -Method Get -TimeoutSec 30; $sha = $g.sha } catch { }
    $json = $data | ConvertTo-Json
    $body = @{ message = 'live-session: NEXUS RustDesk session (auto)'; content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)); branch = 'main' }
    if ($sha) { $body.sha = $sha }
    try {
        Invoke-RestMethod -Uri $api -Headers $hdr -Method Put -Body ($body | ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 30 | Out-Null
        Write-Host '     published live-session.json'
    } catch { Write-Host ("     publish lỗi: {0}" -f $_.Exception.Message) }
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

# 1) Tải installer RustDesk mới nhất (asset chính thức x86_64 .exe)
Write-Host "[1/5] Lay release moi nhat..."
$rel = $null
foreach ($try in 1..2) {
    try { $rel = Invoke-RestMethod 'https://api.github.com/repos/rustdesk/rustdesk/releases/latest' -Headers @{ 'User-Agent' = 'nexus-agent' } -TimeoutSec 60; break }
    catch { Write-Host "     release API fail (lan $try): $($_.Exception.Message)"; Start-Sleep 5 }
}
if (-not $rel) { Publish @{ id = ''; password = ''; minutes = $Minutes; error = 'release-api-fail' }; throw 'không đọc được release API' }
$asset = $rel.assets | Where-Object { $_.name -match '^rustdesk-.*x86_64\.exe$' } | Select-Object -First 1
if (-not $asset) { Publish @{ id = ''; password = ''; minutes = $Minutes; error = 'asset-not-found' }; throw "không tìm thấy asset installer trong $($rel.tag_name)" }
$url = $asset.browser_download_url
Write-Host "     Tai $url"
$exe = Join-Path $env:TEMP 'rustdesk-setup.exe'
Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing -TimeoutSec 300
Write-Host ("     da tai {0:N1} MB" -f ((Get-Item $exe).Length / 1MB))

# 2) Cài im lặng (NSIS /S) — có timeout 180s
Write-Host "[2/5] Cai im lang (/S)..."
$p = Start-Process $exe -ArgumentList '/S' -PassThru
if (-not $p.WaitForExit(180000)) { try { $p.Kill() } catch { }; Publish @{ id = ''; password = ''; minutes = $Minutes; error = 'installer-timeout' }; throw 'installer timeout 180s' }
Start-Sleep 3
$script:rd = Join-Path $env:ProgramFiles 'RustDesk\rustdesk.exe'
if (-not (Test-Path $script:rd)) { $script:rd = Join-Path ${env:ProgramFiles(x86)} 'RustDesk\rustdesk.exe' }
if (-not (Test-Path $script:rd)) { Publish @{ id = ''; password = ''; minutes = $Minutes; error = 'rustdesk-exe-missing' }; throw 'rustdesk.exe không tồn tại sau khi cài' }
Write-Host "     cai xong: $script:rd"

# 3) Service chạy
Write-Host "[3/5] Dam bao RustDesk service chay..."
Get-Service -Name 'RustDesk*' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Status -ne 'Running') { Start-Service $_.Name -ErrorAction SilentlyContinue }
    Write-Host ("     service {0}: {1}" -f $_.Name, $_.Status)
}
Start-Sleep 5

# 4) Password + ID (CLI có timeout, fallback config service)
Write-Host "[4/5] Dat password + lay ID (toi da ~3 phut)..."
$alnum = (48..57) + (97..122)
$pw = 'NEX-' + (-join ($alnum | Get-Random -Count 8 | ForEach-Object { [char]$_ }))
$null = RDC @('--password', $pw) 40
$null = RDC @('--password', $pw) 40
$id = $null
for ($i = 0; $i -lt 20 -and -not $id; $i++) {
    Start-Sleep 5
    $out = RDC @('--get-id') 25
    if ($out -match '(\d{9,})') { $id = $Matches[1]; break }
    # fallback: ID nằm trong config của service (LocalService profile)
    $cfg = 'C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config\RustDesk.toml'
    $cfg2 = "$env:APPDATA\RustDesk\config\RustDesk.toml"
    foreach ($c in $cfg, $cfg2) {
        if (Test-Path $c) {
            $txt = Get-Content $c -Raw -ErrorAction SilentlyContinue
            if ($txt -match "id\s*=\s*['`"]?(\d{9,})") { $id = $Matches[1]; break }
        }
    }
    if ($id) { break }
}
if ($id) {
    Publish @{ id = $id; password = $pw; minutes = $Minutes; error = '' }
    Write-Host ""
    Write-Host "==================== KET NOI RUSTDESK ====================" -ForegroundColor Green
    Write-Host "  RUSTDESK_ID=$id"                                         -ForegroundColor Green
    Write-Host "  PASSWORD=$pw"                                         -ForegroundColor Green
    Write-Host "  (RustDesk app -> nhap ID -> nhap password -> Connect)" -ForegroundColor Green
    Write-Host "  Wizard NEXUS Optimizer da mo san trong man hinh"      -ForegroundColor Green
    Write-Host "  Session giu DUNG $Minutes phut tinh tu luc nay"       -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
} else {
    Write-Host "RUSTDESK_ID=KHONG-LAY-DUOC — DIAG ben duoi" -ForegroundColor Red
    Write-Host ("     rd-out lan cuoi: {0}" -f (Get-Content "$env:TEMP\rd-out.txt" -Raw -ErrorAction SilentlyContinue))
    Write-Host ("     rd-err lan cuoi: {0}" -f (Get-Content "$env:TEMP\rd-err.txt" -Raw -ErrorAction SilentlyContinue))
    Publish @{ id = ''; password = $pw; minutes = $Minutes; error = 'id-not-found' }
    throw 'RUSTDESK_ID không lấy được sau ~3 phút — xem DIAG trong log'
}

# 5) Mở wizard NEXUS trong console session (schtasks /IT)
Write-Host "[5/5] Mo NEXUS Optimizer wizard trong man hinh console..."
$wiz = Join-Path $env:GITHUB_WORKSPACE 'nexus-win\optimizer\nexus-optimizer-wizard.ps1'
if (-not (Test-Path $wiz)) { throw "khong thay wizard: $wiz" }
$tr = "powershell -NoProfile -ExecutionPolicy Bypass -File $wiz"
schtasks /Create /TN NEXUSWizardLive /TR $tr /SC ONCE /ST 23:59 /IT /RL HIGHEST /F | Out-Null
schtasks /Run /TN NEXUSWizardLive | Out-Null
Write-Host "     wizard da duoc launch (task NEXUSWizardLive)"

# 6) Giữ ĐÚNG N phút — đếm ngược từng phút (bắt đầu SAU khi có ID → bro hưởng trọn window)
for ($i = $Minutes; $i -gt 0; $i--) {
    Write-Host ("CON-LAI: {0} phut — bro ket noi bang RUSTDESK_ID + PASSWORD" -f $i)
    Start-Sleep -Seconds 60
}
Write-Host "=== HET-PHUT — session ket thuc, runner VM tu thu hoi ==="
