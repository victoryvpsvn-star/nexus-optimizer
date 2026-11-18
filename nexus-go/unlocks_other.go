//go:build !windows
// +build !windows

package main

import "runtime"

const unlockMode = "ci-sim"

/** Nền KHÔNG phải Windows (CI Linux): trạng thái + kết quả mô phỏng trung thực —
 * quy trình CI test được shape end-to-end, Windows chạy powercfg/nvidia-smi thật. */
func getUnlocksStatus() UnlockStatus {
	return UnlockStatus{
		Mode: unlockMode,
		CPU:  UnlockCPUStatus{ThrottleMin: "5%", ThrottleMax: "100%", PowerThrottlingOff: "mặc định (bật) — mô phỏng CI"},
		GPU:  UnlockGPUStatus{Available: false, Name: "", ClockNote: "Không có GPU NVIDIA trên máy CI (mô phỏng)"},
		Note: unlockNoteOther,
	}
}

func runUnlock(action string) UnlockRunResult {
	res := fmtUnlockSim(action)
	res.Mode = unlockMode
	res.Message += " (" + runtime.GOOS + ")"
	return res
}
