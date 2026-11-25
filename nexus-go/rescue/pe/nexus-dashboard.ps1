# NEXUS Rescue PE - dashboard cau hinh _ay _u (gaming ultra-light, v4.6.0)
# Chay trong WinPE: PowerShell + WMI + StorageWMI (_a inject vao image).
$ErrorActionPreference = 'Continue'
Clear-Host
$line = '=' * 66
Write-Host $line
Write-Host '   N E X U S   R E S C U E   P E   -   gaming ultra-light (v4.6.0)'
Write-Host $line
Write-Host ''

# --- CPU ---
try {
  $cpu = Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1
  Write-Host '[CPU]'
  Write-Host ('  ' + $cpu.Name.Trim())
  Write-Host ('  So loi xu ly: ' + $cpu.NumberOfCores + ' | So luong: ' + $cpu.NumberOfLogicalProcessors)
} catch {
  Write-Host '[CPU] khong doc duoc WMI: ' $_.Exception.Message
}
Write-Host ''

# --- RAM ---
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  $totalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
  $freeGB  = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
  $usedGB  = [math]::Round($totalGB - $freeGB, 2)
  Write-Host '[RAM]'
  Write-Host ('  Tong: {0} GB | Dang dung: {1} GB | Con trong: {2} GB' -f $totalGB, $usedGB, $freeGB)
} catch {
  Write-Host '[RAM] khong doc duoc: ' $_.Exception.Message
}
Write-Host ''

# --- O _ia - GB _a dung ---
try {
  Write-Host '[O dia - GB da dung]'
  Get-CimInstance Win32_LogicalDisk -ErrorAction Stop | ForEach-Object {
    if ($_.Size -gt 0) {
      $t = [math]::Round($_.Size / 1GB, 1)
      $f = [math]::Round($_.FreeSpace / 1GB, 1)
      $u = [math]::Round($t - $f, 1)
      Write-Host ('  {0} - tong {1} GB - da dung {2} GB - con {3} GB' -f $_.DeviceID, $t, $u, $f)
    }
  }
} catch {
  Write-Host '[O dia] khong doc duoc: ' $_.Exception.Message
}
Write-Host ''

# --- O vat ly + S.M.A.R.T (StorageWMI) ---
try {
  Write-Host '[O vat ly + SMART]'
  Get-PhysicalDisk -ErrorAction Stop | ForEach-Object {
    Write-Host ('  {0} | {1} | {2} | {3:N0} GB' -f $_.FriendlyName, $_.MediaType, $_.HealthStatus, ($_.Size / 1GB))
  }
} catch {
  Write-Host '  (StorageWMI khong san sang - bo qua SMART)'
}
Write-Host ''

# --- GPU ---
try {
  Write-Host '[GPU]'
  Get-CimInstance Win32_VideoController -ErrorAction Stop | ForEach-Object {
    Write-Host ('  ' + $_.Name + ' | ' + [math]::Round($_.AdapterRAM / 1GB, 2) + ' GB VRAM (neu bao 0/loi thi WMI chua nap du)')
  }
} catch {
  Write-Host '[GPU] khong doc duoc: ' $_.Exception.Message
}
Write-Host ''

# --- Mang + _ia chi web server ---
try {
  Write-Host '[Mang]'
  Get-CimInstance Win32_NetworkAdapterConfiguration -ErrorAction Stop |
    Where-Object { $_.IPAddress -and $_.IPAddress[0] -ne '0.0.0.0' } | ForEach-Object {
      Write-Host ('  {0} | IP: {1}' -f $_.Description, ($_.IPAddress -join ', '))
      $script:lanip = $_.IPAddress[0]
    }
} catch {
  Write-Host '[Mang] khong doc duoc: ' $_.Exception.Message
}
Write-Host ''
Write-Host $line
Write-Host ('  NEXUS Dashboard (mo tu may khac cung mang LAN): http://' + $(if ($lanip) { $lanip } else { '<ip>' }) + ':8080')
Write-Host '  PE nay chi chay trong RAM - KHONG thay doi Windows that tren may.'
Write-Host '  Cuu du lieu / diagnose / xem SMART - sau do boot lai Windows binh thuong.'
Write-Host $line
