# NEXUS Offline Gaming Tune (WinPE v4.6) - apply tweaks vao WINDOWS THAT (offline registry)
# An toan: chi ghi vai key quen thuoc, khong xoa file; snapshot/rollback = System Restore cua ban.
$ErrorActionPreference = 'Continue'
Write-Host ''
Write-Host ('=' * 60)
Write-Host '  NEXUS OFFLINE GAMING TUNE - apply vao Windows that (khong khoi dong)'
Write-Host ('=' * 60)

# Tim partition Windows that
$win = $null
foreach ($d in @('C:', 'D:', 'E:', 'F:')) {
  if (Test-Path ($d + '\Windows\System32\config\SOFTWARE')) { $win = $d; break }
}
if (-not $win) { Write-Host '[x] Khong tim thay Windows that - thoat'; exit }
Write-Host "[i] Windows that o: $win"

$soft = "$win\Windows\System32\config\SOFTWARE"
$sys  = "$win\Windows\System32\config\SYSTEM"

# Mount offline hive
reg load HKLM\NEXUS_SOFT "$soft" 2>&1 | Out-Null
reg load HKLM\NEXUS_SYS  "$sys" 2>&1 | Out-Null
if (-not (Test-Path 'HKLM:\NEXUS_SOFT')) { Write-Host '[x] reg load SOFTWARE that bai'; exit }

function Set-K($path, $name, $value, $type = 'DWord') {
  try {
    if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
    Set-ItemProperty -Path $path -Name $name -Value $value -Type $type -ErrorAction Stop
    Write-Host ('  [ok] ' + $path.Replace('HKLM\NEXUS_', '') + ' | ' + $name + ' = ' + $value)
  } catch { Write-Host ('  [skip] ' + $name + ': ' + $_.Exception.Message) }
}

$base = 'HKLM:\NEXUS_SOFT'
Write-Host ''
Write-Host '[1] HAGS (Hardware GPU Scheduling - tu Windows 10 2004)'
Set-K 'HKLM:\NEXUS_SYS\ControlSet001\Control\GraphicsDrivers' 'HwSchMode' 2

Write-Host '[2] Game Mode bat + Game Bar het nieu'
Set-K ($base + '\Microsoft\GameBar') 'AutoGameModeEnabled' 1
Set-K ($base + '\Microsoft\GameBar') 'AllowAutoGameMode' 1
Set-K ($base + '\Microsoft\GameBar') 'ShowStartupPanel' 0
Set-K ($base + '\Microsoft\GameBar') 'GamePanelStartupTipIndex' 3

Write-Host '[3] Game DVR / Background Recording TAT (tang FPS)'
Set-K ($base + '\Policies\Microsoft\Windows\GameDVR') 'AllowGameDVR' 0
Set-K ($base + '\Microsoft\Windows\CurrentVersion\GameDVR') 'AppCaptureEnabled' 0

Write-Host '[4] Telemetry + Ads giam nhe'
Set-K ($base + '\Policies\Microsoft\Windows\DataCollection') 'AllowTelemetry' 0
Set-K ($base + '\Microsoft\Windows\CurrentVersion\AdvertisingInfo') 'Enabled' 0

Write-Host '[5] SysMain/Superfetch + Delivery Optimization TAT (game thu SSD)'
Set-K 'HKLM:\NEXUS_SYS\ControlSet001\Services\SysMain' 'Start' 4
Set-K ($base + '\Policies\Microsoft\Windows\DeliveryOptimization') 'DODownloadMode' 0

Write-Host '[6] Power: bo CPU throttle token (UnthrottleFrequency - khong dam vao plan)'
Set-K 'HKLM:\NEXUS_SYS\ControlSet001\Control\Power\PowerThrottling' 'PowerThrottlingOff' 1

Write-Host '[7] Menu don drag/toan manh game (reduced latency)'
Set-K ($base + '\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile') 'SystemResponsiveness' 10
Set-K ($base + '\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games') 'GPU Priority' 8
Set-K ($base + '\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games') 'Priority' 6

# Unmount
[gc]::Collect(); Start-Sleep 1
reg unload HKLM\NEXUS_SOFT 2>&1 | Out-Null
reg unload HKLM\NEXUS_SYS 2>&1 | Out-Null
Write-Host ''
Write-Host '[done] Tweak da ghi vao Windows that - khoi dong lai Windows de hieu luc.'
Write-Host ('=' * 60)
