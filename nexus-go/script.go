// script.go — Script nâng cao (chạy code tùy chỉnh) + Ảnh chụp (port từ scripts.ts, screenshot route).
package main

import (
	"sort"
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ---------- Script runner ----------

const maxOutputChars = 60000
const maxCodeChars = 20000
const defaultTimeoutMs = 90_000
const maxTimeoutMs = 180_000

func supportedLanguages() []string {
	if runtimeIsWindows {
		return []string{"powershell"}
	}
	return []string{"bash", "python"}
}

var scriptLangs = map[string]bool{"bash": true, "python": true, "powershell": true}

type ScriptRunResponse struct {
	Success    bool   `json:"success"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	Output     string `json:"output"`
	TimedOut   bool   `json:"timedOut,omitempty"`
	Message    string `json:"message,omitempty"`
}

// cappedWriter — v3.9.0 (theo audit P1-06): giới hạn output trong lúc đọc (không chờ
// process xong mới cắt); sau khi đủ cap vẫn tiêu thụ + vứt để pipe không block tiến trình con.
type cappedWriter struct {
	sb   strings.Builder
	over bool
}

func (c *cappedWriter) Write(p []byte) (int, error) {
	if !c.over {
		remain := maxOutputChars - c.sb.Len()
		if remain > 0 {
			n := remain
			if len(p) < n {
				n = len(p)
			}
			c.sb.Write(p[:n])
		}
		if c.sb.Len() >= maxOutputChars {
			c.over = true
		}
	}
	return len(p), nil // giả vờ ghi hết — process con không bao giờ block vì output
}

/** Chạy code tùy chỉnh — PowerShell (Windows) / bash, python (khác). Giới hạn size + timeout.
 * v3.9.0 (theo audit P1-04): exec.CommandContext — hết deadline là tiến trình bị hủy thật;
 * Windows kill thêm cả cây bằng taskkill /T vì CommandContext chỉ giết tiến trình cha. */
func runScriptCode(language, code string, timeoutMs int64) ScriptRunResponse {
	res := ScriptRunResponse{}
	if !scriptLangs[language] {
		res.Message = fmt.Sprintf("Ngôn ngữ không hỗ trợ — máy này chỉ chạy: %s", strings.Join(supportedLanguages(), ", "))
		return res
	}
	if len(code) > maxCodeChars {
		res.Message = fmt.Sprintf("Code quá dài (tối đa %d ký tự)", maxCodeChars)
		return res
	}
	if timeoutMs <= 0 {
		timeoutMs = defaultTimeoutMs
	}
	if timeoutMs > maxTimeoutMs {
		timeoutMs = maxTimeoutMs
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	var cmd *exec.Cmd
	if language == "powershell" {
		if !runtimeIsWindows {
			res.Message = "PowerShell chỉ chạy được trên Windows"
			return res
		}
		ps := resolvePowerShellExe()
		if ps.Exe == "" {
			res.Message = "Không tìm thấy PowerShell: " + ps.Detail
			return res
		}
		f, err := os.CreateTemp("", "nexus-script-*.ps1")
		if err != nil {
			res.Message = "Không ghi được file tạm: " + err.Error()
			return res
		}
		f.WriteString("\uFEFF[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n" + code)
		f.Close()
		defer os.Remove(f.Name())
		cmd = exec.CommandContext(ctx, ps.Exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", f.Name())
	} else if language == "python" {
		cmd = exec.CommandContext(ctx, "python3", "-I", "-c", code)
		if _, err := exec.LookPath("python3"); err != nil {
			cmd = exec.CommandContext(ctx, "python", "-I", "-c", code)
		}
	} else {
		f, err := os.CreateTemp("", "nexus-script-*.sh")
		if err != nil {
			res.Message = "Không ghi được file tạm: " + err.Error()
			return res
		}
		f.WriteString(code)
		f.Close()
		os.Chmod(f.Name(), 0o700)
		defer os.Remove(f.Name())
		cmd = exec.CommandContext(ctx, "bash", f.Name())
	}
	setHideWindow(cmd)
	// v3.9.0: đổi tên biến môi trường — trước đây "NEXUS_SANDBOX=1" chỉ là biến, không cô lập gì
	// (audit P1-05). UI đã nói đúng "script chạy với quyền của app"; biến giờ mang tên trung thực.
	cmd.Env = append(os.Environ(), "NEXUS_SCRIPT_RUN=1", "NEXUS_NO_SANDBOX=1")
	cw := &cappedWriter{}
	cmd.Stdout = cw
	cmd.Stderr = cw
	// Kill cây tiến trình khi hết deadline (Windows: taskkill /T — giết cả con cháu)
	if runtimeIsWindows {
		done := make(chan struct{})
		defer close(done)
		go func() {
			select {
			case <-ctx.Done():
				if cmd.Process != nil {
					runSysExe("taskkill.exe", []string{"/F", "/T", "/PID", fmt.Sprint(cmd.Process.Pid)}, 8*time.Second)
				}
			case <-done:
			}
		}()
	}
	t0 := time.Now()
	err := cmd.Run()
	res.DurationMs = time.Since(t0).Milliseconds()
	res.Output = cw.sb.String()
	if cw.over {
		res.Output += "\n…(output cắt bớt tại " + fmt.Sprint(maxOutputChars) + " ký tự — phần sau bị vứt trong lúc chạy)"
	}
	if ctx.Err() == context.DeadlineExceeded {
		res.TimedOut = true
		res.Success = false
		res.Message = fmt.Sprintf("Script vượt thời gian chờ %dms — tiến trình (và cây con) đã bị kill", timeoutMs)
		return res
	}
	if ee, ok := err.(*exec.ExitError); ok {
		res.ExitCode = ee.ExitCode()
		res.Success = false
	} else if err != nil {
		res.ExitCode = -1
		res.Message = err.Error()
	} else {
		res.ExitCode = 0
		res.Success = true
	}
	return res
}

// ---------- Ảnh chụp ----------

type ScreenshotInfo struct {
	File      string `json:"file"`
	URL       string `json:"url"`
	CreatedAt string `json:"createdAt"`
	SizeBytes int64  `json:"sizeBytes"`
}

func shotsDir() string {
	d := filepath.Join(dataDir(), "screenshots")
	_ = os.MkdirAll(d, 0o755)
	return d
}

var b64DataRe = regexp.MustCompile(`^data:image/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\r\n]+)$`)

/** Lưu ảnh chụp (base64 data URL từ UI) — tối đa 15MB sau decode */
func saveScreenshot(dataURL string) (ScreenshotInfo, string, bool) {
	m := b64DataRe.FindStringSubmatch(strings.TrimSpace(dataURL))
	if m == nil {
		return ScreenshotInfo{}, "Dữ liệu ảnh không hợp lệ (cần data:image/png;base64,…)", false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.NewReplacer("\r", "", "\n", "").Replace(m[2]))
	if err != nil {
		return ScreenshotInfo{}, "Base64 không giải mã được: " + err.Error(), false
	}
	if len(raw) > 15*1024*1024 {
		return ScreenshotInfo{}, "Ảnh quá lớn (>15MB)", false
	}
	ext := "png"
	if m[1] != "png" {
		ext = strings.ReplaceAll(m[1], "jpeg", "jpg")
	}
	// v4.4.0 (B-26): verify MAGIC BYTES — file "ảnh" thực chất là thứ khác bị chặn
	if err := verifyImageMagic(raw, m[1]); err != nil {
		return ScreenshotInfo{}, err.Error(), false
	}
	// v4.4.0 (B-24): thêm suffix entropy — 2 ảnh cùng giây không còn ghi đè nhau
	name := fmt.Sprintf("shot_%s_%04x.%s", time.Now().Format("2006-01-02_150405"), time.Now().Nanosecond()%65536, ext)
	shotPath := filepath.Join(shotsDir(), name)
	if f, ferr := os.OpenFile(shotPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644); ferr == nil {
		_, werr := f.Write(raw)
		f.Close()
		if werr != nil {
			return ScreenshotInfo{}, "Không ghi được ảnh: " + werr.Error(), false
		}
	} else {
		return ScreenshotInfo{}, "Không lưu được ảnh: " + ferr.Error(), false
	}
	return ScreenshotInfo{File: name, URL: "/shots/" + name, CreatedAt: time.Now().Format(time.RFC3339), SizeBytes: int64(len(raw))}, "Đã lưu ảnh chụp", true
}

/** v4.4.0 (B-26): kiểm magic bytes theo Content-Type khai báo — không tin client. */
func verifyImageMagic(raw []byte, typ string) error {
	switch typ {
	case "png":
		if len(raw) < 8 || string(raw[:8]) != "\x89PNG\r\n\x1a\n" {
			return fmt.Errorf("dữ liệu không phải PNG thật (magic bytes sai)")
		}
	case "jpeg":
		if len(raw) < 3 || raw[0] != 0xFF || raw[1] != 0xD8 || raw[2] != 0xFF {
			return fmt.Errorf("dữ liệu không phải JPEG thật (magic bytes sai)")
		}
	case "webp":
		if len(raw) < 12 || string(raw[:4]) != "RIFF" || string(raw[8:12]) != "WEBP" {
			return fmt.Errorf("dữ liệu không phải WebP thật (magic bytes sai)")
		}
	default:
		return fmt.Errorf("định dạng ảnh không hỗ trợ: %s", typ)
	}
	return nil
}

func listScreenshots() []ScreenshotInfo {
	ents, err := os.ReadDir(shotsDir())
	out := []ScreenshotInfo{}
	if err != nil {
		return out
	}
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		st, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, ScreenshotInfo{
			File: e.Name(), URL: "/shots/" + e.Name(),
			CreatedAt: st.ModTime().Format(time.RFC3339), SizeBytes: st.Size(),
		})
	}
	// v4.4.0 (B-36): O(n log n) + giới hạn 200 ảnh mới nhất
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	if len(out) > 200 {
		out = out[:200]
	}
	return out
}

func deleteScreenshot(name string) bool {
	if strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, ".") {
		return false // chặn path traversal
	}
	return os.Remove(filepath.Join(shotsDir(), name)) == nil
}
