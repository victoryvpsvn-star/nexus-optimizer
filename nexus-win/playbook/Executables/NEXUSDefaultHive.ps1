# NEXUSDefaultHive.ps1 — mirror baseline HKCU tweaks vào Default user hive (user mới nhận cùng cấu hình)
$ErrorActionPreference = 'Continue'
$h = 'HKU\AME_UserHive_Default'
$nt = "$env:SystemDrive\Users\Default\NTUSER.DAT"
if (-not (Test-Path $nt)) { Write-Warning "không thấy $nt — bỏ qua"; return }

reg unload $h 2>$null | Out-Null   # best-effort: version cũ có thể để hive load
reg load $h $nt | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Warning "reg load fail (hive đang bị dùng?) — bỏ qua"; return }

try {
    $p = "$h\Software\Microsoft\GameBar"
    reg add $p /v AutoGameModeEnabled /t REG_DWORD /d 1 /f | Out-Null
    reg add $p /v ShowStartupPanel /t REG_DWORD /d 0 /f | Out-Null
    reg add "$h\Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo" /v Enabled /t REG_DWORD /d 0 /f | Out-Null
    # Consumer features/suggestions cho user mới (mirror reinstall-blockers ở HKCU level)
    $cd = "$h\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager"
    foreach ($v in @('ContentDeliveryAllowed', 'OemPreInstalledAppsEnabled', 'PreInstalledAppsEnabled', 'PreInstalledAppsEverEnabled', 'SilentInstalledAppsEnabled', 'SoftLandingEnabled', 'SubscribedContentEnabled', 'SystemPaneSuggestionsEnabled', 'RotatingLockScreenOverlayEnabled')) {
        reg add $cd /v $v /t REG_DWORD /d 0 /f | Out-Null
    }
    Write-Output 'Default hive mirrored: GameBar + AdvertisingInfo + ContentDelivery'
} finally {
    [gc]::Collect(); Start-Sleep 1
    reg unload $h 2>$null | Out-Null
}
