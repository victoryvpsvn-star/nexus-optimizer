# hyperv-test.ps1 — NEXUS NANO: boot test THẬT trên Hyper-V (không qemu)
# Tự tạo VM Gen 2 riêng (không đụng VM đang có), boot ISO/VHDX, đọc COM1 qua named pipe,
# chạy check trong guest qua serial (giống CI expect nhưng trên phần cứng ảo thật của bro),
# đo thời gian boot thật, sample CPUUsage/Heartbeat/Uptime, xuất report + serial log.
#
# CÁCH DÙNG (PowerShell Run as Administrator, trên máy có Hyper-V):
#   powershell -ExecutionPolicy Bypass -File hyperv-test.ps1 -IsoPath .\nexus-v2.iso
#   powershell -ExecutionPolicy Bypass -File hyperv-test.ps1 -IsoPath .\nexus-v2.iso -VhdxPath .\nexus-linux-nano.vhdx
#   powershell -ExecutionPolicy Bypass -File hyperv-test.ps1 -IsoPath .\nexus-v2.iso -KeepVm   (giữ VM chạy để tự nối PuTTY)
# Không truyền path → tự tải artifact mới nhất từ release (repo public hoặc có GH_TOKEN).
#
# Kết quả: thư mục nexus-hyperv-report\<timestamp>\ chứa serial-iso.log, serial-vhdx.log,
# report.txt, report.json. Exit code 0 = tất cả PASS.
param(
    [string]$IsoPath  = "",
    [string]$VhdxPath = "",
    [string]$VmName   = "nx-hvtest",
    [int]   $BootTimeoutSec = 240,
    [switch]$KeepVm
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------- guard ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "❌ Chạy PowerShell Run as Administrator (Hyper-V cmdlets cần quyền admin)"; exit 2 }
if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) { Write-Host "❌ Không thấy module Hyper-V — bật vai trò Hyper-V trước"; exit 2 }
Import-Module Hyper-V -ErrorAction SilentlyContinue

$Repo = "victoryvpsvn-star/nexus-optimizer"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$ReportDir = Join-Path (Get-Location).Path "nexus-hyperv-report\$stamp"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

function Write-Log([string]$msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -Path (Join-Path $ReportDir 'report.txt') -Value $line -Encoding UTF8
}

function Get-ReleaseAsset([string]$tag, [string]$asset, [string]$outFile) {
    if (Test-Path $outFile) { return $outFile }
    Write-Log "Tải $asset từ release $tag ..."
    $hdr = @{}
    if ($env:GH_TOKEN) { $hdr['Authorization'] = "Bearer $env:GH_TOKEN" }
    $rel = Invoke-RestMethod -Headers $hdr -Uri "https://api.github.com/repos/$Repo/releases/tags/$tag"
    $a = $rel.assets | Where-Object { $_.name -eq $asset } | Select-Object -First 1
    if (-not $a) { throw "Không thấy asset $asset trong release $tag" }
    Invoke-WebRequest -Headers $hdr -Uri $a.browser_download_url -OutFile $outFile -UseBasicParsing
    return $outFile
}

if (-not $IsoPath)  { $IsoPath  = Get-ReleaseAsset 'nexus-nano-v2' 'nexus-v2.iso'           (Join-Path $ReportDir 'nexus-v2.iso') }
if (-not $VhdxPath) { $VhdxPath = Get-ReleaseAsset 'nexus-nano-v1' 'nexus-linux-nano.vhdx' (Join-Path $ReportDir 'nexus-linux-nano.vhdx') }
foreach ($p in @($IsoPath, $VhdxPath)) { if ($p -and -not (Test-Path $p)) { Write-Host "❌ Không thấy file: $p"; exit 2 } }

$sw = Get-VMSwitch | Where-Object { $_.Name -like '*Default*' } | Select-Object -First 1
if (-not $sw) { $sw = Get-VMSwitch | Select-Object -First 1 }
if (-not $sw) { Write-Host "❌ Không có vSwitch nào — tạo Default Switch hoặc truyền -SwitchName"; exit 2 }
Write-Log "vSwitch: $($sw.Name)"

# ---------- serial helpers (biến script-scope: Pipe, Writer, SerialLog, SerialFile, Samples) ----------
function Connect-Serial {
    param([string]$Name)
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Name, [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(60000)
    $script:Pipe   = $pipe
    $script:Writer = New-Object System.IO.StreamWriter -ArgumentList $pipe
    $script:Writer.AutoFlush = $true
    $script:Pending = $null
}

function Send-Serial([string]$text) {
    $script:Writer.Write($text + "`r")
    $script:Writer.Flush()
}

function Read-SerialUntil {
    param([string]$Pattern, [int]$TimeoutSec, [switch]$Quiet)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $buf = New-Object byte[] 4096
    while ((Get-Date) -lt $deadline) {
        if (-not $script:Pending) { $script:Pending = $script:Pipe.ReadAsync($buf, 0, $buf.Length) }
        if ($script:Pending.Wait(250)) {
            $n = $script:Pending.Result
            $script:Pending = $null
            if ($n -gt 0) {
                $chunk = [Text.Encoding]::ASCII.GetString($buf, 0, $n)
                $script:SerialLog.Append($chunk) | Out-Null
                Add-Content -Path $script:SerialFile -Value $chunk -NoNewline -Encoding ASCII
                if ($chunk -match $Pattern) { return $true }
            }
        } else {
            # không có dữ liệu trong 250ms — dịp sample VM (throttle ~2s/lần cho đỡ nặng VMMS)
            if (((Get-Date) - $script:LastSample).TotalSeconds -ge 2) {
                $script:LastSample = Get-Date
                try {
                    $vm = Get-VM -Name $script:VmName -ErrorAction Stop
                    $script:Samples += [pscustomobject]@{ t = (Get-Date -Format 'HH:mm:ss'); cpu = $vm.CPUUsage; hb = $vm.Heartbeat; up = [math]::Round($vm.Uptime.TotalSeconds, 0); state = [string]$vm.State }
                    if ($vm.State -ne 'Running') { Write-Log "VM chuyển state: $($vm.State) — dừng đọc serial"; return $false }
                } catch { return $false }
            }
            Start-Sleep -Milliseconds 200
        }
    }
    return $false
}

# ---------- một vòng boot test ----------
function Invoke-BootTest {
    param([string]$Kind, [string]$Path)   # Kind: iso | vhdx
    $script:VmName     = "$VmName-$Kind"
    $pipeName          = "$VmName-com"
    $script:SerialFile = Join-Path $ReportDir "serial-$Kind.log"
    $script:SerialLog  = New-Object System.Text.StringBuilder
    $script:Samples    = @()
    $script:LastSample = (Get-Date).AddSeconds(-5)
    Set-Content -Path $script:SerialFile -Value '' -Encoding ASCII

    Write-Log "=== [$Kind] Dọn VM cũ + tạo VM $script:VmName (Gen2, 1GB, SB off, COM \\.\pipe\$pipeName) ==="
    Get-VM -Name $script:VmName -ErrorAction SilentlyContinue | ForEach-Object { Stop-VM -VM $_ -TurnOff -Force -ErrorAction SilentlyContinue; Remove-VM -VM $_ -Force }
    $vm = New-VM -Name $script:VmName -Generation 2 -MemoryStartupBytes 1GB -NoVHD -SwitchName $sw.Name
    Set-VMFirmware -VMName $script:VmName -EnableSecureBoot Off
    Set-VMComPort  -VMName $script:VmName -Number 1 -Path "\\.\pipe\$pipeName"

    if ($Kind -eq 'iso') {
        Add-VMDvdDrive -VMName $script:VmName -Path $Path
        if ($VhdxPath -and (Test-Path $VhdxPath)) { Add-VMHardDiskDrive -VMName $script:VmName -Path $VhdxPath; $attachVhdx = $true }
        Set-VMFirmware -VMName $script:VmName -FirstBootDevice (Get-VMDvdDrive -VMName $script:VmName)
    } else {
        Add-VMHardDiskDrive -VMName $script:VmName -Path $Path
        Set-VMFirmware -VMName $script:VmName -FirstBootDevice (Get-VMHardDiskDrive -VMName $script:VmName | Select-Object -First 1)
    }

    $res = [ordered]@{ kind = $Kind; bootSec = $null; NK = $false; DB22 = $false; NPST = $false; TV = $false; SD = 'n/a'; CD9660 = 'n/a'; MEMKB = $null; cpuAvg = $null; cpuMax = $null; hb = $null; PASS = $false; serialLog = $script:SerialFile }
    $t0 = Get-Date
    try {
        Start-VM -VM $vm
        Write-Log "[$Kind] VM đã start — nối pipe + chờ NANO-READY (tối đa $BootTimeoutSec s) ..."
        Connect-Serial -Name $pipeName
        $ready = Read-SerialUntil -Pattern 'NANO-READY' -TimeoutSec $BootTimeoutSec
        $res.bootSec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
        if (-not $ready) {
            Write-Log "❌ [$Kind] KHÔNG thấy NANO-READY trong $($res.bootSec)s — serial log: $script:SerialFile (gửi file này cho tôi xem dòng chết)"
            return $res
        }
        Write-Log "✅ [$Kind] NANO-READY sau $($res.bootSec)s từ Start-VM (boot thật trên Hyper-V)"

        Start-Sleep -Seconds 2
        Send-Serial 'R=$(uname -r); echo NK=$R'
        $res.NK = Read-SerialUntil -Pattern 'NK=6\.1\.100-nexus1' -TimeoutSec 60
        Write-Log ("[$Kind] kernel  : {0}" -f $(if ($res.NK) { 'OK 6.1.100-nexus1' } else { 'FAIL — không thấy NK= (log serial để xem)' }))

        Send-Serial 'B=$(netstat -tln 2>/dev/null | grep -c ":22 " || echo 0); echo DB22=$B'
        $res.DB22 = Read-SerialUntil -Pattern 'DB22=[1-9]' -TimeoutSec 60
        Write-Log ("[$Kind] dropbear: {0}" -f $(if ($res.DB22) { 'đang nghe :22' } else { 'FAIL' }))

        Send-Serial 'T=$(nx install tree >/dev/null 2>&1 && echo OK); echo NPST=$T'
        $res.NPST = Read-SerialUntil -Pattern 'NPST=OK' -TimeoutSec 180
        Send-Serial 'V=$(tree --version | head -c6); echo TV=$V'
        $res.TV = Read-SerialUntil -Pattern 'TV=tree v' -TimeoutSec 60
        Write-Log ("[$Kind] NPS     : {0}" -f $(if ($res.NPST -and $res.TV) { 'nx install tree OK' } else { 'FAIL' }))

        if ($Kind -eq 'vhdx' -or $attachVhdx) {
            Send-Serial 'D=$(ls /dev/sd* 2>/dev/null | head -1); echo SD=$D'
            if (Read-SerialUntil -Pattern 'SD=/dev/sd' -TimeoutSec 60) { $res.SD = 'OK (storvsc thấy disk thật)' } else { $res.SD = 'FAIL' }
            Write-Log "[$Kind] storvsc : $($res.SD)"
        }
        if ($Kind -eq 'iso') {
            Send-Serial 'M=$(mkdir -p /mnt; mount -t iso9660 /dev/sr0 /mnt 2>&1 && echo MOK); echo CD9660=$M'
            if (Read-SerialUntil -Pattern 'CD9660=MOK' -TimeoutSec 60) { $res.CD9660 = 'OK (đọc lại chính CD)' } else { $res.CD9660 = 'FAIL' }
            Write-Log "[$Kind] CD      : $($res.CD9660)"
        }

        Send-Serial 'A=$(grep MemAvailable /proc/meminfo | tr -dc "0-9"); echo MEMAVAILKB=$A'
        Read-SerialUntil -Pattern 'MEMAVAILKB=[0-9]+' -TimeoutSec 30 | Out-Null
        if ($script:SerialLog.ToString() -match 'MEMAVAILKB=(\d+)') { $res.MEMKB = [int]$Matches[1] }
        Write-Log ("[$Kind] RAM free: {0} MB" -f $(if ($res.MEMKB) { [math]::Round($res.MEMKB/1024, 1) } else { '?' }))

        Send-Serial 'echo HVTEST-PASS'
        $pass = Read-SerialUntil -Pattern 'HVTEST-PASS' -TimeoutSec 30
        $res.PASS = ($res.NK -and $res.DB22 -and $res.NPST -and $res.TV -and $pass)
        Write-Log ("[$Kind] KẾT QUẢ: {0}" -f $(if ($res.PASS) { '✅ PASS' } else { '❌ FAIL (xem report.txt + serial log)' }))
        # tổng hợp sample CPU/Heartbeat của vòng này
        if ($script:Samples.Count -gt 0) {
            $res.cpuAvg = [math]::Round(($script:Samples | Measure-Object cpu -Average).Average, 1)
            $res.cpuMax = ($script:Samples | Measure-Object cpu -Maximum).Maximum
            $res.hb     = ($script:Samples | Select-Object -Last 1).hb
            $script:Samples | Export-Csv -Path (Join-Path $ReportDir "samples-$Kind.csv") -NoTypeInformation -Encoding ASCII
        }
    } catch {
        Write-Log "❌ [$Kind] lỗi: $($_.Exception.Message)"
    } finally {
        if (-not $KeepVm) {
            Get-VM -Name $script:VmName -ErrorAction SilentlyContinue | ForEach-Object { Stop-VM -VM $_ -TurnOff -Force -ErrorAction SilentlyContinue; Remove-VM -VM $_ -Force }
        } else {
            Write-Log "[$Kind] giữ VM $script:VmName đang chạy — nối PuTTY Serial \\.\pipe\$pipeName 115200 để xem trực tiếp"
        }
    }
    return $res
}

# ---------- chạy ----------
$all = @()
if ($IsoPath)  { $all += Invoke-BootTest -Kind iso  -Path $IsoPath }
if ($VhdxPath) { $all += Invoke-BootTest -Kind vhdx -Path $VhdxPath }

$summary = $all | Select-Object kind, bootSec, NK, DB22, NPST, TV, SD, CD9660, MEMKB, cpuAvg, cpuMax, hb, PASS, serialLog
$summary | ConvertTo-Json | Set-Content -Path (Join-Path $ReportDir 'report.json') -Encoding UTF8
Write-Log "=== TỔNG KẾT ==="
$summary | Format-Table kind, bootSec, NK, DB22, NPST, TV, SD, CD9660, MEMKB, cpuAvg, cpuMax, PASS -AutoSize | Out-String | ForEach-Object { Write-Log $_.TrimEnd() }
Write-Log "Report: $ReportDir"
if ($all | Where-Object { -not $_.PASS }) { exit 1 } else { exit 0 }
