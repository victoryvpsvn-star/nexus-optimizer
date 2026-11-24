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
# Audit run #97 (26H2 26300): 20 package thuc te bi remove — blacklist khop dung cac bloat co mat.
# Them Widgets (WebExperience + WidgetsPlatformRuntime) — taskbar widgets an RAM + ads, gamer khong can.
$blacklist = 'Microsoft\.3DBuilder|Microsoft\.3DViewer|Microsoft\.BingNews|Microsoft\.BingWeather|Microsoft\.BingSearch|Microsoft\.Copilot|Microsoft\.GetHelp|Microsoft\.Getstarted|Microsoft\.MicrosoftOfficeHub|Microsoft\.MicrosoftSolitaireCollection|Microsoft\.MixedReality\.Portal|Microsoft\.Office\.OneNote|Microsoft\.OutlookForWindows|Microsoft\.People|Microsoft\.PowerAutomateDesktop|Microsoft\.Print3D|Microsoft\.SkypeApp|Microsoft\.Todos|Microsoft\.Windows\.DevHome|Microsoft\.WindowsFeedbackHub|Microsoft\.WindowsMaps|Microsoft\.YourPhone|Microsoft\.ZuneMusic|Microsoft\.ZuneVideo|MicrosoftCorporationII\.QuickAssist|microsoft\.microsoftskydrive|Clipchamp\.Clipchamp|MicrosoftTeams|^MSTeams|Microsoft\.XboxSpeechToTextOverlay|Microsoft\.Advertising\.Xaml|Microsoft\.549981C3F77F5|Microsoft\.Whiteboard|Microsoft\.MicrosoftStickyNotes|Microsoft\.WindowsSoundRecorder|Microsoft\.WindowsCamera|MicrosoftWindows\.Client\.WebExperience|Microsoft\.WidgetsPlatformRuntime'
$removed = 0
Get-AppxProvisionedPackage -Path $mnt | Where-Object { $_.DisplayName -match $blacklist } | ForEach-Object {
  Write-Host "  - $($_.DisplayName)"
  Remove-AppxProvisionedPackage -Path $mnt -PackageName $_.PackageName | Out-Null
  $removed++
}
Write-Host "Removed: $removed packages"

# AUDIT CHUYEN SAU (yeu cau bro): dump DAY DU danh sach provisioned con lai de doi chieu
# (lan sau khong phai doan mo coi nao con trong image), + KEEP-CHECK hang rao khong xoa nham:
$remain = Get-AppxProvisionedPackage -Path $mnt
Write-Host "=== AUDIT: provisioned CON LAI sau debloat: $($remain.Count) packages ==="
$remain | ForEach-Object { Write-Host "  + $($_.DisplayName)" }
$keepMust = @('Microsoft.WindowsStore', 'Microsoft.DesktopAppInstaller')
foreach ($k in $keepMust) {
  if (-not ($remain | Where-Object { $_.DisplayName -eq $k })) { throw "KEEP-CHECK FAIL: $k bi mat - Store/winget se hong, kiem tra blacklist" }
}
$keepWarn = @('Microsoft.VCLibs', 'Microsoft.UI.Xaml', 'Microsoft.NET.Native', 'Microsoft.SecHealthUI', 'Microsoft.StorePurchaseApp')
foreach ($k in $keepWarn) {
  if (-not ($remain | Where-Object { $_.DisplayName -like "$k*" })) { Write-Host "  [CANH BAO] khong thay $k* trong provisioned con lai" }
}
Write-Host "KEEP-CHECK OK: Store + DesktopAppInstaller con nguyen (can cho winget FirstBoot)"

# OneDrive consumer: xoa installer inline (26H2 van con OneDriveSetup.exe — run #97 xac nhan)
# + Run key first-logon — khong xoa thi OOBE van tu cai OneDrive
# Run #101: file co attribute ReadOnly/System trong offline mount → Remove-Item -Force
# van bi "Access denied" → bo attribute truoc. OneDrive la phan PHU: xoa khong duoc thi
# chi WARN (Run key da bi chan o buoc 5), KHONG de no gian do ca build.
foreach ($od in @("$mnt\Windows\System32\OneDriveSetup.exe", "$mnt\Windows\SysWOW64\OneDriveSetup.exe")) {
  if (-not (Test-Path $od)) { continue }
  try {
    $f = Get-Item $od -Force
    $f.Attributes = [IO.FileAttributes]::Normal
    $f.IsReadOnly = $false
    Remove-Item $od -Force
    Write-Host "  xoa $(Split-Path $od -Leaf) [$(Split-Path (Split-Path $od) -Leaf)]"
  } catch {
    Write-Host "  [NHE] khong xoa duoc $od — bo qua (Run key da chan, khong anh huong build)"
  }
}

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
# OneDrive: xoa Run key first-logon (installer da xoa o buoc 4 — day la phan con lai)
# Run #102: reg delete tren gia tri KHONG ton tai → stderr + EAP=Stop → terminating.
# Dung cmd /c de nuot hoan toan (key co san hay khong cung khong bao loi).
cmd /c "reg delete `"$S\Microsoft\Windows\CurrentVersion\Run`" /v OneDriveSetup /f >nul 2>&1"
cmd /c "reg delete `"$S\Microsoft\Windows\CurrentVersion\Run`" /v OneDriveStandaloneUpdateTaskLogon /f >nul 2>&1"
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
RA "$S\Policies\Microsoft\Windows\WindowsUpdate" 'TargetReleaseVersionInfo' '26H2' 'REG_SZ'
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

# ---------- 9. Export Pro-only (recovery) + SPLIT .swm ----------
# Bai hoc run 93/94: ISO 26H2 (26300) install.wim 7.6GB -> export Pro-only recovery = 5.21GB
# (>3.9GB - vuot gioi han file 4GB-1 cua ISO9660). Chuan Windows cho >4GB: SPLIT .swm
# (install.swm + install2.swm...) — Setup doc tu nhien (FAT32 USB), Rufus/Ventoy ok.
# Re-run: neu da export roi thi skip.
Write-Host '[9] Export Pro-only compress recovery + split swm...'
if ((Test-Path "$out\install.wim") -and ((Get-Item "$out\install.wim").Length -gt 1GB)) {
  Write-Host 'install.wim da export o lan truoc — skip'
} else {
  dism /Export-Image /SourceImageFile:"$src\sources\install.wim" /SourceIndex:$proIdx /DestinationImageFile:"$out\install.wim" /Compress:recovery /CheckIntegrity
  if ($LASTEXITCODE -ne 0) { throw "export failed ($LASTEXITCODE)" }
}
Move-Item "$out\install.wim" "$src\sources\install.wim" -Force
$sz2 = (Get-Item "$src\sources\install.wim").Length
Write-Host "install.wim final (Pro-only, recovery): $([math]::Round($sz2/1GB,2)) GB"
$info = Get-WindowsImage -ImagePath "$src\sources\install.wim"
if ($info.Count -ne 1) { throw "install.wim phai chi con 1 image (Pro)" }
Write-Host "Image duy nhat: $($info[0].ImageName)"
# SPLIT .swm — moi phan <=3800MB (<4GB-1 ISO9660)
Remove-Item "$src\sources\install*.swm" -Force -ErrorAction SilentlyContinue
dism /Split-Image /ImageFile:"$src\sources\install.wim" /SWMFile:"$src\sources\install.swm" /FileSize:3800
if ($LASTEXITCODE -ne 0) { throw "split swm failed ($LASTEXITCODE)" }
Remove-Item "$src\sources\install.wim" -Force
$swms = Get-ChildItem "$src\sources\install*.swm" | Sort-Object Name
if ($swms.Count -lt 2) { throw "split ra it hon 2 phan swm?" }
$swms | ForEach-Object { Write-Host "  $($_.Name): $([math]::Round($_.Length/1GB,2)) GB" }
if (($swms | Measure-Object Length -Maximum).Maximum -gt 3.9GB) { throw "co phan swm > 3.9GB - giam FileSize split" }
Write-Host 'TUNE-INSTALL-WIM-OK'
