package main

// perf.go — Hiệu năng: Timer Resolution (tự chọn giá trị tốt nhất máy hỗ trợ), ép xung GPU/CPU
// (an toàn: khóa clock boost + power plan, không vọc voltage), mục tiêu FPS + API cho FPS test.
// Phần gọi hệ thống thật nằm ở perf_windows.go (build tag windows); nền khác → perf_other.go
// (chế độ mô phỏng cho CI — kết quả luôn ghi rõ mode để không nhầm với tác dụng thật).

import (
	"net/http"
	"strconv"
	"strings"
)

// PerfSettings — cấu hình hiệu năng lưu trong config.json (mục "perf").
type PerfSettings struct {
	FpsTarget int    `json:"fpsTarget"` // mục tiêu FPS của test/benchmark (mặc định 60)
	TimerRes  string `json:"timerRes"`  // "auto" | "0.5" | "1" | "2" | "off"
	OcLevel   string `json:"ocLevel"`   // "safe" | "balanced" | "max"
}

func defaultPerfSettings() PerfSettings {
	return PerfSettings{FpsTarget: 60, TimerRes: "auto", OcLevel: "balanced"}
}

func (s *Store) normalizePerfLocked() {
	if s.data.Perf.FpsTarget <= 0 {
		s.data.Perf.FpsTarget = 60
	}
	if s.data.Perf.TimerRes == "" {
		s.data.Perf.TimerRes = "auto"
	}
	if s.data.Perf.OcLevel != "safe" && s.data.Perf.OcLevel != "balanced" && s.data.Perf.OcLevel != "max" {
		s.data.Perf.OcLevel = "balanced"
	}
}

func (s *Store) GetPerfSettings() PerfSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.normalizePerfLocked()
	return s.data.Perf
}

func (s *Store) PutPerfSettings(p PerfSettings) PerfSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Perf = p
	s.normalizePerfLocked()
	_ = s.saveLocked()
	return s.data.Perf
}

// ---------- Kết quả API ----------

type PerfStep struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// v3.6.0: GPU ưu tiên cao cho game — UserGpuPreferences (HKCU, không cần admin)
type GameGpuEntry struct {
	Path  string `json:"path"`
	Value string `json:"value"`
}

type GameGpuResult struct {
	Success bool   `json:"success"`
	Mode    string `json:"mode"` // "windows" (HKCU thật) | "ci-sim"
	Action  string `json:"action"`
	Path    string `json:"path,omitempty"`
	Message string `json:"message"`
}

type GameGpuList struct {
	Mode    string         `json:"mode"`
	Entries []GameGpuEntry `json:"entries"`
}

// v3.6.0: GPU ưu tiên cao cho game — UserGpuPreferences trong HKCU (không cần admin).
// Ghi chú: GpuPreference=2 = "Hiệu năng cao" → Windows luôn chọn GPU rời cho file exe đó.
const gpuPrefKey = `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`
const gpuPrefValue = "GpuPreference=2;"

type OcResult struct {
	Success bool       `json:"success"`
	Mode    string     `json:"mode"` // "windows" (tác dụng thật) | "ci-sim" (mô phỏng)
	Level   string     `json:"level"`
	GPU     string     `json:"gpu"`
	Steps   []PerfStep `json:"steps"`
	Message string     `json:"message"`
}

type TimerResResult struct {
	Success bool   `json:"success"`
	Mode    string `json:"mode"`
	Action  string `json:"action"` // auto | apply | off
	Before  string `json:"before"` // độ phân giải hiện tại trước khi đặt (ms)
	After   string `json:"after"`  // sau khi đặt
	Chosen  string `json:"chosen"` // giá trị tự chọn tốt nhất máy hỗ trợ (ms)
	Method  string `json:"method"` // cơ chế dùng (NtSetTimerResolution / mô phỏng)
	Message string `json:"message"`
}

type PerfStatus struct {
	Mode      string `json:"mode"`
	TimerRes  string `json:"timerRes"` // độ phân giải timer hiện tại của hệ thống (ms)
	TimerSet  string `json:"timerSet"` // cấu hình đang lưu ("auto"/"0.5"/…/"off")
	GPU       string `json:"gpu"`
	GPUClocks string `json:"gpuClocks"` // xung hiện tại/tối đa nếu đọc được
	FpsTarget int    `json:"fpsTarget"`
	OcLevel   string `json:"ocLevel"`
	OS        string `json:"os"`
}

func validOcLevel(l string) bool { return l == "safe" || l == "balanced" || l == "max" }

func registerPerfRoutes(mux *http.ServeMux) {
	// ---------- Hiệu năng ----------
	mux.HandleFunc("GET /api/perf/settings", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, appState.GetPerfSettings())
	})
	mux.HandleFunc("PUT /api/perf/settings", func(w http.ResponseWriter, r *http.Request) {
		var p PerfSettings
		if !readBody(w, r, &p) {
			return
		}
		if p.FpsTarget < 30 || p.FpsTarget > 1000 {
			writeErr(w, 400, "FPS mục tiêu chỉ nhận 30…1000")
			return
		}
		if p.TimerRes != "auto" && p.TimerRes != "off" && p.TimerRes != "0.5" && p.TimerRes != "1" && p.TimerRes != "2" {
			writeErr(w, 400, "TimerRes chỉ nhận auto/0.5/1/2/off")
			return
		}
		if !validOcLevel(p.OcLevel) {
			writeErr(w, 400, "Mức ép xung chỉ nhận safe/balanced/max")
			return
		}
		writeJSON(w, 200, appState.PutPerfSettings(p))
	})
	mux.HandleFunc("GET /api/perf/status", func(w http.ResponseWriter, r *http.Request) {
		st := perfStatus()
		p := appState.GetPerfSettings()
		st.FpsTarget = p.FpsTarget
		st.TimerSet = p.TimerRes
		st.OcLevel = p.OcLevel
		writeJSON(w, 200, st)
	})
	mux.HandleFunc("POST /api/perf/timer-resolution", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Action string  `json:"action"` // auto | apply | off
			Ms     float64 `json:"ms"`     // khi action=apply
		}
		if !readBody(w, r, &body) {
			return
		}
		if body.Action == "" {
			body.Action = "auto"
		}
		if body.Action == "apply" && body.Ms != 0.5 && body.Ms != 1 && body.Ms != 2 {
			writeErr(w, 400, "Giá trị timer chỉ nhận 0.5 / 1 / 2 ms")
			return
		}
		if body.Action != "auto" && body.Action != "apply" && body.Action != "off" {
			writeErr(w, 400, "Action chỉ nhận auto/apply/off")
			return
		}
		res := perfTimerResolution(body.Action, body.Ms)
		code := 200
		if !res.Success {
			code = 500
		}
		writeJSON(w, code, res)
	})
	mux.HandleFunc("POST /api/perf/overclock", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Level string `json:"level"`
		}
		if !readBody(w, r, &body) {
			return
		}
		if body.Level == "" {
			body.Level = appState.GetPerfSettings().OcLevel
		}
		if !validOcLevel(body.Level) {
			writeErr(w, 400, "Mức ép xung chỉ nhận safe/balanced/max")
			return
		}
		if !trySysOp("ép xung") { // v4.1.1 (P2-08)
			writeErr(w, 409, sysOpBusyErr())
			return
		}
		res := perfOverclock(body.Level)
		doneSysOp()
		if res.Level == "" {
			res.Level = body.Level
		}
		code := 200
		if !res.Success {
			code = 500
		}
		writeJSON(w, code, res)
	})
	mux.HandleFunc("POST /api/perf/restore", func(w http.ResponseWriter, r *http.Request) {
		if !trySysOp("khôi phục ép xung") { // v4.1.1 (P2-08)
			writeErr(w, 409, sysOpBusyErr())
			return
		}
		defer doneSysOp()
		writeJSON(w, 200, perfRestore())
	})
	// v3.6.0: GPU ưu tiên cao cho game (UserGpuPreferences)
	mux.HandleFunc("GET /api/perf/game-gpu", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, perfGameGPUList())
	})
	mux.HandleFunc("POST /api/perf/game-gpu", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path   string `json:"path"`
			Action string `json:"action"` // set | clear
		}
		if !readBody(w, r, &body) {
			return
		}
		body.Path = strings.TrimSpace(strings.Trim(body.Path, `"`))
		if body.Action == "" {
			body.Action = "set"
		}
		if body.Action != "set" && body.Action != "clear" {
			writeErr(w, 400, "Action chỉ nhận set/clear")
			return
		}
		if body.Path == "" || len(body.Path) > 260 {
			writeErr(w, 400, "Đường dẫn exe game rỗng hoặc quá dài (>260 ký tự)")
			return
		}
		res := perfGameGPUSet(body.Path, body.Action)
		code := 200
		if !res.Success {
			code = 500
		}
		writeJSON(w, code, res)
	})
}

func fmtMs(v float64) string { return strconv.FormatFloat(v, 'f', 2, 64) + " ms" }

// firstLine — rút gọn output của lệnh hệ thống thành 1 dòng ≤120 ký tự (dùng chung
// perf + fixes + appopt trên mọi nền tảng — trước đây nằm ở perf_windows.go, v3.7.0 chuyển)
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
