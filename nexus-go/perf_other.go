//go:build !windows
// +build !windows

package main

// perf_other.go — nền KHÔNG phải Windows (máy dev / runner CI Linux): các API vẫn hoạt động
// ở chế độ MÔ PHỎNG để quy trình CI test được end-to-end (UI → API → kết quả → FPS test).
// Mọi kết quả đều ghi mode="ci-sim" và ghi rõ trong từng bước là mô phỏng — không gắn tag
// "tác dụng thật" như perf_windows.go. Timer resolution thật trên Linux vốn ~1ms (HZ cao).

import (
	"fmt"
	"runtime"
	"time"
)

const perfMode = "ci-sim"

func perfStatus() PerfStatus {
	return PerfStatus{
		Mode:      perfMode,
		TimerRes:  "1.00 ms", // Linux vốn dùng high-res timer ~1ms
		GPU:       "Không có GPU trên máy CI (mô phỏng)",
		GPUClocks: "—",
		OS:        runtime.GOOS,
	}
}

func perfTimerResolution(action string, ms float64) TimerResResult {
	res := TimerResResult{Mode: perfMode, Action: action, Method: "mô phỏng (CI Linux — Windows dùng ntdll!NtSetTimerResolution)"}
	res.Before = "1.00 ms"
	switch action {
	case "off":
		res.After = "1.00 ms"
		res.Chosen = "mặc định hệ thống"
		res.Success = true
		res.Message = "Đã khôi phục timer mặc định (mô phỏng CI)"
	default:
		chosen := ms
		if action == "auto" {
			chosen = 0.5 // máy CI "hỗ trợ" 0.5ms — Windows sẽ dò thật bằng ntdll
		}
		res.Chosen = fmtMs(chosen)
		res.After = fmtMs(chosen)
		res.Success = true
		res.Message = fmt.Sprintf("Tự chọn timer resolution tốt nhất: %.2f ms (trước: %s) — mô phỏng CI, Windows sẽ dò thật", chosen, res.Before)
	}
	return res
}

func perfOverclock(level string) OcResult {
	oc := OcResult{Mode: perfMode, Level: level, Success: true, GPU: "Không có GPU trên CI (mô phỏng)", Steps: []PerfStep{}}
	note := "mô phỏng trên CI Linux — Windows sẽ gọi nvidia-smi/powercfg thật"
	oc.Steps = append(oc.Steps,
		PerfStep{Name: "Khóa xung lõi GPU mức boost tối đa", OK: true, Detail: note},
		PerfStep{Name: "Power plan High Performance", OK: true, Detail: note},
	)
	if level != "safe" {
		oc.Steps = append(oc.Steps, PerfStep{Name: "CPU min state 100% (cắm điện)", OK: true, Detail: note})
		if level == "max" {
			oc.Steps = append(oc.Steps, PerfStep{Name: "Ultimate Performance plan", OK: true, Detail: note})
		}
	}
	oc.Message = fmt.Sprintf("Ép xung mức %s hoàn tất (mô phỏng CI, thời gian ghi nhận %s) — Windows sẽ chạy thật", ocLevelVN2(level), time.Now().Format("15:04:05"))
	return oc
}

func perfRestore() OcResult {
	res := OcResult{Mode: perfMode, Level: "restore", Success: true, Steps: []PerfStep{}}
	res.Steps = append(res.Steps,
		PerfStep{Name: "Gỡ khóa xung GPU", OK: true, Detail: "mô phỏng trên CI Linux"},
		PerfStep{Name: "Power plan Balanced", OK: true, Detail: "mô phỏng trên CI Linux"},
		PerfStep{Name: "Timer resolution mặc định", OK: true, Detail: "mô phỏng trên CI Linux"},
	)
	res.Message = "Đã khôi phục cấu hình gốc (mô phỏng CI)"
	return res
}

// v3.6.0: mô phỏng UserGpuPreferences — lưu in-memory để CI test được shape end-to-end
var ciSimGpuPrefs = map[string]string{}

func perfGameGPUSet(path, action string) GameGpuResult {
	res := GameGpuResult{Mode: perfMode, Action: action, Path: path}
	if action == "clear" {
		delete(ciSimGpuPrefs, path)
		res.Success = true
		res.Message = "Đã gỡ ưu tiên GPU cho " + path + " (mô phỏng CI)"
		return res
	}
	ciSimGpuPrefs[path] = gpuPrefValue
	res.Success = true
	res.Message = "Đã đặt GPU Ưu tiên cao cho " + path + " (mô phỏng CI — Windows sẽ ghi HKCU UserGpuPreferences thật)"
	return res
}

func perfGameGPUList() GameGpuList {
	lst := GameGpuList{Mode: perfMode, Entries: []GameGpuEntry{}}
	for p, v := range ciSimGpuPrefs {
		lst.Entries = append(lst.Entries, GameGpuEntry{Path: p, Value: v})
	}
	return lst
}

func ocLevelVN2(l string) string {
	switch l {
	case "safe":
		return "an toàn"
	case "max":
		return "tối đa"
	}
	return "cân bằng"
}
