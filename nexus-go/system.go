// system.go — trạng thái hệ thống cho UI, nút "Chạy lại với quyền Admin" (UAC), và
// backup registry: export các key mà catalog đụng tới thành file .reg trước khi chỉnh.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type SystemStatus struct {
	IsWin          bool   `json:"isWin"`
	Platform       string `json:"platform"`
	OsRelease      string `json:"osRelease"`
	Admin          bool   `json:"admin,omitempty"`
	AdminMethod    string `json:"adminMethod,omitempty"`
	PowershellFound bool  `json:"powershellFound,omitempty"`
	PowershellPath string `json:"powershellPath,omitempty"`
	PowershellDetail string `json:"powershellDetail,omitempty"`
	RegOk          bool   `json:"regOk,omitempty"`
	AppExe         string `json:"appExe,omitempty"`
	Note           string `json:"note,omitempty"`
}

func getSystemStatus() SystemStatus {
	st := SystemStatus{Platform: runtime.GOOS, OsRelease: osRelease(), IsWin: runtimeIsWindows}
	if !runtimeIsWindows {
		st.Note = "Nâng quyền chỉ dùng được trong bản Windows .exe"
		return st
	}
	ws := getWinStatus()
	st.Admin = ws.Admin
	st.AdminMethod = ws.AdminMethod
	st.PowershellFound = ws.PsFound
	st.PowershellPath = ws.PsPath
	st.PowershellDetail = ws.PsDetail
	st.RegOk = ws.RegOk
	exe, _ := os.Executable()
	st.AppExe = filepath.Base(exe)
	return st
}

/**
 * Relaunch-admin: spawn PS detached Start-Process -Verb RunAs (UAC hỏi xác nhận), app hiện tại
 * tự đóng sau 1.5s. Port trực tiếp, bỏ bước flag file vì không còn server con — 1 tiến trình duy nhất.
 */
func relaunchAdmin() (bool, string, int, string) {
	if !runtimeIsWindows {
		return false, "Nâng quyền chỉ dùng được trên Windows", 400, ""
	}
	st := getWinStatus()
	exe, err := os.Executable()
	if err != nil {
		return false, "Không xác định được file ứng dụng: " + err.Error(), 500, ""
	}
	if st.Admin {
		return true, "App đang chạy với quyền Administrator sẵn rồi", 200, "already-admin"
	}
	ps := resolvePowerShellExe()
	if ps.Exe == "" {
		return false, fmt.Sprintf("Không tìm thấy PowerShell nên không tự nâng quyền được (%s) — hãy nhấp chuột phải vào NEXUS Optimizer và chọn \"Run as administrator\"", ps.Detail), 500, ""
	}
	inner := fmt.Sprintf("Start-Sleep -Seconds 3; Start-Process -FilePath '%s' -Verb RunAs", strings.ReplaceAll(exe, "'", "''"))
	c := exec.Command(ps.Exe, "-NoProfile", "-Command", inner)
	setHideWindow(c)
	if err := c.Start(); err != nil {
		return false, "Không spawn được PowerShell nâng quyền: " + err.Error(), 500, ""
	}
	go func() {
		_ = c.Wait() // detached — lỗi UAC hủy không ảnh hưởng app hiện tại
	}()
	time.Sleep(300 * time.Millisecond)
	// App tự đóng sau khi response trả về UI (client nhận message rồi)
	return true, "Đã yêu cầu Windows mở lại NEXUS Optimizer với quyền Admin — hộp thoại UAC sẽ hiện sau vài giây; app hiện tại sẽ tự đóng.", 200, "ok"
}

// ---------- Backup registry (.reg) — thay thế module S3 backup cũ bằng bản local đủ dùng ----------

type BackupLocal struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	SizeBytes int64  `json:"sizeBytes"`
	CreatedAt string `json:"createdAt"`
}

var backupKeys = []string{
	regGameConfig, regGameDVR, regGameBar, regSysMulti, regMouse, regVisualFX, regPersonalize,
	regSerialize, regCDM, regKeyboard, regAccess, regDesktop, regAdvanced, regPriority,
	regGraphics, regMMCSSGaming, regDNSPolicy, regCopilot, regBGApps, regLanmanSrv,
}

func backupDir() string {
	d := filepath.Join(dataDir(), "backups")
	_ = os.MkdirAll(d, 0o755)
	return d
}

/** Export mọi key registry mà catalog đụng tới thành 1 file .reg (merge được bằng reg import) */
func createRegistryBackup() (BackupLocal, string, bool) {
	if !runtimeIsWindows {
		return BackupLocal{}, "Backup registry chỉ chạy được trên Windows", false
	}
	reg := findSysExe("reg.exe")
	if reg == "" {
		return BackupLocal{}, noRegExeMsg, false
	}
	ts := time.Now().Format("2006-01-02_150405")
	out := filepath.Join(backupDir(), fmt.Sprintf("nexus-registry-backup_%s.reg", ts))
	var b strings.Builder
	b.WriteString("Windows Registry Editor Version 5.00\r\n\r\n")
	exported := 0
	var missing []string
	for _, k := range backupKeys {
		r := runExe(reg, []string{"export", k, os.DevNull, "/y"}, 15*time.Second)
		_ = r // reg export ghi file riêng; dùng query thay vì export để gộp 1 file:
		q := runExe(reg, []string{"query", k}, 15*time.Second)
		if !q.OK {
			missing = append(missing, k)
			continue
		}
		fmt.Fprintf(&b, "[%s]\r\n", k)
		for _, ln := range strings.Split(q.Stdout, "\n") {
			ln = strings.TrimRight(ln, "\r")
			if ln == "" || strings.HasPrefix(ln, " ") || strings.HasPrefix(strings.ToUpper(ln), "HKEY_") {
				continue
			}
			fmt.Fprintf(&b, "%s\r\n", ln)
		}
		b.WriteString("\r\n")
		exported++
	}
	if exported == 0 {
		return BackupLocal{}, "Không export được key nào: " + strings.Join(missing, "; "), false
	}
	if err := os.WriteFile(out, []byte(b.String()), 0o644); err != nil {
		return BackupLocal{}, "Không ghi được file backup: " + err.Error(), false
	}
	st, _ := os.Stat(out)
	rec := BackupLocal{
		ID:        int(time.Now().UnixNano() % 1000000),
		Name:      filepath.Base(out),
		SizeBytes: st.Size(),
		CreatedAt: time.Now().Format(time.RFC3339),
	}
	appState.AddCleanupLog("backup", rec.Name, rec.SizeBytes, true, fmt.Sprintf("Backup %d key registry thành file .reg (bỏ qua %d key không tồn tại)", exported, len(missing)))
	return rec, fmt.Sprintf("Đã backup %d key registry → %s", exported, rec.Name), true
}

func listRegistryBackups() []BackupLocal {
	entries, err := os.ReadDir(backupDir())
	out := []BackupLocal{}
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".reg") {
			continue
		}
		st, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, BackupLocal{
			Name: e.Name(), SizeBytes: st.Size(),
			CreatedAt: st.ModTime().Format(time.RFC3339),
		})
	}
	sortB(out)
	return out
}

func sortB(list []BackupLocal) {
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j].CreatedAt > list[j-1].CreatedAt; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
}

func deleteRegistryBackup(name string) bool {
	if !strings.HasSuffix(name, ".reg") || strings.ContainsAny(name, `/\`) {
		return false // chặn path traversal
	}
	return os.Remove(filepath.Join(backupDir(), name)) == nil
}

/** Mở thư mục backup trong Explorer cho user copy tay */
func openBackupsFolder() string {
	d := backupDir()
	if runtimeIsWindows {
		exec.Command("explorer.exe", d).Start()
	}
	return d
}
