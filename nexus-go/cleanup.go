// cleanup.go — dọn dẹp disk + RAM (port từ cleanup.ts). Khác bản cũ: ĐO dung lượng bằng Go
// (filepath.WalkDir, không cần PowerShell chậm); CLEAN dùng PS script cho recycle bin/browser
// cache, os.RemoveAll cho temp. RAM dùng chung script với tweaks (ram.go).
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

type CleanupResult struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"` // disk|ram
	FreedBytes int64 `json:"freedBytes"`
	Success   bool   `json:"success"`
	Message   string `json:"message"`
}

type CleanupTargetInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	PathLabel string `json:"path,omitempty"`
	SizeBytes int64  `json:"sizeBytes"`
	CanClean  bool   `json:"canClean"`
	Note      string `json:"note,omitempty"`
	Admin     bool   `json:"admin,omitempty"`
}

type CleanupScanResponse struct {
	Targets           []CleanupTargetInfo `json:"targets"`
	Logs              []CleanupLogEntry   `json:"logs"`
	RamNote           string              `json:"ramNote"`
	TotalFreedAllTime int64               `json:"totalFreedAllTime"` // tổng đã giải phóng từ trước tới nay
	LastRan           string              `json:"lastRan,omitempty"` // ISO time lần dọn gần nhất
}

type CleanupRunResponse struct {
	Results       []CleanupResult `json:"results"`
	TotalFreedDisk int64          `json:"totalFreedDisk"`
	TotalFreedRam  int64          `json:"totalFreedRam"`
}

const ramNoteWin = "Dọn RAM chạy EmptyWorkingSet + xả standby list: tiến trình nặng nhả working set ngay; standby list cần quyền Administrator để trả RAM về available."
const ramNoteOther = "Dọn RAM cần bản Windows .exe (dùng EmptyWorkingSet qua PowerShell)."

type targetDef struct {
	ID          string
	Name        string
	Paths       []string // các thư mục gốc tính size + xóa nội dung
	PathLabel   string
	FilePattern *regexp.Regexp // chỉ xóa file khớp (vd thumbcache)
	BrowserRoot string         // special browser cache: User Data root
	Special     string         // recyclebin | deliveryopt | ""
	Admin       bool
	Note        string
}

var thumbCacheRe = regexp.MustCompile(`(?i)^thumbcache_.*\.db$|^iconcache_.*\.db$`)

func winLocal() string {
	if v := os.Getenv("LOCALAPPDATA"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "AppData", "Local")
}

func winRoot() string {
	if v := os.Getenv("SystemRoot"); v != "" {
		return v
	}
	return `C:\Windows`
}

func cleanupTargetsWin() []targetDef {
	local := winLocal()
	root := winRoot()
	return []targetDef{
		{ID: "win-user-temp", Name: "File tạm người dùng (Temp)", Paths: []string{os.TempDir()}, PathLabel: "%TEMP%",
			Note: "Thư mục TEMP của user hiện tại"},
		{ID: "win-win-temp", Name: "File tạm Windows", Paths: []string{filepath.Join(root, "Temp")},
			PathLabel: root + "\\Temp", Admin: true, Note: "Cần quyền Administrator"},
		{ID: "win-prefetch", Name: "Prefetch Windows", Paths: []string{filepath.Join(root, "Prefetch")},
			PathLabel: root + "\\Prefetch", Admin: true, Note: "An toàn — Windows tự dựng lại"},
		{ID: "win-wu-cache", Name: "Cache Windows Update", Paths: []string{filepath.Join(root, "SoftwareDistribution", "Download")},
			PathLabel: root + "\\SoftwareDistribution\\Download", Admin: true, Note: "Cần quyền Administrator — Windows tự tải lại khi Update"},
		{ID: "win-d3dscache", Name: "DirectX Shader Cache", Paths: []string{filepath.Join(local, "D3DSCache")},
			PathLabel: "%LOCALAPPDATA%\\D3DSCache"},
		{ID: "win-thumbcache", Name: "Thumbnail + icon cache", Paths: []string{filepath.Join(local, "Microsoft", "Windows", "Explorer")},
			PathLabel: "%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer", FilePattern: thumbCacheRe,
			Note: "Chỉ xóa file thumbcache_*.db / iconcache_*.db (Windows tự dựng lại)"},
		{ID: "win-chrome-cache", Name: "Cache Chrome", Paths: []string{filepath.Join(local, "Google", "Chrome", "User Data")},
			PathLabel: "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Cache · *\\Code Cache", BrowserRoot: "chrome"},
		{ID: "win-edge-cache", Name: "Cache Edge", Paths: []string{filepath.Join(local, "Microsoft", "Edge", "User Data")},
			PathLabel: "%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\*\\Cache · *\\Code Cache", BrowserRoot: "edge"},
		{ID: "win-crash-dumps", Name: "Crash dumps", Paths: []string{filepath.Join(local, "CrashDumps")},
			PathLabel: "%LOCALAPPDATA%\\CrashDumps"},
		{ID: "win-recycle-bin", Name: "Thùng rác (Recycle Bin)", PathLabel: "Tất cả các ổ đĩa",
			Special: "recyclebin", Note: "Xóa vĩnh viễn các file đang nằm trong Thùng rác"},
		{ID: "win-delivery-opt", Name: "Cache Delivery Optimization", PathLabel: "Do Windows quản lý (Delivery Optimization)",
			Special: "deliveryopt", Admin: true, Note: "Cần quyền Administrator — dung lượng giải phóng không đo được chính xác"},
	}
}

var profileRe = regexp.MustCompile(`^(Default|Profile \d+)$`)

/** Các thư mục cache thật của profile trình duyệt (Default|Profile N → Cache, Code Cache, GPUCache) */
func browserCacheDirs(root string) []string {
	ents, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		if !e.IsDir() || !profileRe.MatchString(e.Name()) {
			continue
		}
		profile := filepath.Join(root, e.Name())
		for _, sub := range []string{"Cache", "Code Cache", "GPUCache"} {
			out = append(out, filepath.Join(profile, sub))
		}
	}
	return out
}

/** Đo dung lượng bằng Go walk — không spawn process nào, nhanh và không lỗi locale */
func dirSize(path string, only *regexp.Regexp) int64 {
	var total int64
	filepath.WalkDir(path, func(_ string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // không đọc được (khóa file/quyền) — bỏ qua, không fail cả target
		}
		if !d.IsDir() {
			if only != nil && !only.MatchString(d.Name()) {
				return nil
			}
			if info, err := d.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}

func scanTargets() CleanupScanResponse {
	logs := appState.GetCleanupLogs()
	res := CleanupScanResponse{
		Targets:           []CleanupTargetInfo{},
		Logs:              logs,
		TotalFreedAllTime: appState.CleanupTotalFreed(),
	}
	for _, l := range logs {
		if res.LastRan == "" || l.CreatedAt.Format(time.RFC3339) > res.LastRan {
			res.LastRan = l.CreatedAt.Format(time.RFC3339)
		}
	}
	if !runtimeIsWindows {
		res.RamNote = ramNoteOther
		res.Targets = append(res.Targets, CleanupTargetInfo{
			ID: "unsupported", Name: "Dọn dẹp disk chỉ hỗ trợ trên Windows (bản .exe)", SizeBytes: 0, CanClean: false,
		})
		return res
	}
	res.RamNote = ramNoteWin
	admin := getWinStatus().Admin
	for _, t := range cleanupTargetsWin() {
		info := CleanupTargetInfo{ID: t.ID, Name: t.Name, PathLabel: t.PathLabel, Note: t.Note, Admin: t.Admin}
		info.CanClean = true
		switch t.Special {
		case "recyclebin":
			// đo qua các ổ $Recycle.Bin nếu đọc được; không đo được thì vẫn cho clean
			var sz int64
			for _, vol := range []string{"C:", "D:", "E:"} {
				sz += dirSize(vol+`\$Recycle.Bin`, nil)
			}
			info.SizeBytes = sz
		case "deliveryopt":
			info.SizeBytes = 0
			info.CanClean = admin
		default:
			var sz int64
			if t.BrowserRoot != "" {
				for _, p := range t.Paths {
					for _, c := range browserCacheDirs(p) {
						sz += dirSize(c, nil)
					}
				}
			} else {
				for _, p := range t.Paths {
					sz += dirSize(p, t.FilePattern)
				}
			}
			info.SizeBytes = sz
			if t.Admin && !admin {
				info.CanClean = false
			}
		}
		res.Targets = append(res.Targets, info)
	}
	return res
}

/** Xóa NỘI DUNG thư mục (giữ nguyên thư mục) — tôn trọng FilePattern nếu có */
/** v4.3.0 (P2-05): phân biệt "folder không tồn tại" (bình thường → coi như sạch) với
 * lỗi thật (access denied/locked) — không được báo Success=true giả khi không đọc được. */
func emptyDirContents(path string, only *regexp.Regexp) (int64, int, error) {
	var freed int64
	n := 0
	ents, err := os.ReadDir(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, 0, nil // folder chưa tồn tại = không có gì để dọn
		}
		return 0, 0, err // access denied / lỗi I/O — caller phải báo trung thực
	}
	for _, e := range ents {
		full := filepath.Join(path, e.Name())
		if only != nil && !only.MatchString(e.Name()) {
			continue
		}
		sz := dirSize(full, nil)
		if err := os.RemoveAll(full); err == nil {
			freed += sz
			n++
		}
	}
	return freed, n, nil
}

/** Clean browser cache: xóa Cache/Code Cache/GPUCache của các profile thật */
func cleanBrowserRoot(root string) (int64, int, error) {
	var freed int64
	n := 0
	var firstErr error
	for _, c := range browserCacheDirs(root) {
		f, cnt, err := emptyDirContents(c, nil)
		freed += f
		n += cnt
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return freed, n, firstErr
}

/** Recycle bin: Clear-RecycleBin -Force (PS); Delivery Optimization: Delete-DeliveryOptimizationCache */
func cleanSpecialWindows(id string) (int64, CleanupResult) {
	switch id {
	case "win-recycle-bin":
		r := psRun("try { Clear-RecycleBin -Force -ErrorAction Stop; exit 0 } catch { Write-Output $_.Exception.Message; exit 1 }", 60*time.Second)
		if !r.OK {
			return 0, CleanupResult{ID: id, Name: "Thùng rác (Recycle Bin)", Kind: "disk", Success: false,
				Message: truncateShort("Clear-RecycleBin thất bại: " + orDefault(r.Stdout, r.Stderr, "không rõ lý do"))}
		}
		return 0, CleanupResult{ID: id, Name: "Thùng rác (Recycle Bin)", Kind: "disk", Success: true,
			Message: "Đã dọn Thùng rác (không đo trước được dung lượng — Windows quản lý)"}
	case "win-delivery-opt":
		r := psRun("try { Delete-DeliveryOptimizationCache -Force -ErrorAction Stop; exit 0 } catch { Write-Output $_.Exception.Message; exit 1 }", 60*time.Second)
		if !r.OK {
			return 0, CleanupResult{ID: id, Name: "Cache Delivery Optimization", Kind: "disk", Success: false,
				Message: truncateShort("Delete-DeliveryOptimizationCache thất bại: " + orDefault(r.Stdout, r.Stderr, "không rõ lý do") + " (cần Administrator)")}
		}
		return 0, CleanupResult{ID: id, Name: "Cache Delivery Optimization", Kind: "disk", Success: true,
			Message: "Đã dọn cache Delivery Optimization (Windows quản lý, không đo chính xác được)"}
	}
	return 0, CleanupResult{}
}

func cleanTargetWin(t targetDef) CleanupResult {
	if t.Special != "" {
		_, r := cleanSpecialWindows(t.ID)
		return r
	}
	var freed int64
	n := 0
	var firstErr error
	if t.BrowserRoot != "" {
		for _, root := range t.Paths {
			f, c, err := cleanBrowserRoot(root)
			freed += f
			n += c
			if err != nil && firstErr == nil {
				firstErr = err
			}
		}
	} else {
		for _, p := range t.Paths {
			f, c, err := emptyDirContents(p, t.FilePattern)
			freed += f
			n += c
			if err != nil && firstErr == nil {
				firstErr = err
			}
		}
	}
	name := targetNameByID(t.ID)
	if firstErr != nil {
		// v4.3.0 (P2-05): không đọc được folder là FAIL thật, không nuốt thành "không có gì để dọn"
		return CleanupResult{ID: t.ID, Name: name, Kind: "disk", Success: false,
			Message: truncateShort("Không truy cập được thư mục (cần Administrator hoặc file bị khóa): " + firstErr.Error() + " — đã dọn được " + fmt.Sprint(n) + " mục trước đó")}
	}
	if n == 0 && freed == 0 {
		return CleanupResult{ID: t.ID, Name: name, Kind: "disk", Success: true, FreedBytes: 0,
			Message: "Không có gì để dọn (hoặc file đang bị khóa bởi app khác)"}
	}
	return CleanupResult{ID: t.ID, Name: name, Kind: "disk", Success: true, FreedBytes: freed,
		Message: fmt.Sprintf("Đã xóa %d mục — giải phóng %s", n, humanBytes(freed))}
}

func targetNameByID(id string) string {
	for _, t := range cleanupTargetsWin() {
		if t.ID == id {
			return t.Name
		}
	}
	return id
}

func humanBytes(b int64) string {
	const kb, mb, gb = 1024.0, 1024.0*1024, 1024.0*1024*1024
	switch {
	case b >= int64(gb):
		return fmt.Sprintf("%.2f GB", float64(b)/gb)
	case b >= int64(mb):
		return fmt.Sprintf("%.1f MB", float64(b)/mb)
	case b >= int64(kb):
		return fmt.Sprintf("%.1f KB", float64(b)/kb)
	default:
		return fmt.Sprintf("%d B", b)
	}
}

/** POST /api/cleanup {action: disk|ram|all, targets?: [id,...]} — targets rỗng = dọn hết;
 * có targets thì chỉ dọn đúng các mục user tick chọn trên UI */
/** v4.3.0 (P1-01): gate của Disk worker — action=ram TUYỆT ĐỐI không được spawn worker
 * xóa disk (bug cũ: goroutine chạy ngầm xóa Temp/Recycle Bin dù user chỉ chọn RAM). */
func shouldRunDiskWorkers(action string) bool {
	return action == "disk" || action == "all"
}

func runCleanup(action string, ids []string) CleanupRunResponse {
	out := CleanupRunResponse{Results: []CleanupResult{}}
	sel := map[string]bool{}
	for _, id := range ids {
		sel[id] = true
	}
	// v4.3.0 (P1-01): BUG NGUY HIỂM — goroutine Disk trước đây spawn VÔ ĐIỀU KIỆN,
	// action=ram thì kết quả bị bỏ nhưng worker VẪN XÓA FILE ngầm (Temp/Prefetch/
	// Recycle Bin...). Giờ chỉ spawn worker khi action thật sự cần Disk.
	runDisk := shouldRunDiskWorkers(action)
	if !runDisk && action != "ram" {
		out.Results = append(out.Results, CleanupResult{ID: "invalid", Name: "Hành động", Kind: "disk",
			Success: false, Message: "Action không hợp lệ — chỉ nhận disk / ram / all"})
		return out
	}
	doneDisk := make(chan []CleanupResult, 1)
	if runDisk {
		go func() {
			var rs []CleanupResult
			if runtimeIsWindows {
				for _, t := range cleanupTargetsWin() {
					if len(sel) > 0 && !sel[t.ID] {
						continue
					}
					rs = append(rs, cleanTargetWin(t))
				}
				if len(sel) > 0 && len(rs) == 0 {
					rs = append(rs, CleanupResult{ID: "none", Name: "Mục đã chọn", Kind: "disk", Success: false,
						Message: "Không có mục nào khớp lựa chọn — hãy tick ít nhất 1 mục"})
				}
			} else {
				rs = append(rs, CleanupResult{ID: "unsupported", Name: "Disk", Kind: "disk", Success: false,
					Message: "Dọn disk chỉ hỗ trợ trên Windows (bản .exe)"})
			}
			doneDisk <- rs
		}()
	}
	if action == "disk" {
		out.Results = <-doneDisk
		for _, r := range out.Results {
			if r.Success {
				out.TotalFreedDisk += r.FreedBytes
			}
		}
	} else if action == "ram" {
		rs, total := cleanupRamTargets()
		out.Results = append(out.Results, rs...)
		out.TotalFreedRam = total
	} else { // all — song song
		doneRam := make(chan struct{ rs []CleanupResult; total int64 }, 1)
		go func() {
			rs, total := cleanupRamTargets()
			doneRam <- struct{ rs []CleanupResult; total int64 }{rs, total}
		}()
		out.Results = append(out.Results, <-doneDisk...)
		rr := <-doneRam
		out.Results = append(out.Results, rr.rs...)
		for _, r := range out.Results {
			if r.Success {
				if r.Kind == "ram" {
					out.TotalFreedRam += r.FreedBytes
				} else {
					out.TotalFreedDisk += r.FreedBytes
				}
			}
		}
	}
	for _, r := range out.Results {
		appState.AddCleanupLog(r.Kind, r.Name, r.FreedBytes, r.Success, r.Message)
	}
	return out
}
