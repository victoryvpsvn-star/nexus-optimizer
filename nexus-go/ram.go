// ram.go — 2 script PowerShell xả RAM (port từ tweaks.ts): EmptyWorkingSet cho tiến trình >50MB
// và MemoryPurgeStandbyList qua ntdll. Cần Windows + PowerShell (các máy rút gọn PS sẽ báo lỗi
// trung thực, không giả lập thành công).
package main

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

const ramEmptyWorkingSetScript = `try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NexusPsApi {
  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool EmptyWorkingSet(IntPtr hProc);
}
'@ -ErrorAction Stop
} catch {
  Write-Output $_.Exception.Message
  exit 1
}
$me = $PID
$n = 0
$procs = Get-Process | Where-Object { $_.Id -ne $me -and $_.WorkingSet64 -gt 50MB }
foreach ($p in $procs) {
  try {
    if ([NexusPsApi]::EmptyWorkingSet($p.Handle)) { $n++ }
  } catch { }
}
Write-Output "trimmed=$n"
exit 0`

const ramStandbyScript = `$sig = @'
using System;
using System.Runtime.InteropServices;
public static class NexusStandby {
  [DllImport("ntdll.dll")] public static extern uint NtSetSystemInformation(int InfoClass, ref int Info, int Length);
  [DllImport("ntdll.dll")] public static extern uint RtlAdjustPrivilege(int Privilege, bool Enable, bool CurrentThread, ref bool Enabled);
}
'@
try {
  Add-Type -TypeDefinition $sig -ErrorAction Stop
} catch {
  Write-Output $_.Exception.Message
  exit 1
}
$en = $false
[void][NexusStandby]::RtlAdjustPrivilege(19, $true, $false, [ref]$en)
$freeBefore = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024, 1)
# 5 = MemoryPurgeStandbyList, 4 = MemoryPurgeLowMemoryStandbyList (SystemMemoryListInformation = 80)
$r1 = [NexusStandby]::NtSetSystemInformation(80, [ref]5, 4)
$r2 = [NexusStandby]::NtSetSystemInformation(80, [ref]4, 4)
$freeAfter = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024, 1)
Write-Output "freeMB=$freeBefore -> $freeAfter nts1=$r1 nts2=$r2"
if ($r1 -ne 0 -and $r2 -ne 0) { exit 1 }
exit 0`

func ramEmptyWorkingSet() ActionResult {
	r := psRun(ramEmptyWorkingSetScript, 30*time.Second)
	if !r.OK {
		return ActionResult{false, truncateShort(orDefault(r.Stderr, r.Stdout, "Không nạp được EmptyWorkingSet (psapi.dll)"))}
	}
	return ActionResult{true, "Đã yêu cầu giải phóng working set của các tiến trình nặng"}
}

var freeMBRe = regexp.MustCompile(`freeMB=([\d.]+) -> ([\d.]+)`)

func ramStandbyPurge() ActionResult {
	r := psRun(ramStandbyScript, 30*time.Second)
	if !r.OK {
		return ActionResult{false, truncateShort("Xả standby list thất bại: " +
			orDefault(r.Stdout, r.Stderr, "không rõ lý do") + " (cần Administrator + PowerShell)")}
	}
	m := freeMBRe.FindStringSubmatch(r.Stdout)
	if m != nil {
		freed := int(floatDiff(m[1], m[2]))
		if freed < 0 {
			freed = 0
		}
		// v3.9.0 (theo audit P2-06): đây là quan sát RAM trống toàn hệ thống trước/sau —
		// bao gồm cả tác động của Windows/app khác, không gán toàn bộ delta cho tool
		return ActionResult{true, fmt.Sprintf("Đã xả standby list — RAM trống tăng từ %sMB → %sMB (quan sát toàn hệ thống: +~%dMB)", m[1], m[2], freed)}
	}
	return ActionResult{true, "Đã yêu cầu xả standby list RAM"}
}

func floatDiff(a, b string) float64 {
	var x, y float64
	fmt.Sscanf(a, "%f", &x)
	fmt.Sscanf(b, "%f", &y)
	return y - x
}

/** Dọn RAM cho tab Dọn dẹp: EmptyWorkingSet + xả standby (khi có quyền Admin) */
func cleanupRamTargets() ([]CleanupResult, int64) {
	var results []CleanupResult
	var total int64
	r1 := psRun(ramEmptyWorkingSetScript, 60*time.Second)
	ok1 := r1.OK
	msg1 := "Đã xả working set các tiến trình nặng (EmptyWorkingSet)"
	if !ok1 {
		msg1 = truncateShort("EmptyWorkingSet thất bại: " + orDefault(r1.Stderr, r1.Stdout, "không rõ lý do"))
	}
	results = append(results, CleanupResult{
		ID: "ram-workset", Name: "Xả RAM tiến trình (EmptyWorkingSet)", Kind: "ram",
		Success: ok1, Message: msg1,
	})
	r2 := psRun(ramStandbyScript, 60*time.Second)
	ok2 := r2.OK
	var freed int64
	msg2 := "Đã xả standby list RAM"
	if m := freeMBRe.FindStringSubmatch(r2.Stdout); m != nil {
		d := floatDiff(m[1], m[2])
		if d > 0 {
			freed = int64(d) * 1024 * 1024
			total += freed
			msg2 = fmt.Sprintf("Đã xả standby list — RAM trống %sMB → %sMB", m[1], m[2])
		}
	}
	if !ok2 {
		msg2 = truncateShort("Xả standby list: " + orDefault(r2.Stdout, r2.Stderr, "không rõ lý do") + " (cần Administrator) — phần EmptyWorkingSet vẫn đã chạy")
	}
	results = append(results, CleanupResult{
		ID: "ram-standby", Name: "Xả standby list RAM", Kind: "ram",
		FreedBytes: freed, Success: ok2, Message: msg2,
	})
	return results, total
}

// CleanupResult/định dạng dùng chung với cleanup.go — khai báo tại đó

var _ = strings.TrimSpace
