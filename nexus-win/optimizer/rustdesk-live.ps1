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
    # publish bằng git push (checkout đã persist credentials với GITHUB_TOKEN) — tránh 401 của contents API
    try {
        $json = $data | ConvertTo-Json
        $f = Join-Path $env:GITHUB_WORKSPACE 'nexus-win\optimizer\live-session.json'
        Set-Content -Path $f -Value $json -Encoding Ascii -Force
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
Write-Host "     asset: $($asset.name) | Tai $url"
$exe = Join-Path $env:TEMP 'rustdesk-setup.exe'
Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing -TimeoutSec 300
Write-Host ("     da tai {0:N1} MB" -f ((Get-Item $exe).Length / 1MB))

# 2) Cài im lặng (NSIS /S) — có timeout 180s + Unblock (MotW) + exit code + tìm nhiều đường dẫn
Write-Host "[2/5] Cai im lang (/S)..."
Unblock-File $exe -ErrorAction SilentlyContinue
$p = Start-Process $exe -ArgumentList '/S' -PassThru
if (-not $p.WaitForExit(180000)) { try { $p.Kill() } catch { }; Publish @{ id = ''; password = ''; minutes = $Minutes; error = 'installer-timeout' }; throw 'installer timeout 180s' }
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
if (-not $script:rd) {
    Write-Host "     rustdesk.exe KHÔNG thấy ở các vị trí chuẩn — quét:" -ForegroundColor Red
    Get-ChildItem "$env:ProgramFiles", "$env:LOCALAPPDATA\Programs" -Directory -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("       - {0}" -f $_.FullName) }
    Publish @{ id = ''; password = ''; minutes = $Minutes; error = 'rustdesk-exe-missing' }
    throw 'rustdesk.exe không tồn tại sau khi cài (xem exit code + danh sách thư mục ở trên)'
}
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
