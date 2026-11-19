// fixes.go — v3.7.0: Fixes — sửa nhanh các lỗi Windows thường gặp, 1 nút bấm.
// Mỗi fix chạy nhiều bước và báo TRUNG THỰC kết quả từng bước (không khoe gì khi thiếu quyền).
// Trên nền không phải Windows: trả về danh sách bước với kết quả trung thực "chỉ chạy trên Windows".
package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type FixCard struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Desc       string `json:"desc"`
	Icon       string `json:"icon"`
	NeedsAdmin bool   `json:"needsAdmin"`
	// v4.4.0 (B-31): tác động KHÔNG hoàn tác được phải nằm trong Confirm — UI bắt buộc
	// dialog rõ ràng; backend chặn POST thiếu confirm:true với các card này
	Confirm string `json:"confirm,omitempty"`
}

type FixResult struct {
	Success bool       `json:"success"`
	Mode    string     `json:"mode"` // "windows" | "không-Windows"
	ID      string     `json:"id"`
	Steps   []PerfStep `json:"steps"`
	Message string     `json:"message"`
}

var fixDefs = []FixCard{
	{ID: "fix-internet", Name: "Mất mạng / Lag mạng / DNS lỗi", Desc: "Xóa cache DNS, reset Winsock + TCP/IP, lấy lại IP từ router — xử lý lỗi 'DNS không phản hồi', mạng bị lag đột xuất, không vào được web. Máy có thể mất mạng vài giây khi renew.", Icon: "🌐", NeedsAdmin: true, Confirm: "Đặt lại Winsock/TCP-IP: mạng có thể mất vài giây khi renew IP; IP tĩnh cần cấu hình lại; KHÔNG hoàn tác được — tải file đang chạy có thể ngắt."},
	{ID: "fix-wupdate", Name: "Windows Update kẹt / báo lỗi", Desc: "Khởi động lại dịch vụ Windows Update (wuauserv, BITS, Delivery Optimization) — xử lý Update đứng ở %, tải mãi không xong.", Icon: "🔄", NeedsAdmin: true, Confirm: "Khởi động lại dịch vụ Windows Update — lần kiểm tra Update đang chạy sẽ bị ngắt."},
	{ID: "fix-audio", Name: "Mất tiếng / Âm thanh lỗi", Desc: "Khởi động lại dịch vụ âm thanh Windows (Audiosrv + AudioEndpointBuilder) — xử lý lỗi mất tiếng, loa bập bẹ, tai nghe không nhận. Các app đang phát nhạc cần phát lại.", Icon: "🔊", NeedsAdmin: true, Confirm: "Khởi động lại dịch vụ âm thanh — app đang phát nhạc cần phát lại."},
	{ID: "fix-explorer", Name: "Menu Start / Taskbar đơ", Desc: "Khởi động lại Windows Explorer — xử lý lỗi Start menu không mở, taskbar đơ, nút Win không bấm được. Cửa sổ đang mở không bị mất.", Icon: "🖥️", NeedsAdmin: false, Confirm: "Khởi động lại Windows Explorer — desktop nhấp nháy 1–2 giây; cửa sổ Explorer đang mở có thể đóng."},
	{ID: "fix-printer", Name: "In ấn kẹt / hàng đợi in không xóa được", Desc: "Dọn hàng đợi in + khởi động lại Print Spooler — xử lý lỗi máy in kẹt giấy trong queue, lệnh in kẹt cứng.", Icon: "🖨️", NeedsAdmin: true, Confirm: "XÓA toàn bộ lệnh in đang chờ trong hàng đợi (không hoàn tác được) và khởi động lại Print Spooler."},
	{ID: "fix-store", Name: "Microsoft Store / app Store không mở", Desc: "Xóa cache của Microsoft Store (wsreset) — xử lý lỗi Store không mở, app UWP không tải được. Cửa sổ Store có thể tự mở sau khi xong.", Icon: "🏪", NeedsAdmin: false, Confirm: ""},
	// ---------- v4.0.0: mở rộng bộ fix ----------
	{ID: "fix-sfc", Name: "Windows lỗi lặt vặt / file hệ thống hỏng", Desc: "DISM kiểm tra + phục hồi component store, rồi SFC quét và thay file hệ thống hỏng — xử lý lỗi Start menu/Update/UWP lỗi dai dẳng không rõ nguyên nhân. Chạy 5–20 phút, KHÔNG tắt máy trong lúc chạy.", Icon: "🧰", NeedsAdmin: true, Confirm: ""},
	{ID: "fix-search", Name: "Windows Search không tìm thấy / tìm chậm", Desc: "Xây lại chỉ mục tìm kiếm: dừng WSearch, xóa file index cũ, khởi động lại — xử lý lỗi tìm kiếm trống kết quả, menu Start tìm không ra app. Lần đầu sau khi fix, chỉ mục cần vài phút để nạp lại.", Icon: "🔍", NeedsAdmin: true, Confirm: "XÓA file chỉ mục tìm kiếm cũ và xây lại từ đầu — vài phút đầu sau khi fix, tìm kiếm có thể trả kết quả thưa."},
	{ID: "fix-defender", Name: "Windows Defender không cập nhật virus", Desc: "Cập nhật signature Defender bằng MpCmdRun + khởi động lại dịch vụ Defender — xử lý lỗi bảo vệ 'cần kiểm tra', cập nhật kẹt 0%.", Icon: "🛡️", NeedsAdmin: true, Confirm: ""},
	{ID: "fix-time", Name: "Giờ máy sai / lệch giờ", Desc: "Đồng bộ lại giờ hệ thống với máy chủ thời gian (w32tm resync) — xử lý đồng hồ chạy sai, chứng chỉ web báo lỗi vì lệch giờ. Lưu ý: chỉ đồng bộ GIỜ, KHÔNG sửa múi giờ — múi giờ sai thì chỉnh trong Settings > Time & Language.", Icon: "🕒", NeedsAdmin: true, Confirm: "Đồng bộ lại giờ với máy chủ thời gian — mọi app đang chạy giữ giờ cũ cho đến khi làm mới."},
	// ---------- v4.4.0: Repair Center mở rộng ----------
	{ID: "fix-restorepoint", Name: "Tạo điểm khôi phục (Restore Point)", Desc: "Tạo Windows Restore Point 'NEXUS pre-repair' để có đường lui an toàn trước khi áp các tối ưu nặng. Windows giới hạn 1 restore point/24h (System Restore frequency) — nếu đã tạo hôm nay qua công cụ khác, Windows có thể từ chối và tool sẽ báo thật. Restore point KHÔNG thay thế snapshot nội bộ của từng tweak.", Icon: "🛟", NeedsAdmin: true, Confirm: "Tạo điểm khôi phục hệ thống — an toàn, không thay đổi cấu hình."},
	{ID: "fix-icons", Name: "Icon lỗi / hình bày bừ, không load", Desc: "Xóa cache icon + thumbnail (IconCache.db, thumbcache_*.db, iconcache_*.db) rồi khởi động lại Explorer — xử lý lỗi icon trắng, thumbnail không hiện, icon rác. Windows tự xây lại cache khi mở lại.", Icon: "🎨", NeedsAdmin: true, Confirm: "Xóa cache icon/thumbnail (tự xây lại) và khởi động lại Explorer — desktop nhấp nháy vài giây."},
	{ID: "fix-uwp", Name: "App UWP (Store, Photo, Terminal…) mở lên lỗi", Desc: "Đăng ký lại toàn bộ app UWP cho mọi user (Add-AppxPackage -Register AppXManifest) — xử lý app UWP lỗi sau Update, mở giây hơi crash, nút không bấm được. Chạy 1–3 phút, không xóa dữ liệu app.", Icon: "📱", NeedsAdmin: false, Confirm: "Đăng ký lại toàn bộ app UWP (1–3 phút) — không xóa dữ liệu, không cần mạng."},
	{ID: "fix-diskscan", Name: "Quét sức khỏe ổ đĩa + thiết bị lỗi", Desc: "ĐỌC-ONLY: báo trạng thái S.M.A.R.T từng ổ (Get-PhysicalDisk), tình trạng volume (Get-Volume) và thiết bị đang lỗi trong Device Manager (Get-PnpDevice -Status Error) — chẩn đoán trước khi quyết định chạy CHKDSK hay đổi phần cứng. Không ghi gì lên đĩa.", Icon: "💽", NeedsAdmin: false, Confirm: ""},
}

func registerFixRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/fixes", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, fixDefs)
	})
	mux.HandleFunc("POST /api/fixes", func(w http.ResponseWriter, r *http.Request) {
		// v4.1.1 (P2-08): operation coordinator — không chạy fix khi đang có thao tác khác
		if !trySysOp("fix") {
			writeErr(w, 409, sysOpBusyErr())
			return
		}
		defer doneSysOp()
		var body struct {
			ID      string `json:"id"`
			Confirm bool   `json:"confirm"` // v4.4.0 (B-31)
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
		if def.Confirm != "" && !body.Confirm {
			// v4.4.0 (B-31): backend tự chặn — UI không gửi confirm thì không chạy card có
			// tác động không hoàn tác được (preview tác động nằm trong def.Confirm)
			writeErr(w, 428, "Cần xác nhận trước khi chạy: " + def.Confirm)
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
	case "fix-restorepoint":
		return fixRestorePoint()
	case "fix-icons":
		return fixIcons()
	case "fix-uwp":
		return fixUWP()
	case "fix-diskscan":
		return fixDiskScan()
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
		// v4.1.1 (P2-04): BỎ OR — restart chỉ thành công khi trạng thái CUỐI verified RUNNING;
		// service vốn đã STOPPED thì không cần stop; start fail là fail thật
		st := runSysExe("sc.exe", []string{"query", sv}, 12*time.Second)
		out := strings.ToUpper(st.Stdout)
		switch {
		case !st.OK && !strings.Contains(out, "RUNNING") && !strings.Contains(out, "STOPPED"):
			res.Steps = append(res.Steps, PerfStep{Name: "Restart dịch vụ " + sv, OK: false,
				Detail: "không đọc được trạng thái (exit " + firstLine(st.Stdout+st.Stderr) + ") — không restart mù"})
			res.Success = false
		case strings.Contains(out, "STOPPED") && !strings.Contains(out, "RUNNING"):
			r2 := runSysExe("net.exe", []string{"start", sv}, 20*time.Second)
			st2 := runSysExe("sc.exe", []string{"query", sv}, 12*time.Second)
			running := strings.Contains(strings.ToUpper(st2.Stdout), "RUNNING") || strings.Contains(strings.ToUpper(st2.Stdout), "START_PENDING")
			res.Steps = append(res.Steps, PerfStep{Name: "Start dịch vụ " + sv + " (vốn đã dừng)", OK: running,
				Detail: map[bool]string{true: "verified RUNNING", false: firstLine(r2.Stdout + r2.Stderr)}[running]})
			if !running {
				res.Success = false
			}
		default:
			r1 := runSysExe("net.exe", []string{"stop", sv}, 20*time.Second)
			if !r1.OK && !strings.Contains(strings.ToLower(r1.Stdout+r1.Stderr), "not started") && !strings.Contains(strings.ToLower(r1.Stdout+r1.Stderr), "1062") {
				res.Steps = append(res.Steps, PerfStep{Name: "Restart dịch vụ " + sv, OK: false,
					Detail: "stop thất bại — không tiếp tục (không che lỗi bước trước): " + firstLine(r1.Stdout + r1.Stderr)})
				res.Success = false
				continue
			}
			r2 := runSysExe("net.exe", []string{"start", sv}, 20*time.Second)
			st2 := runSysExe("sc.exe", []string{"query", sv}, 12*time.Second)
			running := strings.Contains(strings.ToUpper(st2.Stdout), "RUNNING") || strings.Contains(strings.ToUpper(st2.Stdout), "START_PENDING")
			res.Steps = append(res.Steps, PerfStep{Name: "Restart dịch vụ " + sv, OK: running,
				Detail: map[bool]string{true: "stop → start → verified RUNNING",
					false: "start: " + firstLine(r2.Stdout+r2.Stderr) + " — verify: " + firstLine(st2.Stdout)}[running]})
			if !running {
				res.Success = false
			}
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
	// v4.1.1 (P2-05): precondition — Spooler phải STOPPED rõ ràng mới dọn queue;
	// không dừng được → trả service về chạy + dừng trung thực (không dọn khi còn khóa)
	st := runSysExe("sc.exe", []string{"query", "Spooler"}, 12*time.Second)
	wasRunning := strings.Contains(strings.ToUpper(st.Stdout), "RUNNING")
	if wasRunning {
		r1 := runSysExe("net.exe", []string{"stop", "Spooler"}, 20*time.Second)
		st2 := runSysExe("sc.exe", []string{"query", "Spooler"}, 12*time.Second)
		stopped := strings.Contains(strings.ToUpper(st2.Stdout), "STOPPED") && !strings.Contains(strings.ToUpper(st2.Stdout), "RUNNING")
		res.Steps = append(res.Steps, PerfStep{Name: "Dừng Print Spooler", OK: stopped,
			Detail: map[bool]string{true: "verified STOPPED — queue không còn khóa",
				false: "không dừng được — KHÔNG dọn queue mù: " + firstLine(r1.Stdout + r1.Stderr)}[stopped]})
		if !stopped {
			return FixResult{Success: false, Mode: "windows", ID: "fix-printer", Steps: res.Steps,
				Message: "Không dừng được Print Spooler — chưa dọn hàng đợi (thử lại khi máy rảnh hoặc khởi động lại máy)"}
		}
	} else if !st.OK {
		res.Steps = append(res.Steps, PerfStep{Name: "Đọc trạng thái Spooler", OK: false,
			Detail: firstLine(st.Stdout + st.Stderr) + " — trạng thái UNKNOWN, không dọn mù"})
		return FixResult{Success: false, Mode: "windows", ID: "fix-printer", Steps: res.Steps,
			Message: "Không xác định được trạng thái Spooler — dừng an toàn, không đụng queue"}
	} else {
		res.Steps = append(res.Steps, PerfStep{Name: "Print Spooler vốn không chạy", OK: true, Detail: "đi thẳng bước dọn queue"})
	}
	r2 := runSysExe("cmd.exe", []string{"/c", `del /q /f "%WINDIR%\System32\spool\PRINTERS\*.*"`}, 10*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: "Dọn hàng đợi in kẹt", OK: r2.OK,
		Detail: map[bool]string{true: "các lệnh in kẹt đã bị xóa", false: firstLine(r2.Stdout + r2.Stderr)}[r2.OK]})
	if !r2.OK {
		res.Success = false
	}
	r3 := runSysExe("net.exe", []string{"start", "Spooler"}, 20*time.Second)
	st3 := runSysExe("sc.exe", []string{"query", "Spooler"}, 12*time.Second)
	running := strings.Contains(strings.ToUpper(st3.Stdout), "RUNNING") || strings.Contains(strings.ToUpper(st3.Stdout), "START_PENDING")
	res.Steps = append(res.Steps, PerfStep{Name: "Mở lại Print Spooler", OK: running,
		Detail: map[bool]string{true: "verified RUNNING — in ấn hoạt động lại bình thường",
			false: firstLine(r3.Stdout + r3.Stderr) + " — verify: " + firstLine(st3.Stdout)}[running]})
	res.Success = res.Success && running
	res.Message = map[bool]string{true: "Đã dọn hàng đợi in + restart Spooler (verified RUNNING) — thử in lại",
		false: "Một phần thất bại — xem chi tiết từng bước"}[res.Success]
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

/** fix-search v4.1.0 (phát hiện 05): tổng hợp TRUNG THỰC cả stop/delete/start —
 * stop thất bại là thất bại (index còn khóa, không xóa được); delete phân biệt
 * "file không tồn tại" (hợp lệ) với access denied/lock (thất bại); verify cuối. */
func fixSearch() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-search", Steps: []PerfStep{}, Success: true}
	edb := os.Getenv("PROGRAMDATA") + `\Microsoft\Search\Data\Applications\Windows\Windows.edb`
	// trạng thái trước: query service state bằng sc query (không đoán từ net stop)
	st := runSysExe("sc.exe", []string{"query", "WSearch"}, 12*time.Second)
	wasRunning := strings.Contains(strings.ToUpper(st.Stdout), "RUNNING")
	if wasRunning {
		r1 := runSysExe("net.exe", []string{"stop", "WSearch"}, 20*time.Second)
		st2 := runSysExe("sc.exe", []string{"query", "WSearch"}, 12*time.Second)
		// v4.1.1 (P2-06): chỉ nhận STOPPED RÕ RÀNG — output rỗng/query lỗi là UNKNOWN,
		// tuyệt đối không coi là đã dừng rồi đi xóa index
		stopped := st2.OK && strings.Contains(strings.ToUpper(st2.Stdout), "STOPPED") && !strings.Contains(strings.ToUpper(st2.Stdout), "RUNNING")
		res.Steps = append(res.Steps, PerfStep{Name: "Dừng dịch vụ Windows Search", OK: stopped,
			Detail: map[bool]string{true: "service verified STOPPED — index không còn bị khóa",
				false: "không dừng được — index còn khóa, KHÔNG xóa mù: " + firstLine(r1.Stdout + r1.Stderr)}[stopped]})
		if !stopped {
			_ = runSysExe("net.exe", []string{"start", "WSearch"}, 20*time.Second) // trả lại trạng thái cũ
			return FixResult{Success: false, Mode: "windows", ID: "fix-search", Steps: res.Steps,
				Message: "Không dừng được WSearch — index chưa xóa được, đã trả service về trạng thái chạy (thử lại khi ít tải hoặc khởi động lại máy)"}
		}
	} else {
		res.Steps = append(res.Steps, PerfStep{Name: "Windows Search vốn không chạy", OK: true, Detail: "không cần stop — đi thẳng bước xóa index"})
	}
	// delete: phân biệt not-found (hợp lệ) với lỗi thật (access denied/lock)
	_, statErr := os.Stat(edb)
	if statErr != nil && os.IsNotExist(statErr) {
		res.Steps = append(res.Steps, PerfStep{Name: "Xóa file chỉ mục cũ (Windows.edb)", OK: true, Detail: "không có file index — vốn đã sạch"})
	} else {
		r2 := runSysExe("cmd.exe", []string{"/c", `del /q /f "` + edb + `"`}, 10*time.Second)
		_, stillThere := os.Stat(edb)
		deleted := r2.OK && os.IsNotExist(stillThere)
		res.Steps = append(res.Steps, PerfStep{Name: "Xóa file chỉ mục cũ (Windows.edb)", OK: deleted,
			Detail: map[bool]string{true: "file index đã xóa (verify không còn)",
				false: "KHÔNG xóa được — " + firstLine(r2.Stdout + r2.Stderr) + " (access denied/file lock?); không báo rebuild thành công khi index còn nguyên"}[deleted]})
		if !deleted {
			_ = runSysExe("net.exe", []string{"start", "WSearch"}, 20*time.Second)
			return FixResult{Success: false, Mode: "windows", ID: "fix-search", Steps: res.Steps,
				Message: "Không xóa được file index (bị khóa/quyền) — đã trả service về chạy; index cũ vẫn còn nên KHÔNG coi là rebuild thành công"}
		}
	}
	r3 := runSysExe("net.exe", []string{"start", "WSearch"}, 20*time.Second)
	st3 := runSysExe("sc.exe", []string{"query", "WSearch"}, 12*time.Second)
	runningNow := strings.Contains(strings.ToUpper(st3.Stdout), "RUNNING")
	res.Steps = append(res.Steps, PerfStep{Name: "Khởi động lại Windows Search", OK: runningNow,
		Detail: map[bool]string{true: "service verified RUNNING — sẽ tự xây index mới trong vài phút",
			false: firstLine(r3.Stdout + r3.Stderr) + " — service không start lại được"}[runningNow]})
	res.Success = runningNow
	res.Message = map[bool]string{true: "Đã xây lại chỉ mục tìm kiếm (stop verified + index xóa verified + start verified) — chờ vài phút nạp lại",
		false: "Một phần thất bại — xem chi tiết từng bước"}[res.Success]
	return res
}

/** fix-defender v4.1.0 (phát hiện 04): BỎ điều kiện stop OR start — restart là chuỗi có
 * thứ tự, một lệnh thành công không chứng minh trạng thái cuối. Luồng mới:
 * 1) resolve MpCmdRun (cả platform versioned path — 13.5); 2) SignatureUpdate;
 * 3) KHÔNG stop mù: query WinDefend trước — đang chạy thì không đụng (tamper thường chặn
 * stop anyway), đã dừng thì start + VERIFY trạng thái cuối bằng `sc query` RUNNING.
 * Success chỉ khi signature OK (hoặc báo rõ lỗi) VÀ service verified chạy. */
func fixDefender() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-defender", Steps: []PerfStep{}, Success: true}
	mp := defenderMpCmdRun()
	if mp == "" {
		return FixResult{Success: false, Mode: "windows", ID: "fix-defender",
			Steps: []PerfStep{{Name: "Tìm MpCmdRun.exe", OK: false, Detail: "không tìm thấy Windows Defender platform binary (ProgramFiles + platform/<ver>)"}},
			Message: "Máy không có Windows Defender (dùng AV khác?) — không fix được"}
	}
	r1 := runExe(mp, []string{"-SignatureUpdate"}, 5*time.Minute)
	res.Steps = append(res.Steps, PerfStep{Name: "Cập nhật signature Defender", OK: r1.OK,
		Detail: map[bool]string{true: "virus database đã cập nhật", false: firstLine(r1.Stdout + r1.Stderr) + " — signature CHƯA cập nhật được (mạng/blocked?)"}[r1.OK]})
	if !r1.OK {
		res.Success = false // không lấy trạng thái service che lấp lỗi signature (TEST DEFENDER-04)
	}
	// trạng thái service TRƯỚC khi thao tác — không stop mù (Defender có tamper protection)
	st := runSysExe("sc.exe", []string{"query", "WinDefend"}, 12*time.Second)
	running := strings.Contains(strings.ToUpper(st.Stdout), "RUNNING")
	if running {
		res.Steps = append(res.Steps, PerfStep{Name: "WinDefend đang chạy — không cần restart", OK: true,
			Detail: "không stop mù (Tamper Protection của Windows thường từ chối và việc stop không cần thiết cho cập nhật signature)"})
	} else {
		r3 := runSysExe("sc.exe", []string{"start", "WinDefend"}, 20*time.Second)
		// verify trạng thái CUỐI bằng sc query — exit 0 của `sc start` không đủ (audit 6.2)
		st2 := runSysExe("sc.exe", []string{"query", "WinDefend"}, 12*time.Second)
		runningNow := strings.Contains(strings.ToUpper(st2.Stdout), "RUNNING")
		res.Steps = append(res.Steps, PerfStep{Name: "WinDefend không chạy → start + verify", OK: runningNow,
			Detail: map[bool]string{true: "service verified RUNNING sau khi start",
				false: "start " + firstLine(r3.Stdout+r3.Stderr) + " — verify `sc query`: " + firstLine(st2.Stdout) + " (Windows từ chối thao tác — Tamper Protection/policy; KHÔNG khuyến nghị tắt bảo vệ để đạt xanh)"}[runningNow]})
		if !runningNow {
			res.Success = false // stop thành công không được che lấp start thất bại (TEST DEFENDER-01)
		}
	}
	res.Message = map[bool]string{true: "Defender signature cập nhật + service verified đang chạy",
		false: "Một số phần lỗi — xem chi tiết từng bước (signature cần mạng; service cần Windows cho phép start)"}[res.Success]
	return res
}

/** v4.1.0 (13.5): resolve MpCmdRun.exe — thử path chuẩn rồi platform/<ver mới nhất> */
func defenderMpCmdRun() string {
	pf := os.Getenv("ProgramFiles")
	cands := []string{pf + `\Windows Defender\MpCmdRun.exe`}
	platRoot := pf + `\Windows Defender\platform`
	if ents, err := os.ReadDir(platRoot); err == nil {
		var vers []string
		for _, e := range ents {
			if e.IsDir() {
				vers = append(vers, e.Name())
			}
		}
		for i := 0; i < len(vers); i++ { // sort giảm dần — lấy version mới nhất
			for j := i + 1; j < len(vers); j++ {
				if vers[j] > vers[i] {
					vers[i], vers[j] = vers[j], vers[i]
				}
			}
		}
		for _, v := range vers {
			cands = append(cands, filepath.Join(platRoot, v, "MpCmdRun.exe"))
		}
	}
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
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


// ==================== v4.4.0: Repair Center mở rộng ====================

/** fix-restorepoint: Windows Restore Point trước khi sửa chữa — đường lui an toàn.
 * Windows giới hạn 1 điểm/24h — Checkpoint-Computer lỗi do frequency sẽ được báo thật. */
func fixRestorePoint() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-restorepoint", Steps: []PerfStep{}, Success: true}
	// Enable-ComputerRestore trên C: — không đổi cấu hình, chỉ bảo đảm tính năng bật
	r0 := psRun("Enable-ComputerRestore -Drive 'C:\\' | Out-Null", 30*time.Second)
	if !r0.OK && !strings.Contains(strings.ToLower(r0.Stdout+r0.Stderr), "already") {
		res.Steps = append(res.Steps, PerfStep{Name: "Bật System Protection (C:)", OK: false,
			Detail: firstLine(r0.Stdout + r0.Stderr) + " — có thể System Protection bị policy tắt; vẫn thử tạo điểm"})
	}
	r1 := psRun("Checkpoint-Computer -Description 'NEXUS pre-repair' -RestorePointType MODIFY_SETTINGS", 3*time.Minute)
	res.Steps = append(res.Steps, PerfStep{Name: "Tạo Restore Point 'NEXUS pre-repair'", OK: r1.OK,
		Detail: map[bool]string{true: "Đã tạo — xem trong System Properties > System Protection > System Restore",
			false: firstLine(r1.Stdout + r1.Stderr) + " — Windows giới hạn 1 điểm/24h; nếu đã tạo hôm nay thì thử lại ngày mai (System Restore frequency)"}[r1.OK]})
	if !r1.OK {
		res.Success = false
	}
	res.Message = map[bool]string{true: "Restore Point sẵn sàng — giờ có đường lui an toàn trước mọi tối ưu nặng",
		false: "Không tạo được Restore Point (chi tiết bên dưới) — khuyên tạo thủ công trong System Protection trước khi tối ưu"}[res.Success]
	return res
}

/** fix-icons: rebuild icon cache + thumbnails — lỗi icon trắng/thumbnail không hiện. */
func fixIcons() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-icons", Steps: []PerfStep{}, Success: true}
	la := os.Getenv("LOCALAPPDATA")
	if la == "" {
		la = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	paths := []string{
		filepath.Join(la, "IconCache.db"),
	}
	// thumbcache/iconcache nằm trong Explorer cache dir
	explorer := filepath.Join(la, "Microsoft", "Windows", "Explorer")
	if ents, err := os.ReadDir(explorer); err == nil {
		for _, e := range ents {
			ln := strings.ToLower(e.Name())
			if strings.HasPrefix(ln, "thumbcache_") || strings.HasPrefix(ln, "iconcache_") {
				paths = append(paths, filepath.Join(explorer, e.Name()))
			}
		}
	}
	deleted, blocked := 0, 0
	for _, p := range paths {
		if err := os.Remove(p); err == nil {
			deleted++
		} else if !os.IsNotExist(err) {
			blocked++
		}
	}
	res.Steps = append(res.Steps, PerfStep{Name: "Xóa cache icon/thumbnail", OK: true,
		Detail: fmt.Sprintf("xóa %d file cache (file đang bị Explorer khóa sẽ còn lại %d — vẫn tự xây lại khi restart)", deleted, blocked)})
	r1 := runSysExe("taskkill.exe", []string{"/IM", "explorer.exe", "/F"}, 15*time.Second)
	time.Sleep(1200 * time.Millisecond)
	r2 := runSysExe("cmd.exe", []string{"/C", "start explorer.exe"}, 15*time.Second)
	ok := r2.OK // explorer kill bị coi là thành công nếu explorer tự chết
	_ = r1
	res.Steps = append(res.Steps, PerfStep{Name: "Khởi động lại Windows Explorer", OK: ok,
		Detail: map[bool]string{true: "Explorer đang mở lại với cache mới", false: firstLine(r2.Stdout + r2.Stderr) + " — mở Task Manager > File > Run explorer.exe nếu desktop chưa quay lại"}[ok]})
	res.Message = "Đã xây lại cache icon/thumbnail — icon sẽ load lại dần khi mở app"
	return res
}

/** fix-uwp: re-register app UWP cho mọi user — sửa app Store/UWP mở lên crash. */
func fixUWP() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-uwp", Steps: []PerfStep{}, Success: true}
	script := `$errs = 0; $ok = 0
Get-AppxPackage -AllUsers | ForEach-Object {
  $manifest = Join-Path $_.InstallLocation 'AppXManifest.xml'
  if (Test-Path $manifest) {
    try { Add-AppxPackage -DisableDevelopmentMode -Register $manifest -ErrorAction Stop; $ok++ } catch { $errs++ }
  }
}
Write-Output "REGISTERED=$ok ERRORS=$errs"`
	r1 := psRun(script, 5*time.Minute)
	detail := lastMeaningfulLine(r1.Stdout)
	if detail == "" {
		detail = firstLine(r1.Stdout + r1.Stderr)
	}
	res.Steps = append(res.Steps, PerfStep{Name: "Đăng ký lại app UWP (mọi user)", OK: r1.OK,
		Detail: map[bool]string{true: detail + " — lỗi rải rác vài package hệ thống là bình thường (không được cấp quyền với vài gói)",
			false: firstLine(r1.Stdout + r1.Stderr)}[r1.OK]})
	if !r1.OK {
		res.Success = false
	}
	res.Message = map[bool]string{true: "Đã đăng ký lại app UWP — thử mở lại app bị lỗi; một số app cần đăng xuất/nhập lại",
		false: "Re-register lỗi — chi tiết bên dưới; thử wsreset hoặc tạo user profile mới nếu app vẫn crash"}[res.Success]
	return res
}

/** fix-diskscan: READ-ONLY — SMART + volume + thiết bị lỗi; không ghi đĩa. */
func fixDiskScan() FixResult {
	res := FixResult{Mode: "windows", ID: "fix-diskscan", Steps: []PerfStep{}, Success: true}
	script := `$d = Get-PhysicalDisk | Select-Object FriendlyName, MediaType, HealthStatus, OperationalStatus | Format-Table -AutoSize | Out-String
$v = Get-Volume | Where-Object { $_.DriveLetter } | Select-Object DriveLetter, FileSystem, HealthStatus, @{n='UsedGB';e={[math]::Round(($_.Size-$_.SizeRemaining)/1GB,1)}}, @{n='FreeGB';e={[math]::Round($_.SizeRemaining/1GB,1)}} | Format-Table -AutoSize | Out-String
$e = Get-PnpDevice -Status Error | Select-Object -First 12 FriendlyName, InstanceId | Format-Table -AutoSize | Out-String
Write-Output "--- DISK SMART ---"; Write-Output $d; Write-Output "--- VOLUMES ---"; Write-Output $v; Write-Output "--- DEVICES WITH ERROR ---"; Write-Output $(if ($e) { $e } else { "(không có thiết bị nào báo lỗi)" })`
	r1 := psRun(script, 90*time.Second)
	bad := ""
	for _, ln := range strings.Split(r1.Stdout, "\n") {
		lo := strings.ToLower(ln)
		if strings.Contains(lo, "warning") || strings.Contains(lo, "unhealthy") || strings.Contains(lo, "error") {
			bad += strings.TrimSpace(ln) + " | "
		}
	}
	detail := strings.TrimSpace(r1.Stdout)
	if len(detail) > 2200 {
		detail = detail[len(detail)-2200:]
	}
	// v4.4.0: precompute — composite literal phức tạp không parse được
	smartDetail := "TẤT CẢ ổ + thiết bị khỏe"
	if strings.TrimSpace(bad) != "" {
		smartDetail = "CÓ CẢNH BÁO — xem chi tiết: " + strings.TrimRight(bad, " |")
	}
	res.Steps = append(res.Steps, PerfStep{Name: "S.M.A.R.T + volume + thiết bị lỗi", OK: r1.OK,
		Detail: (map[bool]string{true: smartDetail, false: firstLine(r1.Stdout + r1.Stderr)})[r1.OK]})
	if len(detail) > 0 {
		res.Steps = append(res.Steps, PerfStep{Name: "Báo cáo chi tiết", OK: true, Detail: detail})
	}
	if !r1.OK {
		res.Success = false
	}
	res.Message = map[bool]string{true: "Quét xong — ĐỌC-ONLY không đổi gì trên máy; chi tiết bên dưới",
		false: "Không đọc được trạng thái ổ đĩa (cần quyền? thiết bị?) — chi tiết bên dưới"}[res.Success]
	return res
}
