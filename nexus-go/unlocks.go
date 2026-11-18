// unlocks.go — v4.0.0: Unlock giới hạn phần cứng (CPU throttle + GPU power/clock limit).
// Đối với Windows: powercfg PROCTHROTTLE (AC+DC), PowerThrottlingOff registry, nvidia-smi
// power limit + lock clock max. Đối với nền khác: chế độ mô phỏng CI trung thực.
// Nguyên tắc v3.9.0 giữ nguyên: snapshot giá trị gốc trước khi đổi, hoàn tác trả đúng gốc,
// tổng hợp kết quả trung thực từng bước (không khoe success khi bước lỗi).
package main

import "net/http"

type UnlockCPUStatus struct {
	ThrottleMin        string `json:"throttleMin"`        // % — theo power plan hiện tại (AC)
	ThrottleMax        string `json:"throttleMax"`        // %
	PowerThrottlingOff string `json:"powerThrottlingOff"` // "mặc định (bật)" hoặc giá trị registry
}

type UnlockGPUStatus struct {
	Available   bool   `json:"available"`
	Name        string `json:"name,omitempty"`
	PowerNow    string `json:"powerNow,omitempty"`    // W
	PowerMin    string `json:"powerMin,omitempty"`    // W
	PowerMax    string `json:"powerMax,omitempty"`    // W
	PowerDefault string `json:"powerDefault,omitempty"` // W — giá trị gốc để hoàn tác
	ClockSM     string `json:"clockSm,omitempty"`     // SM clock ứng dụng hiện tại
	ClockSMMax  string `json:"clockSmMax,omitempty"`  // SM clock tối đa card hỗ trợ
	ClockNote   string `json:"clockNote,omitempty"`
}

type UnlockStatus struct {
	Mode string           `json:"mode"` // "windows" | "ci-sim"
	CPU  UnlockCPUStatus  `json:"cpu"`
	GPU  UnlockGPUStatus  `json:"gpu"`
	Note string           `json:"note"`
}

type UnlockRunResult struct {
	Success bool       `json:"success"`
	Mode    string     `json:"mode"`
	Action  string     `json:"action"`
	Steps   []PerfStep `json:"steps"`
	Message string     `json:"message"`
}

func registerUnlocksRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/unlocks", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, getUnlocksStatus())
	})
	mux.HandleFunc("POST /api/unlocks", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Action string `json:"action"` // cpu-full | gpu-power | gpu-clock | restore
		}
		if !readBody(w, r, &body) {
			return
		}
		switch body.Action {
		case "cpu-full", "gpu-power", "gpu-clock", "restore":
		default:
			writeErr(w, 400, "Hành động không hợp lệ — cần action: cpu-full|gpu-power|gpu-clock|restore")
			return
		}
		res := runUnlock(body.Action)
		code := 200
		if !res.Success && res.Mode == "windows" {
			code = 500
		}
		writeJSON(w, code, res)
	})
}

const unlockNoteWin = "CPU unlock đổi power plan máy (cần admin, hiệu lực ngay) — GPU power/clock chỉ áp dụng cho NVIDIA qua nvidia-smi; driver laptop có thể chặn, khi đó sẽ báo lỗi trung thực. Khóa clock reset lại sau khi khởi động máy."
const unlockNoteOther = "Unlock phần cứng chỉ áp dụng được trên Windows (bản .exe) — các mục sẽ được báo lỗi trung thực."

/** Kết quả mô phỏng dùng chung cho nền không phải Windows (unlocks_other.go gọi) */
func fmtUnlockSim(action string) UnlockRunResult {
	return UnlockRunResult{Mode: unlockMode, Action: action, Success: true, Steps: []PerfStep{
		{Name: "Mô phỏng unlock " + action, OK: true, Detail: "mô phỏng trên CI Linux — Windows sẽ gọi powercfg/nvidia-smi thật"},
	}, Message: "Unlock " + action + " hoàn tất (mô phỏng CI) — Windows sẽ chạy thật"}
}
