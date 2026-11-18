//go:build windows
// +build windows

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
	reProcThrottleGUIDMin = "893dee14-06ef-4280-ab3b-2af51c181d7a" // PROCTHROTTLEMIN
	reProcThrottleGUIDMax = "bc5038f7-23e0-4960-96da-33abed597abc" // PROCTHROTTLEMAX
	reSubProcessor        = "54533251-82be-4824-96c1-47b60b740d00" // SUB_PROCESSOR
	reHexIndex            = regexp.MustCompile(`0x([0-9a-fA-F]+)`)
	reNvPower             = regexp.MustCompile(`:\s*([0-9.]+)\s*W`)
)

/** Đọc 1 setting powercfg theo GUID → số hex cuối trong output (đa ngôn ngữ vẫn đọc được) */
func powercfgQueryValue(settingGUID string) (string, bool) {
	r := runExe("powercfg", []string{"/q", "SCHEME_CURRENT", reSubProcessor, settingGUID}, 10*time.Second)
	if !r.OK {
		return "", false
	}
	m := reHexIndex.FindAllStringSubmatch(r.Stdout, -1)
	if len(m) == 0 {
		return "", false
	}
	last := m[len(m)-1][1]
	v, err := strconv.ParseUint(last, 16, 64)
	if err != nil {
		return "", false
	}
	return strconv.Itoa(int(v)), true
}

func getUnlocksStatus() UnlockStatus {
	st := UnlockStatus{Mode: unlockMode, CPU: UnlockCPUStatus{ThrottleMin: "?", ThrottleMax: "?", PowerThrottlingOff: "mặc định (bật)"}}
	if v, ok := powercfgQueryValue(reProcThrottleGUIDMin); ok {
		st.CPU.ThrottleMin = v + "%"
	}
	if v, ok := powercfgQueryValue(reProcThrottleGUIDMax); ok {
		st.CPU.ThrottleMax = v + "%"
	}
	if _, data, found := regQueryValue(`HKLM\SYSTEM\CurrentControlSet\Control\Power`, "PowerThrottlingOff"); found {
		st.CPU.PowerThrottlingOff = "PowerThrottlingOff=" + data
	}
	// GPU NVIDIA — nvidia-smi có mới hỏi
	if _, err := osStatNvidia(); err == nil {
		st.GPU.Available = true
		if n := runExe("nvidia-smi", []string{"--query-gpu=name", "--format=csv,noheader"}, 6*time.Second); n.OK {
			st.GPU.Name = firstLine(n.Stdout)
		}
		if q := runExe("nvidia-smi", []string{"-q", "-d", "POWER"}, 8*time.Second); q.OK {
			st.GPU.PowerNow = nvPowerField(q.Stdout, "Power Limit")
			st.GPU.PowerMin = nvPowerField(q.Stdout, "Min Power Limit")
			st.GPU.PowerMax = nvPowerField(q.Stdout, "Max Power Limit")
			st.GPU.PowerDefault = nvPowerField(q.Stdout, "Default Power Limit")
		}
		if q := runExe("nvidia-smi", []string{"-q", "-d", "CLOCK"}, 8*time.Second); q.OK {
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

func osStatNvidia() (os.FileInfo, error) {
	return os.Stat(nvidiaSmiPath())
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
	re := regexp.MustCompile(`:\s*([0-9]+)\s*MHz`)
	for _, ln := range strings.Split(q, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, section) {
			inSection = true
			continue
		}
		if inSection && strings.HasPrefix(t, field) {
			if m := re.FindStringSubmatch(t); m != nil {
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

/** CPU: bỏ trần throttle (MIN/MAX 100% AC+DC) + tắt Power Throttling — snapshot gốc trước */
func runUnlockCPU(res *UnlockRunResult) {
	snap := map[string]map[string]string{}
	if v, ok := powercfgQueryValue(reProcThrottleGUIDMin); ok {
		snap["throttleMin"] = map[string]string{"v": v}
	}
	if typ, data, found := regQueryValue(`HKLM\SYSTEM\CurrentControlSet\Control\Power`, "PowerThrottlingOff"); found {
		snap["powerThrottlingOff"] = map[string]string{"type": typ, "data": data}
	}
	saveAppoptSnap("unlocks-cpu", snap)

	okAll := true
	for _, s := range []struct{ alias, guid, val string }{
		{"PROCTHROTTLEMIN", reProcThrottleGUIDMin, "100"},
		{"PROCTHROTTLEMIN (pin)", reProcThrottleGUIDMin, "100"},
		{"PROCTHROTTLEMAX", reProcThrottleGUIDMax, "100"},
		{"PROCTHROTTLEMAX (pin)", reProcThrottleGUIDMax, "100"},
	} {
		flag := "/setacvalueindex"
		if strings.Contains(s.alias, "pin") {
			flag = "/setdcvalueindex"
		}
		r := runExe("powercfg", []string{flag, "SCHEME_CURRENT", reSubProcessor, s.guid, s.val}, 8*time.Second)
		res.Steps = append(res.Steps, PerfStep{Name: "CPU " + s.alias + " → " + s.val + "%", OK: r.OK,
			Detail: map[bool]string{true: "power plan hiện tại đã ghi (AC/DC)", false: firstLine(r.Stdout + r.Stderr)}[r.OK]})
		if !r.OK {
			okAll = false
		}
	}
	if r := runExe("powercfg", []string{"/setactive", "SCHEME_CURRENT"}, 8*time.Second); r.OK {
		res.Steps = append(res.Steps, PerfStep{Name: "Áp dụng power plan (setactive)", OK: true, Detail: "thay đổi có hiệu lực ngay"})
	} else {
		res.Steps = append(res.Steps, PerfStep{Name: "Áp dụng power plan (setactive)", OK: false, Detail: firstLine(r.Stdout + r.Stderr)})
		okAll = false
	}
	r := runExe("reg.exe", []string{"add", `HKLM\SYSTEM\CurrentControlSet\Control\Power`, "/v", "PowerThrottlingOff", "/t", "REG_DWORD", "/d", "1", "/f"}, 8*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Tắt Power Throttling (registry)", OK: r.OK,
		Detail: map[bool]string{true: "Windows không còn ép giảm tốc các app nền", false: firstLine(r.Stdout + r.Stderr)}[r.OK]})
	if !r.OK {
		okAll = false
	}
	res.Success = okAll
	res.Message = map[bool]string{true: "Đã bỏ trần throttle CPU (MIN=MAX=100% AC+DC) + tắt Power Throttling — snapshot gốc đã lưu để hoàn tác",
		false: "CPU unlock một phần lỗi — xem chi tiết (thường do thiếu quyền admin)"}[okAll]
}

/** GPU power limit: tăng lên mức Max driver cho phép — snapshot Default để hoàn tác */
func runUnlockGPUPower(res *UnlockRunResult) {
	if nvidiaSmiPath() == "" {
		res.Success = false
		res.Message = "Không có nvidia-smi trên máy — không phải NVIDIA GPU CUDA; phần GPU unlock chỉ áp dụng cho NVIDIA"
		return
	}
	q := runExe("nvidia-smi", []string{"-q", "-d", "POWER"}, 8*time.Second)
	now, max := nvPowerField(q.Stdout, "Power Limit"), nvPowerField(q.Stdout, "Max Power Limit")
	def := nvPowerField(q.Stdout, "Default Power Limit")
	if max == "" {
		res.Success = false
		res.Message = "Không đọc được Power Limit từ nvidia-smi — driver không hỗ trợ (-q -d POWER trống)"
		return
	}
	if def != "" {
		saveAppoptSnap("unlocks-gpu", map[string]map[string]string{
			"powerDefault": map[string]string{"v": strings.TrimSuffix(def, "W")},
		})
	}
	maxW := strings.TrimSuffix(max, "W")
	nowW := strings.TrimSuffix(now, "W")
	r := runExe("nvidia-smi", []string{"-pl", maxW}, 10*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Power limit GPU → tối đa " + maxW + "W", OK: r.OK,
		Detail: map[bool]string{true: "trước: " + nowW + "W (mặc định " + def + ") — card chạy ngập mũ do driver cho phép",
			false: firstLine(r.Stdout + r.Stderr) + " (laptop/driver thường chặn — không ép được là bình thường)"}[r.OK]})
	res.Success = r.OK
	res.Message = map[bool]string{true: "Đã mở power limit GPU lên mức tối đa driver cho phép (" + maxW + "W)",
		false: "Driver từ chối đổi power limit — laptop và một số desktop bị khóa firmware, báo trung thực chứ không giả vờ thành công"}[r.OK]
}

/** GPU clock: khóa xung SM ở mức tối đa card hỗ trợ (-lgc 0,<max>) — reset sau khi reboot */
func runUnlockGPUClock(res *UnlockRunResult) {
	if nvidiaSmiPath() == "" {
		res.Success = false
		res.Message = "Không có nvidia-smi trên máy — không phải NVIDIA GPU CUDA"
		return
	}
	q := runExe("nvidia-smi", []string{"-q", "-d", "CLOCK"}, 8*time.Second)
	maxSM := nvClockField(q.Stdout, "Max Clocks", "SM")
	if maxSM == "" {
		res.Success = false
		res.Message = "Không đọc được Max Clocks SM từ nvidia-smi — driver không hỗ trợ"
		return
	}
	num := strings.TrimSuffix(maxSM, "MHz")
	r := runExe("nvidia-smi", []string{"-lgc", "0," + num}, 10*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Khóa xung SM GPU ở mức tối đa " + num + "MHz", OK: r.OK,
		Detail: map[bool]string{true: "-lgc 0," + num + " — xung luôn giữ mức boost cao nhất (reset về động sau khi khởi động lại máy)",
			false: firstLine(r.Stdout + r.Stderr)}[r.OK]})
	res.Success = r.OK
	res.Message = map[bool]string{true: "Đã khóa xung GPU ở mức tối đa card hỗ trợ (" + num + "MHz) — không còn tụt xung khi tải nặng",
		false: "Khóa xung lỗi — xem chi tiết"}[r.OK]
}

/** Hoàn tác: trả CPU về giá trị gốc snapshot (hoặc mặc định Windows 5%/100%), GPU -rgc + power limit mặc định */
func runUnlockRestore(res *UnlockRunResult) {
	okAll := true
	// CPU
	snap := loadAppoptSnap("unlocks-cpu")
	minVal := "5" // mặc định Windows
	if snap != nil && snap["throttleMin"] != nil && snap["throttleMin"]["v"] != "" {
		minVal = snap["throttleMin"]["v"]
	}
	for _, s := range []struct{ flag, guid string }{
		{"/setacvalueindex", reProcThrottleGUIDMin}, {"/setdcvalueindex", reProcThrottleGUIDMin},
	} {
		r := runExe("powercfg", []string{s.flag, "SCHEME_CURRENT", reSubProcessor, s.guid, minVal}, 8*time.Second)
		if !r.OK {
			okAll = false
		}
	}
	res.Steps = append(res.Steps, PerfStep{Name: "CPU PROCTHROTTLEMIN → giá trị gốc (" + minVal + "%)", OK: okAll,
		Detail: "trạng thái trước khi unlock — mặc định Windows là 5%"})
	if snap != nil && snap["powerThrottlingOff"] != nil {
		s := snap["powerThrottlingOff"]
		r := runExe("reg.exe", []string{"add", `HKLM\SYSTEM\CurrentControlSet\Control\Power`, "/v", "PowerThrottlingOff", "/t", s["type"], "/d", s["data"], "/f"}, 8*time.Second)
		res.Steps = append(res.Steps, PerfStep{Name: "Power Throttling → trả giá trị gốc", OK: r.OK, Detail: s["data"]})
		if !r.OK {
			okAll = false
		}
	} else {
		r := runExe("reg.exe", []string{"delete", `HKLM\SYSTEM\CurrentControlSet\Control\Power`, "/v", "PowerThrottlingOff", "/f"}, 8*time.Second)
		res.Steps = append(res.Steps, PerfStep{Name: "Power Throttling → về mặc định Windows (xóa registry)", OK: r.OK, Detail: "key chưa từng có trước khi unlock"})
		if !r.OK {
			okAll = false
		}
	}
	if r := runExe("powercfg", []string{"/setactive", "SCHEME_CURRENT"}, 8*time.Second); !r.OK {
		okAll = false
	}
	clearAppoptSnap("unlocks-cpu")
	// GPU
	if nvidiaSmiPath() != "" {
		rgc := runExe("nvidia-smi", []string{"-rgc"}, 10*time.Second)
		res.Steps = append(res.Steps, PerfStep{Name: "Gỡ khóa xung GPU (-rgc)", OK: rgc.OK,
			Detail: map[bool]string{true: "xung trả về điều khiển động", false: firstLine(rgc.Stdout + rgc.Stderr)}[rgc.OK]})
		if !rgc.OK {
			okAll = false
		}
		if gsnap := loadAppoptSnap("unlocks-gpu"); gsnap != nil && gsnap["powerDefault"] != nil {
			v := gsnap["powerDefault"]["v"]
			r := runExe("nvidia-smi", []string{"-pl", v}, 10*time.Second)
			res.Steps = append(res.Steps, PerfStep{Name: "Power limit GPU → trả giá trị gốc " + v + "W", OK: r.OK,
				Detail: map[bool]string{true: "đúng mức mặc định trước khi unlock", false: firstLine(r.Stdout + r.Stderr)}[r.OK]})
			if !r.OK {
				okAll = false
			}
			clearAppoptSnap("unlocks-gpu")
		}
	}
	res.Success = okAll
	res.Message = map[bool]string{true: "Đã hoàn tác unlock — CPU/GPU trả đúng trạng thái trước khi unlock",
		false: "Hoàn tác một phần lỗi — xem chi tiết từng bước"}[okAll]
}
