# NEXUSFinish.ps1 — gom backups thành install-report.html + marker
$ErrorActionPreference = 'Continue'
$win = [Environment]::GetFolderPath('Windows')
$nx = "$win\NEXUS"
$bk = "$nx\Backups"
$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm')
$appxFiles = @(Get-ChildItem "$bk\appx-removed-*.txt" -ErrorAction SilentlyContinue)

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('<!DOCTYPE html><html><head><meta charset="utf-8"><title>NEXUS install report</title>')
[void]$sb.AppendLine('<style>body{font-family:Segoe UI,sans-serif;background:#0f1115;color:#e6e6e6;max-width:900px;margin:2rem auto;padding:0 1rem}h1{color:#7ee787}h2{color:#79c0ff;margin-top:1.5rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #30363d;padding:6px 10px;text-align:left;font-size:13px}code{background:#161b22;padding:2px 6px;border-radius:4px}</style></head><body>')
[void]$sb.AppendLine("<h1>NEXUS Optimizer — install report</h1><p>Thời điểm: <b>$stamp</b> — máy: <code>$env:COMPUTERNAME</code> — build <code>$([Environment]::OSVersion.Version.Build)</code></p>")
[void]$sb.AppendLine('<h2>AppX đã gỡ (theo tier)</h2>')
if ($appxFiles.Count) {
    foreach ($f in $appxFiles) {
        $lines = @(Get-Content $f.FullName -ErrorAction SilentlyContinue | Where-Object { $_ })
        [void]$sb.AppendLine("<p><b>$($f.Name)</b> — $($lines.Count) packages</p><table><tr><th>Loại</th><th>Tên</th><th>Package</th></tr>")
        foreach ($l in $lines) {
            $cols = $l -split '\|', 3
            if ($cols.Count -ge 3) { [void]$sb.AppendLine("<tr><td>$($cols[0].Trim())</td><td>$($cols[1].Trim())</td><td>$($cols[2].Trim())</td></tr>") }
        }
        [void]$sb.AppendLine('</table>')
    }
} else { [void]$sb.AppendLine('<p>Không có file report AppX nào (bước debloat bị skip?).</p>') }
[void]$sb.AppendLine('<h2>Undo</h2>')
[void]$sb.AppendLine('<p>AppX đã gỡ cài lại được từ Store/winget. Deprovisioned markers nằm trong <code>HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Appx\AppxAllUserStore\Deprovisioned</code> — xóa key tương ứng để cho phép feature update cài lại. Backups gốc: <code>C:\Windows\NEXUS\Backups</code>. Restore point (nếu tạo): System Restore.</p>')
[void]$sb.AppendLine('</body></html>')
[IO.File]::WriteAllText("$nx\install-report.html", $sb.ToString(), [Text.UTF8Encoding]::new($false))

"install report: $nx\install-report.html | backups: $bk | Stamp: $stamp" | Out-File "$nx\NEXUS-installed.txt" -Encoding utf8 -Force
Write-Output "NEXUS-REPORT-OK: $nx\install-report.html"
