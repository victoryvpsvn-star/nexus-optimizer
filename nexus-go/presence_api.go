// presence_api.go — GET/POST /api/presence: trạng thái (GET), tracker section cho beacon
// (extension đọc qua /api/presence-beacon), cài extension/policy. Đường IPC Discord desktop
// đã bị loại bỏ — enable/disable chỉ trả thông điệp hướng dẫn dùng extension.
package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

type presenceCfg struct {
	Enabled      bool   `json:"enabled"`
	AppID        string `json:"appId"`
	PolicyEnabled bool  `json:"policyEnabled"`
	PolicyPort   int    `json:"policyPort"`
}

var pcfgMtx sync.Mutex

func presenceConfigPath() string {
	dir := os.Getenv("NEXUS_DATA_DIR")
	if dir == "" {
		dir = "."
	}
	return filepath.Join(dir, "presence.json")
}

func presenceCfgLoad() presenceCfg {
	pcfgMtx.Lock()
	defer pcfgMtx.Unlock()
	var c presenceCfg
	b, err := os.ReadFile(presenceConfigPath())
	if err == nil && json.Unmarshal(b, &c) == nil {
		if c.AppID == "" {
			c.AppID = presenceDefaultAppID
		}
		return c
	}
	return presenceCfg{Enabled: false, AppID: presenceDefaultAppID}
}

func presenceCfgSave(c presenceCfg) error {
	pcfgMtx.Lock()
	defer pcfgMtx.Unlock()
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return pfWriteFile(presenceConfigPath(), b, 0o600)
}

func handlePresence(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		c := presenceCfgLoad()
		en, conn, appID, section, note := presenceStatus()
		if appID == "" {
			appID = c.AppID
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled": en && c.Enabled, "connected": conn, "appId": appID,
			"section": section, "note": note, "dir": presenceDirLabel(),
			"policy": map[string]any{"enabled": c.PolicyEnabled, "port": c.PolicyPort, "updateUrl": extUpdateURL(), "source": extSourcePattern(), "extId": extCacheID},
		})
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Action  string `json:"action"`
		AppID   string `json:"appId"`
		Section string `json:"section"`
		Note    string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"success": false, "message": "body JSON sai"})
		return
	}
	switch req.Action {
	case "enable":
		// Đường IPC Discord desktop đã bị LOẠI BỎ khỏi tool — status chỉ qua extension.
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "Đã bỏ đường Discord desktop. Discord status giờ do extension Cat Status đảm nhiệm: bấm '🛡️ Cài kiểu Kaspersky' → restart Chrome → mở popup extension → Đăng nhập → Bật."})
	case "disable":
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "Đường Discord desktop đã bị loại bỏ khỏi tool — không còn gì để tắt."})
	case "section":
		presenceSet(req.Section, req.Note) // luôn nhận — beacon trả section cho extension
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
	case "install-policy":
		msg, err := extPolicyInstall()
		writeJSON(w, http.StatusOK, map[string]any{"success": err == nil, "message": msg, "error": errStr(err), "extId": extCacheID})
	case "remove-policy":
		msg, err := extPolicyRemove()
		writeJSON(w, http.StatusOK, map[string]any{"success": err == nil, "message": msg, "error": errStr(err)})
	case "install-extension":
		path, guide := presenceInstallExtension()
		writeJSON(w, http.StatusOK, map[string]any{"success": path != "", "path": path, "message": guide})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"success": false, "message": "action không hợp lệ"})
	}
}

/** pfWriteFile: ghi file qua tmp + rename (atomic) */
func pfWriteFile(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func errStr(e error) string {
	if e == nil {
		return ""
	}
	return e.Error()
}
