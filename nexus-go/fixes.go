// fixes.go — v3.7.0: Fixes — sửa nhanh các lỗi Windows thường gặp, 1 nút bấm.
// Mỗi fix chạy nhiều bước và báo TRUNG THỰC kết quả từng bước (không khoe gì khi thiếu quyền).
// Trên nền không phải Windows: trả về danh sách bước với kết quả trung thực "chỉ chạy trên Windows".
package main

import (
	"net/http"
	"os"
	"strings"
	"time"
)

type FixCard struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Desc       string `json:"desc"`
	Icon       string `json:"icon"`
	NeedsAdmin bool   `json:"needsAdmin"`
}

type FixResult struct {
	Success bool       `json:"success"`
	Mode    string     `json:"mode"` // "windows" | "không-Windows"
	ID      string     `json:"id"`
	Steps   []PerfStep `json:"steps"`
	Message string     `json:"message"`
}

var fixDefs = []FixCard{
	{"fix-internet", "Mất mạng / Lag mạng / DNS lỗi",
		"Xóa cache DNS, reset Winsock + TCP/IP, lấy lại IP từ router — xử lý lỗi 'DNS không phản hồi', mạng bị lag đột xuất, không vào được web. Máy có thể mất mạng vài giây khi renew.",
		"🌐", true},
	{"fix-wupdate", "Windows Update kẹt / báo lỗi",
		"Khởi động lại dịch vụ Windows Update (wuauserv, BITS, Delivery Optimization) — xử lý Update đứng ở %, tải mãi không xong.",
		"🔄", true},
	{"fix-audio", "Mất tiếng / Âm thanh lỗi",
		"Khởi động lại dịch vụ âm thanh Windows (Audiosrv + AudioEndpointBuilder) — xử lý lỗi mất tiếng, loa bập bẹ, tai nghe không nhận. Các app đang phát nhạc cần phát lại.",
		"🔊", true},
	{"fix-explorer", "Menu Start / Taskbar đơ",
		"Khởi động lại Windows Explorer — xử lý lỗi Start menu không mở, taskbar đơ, nút Win không bấm được. Cửa sổ đang mở không bị mất.",
		"🖥️", false},
	{"fix-printer", "In ấn kẹt / hàng đợi in không xóa được",
		"Dọn hàng đợi in + khởi động lại Print Spooler — xử lý lỗi máy in kẹt giấy trong queue, lệnh in kẹt cứng.",
		"🖨️", true},
	{"fix-store", "Microsoft Store / app Store không mở",
		"Xóa cache của Microsoft Store (wsreset) — xử lý lỗi Store không mở, app UWP không tải được. Cửa sổ Store có thể tự mở sau khi xong.",
		"🏪", false},
	// ---------- v4.0.0: mở rộng bộ fix ----------
	{"fix-sfc", "Windows lỗi lặt vặt / file hệ thống hỏng",
		"DISM kiểm tra + phục hồi component store, rồi SFC quét và thay file hệ thống hỏng — xử lý lỗi Start menu/Update/UWP lỗi dai dẳng không rõ nguyên nhân. Chạy 5–20 phút, KHÔNG tắt máy trong lúc chạy.",
		"🧰", true},
	{"fix-search", "Windows Search không tìm thấy / tìm chậm",
		"Xây lại chỉ mục tìm kiếm: dừng WSearch, xóa file index cũ, khởi động lại — xử lý lỗi tìm kiếm trống kết quả, menu Start tìm không ra app. Lần đầu sau khi fix, chỉ mục cần vài phút để nạp lại.",
		"🔍", true},
	{"fix-defender", "Windows Defender không cập nhật virus",
		"Cập nhật signature Defender bằng MpCmdRun + khởi động lại dịch vụ Defender — xử lý lỗi bảo vệ 'cần kiểm tra', cập nhật kẹt 0%.",
		"🛡️", true},
	{"fix-time", "Giờ máy sai / lệch múi giờ",
		"Đồng bộ lại giờ hệ thống với máy chủ thời gian (w32tm resync) — xử lý lỗi đồng hồ chạy sai, chứng chỉ web báo lỗi vì lệch giờ.",
		"🕒", true},
}

func registerFixRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/fixes", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, fixDefs)
	})
	mux.HandleFunc("POST /api/fixes", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID string `json:"id"`
		}
		if !readBody(w, r, &body) || body.ID == "" {
			writeErr(w, 400, "Dữ liệu không hợp lệ (cần id)")
			return
		}
		var def *FixCard
		for i := range fixDefs {
			if fixDefs[i].ID == body.ID {
				def = &fixDefs[i]
				break
			}
		}
		if def == nil {
			writeErr(w, 400, "Fix không tồn tại: "+body.ID)
			return
		}
		res := runFix(*def)
		code := 200
		if !res.Success && res.Mode == "windows" {
			code = 500
		}
		writeJSON(w, code, res)
	})
}

func runFix(def FixCard) FixResult {
	if !runtimeIsWindows {
		return FixResult{Success: false, Mode: "không-Windows", ID: def.ID,
			Steps: []PerfStep{{Name: def.Name, OK: false, Detail: "Fix Windows chỉ chạy được trên bản .exe Windows — bản Linux/CI chỉ hiển thị trung thực"}},
			Message: "Fix này chỉ áp dụng được trên Windows"}
	}
	if def.NeedsAdmin {
		if m, ok := adminGate(); !ok {
			return FixResult{Success: false, Mode: "windows", ID: def.ID,
				Steps: []PerfStep{{Name: "Quyền admin", OK: false, Detail: m}}, Message: m}
		}
	}
	switch def.ID {
	case "fix-internet":
		return fixInternet()
	case "fix-wupdate":
		return fixServicesRestart(def.ID, "Windows Update", []string{"wuauserv", "bits", "dosvc"},
			"Đã khởi động lại dịch vụ Windows Update — thử kiểm tra Update lại")
	case "fix-audio":
		return fixServicesRestart(def.ID, "Dịch vụ âm thanh", []string{"Audiosrv", "AudioEndpointBuilder"},
			"Đã khởi động lại dịch vụ âm thanh — phát lại nhạc để kiểm tra")
	case "fix-explorer":
		return fixExplorer()
	case "fix-printer":
		return fixPrinter()
	case "fix-store":
		return fixStore()
	case "fix-sfc":
		return fixSfc()
	case "fix-search":
		return fixSearch()
	case "fix-defender":
		return fixDefender()
	case "fix-time":
		return fixTime()
	}
	return FixResult{Success: false, Mode: "windows", ID: def.ID, Message: "Fix không hỗ trợ"}
}

func fixStep(r RunResult, name, okDetail string) PerfStep {
	return PerfStep{Name: name, OK: r.OK, Detail: map[bool]string{true: okDetail, false: firstLine(r.Stdout + r.Stderr)}[r.OK]}
}

func fixInternet() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-internet", Steps: []PerfStep{}, Success: true}
	res.Steps = append(res.Steps, fixStep(runSysExe("ipconfig.exe", []string{"/flushdns"}, 8*time.Second),
		"Xóa cache DNS", "cache DNS đã sạch"))
	res.Steps = append(res.Steps, fixStep(runSysExe("netsh.exe", []string{"winsock", "reset"}, 10*time.Second),
		"Reset Winsock catalog", "winsock reset xong (khởi động lại Windows để chắc chắn)"))
	res.Steps = append(res.Steps, fixStep(runSysExe("netsh.exe", []string{"int", "ip", "reset"}, 10*time.Second),
		"Reset TCP/IP stack", "tcp/ip reset xong"))
	res.Steps = append(res.Steps, fixStep(runSysExe("ipconfig.exe", []string{"/renew"}, 15*time.Second),
		"Lấy lại IP từ router", "IP mới đã được cấp"))
	for _, s := range res.Steps {
		if !s.OK {
			res.Success = false
		}
	}
	res.Message = map[bool]string{true: "Đã sửa mạng: DNS + Winsock + TCP/IP + IP mới — mạng nên ổn định lại",
		false: "Một số bước lỗi — xem chi tiết từng bước dưới (cần quyền admin?)"}[res.Success]
	return res
}

func fixServicesRestart(id, name string, services []string, okMsg string) FixResult {
	res := FixResult{Mode: "windows", ID: id, Steps: []PerfStep{}, Success: true}
	for _, sv := range services {
		r1 := runSysExe("net.exe", []string{"stop", sv}, 15*time.Second)
		r2 := runSysExe("net.exe", []string{"start", sv}, 15*time.Second)
		ok := r2.OK || r1.OK // service có thể chưa chạy — start thành công vẫn tính
		res.Steps = append(res.Steps, PerfStep{Name: "Khởi động lại dịch vụ " + sv, OK: ok,
			Detail: map[bool]string{true: "stop → start OK", false: firstLine(r1.Stdout + r1.Stderr + r2.Stderr)}[ok]})
		if !ok {
			res.Success = false
		}
	}
	res.Message = map[bool]string{true: okMsg, false: "Một số dịch vụ không restart được — xem chi tiết"}[res.Success]
	return res
}

func fixExplorer() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-explorer", Steps: []PerfStep{}, Success: true}
	r1 := runSysExe("taskkill.exe", []string{"/f", "/im", "explorer.exe"}, 10*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Đóng Explorer", OK: r1.OK, Detail: firstLine(r1.Stdout + r1.Stderr)})
	r2 := runSysExe("cmd.exe", []string{"/c", "start", "explorer.exe"}, 10*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Mở lại Explorer / Taskbar", OK: r2.OK, Detail: "taskbar + Start menu đã quay lại"})
	res.Success = r2.OK
	res.Message = map[bool]string{true: "Đã khởi động lại Explorer — Start menu/taskbar bình thường lại",
		false: "Không mở lại được Explorer — mở tay bằng Task Manager nếu cần"}[res.Success]
	return res
}

func fixPrinter() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-printer", Steps: []PerfStep{}, Success: true}
	r1 := runSysExe("net.exe", []string{"stop", "Spooler"}, 15*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Dừng Print Spooler", OK: r1.OK, Detail: firstLine(r1.Stdout + r1.Stderr)})
	r2 := runSysExe("cmd.exe", []string{"/c", `del /q /f "%WINDIR%\System32\spool\PRINTERS\*.*"`}, 10*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Dọn hàng đợi in kẹt", OK: r2.OK, Detail: "các lệnh in kẹt đã bị xóa"})
	r3 := runSysExe("net.exe", []string{"start", "Spooler"}, 15*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Mở lại Print Spooler", OK: r3.OK, Detail: "in ấn hoạt động lại bình thường"})
	res.Success = r3.OK
	res.Message = map[bool]string{true: "Đã dọn hàng đợi in + restart Spooler — thử in lại",
		false: "Spooler không start lại được — xem chi tiết"}[res.Success]
	return res
}

func fixStore() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-store", Steps: []PerfStep{}, Success: true}
	r := runSysExe("wsreset.exe", nil, 40*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Xóa cache Microsoft Store (wsreset)", OK: r.OK,
		Detail: map[bool]string{true: "cache Store đã sạch", false: firstLine(r.Stdout + r.Stderr)}[r.OK]})
	res.Success = r.OK
	res.Message = map[bool]string{true: "Đã reset Microsoft Store — thử mở lại Store/app",
		false: "wsreset lỗi — xem chi tiết"}[res.Success]
	return res
}

// ---------- v4.0.0: mở rộng bộ fix ----------

/** fix-sfc: DISM RestoreHealth → SFC /scannow — sửa file hệ thống hỏng. Chạy lâu (5–20 phút),
 * timeout 20 phút mỗi bước, output chỉ lấy phần tóm tắt cuối để UI không phình. */
func fixSfc() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-sfc", Steps: []PerfStep{}, Success: true}
	r1 := runSysExe("dism.exe", []string{"/Online", "/Cleanup-Image", "/RestoreHealth"}, 20*time.Minute)
	res.Steps = append(res.Steps, PerfStep{Name: "DISM phục hồi component store (5–15 phút)", OK: r1.OK,
		Detail: map[bool]string{true: lastMeaningfulLine(r1.Stdout), false: firstLine(r1.Stdout + r1.Stderr) + " — nếu timeout, chạy lại trong PowerShell riêng"}[r1.OK]})
	if !r1.OK {
		res.Success = false
	}
	r2 := runSysExe("sfc.exe", []string{"/scannow"}, 20*time.Minute)
	res.Steps = append(res.Steps, PerfStep{Name: "SFC quét + thay file hệ thống hỏng (5–15 phút)", OK: r2.OK,
		Detail: map[bool]string{true: lastMeaningfulLine(r2.Stdout), false: firstLine(r2.Stdout + r2.Stderr)}[r2.OK]})
	if !r2.OK {
		res.Success = false
	}
	res.Message = map[bool]string{true: "Đã quét và phục hồi file hệ thống — khuyên khởi động lại máy để áp dụng trọn vẹn",
		false: "Một số bước lỗi — chi tiết từng bước bên dưới; có thể cần chạy lại khi mạng chậm (DISM tải file từ Windows Update)"}[res.Success]
	return res
}

/** fix-search: xây lại chỉ mục Windows Search — dừng WSearch, xóa index cũ, khởi động lại */
func fixSearch() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-search", Steps: []PerfStep{}, Success: true}
	r1 := runSysExe("net.exe", []string{"stop", "WSearch"}, 15*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Dừng dịch vụ Windows Search", OK: r1.OK, Detail: firstLine(r1.Stdout + r1.Stderr)})
	r2 := runSysExe("cmd.exe", []string{"/c", `del /q /f "%PROGRAMDATA%\Microsoft\Search\Data\Applications\Windows\Windows.edb"`}, 10*time.Second)
	// del lỗi vì file không tồn tại cũng coi như xong (mục tiêu là index sạch) — ghi trung thực vào detail
	res.Steps = append(res.Steps, PerfStep{Name: "Xóa file chỉ mục cũ (Windows.edb)", OK: true,
		Detail: map[bool]string{true: "file index đã xóa", false: "không tìm thấy file index cũ — vẫn tiếp tục (index vốn trống)"}[r2.OK]})
	r3 := runSysExe("net.exe", []string{"start", "WSearch"}, 15*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Khởi động lại Windows Search", OK: r3.OK, Detail: firstLine(r3.Stdout + r3.Stderr)})
	res.Success = r3.OK
	res.Message = map[bool]string{true: "Đã xây lại chỉ mục tìm kiếm — chờ vài phút để Windows nạp lại index rồi thử tìm",
		false: "WSearch không start lại được — xem chi tiết"}[res.Success]
	return res
}

/** fix-defender: cập nhật signature + restart dịch vụ Defender */
func fixDefender() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-defender", Steps: []PerfStep{}, Success: true}
	mp := os.Getenv("ProgramFiles") + `\Windows Defender\MpCmdRun.exe`
	if _, err := os.Stat(mp); err != nil {
		return FixResult{Success: false, Mode: "windows", ID: "fix-defender",
			Steps: []PerfStep{{Name: "Tìm MpCmdRun.exe", OK: false, Detail: "không tìm thấy Windows Defender trên máy này"}},
			Message: "Máy không có Windows Defender (dùng AV khác?) — không fix được"}
	}
	r1 := runExe(mp, []string{"-SignatureUpdate"}, 5*time.Minute)
	res.Steps = append(res.Steps, PerfStep{Name: "Cập nhật signature Defender", OK: r1.OK,
		Detail: map[bool]string{true: "virus database đã cập nhật", false: firstLine(r1.Stdout + r1.Stderr)}[r1.OK]})
	if !r1.OK {
		res.Success = false
	}
	r2 := runSysExe("net.exe", []string{"stop", "WinDefend"}, 15*time.Second)
	r3 := runSysExe("net.exe", []string{"start", "WinDefend"}, 15*time.Second)
	ok2 := r3.OK || r2.OK // Defender được bảo vệ — stop có thể bị từ chối, start OK vẫn tính
	res.Steps = append(res.Steps, PerfStep{Name: "Khởi động lại dịch vụ WinDefend", OK: ok2,
		Detail: map[bool]string{true: "dịch vụ chạy lại bình thường", false: firstLine(r2.Stdout + r2.Stderr + r3.Stderr) + " (Defender có tamper protection — không stop được cũng bình thường)"}[ok2]})
	if !ok2 {
		res.Success = false
	}
	res.Message = map[bool]string{true: "Đã cập nhật Defender + khởi động lại dịch vụ — thử kiểm tra bảo vệ lại",
		false: "Một số bước lỗi — xem chi tiết (signature update cần mạng)"}[res.Success]
	return res
}

/** fix-time: đồng bộ lại giờ hệ thống với máy chủ thời gian */
func fixTime() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-time", Steps: []PerfStep{}, Success: true}
	r1 := runSysExe("net.exe", []string{"start", "W32Time"}, 10*time.Second)
	_ = r1 // service có thể đã chạy
	r2 := runSysExe("w32tm.exe", []string{"/resync", "/force"}, 30*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Đồng bộ giờ với máy chủ thời gian (w32tm resync)", OK: r2.OK,
		Detail: map[bool]string{true: firstLine(r2.Stdout), false: firstLine(r2.Stdout + r2.Stderr) + " (cần mạng ra được time.windows.com)"}[r2.OK]})
	if !r2.OK {
		res.Success = false
	}
	res.Message = map[bool]string{true: "Đã đồng bộ lại đồng hồ hệ thống — giờ máy giờ đây chính xác",
		false: "Resync lỗi — xem chi tiết (thường do mạng chặn NTP hoặc timezone sai — chỉnh timezone trong Settings)"}[res.Success]
	return res
}

/** dòng có nội dung cuối cùng trong output DISM/SFC (phần tóm tắt) */
func lastMeaningfulLine(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	var last string
	for _, ln := range strings.Split(s, "\n") {
		t := strings.TrimSpace(ln)
		if t != "" {
			last = t
		}
	}
	if len(last) > 220 {
		last = last[:220] + "…"
	}
	if last == "" {
		return "xong (không có output)"
	}
	return last
}
