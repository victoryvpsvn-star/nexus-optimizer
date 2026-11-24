# NEXUSAppx.ps1 — debloat AppX ONLINE cho playbook AME Wizard (bản cùng blacklist tune-install-wim.ps1)
# Tier Gaming  = full 126 pattern (Atlas parity + FSOS-X bloat/ai/m365/ads/OEM)
# Tier Core    = chỉ nhóm nền tảng an toàn
# Guardrails: GamingApp/GameBar/XboxIdentity/TCUI/Paint/ScreenSketch/Store/winget/SecHealthUI — KHÔNG bao giờ đụng
param([ValidateSet('Gaming', 'Core')][string]$Tier = 'Gaming')
$ErrorActionPreference = 'Continue'
$win = [Environment]::GetFolderPath('Windows')
$nx = "$win\NEXUS"
New-Item -ItemType Directory -Force -Path "$nx\Backups" | Out-Null

# --- Nhom nen tang (Atlas parity + FSOS core) — moi presét chay ---
$blPlatform = @(
  'Microsoft\.3DBuilder', 'Microsoft3DViewer', 'Microsoft\.3DViewer',
  'Microsoft\.BingNews', 'Microsoft\.BingWeather', 'Microsoft\.BingSearch',
  'Microsoft\.BingFinance', 'Microsoft\.BingSports', 'MicrosoftCorporationII\.Bing',
  'Microsoft\.Copilot', 'Microsoft\.Windows\.Copilot', 'MicrosoftWindows\.Client\.Copilot',
  'MicrosoftWindows\.Client\.AIX', 'Microsoft\.Windows\.Ai\.Copilot\.Provider', 'Microsoft\.Windows\.AIHub',
  'Microsoft\.549981C3F77F5', 'Microsoft\.549981C3F5F10',
  'Microsoft\.GetHelp', 'Microsoft\.Getstarted', 'Microsoft\.MicrosoftOfficeHub',
  'Microsoft\.MicrosoftSolitaireCollection', 'Microsoft\.MicrosoftStickyNotes', 'Microsoft\.StickyNotesPreview',
  'Microsoft\.MixedReality\.Portal', 'Microsoft\.Office\.OneNote',
  'Microsoft\.OutlookForWindows', 'Microsoft\.OutlookPWA',
  'Microsoft\.People', 'Microsoft\.Windows\.PeopleExperienceHost', 'microsoft\.windowscommunicationsapps',
  'Microsoft\.PowerAutomateDesktop', 'Microsoft\.MicrosoftPowerBIForWindows',
  'Microsoft\.Print3D', 'Microsoft\.MSPaint',
  'Microsoft\.SkypeApp', 'Microsoft\.Todos', 'Microsoft\.Wallet', 'Microsoft\.Whiteboard',
  'Microsoft\.Windows\.DevHome', 'Microsoft\.Windows\.SecureAssessmentBrowser',
  'Microsoft\.WindowsFeedbackHub', 'Microsoft\.WindowsMaps', 'Microsoft\.WindowsAlarms',
  'Microsoft\.WindowsBackup', 'Microsoft\.WindowsSoundRecorder', 'Microsoft\.WindowsCamera',
  'Microsoft\.StartExperiencesApp', 'Ink\.Handwriting\.Main\.Store',
  'Microsoft\.YourPhone', 'Microsoft\.ZuneMusic', 'Microsoft\.ZuneVideo',
  'MicrosoftCorporationII\.QuickAssist', 'MicrosoftCorporationII\.MicrosoftFamily',
  'MicrosoftCorporationII\.MailforSurfaceHub', 'Microsoft\.MicrosoftTeamsforSurfaceHub',
  'microsoft\.microsoftskydrive', 'Microsoft\.OneDrive',
  'Clipchamp\.Clipchamp', 'MicrosoftTeams', '^MSTeams',
  'Microsoft\.XboxSpeechToTextOverlay', 'Microsoft\.XboxApp',
  'Microsoft\.Advertising\.Xaml',
  'MicrosoftWindows\.Client\.WebExperience', 'Microsoft\.WidgetsPlatformRuntime'
)
# --- FSOS them: stub M365 + phu tung MS + sponsored + OEM (chi Gaming) ---
$blFsos = @(
  'Microsoft\.Office\.Word', 'Microsoft\.Office\.Excel', 'Microsoft\.Office\.PowerPoint', 'Microsoft\.Office\.Sway',
  'Microsoft\.M365Companions', '7EE7776C\.LinkedInforWindows', 'Microsoft\.MicrosoftJournal',
  'Microsoft\.PCManager', 'Microsoft\.NetworkSpeedTest', 'Microsoft\.Flipgrid',
  'Microsoft\.MicrosoftEdgeDevToolsClient',
  'AppleInc\.AppleMusicWin', 'AppleInc\.iTunes',
  'king\.com', 'SpotifyAB', 'TikTok', 'Netflix', 'Disney', 'Facebook', 'Instagram', 'Twitter',
  'Pandora', 'iHeartRadio', 'Shazam', 'Viber', 'WinZip', 'NYTCrossword', 'Duolingo',
  'Fitbit', 'Flipboard', 'EclipseManager', 'ActiproSoftware', 'CyberLink', 'PicsArt', 'Polarr',
  'Phototastic', 'Drawboard', 'Autodesk', 'XING', 'Wunderlist', 'TuneIn', 'SlingTV',
  'OneCalendar', 'ACGMediaPlayer', 'LiveWallpaper', 'Asphalt8', 'CaesarsSlots', 'COOKINGFEVER',
  'HiddenCity', 'MarchofEmpires', 'RoyalRevolt', 'AdobeSystemsIncorporated',
  'Amazon', 'PrimeVideo', 'HULU', 'Booking', 'Plex',
  'AD2F1837\.', 'DellInc\.', 'LenovoCompanyLimited\.', 'E046963F\.'
)
$bl = if ($Tier -eq 'Gaming') { $blPlatform + $blFsos } else { $blPlatform }
$blacklist = $bl -join '|'
Write-Output "NEXUS AppX debloat - Tier $Tier ($($bl.Count) patterns)"
$report = @()

# --- 1. Per-user (tat ca users) ---
foreach ($p in (Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue)) {
  if ($p.Name -match $blacklist) {
    try { Remove-AppxPackage -Package $p.PackageFullName -AllUsers -ErrorAction Stop; $report += "USER  | $($p.Name) | $($p.PackageFullName)" }
    catch { Write-Warning "per-user $($p.Name): $($_.Exception.Message)" }
  }
}

# --- 2. Provisioned (offline-friendly marker: Remove-AppxProvisionedPackage tu ghi Deprovisioned) ---
foreach ($p in (Get-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue)) {
  if ($p.DisplayName -match $blacklist) {
    try { Remove-AppxProvisionedPackage -Online -PackageName $p.PackageName | Out-Null; $report += "PROV  | $($p.DisplayName) | $($p.PackageName)" }
    catch { Write-Warning "provisioned $($p.DisplayName): $($_.Exception.Message)" }
  }
}

# --- 3. KEEP-CHECK (fail = abort voi thong bao ro) ---
$keepMust = @('Microsoft.WindowsStore', 'Microsoft.DesktopAppInstaller', 'Microsoft.XboxIdentityProvider', 'Microsoft.Xbox.TCUI', 'Microsoft.SecHealthUI')
foreach ($k in $keepMust) {
  if (-not (Get-AppxPackage -Name $k -ErrorAction SilentlyContinue)) {
    throw "KEEP-CHECK FAIL: $k da bi mat - guardrail bi xam pham (khong duoc xoa: Store/winget/Xbox sign-in/Defender UI)"
  }
}
Write-Output 'KEEP-CHECK OK: Store + winget + XboxIdentityProvider + TCUI + SecHealthUI nguyen ven'

# --- 4. Report ---
$report | Out-File "$nx\Backups\appx-removed-$Tier.txt" -Encoding utf8 -Force
Write-Output "Removed: $($report.Count) packages (Tier $Tier) — report: $nx\Backups\appx-removed-$Tier.txt"
