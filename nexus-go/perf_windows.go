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
	"os/exec"
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
	// v4.1.1 (P2-01): dùng đường dẫn resolved — nvidia-smi không nằm trong PATH vẫn chạy được
	r := runExe(nvSmi(), []string{"--query-gpu=" + q, "--format=csv,noheader,nounits"}, 5*time.Second)
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
		r := runSysExe("powershell.exe", []string{"-NoProfile", "-Command",
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
		r := runSysExe("powershell.exe", []string{"-NoProfile", "-Command",
			"(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name"}, 8*time.Second)
		if r.OK {
			gpu = strings.TrimSpace(r.Stdout)
		}
	}
	oc.GPU = gpu
	if gpu == "" {
		gpu = "không nhận diện được"
	}

	// 1) Ép xung GPU: NVIDIA → đặt trần xung lõi (và bộ nhớ nếu ≥ balanced) theo mức tối đa
	// v4.1.1 (P1-02): bước bắt buộc trên NVIDIA — fail → tổng thể fail; (P2-03) không hứa
	// "giữ boost tối đa liên tục" — xung thực tế phụ thuộc nhiệt/điện/driver/tải
	if clockMax != "" {
		// v4.3.0 (P1-09): snapshot CUSTOM LOCK người dùng có TRƯỚC khi ghi đè —
		// Applications Clocks SM ≠ Default → có lock; restore sẽ trả đúng lock đó thay vì -rgc mù
		if q := runExe(nvSmi(), []string{"-q", "-d", "CLOCK"}, 8*time.Second); q.OK {
			appSM := nvClockField(q.Stdout, "Applications Clocks", "SM")
			defSM := nvClockField(q.Stdout, "Default Applications Clocks", "SM")
			if appSM != "" && defSM != "" && appSM != defSM {
				_ = updateAppoptSnap("perf", func(m map[string]map[string]string) {
					if m["gpuLockBefore"] == nil {
						m["gpuLockBefore"] = map[string]string{"v": appSM}
					}
				})
			}
		}
		r := runExe(nvSmi(), []string{"-lgc", "0," + clockMax}, 8*time.Second)
		if r.OK {
			oc.Steps = append(oc.Steps, PerfStep{Name: "Trần xung lõi GPU " + clockMax + " MHz (NVIDIA)", OK: true,
				Detail: "nvidia-smi -lgc 0," + clockMax + " — đặt trần theo mức tối đa driver cho phép; xung thực tế còn phụ thuộc nhiệt độ/điện/driver/tải"})
			if level != "safe" {
				if mc, ok := nvidiaQuery("clocks.max.mc"); ok && mc != "" {
					r2 := runExe(nvSmi(), []string{"-lmc", "0," + mc}, 8*time.Second)
					oc.Steps = append(oc.Steps, PerfStep{Name: "Trần xung bộ nhớ GPU " + mc + " MHz", OK: r2.OK,
						Detail: firstLine(r2.Stdout + r2.Stderr)})
					if !r2.OK {
						oc.Success = false
					}
				}
			}
		} else {
			oc.Steps = append(oc.Steps, PerfStep{Name: "Trần xung lõi GPU", OK: false,
				Detail: firstLine(r.Stdout + r.Stderr)})
			oc.Success = false // NVIDIA có sẵn mà đặt trần lỗi — không được báo thành công
		}
	} else {
		// GPU khác: bật HAGS (lập lịch GPU phần cứng) — bước TÙY CHỌN, fail không làm tổng thể fail
		// v4.1.1 (P1-01): snapshot HAGS gốc (kể cả exists=false) trước khi ghi — restore trả đúng
		const hagsKey = `HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers`
		hagsTyp, hagsData, hagsExists, hagsErr := regQueryValueStrict(hagsKey, "HwSchMode")
		if hagsErr == nil {
			// v4.3.0 (P1-04): fail closed — load/snapshot lỗi thì KHÔNG ghi HAGS;
			// update qua read-modify-write để không mất schemeGUID/CPU-MIN đã lưu
			if lerr := updateAppoptSnap("perf", func(m map[string]map[string]string) {
				if m["hagsExists"] == nil { // giữ snapshot lần đầu
					m["hagsExists"] = map[string]string{"v": map[bool]string{true: "1", false: "0"}[hagsExists]}
					if hagsExists {
						m["hagsType"] = map[string]string{"v": hagsTyp}
						m["hagsData"] = map[string]string{"v": hagsData}
					}
				}
			}); lerr != nil {
				hagsErr = powerErr("snapshot perf không đọc/ghi được (P1-04 fail-closed): " + lerr.Error() + " — BỎ QUA bước HAGS")
			}
		}
		if hagsErr != nil {
			oc.Steps = append(oc.Steps, PerfStep{Name: "HAGS — Hardware-accelerated GPU scheduling", OK: false,
				Detail: hagsErr.Error() + " — BỎ QUA (tùy chọn, không hoàn tác được thì không áp dụng)"})
		} else {
			r := runSysExe("reg.exe", []string{"add", hagsKey,
				"/v", "HwSchMode", "/t", "REG_DWORD", "/d", "2", "/f"}, 5*time.Second)
			oc.Steps = append(oc.Steps, PerfStep{Name: "HAGS — Hardware-accelerated GPU scheduling (tùy chọn)", OK: r.OK,
				Detail: firstLine(r.Stdout+r.Stderr) + " (áp dụng sau khi khởi động lại; snapshot gốc đã lưu)"})
		}
		oc.Steps = append(oc.Steps, PerfStep{Name: "GPU " + gpu, OK: true,
			Detail: "Không phải NVIDIA — khóa clock không khả dụng; đã bật tối ưu hệ thống bên dưới"})
	}

	// 2) Power plan High Performance (mọi mức)
	// v4.1.0 (13.2): snapshot scheme đang active TRƯỚC khi đổi — restore trả đúng plan
	// người dùng đang dùng, không phải Balanced mù. Persist lỗi → KHÔNG đổi plan (không
	// áp dụng thứ mình không hoàn tác được); phần GPU vẫn chạy vì -lgc tự reset khi reboot.
	schemeBefore, schemeErr := activeSchemeGUID()
	planOK := false
	if schemeErr == nil {
		// v4.3.0 (P1-04): đọc qua update-helper — giữ nguyên HAGS/CPU-MIN đã lưu;
		// persist lỗi → KHÔNG đổi plan (fail closed)
		if old, found, lerr := loadAppoptSnap("perf"); lerr == nil && found && old["schemeGUID"] != nil {
			schemeBefore = old["schemeGUID"]["v"] // giữ scheme của lần ép xung đầu
		} else if lerr == nil {
			if serr := updateAppoptSnap("perf", func(m map[string]map[string]string) {
				if m["schemeGUID"] == nil {
					m["schemeGUID"] = map[string]string{"v": schemeBefore}
				}
			}); serr != nil {
				schemeErr = powerErr("persist snapshot scheme thất bại: " + serr.Error())
			}
		} else {
			schemeErr = powerErr(lerr.Error())
		}
	}
	if schemeErr != nil {
		oc.Steps = append(oc.Steps, PerfStep{Name: "Power plan High Performance", OK: false,
			Detail: schemeErr.Error() + " — BỎ QUA bước đổi plan (không áp dụng thứ không hoàn tác được)"})
	} else {
		r := runSysExe("powercfg.exe", []string{"/setactive", "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"}, 5*time.Second)
		planOK = r.OK
		if r.OK {
		oc.Steps = append(oc.Steps, PerfStep{Name: "Power plan High Performance", OK: true,
			Detail: "CPU không còn ngủ sớm, GPU không còn hạ xung khi rảnh"})
		} else {
			oc.Steps = append(oc.Steps, PerfStep{Name: "Power plan High Performance", OK: false,
				Detail: firstLine(r.Stdout+r.Stderr) + " (cần quyền admin?)"})
		}
		// 3) CPU min state 100% (AC+DC) + Ultimate Performance nếu max
		// v4.1.1 (P1-01): snapshot MIN AC/DC của plan bị thao tác TRƯỚC khi set (lưu cả DC);
		// (P1-02) fail → tổng thể fail, không im lặng; verify read-back sau khi set
		if level != "safe" {
			bac, bdc, berr := powercfgQueryIndices("SCHEME_CURRENT", procThrottleGUIDMin)
			if berr != nil {
				oc.Steps = append(oc.Steps, PerfStep{Name: "CPU min state 100%", OK: false,
					Detail: berr.Error() + " — không snapshot được MIN gốc, BỎ QUA (không áp dụng thứ không trả được)"})
			} else {
				// v4.3.0 (P1-04 C): persist MIN gốc là ĐIỀU KIỆN — lỗi thì không set 100%
				var persistErr error
				if lerr := updateAppoptSnap("perf", func(m map[string]map[string]string) {
					if m["cpuMinAC"] == nil { // giữ snapshot lần đầu
						m["cpuMinAC"] = map[string]string{"v": bac}
						m["cpuMinDC"] = map[string]string{"v": bdc}
					}
				}); lerr != nil {
					persistErr = lerr
				}
				if persistErr != nil {
					oc.Steps = append(oc.Steps, PerfStep{Name: "CPU min state 100%", OK: false,
						Detail: persistErr.Error() + " — không persist được MIN gốc → BỎ QUA (không áp dụng thứ không trả được)"})
					oc.Success = false
					persistErr = nil
				} else {
				r := runSysExe("powercfg.exe", []string{"/setacvalueindex", "SCHEME_CURRENT", "SUB_PROCESSOR", "PROCTHROTTLEMIN", "100"}, 5*time.Second)
				dc := runSysExe("powercfg.exe", []string{"/setdcvalueindex", "SCHEME_CURRENT", "SUB_PROCESSOR", "PROCTHROTTLEMIN", "100"}, 5*time.Second)
				dcOK := dc.OK
				if !dc.OK { // desktop không hỗ trợ DC → NotApplicable, không phải lỗi
					out := strings.ToLower(dc.Stdout + dc.Stderr)
					dcOK = strings.Contains(out, "not support") || strings.Contains(out, "không hỗ trợ")
				}
				ref := runSysExe("powercfg.exe", []string{"/setactive", "SCHEME_CURRENT"}, 5*time.Second)
				ok := r.OK && dcOK && ref.OK
				if ok { // verify read-back
					if nac, ndc, nerr := powercfgQueryIndices("SCHEME_CURRENT", procThrottleGUIDMin); nerr != nil || nac != "100" || ndc != "100" {
						if nerr == nil && nac == "100" { // desktop đọc DC khác 100 là bình thường (DC không áp dụng) — không fail cứng
							ok = true
						} else {
							ok = false
						}
					}
				}
				oc.Steps = append(oc.Steps, PerfStep{Name: "CPU min state 100% (AC+DC)", OK: ok,
					Detail: map[bool]string{true: "trước: MIN AC " + bac + "% / DC " + bdc + "% — snapshot đã lưu, verify read-back đạt",
						false: "set/verify lỗi: " + firstLine(r.Stdout+r.Stderr+dc.Stdout+dc.Stderr)}[ok]})
				if !ok {
					oc.Success = false
				}
				}
			}
			if level == "max" {
				r2 := runSysExe("powercfg.exe", []string{"/duplicatescheme", "e9a42b02-d5df-448d-aa00-03f14749eb61"}, 6*time.Second)
				if r2.OK {
					if guid := firstGUID(r2.Stdout); guid != "" {
						// v4.1.1 (P1-01) + v4.3.0 (P1-04 D): persist ultimateGUID là ĐIỀU KIỆN —
						// load/persist lỗi → KHÔNG activate scheme mới (không để plan không quản lý được)
						var ultErr error
						if lerr := updateAppoptSnap("perf", func(m map[string]map[string]string) {
							if m["ultimateGUID"] == nil {
								m["ultimateGUID"] = map[string]string{"v": guid}
							}
						}); lerr != nil {
							ultErr = lerr
						}
						if ultErr != nil {
							oc.Steps = append(oc.Steps, PerfStep{Name: "Ultimate Performance plan", OK: false,
								Detail: ultErr.Error() + " — persist snapshot plan tạo thêm thất bại → không bật Ultimate (không để rác plan không hoàn tác được)"})
							oc.Success = false
							return oc
						}
						r3 := runSysExe("powercfg.exe", []string{"/setactive", guid}, 5*time.Second)
						oc.Steps = append(oc.Steps, PerfStep{Name: "Ultimate Performance plan", OK: r3.OK,
							Detail: "Scheme Ultimate (" + guid + ") do NEXUS tạo — restore sẽ xóa đúng plan này"})
						if !r3.OK {
							oc.Success = false
						}
					} else {
						oc.Steps = append(oc.Steps, PerfStep{Name: "Ultimate Performance plan", OK: false,
							Detail: "duplicatescheme OK nhưng không đọc được GUID mới"})
						oc.Success = false
					}
				} else {
					oc.Steps = append(oc.Steps, PerfStep{Name: "Ultimate Performance plan", OK: false,
						Detail: firstLine(r2.Stdout + r2.Stderr)})
					oc.Success = false
				}
			}
		}
	}
	// v4.1.1 (P1-02): planOK trước đó bị gán rồi bỏ — giờ dùng quyết định Success
	if !planOK {
		oc.Success = false
	}

	oc.Message = fmt.Sprintf("Ép xung mức %s hoàn tất trên %s — %d bước, có thể ↩ khôi phục gốc bất cứ lúc nào", ocLevelVN(level), gpu, len(oc.Steps))
	return oc
}

// v3.9.0 (theo audit P2-29): aggregate kết quả thật — từng bước ghi cả khi lỗi;
// Success chỉ true khi các bước bắt buộc (power plan, timer) đã thành công.
func perfRestore() OcResult {
	res := OcResult{Mode: perfMode, Level: "restore", Success: true, Steps: []PerfStep{}}
	// v4.3.0: load snapshot perf ĐẦU HÀM — GPU block (P1-09) dùng trước các block khác
	snap, snapFound, snapErr := loadAppoptSnap("perf")
	var restAll = false // v4.3.0: dùng ở cả GPU block (P1-09) lẫn block snapshot
	r := runExe(nvSmi(), []string{"-rgc"}, 8*time.Second)
	if r.OK {
		res.Steps = append(res.Steps, PerfStep{Name: "Gỡ khóa xung GPU", OK: true, Detail: "xung lõi trả về điều khiển động"})
	} else if _, lookErr := exec.LookPath("nvidia-smi"); lookErr == nil {
		res.Steps = append(res.Steps, PerfStep{Name: "Gỡ khóa xung GPU", OK: false, Detail: firstLine(r.Stdout + r.Stderr)})
		res.Success = false
	} // không có nvidia-smi → máy không phải GPU NVIDIA — không tính là lỗi
	if _, lookErr := exec.LookPath(nvSmi()); lookErr == nil || nvidiaSmiPath() != "" {
		// v4.3.0 (P1-09): người dùng có custom lock TRƯỚC khi ép xung → trả đúng lock đó
		// (verify read-back); chỉ -rgc/-rmc khi snapshot xác nhận trước đó driver-managed
		if snapErr == nil && snapFound && snap["gpuLockBefore"] != nil {
			want := snap["gpuLockBefore"]["v"]
			rl := runExe(nvSmi(), []string{"-lgc", "0," + want}, 10*time.Second)
			verified := false
			if rl.OK {
				if q := runExe(nvSmi(), []string{"-q", "-d", "CLOCK"}, 8*time.Second); q.OK {
					verified = nvClockField(q.Stdout, "Applications Clocks", "SM") == want+"MHz"
				}
			}
			lockOK := rl.OK && verified
			res.Steps = append(res.Steps, PerfStep{Name: "Trả custom lock GPU " + want + "MHz (mức bạn có trước khi ép xung)", OK: lockOK,
				Detail: map[bool]string{true: "verify read-back khớp — không mất cấu hình lock của bạn",
					false: firstLine(rl.Stdout + rl.Stderr) + " — snapshot GIỮ để retry"}[lockOK]})
			if !lockOK {
				res.Success = false
				restAll = false
			}
		} else {
			rgc := runExe(nvSmi(), []string{"-rgc"}, 8*time.Second)
			if rgc.OK {
				res.Steps = append(res.Steps, PerfStep{Name: "Gỡ khóa xung GPU (-rgc)", OK: true,
					Detail: "trước khi ép xung GPU ở driver-managed — đúng trạng thái gốc"})
			} else {
				res.Steps = append(res.Steps, PerfStep{Name: "Gỡ khóa xung GPU (-rgc)", OK: false,
					Detail: firstLine(rgc.Stdout + rgc.Stderr)})
				res.Success = false
				restAll = false
			}
			// v4.1.0 (13.2): -rmc ghi trung thực từng bước
			rmc := runExe(nvSmi(), []string{"-rmc"}, 8*time.Second)
			res.Steps = append(res.Steps, PerfStep{Name: "Reset app clocks GPU (-rmc)", OK: rmc.OK,
				Detail: map[bool]string{true: "xung ứng dụng về mặc định driver", false: firstLine(rmc.Stdout + rmc.Stderr)}[rmc.OK]})
			if !rmc.OK {
				res.Success = false
			}
		}
	}
	// v4.1.0 (13.2) + v4.1.1 (P1-01): trả ĐÚNG scheme gốc + HAGS + CPU MIN + xóa plan app tạo;
	// CHỈ clear snapshot khi mọi mục restore thành công (P1-01 mục 9)
	r2OK, schemeDetail := false, ""
	if snapErr == nil && snapFound && snap["schemeGUID"] != nil {
		want := snap["schemeGUID"]["v"]
		r2 := runSysExe("powercfg.exe", []string{"/setactive", want}, 5*time.Second)
		if r2.OK {
			if cur, cerr := activeSchemeGUID(); cerr == nil && cur == want {
				r2OK = true
				schemeDetail = "trả đúng power plan bạn dùng trước khi ép xung (" + want + ") — verify khớp"
			} else if cerr != nil {
				schemeDetail = cerr.Error() + " — không verify được"
			} else {
				schemeDetail = "setactive exit 0 nhưng scheme hiện tại là " + cur + " — không khớp, coi như lỗi"
			}
		} else {
			schemeDetail = firstLine(r2.Stdout + r2.Stderr)
		}
	} else if snapErr != nil {
		schemeDetail = snapErr.Error()
	} else {
		// không có snapshot (ép xung từ bản cũ) — fallback Balanced + nói rõ không phải exact
		r2 := runSysExe("powercfg.exe", []string{"/setactive", "381b4222-f694-41f0-9685-ff5bb260df2e"}, 5*time.Second)
		r2OK = r2.OK
		schemeDetail = "không có snapshot scheme gốc (bản ép xung cũ) — về Balanced mặc định, tự chọn lại plan của bạn nếu cần"
		if !r2OK {
			schemeDetail = firstLine(r2.Stdout + r2.Stderr)
		}
	}
	if r2OK {
		res.Steps = append(res.Steps, PerfStep{Name: "Power plan → trạng thái gốc", OK: true, Detail: schemeDetail})
	} else {
		res.Steps = append(res.Steps, PerfStep{Name: "Power plan → trạng thái gốc", OK: false, Detail: schemeDetail})
		res.Success = false
	}
	restAll = r2OK
	if snapErr == nil && snapFound {
		// (P1-01) CPU MIN trả đúng giá trị gốc trên plan High Performance (plan bị thao tác)
		if snap["cpuMinAC"] != nil {
			minOK := true
			for _, c := range []struct{ flag, val string }{
				{"/setacvalueindex", snap["cpuMinAC"]["v"]},
				{"/setdcvalueindex", snap["cpuMinDC"]["v"]},
			} {
				r3 := runSysExe("powercfg.exe", []string{c.flag, "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c", "SUB_PROCESSOR", "PROCTHROTTLEMIN", c.val}, 5*time.Second)
				if !r3.OK {
					out := strings.ToLower(r3.Stdout + r3.Stderr)
					if !(strings.Contains(out, "not support") || strings.Contains(out, "không hỗ trợ")) {
						minOK = false
					}
				}
			}
			// v4.3.0 (P1-03): KHÔNG setactive High Perf sau khi trả MIN — setacvalueindex
			// đã lưu giá trị vào plan; activate sẽ đẩy plan active cuối về High Perf thay vì
			// plan gốc (bug audit #3). Verify read-back trực tiếp trên plan bị thao tác.
			if nac, _, nerr := powercfgQueryIndices("8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c", procThrottleGUIDMin); nerr != nil || nac != snap["cpuMinAC"]["v"] {
				minOK = false // desktop đọc DC khác gốc là bình thường (DC không áp dụng) — verify AC là đủ
			}
			res.Steps = append(res.Steps, PerfStep{Name: "CPU min state → trả giá trị gốc", OK: minOK,
				Detail: "MIN AC " + snap["cpuMinAC"]["v"] + "% / DC " + snap["cpuMinDC"]["v"] + "% trên plan High Performance (verify read-back)"})
			if !minOK {
				res.Success = false
				restAll = false
			}
		}
		// (P1-01) HAGS trả gốc / xóa nếu chưa từng có
		if snap["hagsExists"] != nil {
			hagsOK := true
			const hagsKey = `HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers`
			if snap["hagsExists"]["v"] == "1" {
				r4 := runSysExe("reg.exe", []string{"add", hagsKey, "/v", "HwSchMode", "/t", snap["hagsType"]["v"], "/d", snap["hagsData"]["v"], "/f"}, 6*time.Second)
				hagsOK = r4.OK
				res.Steps = append(res.Steps, PerfStep{Name: "HAGS → trả giá trị gốc", OK: hagsOK, Detail: snap["hagsData"]["v"] + " (áp dụng sau khởi động lại)"})
			} else {
				r4 := runSysExe("reg.exe", []string{"delete", hagsKey, "/v", "HwSchMode", "/f"}, 6*time.Second)
				hagsOK = r4.OK
				res.Steps = append(res.Steps, PerfStep{Name: "HAGS → về mặc định (xóa registry)", OK: hagsOK, Detail: "HwSchMode chưa từng có trước khi ép xung"})
			}
			if !hagsOK {
				res.Success = false
				restAll = false
			}
		}
		// (P1-01) xóa Ultimate plan do NEXUS tạo (không đụng plan người dùng)
		if snap["ultimateGUID"] != nil {
			r5 := runSysExe("powercfg.exe", []string{"/delete", snap["ultimateGUID"]["v"]}, 6*time.Second)
			ultOK := r5.OK
			res.Steps = append(res.Steps, PerfStep{Name: "Xóa Ultimate plan do NEXUS tạo", OK: ultOK,
				Detail: map[bool]string{true: snap["ultimateGUID"]["v"] + " — plan copy riêng của app, không đụng plan của bạn",
					false: firstLine(r5.Stdout + r5.Stderr) + " — plan còn lại, xóa tay bằng powercfg /delete nếu muốn"}[ultOK]})
			if !ultOK {
				res.Success = false
				restAll = false
			}
		}
		if restAll {
			// v4.3.0 (P1-03): verify CUỐI — plan đang active phải là plan gốc từ snapshot
			// (không thể "restore thành công" trong khi máy vẫn đang chạy High/Ultimate)
			if snap["schemeGUID"] != nil {
				if cur, cerr := activeSchemeGUID(); cerr != nil || cur != snap["schemeGUID"]["v"] {
					res.Success = false
					restAll = false
					res.Steps = append(res.Steps, PerfStep{Name: "Verify plan active cuối", OK: false,
						Detail: "máy đang dùng scheme " + cur + " ≠ gốc " + snap["schemeGUID"]["v"] + " — giữ snapshot để Restore lại"})
				}
			}
		}
		if restAll {
			if err := clearAppoptSnap("perf"); err != nil {
				res.Success = false
				restAll = false
				res.Steps = append(res.Steps, PerfStep{Name: "Xóa snapshot perf", OK: false, Detail: err.Error() + " — giữ để retry an toàn"})
			}
		}
	}
	tr := perfTimerResolution("off", 0)
	if tr.Success {
		res.Steps = append(res.Steps, PerfStep{Name: "Timer resolution mặc định", OK: true, Detail: tr.Message})
	} else {
		res.Steps = append(res.Steps, PerfStep{Name: "Timer resolution mặc định", OK: false, Detail: tr.Message})
		res.Success = false
	}
	res.Message = map[bool]string{true: "Đã khôi phục cấu hình gốc (GPU / power plan / timer)",
		false: "Khôi phục xong nhưng một số bước lỗi — xem chi tiết từng bước"}[res.Success]
	return res
}

// v3.6.0: GPU ưu tiên cao cho game — UserGpuPreferences trong HKCU (không cần admin),
// const gpuPrefKey/gpuPrefValue nằm ở perf.go dùng chung với bản mô phỏng CI.
func perfGameGPUSet(path, action string) GameGpuResult {
	res := GameGpuResult{Mode: perfMode, Action: action, Path: path}
	switch action {
	case "clear":
		r := runSysExe("reg.exe", []string{"delete", gpuPrefKey, "/v", path, "/f"}, 5*time.Second)
		res.Success = r.OK
		if r.OK {
			res.Message = "Đã gỡ ưu tiên GPU cho " + path + " — Windows tự chọn lại GPU"
		} else {
			res.Message = firstLine(r.Stdout + r.Stderr) + " (chưa đặt hoặc thiếu quyền?)"
		}
	default:
		r := runSysExe("reg.exe", []string{"add", gpuPrefKey, "/v", path, "/t", "REG_SZ", "/d", gpuPrefValue, "/f"}, 5*time.Second)
		res.Success = r.OK
		if r.OK {
			res.Message = "Đã đặt GPU Ưu tiên cao (hiệu năng cao) cho " + path + " — hiệu lực ngay, không cần khởi động lại"
		} else {
			res.Message = firstLine(r.Stdout + r.Stderr)
		}
	}
	return res
}

func perfGameGPUList() GameGpuList {
	lst := GameGpuList{Mode: perfMode, Entries: []GameGpuEntry{}}
	r := runSysExe("reg.exe", []string{"query", gpuPrefKey}, 5*time.Second)
	if !r.OK {
		return lst // key chưa tồn tại = chưa có entry nào
	}
	// output dạng: "    C:\\Games\\game.exe    REG_SZ    GpuPreference=2;" — tách theo dấu REG_SZ
	for _, line := range strings.Split(r.Stdout, "\n") {
		i := strings.Index(line, "REG_SZ")
		if i < 0 {
			continue
		}
		name := strings.TrimSpace(line[:i])
		data := strings.TrimSpace(line[i+len("REG_SZ"):])
		if name != "" && data != "" {
			lst.Entries = append(lst.Entries, GameGpuEntry{Path: name, Value: data})
		}
	}
	return lst
}

// firstLine đã chuyển sang perf.go dùng chung (v3.7.0: fixes.go cũng cần ở bản Linux)

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
