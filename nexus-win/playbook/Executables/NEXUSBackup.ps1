# NEXUSBackup.ps1 — snapshot hiện trạng TRƯỚC khi sửa (AppX families + services + tasks)
$ErrorActionPreference = 'Continue'
$win = [Environment]::GetFolderPath('Windows')
$bk = "$win\NEXUS\Backups"
New-Item -ItemType Directory -Force -Path $bk | Out-Null

# AppX family list — feeds the deprovision diff (Atlas trick: only '<=' side taken)
(Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue).PackageFamilyName |
    Sort-Object -Unique | Out-File "$bk\AppxPackagesOld.txt" -Encoding utf8

# Services start types (undo reference)
Get-Service | Select-Object Name, DisplayName, StartType |
    Export-Csv "$bk\services-before.csv" -NoTypeInformation -Encoding utf8

# Scheduled tasks state (undo reference)
schtasks /query /fo csv 2>$null | Out-File "$bk\scheduled-tasks-before.csv" -Encoding utf8

Write-Output "Backups: $bk (AppX families: $((Get-Content "$bk\AppxPackagesOld.txt").Count))"
