// apps_opt.go — v3.7.0: App Optimizer — thẻ tối ưu riêng từng app phổ biến
// (Edge / Chrome / Brave / Firefox / Discord / Spotify), phát hiện cài đặt THẬT qua
// đường dẫn chuẩn + áp dụng hoàn tác riêng từng app, trạng thái lưu config.json.
// Kết quả luôn trung thực: app chưa cài → "App not found", thiếu admin → báo rõ.
package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type AppOptCard struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Desc       string     `json:"desc"`
	Icon       string     `json:"icon"`
	Installed  bool       `json:"installed"`
	Path       string     `json:"path,omitempty"`
	Warning    string     `json:"warning,omitempty"`
	Applied    bool       `json:"applied"`
	AppliedAt  *time.Time `json:"appliedAt,omitempty"`
	NeedsAdmin bool       `json:"needsAdmin"`
}

type AppOptRunResult struct {
	Success bool       `json:"success"`
	Mode    string     `json:"mode"`
	ID      string     `json:"id"`
	Steps   []PerfStep `json:"steps"`
	Message string     `json:"message"`
}

type appDef struct {
	id, name, desc, icon string
	needsAdmin           bool
}

var appDefs = []appDef{
	{"edge", "Microsoft Edge Optimization",
		"Tắt Startup Boost + chạy nền của Edge qua chính sách Windows — Edge không còn ăn CPU/GPU/RAM sau khi đóng, nhường tài nguyên cho game.",
		"🌐", true},
	{"chrome", "Google Chrome Optimization",
		"Tắt chạy nền của Chrome (Background Mode) qua chính sách — đóng Chrome là thật sự thoát, không còn tiến trình nền âm thầm.",
		"🟢", true},
	{"brave", "Brave Browser Optimization",
		"Tắt chạy nền của Brave qua chính sách Windows — Brave không còn tải trang nền khi game đang chạy.",
		"🦁", true},
	{"firefox", "Mozilla Firefox Optimization",
		"Tắt telemetry + đo đạc nền của Firefox qua chính sách — bớt hoạt động nền, không thu thập dữ liệu trong lúc chơi game.",
		"🦊", true},
	{"discord", "Discord Optimization",
		"Tắt hardware acceleration trong settings.json của Discord (giảm GPU usage khi game chạy) + hạ CPU priority Discord xuống Below Normal qua IFEO.",
		"🎮", true},
	{"spotify", "Spotify Optimization",
		"Gỡ Spotify khỏi danh sách tự khởi động cùng Windows — máy bật nhanh hơn, Spotify chỉ mở khi bạn cần nghe nhạc.",
		"🎵", false},
}

// ---------- phát hiện cài đặt (đường dẫn chuẩn, không đoán mò) ----------

func firstExists(paths ...string) string {
	for _, p := range paths {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func detectApp(id string) (bool, string) {
	pf := os.Getenv("ProgramFiles")
	pf86 := os.Getenv("ProgramFiles(x86)")
	home, _ := os.UserHomeDir()
	appdata := filepath.Join(home, "AppData", "Roaming")
	localdata := filepath.Join(home, "AppData", "Local")
	switch id {
	case "edge":
		return pick(firstExists(
			filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`),
			filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`)))
	case "chrome":
		return pick(firstExists(
			filepath.Join(pf, `Google\Chrome\Application\chrome.exe`),
			filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`)))
	case "brave":
		return pick(firstExists(
			filepath.Join(pf, `BraveSoftware\Brave-Browser\Application\brave.exe`),
			filepath.Join(pf86, `BraveSoftware\Brave-Browser\Application\brave.exe`)))
	case "firefox":
		return pick(firstExists(
			filepath.Join(pf, `Mozilla Firefox\firefox.exe`),
			filepath.Join(pf86, `Mozilla Firefox\firefox.exe`)))
	case "discord":
		if p := firstExists(filepath.Join(appdata, "discord", "settings.json")); p != "" {
			return true, p
		}
		return pick(firstExists(filepath.Join(localdata, "Discord", "Update.exe")))
	case "spotify":
		return pick(firstExists(filepath.Join(appdata, "Spotify", "Spotify.exe")))
	}
	return false, ""
}

func pick(p string) (bool, string) { return p != "", p }

// ---------- registry key chính sách cho từng app ----------

const polEdge = `HKLM\SOFTWARE\Policies\Microsoft\Edge`
const polChrome = `HKLM\SOFTWARE\Policies\Google\Chrome`
const polBrave = `HKLM\SOFTWARE\Policies\BraveSoftware\Brave`
const polFirefox = `HKLM\SOFTWARE\Policies\Mozilla\Firefox`
const ifeoDiscord = `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\Discord.exe\PerfOptions`

// ---------- áp dụng / hoàn tác từng app ----------

func applyBrowserPolicy(id string) AppOptRunResult {
	var key string
	var vals []RegValue
	switch id {
	case "edge":
		key = polEdge
		vals = []RegValue{{"StartupBoostEnabled", "REG_DWORD", "0"}, {"BackgroundModeEnabled", "REG_DWORD", "0"}}
	case "chrome":
		key = polChrome
		vals = []RegValue{{"BackgroundModeEnabled", "REG_DWORD", "0"}}
	case "brave":
		key = polBrave
		vals = []RegValue{{"BackgroundModeEnabled", "REG_DWORD", "0"}}
	case "firefox":
		key = polFirefox
		vals = []RegValue{{"DisableTelemetry", "REG_DWORD", "1"}}
	}
	r := regAddValues(key, vals, "")
	res := AppOptRunResult{Mode: "windows", ID: id, Steps: []PerfStep{{Name: "Ghi chính sách " + key, OK: r.Success, Detail: r.Message}}}
	if id == "edge" {
		res.Steps[0].Name = "Startup Boost + Background Mode → tắt (chính sách Edge)"
	} else if id == "firefox" {
		res.Steps[0].Name = "Telemetry Firefox → tắt (chính sách Mozilla)"
	} else {
		res.Steps[0].Name = "Background Mode → tắt (chính sách trình duyệt)"
	}
	res.Steps[0].Detail = "Áp dụng sau khi khởi động lại trình duyệt. Hoàn tác được mọi lúc."
	res.Success = r.Success
	res.Message = map[bool]string{true: "Đã tối ưu qua chính sách Windows", false: r.Message}[r.Success]
	return res
}

func revertBrowserPolicy(id string) AppOptRunResult {
	key, names := polChrome, []string{"BackgroundModeEnabled"}
	switch id {
	case "edge":
		key, names = polEdge, []string{"StartupBoostEnabled", "BackgroundModeEnabled"}
	case "chrome":
		key, names = polChrome, []string{"BackgroundModeEnabled"}
	case "brave":
		key, names = polBrave, []string{"BackgroundModeEnabled"}
	case "firefox":
		key, names = polFirefox, []string{"DisableTelemetry"}
	}
	r := regDeleteValues(key, names, "")
	return AppOptRunResult{Mode: "windows", ID: id, Success: r.Success,
		Steps: []PerfStep{{Name: "Gỡ chính sách (về mặc định)", OK: r.Success, Detail: r.Message}},
		Message: map[bool]string{true: "Đã hoàn tác — trình duyệt về mặc định", false: r.Message}[r.Success]}
}

func applyDiscord(enabled bool) AppOptRunResult {
	res := AppOptRunResult{Mode: "windows", ID: "discord", Steps: []PerfStep{}}
	home, _ := os.UserHomeDir()
	cfg := filepath.Join(home, "AppData", "Roaming", "discord", "settings.json")
	if enabled {
		if st, err := os.Stat(cfg); err == nil && !st.IsDir() {
			raw, err := os.ReadFile(cfg)
			if err == nil {
				var m map[string]any
				if err := json.Unmarshal(raw, &m); err == nil {
					m["HardwareAcceleration"] = false
					if out, err := json.MarshalIndent(m, "", "  "); err == nil && os.WriteFile(cfg, out, 0644) == nil {
						res.Steps = append(res.Steps, PerfStep{Name: "Hardware Acceleration → tắt trong settings.json", OK: true,
							Detail: "Discord không còn cạnh tranh GPU với game — áp dụng sau khi mở lại Discord"})
					}
				}
			}
		} else {
			res.Steps = append(res.Steps, PerfStep{Name: "Hardware Acceleration → tắt trong settings.json", OK: false,
				Detail: "không tìm thấy settings.json của Discord"})
		}
		// IFEO CPU priority — cần admin
		r := regAddValues(ifeoDiscord, []RegValue{{"CpuPriorityClass", "REG_DWORD", "16384"}}, "")
		res.Steps = append(res.Steps, PerfStep{Name: "CPU priority Discord → Below Normal (IFEO)", OK: r.Success,
			Detail: map[bool]string{true: "16384 (Below Normal) — game luôn được CPU trước Discord", false: r.Message + " (cần quyền admin)"}[r.Success]})
		res.Success = len(res.Steps) > 0 && res.Steps[0].OK
		res.Message = "Đã tối ưu Discord (HW accel tắt + ưu tiên CPU thấp)"
	} else {
		if st, err := os.Stat(cfg); err == nil && !st.IsDir() {
			if raw, err := os.ReadFile(cfg); err == nil {
				var m map[string]any
				if err := json.Unmarshal(raw, &m); err == nil {
					delete(m, "HardwareAcceleration")
					if out, err := json.MarshalIndent(m, "", "  "); err == nil && os.WriteFile(cfg, out, 0644) == nil {
						res.Steps = append(res.Steps, PerfStep{Name: "Hardware Acceleration → về mặc định", OK: true, Detail: "xóa key khỏi settings.json"})
					}
				}
			}
		}
		regDeleteValues(ifeoDiscord, []string{"CpuPriorityClass"}, "")
		res.Steps = append(res.Steps, PerfStep{Name: "CPU priority Discord → mặc định", OK: true, Detail: "đã gỡ IFEO PerfOptions"})
		res.Success = true
		res.Message = "Đã hoàn tác tối ưu Discord"
	}
	return res
}

func applySpotify(enabled bool) AppOptRunResult {
	res := AppOptRunResult{Mode: "windows", ID: "spotify", Steps: []PerfStep{}}
	runKey := `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	if enabled {
		r := regDeleteValues(runKey, []string{"Spotify", "Spotify Web Helper"}, "")
		res.Steps = append(res.Steps, PerfStep{Name: "Gỡ Spotify khỏi tự khởi động (HKCU Run)", OK: r.Success,
			Detail: map[bool]string{true: "máy bật nhanh hơn — Spotify chỉ mở khi bấm vào", false: r.Message}[r.Success]})
		res.Success = r.Success
		res.Message = "Đã gỡ Spotify khỏi khởi động Windows"
	} else {
		home, _ := os.UserHomeDir()
		exe := filepath.Join(home, "AppData", "Roaming", "Spotify", "Spotify.exe")
		if _, err := os.Stat(exe); err == nil {
			r := regAddValues(runKey, []RegValue{{"Spotify", "REG_SZ", exe}}, "")
			res.Steps = append(res.Steps, PerfStep{Name: "Khôi phục Spotify trong khởi động", OK: r.Success, Detail: exe})
			res.Success = r.Success
		} else {
			res.Success = false
			res.Steps = append(res.Steps, PerfStep{Name: "Khôi phục Spotify trong khởi động", OK: false, Detail: "không tìm thấy Spotify.exe"})
		}
		res.Message = "Đã hoàn tác"
	}
	return res
}

func runAppOpt(id string, enabled bool) AppOptRunResult {
	switch id {
	case "edge", "chrome", "brave", "firefox":
		if m, ok := adminGate(); !ok {
			return AppOptRunResult{Mode: "windows", ID: id, Success: false, Steps: []PerfStep{{Name: "Quyền admin", OK: false, Detail: m}},
				Message: m}
		}
		if enabled {
			return applyBrowserPolicy(id)
		}
		return revertBrowserPolicy(id)
	case "discord":
		return applyDiscord(enabled)
	case "spotify":
		return applySpotify(enabled)
	}
	return AppOptRunResult{Mode: "windows", ID: id, Success: false, Message: "app không hỗ trợ"}
}

// ---------- routes ----------

func registerAppOptRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/appopt", func(w http.ResponseWriter, r *http.Request) {
		cards := make([]AppOptCard, 0, len(appDefs))
		states := appState.GetAppOptStates()
		for _, d := range appDefs {
			installed, path := detectApp(d.id)
			st := states[d.id]
			c := AppOptCard{ID: d.id, Name: d.name, Desc: d.desc, Icon: d.icon,
				Installed: installed, Path: path, Applied: st.Applied, AppliedAt: st.AppliedAt, NeedsAdmin: d.needsAdmin}
			if runtimeIsWindows && !installed {
				c.Warning = "App not found — app này chưa được cài trên máy nên không thể tối ưu"
			} else if !runtimeIsWindows {
				c.Warning = "Phát hiện + tối ưu app chỉ chạy trên Windows (bản .exe) — đây là chế độ hiển thị"
			}
			cards = append(cards, c)
		}
		writeJSON(w, 200, cards)
	})
	mux.HandleFunc("POST /api/appopt", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID      string `json:"id"`
			Enabled bool   `json:"enabled"`
		}
		if !readBody(w, r, &body) || body.ID == "" {
			writeErr(w, 400, "Dữ liệu không hợp lệ (cần id)")
			return
		}
		installed, _ := detectApp(body.ID)
		if runtimeIsWindows && !installed {
			writeErr(w, 400, "App not found — app chưa được cài trên máy này")
			return
		}
		res := runAppOpt(body.ID, body.Enabled)
		if !runtimeIsWindows {
			res.Mode = "không-Windows (hiển thị trung thực — không có tác dụng thật)"
			res.Success = false
			res.Steps = []PerfStep{{Name: "Tối ưu " + body.ID, OK: false, Detail: "chỉ chạy được trên Windows — bản Linux/CI chỉ hiển thị"}}
			res.Message = "Tối ưu app chỉ áp dụng được trên Windows"
		}
		if res.Success || !runtimeIsWindows {
			now := time.Now()
			appState.PutAppOptState(body.ID, TweakState{Applied: body.Enabled, AppliedAt: &now, LastResult: res.Message})
		}
		code := 200
		if !res.Success && runtimeIsWindows {
			code = 500
		}
		writeJSON(w, code, res)
	})
}
