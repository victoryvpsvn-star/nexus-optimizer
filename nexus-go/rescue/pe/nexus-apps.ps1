# NEXUS App Installer + Sakura-style Debloat (WinPE v4.5)
# Tai installer CHINH CHU ve Windows that + dat RunOnce: khi boot lai Windows se
# tu debloat + tu cai apps. Khong bam tay gi sau khi boot lai.
$ErrorActionPreference = 'Continue'
Write-Host ''
Write-Host ('=' * 60)
Write-Host '  NEXUS APP INSTALLER + DEBLOAT - tai ve Windows that, tu cai khi boot lai'
Write-Host ('=' * 60)

$win = $null
foreach ($d in @('C:', 'D:', 'E:', 'F:')) {
  if (Test-Path ($d + '\Windows\System32\config\SOFTWARE')) { $win = $d; break }
}
if (-not $win) { Write-Host '[x] Khong tim thay Windows that - thoat'; exit }
Write-Host "[i] Windows that o: $win"
$appsDir = "$win\NEXUS-Apps"
$fbDir   = "$win\NEXUS"
New-Item -ItemType Directory -Force -Path $appsDir, $fbDir | Out-Null

# URL chinh chu (winget-source official)
$apps = [ordered]@{
  'Discord'    = @{ url = 'https://discord.com/api/downloads/distributions/app/installers/latest?channel=stable&platform=win&arch=x64'; args = '-s' }
  'Steam'      = @{ url = 'https://cdn.cloudflare.steamstatic.com/client/installer/SteamSetup.exe'; args = '/S' }
  'Chrome'     = @{ url = 'https://dl.google.com/chrome/install/latest/chrome_installer.exe'; args = '/silent /install' }
  'Opera GX'   = @{ url = 'https://net.geo.opera.com/opera_gx/stable/windows'; args = '/silent /install' }
  'Firefox'    = @{ url = 'https://download.mozilla.org/?product=firefox-latest&os=win&lang=en-US'; args = '/S' }
  'VLC'        = @{ url = 'https://get.videolan.org/vlc/last/win64/'; args = '/S' }
  'Edge'       = @{ url = 'https://go.microsoft.com/fwlink/?linkid=2108834&Channel=Stable&arch=x64'; args = '/silent /install' }
  'Epic Games' = @{ url = 'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncherInstaller.exe'; args = '/S' }
}

Write-Host ''
Write-Host '  [1] TAT CA (Discord, Steam, Chrome, Opera GX, Firefox, VLC, Edge, Epic)'
Write-Host '  [2] Chi Gaming (Steam, Discord, Epic, Opera GX, Chrome)'
Write-Host '  [3] Bo qua tai apps (chi debloat)'
$choice = Read-Host '  Chon (1/2/3)'
$selected = @()
if ($choice -eq '1') { $selected = @($apps.Keys) }
elseif ($choice -eq '2') { $selected = @('Steam', 'Discord', 'Epic Games', 'Opera GX', 'Chrome') }

foreach ($k in $selected) {
  $a = $apps[$k]
  $fn = ($k -replace ' ', '') + '.exe'
  $dst = Join-Path $appsDir $fn
  try {
    Write-Host ("  [dl] {0} ..." -f $k)
    Invoke-WebRequest -Uri $a.url -OutFile $dst -UseBasicParsing -TimeoutSec 600
    $sz = (Get-Item $dst).Length
    Write-Host ("       -> {0} ({1:N1} MB)" -f $fn, ($sz / 1MB))
  } catch { Write-Host ("       [skip] {0}: {1}" -f $k, $_.Exception.Message) }
}

# firstboot.ps1: debloat + cai apps silent khi boot lai Windows
$fb = @'
# NEXUS FirstBoot - chay 1 lan sau khi boot lai Windows (tai WinPE dat)
$ErrorActionPreference = 'Continue'
Write-Host 'NEXUS FirstBoot: debloat + cai apps...' -ForegroundColor Cyan

# --- Sakura-style debloat (an toan, chi remove UWP va task khong quan trong) ---
$bloated = @(
  '*Microsoft.3DBuilder*','*Microsoft.Print3D*','*Microsoft.3DViewer*','*Microsoft.SkypeApp*',
  '*Microsoft.MixedReality.Portal*','*Microsoft.BingWeather*','*Microsoft.BingNews*','*Microsoft.BingSearch*',
  '*Microsoft.GetHelp*','*Microsoft.Getstarted*','*Microsoft.MicrosoftSolitaireCollection*',
  '*Microsoft.Office.OneNote*','*Microsoft.People*','*Microsoft.Todos*','*Microsoft.WindowsFeedbackHub*',
  '*Microsoft.YourPhone*','*Microsoft.Xbox.TCUI*','*Microsoft.XboxGameOverlay*','*Microsoft.XboxGamingOverlay*',
  '*Microsoft.ZuneMusic*','*Microsoft.ZuneVideo*','*Microsoft.WindowsMaps*','*Microsoft.Copilot*',
  '*Clipchamp.Clipchamp*','*MicrosoftTeams*','*Microsoft.PowerAutomateDesktop*'
)
foreach ($p in $bloated) { try { Get-AppxPackage -Name $p -ErrorAction Stop | Remove-AppxPackage -ErrorAction Stop; Write-Host ('  [debloat] removed ' + $p) } catch {} }

# Game DVR off (thuc thi trong Windows)
try {
  New-Item -Path 'HKCU:\System\GameConfigStore' -Force | Out-Null
  Set-ItemProperty 'HKCU:\System\GameConfigStore' 'GameDVR_Enabled' 0 -Type DWord -Force
  Set-ItemProperty 'HKCU:\System\GameConfigStore' 'GameDVR_FSEBehaviorMode' 2 -Type DWord -Force -ErrorAction SilentlyContinue
} catch {}

# --- Cai apps silent ---
$appsDir = "$env:SystemDrive\NEXUS-Apps"
if (Test-Path $appsDir) {
  $silent = @{ 'Discord.exe' = '-s'; 'SteamSetup.exe' = '/S'; 'chrome_installer.exe' = '/silent /install';
               'OperaGX.exe' = '/silent /install'; 'Firefox.exe' = '/S'; 'VLC.exe' = '/S';
               'Edge.exe' = '/silent /install'; 'EpicGames.exe' = '/S' }
  Get-ChildItem $appsDir -Filter *.exe | ForEach-Object {
    $args = $silent[$_.Name]; if (-not $args) { $args = '/S' }
    Write-Host ('  [install] ' + $_.Name)
    try { Start-Process $_.FullName -ArgumentList $args -Wait -WindowStyle Hidden } catch { Write-Host ('    [skip] ' + $_.Exception.Message) }
  }
}
Write-Host 'NEXUS FirstBoot HOAN TAT.' -ForegroundColor Green

# --- Tat RunOnce de khong chay lai lan nua ---
try {
  Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'NEXUSFirstBoot' -ErrorAction SilentlyContinue
} catch {}
'@
$fbPath = "$fbDir\firstboot.ps1"
# LF->CRLF cho PowerShell Windows
$fbScript = ($fb -replace "`r`n", "`n") -replace "`n", "`r`n"
[System.IO.File]::WriteAllText("$win\NEXUS\firstboot.ps1", $fbScript)
Write-Host "[i] Da ghi firstboot script: $win\NEXUS\firstboot.ps1"

# RunOnce offline (boot lai Windows se tu chay)
reg load HKLM\NEXUS_SOFT "$win\Windows\System32\config\SOFTWARE" 2>&1 | Out-Null
if (Test-Path 'HKLM:\NEXUS_SOFT') {
  reg add "HKLM\NEXUS_SOFT\Microsoft\Windows\CurrentVersion\RunOnce" /v NEXUSFirstBoot /t REG_SZ /d "powershell -NoProfile -ExecutionPolicy Bypass -File $win\NEXUS\firstboot.ps1" /f 2>&1 | Out-Null
  Write-Host "[i] RunOnce NEXUSFirstBoot da dat - boot lai la chay."
  [gc]::Collect(); Start-Sleep 1
  reg unload HKLM\NEXUS_SOFT 2>&1 | Out-Null
} else { Write-Host '[x] Khong mount duoc SOFTWARE hive - dat RunOnce thu cong sau khi boot.' }
Write-Host ('=' * 60)
