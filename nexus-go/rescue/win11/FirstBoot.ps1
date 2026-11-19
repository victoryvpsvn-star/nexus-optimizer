# NEXUS Win11 Pro 24H2 Gaming - FirstBoot (chay 1 lan khi vao desktop lan dau)
# Log: C:\NEXUS\FirstBoot.log  |  Re-run: shortcut "NEXUS Gaming Setup" tren Desktop
$ErrorActionPreference = 'Continue'
$log = 'C:\NEXUS\FirstBoot.log'
New-Item -ItemType Directory -Force -Path 'C:\NEXUS' | Out-Null
function L($m) { $s = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m; Write-Host $s; Add-Content $log $s }

L '=== NEXUS Win11 Gaming FirstBoot bat dau ==='

# ---------- 1. HKCU tweaks (user Gamer) ----------
L '[1] HKCU tweaks (latency + visual)'
$u = 'HKCU:\Software\Microsoft\Windows\CurrentVersion'
reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\GameDVR' /v AppCaptureEnabled /t REG_DWORD /d 0 /f 2>&1 | Out-Null
reg add 'HKCU\System\GameConfigStore' /v GameDVR_Enabled /t REG_DWORD /d 0 /f 2>&1 | Out-Null
reg add 'HKCU\System\GameConfigStore' /v GameDVR_FSEBehaviorMode /t REG_DWORD /d 2 /f 2>&1 | Out-Null
reg add 'HKCU\System\GameConfigStore' /v GameDVR_HonorUserFSEBehaviorMode /t REG_DWORD /d 1 /f 2>&1 | Out-Null
reg add 'HKCU\System\GameConfigStore' /v GameDVR_DXGIHonorFSEWindowsCompatible /t REG_DWORD /d 1 /f 2>&1 | Out-Null
reg add 'HKCU\System\GameConfigStore' /v GameDVR_EFSEFeatureFlags /t REG_DWORD /d 0 /f 2>&1 | Out-Null
reg add "$u\Search" /v BingSearchEnabled /t REG_DWORD /d 0 /f 2>&1 | Out-Null
reg add 'HKCU\Software\Policies\Microsoft\Windows\Explorer' /v DisableSearchBoxSuggestions /t REG_DWORD /d 1 /f 2>&1 | Out-Null
reg add "$u\Explorer\Advanced" /v ShowTaskViewButton /t REG_DWORD /d 0 /f 2>&1 | Out-Null
reg add "$u\Explorer\Advanced" /v TaskbarMn /t REG_DWORD /d 0 /f 2>&1 | Out-Null
reg add "$u\Explorer\Advanced" /v TaskbarDa /t REG_DWORD /d 0 /f 2>&1 | Out-Null
reg add 'HKCU\Control Panel\Desktop' /v MenuShowDelay /t REG_SZ /d 0 /f 2>&1 | Out-Null
reg add 'HKCU\Control Panel\Desktop' /v MinAnimate /t REG_SZ /d 0 /f 2>&1 | Out-Null
reg add 'HKCU\Control Panel\Desktop\WindowMetrics' /v MinAnimate /t REG_SZ /d 0 /f 2>&1 | Out-Null
reg add "$u\Explorer\VisualEffects" /v TaskbarAnimations /t REG_DWORD /d 0 /f 2>&1 | Out-Null
reg add 'HKCU\Control Panel\Mouse' /v MouseSpeed /t REG_SZ /d 0 /f 2>&1 | Out-Null
reg add 'HKCU\Control Panel\Mouse' /v MouseSensitivity /t REG_SZ /d 10 /f 2>&1 | Out-Null
reg add 'HKCU\Control Panel\Mouse' /v MouseHoverTime /t REG_SZ /d 10 /f 2>&1 | Out-Null
# Menu chuot phai Win11 -> Win10 classic (toc do + quen thuan)
reg add 'HKCU\Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\InprocServer32' /ve /d '' /f 2>&1 | Out-Null
L 'HKCU done'

# ---------- 2. Power: Ultimate Performance ----------
L '[2] Power scheme Ultimate Performance'
try {
  $out = powercfg /duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61 2>&1 | Out-String
  $guid = [regex]::Match($out, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}').Value
  if ($guid) { powercfg /setactive $guid; L "Ultimate active: $guid" } else { L 'Ultimate duplicate: khong lay duoc guid' }
} catch { L ('power err: ' + $_.Exception.Message) }
powercfg /hibernate off 2>&1 | Out-Null

# ---------- 3. Scheduled tasks telemetry ----------
L '[3] Disable telemetry tasks'
$tasks = @(
  '\Microsoft\Windows\Application Experience\Microsoft Compatibility Appraiser',
  '\Microsoft\Windows\Application Experience\ProgramDataUpdater',
  '\Microsoft\Windows\Customer Experience Improvement Program\Consolidator',
  '\Microsoft\Windows\Customer Experience Improvement Program\UsbCeip',
  '\Microsoft\Windows\Autochk\Proxy',
  '\Microsoft\Windows\DiskDiagnostic\Microsoft-Windows-DiskDiagnosticDataCollector',
  '\Microsoft\Windows\Windows Error Reporting\QueueReporting',
  '\Microsoft\Windows\Feedback\Siuf\DmClient',
  '\Microsoft\Windows\Feedback\Siuf\DmClientOnScenarioDownload',
  '\Microsoft\Windows\Maps\MapsToastTask',
  '\Microsoft\Windows\Maps\MapsUpdateTask'
)
foreach ($t in $tasks) { try { schtasks /Change /TN $t /Disable 2>&1 | Out-Null } catch {} }
L 'tasks done'

# ---------- 4. Services nho them (offline da Start=4) ----------
L '[4] Services'
foreach ($svc in @('DiagTrack','dmwappushservice','SysMain','MapsBroker','RetailDemo')) {
  try { Set-Service -Name $svc -StartupType Disabled -ErrorAction Stop; L "svc disabled: $svc" } catch {}
}
try { Stop-Service DiagTrack -Force -ErrorAction SilentlyContinue } catch {}

# ---------- 5. Winget: cai apps game thu ----------
L '[5] Winget apps (Discord, Steam, Chrome, Opera GX)'
$apps = @(
  @{ id = 'Discord.Discord';  name = 'Discord' },
  @{ id = 'Valve.Steam';      name = 'Steam' },
  @{ id = 'Google.Chrome';    name = 'Chrome' },
  @{ id = 'Opera.GX';         name = 'Opera GX' }
)
$wg = Get-Command winget -ErrorAction SilentlyContinue
if ($wg) {
  foreach ($a in $apps) {
    L ('  install ' + $a.name + ' ...')
    try {
      winget install --id $a.id --silent --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | ForEach-Object { Add-Content $log ("    " + $_) }
      L ('  OK: ' + $a.name)
    } catch { L ('  SKIP: ' + $a.name + ' - ' + $_.Exception.Message) }
  }
} else { L '  winget khong co - chay shortcut sau khi Store cap nhat App Installer' }

# ---------- 6. Desktop shortcut re-run ----------
L '[6] Shortcut NEXUS Gaming Setup'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'NEXUS Gaming Setup.lnk'
try {
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath = 'powershell.exe'
  $sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -File C:\Windows\NEXUS\FirstBoot.ps1'
  $sc.WorkingDirectory = 'C:\NEXUS'
  $sc.IconLocation = 'C:\Windows\System32\shell32.dll,251'
  $sc.Description = 'NEXUS Gaming: tune lai + cai apps (Discord/Steam/Chrome/Opera GX)'
  $sc.Save()
  L 'shortcut OK'
} catch { L ('shortcut err: ' + $_.Exception.Message) }

L '=== NEXUS FirstBoot HOAN TAT - restart de clear menu context menu moi ==='
