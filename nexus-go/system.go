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
	"unicode/utf16"
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

/** Export mọi key registry mà catalog đụng tới thành 1 file .reg (merge được bằng reg import).
 * v3.9.0 (theo audit P0-02): KHÔNG tự parse `reg query` nữa — export mỗi key bằng
 * `reg export <key> <file> /y` thật rồi ghép nguyên văn phần section (giữ cả hex multi-line)
 * vào 1 file; không có value nào → báo thất bại thay vì khoe thành công. */
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
	exported, totalValues := 0, 0
	var missing []string
	for _, k := range backupKeys {
		tmp, err := os.CreateTemp("", "nexus-regexport-*.reg")
		if err != nil {
			return BackupLocal{}, "Không tạo được file tạm: " + err.Error(), false
		}
		tmpName := tmp.Name()
		tmp.Close()
		os.Remove(tmpName) // reg export tự tạo file mới
		r := runExe(reg, []string{"export", k, tmpName, "/y"}, 15*time.Second)
		if !r.OK {
			os.Remove(tmpName)
			missing = append(missing, k) // key không tồn tại trên máy — bỏ qua trung thực
			continue
		}
		data, err := os.ReadFile(tmpName)
		os.Remove(tmpName)
		if err != nil {
			missing = append(missing, k)
			continue
		}
		s := decodeRegExport(data) // reg.exe export ghi UTF-16LE — decode về UTF-8
		idx := strings.Index(s, "[")
		if idx < 0 { // file không có section nào — bỏ qua
			missing = append(missing, k)
			continue
		}
		body := s[idx:]
		nv := 0
		for _, ln := range strings.Split(body, "\n") {
			t := strings.TrimSpace(ln)
			if strings.HasPrefix(t, "\"") || strings.HasPrefix(t, "@=") {
				nv++
			}
		}
		b.WriteString(strings.TrimLeft(body, "\r\n"))
		if !strings.HasSuffix(body, "\n") {
			b.WriteString("\r\n")
		}
		b.WriteString("\r\n")
		exported++
		totalValues += nv
	}
	if exported == 0 {
		return BackupLocal{}, "Không export được key nào (key không tồn tại trên máy): " + strings.Join(missing, "; "), false
	}
	if totalValues == 0 {
		// audit P0-02: backup không chứa value nào thì không có gì để khôi phục — KHÔNG ghi file rỗng
		return BackupLocal{}, fmt.Sprintf("Export có %d key nhưng 0 value — dừng, không ghi backup rỗng", exported), false
	}
	if err := os.WriteFile(out, []byte(b.String()), filePerm()); err != nil {
		return BackupLocal{}, "Không ghi được file backup: " + err.Error(), false
	}
	st, _ := os.Stat(out)
	rec := BackupLocal{
		ID:        int(time.Now().UnixNano() % 1000000),
		Name:      filepath.Base(out),
		SizeBytes: st.Size(),
		CreatedAt: time.Now().Format(time.RFC3339),
	}
	appState.AddCleanupLog("backup", rec.Name, rec.SizeBytes, true,
		fmt.Sprintf("Backup %d key registry (%d value) bằng reg export thật — bỏ qua %d key không tồn tại", exported, totalValues, len(missing)))
	return rec, fmt.Sprintf("Đã backup %d key registry (%d value) → %s", exported, totalValues, rec.Name), true
}

/** v3.9.0 (theo audit P0-02): khôi phục file backup .reg bằng reg import — cần admin. */
func restoreRegistryBackup(name string) (bool, string) {
	if !runtimeIsWindows {
		return false, "Khôi phục registry chỉ chạy được trên Windows"
	}
	if !safeBackupName(name) {
		return false, "Tên backup không hợp lệ"
	}
	found := false
	for _, bk := range listRegistryBackups() {
		if bk.Name == name {
			found = true
			break
		}
	}
	if !found {
		return false, "Không tìm thấy file backup: " + name
	}
	if _, ok := adminGate(); !ok {
		m, _ := adminGate()
		return false, m
	}
	reg := findSysExe("reg.exe")
	if reg == "" {
		return false, noRegExeMsg
	}
	p := filepath.Join(backupDir(), name)
	r := runExe(reg, []string{"import", p}, 30*time.Second)
	if !r.OK {
		return false, firstLine(r.Stdout + r.Stderr)
	}
	appState.AddCleanupLog("backup", name, 0, true, "Đã khôi phục registry từ "+name)
	return true, "Đã import " + name + " về Registry — giá trị trong backup đã ghi đè trạng thái hiện tại"
}

/** Chỉ nhận tên backup an toàn (chặn path traversal) */
func safeBackupName(name string) bool {
	if !strings.HasSuffix(name, ".reg") || len(name) > 200 || strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, ".") {
		return false
	}
	for _, c := range name {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}

/** decode file reg.exe export: UTF-16LE (mặc định) hoặc UTF-8 với BOM */
func decodeRegExport(b []byte) string {
	if len(b) >= 2 && b[0] == 0xFF && b[1] == 0xFE { // BOM UTF-16LE
		u := make([]uint16, 0, (len(b)-2)/2)
		for i := 2; i+1 < len(b); i += 2 {
			u = append(u, uint16(b[i])|uint16(b[i+1])<<8)
		}
		return string(utf16.Decode(u))
	}
	s := string(b)
	return strings.TrimPrefix(s, "\xef\xbb\xbf")
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
