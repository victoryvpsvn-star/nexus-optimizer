# nexus-optimizer-wizard.ps1 — NEXUS Optimizer (phong cách playbook FSOS-X/Atlas)
# Hỏi TỪNG MODULE trước khi tắt — không có gì bị tắt ngầm.
# HYPER-V: hỏi riêng, mặc định GIỮ, phải gõ đúng chữ YES mới tắt.
# KHÔNG BAO GIỜ đụng: Defender, Windows Update, Core Isolation/VBS (chơi game anti-cheat an toàn).
# Chạy: PowerShell Run as Administrator → powershell -NoProfile -ExecutionPolicy Bypass -File .\nexus-optimizer-wizard.ps1
param()
$ErrorActionPreference = 'Continue'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[!!] Chạy không đủ quyền — mở PowerShell Run as Administrator rồi chạy lại." -ForegroundColor Red
    exit 1
}

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$Report = "$env:USERPROFILE\Desktop\NEXUS-Optimizer-Report-$ts.txt"
$BackupDir = "$env:USERPROFILE\NEXUS-Backup\$ts"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$script:Step = 1

function Log([string]$m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
    Write-Host $line
    Add-Content -Path $Report -Value $line -Encoding UTF8
}

function Backup([string]$key, [string]$name) {
    $file = Join-Path $BackupDir ("$name.reg")
    $null = & reg.exe export "$key" "$file" /y 2>$null
    if ($LASTEXITCODE -eq 0) { Log "  backup: $key -> $name.reg" }
}

function Ask([string]$q, [string]$hint) {
    Write-Host ""
    Write-Host "[$script:Step] $q" -ForegroundColor Cyan
    if ($hint) { Write-Host "     $hint" -ForegroundColor DarkGray }
    $r = Read-Host "     Áp dụng? [y/N]"
    $script:Step++
    return ($r -match '^[Yy]')
}

function Remove-App([string]$name) {
    $p = Get-AppxPackage -AllUsers -Name $name -ErrorAction SilentlyContinue
    if ($p) { $p | Remove-AppxPackage -AllUsers -ErrorAction SilentlyContinue; Log "  gỡ appx: $name" }
    $prov = Get-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $name }
    foreach ($x in $prov) { Remove-AppxProvisionedPackage -Online -PackageName $x.PackageName -ErrorAction SilentlyContinue | Out-Null; Log "  gỡ provisioned: $name" }
    if (-not $p -and -not $prov) { Log "  (app không có trên máy: $name)" }
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  NEXUS OPTIMIZER — playbook kiểu FSOS-X / AtlasOS"          -ForegroundColor Cyan
Write-Host "  Moi module deu HOI truoc khi ap dung. Default = GIU."     -ForegroundColor Cyan
Write-Host "  HYPER-V: phai gõ YES (hoa) moi tat."                      -ForegroundColor Cyan
Write-Host "  Khong đụng: Defender / Windows Update / Core Isolation."  -ForegroundColor Cyan
Write-Host "  Backup reg: $BackupDir"                                    -ForegroundColor Cyan
Write-Host "  Report    : $Report"                                       -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Log "NEXUS Optimizer bắt đầu — Windows $($PSVersionTable.BuildVersion)"

# ---------- 0. ĐIỂM KHÔI PHỤC ----------
if (Ask "Tạo điểm khôi phục System Restore TRƯỚC khi tối ưu?" "Khuyến nghị — chỉ chạy được nếu System Restore đã bật trên C:") {
    try {
        Checkpoint-Computer -Description "NEXUS pre-optimizer $ts" -RestorePointType MODIFY_SETTINGS -ErrorAction Stop
        Log "Điểm khôi phục: đã tạo (NEXUS pre-optimizer $ts)"
    } catch {
        Log "Không tạo được điểm khôi phục tự động ($($_.Exception.Message)) — tạo tay: Start -> 'Create a restore point'"
    }
} else { Log "Bỏ qua tạo điểm khôi phục (người dùng chọn)" }

# ---------- 1. APP RÁC (dạng Win11Debloat — hỏi TỪNG app) ----------
if (Ask "Dọn app rác UWP (hỏi từng app, mặc định GIỮ hết)?" "Gõ y cho từng app muốn gỡ — app hệ thống quan trọng không nằm trong danh sách") {
    $apps = @(
        'MSTeams',                                   # Teams bản consumer
        'Clipchamp.Clipchamp',
        'Microsoft.News',
        'Microsoft.MicrosoftSolitaireCollection',
        'Microsoft.GetHelp',
        'Microsoft.Getstarted',
        'Microsoft.WindowsFeedbackHub',
        'Microsoft.BingWeather',
        'Microsoft.BingNews',
        'Microsoft.MicrosoftOfficeHub',
        'Microsoft.WindowsMaps',
        'Microsoft.Microsoft3DViewer'
    )
    foreach ($a in $apps) {
        $r = Read-Host ("     Gỡ '{0}'? [y/N]" -f $a)
        if ($r -match '^[Yy]') { Remove-App $a }
    }
} else { Log "Bỏ qua dọn app rác" }

# ---------- 2. STARTUP (liệt kê để tự xem — tắt trong Task Manager là an toàn nhất) ----------
Write-Host ""
Write-Host "[$script:Step] Startup đang có (chỉ LIỆT KÊ — tắt thủ công trong Task Manager để an toàn):" -ForegroundColor Cyan
Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host ("     - {0}  <-  {1}" -f $_.Name, $_.Command) -ForegroundColor DarkGray
    Log "  startup thấy: $($_.Name) <- $($_.Command)"
}
$script:Step++

# ---------- 3. TELEMETRY / DỊCH VỤ ĐO ĐẮM ----------
if (Ask "Giảm telemetry: tắt DiagTrack + dmwappushservice, telemetry về mức Basic?" "Không đụng Windows Update — chỉ đo đắm chẩn đoán") {
    Backup 'HKLM\SOFTWARE\Policies\Microsoft\Windows\DataCollection' 'DataCollection'
    foreach ($s in 'DiagTrack','dmwappushservice') {
        $svc = Get-Service -Name $s -ErrorAction SilentlyContinue
        if ($svc) {
            Stop-Service $s -Force -ErrorAction SilentlyContinue
            Set-Service $s -StartupType Disabled -ErrorAction SilentlyContinue
            Log "  service tắt: $s"
        }
    }
    New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection' -Force | Out-Null
    Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection' -Name AllowTelemetry -Value 1 -Type DWord
    Log "  AllowTelemetry = 1 (Basic — không phải mức Security)"
} else { Log "Bỏ qua telemetry" }

# ---------- 4. QUYỀN RIÊNG TƯ ----------
if (Ask "Quyền riêng tư: tắt Advertising ID, tailored experiences, feedback, Activity History?" "Toàn bộ backup vào NEXUS-Backup") {
    Backup 'HKCU\Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo' 'AdvertisingInfo'
    New-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo' -Force | Out-Null
    Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo' -Name Enabled -Value 0 -Type DWord
    New-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Privacy' -Force | Out-Null
    Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Privacy' -Name TailoredExperiencesWithDiagnosticDataEnabled -Value 0 -Type DWord
    New-Item 'HKCU:\Software\Microsoft\Siuf\Rules' -Force | Out-Null
    Set-ItemProperty 'HKCU:\Software\Microsoft\Siuf\Rules' -Name NumberOfSIUFInPeriod -Value 0 -Type DWord
    New-Item 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -Force | Out-Null
    Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -Name EnableActivityFeed -Value 0 -Type DWord
    Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -Name PublishUserActivities -Value 0 -Type DWord
    Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -Name UploadUserActivities -Value 0 -Type DWord
    Log "  Advertising ID / tailored / feedback / Activity History: TẮT"
} else { Log "Bỏ qua quyền riêng tư" }

# ---------- 5. GIAO DIỆN GIẢM TẢI ----------
if (Ask "Giao diện: tắt trong suốt + Widgets + Copilot + Recall?" "Hiệu ứng animation hỏi riêng bên dưới") {
    Backup 'HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' 'Personalize'
    Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name EnableTransparency -Value 0 -Type DWord
    Log "  Trong suốt: TẮT"
    Remove-App 'MicrosoftWindows.Client.WebExperience'   # Widgets
    New-Item 'HKCU:\Software\Policies\Microsoft\Windows\WindowsCopilot' -Force | Out-Null
    Set-ItemProperty 'HKCU:\Software\Policies\Microsoft\Windows\WindowsCopilot' -Name TurnOffWindowsCopilot -Value 1 -Type DWord
    Log "  Copilot: TẮT"
    New-Item 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsAI' -Force | Out-Null
    Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsAI' -Name DisableAIDataAnalysis -Value 1 -Type DWord
    Log "  Recall (WindowsAI): TẮT"
    $ve = Read-Host "     Hiệu ứng: 0=để Windows tự quyết, 1=đẹp nhất, 2=hiệu năng tốt nhất [0/1/2, Enter=giữ nguyên]"
    if ($ve -match '^[012]$') {
        Backup 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects' 'VisualEffects'
        Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects' -Name VisualFXSetting -Value ([int]$ve) -Type DWord
        Log "  Visual effects mode = $ve"
    }
} else { Log "Bỏ qua giao diện" }

# ---------- 6. GAME ----------
if (Ask "Game: bật Game Mode + tắt Game Bar/Game DVR + hỏi thêm HAGS + power plan?" "Game Mode GIỮ BẬT (có lợi FPS), chỉ tắt overlay/DVR") {
    Backup 'HKCU\Software\Microsoft\GameBar' 'GameBar'
    New-Item 'HKCU:\Software\Microsoft\GameBar' -Force | Out-Null
    Set-ItemProperty 'HKCU:\Software\Microsoft\GameBar' -Name AutoGameModeEnabled -Value 1 -Type DWord
    Log "  Game Mode: BẬT"
    Set-ItemProperty 'HKCU:\Software\Microsoft\GameBar' -Name ShowStartupPanel -Value 0 -Type DWord
    New-Item 'HKCU:\System\GameConfigStore' -Force | Out-Null
    Set-ItemProperty 'HKCU:\System\GameConfigStore' -Name GameDVR_Enabled -Value 0 -Type DWord
    New-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR' -Force | Out-Null
    Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR' -Name AppCaptureEnabled -Value 0 -Type DWord
    Log "  Game Bar overlay + Game DVR: TẮT"
    if (Ask "   Bật Hardware-accelerated GPU scheduling (HAGS)?" "Chỉ áp dụng nếu GPU + driver hỗ trợ (NVIDIA 10xx+ / AMD 5xxx+)") {
        Backup 'HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' 'GraphicsDrivers'
        Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' -Name HwSchMode -Value 2 -Type DWord
        Log "  HAGS: BẬT (2) — cần restart để hiệu lực"
    }
    if (Ask "   Chuyển power plan sang Ultimate/High Performance?" "Máy laptop chạy pin nên cân nhắc") {
        $out = & powercfg -duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61 2>$null
        if ("$out" -match '([0-9a-fA-F\-]{36})') {
            & powercfg /setactive $Matches[1] | Out-Null
            Log "  Power plan: Ultimate Performance ($($Matches[1]))"
        } else {
            & powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c | Out-Null
            Log "  Power plan: High Performance (Ultimate không tạo được trên máy này)"
        }
    }
} else { Log "Bỏ qua module game" }

# ---------- 7. HYPER-V — HỎI RIÊNG, GÕ YES MỚI TẮT ----------
Write-Host ""
Write-Host "[$script:Step] HYPER-V — MÔ ĐUN ĐẶC BIỆT (bắt buộc hỏi)" -ForegroundColor Magenta
try {
    $hv = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction Stop
    Log "  Hyper-V hiện tại: $($hv.State)"
    if ($hv.State -eq 'Enabled') {
        Write-Host "     Hyper-V đang BẬT. Dự án NEXUS cần nó để boot test ISO/VHDX." -ForegroundColor Yellow
        Write-Host "     Tắt sẽ làm chết: VM Hyper-V, WSL2, Docker Desktop, WSA, memory integrity vẫn giữ." -ForegroundColor Yellow
        $r = Read-Host "     Gõ đúng chữ YES (HOA) để TẮT — Enter hoặc chữ khác = GIỮ NGUYÊN"
        if ($r -ceq 'YES') {
            $res = Disable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -NoRestart -ErrorAction SilentlyContinue
            Log "  Hyper-V: ĐÃ TẮT (restart của máy mới hoàn tất) — bật lại: Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All"
        } else {
            Log "  Hyper-V: GIỮ NGUYÊN (mặc định an toàn cho NEXUS)"
        }
    } else {
        $r = Read-Host "     Hyper-V đang TẮT — bật lên để test NEXUS? [y/N]"
        if ($r -match '^[Yy]') {
            Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -NoRestart -ErrorAction SilentlyContinue | Out-Null
            Log "  Hyper-V: ĐÃ BẬT (restart của máy mới hoàn tất)"
        } else { Log "  Hyper-V: giữ nguyên trạng thái TẮT" }
    }
} catch {
    Log "  Không đọc được trạng thái Hyper-V ($($_.Exception.Message)) — có thể là Windows Home"
}
$script:Step++

# ---------- 8. KHÔNG ĐỤNG — IN THÔNG BÁO ----------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host " KHÔNG ĐỤNG (giữ nguyên 100% — vì anti-cheat):"          -ForegroundColor Yellow
Write-Host "   - Windows Defender (real-time protection)"             -ForegroundColor Yellow
Write-Host "   - Windows Update (không disable service)"              -ForegroundColor Yellow
Write-Host "   - Core Isolation / VBS / các mitigation bảo mật"       -ForegroundColor Yellow
Write-Host " Anti-cheat (Vanguard, ACE, EAC, BattlEye) cần đúng các"  -ForegroundColor Yellow
Write-Host " thành phần này — tắt là treo máy/ban tài khoản."         -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Yellow
Log "Defender/Update/Core Isolation: GIỮ NGUYÊN (quyết định cố định của playbook)"

# ---------- TỔNG KẾT ----------
Log "HOÀN TẤT — backup: $BackupDir | report: $Report"
Write-Host ""
Write-Host "=== XONG — report: $Report ===" -ForegroundColor Green
Write-Host "Restart mới có hiệu lực với HAGS/Hyper-V (nếu có đụng)."
Read-Host "Nhấn Enter để thoát"
