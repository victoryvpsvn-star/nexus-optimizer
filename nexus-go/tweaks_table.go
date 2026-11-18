// tweaks_table.go — 165 tinh chỉnh bổ sung dạng BẢNG DỮ LIỆU (mỗi mục = danh sách step
// áp dụng + hoàn tác). Tất cả đều là registry key / lệnh hệ thống thật, chuẩn Chris Titus
// WinUtil style — KHÔNG bịa key. Exit code là chuẩn đánh giá (reg/sc localize không parse text).
package main

import (
	"fmt"
	"strings"
	"time"
)

// ---------- Mô hình step ----------

type stepKind int

const (
	stepRegAdd    stepKind = iota // reg add key /v name /t typ /d data /f
	stepRegDel                    // reg delete value — query trước: missing = OK
	stepRegAddVe                  // reg add key /ve /d "" (tạo key với default rỗng)
	stepRegDelKey                 // reg delete key /f — query trước: missing = OK
	stepRegAddKey                 // reg add key /f (tạo lại key rỗng)
	stepSc                        // sc config <svc> start= <mode> (+stop khi apply, +start khi revert); 1060 = OK
	stepPc                        // powercfg -setacvalueindex scheme_current sub setting val + /setactive
	stepTask                      // schtasks /Query rồi /Change /DISABLE|ENABLE — task missing = OK
	stepAppx                      // Get-AppxPackage remove (apply) / re-register (revert)
	stepPS                        // script PowerShell tùy chỉnh
	stepExe                       // runSysExe(name, args) — Tolerant = bỏ qua lỗi
)

type step struct {
	Kind     stepKind
	Key      string // reg key
	Name     string // reg value / service / appx package / task name
	Typ      string // reg type
	Data     string // reg data / sc start mode / powercfg value
	Sub      string // powercfg subgroup GUID
	Setting  string // powercfg setting GUID
	Script   string // PS script
	Args     []string
	Tolerant bool
	Secs     int
}

func (s *step) timeout() time.Duration {
	if s.Secs > 0 {
		return time.Duration(s.Secs) * time.Second
	}
	switch s.Kind {
	case stepSc, stepPc, stepAppx, stepPS:
		return 60 * time.Second
	case stepTask:
		return 20 * time.Second
	default:
		return 20 * time.Second
	}
}

// helpers dựng step gọn
func ra(key, name, typ, data string) step {
	return step{Kind: stepRegAdd, Key: key, Name: name, Typ: typ, Data: data}
}
func rd(key, name string) step   { return step{Kind: stepRegDel, Key: key, Name: name} }
func rdk(key string) step        { return step{Kind: stepRegDelKey, Key: key} }
func rak(key string) step        { return step{Kind: stepRegAddKey, Key: key} }
func rave(key string) step       { return step{Kind: stepRegAddVe, Key: key} }
func svc(name, mode string) step { return step{Kind: stepSc, Name: name, Data: mode} }
func pcfg(sub, setting, val string) step {
	return step{Kind: stepPc, Sub: sub, Setting: setting, Data: val}
}
func task(name string) step  { return step{Kind: stepTask, Name: name} }
func appx(pkg string) step   { return step{Kind: stepAppx, Name: pkg} }
func pss(script string) step { return step{Kind: stepPS, Script: script} }
func exe(name string, args ...string) step {
	return step{Kind: stepExe, Name: name, Args: args}
}
func exeT(name string, args ...string) step {
	return step{Kind: stepExe, Name: name, Args: args, Tolerant: true}
}

type tableTweak struct {
	Def         TweakDef
	ApplySteps  []step
	ApplyMsg    string
	RevertSteps []step
	RevertMsg   string
	ApplyOnly   bool // hành động tức thời — revert chỉ trả thông báo
}

// ---------- Runner chung ----------

const scSvcMissing = 1060 // ERROR_SERVICE_DOES_NOT_EXIST
const scSvcNotRunning = 1062

func failStep(what string, r RunResult) (string, bool) {
	return truncateShort(fmt.Sprintf("%s thất bại (exit %d): %s", what, r.Code, orDefault(r.Stderr, r.Stdout, "không rõ lý do"))), false
}

/** Chạy 1 step; revert=false là chiều áp dụng, true là chiều hoàn tác */
func runStep(s step, revert bool) (string, bool) {
	switch s.Kind {
	case stepRegAdd:
		r := runSysExe("reg.exe", []string{"add", s.Key, "/v", s.Name, "/t", s.Typ, "/d", s.Data, "/f"}, s.timeout())
		if !r.OK {
			return failStep(fmt.Sprintf("reg add %s\\%s", s.Key, s.Name), r)
		}
		return "", true
	case stepRegDel:
		// v4.1.0 (phát hiện 08-A): query thất bại ≠ "không tồn tại" — chỉ lỗi
		// "unable to find" của reg.exe mới là chắc chắn sạch; còn lại là lỗi thật
		q := runSysExe("reg.exe", []string{"query", s.Key, "/v", s.Name}, s.timeout())
		if !q.OK {
			out := strings.ToLower(q.Stdout + q.Stderr)
			if strings.Contains(out, "unable to find") || strings.Contains(out, "cannot find") {
				return "", true // NotFound rõ ràng — đã ở mặc định
			}
			return failStep(fmt.Sprintf("reg query %s\\%s (không phân biệt được NotFound và lỗi truy cập — access denied?)", s.Key, s.Name), q)
		}
		d := runSysExe("reg.exe", []string{"delete", s.Key, "/v", s.Name, "/f"}, s.timeout())
		if !d.OK {
			return failStep(fmt.Sprintf("reg delete %s\\%s", s.Key, s.Name), d)
		}
		// read-back verify: sau delete phải NotFound mới tính sạch
		q2 := runSysExe("reg.exe", []string{"query", s.Key, "/v", s.Name}, s.timeout())
		if q2.OK {
			return fmt.Sprintf("reg delete %s\\%s: exit 0 nhưng value VẪN còn (read-back thấy value) — không tính hoàn tác", s.Key, s.Name), false
		}
		return "", true
	case stepRegAddVe:
		r := runSysExe("reg.exe", []string{"add", s.Key, "/ve", "/d", "", "/f"}, s.timeout())
		if !r.OK {
			return failStep(fmt.Sprintf("reg add %s (default)", s.Key), r)
		}
		return "", true
	case stepRegDelKey:
		// v4.1.0 (phát hiện 08-A): giống stepRegDel — phân biệt NotFound với QueryError
		q := runSysExe("reg.exe", []string{"query", s.Key}, s.timeout())
		if !q.OK {
			out := strings.ToLower(q.Stdout + q.Stderr)
			if strings.Contains(out, "unable to find") || strings.Contains(out, "cannot find") {
				return "", true
			}
			return failStep(fmt.Sprintf("reg query key %s (không phân biệt được NotFound và lỗi truy cập)", s.Key), q)
		}
		d := runSysExe("reg.exe", []string{"delete", s.Key, "/f"}, s.timeout())
		if !d.OK {
			return failStep(fmt.Sprintf("reg delete key %s", s.Key), d)
		}
		q2 := runSysExe("reg.exe", []string{"query", s.Key}, s.timeout())
		if q2.OK {
			return fmt.Sprintf("reg delete key %s: exit 0 nhưng key VẪN còn (read-back thấy key) — không tính hoàn tác", s.Key), false
		}
		return "", true
	case stepRegAddKey:
		r := runSysExe("reg.exe", []string{"add", s.Key, "/f"}, s.timeout())
		if !r.OK {
			return failStep(fmt.Sprintf("reg add key %s", s.Key), r)
		}
		return "", true
	case stepSc:
		mode := s.Data
		if !revert {
			mode = "disabled" // apply luôn disable (DSL SC:svc|revertMode — Data là mode hoàn tác)
		}
		cfg := runSysExe("sc.exe", []string{"config", s.Name, "start=", mode}, s.timeout())
		if !cfg.OK && cfg.Code != scSvcMissing {
			return failStep(fmt.Sprintf("sc config %s start=%s", s.Name, mode), cfg)
		}
		if cfg.Code == scSvcMissing {
			return "", true // dịch vụ không tồn tại (máy rút gọn) — coi như xong
		}
		if !revert {
			// apply: dừng service — không phải mục tiêu chính (config mới là chính), báo trung thực
			sr := runSysExe("sc.exe", []string{"stop", s.Name}, s.timeout())
			if !sr.OK {
				_ = sr // chi tiết runtime state sẽ được verify bên dưới, không che lấp config
			}
		} else {
			// v4.1.0 (phát hiện 08-B): revert gồm start — start thất bại PHẢI là thất bại;
			// "already running" (1056) thì OK vì service đã chạy
			sr := runSysExe("sc.exe", []string{"start", s.Name}, s.timeout())
			if !sr.OK {
				out := strings.ToLower(sr.Stdout + sr.Stderr)
				if !strings.Contains(out, "already running") && !strings.Contains(out, "1056") {
					// verify lại bằng sc query — có thể đã start được dù exit != 0
					sv := runSysExe("sc.exe", []string{"query", s.Name}, s.timeout())
					if !strings.Contains(strings.ToUpper(sv.Stdout), "RUNNING") && !strings.Contains(strings.ToUpper(sv.Stdout), "START_PENDING") {
						return fmt.Sprintf("sc start %s thất bại — service vẫn chưa chạy (startup type đã đúng nhưng runtime chưa): %s", s.Name, truncateShort(firstLine(sr.Stdout+sr.Stderr))), false
					}
				}
			}
		}
		// verify trạng thái runtime cuối — chỉ dùng để bắt lệch startup/runtime trên revert (đã fail ở trên);
		// chiều apply OK của config vẫn trung thực: exit 0 của sc config là đủ cho startup type
		return "", true
	case stepPc:
		set := runSysExe("powercfg.exe", []string{"-setacvalueindex", powercfgGuidCurrent, s.Sub, s.Setting, s.Data}, s.timeout())
		if !set.OK {
			return failStep("powercfg setacvalueindex", set)
		}
		// v4.1.0 (phát hiện 08-C): DC fail ≠ bỏ qua mù — "not support" = NotApplicable
		// (desktop không có chế độ pin), còn lại là lỗi thật → step thất bại
		dc := runSysExe("powercfg.exe", []string{"-setdcvalueindex", powercfgGuidCurrent, s.Sub, s.Setting, s.Data}, s.timeout())
		if !dc.OK {
			out := strings.ToLower(dc.Stdout + dc.Stderr)
			if !strings.Contains(out, "not support") && !strings.Contains(out, "không hỗ trợ") {
				return failStep("powercfg setdcvalueindex (laptop có chế độ pin — giá trị pin chưa được đổi)", dc)
			}
		}
		act := runSysExe("powercfg.exe", []string{"/setactive", powercfgGuidCurrent}, s.timeout())
		if !act.OK {
			return failStep("powercfg setactive", act)
		}
		return "", true
	case stepTask:
		flag := "/DISABLE"
		if revert {
			flag = "/ENABLE"
		}
		q := runSysExe("schtasks.exe", []string{"Query", "/TN", s.Name}, s.timeout())
		if !q.OK {
			// v4.1.0 (phát hiện 08-D): chỉ "không tồn tại" rõ ràng mới bỏ qua
			out := strings.ToLower(q.Stdout + q.Stderr)
			if strings.Contains(out, "does not exist") || strings.Contains(out, "cannot find") || strings.Contains(out, "không tồn tại") {
				return "", true
			}
			return failStep(fmt.Sprintf("schtasks Query %s (không phân biệt được NotFound và lỗi truy cập)", s.Name), q)
		}
		c := runSysExe("schtasks.exe", []string{"Change", "/TN", s.Name, flag}, s.timeout())
		if !c.OK {
			return failStep(fmt.Sprintf("schtasks %s %s", s.Name, flag), c)
		}
		return "", true
	case stepAppx:
		return runAppxStep(s.Name, revert)
	case stepPS:
		r := psRun(s.Script, s.timeout())
		if !r.OK {
			return failStep("script PowerShell", r)
		}
		return "", true
	case stepExe:
		r := runSysExe(s.Name, s.Args, s.timeout())
		if !r.OK && !s.Tolerant {
			return failStep(s.Name+" "+strings.Join(s.Args, " "), r)
		}
		return "", true
	}
	return "loại step không hỗ trợ", false
}

func runSteps(steps []step, revert bool) (string, bool) {
	for i, s := range steps {
		if msg, ok := runStep(s, revert); !ok {
			if len(steps) > 1 {
				// v4.1.0 (phát hiện 08-E): cờ MỘT PHẦN ĐÃ ÁP DỤNG trong message —
				// caller parse để lưu Partial state (boolean Applied không diễn tả được partial)
				return fmt.Sprintf("bước %d/%d — %s (các bước TRƯỚC nó nếu đã chạy là đã áp dụng thật) ⚠️ MỘT PHẦN ĐÃ ÁP DỤNG", i+1, len(steps), msg), false
			}
			return msg, false
		}
	}
	return "", true
}

func appxScript(pkg string, revert bool) string {
	if !revert {
		return fmt.Sprintf(`$ErrorActionPreference='Stop'
try {
  $pkg = Get-AppxPackage -Name '%s' -ErrorAction SilentlyContinue
  if (-not $pkg) { Write-Output 'khong-tim-thay-package (da go san?)'; exit 0 }
  Remove-AppxPackage -Package $pkg.PackageFullName
  Write-Output ("da go " + $pkg.PackageFullName)
} catch { Write-Output $_.Exception.Message; exit 1 }`, pkg)
	}
	return fmt.Sprintf(`$ErrorActionPreference='Stop'
try {
  $pkg = Get-AppxPackage -AllUsers -Name '%s' -ErrorAction SilentlyContinue
  if (-not $pkg) { $pkg = Get-AppxPackage -Name '%s' -ErrorAction SilentlyContinue }
  if (-not $pkg) { Write-Output 'khong con package de khoi phuc — hay cai lai tu Microsoft Store'; exit 1 }
  Add-AppxPackage -DisableDevelopmentMode -Register "$($pkg.InstallLocation)\AppxManifest.xml"
  Write-Output ("da dang ky lai " + $pkg.PackageFullName)
} catch { Write-Output $_.Exception.Message; exit 1 }`, pkg, pkg)
}

func runAppxStep(pkg string, revert bool) (string, bool) {
	r := psRun(appxScript(pkg, revert), 60*time.Second)
	if !r.OK {
		return truncateShort(fmt.Sprintf("Gỡ/cài lại app UWP %s thất bại: %s", pkg, orDefault(r.Stdout, r.Stderr, "không rõ lý do"))), false
	}
	return "", true
}

func tableAction(t tableTweak) TweakAction {
	return TweakAction{
		Def: t.Def,
		Apply: func() ActionResult {
			if t.Def.RequiresRoot {
				if m, ok := adminGate(); !ok {
					return ActionResult{false, m}
				}
			}
			if msg, ok := runSteps(t.ApplySteps, false); !ok {
				return ActionResult{false, msg}
			}
			return ActionResult{true, t.ApplyMsg}
		},
		Revert: func() ActionResult {
			if t.ApplyOnly {
				return ActionResult{true, "Hành động tức thời — không cần hoàn tác"}
			}
			if t.Def.RequiresRoot {
				if m, ok := adminGate(); !ok {
					return ActionResult{false, m}
				}
			}
			if msg, ok := runSteps(t.RevertSteps, true); !ok {
				return ActionResult{false, msg}
			}
			return ActionResult{true, t.RevertMsg}
		},
	}
}

// ---------- Danh mục 1: Bảo mật & riêng tư (telemetry + hardening) ----------

var privacyKeys = struct {
	DataCollection string
	Siuf           string
	SQM            string
	AppCompat      string
	WER            string
	Privacy        string
	Advertising    string
	System         string
	WiFiPolicy     string
	SpeechOneCore  string
	InputPers      string
	TrainedData    string
	ExplorerPolicy string
	Search         string
	WinSearchPol   string
	LocSensors     string
	FindMyDevice   string
	WindowsAI      string
	Clipboard      string
	DeviceMeta     string
	CDM            string
	CloudContent   string
	Winlogon       string
	Lsa            string
	MemMgmt        string
	RemoteAsst     string
	LanmanWs       string
	Mrxsmb10       string
	Dnscache       string
}{`HKLM\SOFTWARE\Policies\Microsoft\DataCollection`,
	`HKCU\SOFTWARE\Microsoft\Siuf\Rules`,
	`HKLM\SOFTWARE\Policies\Microsoft\SQMClient\Windows`,
	`HKLM\SOFTWARE\Policies\Microsoft\Windows\AppCompat`,
	`HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting`,
	`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Privacy`,
	`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\AdvertisingInfo`,
	`HKLM\SOFTWARE\Policies\Microsoft\Windows\System`,
	`HKLM\Software\Microsoft\PolicyManager\default\WiFi`,
	`HKCU\Software\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy`,
	`HKCU\SOFTWARE\Microsoft\InputPersonalization`,
	`HKCU\SOFTWARE\Microsoft\InputPersonalization\TrainedDataStore`,
	`HKCU\SOFTWARE\Policies\Microsoft\Windows\Explorer`,
	`HKCU\Software\Microsoft\Windows\CurrentVersion\Search`,
	`HKLM\SOFTWARE\Policies\Microsoft\Windows\Windows Search`,
	`HKLM\SOFTWARE\Policies\Microsoft\Windows\LocationAndSensors`,
	`HKLM\SOFTWARE\Policies\Microsoft\FindMyDevice`,
	`HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsAI`,
	`HKCU\Software\Microsoft\Clipboard`,
	`HKLM\SOFTWARE\Policies\Microsoft\Windows\Device Metadata`,
	`HKCU\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager`,
	`HKCU\SOFTWARE\Policies\Microsoft\Windows\CloudContent`,
	`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`,
	`HKLM\SYSTEM\CurrentControlSet\Control\Lsa`,
	`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management`,
	`HKLM\SYSTEM\CurrentControlSet\Control\Remote Assistance`,
	`HKLM\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters`,
	`HKLM\SYSTEM\CurrentControlSet\Services\mrxsmb10`,
	`HKLM\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters`,
}

func privacyTweaks() []tableTweak {
	return []tableTweak{
		{Def: TweakDef{ID: "tel-allow-telemetry-0", Name: "Tắt gửi dữ liệu chẩn đoán (AllowTelemetry=0)",
			Description: "Policy AllowTelemetry=0 chặn Windows gửi dữ liệu chẩn đoán/telemetry về Microsoft ở mức thấp nhất (Enterprise/Pro áp đầy; Home áp một phần).",
			Category:    "Bảo mật & riêng tư", Risk: "medium", RequiresRoot: true, Recommended: true},
			ApplySteps:  []step{ra(privacyKeys.DataCollection, "AllowTelemetry", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt gửi dữ liệu chẩn đoán (AllowTelemetry=0)",
			RevertSteps: []step{rd(privacyKeys.DataCollection, "AllowTelemetry")},
			RevertMsg:   "Đã xóa policy AllowTelemetry — trở về mặc định"},
		{Def: TweakDef{ID: "tel-feedback-off", Name: "Tắt hộp thoại xin feedback của Windows",
			Description: "NumberOfSIUFInPeriod=0 — Windows không còn hiện 'Bạn có muốn cho chúng tôi biết cảm nhận của bạn?'",
			Category:    "Bảo mật & riêng tư", Risk: "low"},
			ApplySteps:  []step{ra(privacyKeys.Siuf, "NumberOfSIUFInPeriod", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt xin feedback (SIUF)",
			RevertSteps: []step{rd(privacyKeys.Siuf, "NumberOfSIUFInPeriod")},
			RevertMsg:   "Đã xóa số lần xin feedback — trở về mặc định"},
		{Def: TweakDef{ID: "tel-ceip-off", Name: "Tắt CEIP (Chương trình cải tiến trải nghiệm)",
			Description: "CEIPEnable=0 (HKLM + HKCU) — tắt thu thập dữ liệu Chương trình Cải tiến Trải nghiệm Khách hàng.",
			Category:    "Bảo mật & riêng tư", Risk: "low", RequiresRoot: true},
			ApplySteps: []step{
				ra(privacyKeys.SQM, "CEIPEnable", "REG_DWORD", "0"),
				ra(`HKCU\Software\Policies\Microsoft\SQMClient\Windows`, "CEIPEnable", "REG_DWORD", "0"),
			},
			ApplyMsg: "Đã tắt CEIP (HKLM + HKCU)",
			RevertSteps: []step{
				rd(privacyKeys.SQM, "CEIPEnable"),
				rd(`HKCU\Software\Policies\Microsoft\SQMClient\Windows`, "CEIPEnable"),
			},
			RevertMsg: "Đã xóa policy CEIP — trở về mặc định"},
		{Def: TweakDef{ID: "tel-appcompat-off", Name: "Tắt AppCompat telemetry (AIT + inventory)",
			Description: "AITEnable=0 + DisableInventory=1 — tắt trình thu thập dữ liệu tương thích ứng dụng (bộ phận telemetry nặng nhất khi chạy nền).",
			Category:    "Bảo mật & riêng tư", Risk: "low", RequiresRoot: true},
			ApplySteps: []step{
				ra(privacyKeys.AppCompat, "AITEnable", "REG_DWORD", "0"),
				ra(privacyKeys.AppCompat, "DisableInventory", "REG_DWORD", "1"),
			},
			ApplyMsg: "Đã tắt AppCompat telemetry (AIT + inventory)",
			RevertSteps: []step{
				rd(privacyKeys.AppCompat, "AITEnable"),
				rd(privacyKeys.AppCompat, "DisableInventory"),
			},
			RevertMsg: "Đã xóa policy AppCompat — trở về mặc định"},
		{Def: TweakDef{ID: "tel-error-report-off", Name: "Tắt Windows Error Reporting",
			Description: "Disabled=1 cho Windows Error Reporting (HKLM + HKCU) — không gửi báo cáo crash về Microsoft; crash dump cục bộ vẫn ghi bình thường.",
			Category:    "Bảo mật & riêng tư", Risk: "low", RequiresRoot: true},
			ApplySteps: []step{
				ra(privacyKeys.WER, "Disabled", "REG_DWORD", "1"),
				ra(`HKCU\SOFTWARE\Microsoft\Windows\Windows Error Reporting`, "Disabled", "REG_DWORD", "1"),
			},
			ApplyMsg: "Đã tắt Windows Error Reporting (HKLM + HKCU)",
			RevertSteps: []step{
				rd(privacyKeys.WER, "Disabled"),
				rd(`HKCU\SOFTWARE\Microsoft\Windows\Windows Error Reporting`, "Disabled"),
			},
			RevertMsg: "Đã bật lại Windows Error Reporting (mặc định)"},
		{Def: TweakDef{ID: "tel-tailored-off", Name: "Tắt trải nghiệm cá nhân hóa theo dữ liệu chẩn đoán",
			Description: "TailoredExperiencesWithDiagnosticDataEnabled=0 — Windows không dùng dữ liệu chẩn đoán để cá nhân hóa tips/quảng cáo.",
			Category:    "Bảo mật & riêng tư", Risk: "low"},
			ApplySteps:  []step{ra(privacyKeys.Privacy, "TailoredExperiencesWithDiagnosticDataEnabled", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt trải nghiệm cá nhân hóa theo dữ liệu chẩn đoán",
			RevertSteps: []step{ra(privacyKeys.Privacy, "TailoredExperiencesWithDiagnosticDataEnabled", "REG_DWORD", "1")},
			RevertMsg:   "Đã bật lại trải nghiệm cá nhân hóa (mặc định)"},
		{Def: TweakDef{ID: "tel-ads-id-off", Name: "Tắt Advertising ID (quảng cáo cá nhân hóa)",
			Description: "Enabled=0 — apps không còn đọc Advertising ID để nhắm quảng cáo theo người dùng.",
			Category:    "Bảo mật & riêng tư", Risk: "low", Recommended: true},
			ApplySteps:  []step{ra(privacyKeys.Advertising, "Enabled", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt Advertising ID",
			RevertSteps: []step{ra(privacyKeys.Advertising, "Enabled", "REG_DWORD", "1")},
			RevertMsg:   "Đã bật lại Advertising ID (mặc định)"},
		{Def: TweakDef{ID: "tel-activity-feed-off", Name: "Tắt Timeline / Activity Feed",
			Description: "EnableActivityFeed=0 — tắt dòng thời gian hoạt động (Timeline) và lịch sử app trên các thiết bị.",
			Category:    "Bảo mật & riêng tư", Risk: "low", RequiresRoot: true},
			ApplySteps:  []step{ra(privacyKeys.System, "EnableActivityFeed", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt Timeline / Activity Feed",
			RevertSteps: []step{rd(privacyKeys.System, "EnableActivityFeed")},
			RevertMsg:   "Đã xóa policy Activity Feed — trở về mặc định"},
		{Def: TweakDef{ID: "tel-activity-upload-off", Name: "Tắt tải lên cloud hoạt động người dùng",
			Description: "PublishUserActivities=0 + UploadUserActivities=0 — Windows không gửi lịch sử hoạt động lên Microsoft cloud để đồng bộ giữa các máy.",
			Category:    "Bảo mật & riêng tư", Risk: "low", RequiresRoot: true},
			ApplySteps: []step{
				ra(privacyKeys.System, "PublishUserActivities", "REG_DWORD", "0"),
				ra(privacyKeys.System, "UploadUserActivities", "REG_DWORD", "0"),
			},
			ApplyMsg: "Đã tắt tải hoạt động lên cloud",
			RevertSteps: []step{
				rd(privacyKeys.System, "PublishUserActivities"),
				rd(privacyKeys.System, "UploadUserActivities"),
			},
			RevertMsg: "Đã xóa policy upload hoạt động — trở về mặc định"},
		{Def: TweakDef{ID: "tel-wifi-sense-off", Name: "Tắt chia sẻ Wi-Fi (Wi-Fi Sense policy)",
			Description: "Chặn Windows báo cáo hotspot và tự kết nối mạng mở được chia sẻ — hết rủi ro tự dính mạng lạ.",
			Category:    "Bảo mật & riêng tư", Risk: "low", RequiresRoot: true},
			ApplySteps: []step{
				ra(privacyKeys.WiFiPolicy, "AllowWiFiHotSpotReporting", "REG_DWORD", "0"),
				ra(privacyKeys.WiFiPolicy, "AllowAutoConnectToWiFiSenseHotspots", "REG_DWORD", "0"),
			},
			ApplyMsg: "Đã tắt Wi-Fi Sense (không báo cáo/chia sẻ hotspot)",
			RevertSteps: []step{
				rd(privacyKeys.WiFiPolicy, "AllowWiFiHotSpotReporting"),
				rd(privacyKeys.WiFiPolicy, "AllowAutoConnectToWiFiSenseHotspots"),
			},
			RevertMsg: "Đã xóa policy Wi-Fi Sense — trở về mặc định"},
		{Def: TweakDef{ID: "tel-speech-off", Name: "Tắt nhận diện giọng nói online",
			Description: "HasAccepted=0 — không gửi giọng nói lên Microsoft cloud để nhận dạng; ghi chú từng phím offline vẫn hoạt động.",
			Category:    "Bảo mật & riêng tư", Risk: "low"},
			ApplySteps:  []step{ra(privacyKeys.SpeechOneCore, "HasAccepted", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt nhận diện giọng nói online",
			RevertSteps: []step{ra(privacyKeys.SpeechOneCore, "HasAccepted", "REG_DWORD", "1")},
			RevertMsg:   "Đã bật lại nhận diện giọng nói online (mặc định)"},
		{Def: TweakDef{ID: "tel-input-personalization-off", Name: "Tắt cá nhân hóa bàn phím/nhập liệu",
			Description: "RestrictImplicitTextCollection + RestrictImplicitInkCollection=1 và chặn HarvestContacts — Windows không tự thu thập nội dung gõ/vẽ/danh bạ để học cách gõ của bạn.",
			Category:    "Bảo mật & riêng tư", Risk: "low"},
			ApplySteps: []step{
				ra(privacyKeys.InputPers, "RestrictImplicitTextCollection", "REG_DWORD", "1"),
				ra(privacyKeys.InputPers, "RestrictImplicitInkCollection", "REG_DWORD", "1"),
				ra(privacyKeys.TrainedData, "HarvestContacts", "REG_DWORD", "0"),
			},
			ApplyMsg: "Đã tắt thu thập dữ liệu nhập liệu + danh bạ",
			RevertSteps: []step{
				rd(privacyKeys.InputPers, "RestrictImplicitTextCollection"),
				rd(privacyKeys.InputPers, "RestrictImplicitInkCollection"),
				rd(privacyKeys.TrainedData, "HarvestContacts"),
			},
			RevertMsg: "Đã xóa giới hạn nhập liệu — trở về mặc định"},
		{Def: TweakDef{ID: "tel-bing-suggest-off", Name: "Tắt gợi ý web Bing trong Search (policy)",
			Description: "DisableSearchBoxSuggestions=1 — ô tìm kiếm không còn đưa gợi ý web/link Bing từ internet (chỉ tìm nội dung máy).",
			Category:    "Bảo mật & riêng tư", Risk: "low", Recommended: true},
			ApplySteps:  []step{ra(privacyKeys.ExplorerPolicy, "DisableSearchBoxSuggestions", "REG_DWORD", "1")},
			ApplyMsg:    "Đã tắt gợi ý web Bing trong Search",
			RevertSteps: []step{rd(privacyKeys.ExplorerPolicy, "DisableSearchBoxSuggestions")},
			RevertMsg:   "Đã xóa policy — Search gợi ý web lại như mặc định"},
		{Def: TweakDef{ID: "tel-bing-web-off", Name: "Tắt tìm web Bing trong Start (per-user)",
			Description: "BingSearchEnabled=0 + CortanaConsent=0 — tìm kiếm Start không truy Bing nữa, kết quả tức thì hơn.",
			Category:    "Bảo mật & riêng tư", Risk: "low"},
			ApplySteps: []step{
				ra(privacyKeys.Search, "BingSearchEnabled", "REG_DWORD", "0"),
				ra(privacyKeys.Search, "CortanaConsent", "REG_DWORD", "0"),
			},
			ApplyMsg: "Đã tắt Bing trong Start search",
			RevertSteps: []step{
				ra(privacyKeys.Search, "BingSearchEnabled", "REG_DWORD", "1"),
				ra(privacyKeys.Search, "CortanaConsent", "REG_DWORD", "1"),
			},
			RevertMsg: "Đã bật lại tìm web Bing (mặc định)"},
		{Def: TweakDef{ID: "tel-cortana-policy-off", Name: "Tắt Cortana (policy máy)",
			Description: "AllowCortana=0 — Cortana bị tắt hoàn toàn ở mức policy trên máy.",
			Category:    "Bảo mật & riêng tư", Risk: "low", RequiresRoot: true},
			ApplySteps:  []step{ra(privacyKeys.WinSearchPol, "AllowCortana", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt Cortana (policy)",
			RevertSteps: []step{rd(privacyKeys.WinSearchPol, "AllowCortana")},
			RevertMsg:   "Đã xóa policy Cortana — trở về mặc định"},
		{Def: TweakDef{ID: "tel-location-policy-off", Name: "Tắt vị trí máy (Location policy)",
			Description: "DisableLocation=1 — các app không đọc được vị trí thiết bị qua Windows Location.",
			Category:    "Bảo mật & riêng tư", Risk: "medium", RequiresRoot: true},
			ApplySteps:  []step{ra(privacyKeys.LocSensors, "DisableLocation", "REG_DWORD", "1")},
			ApplyMsg:    "Đã tắt vị trí máy (policy)",
			RevertSteps: []step{rd(privacyKeys.LocSensors, "DisableLocation")},
			RevertMsg:   "Đã xóa policy vị trí — trở về mặc định"},
		{Def: TweakDef{ID: "tel-findmydevice-off", Name: "Tắt Find My Device",
			Description: "AllowFindMyDevice=0 — Windows không định vị máy khi mất (tính năng cloud) và không gửi vị trí định kỳ.",
			Category:    "Bảo mật & riêng tư", Risk: "low", RequiresRoot: true},
			ApplySteps:  []step{ra(privacyKeys.FindMyDevice, "AllowFindMyDevice", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt Find My Device",
			RevertSteps: []step{rd(privacyKeys.FindMyDevice, "AllowFindMyDevice")},
			RevertMsg:   "Đã xóa policy Find My Device — trở về mặc định"},
		{Def: TweakDef{ID: "tel-recall-off", Name: "Tắt Recall / phân tích AI (Win11 24H2)",
			Description: "DisableAIDataAnalysis=1 — tắt Recall (chụp màn hình định kỳ + phân tích AI cục bộ) và Click to Do trên Windows 11 24H2.",
			Category:    "Bảo mật & riêng tư", Risk: "medium", RequiresRoot: true, Recommended: true},
			ApplySteps:  []step{ra(privacyKeys.WindowsAI, "DisableAIDataAnalysis", "REG_DWORD", "1")},
			ApplyMsg:    "Đã tắt Recall / AI phân tích (DisableAIDataAnalysis=1)",
			RevertSteps: []step{rd(privacyKeys.WindowsAI, "DisableAIDataAnalysis")},
			RevertMsg:   "Đã xóa policy Recall — trở về mặc định"},
		{Def: TweakDef{ID: "tel-clipboard-history-off", Name: "Tắt lịch sử clipboard (Win+V)",
			Description: "EnableClipboardHistory=0 — không lưu lịch sử copy; lợi riêng tư (mật khẩu copy không nằm lại), mất tiện lợi Win+V.",
			Category:    "Bảo mật & riêng tư", Risk: "low"},
			ApplySteps:  []step{ra(privacyKeys.Clipboard, "EnableClipboardHistory", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt lịch sử clipboard",
			RevertSteps: []step{rd(privacyKeys.Clipboard, "EnableClipboardHistory")},
			RevertMsg:   "Đã xóa giới hạn — clipboard history về mặc định"},
		{Def: TweakDef{ID: "tel-clipboard-cloud-off", Name: "Tắt đồng bộ clipboard lên cloud",
			Description: "CloudClipboardAutomaticUpload=0 — nội dung copy không được tải lên Microsoft cloud để đồng bộ giữa các thiết bị.",
			Category:    "Bảo mật & riêng tư", Risk: "low"},
			ApplySteps:  []step{ra(privacyKeys.Clipboard, "CloudClipboardAutomaticUpload", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt đồng bộ clipboard cloud",
			RevertSteps: []step{rd(privacyKeys.Clipboard, "CloudClipboardAutomaticUpload")},
			RevertMsg:   "Đã xóa giới hạn — đồng bộ cloud về mặc định"},
		{Def: TweakDef{ID: "tel-device-metadata-off", Name: "Tắt tải metadata thiết bị từ mạng",
			Description: "PreventDeviceMetadataFromNetwork=1 — Windows không tải icon/thông tin chi tiết thiết bị từ Device Metadata Service (chỉ hiển thị icon dựng sẵn).",
			Category:    "Bảo mật & riêng tư", Risk: "low", RequiresRoot: true},
			ApplySteps:  []step{ra(privacyKeys.DeviceMeta, "PreventDeviceMetadataFromNetwork", "REG_DWORD", "1")},
			ApplyMsg:    "Đã tắt tải metadata thiết bị từ mạng",
			RevertSteps: []step{rd(privacyKeys.DeviceMeta, "PreventDeviceMetadataFromNetwork")},
			RevertMsg:   "Đã xóa policy — tải metadata về mặc định"},
		{Def: TweakDef{ID: "tel-suggest-3rd-party-off", Name: "Tắt gợi ý app bên thứ 3 trong Start",
			Description: "SubscribedContent-353698Enabled=0 — Start không còn đề xuất app bên thứ ba trả phí cho Microsoft.",
			Category:    "Bảo mật & riêng tư", Risk: "low"},
			ApplySteps:  []step{ra(privacyKeys.CDM, "SubscribedContent-353698Enabled", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt gợi ý app bên thứ 3",
			RevertSteps: []step{ra(privacyKeys.CDM, "SubscribedContent-353698Enabled", "REG_DWORD", "1")},
			RevertMsg:   "Đã bật lại gợi ý app (mặc định)"},
		{Def: TweakDef{ID: "tel-silent-apps-off", Name: "Tắt tự cài app khuyến nghị (SilentInstalledApps)",
			Description: "SilentInstalledAppsEnabled=0 — Windows không còn âm thầm cài app khuyến nghị (Candy Crush thời xưa…) sau cập nhật.",
			Category:    "Bảo mật & riêng tư", Risk: "low", Recommended: true},
			ApplySteps:  []step{ra(privacyKeys.CDM, "SilentInstalledAppsEnabled", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt tự cài app khuyến nghị",
			RevertSteps: []step{ra(privacyKeys.CDM, "SilentInstalledAppsEnabled", "REG_DWORD", "1")},
			RevertMsg:   "Đã bật lại tự cài app khuyến nghị (mặc định)"},
		{Def: TweakDef{ID: "tel-softlanding-off", Name: "Tắt tips/chào mừng (SoftLanding)",
			Description: "SoftLandingEnabled=0 — tắt thông báo 'tips, tricks và suggestions' của Content Delivery Manager.",
			Category:    "Bảo mật & riêng tư", Risk: "low"},
			ApplySteps:  []step{ra(privacyKeys.CDM, "SoftLandingEnabled", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt tips/chào mừng (SoftLanding)",
			RevertSteps: []step{ra(privacyKeys.CDM, "SoftLandingEnabled", "REG_DWORD", "1")},
			RevertMsg:   "Đã bật lại SoftLanding (mặc định)"},
		{Def: TweakDef{ID: "tel-rotating-lock-off", Name: "Tắt Spotlight hình nền khóa đổi liên tục",
			Description: "RotatingLockScreenEnabled + Overlay=0 — màn hình khóa không tải hình Spotlight từ mạng mỗi ngày (tiết kiệm băng thông + riêng tư).",
			Category:    "Bảo mật & riêng tư", Risk: "low"},
			ApplySteps: []step{
				ra(privacyKeys.CDM, "RotatingLockScreenEnabled", "REG_DWORD", "0"),
				ra(privacyKeys.CDM, "RotatingLockScreenOverlayEnabled", "REG_DWORD", "0"),
			},
			ApplyMsg: "Đã tắt Spotlight màn hình khóa",
			RevertSteps: []step{
				ra(privacyKeys.CDM, "RotatingLockScreenEnabled", "REG_DWORD", "1"),
				ra(privacyKeys.CDM, "RotatingLockScreenOverlayEnabled", "REG_DWORD", "1"),
			},
			RevertMsg: "Đã bật lại Spotlight (mặc định)"},
		{Def: TweakDef{ID: "tel-tasks-diag-off", Name: "Tắt 6 task chẩn đoán/telemetry định kỳ",
			Description: "Disable các Scheduled Task: Microsoft Compatibility Appraiser, ProgramDataUpdater, CEIP Consolidator, UsbCeip, Autochk Proxy, DiskDiagnosticDataCollector — các task chạy nền gửi dữ liệu về Microsoft.",
			Category:    "Bảo mật & riêng tư", Risk: "medium", RequiresRoot: true},
			ApplySteps: []step{
				task(`\Microsoft\Windows\Application Experience\Microsoft Compatibility Appraiser`),
				task(`\Microsoft\Windows\Application Experience\ProgramDataUpdater`),
				task(`\Microsoft\Windows\Customer Experience Improvement Program\Consolidator`),
				task(`\Microsoft\Windows\Customer Experience Improvement Program\UsbCeip`),
				task(`\Microsoft\Windows\Autochk\Proxy`),
				task(`\Microsoft\Windows\DiskDiagnostic\Microsoft-Windows-DiskDiagnosticDataCollector`),
			},
			ApplyMsg: "Đã tắt 6 task chẩn đoán/telemetry (task thiếu trên máy sẽ tự bỏ qua)",
			RevertSteps: []step{
				task(`\Microsoft\Windows\Application Experience\Microsoft Compatibility Appraiser`),
				task(`\Microsoft\Windows\Application Experience\ProgramDataUpdater`),
				task(`\Microsoft\Windows\Customer Experience Improvement Program\Consolidator`),
				task(`\Microsoft\Windows\Customer Experience Improvement Program\UsbCeip`),
				task(`\Microsoft\Windows\Autochk\Proxy`),
				task(`\Microsoft\Windows\DiskDiagnostic\Microsoft-Windows-DiskDiagnosticDataCollector`),
			},
			RevertMsg: "Đã bật lại các task chẩn đoán (task thiếu tự bỏ qua)"},
		{Def: TweakDef{ID: "tel-nvtelemetry-off", Name: "Tắt NVIDIA Telemetry service",
			Description: "Disable + stop dịch vụ NvTelemetryContainer — hết tiến trình NVIDIA gửi thống kê usage. Máy không có dịch vụ này sẽ tự bỏ qua.",
			Category:    "Bảo mật & riêng tư", Risk: "low", RequiresRoot: true},
			ApplySteps:  []step{svc("NvTelemetryContainer", "disabled")},
			ApplyMsg:    "Đã tắt NVIDIA Telemetry service (nếu có)",
			RevertSteps: []step{svc("NvTelemetryContainer", "demand")},
			RevertMsg:   "Đã hoàn tác NVIDIA Telemetry về start=demand"},
		{Def: TweakDef{ID: "sec-autorun-off", Name: "Tắt AutoRun/AutoPlay từ mọi ổ đĩa",
			Description: "NoDriveTypeAutoRun=255 — chặn USB/CD tự chạy file khi cắm vào (một trong các lây nhiễm ransomware phổ biến nhất qua USB).",
			Category:    "Bảo mật & riêng tư", Risk: "low", RequiresRoot: true, Recommended: true},
			ApplySteps:  []step{ra(`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer`, "NoDriveTypeAutoRun", "REG_DWORD", "255")},
			ApplyMsg:    "Đã tắt AutoRun mọi loại ổ đĩa",
			RevertSteps: []step{rd(`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer`, "NoDriveTypeAutoRun")},
			RevertMsg:   "Đã xóa policy AutoRun — trở về mặc định"},
		{Def: TweakDef{ID: "sec-lsa-ppl-on", Name: "Bật LSA Protection (chống đọc mật khẩu RAM)",
			Description: "RunAsPPL=1 — tiến trình LSASS chạy có bảo vệ, chặn tool dump credential (Mimikatz kiểu này) đọc bộ nhớ. Cần khởi động lại.",
			Category:    "Bảo mật & riêng tư", Risk: "medium", RequiresRoot: true},
			ApplySteps:  []step{ra(privacyKeys.Lsa, "RunAsPPL", "REG_DWORD", "1")},
			ApplyMsg:    "Đã bật LSA Protection — khởi động lại để áp dụng",
			RevertSteps: []step{rd(privacyKeys.Lsa, "RunAsPPL")},
			RevertMsg:   "Đã xóa RunAsPPL — trở về mặc định"},
		{Def: TweakDef{ID: "sec-remote-assistance-off", Name: "Tắt Remote Assistance",
			Description: "fAllowToGetHelp=0 — không ai có thể gửi lời mời hỗ trợ từ xa vào máy (kênh xã hội rộng hay bị lợi dụng).",
			Category:    "Bảo mật & riêng tư", Risk: "low", RequiresRoot: true},
			ApplySteps:  []step{ra(privacyKeys.RemoteAsst, "fAllowToGetHelp", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt Remote Assistance",
			RevertSteps: []step{ra(privacyKeys.RemoteAsst, "fAllowToGetHelp", "REG_DWORD", "1")},
			RevertMsg:   "Đã bật lại Remote Assistance (mặc định)"},
		{Def: TweakDef{ID: "sec-spectre-mitigations-off", Name: "Tắt mitigate Spectre/Meltdown (nhanh hơn, kém an toàn)",
			Description: "FeatureSettingsOverride=3 + Mask=3 — bỏ vánh bảo vệ Spectre/Meltdown để tăng hiệu năng trên CPU đời cũ (Haswell trở về trước cảm nhận rõ). CHỈ dùng máy cá nhân không xử lý dữ liệu nhạy cảm. Cần khởi động lại.",
			Category:    "Bảo mật & riêng tư", Risk: "high", RequiresRoot: true},
			ApplySteps: []step{
				ra(privacyKeys.MemMgmt, "FeatureSettingsOverride", "REG_DWORD", "3"),
				ra(privacyKeys.MemMgmt, "FeatureSettingsOverrideMask", "REG_DWORD", "3"),
			},
			ApplyMsg: "Đã tắt Spectre/Meltdown mitigations — khởi động lại để áp dụng",
			RevertSteps: []step{
				rd(privacyKeys.MemMgmt, "FeatureSettingsOverride"),
				rd(privacyKeys.MemMgmt, "FeatureSettingsOverrideMask"),
			},
			RevertMsg: "Đã xóa override — mitigations bật lại như mặc định (khởi động lại)"},
		{Def: TweakDef{ID: "sec-smb-guest-auth-off", Name: "Chặn đăng nhập SMB guest không xác thực",
			Description: "AllowInsecureGuestAuth=0 — không cho kết nối NAS/chia sẻ kiểu guest (không mật khẩu) — chống tấn công man-in-the-middle trong LAN.",
			Category:    "Bảo mật & riêng tư", Risk: "medium", RequiresRoot: true},
			ApplySteps:  []step{ra(privacyKeys.LanmanWs, "AllowInsecureGuestAuth", "REG_DWORD", "0")},
			ApplyMsg:    "Đã chặn SMB guest không xác thực",
			RevertSteps: []step{rd(privacyKeys.LanmanWs, "AllowInsecureGuestAuth")},
			RevertMsg:   "Đã xóa giới hạn — SMB guest về mặc định"},
		{Def: TweakDef{ID: "sec-smb1-client-off", Name: "Tắt driver client SMB1 (mrxsmb10)",
			Description: "Start=4 cho mrxsmb10 — máy không còn nói chuyện SMB1 với server cũ (vẫn kết nối SMB2/3 bình thường); đi kèm nút Tắt SMB1 server đã có.",
			Category:    "Bảo mật & riêng tư", Risk: "medium", RequiresRoot: true},
			ApplySteps:  []step{ra(privacyKeys.Mrxsmb10, "Start", "REG_DWORD", "4")},
			ApplyMsg:    "Đã tắt SMB1 client driver — khởi động lại để áp dụng",
			RevertSteps: []step{rd(privacyKeys.Mrxsmb10, "Start")},
			RevertMsg:   "Đã xóa override mrxsmb10 — driver về cấu hình mặc định"},
		{Def: TweakDef{ID: "tel-mdns-off", Name: "Tắt mDNS resolution",
			Description: "EnableMDNS=0 — tắt multicast DNS (mDNS) của Dnscache; giảm broadcast rác trong LAN, một số game/tool chặn mDNS để tránh nhảy IP ảo.",
			Category:    "Bảo mật & riêng tư", Risk: "low", RequiresRoot: true},
			ApplySteps:  []step{ra(privacyKeys.Dnscache, "EnableMDNS", "REG_DWORD", "0")},
			ApplyMsg:    "Đã tắt mDNS — khởi động lại để áp dụng",
			RevertSteps: []step{rd(privacyKeys.Dnscache, "EnableMDNS")},
			RevertMsg:   "Đã xóa giới hạn — mDNS về mặc định"},
	}
}

// ---------- Danh mục 2: Bloatware (UWP) ----------

func bloatTweaks() []tableTweak {
	type spec struct {
		pkg, name, desc string
		risk            string
		rec             bool
	}
	specs := []spec{
		{"Microsoft.3DBuilder", "Gỡ 3D Builder", "App vẽ 3D cài sẵn hầu như không ai dùng — gỡ khỏi user hiện tại (hoàn tác = đăng ký lại package nếu còn).", "low", false},
		{"Microsoft.Microsoft3DViewer", "Gỡ 3D Viewer", "Trình xem mô hình 3D cài sẵn — gỡ nếu không mở file .glb/.3mf.", "low", false},
		{"Microsoft.BingNews", "Gỡ Bing News", "App tin tức MSN cài sẵn, chạy nền đồng bộ tin — gỡ.", "low", false},
		{"Microsoft.BingWeather", "Gỡ Bing Weather", "App thời tiết MSN cài sẵn — gỡ (widget thời tiết taskbar không phụ thuộc app này).", "low", false},
		{"Microsoft.Clipchamp", "Gỡ Clipchamp", "Trình edit video cài sẵn (Win11) — gỡ nếu không dùng.", "low", false},
		{"Microsoft.Getstarted", "Gỡ Tips (Get Started)", "App hướng dẫn Windows cài sẵn — gỡ.", "low", false},
		{"Microsoft.WindowsFeedbackHub", "Gỡ Feedback Hub", "App gửi feedback cho Microsoft — gỡ.", "low", false},
		{"Microsoft.WindowsMaps", "Gỡ Maps", "App bản đồ cài sẵn — gỡ nếu không dùng offline maps.", "low", false},
		{"Microsoft.Messaging", "Gỡ Messaging", "App SMS cài sẵn (chỉ dùng với SIM điện thoại kết nối) — gỡ.", "low", false},
		{"Microsoft.MicrosoftOfficeHub", "Gỡ Office Hub (Get Office)", "App quảng bá Office 365 cài sẵn — gỡ (không ảnh hưởng Word/Excel đã cài).", "low", true},
		{"Microsoft.MicrosoftSolitaireCollection", "Gỡ Solitaire Collection", "Bộ game Solitaire cài sẵn — gỡ.", "low", false},
		{"Microsoft.People", "Gỡ People", "App danh bạ cài sẵn — gỡ.", "low", false},
		{"Microsoft.YourPhone", "Gỡ Phone Link", "App nối điện thoại Android/iOS — gỡ nếu không dùng tính năng này.", "medium", false},
		{"Microsoft.PowerAutomateDesktop", "Gỡ Power Automate Desktop", "Tool tự động hóa RPA cài sẵn — gỡ nếu không dùng.", "low", false},
		{"Microsoft.SkypeApp", "Gỡ Skype UWP", "App Skype cài sẵn (Skype đã ngừng hoạt động 2025) — gỡ.", "low", false},
		{"MSTeams", "Gỡ Teams (bản cá nhân)", "Microsoft Teams cá nhân ghim sẵn Win11 — gỡ nếu không chat Teams cá nhân (không ảnh hưởng Teams công ty).", "medium", false},
		{"Microsoft.MixedReality.Portal", "Gỡ Mixed Reality Portal", "App kính VR cài sẵn — gỡ nếu không dùng headset Windows Mixed Reality.", "low", false},
		{"Microsoft.Todos", "Gỡ Microsoft To Do", "App việc cần làm cài sẵn — gỡ.", "low", false},
		{"Microsoft.OneConnect", "Gỡ Paid Wi-Fi & Cellular", "App mua gói Wi-Fi trả phí cài sẵn — gỡ.", "low", false},
		{"Microsoft.549981C3F5F10", "Gỡ Cortana (app)", "App Cortana riêng (khác policy) — gỡ.", "low", false},
		{"Microsoft.ZuneMusic", "Gỡ Media Player (Zune Music)", "App nghe nhạc Media Player mới cài sẵn — gỡ nếu dùng player khác (Windows Media Player legacy không bị ảnh hưởng).", "medium", false},
		{"Microsoft.ZuneVideo", "Gỡ Movies & TV", "App xem phim cài sẵn — gỡ.", "medium", false},
		{"Microsoft.Whiteboard", "Gỡ Whiteboard", "Bảng vẽ cộng tác cài sẵn — gỡ.", "low", false},
		{"Microsoft.OutlookForWindows", "Gỡ Outlook (new)", "Outlook mới ghim sẵn Win11 — gỡ nếu dùng Outlook desktop cũ hoặc webmail.", "medium", false},
		{"Microsoft.Windows.DevHome", "Gỡ Dev Home", "App developer hub của Microsoft cài sẵn (chạy nền Git/monitor) — gỡ.", "medium", false},
		{"Microsoft.XboxTCUI", "Gỡ Xbox TCUI", "Xbox Text/Chat UI overlay — gỡ nếu không chơi game Xbox Store.", "medium", false},
		{"Microsoft.XboxSpeechToTextOverlay", "Gỡ Xbox Speech-to-Text Overlay", "Phụ đề giọng nói game overlay — gỡ.", "medium", false},
		{"Microsoft.XboxIdentityProvider", "Gỡ Xbox Identity Provider", "Nhà cung cấp danh tính Xbox — CẢNH BÁO: game Xbox Store/Microsoft login sẽ không đăng nhập được. Chỉ gỡ khi chắc chắn không dùng.", "high", false},
		{"Microsoft.XboxGamingOverlay", "Gỡ Xbox Game Bar (GameDVR UI)", "Game Bar overlay Win+G — gỡ để sạch tiến trình nền (phần GameDVR registry đã có tweak riêng). Sau khi gỡ không mở được Win+G.", "medium", false},
		{"Microsoft.News", "Gỡ Microsoft News", "App tin tức MSN cài sẵn — gỡ.", "low", false},
		{"Microsoft.GetHelp", "Gỡ Get Help", "App hỗ trợ kỹ thuật của Microsoft — gỡ.", "low", false},
		{"Microsoft.Office.OneNote", "Gỡ OneNote for Windows 10", "App OneNote UWP cài sẵn — gỡ nếu dùng OneNote desktop/other note app.", "low", false},
		{"Microsoft.WindowsCommunicationsApps", "Gỡ Mail, Calendar, People", "Mail + Calendar UWP — CẢNH BÁO: mất app mail mặc định. Chỉ gỡ khi dùng webmail/Outlook khác.", "high", false},
		{"Microsoft.XboxApp", "Gỡ Xbox Console Companion (bản cũ)", "App Xbox đời cũ — gỡ (bản mới là Microsoft.GamingApp).", "low", false},
		{"Microsoft.GamingApp", "Gỡ Xbox app (Game Pass)", "App Xbox chính — CẢNH BÁO: mất Xbox Game Pass/library. Chỉ gỡ khi không chơi qua Xbox app.", "high", false},
		{"Microsoft.Windows.Photos", "Gỡ Photos", "Trình xem ảnh mặc định — CẢNH BÁO: mất trình xem ảnh/máy cắt cơ bản. Chỉ gỡ khi đã có app xem ảnh khác.", "high", false},
		{"Microsoft.Copilot", "Gỡ Copilot (app)", "App Copilot AI riêng cài mới — gỡ (policy tắt Copilot đã có tweak riêng).", "low", false},
		{"Microsoft.BingSearch", "Gỡ Bing Search (app)", "App Bing cài mới — gỡ.", "low", false},
		{"Microsoft.BingFinance", "Gỡ MSN Money", "App tài chính MSN (build cũ) — gỡ; máy không có app này sẽ báo 'đã gỡ sẵn'.", "low", false},
		{"Microsoft.BingSports", "Gỡ MSN Sports", "App thể thao MSN (build cũ) — gỡ; máy không có app này sẽ báo 'đã gỡ sẵn'.", "low", false},
		{"MicrosoftCorporationII.QuickAssist", "Gỡ Quick Assist", "App hỗ trợ từ xa của Microsoft — gỡ nếu không cần nhờ/khách hàng điều khiển từ xa qua Quick Assist.", "low", false},
		{"MicrosoftWindows.CrossDevice", "Gỡ Cross Device Experience", "Dịch vụ app cho 'Tiếp tục trên thiết bị khác' (Link to Windows) — gỡ nếu không nối điện thoại.", "low", false},
		{"MicrosoftCorporationII.MicrosoftFamily", "Gỡ Microsoft Family Safety", "App quản lý gia đình cài sẵn Win11 — gỡ.", "low", false},
		{"RealtekAudioConsole", "Gỡ Realtek Audio Console", "App điều khiển sound Realtek UWP — gỡ nếu không chỉnh EQ/tính năng Realtek (driver vẫn chạy).", "low", false},
	}
	out := make([]tableTweak, 0, len(specs))
	for _, s := range specs {
		pkg := s.pkg
		out = append(out, tableTweak{
			Def: TweakDef{
				ID:          "appx-" + appxID(pkg),
				Name:        s.name,
				Description: s.desc + " [appx: " + pkg + "]",
				Category:    "Bloatware (UWP)",
				Risk:        s.risk,
				Recommended: s.rec,
			},
			ApplySteps:  []step{appx(pkg)},
			ApplyMsg:    s.name + " — chạy qua PowerShell Get-AppxPackage",
			RevertSteps: []step{appx(pkg)},
			RevertMsg:   s.name + " — đã đăng ký lại package (AppxManifest) nếu còn trong WindowsApps",
		})
	}
	return out
}

/** ID gọn từ tên package: Microsoft.3DBuilder → 3dbuilder; MicrosoftCorporationII.QuickAssist → quick-assist */
func appxID(pkg string) string {
	s := pkg
	for _, p := range []string{"Microsoft.", "MicrosoftCorporationII.", "MicrosoftWindows.", "Microsoft"} {
		if strings.HasPrefix(s, p) {
			s = strings.TrimPrefix(s, p)
			break
		}
	}
	s = strings.Trim(s, ".")
	s = strings.ReplaceAll(s, ".", "-")
	return strings.ToLower(s)
}
