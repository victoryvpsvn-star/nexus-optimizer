# rustdesk-live.ps1 — NEXUS: tự cài RustDesk trên runner GitHub, mở wizard, giữ ĐÚNG N phút
# Chạy trong job CI (windows-latest, user runneradmin có console session — RustDesk service capture)
param([int]$Minutes = 10)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

Write-Host "============================================================"
Write-Host "  NEXUS RustDesk LIVE — session giữ đúng $Minutes phut"
Write-Host "============================================================"

# 1) Tải installer RustDesk mới nhất (asset chính thức x86_64 .exe)
$rel = Invoke-RestMethod 'https://api.github.com/repos/rustdesk/rustdesk/releases/latest' -Headers @{ 'User-Agent' = 'nexus-agent' }
$asset = $rel.assets | Where-Object { $_.name -match '^rustdesk-.*x86_64\.exe$' } | Select-Object -First 1
if (-not $asset) { throw "Khong tim thay asset installer rustdesk trong release $($rel.tag_name)" }
$url = $asset.browser_download_url
Write-Host "[1/5] Tai $url"
$exe = Join-Path $env:TEMP 'rustdesk-setup.exe'
Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
Write-Host ("     da tai {0:N1} MB" -f ((Get-Item $exe).Length / 1MB))

# 2) Cài im lặng (NSIS /S)
Write-Host "[2/5] Cai im lang (/S)..."
Start-Process $exe -ArgumentList '/S' -Wait
Start-Sleep 3
$rd = Join-Path $env:ProgramFiles 'RustDesk\rustdesk.exe'
if (-not (Test-Path $rd)) { $rd = Join-Path ${env:ProgramFiles(x86)} 'RustDesk\rustdesk.exe' }
if (-not (Test-Path $rd)) { throw "rustdesk.exe khong ton tai sau khi cai" }
Write-Host "     cai xong: $rd"

# 3) Đảm bảo service chạy
Write-Host "[3/5] Dam bao RustDesk service chay..."
Get-Service -Name 'RustDesk*' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Status -ne 'Running') { Start-Service $_.Name -ErrorAction SilentlyContinue }
    Write-Host ("     service {0}: {1}" -f $_.Name, $_.Status)
}

# 4) Đặt password cố định cho run này + lấy ID
Write-Host "[4/5] Dat password + lay ID (retry toi da 2 phut)..."
$alnum = (48..57) + (97..122)
$pw = 'NEX-' + (-join ($alnum | Get-Random -Count 8 | ForEach-Object { [char]$_ }))
& $rd --password $pw 2>$null | Out-Null
& $rd --password $pw 2>$null | Out-Null
$id = $null
for ($i = 0; $i -lt 24 -and -not $id; $i++) {
    Start-Sleep 5
    $out = (& $rd --get-id 2>$null) -as [string]
    if ($out -match '(\d{9,})') { $id = $Matches[1] }
}
if ($id) {
    Write-Host ""
    Write-Host "==================== KET NOI RUSTDESK ====================" -ForegroundColor Green
    Write-Host "  RUSTDESK_ID=$id"                                         -ForegroundColor Green
    Write-Host "  PASSWORD=$pw"                                         -ForegroundColor Green
    Write-Host "  (RustDesk app -> nhap ID -> nhap password -> Connect)" -ForegroundColor Green
    Write-Host "  Wizard NEXUS Optimizer da mo san trong man hinh"      -ForegroundColor Green
    Write-Host "  Session giu DUNG $Minutes phut roi runner tu thu hoi" -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host "RUSTDESK_ID=KHONG-LAY-DUOC" -ForegroundColor Red
    Write-Host "DIAG: chay lai --get-id de xem loi:" -ForegroundColor Yellow
    & $rd --get-id
}

# 5) Mở wizard NEXUS trong console session (schtasks /IT để vào interactive session)
Write-Host "[5/5] Mo NEXUS Optimizer wizard trong man hinh console..."
$wiz = Join-Path $env:GITHUB_WORKSPACE 'nexus-win\optimizer\nexus-optimizer-wizard.ps1'
if (-not (Test-Path $wiz)) { throw "khong thay wizard: $wiz" }
$tr = "powershell -NoProfile -ExecutionPolicy Bypass -File $wiz"
schtasks /Create /TN NEXUSWizardLive /TR $tr /SC ONCE /ST 23:59 /IT /RL HIGHEST /F | Out-Null
schtasks /Run /TN NEXUSWizardLive | Out-Null
Write-Host "     wizard da duoc launch (task NEXUSWizardLive)"

# 6) Giữ ĐÚNG N phút — đếm ngược từng phút trong log
for ($i = $Minutes; $i -gt 0; $i--) {
    Write-Host ("CON-LAI: {0} phut — bro ket noi bang RUSTDESK_ID + PASSWORD o tren" -f $i)
    Start-Sleep -Seconds 60
}
Write-Host "=== HET-PHUT — session ket thuc, runner VM tu thu hoi ==="
