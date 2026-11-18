// services_cat.go — v3.8.0: tab Dịch vụ (Services) kiểu tham chiếu:
// 4 nhóm dịch vụ Windows thật, mỗi mục tắt/khôi phục riêng qua `sc config start= disabled`,
// trạng thái đọc LIVE bằng `sc qc` (không lưu trạng thái ảo), preset Off/Minimum/Medium/Extreme,
// card Disable Defender trung thực (Tamper Protection chặn thì báo thẳng).
// Nền không-Windows: trả về view trung thực "chỉ chạy trên Windows".
package main

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

type SvcRef struct {
	Name    string `json:"name"`
	Default string `json:"default"` // auto | delayed-auto | demand | disabled
}

type SvcItem struct {
	ID, Name, Desc, Icon string
	Warning              string   `json:"warning,omitempty"`
	Services             []SvcRef `json:"services"`
	AmdDynamic           bool     `json:"amdDynamic,omitempty"` // dò dịch vụ AMD thật trên máy
}

type SvcGroup struct {
	ID, Name, Icon, Tone string // tone: red | orange | teal | purple
	Items                []SvcItem
}

type SvcSvcState struct {
	Name    string `json:"name"`
	Default string `json:"default"`
	State   string `json:"state"` // disabled | auto | delayed-auto | demand | unknown
	Found   bool   `json:"found"`
}

type SvcItemState struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	Desc       string        `json:"desc"`
	Icon       string        `json:"icon"`
	Warning    string        `json:"warning,omitempty"`
	Services   []SvcSvcState `json:"services"`
	State      string        `json:"state"` // off | partial | default | na
	AmdDynamic bool          `json:"amdDynamic,omitempty"`
}

type SvcGroupState struct {
	ID    string         `json:"id"`
	Name  string         `json:"name"`
	Icon  string         `json:"icon"`
	Tone  string         `json:"tone"`
	State string         `json:"state"`
	Items []SvcItemState `json:"items"`
}

type ServicesView struct {
	Mode     string          `json:"mode"`
	Groups   []SvcGroupState `json:"groups"`
	Defender DefenderInfo    `json:"defender"`
}

type DefenderInfo struct {
	Available bool `json:"available"`
	Applied   bool `json:"applied"`
}

type ServicesActionResult struct {
	Success bool       `json:"success"`
	Mode    string     `json:"mode"`
	Action  string     `json:"action"`
	Steps   []PerfStep `json:"steps"`
	Message string     `json:"message"`
}

var svcGroups = []SvcGroup{
	{"user", "User Features", "🧑", "red", []SvcItem{
		{"usr-platform", "Tắt Platform & Devices",
			"Hyper-V máy ảo, kiểm soát gia đình, dịch vụ điện thoại, ví điện tử — các nền tảng phần lớn người chơi game không dùng.",
			"🧩", "", []SvcRef{
				{"vmms", "demand"}, {"WpcMonSvc", "demand"}, {"PhoneSvc", "demand"}, {"WalletService", "demand"},
			}, false},
		{"usr-comm", "Tắt Communication & Data",
			"Đồng bộ liên thiết bị (CDP) + thông báo đẩy Windows — bớt hoạt động nền; thông báo app vẫn hoạt động bình thường khi mở app.",
			"📡", "", []SvcRef{
				{"CDPSvc", "auto"}, {"WpnService", "auto"},
			}, false},
	}},
	{"connectivity", "Connectivity", "🔗", "orange", []SvcItem{
		{"net-discovery", "Tắt Local & Discovery",
			"Dò thiết bị trên mạng LAN (Function Discovery, SSDP, UPnP) — không cần nếu không chia sẻ file/máy in trong nhà.",
			"🔍", "", []SvcRef{
				{"fdPHost", "demand"}, {"FDResPub", "demand"}, {"SSDPSRV", "demand"}, {"upnphost", "demand"},
			}, false},
		{"net-remote", "Tắt Remote & Sharing",
			"Remote Desktop, Remote Registry, định tuyến RRAS, chia sẻ kết nối (ICS).",
			"🔒", "Tắt xong sẽ KHÔNG remote desktop vào được máy này — nếu bro cần RDP thì đừng bật mục này.",
			[]SvcRef{
				{"RemoteRegistry", "demand"}, {"TermService", "demand"}, {"UmRdpService", "demand"}, {"RemoteAccess", "demand"}, {"SharedAccess", "demand"},
			}, false},
	}},
	{"hardware", "Hardware & Display", "🖥️", "teal", []SvcItem{
		{"hw-peripherals", "Tắt Peripherals & Display",
			"Bàn phím cảm ứng, cảm biến (hướng/vị trí), nhận diện vân tay/khuôn mặt — máy bàn + bàn phím rời không cần.",
			"🖥️", "", []SvcRef{
				{"TabletInputService", "demand"}, {"SensrSvc", "demand"}, {"SensorService", "demand"}, {"WbioSrvc", "demand"},
			}, false},
		{"hw-print", "Tắt Print & Misc",
			"Hàng đợi in, fax, trợ lý tương thích chương trình, tải bản đồ nền.",
			"🖨️", "Còn in ấn thì đừng bật — muốn in lại chỉ cần hoàn tác mục này.",
			[]SvcRef{
				{"Spooler", "auto"}, {"Fax", "disabled"}, {"PcaSvc", "auto"}, {"MapsBroker", "delayed-auto"},
			}, false},
		{"hw-amd", "Tắt AMD Radeon Driver Services",
			"Dịch vụ crash recovery + external events của driver AMD Radeon — chỉ có trên máy dùng card AMD; không có sẽ hiện N/A.",
			"⚙️", "", nil, true},
	}},
	{"windows", "Windows Services", "⊞", "purple", []SvcItem{
		{"win-update", "Tắt Updates & Store/Xbox",
			"Windows Update + BITS + Delivery Optimization + cài đặt Microsoft Store + dịch vụ Xbox.",
			"🎮", "Windows Update sẽ không chạy — bật lại mục này khi cần cập nhật vá bảo mật.",
			[]SvcRef{
				{"wuauserv", "demand"}, {"bits", "demand"}, {"dosvc", "delayed-auto"}, {"UsoSvc", "demand"},
				{"InstallService", "demand"}, {"XblAuthManager", "demand"}, {"XblGameSave", "demand"},
				{"XboxNetApiSvc", "demand"}, {"XboxGipSvc", "demand"},
			}, false},
		{"win-diag", "Tắt Diagnostics & Maintenance",
			"Telemetry trải nghiệm người dùng (DiagTrack), chẩn đoán chính sách, đánh chỉ mục tìm kiếm (WSearch), SysMain/prefetch — nhóm khác biệt rõ nhất trên ổ HDD.",
			"📊", "Tắt WSearch = không tìm được file trong Start menu — bật lại bất cứ lúc nào bằng hoàn tác.",
			[]SvcRef{
				{"DiagTrack", "auto"}, {"DPS", "auto"}, {"WdiSystemHost", "demand"}, {"WdiServiceHost", "demand"},
				{"WSearch", "delayed-auto"}, {"SysMain", "auto"},
			}, false},
	}},
}

var svcPreset = map[string]map[string]bool{ // level → service name (flatten)
	"minimum": {
		"DiagTrack": true, "RemoteRegistry": true, "Fax": true, "MapsBroker": true,
		"PhoneSvc": true, "WalletService": true, "WpcMonSvc": true,
	},
	"medium": {
		"DiagTrack": true, "RemoteRegistry": true, "Fax": true, "MapsBroker": true,
		"PhoneSvc": true, "WalletService": true, "WpcMonSvc": true,
		"fdPHost": true, "FDResPub": true, "SSDPSRV": true, "upnphost": true,
		"TabletInputService": true, "SensrSvc": true, "SensorService": true, "WbioSrvc": true,
		"XblAuthManager": true, "XblGameSave": true, "XboxNetApiSvc": true, "XboxGipSvc": true,
		"vmms": true,
	},
	// extreme: tất cả dịch vụ trong catalog — tính động bên dưới
}

// ---------- Windows: đọc trạng thái live ----------

func scQueryStart(svc string) (found bool, state string) {
	r := runSysExe("sc.exe", []string{"qc", svc}, 6*time.Second)
	out := r.Stdout
	if !strings.Contains(out, "START_TYPE") {
		return false, "unknown"
	}
	if strings.Contains(out, "4  DISABLED") || strings.Contains(out, "4 DISABLED") {
		return true, "disabled"
	}
	if strings.Contains(out, "2  AUTO_START") || strings.Contains(out, "2 AUTO_START") {
		if strings.Contains(out, "DELAYED") {
			return true, "delayed-auto"
		}
		return true, "auto"
	}
	if strings.Contains(out, "3  DEMAND_START") || strings.Contains(out, "3 DEMAND_START") {
		return true, "demand"
	}
	return true, "unknown"
}

func detectAmdServices() []SvcRef {
	r := runSysExe("sc.exe", []string{"query", "state=", "all"}, 12*time.Second)
	var names []string
	for _, line := range strings.Split(r.Stdout, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "SERVICE_NAME") {
			n := strings.TrimSpace(strings.TrimPrefix(line, "SERVICE_NAME:"))
			if strings.Contains(strings.ToLower(n), "amd") || strings.Contains(strings.ToLower(n), "auep") {
				names = append(names, n)
			}
		}
	}
	sort.Strings(names)
	out := make([]SvcRef, 0, len(names))
	for _, n := range names {
		def := "demand"
		if _, st := scQueryStart(n); st == "auto" || st == "delayed-auto" {
			def = "auto"
		}
		out = append(out, SvcRef{n, def})
	}
	return out
}

func itemServices(it SvcItem) []SvcRef {
	if it.AmdDynamic {
		return detectAmdServices()
	}
	return it.Services
}

/** v4.1.0 (phát hiện 09): applySvcBatch viết lại theo audit —
 * DISABLE: query StartType thật (giữ delayed-auto) + runtime state (RUNNING/STOPPED)
 *   → snapshot ghi bền vững TRƯỚC khi đụng sc config; persist lỗi → ABORT cả batch.
 * RESTORE: chỉ đụng service CÓ snapshot (NEXUS từng đổi) — trả đúng StartType gốc
 *   (Manual → Manual, Delayed → Delayed, không suy từ catalog Default), service vốn
 *   đang chạy thì start lại + verify RUNNING; verify StartType read-back sau khi ghi. */
func applySvcBatch(refs []SvcRef, disable bool) (okAll bool, detail string) {
	okAll = true
	var done, failed, skipped, noted []string
	if disable {
		// ---- giai đoạn snapshot: đọc thật, gộp vào section "services", persist 1 lần ----
		snap, _, err := loadAppoptSnap("services")
		if err != nil {
			return false, "không đọc được snapshot services (" + err.Error() + ") — ABORT, không đụng dịch vụ nào"
		}
		pending := map[string]map[string]string{}
		for k, v := range snap {
			pending[k] = v // giữ nguyên snapshot của service khác
		}
		for _, ref := range refs {
			found, startType := scQueryStart(ref.Name)
			if !found {
				skipped = append(skipped, ref.Name+" (không tồn tại)")
				continue
			}
			wasRunning := scQueryRunning(ref.Name)
			pending[ref.Name] = map[string]string{
				"startType": startType,
				"wasRunning": map[bool]string{true: "1", false: "0"}[wasRunning],
			}
		}
		if err := saveAppoptSnap("services", pending); err != nil {
			return false, "KHÔNG LƯU ĐƯỢC snapshot StartType gốc (" + err.Error() + ") — ABORT, không tắt dịch vụ nào (audit 09: snapshot phải persist trước khi disable)"
		}
		// ---- giai đoạn disable ----
		for _, ref := range refs {
			if _, _, found, _ := scQueryStartStrict(ref.Name); !found {
				continue // đã skip khi snapshot
			}
			r := runSysExe("sc.exe", []string{"config", ref.Name, "start=", "disabled"}, 8*time.Second)
			if r.OK {
				// dừng service đang chạy để có tác dụng ngay — vốn dừng thì bỏ qua trung thực
				if sr := runSysExe("sc.exe", []string{"stop", ref.Name}, 8*time.Second); !sr.OK {
					if !strings.Contains(strings.ToLower(sr.Stdout+sr.Stderr), "has not been started") && !strings.Contains(strings.ToLower(sr.Stdout+sr.Stderr), "1062") {
						noted = append(noted, ref.Name+" (stop bị từ chối — có thể vẫn đang chạy)")
					}
				}
				done = append(done, ref.Name)
			} else {
				okAll = false
				failed = append(failed, ref.Name)
			}
		}
	} else {
		// ---- restore: CHỈ service có snapshot; không snapshot → không đụng (09.3) ----
		snap, _, err := loadAppoptSnap("services")
		if err != nil {
			return false, "không đọc được snapshot services (" + err.Error() + ") — KHÔNG restore mù theo catalog default"
		}
		for _, ref := range refs {
			orig, has := snap[ref.Name]
			if !has || orig["startType"] == "" {
				skipped = append(skipped, ref.Name+" (không có snapshot — NEXUS chưa từng đổi, không đụng)")
				continue
			}
			target := orig["startType"]
			r := runSysExe("sc.exe", []string{"config", ref.Name, "start=", target}, 8*time.Second)
			if !r.OK {
				okAll = false
				failed = append(failed, ref.Name)
				continue
			}
			// verify StartType read-back
			_, nowType := scQueryStart(ref.Name)
			if nowType != target {
				okAll = false
				failed = append(failed, ref.Name+" (đã config "+target+" nhưng read-back thấy "+nowType+")")
				continue
			}
			// vốn đang chạy trước khi bị tắt → start lại + verify RUNNING (09.5)
			if orig["wasRunning"] == "1" {
				runSysExe("sc.exe", []string{"start", ref.Name}, 12*time.Second)
				if !scQueryRunning(ref.Name) {
					okAll = false
					failed = append(failed, ref.Name+" (config OK, verify StartType OK nhưng KHÔNG chạy lại được — runtime chưa về gốc)")
					continue
				}
			}
			done = append(done, ref.Name+" → "+target)
			// restore + verify xong → gỡ key khỏi snapshot (section còn phần chưa xong)
			delete(snap, ref.Name)
			if err := saveAppoptSnap("services", snap); err != nil {
				noted = append(noted, ref.Name+" (restore OK nhưng gỡ key snapshot lỗi — sẽ lặp an toàn lần sau)")
			}
		}
	}
	if len(failed) > 0 {
		detail = "lỗi: " + strings.Join(failed, ", ")
	} else {
		detail = "OK: " + strings.Join(done, ", ")
	}
	if len(skipped) > 0 {
		detail += " • bỏ qua: " + strings.Join(skipped, ", ")
	}
	if len(noted) > 0 {
		detail += " • lưu ý: " + strings.Join(noted, ", ")
	}
	return okAll, detail
}

/** runtime state — RUNNING/STOPPED riêng với startup type (09.6) */
func scQueryRunning(svc string) bool {
	r := runSysExe("sc.exe", []string{"query", svc}, 8*time.Second)
	return strings.Contains(strings.ToUpper(r.Stdout), "RUNNING")
}

/** scQueryStartStrict — phân biệt service không tồn tại với query lỗi (08-D) */
func scQueryStartStrict(svc string) (found bool, state string, exists bool, err error) {
	found, state = scQueryStart(svc)
	if !found {
		// qc không trả START_TYPE — phân biệt "OpenService FAILED 1060" với lỗi khác
		r := runSysExe("sc.exe", []string{"qc", svc}, 6*time.Second)
		out := strings.ToLower(r.Stdout + r.Stderr)
		if strings.Contains(out, "1060") || strings.Contains(out, "does not exist") || strings.Contains(out, "không tồn tại") {
			return false, "", false, nil
		}
		return false, "", false, fmt.Errorf("sc qc %s thất bại — không phân biệt được (access denied?)", svc)
	}
	return true, state, true, nil
}

// ---------- view ----------

func servicesStateView() ServicesView {
	v := ServicesView{Mode: perfMode, Groups: []SvcGroupState{}}
	if runtimeIsWindows {
		// Defender — đọc trạng thái thật
		r := runSysExe("powershell.exe", []string{"-NoProfile", "-Command",
			"(Get-MpComputerStatus).RealTimeProtectionEnabled"}, 15*time.Second)
		v.Defender.Available = r.OK
		v.Defender.Applied = strings.Contains(strings.ToLower(strings.TrimSpace(r.Stdout)), "false")
	}
	for _, g := range svcGroups {
		gs := SvcGroupState{ID: g.ID, Name: g.Name, Icon: g.Icon, Tone: g.Tone, Items: []SvcItemState{}}
		for _, it := range g.Items {
			is := SvcItemState{ID: it.ID, Name: it.Name, Desc: it.Desc, Icon: it.Icon, Warning: it.Warning, AmdDynamic: it.AmdDynamic, State: "default", Services: []SvcSvcState{}}
			refs := itemServices(it)
			if it.AmdDynamic && len(refs) == 0 {
				is.State = "na"
				gs.Items = append(gs.Items, is)
				continue
			}
			allOff, allDefault := true, true
			for _, ref := range refs {
				st := SvcSvcState{Name: ref.Name, Default: ref.Default, State: "unknown", Found: false}
				if runtimeIsWindows {
					found, s := scQueryStart(ref.Name)
					st.Found, st.State = found, s
					if s != "disabled" {
						allOff = false
					}
					if s != ref.Default {
						allDefault = false
					}
				} else {
					allOff = false
				}
				is.Services = append(is.Services, st)
			}
			if !runtimeIsWindows {
				is.State = "unknown"
			} else if allOff {
				is.State = "off"
			} else if allDefault {
				is.State = "default"
			} else {
				is.State = "partial"
			}
			gs.Items = append(gs.Items, is)
		}
		v.Groups = append(v.Groups, gs)
	}
	return v
}

// ---------- hành động ----------

func servicesAction(action, item, level string) ServicesActionResult {
	res := ServicesActionResult{Mode: perfMode, Action: action, Steps: []PerfStep{}}
	if !runtimeIsWindows {
		res.Success = false
		res.Message = "Tab Dịch vụ chỉ áp dụng được trên Windows — bản Linux/CI chỉ hiển thị trung thực"
		res.Steps = []PerfStep{{Name: "Dịch vụ Windows", OK: false, Detail: res.Message}}
		return res
	}
	if _, ok := adminGate(); !ok {
		m, _ := adminGate()
		res.Success = false
		res.Message = m
		res.Steps = []PerfStep{{Name: "Quyền admin", OK: false, Detail: m}}
		return res
	}
	switch action {
	case "defender":
		return defenderAction(level == "on")
	case "item":
		for _, g := range svcGroups {
			for _, it := range g.Items {
				if it.ID != item {
					continue
				}
				refs := itemServices(it)
				if it.AmdDynamic && len(refs) == 0 {
					res.Success = false
					res.Message = "Không có dịch vụ AMD nào trên máy — không có gì để tắt"
					return res
				}
				disable := level == "off" // UI gửi level="off" để tắt, "default" để khôi phục
				okAll, detail := applySvcBatch(refs, disable)
				name := map[bool]string{true: "Tắt: " + it.Name, false: "Khôi phục: " + it.Name}[disable]
				res.Steps = append(res.Steps, PerfStep{Name: name, OK: okAll, Detail: detail})
				res.Success = okAll
				res.Message = map[bool]string{true: it.Name + " — đã " + map[bool]string{true: "tắt", false: "khôi phục về mặc định"}[disable],
					false: it.Name + " — một số dịch vụ lỗi, xem chi tiết"}[okAll]
				return res
			}
		}
		res.Success = false
		res.Message = "Không tìm thấy mục: " + item
		return res
	case "group":
		for _, g := range svcGroups {
			if g.ID != item {
				continue
			}
			allOK := true
			for _, it := range g.Items {
				refs := itemServices(it)
				if len(refs) == 0 {
					continue
				}
				ok, detail := applySvcBatch(refs, true)
				res.Steps = append(res.Steps, PerfStep{Name: "Tắt: " + it.Name, OK: ok, Detail: detail})
				if !ok {
					allOK = false
				}
			}
			res.Success = allOK
			res.Message = map[bool]string{true: "Nhóm " + g.Name + " — đã tắt toàn bộ dịch vụ",
				false: "Nhóm " + g.Name + " — một số mục lỗi, xem chi tiết"}[allOK]
			return res
		}
		res.Success = false
		res.Message = "Không tìm thấy nhóm: " + item
		return res
	case "preset":
		switch level {
		case "off":
			return presetRestore()
		case "minimum", "medium":
			return presetApply(level)
		case "extreme":
			return presetExtreme()
		}
		res.Success = false
		res.Message = "Preset không hợp lệ: " + level
		return res
	}
	res.Success = false
	res.Message = "Hành động không hợp lệ: " + action
	return res
}

func presetApply(level string) ServicesActionResult {
	sel := svcPreset[level]
	res := ServicesActionResult{Mode: perfMode, Action: "preset:" + level, Steps: []PerfStep{}}
	allOK := true
	for _, g := range svcGroups {
		for _, it := range g.Items {
			var refs []SvcRef
			for _, ref := range itemServices(it) {
				if sel[ref.Name] {
					refs = append(refs, ref)
				}
			}
			if len(refs) == 0 {
				continue
			}
			ok, detail := applySvcBatch(refs, true)
			res.Steps = append(res.Steps, PerfStep{Name: "Tắt: " + it.Name, OK: ok, Detail: detail})
			if !ok {
				allOK = false
			}
		}
	}
	res.Success = allOK
	res.Message = map[bool]string{true: "Đã áp dụng preset " + level + " — dịch vụ nền nhẹ nhất mà vẫn an toàn",
		false: "Preset " + level + " áp dụng xong, một số mục lỗi — xem chi tiết"}[allOK]
	return res
}

func presetExtreme() ServicesActionResult {
	res := ServicesActionResult{Mode: perfMode, Action: "preset:extreme", Steps: []PerfStep{}}
	allOK := true
	for _, g := range svcGroups {
		for _, it := range g.Items {
			refs := itemServices(it)
			if len(refs) == 0 {
				continue
			}
			ok, detail := applySvcBatch(refs, true)
			res.Steps = append(res.Steps, PerfStep{Name: "Tắt: " + it.Name, OK: ok, Detail: detail})
			if !ok {
				allOK = false
			}
		}
	}
	res.Success = allOK
	res.Message = map[bool]string{true: "Đã tắt toàn bộ dịch vụ trong danh mục (Extreme) — in ấn/RDP/Update/Store sẽ dừng, hoàn tác bằng preset Off",
		false: "Extreme áp dụng xong, một số mục lỗi — xem chi tiết"}[allOK]
	return res
}

func presetRestore() ServicesActionResult {
	res := ServicesActionResult{Mode: perfMode, Action: "preset:off", Steps: []PerfStep{}}
	allOK := true
	for _, g := range svcGroups {
		for _, it := range g.Items {
			refs := itemServices(it)
			if len(refs) == 0 {
				continue
			}
			ok, detail := applySvcBatch(refs, false) // về StartDefault từng dịch vụ
			res.Steps = append(res.Steps, PerfStep{Name: "Khôi phục mặc định: " + it.Name, OK: ok, Detail: detail})
			if !ok {
				allOK = false
			}
		}
	}
	res.Success = allOK
	// v4.1.0 (phát hiện 09.3): restore dùng SNAPSHOT từng service — không phải "reset
	// toàn bộ catalog về default" (đó sẽ là action riêng, đụng cả service người dùng tự cấu hình)
	res.Message = map[bool]string{true: "Đã khôi phục các dịch vụ NEXUS từng tắt về ĐÚNG trạng thái gốc trước khi tắt (snapshot StartType + runtime)",
		false: "Khôi phục một phần — service chưa có snapshot sẽ KHÔNG bị đụng; mục lỗi giữ nguyên snapshot để thử lại"}[allOK]
	return res
}

func defenderAction(enable bool) ServicesActionResult {
	res := ServicesActionResult{Mode: perfMode, Action: "defender", Steps: []PerfStep{}}
	// enable=true → BẬT Defender (DisableRealtimeMonitoring $false); enable=false → TẮT ($true)
	verb := map[bool]string{true: "$false", false: "$true"}[enable]
	cmd := "Set-MpPreference -DisableRealtimeMonitoring " + verb
	r := runSysExe("powershell.exe", []string{"-NoProfile", "-Command", cmd}, 25*time.Second)
	res.Steps = append(res.Steps, PerfStep{Name: map[bool]string{true: "Bật lại bảo vệ realtime Defender", false: "Tắt bảo vệ realtime Defender"}[enable],
		OK: r.OK, Detail: map[bool]string{true: "Set-MpPreference đã chạy", false: firstLine(r.Stdout + r.Stderr) + " — nếu bị chặn, tắt Tamper Protection trong Windows Security rồi thử lại"}[r.OK]})
	v := runSysExe("powershell.exe", []string{"-NoProfile", "-Command",
		"(Get-MpComputerStatus).RealTimeProtectionEnabled"}, 15*time.Second)
	nowOn := strings.Contains(strings.ToLower(strings.TrimSpace(v.Stdout)), "true")
	res.Steps = append(res.Steps, PerfStep{Name: "Xác minh trạng thái thực tế", OK: true,
		Detail: map[bool]string{true: "RealTimeProtection = ON", false: "RealTimeProtection = OFF"}[nowOn]})
	if enable {
		res.Success = nowOn
		res.Message = map[bool]string{true: "Defender đã bật lại bình thường", false: "Chưa bật được — xem chi tiết từng bước"}[nowOn]
	} else {
		res.Success = !nowOn && r.OK
		res.Message = map[bool]string{true: "Defender realtime đã tắt — chỉ nên tắt tạm khi chơi game nặng, nhớ bật lại",
			false: "Tamper Protection của Windows chặn tắt Defender — mở Windows Security → Virus & threat protection → Tamper Protection → tắt rồi thử lại"}[res.Success]
	}
	return res
}

// ---------- routes ----------

func registerServicesRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/services", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, servicesStateView())
	})
	mux.HandleFunc("POST /api/services", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Action string `json:"action"`
			Item   string `json:"item"`
			Level  string `json:"level"`
		}
		if !readBody(w, r, &body) || body.Action == "" {
			writeErr(w, 400, "Dữ liệu không hợp lệ (cần action)")
			return
		}
		res := servicesAction(body.Action, body.Item, body.Level)
		code := 200
		if !res.Success && res.Mode == "windows" && runtimeIsWindows {
			code = 500
		}
		writeJSON(w, code, res)
	})
}
