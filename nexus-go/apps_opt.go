// apps_opt.go — v3.7.0: App Optimizer — thẻ tối ưu riêng từng app phổ biến
// (Edge / Chrome / Brave / Firefox / Discord / Spotify), phát hiện cài đặt THẬT qua
// đường dẫn chuẩn + áp dụng hoàn tác riêng từng app, trạng thái lưu config.json.
// Kết quả luôn trung thực: app chưa cài → "App not found", thiếu admin → báo rõ.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	// ---------- v4.0.0: mở rộng App Optimizer ----------
	{"steam", "Steam Optimization",
		"Gỡ Steam khỏi danh sách tự khởi động cùng Windows — Steam không còn tự mở + tự cập nhật khi bật máy, game bật nhanh hơn.",
		"🕹️", false},
	{"onedrive", "OneDrive Optimization",
		"Gỡ OneDrive khỏi danh sách tự khởi động cùng Windows — dừng đồng bộ nền ngầm ăn băng thông/CPU khi game chạy (file vẫn giữ nguyên, chỉ không tự đồng bộ nữa).",
		"☁️", false},
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
	case "steam":
		return pick(firstExists(
			filepath.Join(pf86, `Steam\steam.exe`),
			filepath.Join(pf, `Steam\steam.exe`)))
	case "onedrive":
		return pick(firstExists(
			filepath.Join(localdata, `Microsoft\OneDrive\OneDrive.exe`),
			filepath.Join(pf86, `Microsoft OneDrive\OneDrive.exe`)))
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

// ---------- v3.9.0: snapshot gốc trước khi apply (theo audit P2-03/P2-04/P2-16) ----------
// Lưu vào dataDir()/appopt-snap.json — hoàn tác trả về GIÁ TRỊ GỐC, không delete mù.
// Cấu trúc: { "section": { "key hoặc name": { "type": "REG_DWORD", "data": "0x1" } } }
// v4.1.0 (audit v4.0.0 phát hiện 06): lớp snapshot sửa lại theo báo cáo:
//   - mutex chung quanh mọi read-modify-write (hai thao tác song song không ghi đè nhau)
//   - ghi file nguyên tử: temp + flush/sync + close rồi mới thay thế; lỗi ghi KHÔNG nuốt nữa
//   - JSON hỏng → cách ly file (.corrupt-<ts>) và báo lỗi, KHÔNG tự tạo file mới đè mất
//     các section snapshot khác
//   - caller bắt buộc xử lý lỗi: không persist được snapshot gốc thì KHÔNG được đụng vào
//     cấu hình của người dùng (abort trước khi ghi/xóa registry)

var snapMu sync.Mutex

func appoptSnapPath() string { return filepath.Join(dataDir(), "appopt-snap.json") }

/** Đọc toàn bộ snapshot; JSON hỏng → cách ly + lỗi (không âm thầm tạo lại) */
func loadSnapAll() (map[string]map[string]map[string]string, error) {
	b, err := os.ReadFile(appoptSnapPath())
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]map[string]map[string]string{}, nil
		}
		return nil, fmt.Errorf("đọc %s thất bại: %w", appoptSnapPath(), err)
	}
	var all map[string]map[string]map[string]string
	if err := json.Unmarshal(b, &all); err != nil {
		// cách ly file hỏng — giữ bằng chứng, không ghi đè dữ liệu gốc của các section khác
		q := appoptSnapPath() + ".corrupt-" + time.Now().Format("20060102-150405")
		_ = os.Rename(appoptSnapPath(), q)
		return nil, fmt.Errorf("snapshot JSON hỏng — đã cách ly sang %s (%v)", filepath.Base(q), err)
	}
	if all == nil {
		all = map[string]map[string]map[string]string{}
	}
	return all, nil
}

/** Ghi nguyên tử 1 section; trả lỗi cho caller — không persist được thì caller phải abort */
/** v4.3.0 (P1-04): read-modify-write CHUNG cho section snapshot — mutate từng key,
 * KHÔNG bao giờ thay thế cả map (tránh mất key HAGS/CPU-MIN khi block khác save). */
func updateAppoptSnap(section string, mutate func(m map[string]map[string]string)) error {
	old, _, lerr := loadAppoptSnap(section)
	if lerr != nil {
		return lerr // fail closed — không ghi đè snapshot có thể còn giá trị
	}
	m := old
	if m == nil {
		m = map[string]map[string]string{}
	}
	mutate(m)
	return saveAppoptSnap(section, m)
}

func saveAppoptSnap(section string, m map[string]map[string]string) error {
	snapMu.Lock()
	defer snapMu.Unlock()
	all, err := loadSnapAll()
	if err != nil {
		return err
	}
	all[section] = m
	out, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal snapshot: %w", err)
	}
	tmp := appoptSnapPath() + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, filePerm())
	if err != nil {
		return fmt.Errorf("tạo file tạm snapshot: %w", err)
	}
	if _, err := f.Write(out); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("ghi file tạm snapshot: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("sync snapshot: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("đóng snapshot: %w", err)
	}
	// os.Rename không atomic trên Windows — chấp nhận: temp+sync đã chặt hơn ghi đè trực tiếp,
	// và lỗi rename vẫn được trả về thay vì nuốt (audit yêu cầu propagate error)
	if err := os.Rename(tmp, appoptSnapPath()); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("thay thế file snapshot: %w", err)
	}
	return nil
}

/** Đọc 1 section — found=false là trạng thái hợp lệ ("chưa có"), error là lỗi thật sự */
func loadAppoptSnap(section string) (map[string]map[string]string, bool, error) {
	snapMu.Lock()
	defer snapMu.Unlock()
	all, err := loadSnapAll()
	if err != nil {
		return nil, false, err
	}
	s, found := all[section]
	return s, found, nil
}

/** Xóa 1 section; trả lỗi — chỉ gọi khi toàn bộ restore đã verify thành công */
func clearAppoptSnap(section string) error {
	snapMu.Lock()
	defer snapMu.Unlock()
	all, err := loadSnapAll()
	if err != nil {
		return err
	}
	delete(all, section)
	out, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal snapshot: %w", err)
	}
	tmp := appoptSnapPath() + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, filePerm())
	if err != nil {
		return fmt.Errorf("tạo file tạm snapshot: %w", err)
	}
	if _, err := f.Write(out); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("ghi file tạm snapshot: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("sync snapshot: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("đóng snapshot: %w", err)
	}
	if err := os.Rename(tmp, appoptSnapPath()); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("thay thế file snapshot: %w", err)
	}
	return nil
}

/** Read-back sau khi hoàn tác: value hiện tại phải khớp dữ liệu gốc */
func regValueMatches(key, name, wantData string) bool {
	_, data, found := regQueryValue(key, name)
	if !found {
		return false
	}
	return strings.TrimSpace(data) == strings.TrimSpace(wantData)
}

/** v4.1.0 (phát hiện 01/06): phân biệt "value không tồn tại" với "lỗi query" —
 * reg query thất bại vì Access Denied / runner lỗi KHÔNG được coi như "chưa từng có".
 * exists=false chỉ khi reg trả lỗi "unable to find" (đa ngôn ngữ: lỗi missing của reg.exe
 * thường vẫn tiếng Anh); các lỗi khác → error, caller phải dừng. */
func regQueryValueStrict(key, name string) (typ, data string, exists bool, err error) {
	r := runSysExe("reg.exe", []string{"query", key, "/v", name}, 10*time.Second)
	if !r.OK {
		out := strings.ToLower(r.Stdout + r.Stderr)
		if strings.Contains(out, "unable to find") || strings.Contains(out, "cannot find") || strings.Contains(out, "the system was unable") {
			return "", "", false, nil // chắc chắn không tồn tại — trạng thái hợp lệ
		}
		return "", "", false, fmt.Errorf("reg query %s\\%s thất bại (exit %d): %s — không phân biệt được 'không tồn tại' và 'lỗi truy cập'", key, name, r.Code, firstLine(r.Stdout+r.Stderr))
	}
	for _, ln := range strings.Split(r.Stdout, "\n") {
		ln = strings.TrimSpace(ln)
		if strings.HasPrefix(ln, name) && strings.Contains(ln, "REG_") {
			f := strings.Fields(ln)
			if len(f) >= 3 {
				return f[1], strings.Join(f[2:], " "), true, nil
			}
		}
	}
	return "", "", false, fmt.Errorf("reg query trả output không đọc được cho %s\\%s", key, name)
}

/** regQueryValue — đọc type+data hiện tại của 1 registry value (dùng cho snapshot) */
func regQueryValue(key, name string) (string, string, bool) {
	r := runSysExe("reg.exe", []string{"query", key, "/v", name}, 10*time.Second)
	if !r.OK {
		return "", "", false
	}
	for _, ln := range strings.Split(r.Stdout, "\n") {
		ln = strings.TrimSpace(ln)
		if strings.HasPrefix(ln, name) && strings.Contains(ln, "REG_") {
			// dạng: "StartupBoostEnabled    REG_DWORD    0x1"
			f := strings.Fields(ln)
			if len(f) >= 3 {
				return f[1], strings.Join(f[2:], " "), true
			}
		}
	}
	return "", "", false
}

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
	// v3.9.0: snapshot giá trị gốc TRƯỚC khi ghi — hoàn tác sẽ trả đúng giá trị cũ
	// v4.1.0 (phát hiện 06): persist snapshot thất bại → ABORT trước khi đụng registry
	snap := map[string]map[string]string{}
	unknownVals := 0
	for _, v := range vals {
		// v4.3.0 (P1-07): strict — access denied/lỗi spawn ≠ "không tồn tại"; UNKNOWN → không ghi đè mù
		typ, data, found, qerr := regQueryValueStrict(key, v.Name)
		if qerr != nil {
			unknownVals++
			continue
		}
		if found {
			snap[v.Name] = map[string]string{"type": typ, "data": data}
		}
	}
	if len(snap) > 0 {
		if err := saveAppoptSnap("policy:"+id, snap); err != nil {
			return AppOptRunResult{Mode: "windows", ID: id, Success: false,
				Steps:   []PerfStep{{Name: "Lưu snapshot giá trị gốc", OK: false, Detail: err.Error() + " — HỦY tối ưu, không đụng registry (không mất dữ liệu gốc)"}},
				Message: "Không lưu được snapshot gốc (" + err.Error() + ") — dừng an toàn, máy chưa bị thay đổi"}
		}
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
	// v3.9.0 (audit P2-03): có snapshot → trả giá trị GỐC (giữ chính sách admin có trước);
	// không có snapshot → delete về mặc định Windows
	// v4.1.0 (phát hiện 06): snapshot chỉ được xóa khi TOÀN BỘ value đã trả + verify khớp
	snap, snapFound, snapErr := loadAppoptSnap("policy:" + id)
	if snapErr != nil {
		return AppOptRunResult{Mode: "windows", ID: id, Success: false,
			Steps:   []PerfStep{{Name: "Đọc snapshot gốc", OK: false, Detail: snapErr.Error()}},
			Message: "Không đọc được snapshot — KHÔNG hoàn tác mù (giữ nguyên trạng thái hiện tại để an toàn)"}
	}
	allOK := true
	var detail []string
	for _, n := range names {
		if s, ok := snap[n]; ok {
			r := runSysExe("reg.exe", []string{"add", key, "/v", n, "/t", s["type"], "/d", s["data"], "/f"}, 8*time.Second)
			if !r.OK || !regValueMatches(key, n, s["data"]) {
				allOK = false
			}
			detail = append(detail, n+" → trả giá trị gốc ("+s["data"]+")")
		} else {
			r := regDeleteValues(key, []string{n}, "")
			if !r.Success {
				allOK = false
			}
			detail = append(detail, n+" → gỡ (chưa từng có trước khi tối ưu)")
		}
	}
	if allOK && snapFound {
		if err := clearAppoptSnap("policy:" + id); err != nil {
			allOK = false
			detail = append(detail, "snapshot chưa xóa được: "+err.Error())
		}
	}
	msg := "Đã hoàn tác — trả đúng trạng thái trước khi tối ưu (đã verify)"
	if !allOK {
		msg = "Một số value hoàn tác lỗi — snapshot GIỮ NGUYÊN để thử lại (không mất dữ liệu gốc)"
	}
	return AppOptRunResult{Mode: "windows", ID: id, Success: allOK,
		Steps:   []PerfStep{{Name: "Hoàn tác chính sách (trả đúng trạng thái gốc)", OK: allOK, Detail: strings.Join(detail, "; ")}},
		Message: msg}
}

func applyDiscord(enabled bool) AppOptRunResult {
	res := AppOptRunResult{Mode: "windows", ID: "discord", Steps: []PerfStep{}}
	home, _ := os.UserHomeDir()
	cfg := filepath.Join(home, "AppData", "Roaming", "discord", "settings.json")
	if enabled {
		hwOK := false
		if st, err := os.Stat(cfg); err == nil && !st.IsDir() {
			raw, err := os.ReadFile(cfg)
			if err == nil {
				var m map[string]any
				if err := json.Unmarshal(raw, &m); err == nil {
					// v3.9.0 (audit P2-02): lưu giá trị HardwareAcceleration GỐC trước khi đổi
					// v4.1.0 (phát hiện 06): persist lỗi → abort, không ghi đè settings.json
					if prev, had := m["HardwareAcceleration"]; had {
						if serr := saveAppoptSnap("discord-hw", map[string]map[string]string{
							"value": map[string]string{"json": fmt.Sprint(prev), "had": "1"},
						}); serr != nil {
							return AppOptRunResult{Mode: "windows", ID: "discord", Success: false,
								Steps:   []PerfStep{{Name: "Lưu snapshot giá trị gốc", OK: false, Detail: serr.Error() + " — HỦY, không đổi settings.json"}},
								Message: "Không lưu được snapshot gốc — dừng an toàn, Discord chưa bị thay đổi"}
						}
					}
					m["HardwareAcceleration"] = false
					if out, err := json.MarshalIndent(m, "", "  "); err == nil && os.WriteFile(cfg, out, 0644) == nil {
						hwOK = true
						res.Steps = append(res.Steps, PerfStep{Name: "Hardware Acceleration → tắt trong settings.json", OK: true,
							Detail: "Discord không còn cạnh tranh GPU với game — áp dụng sau khi mở lại Discord"})
					}
				}
			}
		} else {
			res.Steps = append(res.Steps, PerfStep{Name: "Hardware Acceleration → tắt trong settings.json", OK: false,
				Detail: "không tìm thấy settings.json của Discord"})
		}
		// IFEO CPU priority — cần admin; snapshot giá trị gốc nếu có (persist lỗi → bỏ qua IFEO, không ghi đè)
		// v4.3.0 (P1-07): strict — UNKNOWN (access denied) không được coi là value không có
		if typ, data, found, qerr := regQueryValueStrict(ifeoDiscord, "CpuPriorityClass"); qerr == nil && found {
			if serr := saveAppoptSnap("discord-ifeo", map[string]map[string]string{
				"CpuPriorityClass": map[string]string{"type": typ, "data": data},
			}); serr != nil {
				res.Steps = append(res.Steps, PerfStep{Name: "CPU priority Discord (IFEO) → bỏ qua", OK: false,
					Detail: "lưu snapshot giá trị gốc lỗi: " + serr.Error() + " — KHÔNG ghi IFEO (fail-closed: ghi mà không có snapshot thì không hoàn tác được)"})
				// v4.3.0 (P1-06): BỎ hẳn lệnh ghi — trước đây vẫn regAddValues rồi bỏ kết quả
				res.Success = hwOK
				res.Message = map[bool]string{true: "Đã tắt HW accel Discord — RIÊNG IFEO bị bỏ qua vì không lưu được snapshot gốc (an toàn hơn ghi đè mù)",
					false: "Không tắt được Hardware Acceleration — settings.json Discord không tìm thấy/không ghi được"}[hwOK]
				return res
			}
		}
		r := regAddValues(ifeoDiscord, []RegValue{{"CpuPriorityClass", "REG_DWORD", "16384"}}, "")
		res.Steps = append(res.Steps, PerfStep{Name: "CPU priority Discord → Below Normal (IFEO)", OK: r.Success,
			Detail: map[bool]string{true: "16384 (Below Normal) — game luôn được CPU trước Discord", false: r.Message + " (cần quyền admin)"}[r.Success]})
		// v3.9.0 (audit P2-02): tổng hợp trung thực — bước chính là HW accel; IFEO lỗi thì cảnh báo rõ
		res.Success = hwOK
		if hwOK && r.Success {
			res.Message = "Đã tối ưu Discord (HW accel tắt + ưu tiên CPU thấp)"
		} else if hwOK {
			res.Message = "Đã tắt HW accel Discord — RIÊNG phần IFEO CPU priority cần quyền admin nên chưa đặt được (chạy lại app với quyền admin sẽ đủ cả 2)"
		} else {
			res.Message = "Không tắt được Hardware Acceleration — settings.json Discord không tìm thấy/không ghi được"
		}
	} else {
		// v3.9.0 (audit P2-02): hoàn tác trả GIÁ TRỊ GỐC — key có trước thì giữ nguyên giá trị cũ
		// v4.1.0 (phát hiện 06): snapshot chỉ xóa khi restore thành công + verify
		hwRestored := false
		if snap, snapFound, snapErr := loadAppoptSnap("discord-hw"); snapErr != nil {
			res.Steps = append(res.Steps, PerfStep{Name: "Hardware Acceleration → hoàn tác", OK: false, Detail: snapErr.Error()})
		} else if snapFound && snap["value"] != nil {
			if st, err := os.Stat(cfg); err == nil && !st.IsDir() {
				if raw, err := os.ReadFile(cfg); err == nil {
					var m map[string]any
					if err := json.Unmarshal(raw, &m); err == nil {
						if snap["value"]["had"] == "1" && snap["value"]["json"] != "" {
							var prev any
							if err := json.Unmarshal([]byte(snap["value"]["json"]), &prev); err == nil {
								m["HardwareAcceleration"] = prev
							} else {
								m["HardwareAcceleration"] = true
							}
							detail := "trả giá trị gốc: " + snap["value"]["json"]
							if out, err := json.MarshalIndent(m, "", "  "); err == nil && os.WriteFile(cfg, out, 0644) == nil {
								res.Steps = append(res.Steps, PerfStep{Name: "Hardware Acceleration → trả giá trị gốc", OK: true, Detail: detail})
								hwRestored = true
							}
						} else {
							delete(m, "HardwareAcceleration")
							if out, err := json.MarshalIndent(m, "", "  "); err == nil && os.WriteFile(cfg, out, 0644) == nil {
								res.Steps = append(res.Steps, PerfStep{Name: "Hardware Acceleration → về mặc định", OK: true, Detail: "key chưa từng có trước khi tối ưu — đã gỡ"})
								hwRestored = true
							}
						}
					}
				}
			}
			if hwRestored {
				if err := clearAppoptSnap("discord-hw"); err != nil {
					hwRestored = false
					res.Steps = append(res.Steps, PerfStep{Name: "Hardware Acceleration → hoàn tác", OK: false,
						Detail: "restore OK nhưng xóa snapshot lỗi (" + err.Error() + ") — giữ snapshot, thử lại an toàn"})
				}
			}
		}
		if !hwRestored {
			// không có snapshot (tối ưu trước khi cài v3.9.0) — fallback: gỡ key như cũ
			if st, err := os.Stat(cfg); err == nil && !st.IsDir() {
				if raw, err := os.ReadFile(cfg); err == nil {
					var m map[string]any
					if err := json.Unmarshal(raw, &m); err == nil {
						delete(m, "HardwareAcceleration")
						if out, err := json.MarshalIndent(m, "", "  "); err == nil && os.WriteFile(cfg, out, 0644) == nil {
							res.Steps = append(res.Steps, PerfStep{Name: "Hardware Acceleration → về mặc định", OK: true, Detail: "không có snapshot gốc — đã gỡ key (bản tối ưu cũ)"})
							hwRestored = true
						}
					}
				}
			}
		}
		// IFEO: trả giá trị gốc nếu có snapshot, không thì gỡ — chỉ clear khi verify khớp
		ifeoOK := true
		if snap, snapFound, snapErr := loadAppoptSnap("discord-ifeo"); snapErr != nil {
			ifeoOK = false
			res.Steps = append(res.Steps, PerfStep{Name: "CPU priority Discord → hoàn tác", OK: false, Detail: snapErr.Error()})
		} else if snapFound && snap["CpuPriorityClass"] != nil {
			s := snap["CpuPriorityClass"]
			r := runSysExe("reg.exe", []string{"add", ifeoDiscord, "/v", "CpuPriorityClass", "/t", s["type"], "/d", s["data"], "/f"}, 8*time.Second)
			ifeoOK = r.OK && regValueMatches(ifeoDiscord, "CpuPriorityClass", s["data"])
			if ifeoOK {
				if err := clearAppoptSnap("discord-ifeo"); err != nil {
					ifeoOK = false
				}
			}
			res.Steps = append(res.Steps, PerfStep{Name: "CPU priority Discord → trả giá trị gốc", OK: ifeoOK,
				Detail: map[bool]string{true: s["data"] + " (verify khớp)", false: "restore lỗi — snapshot giữ nguyên để thử lại"}[ifeoOK]})
		} else {
			r := regDeleteValues(ifeoDiscord, []string{"CpuPriorityClass"}, "")
			ifeoOK = r.Success
			res.Steps = append(res.Steps, PerfStep{Name: "CPU priority Discord → mặc định", OK: ifeoOK, Detail: "đã gỡ IFEO PerfOptions"})
		}
		res.Success = hwRestored && ifeoOK
		res.Message = map[bool]string{true: "Đã hoàn tác tối ưu Discord — trả đúng trạng thái gốc",
			false: "Hoàn tác một phần — xem chi tiết từng bước"}[res.Success]
	}
	return res
}

func applySpotify(enabled bool) AppOptRunResult {
	res := AppOptRunResult{Mode: "windows", ID: "spotify", Steps: []PerfStep{}}
	runKey := `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	if enabled {
		// v3.9.0 (audit P2-04): snapshot nguyên chuỗi command gốc trước khi xóa
		// v4.1.0 (phát hiện 06): persist lỗi → abort an toàn (máy chưa bị thay đổi)
		snap := map[string]map[string]string{}
		for _, n := range []string{"Spotify", "Spotify Web Helper"} {
			// v4.3.0 (P1-07): strict snapshot
			typ, data, found, qerr := regQueryValueStrict(runKey, n)
			if qerr == nil && found {
				snap[n] = map[string]string{"type": typ, "data": data}
			}
		}
		if len(snap) > 0 {
			if serr := saveAppoptSnap("spotify", snap); serr != nil {
				return AppOptRunResult{Mode: "windows", ID: "spotify", Success: false,
					Steps:   []PerfStep{{Name: "Lưu snapshot giá trị gốc", OK: false, Detail: serr.Error() + " — HỦY, không xóa Run entry"}},
					Message: "Không lưu được snapshot gốc — dừng an toàn, Spotify chưa bị thay đổi"}
			}
		}
		r := regDeleteValues(runKey, []string{"Spotify", "Spotify Web Helper"}, "")
		res.Steps = append(res.Steps, PerfStep{Name: "Gỡ Spotify khỏi tự khởi động (HKCU Run)", OK: r.Success,
			Detail: map[bool]string{true: "máy bật nhanh hơn — Spotify chỉ mở khi bấm vào", false: r.Message}[r.Success]})
		res.Success = r.Success
		res.Message = "Đã gỡ Spotify khỏi khởi động Windows"
	} else {
		// hoàn tác: trả nguyên chuỗi gốc (đúng path + arguments) nếu có snapshot
		// v4.1.0 (phát hiện 06): chỉ xóa snapshot khi mọi value đã trả + verify khớp
		snap, snapFound, snapErr := loadAppoptSnap("spotify")
		if snapErr != nil {
			return AppOptRunResult{Mode: "windows", ID: "spotify", Success: false,
				Steps:   []PerfStep{{Name: "Đọc snapshot gốc", OK: false, Detail: snapErr.Error()}},
				Message: "Không đọc được snapshot — không hoàn tác mù (giữ trạng thái hiện tại)"}
		}
		if snapFound && len(snap) > 0 {
			allOK := true
			for n, s := range snap {
				r := runSysExe("reg.exe", []string{"add", runKey, "/v", n, "/t", s["type"], "/d", s["data"], "/f"}, 8*time.Second)
				if !r.OK || !regValueMatches(runKey, n, s["data"]) {
					allOK = false
				}
				res.Steps = append(res.Steps, PerfStep{Name: "Khôi phục " + n + " (nguyên chuỗi gốc)", OK: r.OK, Detail: s["data"]})
			}
			if allOK {
				if err := clearAppoptSnap("spotify"); err != nil {
					allOK = false
				}
			}
			res.Success = allOK
			res.Message = map[bool]string{true: "Đã hoàn tác — trả đúng chuỗi khởi động gốc (verify khớp)",
				false: "Một số value lỗi — snapshot GIỮ NGUYÊN để thử lại"}[allOK]
			return res
		}
		// không có snapshot (tối ưu trước v3.9.0) — fallback path chuẩn
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
	case "steam":
		return applyRunEntryOpt(id, enabled, "Steam", []string{"Steam"})
	case "onedrive":
		return applyRunEntryOpt(id, enabled, "OneDrive", []string{"OneDrive"})
	}
	return AppOptRunResult{Mode: "windows", ID: id, Success: false, Message: "app không hỗ trợ"}
}

// ---------- v4.0.0: generic autostart optimizer — dùng chung cơ chế snapshot v3.9 ----------
// Gỡ entry khỏi HKCU Run (tự khởi động cùng Windows) với snapshot chuỗi gốc để hoàn tác
// trả đúng nguyên văn — tái dùng pattern Spotify (audit P2-04) cho mọi app mới.

func applyRunEntryOpt(id string, enabled bool, label string, valueNames []string) AppOptRunResult {
	res := AppOptRunResult{Mode: "windows", ID: id, Steps: []PerfStep{}}
	runKey := `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	if enabled {
		// v4.1.0 (phát hiện 06): snapshot LUÔN lưu, gồm cả sentinel existed=false
		// (app vốn không có Run entry → hoàn tác là no-op thành công, không báo "mất snapshot")
		// Persist lỗi → abort TRƯỚC khi xóa value (không mất chuỗi command gốc)
		snap := map[string]map[string]string{"existed": {"v": "0"}}
		for _, n := range valueNames {
			// v4.3.0 (P1-07): strict snapshot
			typ, data, found, qerr := regQueryValueStrict(runKey, n)
			if qerr == nil && found {
				snap[n] = map[string]string{"type": typ, "data": data}
				snap["existed"] = map[string]string{"v": "1"}
			}
		}
		if serr := saveAppoptSnap("run:"+id, snap); serr != nil {
			return AppOptRunResult{Mode: "windows", ID: id, Success: false,
				Steps:   []PerfStep{{Name: "Lưu snapshot giá trị gốc", OK: false, Detail: serr.Error() + " — HỦY, không xóa Run entry"}},
				Message: "Không lưu được snapshot gốc — dừng an toàn, " + label + " chưa bị thay đổi"}
		}
		r := regDeleteValues(runKey, valueNames, "")
		res.Steps = append(res.Steps, PerfStep{Name: "Gỡ " + label + " khỏi tự khởi động (HKCU Run)", OK: r.Success,
			Detail: map[bool]string{true: "app chỉ mở khi bạn cần — máy bật nhanh hơn, không còn tiến trình nền âm thầm", false: r.Message}[r.Success]})
		res.Success = r.Success
		res.Message = map[bool]string{true: "Đã gỡ " + label + " khỏi khởi động Windows", false: r.Message}[r.Success]
		return res
	}
	// hoàn tác: trả nguyên chuỗi gốc nếu có snapshot
	snap, snapFound, snapErr := loadAppoptSnap("run:" + id)
	if snapErr != nil {
		return AppOptRunResult{Mode: "windows", ID: id, Success: false,
			Steps:   []PerfStep{{Name: "Đọc snapshot gốc", OK: false, Detail: snapErr.Error()}},
			Message: "Không đọc được snapshot — KHÔNG hoàn tác mù (giữ trạng thái hiện tại để an toàn)"}
	}
	if !snapFound {
		// tối ưu trước v4.0.0 (không có snapshot) — báo trung thực: không đoán lại path
		res.Success = false
		res.Steps = append(res.Steps, PerfStep{Name: "Khôi phục " + label + " trong khởi động", OK: false,
			Detail: "không có snapshot chuỗi gốc (bản tối ưu trước v4.0.0) — tự bật lại trong Settings của " + label + " nếu cần"})
		res.Message = "Không tìm thấy snapshot cấu hình gốc — không khôi phục mò được"
		return res
	}
	if snap["existed"] != nil && snap["existed"]["v"] == "0" {
		// app vốn KHÔNG có Run entry trước khi tối ưu → hoàn tác = no-op thành công
		res.Success = true
		res.Steps = append(res.Steps, PerfStep{Name: "Khôi phục " + label + " trong khởi động", OK: true,
			Detail: "app vốn không có entry tự khởi động trước khi tối ưu — không có gì cần khôi phục"})
		res.Message = label + " vốn không tự khởi động trước đó — hoàn tác thành công (không có gì để trả)"
		if err := clearAppoptSnap("run:" + id); err != nil {
			res.Success = false
			res.Message = "Hoàn tác OK nhưng xóa snapshot lỗi (" + err.Error() + ") — sẽ thử lại lần sau"
		}
		return res
	}
	allOK := true
	for n, s := range snap {
		if n == "existed" {
			continue
		}
		r := runSysExe("reg.exe", []string{"add", runKey, "/v", n, "/t", s["type"], "/d", s["data"], "/f"}, 8*time.Second)
		ok := r.OK && regValueMatches(runKey, n, s["data"])
		if !ok {
			allOK = false
		}
		res.Steps = append(res.Steps, PerfStep{Name: "Khôi phục " + n + " (nguyên chuỗi gốc)", OK: ok, Detail: s["data"]})
	}
	if allOK {
		if err := clearAppoptSnap("run:" + id); err != nil {
			allOK = false
			res.Steps = append(res.Steps, PerfStep{Name: "Xóa snapshot", OK: false, Detail: err.Error() + " — snapshot giữ nguyên, hoàn tác lại an toàn"})
		}
	}
	res.Success = allOK
	res.Message = map[bool]string{true: "Đã hoàn tác — " + label + " quay lại khởi động như cấu hình gốc (verify khớp)",
		false: "Một số value lỗi — snapshot GIỮ NGUYÊN để thử lại (không mất dữ liệu gốc)"}[allOK]
	return res
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
		if !trySysOp("appopt") { // v4.1.1 (P2-08): coordinator chung — không đụng registry khi đang có thao tác khác
			writeErr(w, 409, sysOpBusyErr())
			return
		}
		defer doneSysOp()
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
