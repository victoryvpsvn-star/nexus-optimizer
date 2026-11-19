# NEXUS Win11 Pro 24H2 Gaming - tune install.wim offline (chay tren GitHub runner)
# Input : C:\win11src (ISO da giai nen), C:\win11mount (Trong), C:\win11out
# Output: C:\win11out\install.wim (Pro duy nhat, da debloat + tweak, compress recovery)
$ErrorActionPreference = 'Stop'
$src = 'C:\win11src'
$mnt = 'C:\win11mount'
$out = 'C:\win11out'
$isoFile = $args[0]
New-Item -ItemType Directory -Force -Path $mnt, $out | Out-Null

# ---------- 1. Giai nen ISO bang 7z (7-Zip co san tren runner) ----------
Write-Host '[1] Extract ISO...'
$sz = 'C:\Program Files\7-Zip\7z.exe'
if (-not (Test-Path $sz)) { $sz = '7z' }
& $sz x $isoFile -o"$src" -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw "7z extract failed ($LASTEXITCODE)" }
if (-not (Test-Path "$src\sources\install.wim")) { throw "install.wim thieu sau khi extract" }
Write-Host "install.wim: $([math]::Round((Get-Item "$src\sources\install.wim").Length/1GB,2)) GB"

# ---------- 2. Tim index Windows 11 Pro ----------
Write-Host '[2] Find Windows 11 Pro index...'
$imgs = Get-WindowsImage -ImagePath "$src\sources\install.wim"
$imgPro = $imgs | Where-Object { $_.ImageName -eq 'Windows 11 Pro' } | Select-Object -First 1
if (-not $imgPro) { throw "Khong tim thay Windows 11 Pro trong install.wim" }
$proIdx = $imgPro.ImageIndex
Write-Host "Pro index: $proIdx"

# ---------- 3. Mount + debloat AppX ----------
Write-Host "[3] Mount index $proIdx..."
dism /Mount-Image /ImageFile:"$src\sources\install.wim" /Index:$proIdx /MountDir:$mnt
if ($LASTEXITCODE -ne 0) { throw "mount install.wim failed ($LASTEXITCODE)" }

Write-Host '[4] Debloat provisioned AppX...'
$blacklist = 'Microsoft\.3DBuilder|Microsoft\.3DViewer|Microsoft\.BingNews|Microsoft\.BingWeather|Microsoft\.BingSearch|Microsoft\.Copilot|Microsoft\.GetHelp|Microsoft\.Getstarted|Microsoft\.MicrosoftOfficeHub|Microsoft\.MicrosoftSolitaireCollection|Microsoft\.MixedReality\.Portal|Microsoft\.Office\.OneNote|Microsoft\.OutlookForWindows|Microsoft\.People|Microsoft\.PowerAutomateDesktop|Microsoft\.Print3D|Microsoft\.SkypeApp|Microsoft\.Todos|Microsoft\.Windows\.DevHome|Microsoft\.WindowsFeedbackHub|Microsoft\.WindowsMaps|Microsoft\.YourPhone|Microsoft\.ZuneMusic|Microsoft\.ZuneVideo|MicrosoftCorporationII\.QuickAssist|microsoft\.microsoftskydrive|Clipchamp\.Clipchamp|MicrosoftTeams|^MSTeams|Microsoft\.XboxSpeechToTextOverlay|Microsoft\.Advertising\.Xaml|Microsoft\.549981C3F77F5|Microsoft\.Whiteboard|Microsoft\.MicrosoftStickyNotes|Microsoft\.WindowsSoundRecorder|Microsoft\.WindowsCamera'
$removed = 0
Get-AppxProvisionedPackage -Path $mnt | Where-Object { $_.DisplayName -match $blacklist } | ForEach-Object {
  Write-Host "  - $($_.DisplayName)"
  Remove-AppxProvisionedPackage -Path $mnt -PackageName $_.PackageName | Out-Null
  $removed++
}
Write-Host "Removed: $removed packages"
# OneDrive consumer inline (giai nen thi khong con OneDrive consumer?)
if (Test-Path "$mnt\Windows\System32\OneDriveSetup.exe") { Write-Host 'OneDriveSetup co - khong go (an toan)' }

# ---------- 5. Offline registry tweaks ----------
Write-Host '[5] Offline registry tweaks...'
reg load HKLM\NXS_SOFT "$mnt\Windows\System32\config\SOFTWARE" | Out-Null
reg load HKLM\NXS_SYS  "$mnt\Windows\System32\config\SYSTEM"  | Out-Null
function RA($key, $name, $val, $type = 'REG_DWORD') {
  reg add $key /v $name /t $type /d $val /f 2>&1 | Out-Null
}
$S = 'HKLM\NXS_SOFT'
$Y = 'HKLM\NXS_SYS'
# Game
RA "$S\Microsoft\GameBar" 'AutoGameModeEnabled' 1
RA "$S\Microsoft\GameBar" 'ShowStartupPanel' 0
RA "$S\Policies\Microsoft\Windows\GameDVR" 'AllowGameDVR' 0
RA "$Y\ControlSet001\Control\GraphicsDrivers" 'HwSchMode' 2
RA "$S\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile" 'SystemResponsiveness' 10
RA "$S\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile" 'NetworkThrottlingIndex' 0xffffffff
RA "$S\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games" 'GPU Priority' 8
RA "$S\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games" 'Priority' 6
RA "$S\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games" 'Scheduling Category' 'High' 'REG_SZ'
RA "$S\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games" 'SFIO Priority' 'High' 'REG_SZ'
RA "$Y\ControlSet001\Control\Session Manager\kernel" 'GlobalTimerResolutionRequests' 1
RA "$Y\ControlSet001\Control\Power\PowerThrottling" 'PowerThrottlingOff' 1
# Telemetry / ads / bloat
RA "$S\Policies\Microsoft\Windows\DataCollection" 'AllowTelemetry' 0
RA "$S\Policies\Microsoft\Windows\DataCollection" 'DoNotShowFeedbackNotifications' 1
RA "$S\Microsoft\Windows\CurrentVersion\AdvertisingInfo" 'Enabled' 0
RA "$S\Policies\Microsoft\Windows\DeliveryOptimization" 'DODownloadMode' 0
RA "$S\Policies\Microsoft\Windows\CloudContent" 'DisableWindowsConsumerFeatures' 1
RA "$S\Policies\Microsoft\Windows\CloudContent" 'DisableConsumerAccountStateContent' 1
RA "$S\Policies\Microsoft\Windows\CloudContent" 'DisableSoftLanding' 1
RA "$S\Microsoft\Windows\CurrentVersion\ContentDeliveryManager" 'ContentDeliveryAllowed' 0
RA "$S\Microsoft\Windows\CurrentVersion\ContentDeliveryManager" 'OemPreInstalledAppsEnabled' 0
RA "$S\Microsoft\Windows\CurrentVersion\ContentDeliveryManager" 'PreInstalledAppsEnabled' 0
RA "$S\Microsoft\Windows\CurrentVersion\ContentDeliveryManager" 'PreInstalledAppsEverEnabled' 0
RA "$S\Microsoft\Windows\CurrentVersion\ContentDeliveryManager" 'SilentInstalledAppsEnabled' 0
RA "$S\Microsoft\Windows\CurrentVersion\ContentDeliveryManager" 'SoftLandingEnabled' 0
RA "$S\Microsoft\Windows\CurrentVersion\ContentDeliveryManager" 'SubscribedContentEnabled' 0
RA "$S\Microsoft\Windows\CurrentVersion\ContentDeliveryManager" 'SystemPaneSuggestionsEnabled' 0
RA "$S\Microsoft\Windows\CurrentVersion\ContentDeliveryManager" 'RotatingLockScreenOverlayEnabled' 0
foreach ($k in @('310093','338387','338388','338389','338393','353698','88000326')) {
  RA "$S\Microsoft\Windows\CurrentVersion\ContentDeliveryManager" "SubscribedContent-$k`Enabled" 0
}
# Services (khong dong am muoi Defender)
RA "$Y\ControlSet001\Services\SysMain" 'Start' 4
RA "$Y\ControlSet001\Services\DiagTrack" 'Start' 4
RA "$Y\ControlSet001\Services\dmwappushservice" 'Start' 4
RA "$Y\ControlSet001\Services\MapsBroker" 'Start' 4
RA "$Y\ControlSet001\Services\RetailDemo" 'Start' 4
RA "$Y\ControlSet001\Services\WpcMonSvc" 'Start' 4
RA "$Y\ControlSet001\Control\Session Manager\Memory Management\PrefetchParameters" 'EnablePrefetcher' 0
RA "$Y\ControlSet001\Control\Session Manager\Memory Management\PrefetchParameters" 'EnableSuperfetch' 0
# Khoa LTS 24H2 - khong tu dong nang len ban moi
RA "$S\Policies\Microsoft\Windows\WindowsUpdate" 'TargetReleaseVersion' 1
RA "$S\Policies\Microsoft\Windows\WindowsUpdate" 'TargetReleaseVersionInfo' '24H2' 'REG_SZ'
RA "$S\Policies\Microsoft\Windows\WindowsUpdate" 'ProductPolicy' 'Windows 11' 'REG_SZ'
[gc]::Collect(); Start-Sleep 1
reg unload HKLM\NXS_SOFT | Out-Null
reg unload HKLM\NXS_SYS | Out-Null
Write-Host 'Registry done'

# ---------- 6. Copy unattend + FirstBoot ----------
Write-Host '[6] Inject unattend + FirstBoot...'
New-Item -ItemType Directory -Force -Path "$mnt\Windows\Panther", "$mnt\Windows\NEXUS" | Out-Null
Copy-Item 'nexus-go\rescue\win11\unattend.xml' "$mnt\Windows\Panther\unattend.xml" -Force
Copy-Item 'nexus-go\rescue\win11\FirstBoot.ps1' "$mnt\Windows\NEXUS\FirstBoot.ps1" -Force
foreach ($f in @("$mnt\Windows\Panther\unattend.xml", "$mnt\Windows\NEXUS\FirstBoot.ps1")) {
  if (-not (Test-Path $f)) { throw "thieu file inject: $f" }
}

# ---------- 7. Unmount commit ----------
Write-Host '[7] Unmount commit (6-12 phut)...'
[gc]::Collect(); Start-Sleep 2
dism /Unmount-Image /MountDir:$mnt /Commit
if ($LASTEXITCODE -ne 0) { throw "unmount commit failed ($LASTEXITCODE)" }

# ---------- 8. Boot.wim: LabConfig bypass TPM/SecureBoot/RAM/CPU ----------
Write-Host '[8] Boot.wim LabConfig bypass...'
dism /Mount-Image /ImageFile:"$src\sources\boot.wim" /Index:2 /MountDir:$mnt
if ($LASTEXITCODE -ne 0) { throw "mount boot.wim failed" }
reg load HKLM\NXS_BOOT "$mnt\Windows\System32\config\SYSTEM" | Out-Null
foreach ($k in @('BypassTPMCheck','BypassSecureBootCheck','BypassRAMCheck','BypassCPUCheck','BypassStorageCheck')) {
  reg add 'HKLM\NXS_BOOT\Setup\LabConfig' /v $k /t REG_DWORD /d 1 /f 2>&1 | Out-Null
}
[gc]::Collect(); Start-Sleep 1
reg unload HKLM\NXS_BOOT | Out-Null
dism /Unmount-Image /MountDir:$mnt /Commit
if ($LASTEXITCODE -ne 0) { throw "unmount boot.wim failed" }

# ---------- 9. Export Pro-only (compress recovery ~2.5-3.2GB < 4GB ISO9660) ----------
Write-Host '[9] Export Pro-only compress recovery...'
dism /Export-Image /SourceImageFile:"$src\sources\install.wim" /SourceIndex:$proIdx /DestinationImageFile:"$out\install.wim" /Compress:recovery /CheckIntegrity
if ($LASTEXITCODE -ne 0) { throw "export failed ($LASTEXITCODE)" }
Move-Item "$out\install.wim" "$src\sources\install.wim" -Force
$sz2 = (Get-Item "$src\sources\install.wim").Length
Write-Host "install.wim final: $([math]::Round($sz2/1GB,2)) GB"
if ($sz2 -gt 3.9GB) { throw "install.wim > 3.9GB - vuot gioi han ISO9660" }
Write-Host 'TUNE-INSTALL-WIM-OK'
