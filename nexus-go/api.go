// api.go — router HTTP: toàn bộ JSON API (cùng đường dẫn với bản cũ để UI quen thuộc)
// + UI tĩnh nhúng trong exe (go:embed). Chỉ lắng nghe 127.0.0.1 — không lộ ra LAN.
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

//go:embed static
var staticFS embed.FS

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

/** Đọc body JSON an toàn (giới hạn 20MB cho screenshot) */
func readBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 20*1024*1024)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		writeErr(w, 400, "Dữ liệu không hợp lệ")
		return false
	}
	return true
}

func buildMux() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/presence", handlePresence)
	mux.HandleFunc("POST /api/presence", handlePresence)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "version": AppVersion, "platform": runtime.GOOS})
	})

	// ---------- Stats ----------
	mux.HandleFunc("GET /api/stats", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, getStats())
	})

	// ---------- Tweaks ----------
	mux.HandleFunc("GET /api/tweaks", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"tweaks": getTweaks()})
	})
	mux.HandleFunc("POST /api/tweaks", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			IDs    []string `json:"ids"`
			Action string   `json:"action"`
		}
		if !readBody(w, r, &body) {
			return
		}
		if len(body.IDs) == 0 || (body.Action != "apply" && body.Action != "revert") {
			writeErr(w, 400, "Yêu cầu không hợp lệ (cần ids[], action)")
			return
		}
		if len(body.IDs) > 50 {
			writeErr(w, 400, "Tối đa 50 tinh chỉnh mỗi lần chạy")
			return
		}
		results := make([]TweakRunResult, 0, len(body.IDs))
		for _, id := range body.IDs {
			if body.Action == "apply" {
				results = append(results, applyTweakById(id))
			} else {
				results = append(results, revertTweakById(id))
			}
		}
		writeJSON(w, 200, map[string]any{"results": results})
	})

	// ---------- Cleanup ----------
	mux.HandleFunc("GET /api/cleanup", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, scanTargets())
	})
	mux.HandleFunc("POST /api/cleanup", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Action string `json:"action"`
		}
		if !readBody(w, r, &body) {
			return
		}
		if body.Action != "disk" && body.Action != "ram" && body.Action != "all" {
			writeErr(w, 400, "Hành động không hợp lệ — chỉ nhận \"disk\", \"ram\" hoặc \"all\".")
			return
		}
		writeJSON(w, 200, runCleanup(body.Action))
	})

	// ---------- Gaming ----------
	mux.HandleFunc("GET /api/gaming", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, getGamingStatus())
	})
	mux.HandleFunc("POST /api/gaming", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Enabled *bool `json:"enabled"`
		}
		if !readBody(w, r, &body) || body.Enabled == nil {
			writeErr(w, 400, "Dữ liệu không hợp lệ (cần enabled: boolean)")
			return
		}
		effects := setGaming(*body.Enabled)
		writeJSON(w, 200, map[string]any{"enabled": *body.Enabled, "effects": effects})
	})

	// ---------- Processes ----------
	mux.HandleFunc("GET /api/processes", func(w http.ResponseWriter, r *http.Request) {
		list, err := listProcesses()
		if err != nil {
			writeErr(w, 500, "Không đọc được danh sách tiến trình")
			return
		}
		writeJSON(w, 200, ProcListResponse{List: list})
	})
	mux.HandleFunc("DELETE /api/processes", func(w http.ResponseWriter, r *http.Request) {
		pid := 0
		if _, err := fmt.Sscanf(r.URL.Query().Get("pid"), "%d", &pid); err != nil || pid <= 0 {
			writeJSON(w, 400, map[string]any{"success": false, "message": "PID không hợp lệ"})
			return
		}
		if pid == osProcPID() {
			writeJSON(w, 400, map[string]any{"success": false, "message": "Không thể kết thúc chính app NEXUS từ trong app"})
			return
		}
		ok, msg := killProcess(pid)
		writeJSON(w, 200, map[string]any{"success": ok, "message": msg})
	})

	// ---------- Network ----------
	mux.HandleFunc("GET /api/network", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, getNetwork())
	})

	// ---------- Selftest ----------
	mux.HandleFunc("GET /api/selftest", func(w http.ResponseWriter, r *http.Request) {
		tw := getTweaks()
		rec, applied := 0, 0
		for _, t := range tw {
			if t.Recommended {
				rec++
			}
			if t.Applied {
				applied++
			}
		}
		var runtimeMap map[string]any
		if runtimeIsWindows {
			st := getWinStatus()
			runtimeMap = map[string]any{
				"isWin": true, "powershellFound": st.PsFound, "powershellPath": st.PsPath,
				"powershellDetail": st.PsDetail, "admin": st.Admin, "adminMethod": st.AdminMethod, "regOk": st.RegOk,
			}
		} else {
			runtimeMap = map[string]any{
				"isWin": false, "platform": runtime.GOOS,
				"note": "App đang chạy ngoài Windows — các tinh chỉnh Windows chỉ chạy được trong bản .exe",
			}
		}
		url := appState.GetWebhookURL()
		writeJSON(w, 200, map[string]any{
			"runtime": runtimeMap,
			"catalog": map[string]any{"total": len(tw), "recommended": rec, "applied": applied},
			"webhook": map[string]any{"configured": url != "", "masked": maskWebhook(url)},
		})
	})
	mux.HandleFunc("PUT /api/selftest", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WebhookURL string `json:"webhookUrl"`
		}
		if !readBody(w, r, &body) {
			return
		}
		if len(body.WebhookURL) > 500 {
			writeErr(w, 400, "Cần trường webhookUrl (string ≤500)")
			return
		}
		url := strings.TrimSpace(body.WebhookURL)
		if url != "" && !isValidWebhook(url) {
			writeErr(w, 400, "URL webhook không hợp lệ — chỉ chấp nhận https://discord.com/api/webhooks/…")
			return
		}
		appState.SetWebhookURL(url)
		writeJSON(w, 200, map[string]any{
			"ok": true,
			"webhook": map[string]any{"configured": url != "", "masked": maskWebhook(url)},
		})
	})
	mux.HandleFunc("POST /api/selftest", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Mode    string `json:"mode"`
			Webhook bool   `json:"webhook"`
		}
		if !readBody(w, r, &body) {
			return
		}
		if body.Mode != "check" && body.Mode != "full" {
			writeErr(w, 400, "Cần trường mode: check|full")
			return
		}
		report := runSelftest(body.Mode, body.Webhook)
		writeJSON(w, 200, map[string]any{"report": report})
	})

	// ---------- Settings (UISettings) ----------
	mux.HandleFunc("GET /api/settings", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, appState.GetSettings())
	})
	mux.HandleFunc("PUT /api/settings", func(w http.ResponseWriter, r *http.Request) {
		var s UISettings
		if !readBody(w, r, &s) {
			return
		}
		if err := appState.ValidateSettings(s); err != nil {
			writeErr(w, 400, "Cài đặt không hợp lệ: "+err.Error())
			return
		}
		appState.PutSettings(s)
		writeJSON(w, 200, appState.GetSettings())
	})

	// ---------- System ----------
	mux.HandleFunc("GET /api/system", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, getSystemStatus())
	})
	mux.HandleFunc("POST /api/system", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Action string `json:"action"`
		}
		if !readBody(w, r, &body) {
			return
		}
		if body.Action != "relaunch-admin" {
			writeErr(w, 400, "Cần { action: \"relaunch-admin\" }")
			return
		}
		ok, msg, status, _ := relaunchAdmin()
		if !ok {
			writeErr(w, status, msg)
			return
		}
		if status == 200 && strings.Contains(msg, "sẵn rồi") {
			writeJSON(w, 200, map[string]any{"alreadyAdmin": true, "message": msg})
			return
		}
		// Đóng app sau 1.5s để response kịp tới UI (giống hành vi bản cũ)
		if runtimeIsWindows {
			go func() {
				time.Sleep(1500 * time.Millisecond)
				appState.Save()
				os.Exit(0)
			}()
		}
		writeJSON(w, 200, map[string]any{"ok": true, "message": msg})
	})

	// ---------- Script nâng cao ----------
	mux.HandleFunc("GET /api/script", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"scripts":    appState.ListScripts(),
			"languages":  supportedLanguages(),
			"maxCode":    maxCodeChars,
			"maxTimeout": maxTimeoutMs,
		})
	})
	mux.HandleFunc("POST /api/script", func(w http.ResponseWriter, r *http.Request) {
		var rec ScriptRecord
		if !readBody(w, r, &rec) {
			return
		}
		if rec.Name == "" || len(rec.Name) > 120 || !scriptLangs[rec.Language] {
			writeErr(w, 400, "Cần name (≤120) + language hợp lệ: "+strings.Join(supportedLanguages(), ", "))
			return
		}
		saved := appState.UpsertScript(rec)
		writeJSON(w, 200, map[string]any{"script": saved})
	})
	mux.HandleFunc("PUT /api/script", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID        int    `json:"id"`
			Name      string `json:"name"`
			Language  string `json:"language"`
			Code      string `json:"code"`
			TimeoutMs int64  `json:"timeoutMs"`
			Run       bool   `json:"run"`
		}
		if !readBody(w, r, &body) {
			return
		}
		if body.Run {
			// chạy trực tiếp code gửi lên (không cần lưu)
			res := runScriptCode(body.Language, body.Code, body.TimeoutMs)
			writeJSON(w, 200, res)
			return
		}
		if body.ID <= 0 {
			writeErr(w, 400, "Cần id script cần cập nhật")
			return
		}
		rec := ScriptRecord{ID: body.ID, Name: body.Name, Language: body.Language, Code: body.Code}
		saved := appState.UpsertScript(rec)
		writeJSON(w, 200, map[string]any{"script": saved})
	})
	mux.HandleFunc("DELETE /api/script", func(w http.ResponseWriter, r *http.Request) {
		id := 0
		fmt.Sscanf(r.URL.Query().Get("id"), "%d", &id)
		if !appState.DeleteScript(id) {
			writeErr(w, 404, "Không tìm thấy script")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	})

	// ---------- Screenshot ----------
	mux.HandleFunc("GET /api/screenshot", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"shots": listScreenshots()})
	})
	mux.HandleFunc("POST /api/screenshot", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Data string `json:"data"`
		}
		if !readBody(w, r, &body) {
			return
		}
		info, msg, ok := saveScreenshot(body.Data)
		if !ok {
			status := 400
			if strings.Contains(msg, "quá lớn") || strings.Contains(msg, "quá nặng") {
				status = 413
			}
			writeErr(w, status, msg)
			return
		}
		writeJSON(w, 200, info)
	})
	mux.HandleFunc("DELETE /api/screenshot", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("file")
		if !deleteScreenshot(name) {
			writeErr(w, 404, "Không tìm thấy ảnh")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	})

	// ---------- Backup registry ----------
	mux.HandleFunc("GET /api/backup", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"local": listRegistryBackups()})
	})
	mux.HandleFunc("POST /api/backup", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Action string `json:"action"`
		}
		if !readBody(w, r, &body) || body.Action != "create" {
			writeErr(w, 400, "Cần { action: \"create\" }")
			return
		}
		rec, msg, ok := createRegistryBackup()
		if !ok {
			writeErr(w, 500, msg)
			return
		}
		writeJSON(w, 200, map[string]any{"backup": rec, "message": msg, "folder": backupDir()})
	})
	mux.HandleFunc("DELETE /api/backup", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		if !deleteRegistryBackup(name) {
			writeErr(w, 404, "Không tìm thấy backup")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("POST /api/backup/open", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"folder": openBackupsFolder()})
	})

	// ---------- Static: UI nhúng + ảnh chụp ----------
	sub, _ := fs.Sub(staticFS, "static")
	fileServer := http.FileServer(http.FS(sub))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" && !strings.HasPrefix(r.URL.Path, "/index.html") {
			fileServer.ServeHTTP(w, r)
			return
		}
		b, err := staticFS.ReadFile("static/index.html")
		if err != nil {
			http.Error(w, "Thiếu UI", 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(b)
	})
	mux.HandleFunc("GET /shots/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/shots/")
		if strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, ".") || name == "" {
			http.Error(w, "Tên file không hợp lệ", 400)
			return
		}
		http.ServeFile(w, r, filepath.Join(shotsDir(), name))
	})

	return mux
}

func osProcPID() int { return os.Getpid() }
