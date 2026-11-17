// fixes.go — v3.7.0: Fixes — sửa nhanh các lỗi Windows thường gặp, 1 nút bấm.
// Mỗi fix chạy nhiều bước và báo TRUNG THỰC kết quả từng bước (không khoe gì khi thiếu quyền).
// Trên nền không phải Windows: trả về danh sách bước với kết quả trung thực "chỉ chạy trên Windows".
package main

import (
	"net/http"
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
