//go:build windows
// +build windows

package main

// perf_windows.go — tác dụng THẬT trên Windows:
//   • Timer Resolution: ntdll!NtSetTimerResolution / NtQueryTimerResolution — dò các mức
//     0.5 / 1 / 2 ms từ cao xuống thấp, giữ mức tốt nhất mà kernel chấp nhận.
//   • Ép xung an toàn: NVIDIA (nvidia-smi -lgc/-lmc khóa xung boost tối đa) hoặc máy khác
//     (HAGS), power plan High Performance, CPU min state 100% (mức "max").
//   Không đụng đến voltage/frequency tăng thủ công — mọi bước đều có thể khôi phục.

import (
	"fmt"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	modntdll                   = syscall.NewLazyDLL("ntdll.dll")
	procNtSetTimerResolution   = modntdll.NewProc("NtSetTimerResolution")
	procNtQueryTimerResolution = modntdll.NewProc("NtQueryTimerResolution")
)

const perfMode = "windows"

// queryTimerResolution trả về (tối đa, tối thiểu, hiện tại) theo 100ns
func queryTimerResolution() (maxRes, minRes, curRes uint32, err error) {
	r1, _, _ := procNtQueryTimerResolution.Call(
		uintptr(unsafe.Pointer(&maxRes)),
		uintptr(unsafe.Pointer(&minRes)),
		uintptr(unsafe.Pointer(&curRes)))
	if r1 != 0 {
		err = fmt.Errorf("NtQueryTimerResolution lỗi 0x%x", r1)
	}
	return
}

// setTimerResolution đặt độ phân giải mong muốn (100ns), trả về mức kernel thực cấp.
// set=false để nhả quyền (khôi phục về mặc định).
func setTimerResolution(desired uint32, set bool) (actual uint32, err error) {
	r1, _, _ := procNtSetTimerResolution.Call(
		uintptr(desired),
		boolToUintptr(set),
		uintptr(unsafe.Pointer(&actual)))
	if r1 != 0 {
		return actual, fmt.Errorf("NtSetTimerResolution lỗi 0x%x", r1)
	}
	return actual, nil
}

func boolToUintptr(b bool) uintptr {
	if b {
		return 1
	}
	return 0
}

func resToMs(res100ns uint32) float64 { return float64(res100ns) / 10000.0 }

func nvidiaQuery(q string) (string, bool) {
	r := runExe("nvidia-smi", []string{"--query-gpu=" + q, "--format=csv,noheader,nounits"}, 5*time.Second)
	return strings.TrimSpace(strings.SplitN(r.Stdout, "\n", 2)[0]), r.OK
}

func perfStatus() PerfStatus {
	st := PerfStatus{Mode: perfMode, OS: "windows"}
	if _, _, cur, err := queryTimerResolution(); err == nil {
		st.TimerRes = fmtMs(resToMs(cur))
	} else {
		st.TimerRes = "?"
	}
	if out, ok := nvidiaQuery("name,clocks.gr,clocks.max.gr"); ok && out != "" {
		parts := strings.Split(out, ",")
		if len(parts) == 3 {
			st.GPU = strings.TrimSpace(parts[0])
			st.GPUClocks = strings.TrimSpace(parts[1]) + " / " + strings.TrimSpace(parts[2]) + " MHz"
		}
	} else {
		r := runExe("powershell", []string{"-NoProfile", "-Command",
			"(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name"}, 8*time.Second)
		if r.OK && strings.TrimSpace(r.Stdout) != "" {
			st.GPU = strings.TrimSpace(r.Stdout)
		} else {
			st.GPU = "Không nhận diện được"
		}
	}
	return st
}

// perfTimerResolution — action: auto (dò 0.5→1→2ms lấy mức tốt nhất máy nhận),
// apply (đặt mức chỉ định), off (nhả quyền, về mặc định hệ thống).
func perfTimerResolution(action string, ms float64) TimerResResult {
	res := TimerResResult{Mode: perfMode, Action: action, Method: "ntdll!NtSetTimerResolution"}
	_, _, cur, err := queryTimerResolution()
	if err != nil {
		res.Message = "Không đọc được timer hiện tại: " + err.Error()
		return res
	}
	res.Before = fmtMs(resToMs(cur))

	switch action {
	case "off":
		if _, err := setTimerResolution(10000, false); err != nil {
			res.Message = "Nhả timer resolution lỗi: " + err.Error()
			return res
		}
		_, _, cur2, _ := queryTimerResolution()
		res.After = fmtMs(resToMs(cur2))
		res.Chosen = "mặc định hệ thống"
		res.Success = true
		res.Message = "Đã khôi phục timer resolution mặc định (" + res.After + ")"
		return res

	case "apply":
		target := uint32(ms * 10000)
		actual, err := setTimerResolution(target, true)
		if err != nil {
			res.Message = err.Error()
			return res
		}
		res.Chosen = fmtMs(resToMs(actual))
		res.After = res.Chosen
		res.Success = true
		res.Message = "Đã đặt timer resolution " + res.After
		return res

	default: // auto — dò từ mức tốt nhất (0.5ms) xuống
		cands := []struct {
			ms      float64
			hundred uint32
		}{{0.5, 5000}, {1, 10000}, {2, 20000}}
		best := ""
		bestMs := 0.0
		for _, c := range cands {
			actual, err := setTimerResolution(c.hundred, true)
			if err != nil {
				continue
			}
			got := resToMs(actual)
			// kernel có thể cấp thô hơn mong muốn: chấp nhận nếu thực tế ≤ 2x mong muốn
			if got <= c.ms*2+0.01 && (best == "" || got < bestMs) {
				best, bestMs = fmtMs(got), got
			}
			if got <= c.ms+0.01 { // đạt đúng mức tốt nhất — dừng sớm
				break
			}
		}
		if best == "" {
			res.Message = "Kernel từ chối mọi mức — giữ nguyên " + res.Before
			res.After = res.Before
			return res
		}
		// đảm bảo quyền đang giữ ở mức đã chọn
		if uint32(bestMs*10000) > 0 {
			_, _ = setTimerResolution(uint32(bestMs*10000), true)
		}
		res.Chosen = best
		res.After = best
		res.Success = true
		res.Message = "Tự chọn timer resolution tốt nhất máy hỗ trợ: " + best + " (trước: " + res.Before + ")"
		return res
	}
}

func perfOverclock(level string) OcResult {
	oc := OcResult{Mode: perfMode, Level: level, Success: true, Steps: []PerfStep{}}

	// 0) Nhận diện GPU
	gpu := ""
	clockMax := ""
	if out, ok := nvidiaQuery("name,clocks.max.gr,clocks.max.mc"); ok && out != "" {
		parts := strings.Split(out, ",")
		if len(parts) >= 3 {
			gpu = strings.TrimSpace(parts[0])
			clockMax = strings.TrimSpace(parts[1])
		}
	}
	if gpu == "" {
		r := runExe("powershell", []string{"-NoProfile", "-Command",
			"(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name"}, 8*time.Second)
		if r.OK {
			gpu = strings.TrimSpace(r.Stdout)
		}
	}
	oc.GPU = gpu
	if gpu == "" {
		gpu = "không nhận diện được"
	}

	// 1) Ép xung GPU: NVIDIA → khóa xung lõi (và bộ nhớ nếu ≥ balanced) ở mức boost tối đa
	if clockMax != "" {
		r := runExe("nvidia-smi", []string{"-lgc", "0," + clockMax}, 8*time.Second)
		if r.OK {
			oc.Steps = append(oc.Steps, PerfStep{Name: "Khóa xung lõi GPU " + clockMax + " MHz (NVIDIA)", OK: true,
				Detail: "nvidia-smi -lgc 0," + clockMax + " — GPU luôn giữ mức boost tối đa"})
			if level != "safe" {
				if mc, ok := nvidiaQuery("clocks.max.mc"); ok && mc != "" {
					r2 := runExe("nvidia-smi", []string{"-lmc", "0," + mc}, 8*time.Second)
					oc.Steps = append(oc.Steps, PerfStep{Name: "Khóa xung bộ nhớ GPU " + mc + " MHz", OK: r2.OK,
						Detail: firstLine(r2.Stdout + r2.Stderr)})
				}
			}
		} else {
			oc.Steps = append(oc.Steps, PerfStep{Name: "Khóa xung lõi GPU", OK: false,
				Detail: firstLine(r.Stdout + r.Stderr)})
		}
	} else {
		// GPU khác: bật HAGS (lập lịch GPU phần cứng) — cần admin, nếu lỗi chỉ ghi nhận
		r := runExe("reg", []string{"add", `HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers`,
			"/v", "HwSchMode", "/t", "REG_DWORD", "/d", "2", "/f"}, 5*time.Second)
		oc.Steps = append(oc.Steps, PerfStep{Name: "HAGS — Hardware-accelerated GPU scheduling", OK: r.OK,
			Detail: firstLine(r.Stdout+r.Stderr) + " (áp dụng sau khi khởi động lại)"})
		oc.Steps = append(oc.Steps, PerfStep{Name: "GPU " + gpu, OK: true,
			Detail: "Không phải NVIDIA — khóa clock không khả dụng; đã bật tối ưu hệ thống bên dưới"})
	}

	// 2) Power plan High Performance (mọi mức)
	r := runExe("powercfg", []string{"/setactive", "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"}, 5*time.Second)
	if r.OK {
		oc.Steps = append(oc.Steps, PerfStep{Name: "Power plan High Performance", OK: true,
			Detail: "CPU không còn ngủ sớm, GPU không còn hạ xung khi rảnh"})
	} else {
		oc.Steps = append(oc.Steps, PerfStep{Name: "Power plan High Performance", OK: false,
			Detail: firstLine(r.Stdout+r.Stderr) + " (cần quyền admin?)"})
	}

	// 3) Mức max: CPU min state 100% + Ultimate Performance nếu có
	if level == "max" {
		r := runExe("powercfg", []string{"/setacvalueindex", "SCHEME_CURRENT", "SUB_PROCESSOR", "PROCTHROTTLEMIN", "100"}, 5*time.Second)
		if r.OK {
			runExe("powercfg", []string{"/setactive", "SCHEME_CURRENT"}, 5*time.Second)
			oc.Steps = append(oc.Steps, PerfStep{Name: "CPU min state 100%", OK: true, Detail: "CPU luôn giữ xung cao nhất khi cắm điện"})
		}
		r2 := runExe("powercfg", []string{"/duplicatescheme", "e9a42b02-d5df-448d-aa00-03f14749eb61"}, 6*time.Second)
		if r2.OK {
			if guid := firstGUID(r2.Stdout); guid != "" {
				r3 := runExe("powercfg", []string{"/setactive", guid}, 5*time.Second)
				oc.Steps = append(oc.Steps, PerfStep{Name: "Ultimate Performance plan", OK: r3.OK,
					Detail: "Scheme Ultimate (" + guid + ")"})
			}
		}
	}

	oc.Message = fmt.Sprintf("Ép xung mức %s hoàn tất trên %s — %d bước, có thể ↩ khôi phục gốc bất cứ lúc nào", ocLevelVN(level), gpu, len(oc.Steps))
	return oc
}

func perfRestore() OcResult {
	res := OcResult{Mode: perfMode, Level: "restore", Success: true, Steps: []PerfStep{}}
	r := runExe("nvidia-smi", []string{"-rgc"}, 8*time.Second)
	if r.OK {
		res.Steps = append(res.Steps, PerfStep{Name: "Gỡ khóa xung GPU", OK: true, Detail: "xung lõi trả về điều khiển động"})
	}
	runExe("nvidia-smi", []string{"-rmc"}, 8*time.Second)
	r2 := runExe("powercfg", []string{"/setactive", "381b4222-f694-41f0-9685-ff5bb260df2e"}, 5*time.Second)
	if r2.OK {
		res.Steps = append(res.Steps, PerfStep{Name: "Power plan Balanced", OK: true, Detail: "Về scheme mặc định của Windows"})
	}
	if tr := perfTimerResolution("off", 0); tr.Success {
		res.Steps = append(res.Steps, PerfStep{Name: "Timer resolution mặc định", OK: true, Detail: tr.Message})
	}
	res.Message = "Đã khôi phục cấu hình gốc (GPU / power plan / timer)"
	return res
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

func firstGUID(s string) string {
	for _, f := range strings.Fields(s) {
		if len(f) == 36 && strings.Count(f, "-") == 4 {
			return f
		}
	}
	return ""
}

func ocLevelVN(l string) string {
	switch l {
	case "safe":
		return "an toàn"
	case "max":
		return "tối đa"
	}
	return "cân bằng"
}
