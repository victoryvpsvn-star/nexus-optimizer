// exec.go — port từ src/lib/exec.ts: runner exe trực tiếp theo đường dẫn tuyệt đối
// (chống ENOENT khi PATH hỏng), psRun qua file .ps1 UTF-8 BOM, getWinStatus (admin probe
// qua ghi thử HKLM bằng reg.exe), adminGate — giữ nguyên hành vi và thông báo tiếng Việt.
package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const maxPSOutput = 400_000
const maxPSStderr = 60_000

type RunResult struct {
	OK     bool   `json:"-"`
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
	Code   int    `json:"code"`
}

func isWin() bool { return runtimeIsWindows }

/** Chạy 1 lệnh qua shell — dùng cho bash trên Linux; Windows hầu như không dùng */
func runCmd(cmdline string, timeout time.Duration) RunResult {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var cmd *exec.Cmd
	if runtimeIsWindows {
		cmd = exec.CommandContext(ctx, "cmd", "/C", cmdline)
	} else {
		cmd = exec.CommandContext(ctx, "bash", "-c", cmdline)
	}
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	r := RunResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if err == nil {
		r.OK = true
		return r
	}
	if ee, ok := err.(*exec.ExitError); ok {
		r.Code = ee.ExitCode()
		r.Stderr = strings.TrimSpace(stdout.String() + stderr.String())
		if r.Stderr == "" {
			r.Stderr = err.Error()
		}
		return r
	}
	r.Code = -1
	r.Stderr = err.Error()
	return r
}

// ---------- Resolver công cụ hệ thống Windows ----------

func winSysDir() string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = os.Getenv("windir")
	}
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "System32")
}

/** Tìm exe hệ thống theo đường dẫn tuyệt đối trong System32 (+Sysnative cho process 32-bit) */
func findSysExe(name string) string {
	if !runtimeIsWindows {
		return ""
	}
	cands := []string{
		filepath.Join(winSysDir(), name),
		filepath.Join(winSysDir(), "..", "Sysnative", name),
	}
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}

/** Spawn trực tiếp 1 exe bằng đường dẫn tuyệt đối — không shell, không PATH, không lo escape */
func runExe(exePath string, args []string, timeout time.Duration) RunResult {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, exePath, args...)
	setHideWindow(cmd)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	r := RunResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if err == nil {
		r.OK = true
		return r
	}
	if ee, ok := err.(*exec.ExitError); ok {
		r.Code = ee.ExitCode()
	} else {
		r.Code = -1
		if ctx.Err() == context.DeadlineExceeded {
			r.Stderr = strings.TrimSpace(r.Stderr + "\nQuá thời gian chờ (timeout)")
			r.Code = -4
			return r
		}
		r.Stderr = strings.TrimSpace(r.Stderr + "\nKhông gọi được " + exePath + ": file không tồn tại hoặc bị chặn (ENOENT)")
		return r
	}
	r.Stderr = strings.TrimSpace(r.Stderr)
	if len(r.Stderr) > maxPSStderr {
		r.Stderr = r.Stderr[:maxPSStderr]
	}
	return r
}

/** Chạy exe hệ thống theo TÊN: ưu tiên System32 tuyệt đối, fallback PATH, báo lỗi trung thực */
func runSysExe(name string, args []string, timeout time.Duration) RunResult {
	if abs := findSysExe(name); abs != "" {
		return runExe(abs, args, timeout)
	}
	r := runExe(name, args, timeout)
	if !r.OK && r.Code == -1 && strings.Contains(r.Stderr, "ENOENT") {
		return RunResult{
			Stderr: fmt.Sprintf("Không tìm thấy %s trong System32 và PATH — công cụ hệ thống bị thiếu/bị chặn", name),
			Code:   -1,
		}
	}
	return r
}

// ---------- PowerShell resolver ----------

type PsResolve struct {
	Exe    string
	Detail string
}

var psCache struct {
	mu   sync.Mutex
	val  PsResolve
	have bool
}

/** Tìm PowerShell theo ĐƯỜNG DẪN TUYỆT ĐỐI trước (System32 → PS7 → where.exe → PATH cuối) */
func resolvePowerShellExe() PsResolve {
	if !runtimeIsWindows {
		return PsResolve{Detail: "Không phải Windows"}
	}
	psCache.mu.Lock()
	defer psCache.mu.Unlock()
	if psCache.have {
		return psCache.val
	}
	if ov := os.Getenv("NEXUS_PS_OVERRIDE"); ov != "" {
		if st, err := os.Stat(ov); err == nil && !st.IsDir() {
			psCache.val = PsResolve{ov, "NEXUS_PS_OVERRIDE=" + ov}
			psCache.have = true
			return psCache.val
		}
	}
	progFiles := os.Getenv("ProgramFiles")
	if progFiles == "" {
		progFiles = `C:\Program Files`
	}
	cands := []PsResolve{
		{filepath.Join(winSysDir(), "WindowsPowerShell", "v1.0", "powershell.exe"), "Windows PowerShell 5.1 (System32)"},
		{filepath.Join(progFiles, "PowerShell", "7", "pwsh.exe"), "PowerShell 7 (Program Files)"},
	}
	for _, c := range cands {
		if st, err := os.Stat(c.Exe); err == nil && !st.IsDir() {
			psCache.val = c
			psCache.have = true
			return psCache.val
		}
	}
	if where := findSysExe("where.exe"); where != "" {
		for _, name := range []string{"pwsh.exe", "powershell.exe"} {
			r := runExe(where, []string{name}, 8*time.Second)
			first := ""
			for _, ln := range strings.Split(r.Stdout, "\n") {
				ln = strings.TrimSpace(ln)
				if ln != "" {
					first = ln
					break
				}
			}
			if r.OK && first != "" {
				psCache.val = PsResolve{first, "tìm thấy qua where.exe: " + first}
				psCache.have = true
				return psCache.val
			}
		}
	}
	psCache.val = PsResolve{
		Exe:    "powershell.exe",
		Detail: "Không tìm thấy PowerShell theo đường dẫn chuẩn (System32\\WindowsPowerShell\\v1.0 + PowerShell 7). Windows có thể đã bị rút gọn PowerShell — chỉ còn phương án tra PATH, có nguy cơ ENOENT.",
	}
	psCache.have = true
	return psCache.val
}

/**
 * Chạy script PowerShell qua file .ps1 tạm (UTF-8 + BOM) — PS 5.1 đọc stdin theo OEM codepage
 * nên đường dẫn tiếng Việt có dấu bị lỗi font; file BOM đọc đúng 100%. Prologue đặt
 * OutputEncoding UTF8. Exit code khác 0 = thất bại. Không phải Windows → thất bại trung thực.
 */
func psRun(script string, timeout time.Duration) RunResult {
	if !runtimeIsWindows {
		return RunResult{Stderr: "PowerShell chỉ khả dụng trên Windows", Code: -3}
	}
	resolved := resolvePowerShellExe()
	if resolved.Exe == "" {
		return RunResult{Stderr: "Không tìm thấy PowerShell trên máy này (" + resolved.Detail + ")", Code: -7}
	}
	f, err := os.CreateTemp("", "nexus-ps-*.ps1")
	if err != nil {
		return RunResult{Stderr: "Không ghi được file PS tạm: " + err.Error(), Code: -6}
	}
	psFile := f.Name()
	defer os.Remove(psFile)
	prologue := "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n"
	if _, err := f.WriteString("\uFEFF" + prologue + script); err != nil {
		f.Close()
		return RunResult{Stderr: "Không ghi được file PS tạm: " + err.Error(), Code: -6}
	}
	f.Close()

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, resolved.Exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psFile)
	setHideWindow(cmd)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	r := RunResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if len(r.Stdout) > maxPSOutput {
		r.Stdout = r.Stdout[:maxPSOutput]
	}
	if err == nil {
		r.OK = true
		return r
	}
	if ee, ok := err.(*exec.ExitError); ok {
		r.Code = ee.ExitCode()
	} else {
		r.Code = -1
		if ctx.Err() == context.DeadlineExceeded {
			r.Code = -4
			r.Stderr = strings.TrimSpace(r.Stderr + "\nQuá thời gian chờ (timeout)")
			return r
		}
		r.Stderr = strings.TrimSpace(r.Stderr + "\nKhông gọi được PowerShell (" + resolved.Exe + "): file không tồn tại hoặc bị chặn (ENOENT)")
		return r
	}
	r.Stderr = strings.TrimSpace(r.Stderr)
	if len(r.Stderr) > maxPSStderr {
		r.Stderr = r.Stderr[:maxPSStderr]
	}
	return r
}

// ---------- Trạng thái runtime Windows ----------

type WinRuntimeStatus struct {
	IsWin       bool   `json:"isWin"`
	PsFound     bool   `json:"psFound"`
	PsPath      string `json:"powershellPath,omitempty"`
	PsDetail    string `json:"powershellDetail"`
	Admin       bool   `json:"admin"`
	AdminMethod string `json:"adminMethod"`
	RegOk       bool   `json:"regOk"`
}

var statusCache struct {
	mu   sync.Mutex
	val  WinRuntimeStatus
	at   time.Time
	have bool
}

const statusTTL = 15 * time.Second

/**
 * Trạng thái runtime: quyền Admin kiểm tra bằng GHI THỬ HKLM qua reg.exe (không phụ thuộc
 * PowerShell) — hết báo nhầm "Cần Admin" khi thực ra là lỗi spawn PS. Cache 15s.
 */
func getWinStatus() WinRuntimeStatus {
	if !runtimeIsWindows {
		return WinRuntimeStatus{IsWin: false, PsDetail: "Không phải Windows", AdminMethod: "not-windows"}
	}
	statusCache.mu.Lock()
	defer statusCache.mu.Unlock()
	if statusCache.have && time.Since(statusCache.at) < statusTTL {
		return statusCache.val
	}
	ps := resolvePowerShellExe()
	reg := findSysExe("reg.exe")
	regOk := reg != ""
	admin := false
	method := "unknown"
	if reg != "" {
		w := runExe(reg, []string{"add", `HKLM\SOFTWARE\NexusOptimizer`, "/v", "AdminProbe", "/t", "REG_DWORD", "/d", "1", "/f"}, 8*time.Second)
		if w.OK {
			admin = true
			method = "hklm-write"
			_ = runExe(reg, []string{"delete", `HKLM\SOFTWARE\NexusOptimizer`, "/v", "AdminProbe", "/f"}, 8*time.Second)
		}
	}
	if !admin && ps.Exe != "" && ps.Exe != "powershell.exe" {
		r := psRun("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator).ToString()", 8*time.Second)
		if r.OK {
			admin = strings.Contains(strings.ToLower(r.Stdout), "true")
			method = "ps-isinrole"
		}
	}
	statusCache.val = WinRuntimeStatus{
		IsWin: true, PsFound: ps.Exe != "", PsPath: ps.Exe, PsDetail: ps.Detail,
		Admin: admin, AdminMethod: method, RegOk: regOk,
	}
	statusCache.at = time.Now()
	statusCache.have = true
	return statusCache.val
}

var adminFailMsg = "Cần quyền Administrator — hãy chạy NEXUS Optimizer với quyền Admin (hoặc bấm nút \"Chạy lại với quyền Admin\" trong tab Tự kiểm tra)"

/** Cổng quyền Administrator cho các mục requiresRoot: chặn TRƯỚC khi chạy lệnh nào */
func adminGate() (string, bool) {
	st := getWinStatus()
	if st.Admin {
		return "", true
	}
	if !st.RegOk && !st.PsFound {
		return truncateShort(fmt.Sprintf("Không kiểm tra được quyền Administrator (thiếu cả reg.exe và PowerShell: %s) — %s", st.PsDetail, adminFailMsg)), false
	}
	return adminFailMsg, false
}

// ---------- helpers dùng chung ----------

var wsRe = regexp.MustCompile(`\s+`)

func truncateShort(msg string) string {
	clean := strings.TrimSpace(wsRe.ReplaceAllString(msg, " "))
	if len(clean) > 220 {
		return clean[:219] + "…"
	}
	return clean
}
