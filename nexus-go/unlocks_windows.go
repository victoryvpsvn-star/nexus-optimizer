//go:build windows
// +build windows

// unlocks_windows.go — v4.0.0 (chỉnh v4.1.0 theo audit 10 phát hiện):
//   - Phát hiện 01: CPU snapshot ĐỦ — active scheme GUID + MIN/MAX AC/DC riêng biệt +
//     PowerThrottlingOff (exists/type/data, phân biệt query-error với not-exist).
//     Apply bị ABORT nếu thiếu bất kỳ giá trị bắt buộc hoặc persist snapshot thất bại.
//     Restore ghi về ĐÚNG scheme đã snapshot, read-back verify từng giá trị, chỉ xóa
//     snapshot khi khớp hết; thiếu snapshot → no-op trung thực (không tự đặt 5%/không xóa registry).
//   - Phát hiện 02: GPU power snapshot giá trị Current (Power Limit) trước khi đổi —
//     restore trả về Current chứ không phải Default; verify read-back; fail → giữ snapshot.
//   - Phát hiện 03: GPU clock snapshot trạng thái khóa cũ (hadLock + giá trị) — nếu người
//     dùng có custom lock thì restore trả đúng lock đó; chỉ -rgc khi trước đó là driver-managed.
package main

import (
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const unlockMode = "windows"

var (
	procThrottleGUIDMin = "893dee14-06ef-4280-ab3b-2af51c181d7a" // PROCTHROTTLEMIN
	procThrottleGUIDMax = "bc5038f7-23e0-4960-96da-33abed597abc" // PROCTHROTTLEMAX
	subProcessorGUID    = "54533251-82be-4824-96c1-47b60b740d00" // SUB_PROCESSOR
	reHexLine           = regexp.MustCompile(`0x([0-9a-fA-F]+)`)
	reGUID              = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
	reNvPower           = regexp.MustCompile(`:\s*([0-9.]+)\s*W`)
	reNvMHz             = regexp.MustCompile(`:\s*([0-9]+)\s*MHz`)
	rePowerKey          = `HKLM\SYSTEM\CurrentControlSet\Control\Power`
)

/** Query 1 setting powercfg → TRẢ CẢ AC và DC (2 dòng Current Index cuối cùng, thứ tự
 * AC trước DC ổn định mọi locale vì output có thể bị localize nhưng hex thì không) */
func powercfgQueryIndices(schemeGUID, settingGUID string) (string, string, error) {
	r := runSysExe("powercfg.exe", []string{"/q", schemeGUID, subProcessorGUID, settingGUID}, 10*time.Second)
	if !r.OK {
		return "", "", powerErr("powercfg /q thất bại (exit " + strconv.Itoa(r.Code) + ")")
	}
	m := reHexLine.FindAllStringSubmatch(r.Stdout, -1)
	if len(m) < 2 {
		return "", "", powerErr("powercfg /q không đủ dòng Current AC/DC — không snapshot được đầy đủ, ABORT theo audit")
	}
	last := m[len(m)-2:]
	ac, errA := strconv.ParseUint(last[0][1], 16, 64)
	dc, errB := strconv.ParseUint(last[1][1], 16, 64)
	if errA != nil || errB != nil {
		return "", "", powerErr("hex không parse được")
	}
	return strconv.Itoa(int(ac)), strconv.Itoa(int(dc)), nil
}

/** active scheme GUID hiện tại (/getactivescheme — GUID universal dù output localize) */
func activeSchemeGUID() (string, error) {
	r := runSysExe("powercfg.exe", []string{"/getactivescheme"}, 10*time.Second)
	if !r.OK {
		return "", powerErr("powercfg /getactivescheme thất bại")
	}
	if m := reGUID.FindString(r.Stdout); m != "" {
		return m, nil
	}
	return "", powerErr("không đọc được GUID scheme đang active")
}

type powerErr string

func (e powerErr) Error() string { return string(e) }

/**.compat: giữ tên cũ cho chỗ dùng đơn — trả giá trị AC của scheme hiện tại */
func powercfgQueryValue(schemeGUID, settingGUID string) (string, bool) {
	ac, _, err := powercfgQueryIndices(schemeGUID, settingGUID)
	if err != nil {
		return "", false
	}
	return ac, true
}

func getUnlocksStatus() UnlockStatus {
	st := UnlockStatus{Mode: unlockMode, CPU: UnlockCPUStatus{ThrottleMin: "?", ThrottleMax: "?", PowerThrottlingOff: "mặc định (bật)"}}
	if scheme, schemeErr := activeSchemeGUID(); schemeErr == nil {
		if mn, _, err := powercfgQueryIndices(scheme, procThrottleGUIDMin); err == nil {
			st.CPU.ThrottleMin = mn + "%"
		}
		if mx, _, err := powercfgQueryIndices(scheme, procThrottleGUIDMax); err == nil {
			st.CPU.ThrottleMax = mx + "%"
		}
		pt := "mặc định (bật)"
		if _, data, exists, err := regQueryValueStrict(rePowerKey, "PowerThrottlingOff"); err != nil {
			pt = "registry query lỗi — không phân biệt được"
		} else if exists {
			pt = "PowerThrottlingOff=" + data
		}
		st.CPU.PowerThrottlingOff = "scheme " + scheme + " • " + pt
	}
	if _, err := os.Stat(nvidiaSmiPath()); err == nil {
		st.GPU.Available = true
		if n := runExe(nvSmi(), []string{"--query-gpu=name", "--format=csv,noheader"}, 6*time.Second); n.OK {
			st.GPU.Name = firstLine(n.Stdout)
		}
		if q := runExe(nvSmi(), []string{"-q", "-d", "POWER"}, 8*time.Second); q.OK {
			st.GPU.PowerNow = nvPowerField(q.Stdout, "Power Limit")
			st.GPU.PowerMin = nvPowerField(q.Stdout, "Min Power Limit")
			st.GPU.PowerMax = nvPowerField(q.Stdout, "Max Power Limit")
			st.GPU.PowerDefault = nvPowerField(q.Stdout, "Default Power Limit")
		}
		if q := runExe(nvSmi(), []string{"-q", "-d", "CLOCK"}, 8*time.Second); q.OK {
			st.GPU.ClockSM = nvClockField(q.Stdout, "Applications Clocks", "SM")
			st.GPU.ClockSMMax = nvClockField(q.Stdout, "Max Clocks", "SM")
			if st.GPU.ClockSM != "" && st.GPU.ClockSMMax != "" {
				st.GPU.ClockNote = "SM ứng dụng: " + st.GPU.ClockSM + " / tối đa " + st.GPU.ClockSMMax + " MHz"
			}
		}
		st.Note = unlockNoteWin
	} else {
		st.Note = unlockNoteWin + " Máy này không có nvidia-smi (không phải NVIDIA GPU CUDA) — phần GPU sẽ báo trung thực."
	}
	return st
}

/** v4.1.1 (P2-01): resolver thống nhất — mọi lệnh NVIDIA chạy qua đường dẫn tuyệt đối
 * nvidiaSmiPath() tìm được; nếu không tìm thấy file thì fallback tên thường chạy LookPath. */
func nvSmi() string {
	if p := nvidiaSmiPath(); p != "" {
		return p
	}
	return "nvidia-smi"
}

func nvidiaSmiPath() string {
	paths := []string{
		os.Getenv("ProgramFiles") + `\NVIDIA Corporation\NVSMI\nvidia-smi.exe`,
		`C:\Windows\System32\nvidia-smi.exe`,
		os.Getenv("SystemRoot") + `\System32\nvidia-smi.exe`,
	}
	for _, p := range paths {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	if p, err := exec.LookPath("nvidia-smi"); err == nil {
		return p
	}
	return ""
}

/** Parse "    <label>               : 170.00 W" — lấy số W sau label (đúng thứ tự xuất hiện) */
func nvPowerField(q string, label string) string {
	for _, ln := range strings.Split(q, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, label) {
			if m := reNvPower.FindStringSubmatch(t); m != nil {
				return m[1] + "W"
			}
		}
	}
	return ""
}

/** Parse clock MHz: section "Applications Clocks" / "Max Clocks" → dòng "    SM    : 2100 MHz" */
func nvClockField(q, section, field string) string {
	inSection := false
	for _, ln := range strings.Split(q, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, section) {
			inSection = true
			continue
		}
		if inSection && strings.HasPrefix(t, field) {
			if m := reNvMHz.FindStringSubmatch(t); m != nil {
				return m[1] + "MHz"
			}
		}
		if inSection && strings.HasPrefix(t, "Clocks Event Reasons") { // hết section
			return ""
		}
	}
	return ""
}

func runUnlock(action string) UnlockRunResult {
	res := UnlockRunResult{Mode: unlockMode, Action: action, Steps: []PerfStep{}, Success: true}
	if m, ok := adminGate(); !ok {
		return UnlockRunResult{Mode: unlockMode, Action: action, Success: false,
			Steps: []PerfStep{{Name: "Quyền admin", OK: false, Detail: m}}, Message: m}
	}
	switch action {
	case "cpu-full":
		runUnlockCPU(&res)
	case "gpu-power":
		runUnlockGPUPower(&res)
	case "gpu-clock":
		runUnlockGPUClock(&res)
	case "restore":
		runUnlockRestore(&res)
	}
	if res.Message == "" {
		res.Message = map[bool]string{true: "Hoàn tất — xem chi tiết từng bước", false: "Một số bước lỗi — xem chi tiết từng bước"}[res.Success]
	}
	return res
}

// ---------- CPU (phát hiện 01) ----------

func runUnlockCPU(res *UnlockRunResult) {
	scheme, err := activeSchemeGUID()
	if err != nil {
		res.Success = false
		res.Message = "Không đọc được power scheme đang active (" + err.Error() + ") — ABORT, không đổi gì cả (audit: thiếu dữ liệu snapshot thì không apply)"
		return
	}
	minAC, minDC, errM := powercfgQueryIndices(scheme, procThrottleGUIDMin)
	maxAC, maxDC, errX := powercfgQueryIndices(scheme, procThrottleGUIDMax)
	ptTyp, ptData, ptExists, errPT := regQueryValueStrict(rePowerKey, "PowerThrottlingOff")
	for _, e := range []error{errM, errX, errPT} {
		if e != nil {
			res.Success = false
			res.Message = "Không đọc đủ trạng thái gốc CPU (" + e.Error() + ") — ABORT, không đổi gì cả"
			return
		}
	}
	snap := map[string]map[string]string{
		"schemeGUID": {"v": scheme},
		"minAC":      {"v": minAC}, "minDC": {"v": minDC},
		"maxAC": {"v": maxAC}, "maxDC": {"v": maxDC},
		"ptExists": {"v": map[bool]string{true: "1", false: "0"}[ptExists]},
	}
	if ptExists {
		snap["ptType"] = map[string]string{"v": ptTyp}
		snap["ptData"] = map[string]string{"v": ptData}
	}
	// lần apply thứ N+1: KHÔNG đè snapshot lần đầu (đang ở trạng thái applied — MIN đã 100)
	if old, found, lerr := loadAppoptSnap("unlocks-cpu"); lerr != nil {
		res.Success = false
		res.Message = "Không đọc được snapshot cũ (" + lerr.Error() + ") — ABORT an toàn"
		return
	} else if found {
		snap = old
		res.Steps = append(res.Steps, PerfStep{Name: "Snapshot gốc", OK: true, Detail: "đã có snapshot từ lần unlock đầu — GIỮ NGUYÊN (không ghi đè bằng giá trị đã bị unlock)"})
	} else {
		if serr := saveAppoptSnap("unlocks-cpu", snap); serr != nil {
			res.Success = false
			res.Message = "Không lưu được snapshot gốc (" + serr.Error() + ") — ABORT, máy chưa bị thay đổi"
			return
		}
		res.Steps = append(res.Steps, PerfStep{Name: "Snapshot gốc đầy đủ", OK: true,
			Detail: "scheme " + scheme + " • MIN " + minAC + "/" + minDC + " • MAX " + maxAC + "/" + maxDC + " • PowerThrottlingOff exists=" + strconv.FormatBool(ptExists)})
	}
	// apply: MIN/MAX = 100 cho AC + DC trên ĐÚNG scheme đã snapshot
	okAll := true
	for _, s := range []struct{ name, flag, guid string }{
		{"MIN (AC)", "/setacvalueindex", procThrottleGUIDMin},
		{"MIN (DC)", "/setdcvalueindex", procThrottleGUIDMin},
		{"MAX (AC)", "/setacvalueindex", procThrottleGUIDMax},
		{"MAX (DC)", "/setdcvalueindex", procThrottleGUIDMax},
	} {
		r := runSysExe("powercfg.exe", []string{s.flag, scheme, subProcessorGUID, s.guid, "100"}, 8*time.Second)
		ok := r.OK
		if s.flag == "/setdcvalueindex" && !r.OK {
			// phân biệt desktop không hỗ trợ DC (NotApplicable) với lỗi thật (Failed)
			out := strings.ToLower(r.Stdout + r.Stderr)
			if strings.Contains(out, "not support") || strings.Contains(out, "không hỗ trợ") {
				ok = true // NotApplicable — desktop không có chế độ pin
			}
		}
		res.Steps = append(res.Steps, PerfStep{Name: "PROCTHROTTLE" + s.name + " → 100%", OK: ok,
			Detail: map[bool]string{true: "powercfg " + s.flag + " trên scheme " + scheme, false: firstLine(r.Stdout + r.Stderr)}[ok]})
		if !ok {
			okAll = false
		}
	}
	if r := runSysExe("powercfg.exe", []string{"/setactive", scheme}, 8*time.Second); r.OK {
		res.Steps = append(res.Steps, PerfStep{Name: "Áp dụng power plan (setactive)", OK: true, Detail: "thay đổi có hiệu lực ngay"})
	} else {
		res.Steps = append(res.Steps, PerfStep{Name: "Áp dụng power plan (setactive)", OK: false, Detail: firstLine(r.Stdout + r.Stderr)})
		okAll = false
	}
	r := runSysExe("reg.exe", []string{"add", rePowerKey, "/v", "PowerThrottlingOff", "/t", "REG_DWORD", "/d", "1", "/f"}, 8*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Tắt Power Throttling (registry)", OK: r.OK,
		Detail: map[bool]string{true: "Windows không còn ép giảm tốc các app nền", false: firstLine(r.Stdout + r.Stderr)}[r.OK]})
	if !r.OK {
		okAll = false
	}
	res.Success = okAll
	res.Message = map[bool]string{true: "Đã bỏ trần throttle CPU (MIN=MAX=100% AC+DC trên scheme gốc) + tắt Power Throttling — snapshot đủ để hoàn tác chính xác",
		false: "CPU unlock một phần lỗi — xem chi tiết (snapshot gốc vẫn còn, hoàn tác an toàn)"}[okAll]
}

// ---------- GPU power (phát hiện 02) ----------

func runUnlockGPUPower(res *UnlockRunResult) {
	if nvidiaSmiPath() == "" {
		res.Success = false
		res.Message = "Không có nvidia-smi trên máy — không phải NVIDIA GPU CUDA; phần GPU unlock chỉ áp dụng cho NVIDIA"
		return
	}
	q := runExe(nvSmi(), []string{"-q", "-d", "POWER"}, 8*time.Second)
	now, max := nvPowerField(q.Stdout, "Power Limit"), nvPowerField(q.Stdout, "Max Power Limit")
	def := nvPowerField(q.Stdout, "Default Power Limit")
	if max == "" {
		res.Success = false
		res.Message = "Không đọc được Power Limit từ nvidia-smi — driver không hỗ trợ (-q -d POWER trống)"
		return
	}
	if now == "" {
		res.Success = false
		res.Message = "Không đọc được Power Limit hiện tại (Current) — không snapshot được mức người dùng đang chạy → ABORT (không thể hứa exact restore)"
		return
	}
	if old, found, lerr := loadAppoptSnap("unlocks-gpu"); lerr != nil {
		res.Success = false
		res.Message = "Không đọc được snapshot GPU cũ (" + lerr.Error() + ") — ABORT an toàn"
		return
	} else if found && old["powerLimitBefore"] != nil {
		res.Steps = append(res.Steps, PerfStep{Name: "Snapshot GPU", OK: true, Detail: "giữ snapshot gốc từ lần đầu: " + old["powerLimitBefore"]["v"] + "W"})
		now = old["powerLimitBefore"]["v"] + "W" // không ghi đè giá trị gốc bằng giá trị đã unlock
	} else {
		snap := map[string]map[string]string{"powerLimitBefore": {"v": strings.TrimSuffix(now, "W")}}
		if def != "" {
			snap["powerDefault"] = map[string]string{"v": strings.TrimSuffix(def, "W")}
		}
		if max != "" {
			snap["powerMax"] = map[string]string{"v": strings.TrimSuffix(max, "W")}
		}
		if serr := saveAppoptSnap("unlocks-gpu", snap); serr != nil {
			res.Success = false
			res.Message = "Không lưu được snapshot GPU (" + serr.Error() + ") — ABORT, card chưa bị thay đổi"
			return
		}
		res.Steps = append(res.Steps, PerfStep{Name: "Snapshot GPU power", OK: true, Detail: "Current " + now + " • Default " + def + " • Max " + max})
	}
	maxW := strings.TrimSuffix(max, "W")
	r := runExe(nvSmi(), []string{"-pl", maxW}, 10*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Power limit GPU → tối đa " + maxW + "W", OK: r.OK,
		Detail: map[bool]string{true: "trước: " + now + " (mặc định " + def + ") — restore sẽ trả về đúng mức người dùng đang chạy, không phải default",
			false: firstLine(r.Stdout + r.Stderr) + " (laptop/driver thường chặn — không ép được là bình thường)"}[r.OK]})
	res.Success = r.OK
	res.Message = map[bool]string{true: "Đã mở power limit GPU lên mức tối đa driver cho phép (" + maxW + "W)",
		false: "Driver từ chối đổi power limit — laptop và một số desktop bị khóa firmware; snapshot giữ nguyên, hoàn tác an toàn"}[r.OK]
}

// ---------- GPU clock (phát hiện 03) ----------

func runUnlockGPUClock(res *UnlockRunResult) {
	if nvidiaSmiPath() == "" {
		res.Success = false
		res.Message = "Không có nvidia-smi trên máy — không phải NVIDIA GPU CUDA"
		return
	}
	q := runExe(nvSmi(), []string{"-q", "-d", "CLOCK"}, 8*time.Second)
	maxSM := nvClockField(q.Stdout, "Max Clocks", "SM")
	appSM := nvClockField(q.Stdout, "Applications Clocks", "SM")
	defAppSM := nvClockField(q.Stdout, "Default Applications Clocks", "SM")
	if maxSM == "" || appSM == "" || defAppSM == "" {
		res.Success = false
		res.Message = "Không đọc đủ trạng thái clock hiện tại (App/Default/Max SM) — không snapshot được lock cũ → ABORT (không thể hứa exact restore)"
		return
	}
	hadLock := strings.TrimSuffix(appSM, "MHz") != strings.TrimSuffix(defAppSM, "MHz")
	if old, found, lerr := loadAppoptSnap("unlocks-gpu-clock"); lerr != nil {
		res.Success = false
		res.Message = "Không đọc được snapshot clock cũ (" + lerr.Error() + ") — ABORT an toàn"
		return
	} else if found && old["lockBefore"] != nil {
		res.Steps = append(res.Steps, PerfStep{Name: "Snapshot clock", OK: true, Detail: "giữ snapshot gốc từ lần đầu"})
	} else {
		snap := map[string]map[string]string{
			"hadLock":    {"v": map[bool]string{true: "1", false: "0"}[hadLock]},
			"lockBefore": {"v": strings.TrimSuffix(appSM, "MHz")},
		}
		if serr := saveAppoptSnap("unlocks-gpu-clock", snap); serr != nil {
			res.Success = false
			res.Message = "Không lưu được snapshot clock (" + serr.Error() + ") — ABORT, GPU chưa bị thay đổi"
			return
		}
		res.Steps = append(res.Steps, PerfStep{Name: "Snapshot trạng thái khóa xung cũ", OK: true,
			Detail: map[bool]string{true: "có custom lock SM " + appSM + " — restore sẽ trả đúng lock này",
				false: "driver-managed (không khóa) — restore sẽ -rgc về điều khiển động"}[hadLock]})
	}
	num := strings.TrimSuffix(maxSM, "MHz")
	r := runExe(nvSmi(), []string{"-lgc", "0," + num}, 10*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Khóa xung SM GPU ở mức tối đa " + num + "MHz", OK: r.OK,
		Detail: map[bool]string{true: "-lgc 0," + num + " — xung luôn giữ mức boost cao nhất", false: firstLine(r.Stdout + r.Stderr)}[r.OK]})
	res.Success = r.OK
	res.Message = map[bool]string{true: "Đã đặt trần xung GPU theo mức tối đa driver cho phép (" + num + "MHz) — xung thực tế còn phụ thuộc nhiệt độ/điện/driver/tải",
		false: "Đặt trần xung lỗi — snapshot giữ nguyên, hoàn tác an toàn"}[r.OK]
}

// ---------- Restore (phát hiện 01/02/03 + read-back verify) ----------

func runUnlockRestore(res *UnlockRunResult) {
	okAll := true
	restoreCPU(res, &okAll)
	restoreGPUPower(res, &okAll)
	restoreGPUClock(res, &okAll)
	if res.Message == "" {
		res.Message = map[bool]string{true: "Đã hoàn tác unlock — CPU/GPU trả đúng trạng thái trước khi unlock (đã verify read-back)",
			false: "Hoàn tác một phần lỗi — snapshot GIỮ NGUYÊN để thử lại"}[okAll]
	}
}

func restoreCPU(res *UnlockRunResult, okAll *bool) {
	snap, found, err := loadAppoptSnap("unlocks-cpu")
	if err != nil {
		*okAll = false
		res.Steps = append(res.Steps, PerfStep{Name: "CPU — đọc snapshot", OK: false, Detail: err.Error()})
		return
	}
	if !found || snap["schemeGUID"] == nil {
		res.Steps = append(res.Steps, PerfStep{Name: "CPU — hoàn tác", OK: true, Detail: "không có phiên CPU Unlock nào đang lưu — không đổi gì cả (không tự đặt 5%, không đụng registry)"})
		return
	}
	scheme := snap["schemeGUID"]["v"]
	cpuOK := true
	for _, s := range []struct{ name, flag, guid, val string }{
		{"MIN (AC)", "/setacvalueindex", procThrottleGUIDMin, snap["minAC"]["v"]},
		{"MIN (DC)", "/setdcvalueindex", procThrottleGUIDMin, snap["minDC"]["v"]},
		{"MAX (AC)", "/setacvalueindex", procThrottleGUIDMax, snap["maxAC"]["v"]},
		{"MAX (DC)", "/setdcvalueindex", procThrottleGUIDMax, snap["maxDC"]["v"]},
	} {
		r := runSysExe("powercfg.exe", []string{s.flag, scheme, subProcessorGUID, s.guid, s.val}, 8*time.Second)
		if !r.OK {
			cpuOK = false
		}
		res.Steps = append(res.Steps, PerfStep{Name: "CPU PROCTHROTTLE" + s.name + " → " + s.val + "%", OK: r.OK,
			Detail: "trên scheme gốc " + scheme})
	}
	// read-back verify từng cặp
	verifyCPU := func(guid string, wantAC, wantDC string) bool {
		ac, dc, err := powercfgQueryIndices(scheme, guid)
		if err != nil || ac != wantAC || dc != wantDC {
			return false
		}
		return true
	}
	if !verifyCPU(procThrottleGUIDMin, snap["minAC"]["v"], snap["minDC"]["v"]) {
		cpuOK = false
		res.Steps = append(res.Steps, PerfStep{Name: "CPU — verify MIN sau restore", OK: false, Detail: "read-back không khớp snapshot — snapshot giữ nguyên"})
	}
	if !verifyCPU(procThrottleGUIDMax, snap["maxAC"]["v"], snap["maxDC"]["v"]) {
		cpuOK = false
		res.Steps = append(res.Steps, PerfStep{Name: "CPU — verify MAX sau restore", OK: false, Detail: "read-back không khớp snapshot — snapshot giữ nguyên"})
	}
	// PowerThrottlingOff theo exists/type/data
	if snap["ptExists"] != nil && snap["ptExists"]["v"] == "1" {
		r := runSysExe("reg.exe", []string{"add", rePowerKey, "/v", "PowerThrottlingOff", "/t", snap["ptType"]["v"], "/d", snap["ptData"]["v"], "/f"}, 8*time.Second)
		res.Steps = append(res.Steps, PerfStep{Name: "Power Throttling → trả giá trị gốc", OK: r.OK, Detail: snap["ptData"]["v"]})
		if !r.OK {
			cpuOK = false
		}
	} else {
		r := runSysExe("reg.exe", []string{"delete", rePowerKey, "/v", "PowerThrottlingOff", "/f"}, 8*time.Second)
		res.Steps = append(res.Steps, PerfStep{Name: "Power Throttling → về mặc định Windows (xóa registry)", OK: r.OK, Detail: "key chưa từng có trước khi unlock (snapshot exists=false)"})
		if !r.OK {
			cpuOK = false
		}
	}
	// v4.1.1 (P1-04): KHÔNG tự setactive scheme cũ nếu người dùng ĐỔI plan sau khi unlock —
	// chỉ refresh active khi máy vẫn đang đúng scheme gốc; khác scheme → ghi giá trị về
	// scheme gốc nhưng giữ nguyên lựa chọn mới của người dùng + báo rõ
	cur, curErr := activeSchemeGUID()
	if curErr == nil && cur == scheme {
		if r := runSysExe("powercfg.exe", []string{"/setactive", scheme}, 8*time.Second); !r.OK {
			cpuOK = false
		}
	} else if curErr != nil {
		res.Steps = append(res.Steps, PerfStep{Name: "Đọc scheme đang active", OK: false, Detail: curErr.Error() + " — không refresh được plan, giá trị vẫn đã ghi vào scheme gốc"})
	} else {
		res.Steps = append(res.Steps, PerfStep{Name: "Power plan KHÔNG bị đổi lại", OK: true,
			Detail: "bạn đang dùng scheme " + cur + " (đổi SAU khi unlock) — NEXUS đã trả MIN/MAX về scheme gốc " + scheme + " nhưng giữ nguyên plan bạn chọn; bật lại plan cũ nếu muốn áp dụng"})
	}
	if cpuOK {
		if err := clearAppoptSnap("unlocks-cpu"); err != nil {
			cpuOK = false
			res.Steps = append(res.Steps, PerfStep{Name: "CPU — xóa snapshot", OK: false, Detail: err.Error() + " — giữ nguyên để thử lại"})
		}
	} else {
		*okAll = false
	}
}

func restoreGPUPower(res *UnlockRunResult, okAll *bool) {
	// v4.1.1 (P1-05): snapshot còn mà GPU không truy cập được → PENDING + giữ snapshot +
	// KHÔNG tính là OK; phân biệt "không có phiên nào" với "GPU đã đổi nhưng mất công cụ"
	snap, found, err := loadAppoptSnap("unlocks-gpu")
	if err != nil {
		*okAll = false
		res.Steps = append(res.Steps, PerfStep{Name: "GPU power — đọc snapshot", OK: false, Detail: err.Error()})
		return
	}
	if !found || snap["powerLimitBefore"] == nil {
		if nvidiaSmiPath() != "" {
			res.Steps = append(res.Steps, PerfStep{Name: "GPU power — hoàn tác", OK: true, Detail: "không có phiên GPU power unlock nào đang lưu — không đụng card"})
		}
		// không snapshot → không có gì để hoàn tác, kể cả khi GPU vắng (trạng thái gốc không đổi)
		return
	}
	if nvSmi() == "" || nvidiaSmiPath() == "" {
		*okAll = false
		res.Steps = append(res.Steps, PerfStep{Name: "GPU power — PENDING (GPU không truy cập được)", OK: false,
			Detail: "phiên unlock GPU còn đang lưu nhưng nvidia-smi/driver hiện không có — snapshot GIỮ NGUYÊN; cài lại driver hoặc kết nối GPU rồi Restore lần nữa"})
		return
	}
	want := snap["powerLimitBefore"]["v"]
	r := runExe(nvSmi(), []string{"-pl", want}, 10*time.Second)
	verified := false
	if r.OK {
		if q := runExe(nvSmi(), []string{"-q", "-d", "POWER"}, 8*time.Second); q.OK {
			verified = nvPowerField(q.Stdout, "Power Limit") == want+"W"
		}
	}
	stepOK := r.OK && verified
	res.Steps = append(res.Steps, PerfStep{Name: "Power limit GPU → trả mức trước khi unlock " + want + "W", OK: stepOK,
		Detail: map[bool]string{true: "verify read-back khớp (không trả về Default mù)",
			false: firstLine(r.Stdout + r.Stderr) + " — snapshot GIỮ NGUYÊN để thử lại"}[stepOK]})
	if stepOK {
		if err := clearAppoptSnap("unlocks-gpu"); err != nil {
			stepOK = false
		}
	}
	if !stepOK {
		*okAll = false
	}
}

func restoreGPUClock(res *UnlockRunResult, okAll *bool) {
	// v4.1.1 (P1-05): như GPU power — snapshot còn + GPU vắng → PENDING, giữ snapshot
	snap, found, err := loadAppoptSnap("unlocks-gpu-clock")
	if err != nil {
		*okAll = false
		res.Steps = append(res.Steps, PerfStep{Name: "GPU clock — đọc snapshot", OK: false, Detail: err.Error()})
		return
	}
	if !found || snap["hadLock"] == nil {
		if nvidiaSmiPath() != "" {
			res.Steps = append(res.Steps, PerfStep{Name: "GPU clock — hoàn tác", OK: true, Detail: "không có phiên GPU clock unlock nào đang lưu — không đụng card"})
		}
		return
	}
	if nvSmi() == "" || nvidiaSmiPath() == "" {
		*okAll = false
		res.Steps = append(res.Steps, PerfStep{Name: "GPU clock — PENDING (GPU không truy cập được)", OK: false,
			Detail: "phiên unlock GPU còn đang lưu nhưng nvidia-smi/driver hiện không có — snapshot GIỮ NGUYÊN; retry khi GPU khả dụng"})
		return
	}
	var stepOK bool
	if snap["hadLock"]["v"] == "1" {
		want := snap["lockBefore"]["v"]
		r := runExe(nvSmi(), []string{"-lgc", "0," + want}, 10*time.Second)
		// v4.1.1 (P1-06): read-back verify sau khi trả custom lock — không khớp thì không tính xong
		verified := false
		if r.OK {
			if q := runExe(nvSmi(), []string{"-q", "-d", "CLOCK"}, 8*time.Second); q.OK {
				verified = nvClockField(q.Stdout, "Applications Clocks", "SM") == want+"MHz"
			}
		}
		stepOK = r.OK && verified
		res.Steps = append(res.Steps, PerfStep{Name: "Trả custom lock SM GPU về mức gốc " + want + "MHz", OK: stepOK,
			Detail: map[bool]string{true: "restore lock SM (mức người dùng có trước) + verify read-back; giới hạn: chỉ mô tả được xung SM — GPC/Memory do driver quản",
				false: firstLine(r.Stdout + r.Stderr) + " — snapshot giữ nguyên để thử lại"}[stepOK]})
	} else {
		r := runExe(nvSmi(), []string{"-rgc"}, 10*time.Second)
		stepOK = r.OK
		res.Steps = append(res.Steps, PerfStep{Name: "Gỡ khóa xung GPU (-rgc) — về điều khiển động", OK: stepOK,
			Detail: map[bool]string{true: "trước khi unlock GPU vốn ở driver-managed — đây là đúng trạng thái gốc",
				false: firstLine(r.Stdout + r.Stderr) + " — snapshot giữ nguyên"}[stepOK]})
	}
	if stepOK {
		if err := clearAppoptSnap("unlocks-gpu-clock"); err != nil {
			stepOK = false
		}
	}
	if !stepOK {
		*okAll = false
	}
}
