// tweaks.go — catalog 35 tinh chỉnh Windows (port 1:1 từ src/lib/tweaks.ts nhánh TWEAK_ACTIONS_WIN)
// reg.exe/powercfg/sc.exe/bcdedit/ipconfig spawn TRỰC TIẾP theo đường dẫn tuyệt đối; exit code là
// chuẩn đánh giá (reg.exe bị localize trên Win vi-VN — không parse text). Bỏ nhánh Linux root.
package main

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

type TweakDef struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Risk        string `json:"risk"` // low|medium|high
	RequiresRoot bool  `json:"requiresRoot"`
	Recommended bool   `json:"recommended"`
	Order       int    `json:"order"`
}

type Tweak struct {
	TweakDef
	Applied    bool   `json:"applied"`
	Partial    bool   `json:"partial,omitempty"` // v4.1.0 (08-E): một phần đã đổi máy / hoàn tác thất bại còn sót
	AppliedAt  string `json:"appliedAt,omitempty"`
	LastResult string `json:"lastResult,omitempty"`
}

type ActionResult struct {
	Success bool
	Message string
}

type TweakAction struct {
	Def    TweakDef
	Apply  func() ActionResult
	Revert func() ActionResult
}

type TweakRunResult struct {
	ID      string `json:"id"`
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// ---------- Registry keys (giữ nguyên từ bản TS) ----------

const regGameConfig = `HKCU\System\GameConfigStore`
const regGameDVR = `HKCU\Software\Microsoft\Windows\CurrentVersion\GameDVR`
const regGameBar = `HKCU\Software\Microsoft\GameBar`
const regSysMulti = `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile`
const regMouse = `HKCU\Control Panel\Mouse`
const regVisualFX = `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer`
const regPersonalize = `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize`
const regSerialize = `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Serialize`
const regCDM = `HKCU\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager`
const regKeyboard = `HKCU\Control Panel\Keyboard`
const regAccess = `HKCU\Control Panel\Accessibility`
const regDesktop = `HKCU\Control Panel\Desktop`
const regAdvanced = `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced`
const regPriority = `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PriorityControl`
const regGraphics = `HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers`
const regMMCSSGaming = `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Gaming`
const regDNSPolicy = `HKLM\SOFTWARE\Policies\Microsoft\Windows NT\DNSClient`
const regCopilot = `HKCU\Software\Policies\Microsoft\Windows\WindowsCopilot`
const regBGApps = `HKCU\Software\Microsoft\Windows\CurrentVersion\BackgroundAccessApplications`
const regLanmanSrv = `HKLM\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters`
const regNetBTIf = `HKLM\SYSTEM\CurrentControlSet\Services\NetBT\Parameters\Interfaces`
const powercfgGuidCurrent = "scheme_current"
const bcdTickName = "disabledynamictick"

const noRegExeMsg = "Không tìm thấy reg.exe trong System32 — không thao tác được registry"

type RegValue struct {
	Name string
	Type string // REG_DWORD | REG_SZ
	Data string
}

/** v4.3.0 (P1-08): output của bcdedit xác nhận value KHÔNG CÒN — phân biệt với
 * access denied/BCD lỗi; chỉ các pattern này mới được coi là "đã ở trạng thái mặc định". */
func bcdValueAbsentOutput(out string) bool {
	out = strings.ToLower(out)
	return strings.Contains(out, "could not be found") || strings.Contains(out, "cannot find") ||
		strings.Contains(out, "not found") || strings.Contains(out, "unable to find")
}

func regAddValues(key string, values []RegValue, okMsg string) ActionResult {
	reg := findSysExe("reg.exe")
	if reg == "" {
		return ActionResult{false, noRegExeMsg}
	}
	okN := 0
	var firstErr string
	for _, v := range values {
		r := runExe(reg, []string{"add", key, "/v", v.Name, "/t", v.Type, "/d", v.Data, "/f"}, 15*time.Second)
		if !r.OK {
			if firstErr == "" {
				firstErr = truncateShort(fmt.Sprintf(
					"reg.exe add %s\\%s thất bại (exit %d): %s", key, v.Name, r.Code, orDefault(r.Stderr, r.Stdout, "không rõ lý do")))
			}
			if okN > 0 {
				// v4.3.0 (P2-03): đã ghi được một phần trước khi lỗi → đánh dấu PARTIAL để
				// UI/state biết máy đã bị thay đổi một phần (revert vẫn có nghĩa)
				return ActionResult{false, fmt.Sprintf("MỘT PHẦN ĐÃ ÁP DỤNG (%d/%d value) — dừng tại: %s; bấm Khôi phục để trả phần đã ghi", okN, len(values), firstErr)}
			}
			return ActionResult{false, firstErr}
		}
		okN++
	}
	return ActionResult{true, okMsg}
}

/** Xóa giá trị: reg query exit != 0 = chưa từng set (không phải lỗi); delete lỗi mới là lỗi thật.
 * v3.9.0 (theo audit P2-01): danh sách value bị bỏ qua (không tìm thấy / không đọc được) được
 * ghi vào message thay vì nuốt cộc lốc — lỗi quyền sẽ lộ qua phần delete thất bại. */
func regDeleteValues(key string, names []string, okMsg string) ActionResult {
	reg := findSysExe("reg.exe")
	if reg == "" {
		return ActionResult{false, noRegExeMsg}
	}
	// v4.1.0 (phát hiện 08-A): skipped chỉ gồm NotFound RÕ RÀNG ("unable to find");
	// query fail vì lý do khác (access denied...) là lỗi thật, không được coi là "chưa từng set"
	var failed, notFound, queryErr []string
	for _, n := range names {
		q := runExe(reg, []string{"query", key, "/v", n}, 15*time.Second)
		if !q.OK {
			out := strings.ToLower(q.Stdout + q.Stderr)
			if strings.Contains(out, "unable to find") || strings.Contains(out, "cannot find") {
				notFound = append(notFound, n)
			} else {
				queryErr = append(queryErr, fmt.Sprintf("%s (exit %d: %s)", n, q.Code, orDefault(q.Stderr, q.Stdout, "không rõ lý do")))
			}
			continue
		}
		d := runExe(reg, []string{"delete", key, "/v", n, "/f"}, 15*time.Second)
		if !d.OK {
			failed = append(failed, fmt.Sprintf("%s (exit %d: %s)", n, d.Code, orDefault(d.Stderr, d.Stdout, "không rõ lý do")))
			continue
		}
		// read-back verify: delete exit 0 nhưng value còn → không tính xong
		q2 := runExe(reg, []string{"query", key, "/v", n}, 15*time.Second)
		if q2.OK {
			failed = append(failed, n+" (delete exit 0 nhưng read-back vẫn thấy value)")
		}
	}
	if len(failed) > 0 || len(queryErr) > 0 {
		msg := truncateShort("reg.exe delete chưa trọn: " + strings.Join(append(failed, queryErr...), "; "))
		if len(notFound) > 0 {
			msg += fmt.Sprintf(" (bỏ qua %d value vốn không tồn tại: %s)", len(notFound), strings.Join(notFound, ", "))
		}
		return ActionResult{false, msg}
	}
	msg := okMsg
	if len(notFound) > 0 {
		msg += fmt.Sprintf(" (bỏ qua %d value vốn không có: %s)", len(notFound), strings.Join(notFound, ", "))
	}
	return ActionResult{true, truncateShort(msg)}
}

func orDefault(a, b, c string) string {
	if strings.TrimSpace(a) != "" {
		return strings.TrimSpace(a)
	}
	if strings.TrimSpace(b) != "" {
		return strings.TrimSpace(b)
	}
	return c
}

var tcpipGUIDRe = regexp.MustCompile(`(?i)\\Tcpip_\{[0-9a-f-]{36}\}$`)
var guidRe = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
var hklmLineRe = regexp.MustCompile(`(?i)^HKLM\\|^HKEY_LOCAL_MACHINE\\`)

/** reg query liệt kê subkey dạng dòng HKEY_LOCAL_MACHINE\... — chuẩn hóa về HKLM\... */
func regListSubkeys(reg string, base string, timeout time.Duration) ([]string, RunResult) {
	q := runExe(reg, []string{"query", base}, timeout)
	if !q.OK {
		return nil, q
	}
	var keys []string
	for _, ln := range strings.Split(q.Stdout, "\n") {
		ln = strings.TrimSpace(strings.ReplaceAll(ln, "HKEY_LOCAL_MACHINE\\", "HKLM\\"))
		if strings.HasPrefix(strings.ToUpper(ln), "HKLM\\") {
			keys = append(keys, ln)
		}
	}
	return keys, q
}

// ---------- Catalog (35 mục, đúng id/name/description/message của bản TS) ----------

func tweakCatalog() []TweakAction {
	return []TweakAction{
		{
			Def: TweakDef{ID: "win-game-dvr-off", Name: "Tắt Game DVR / ghi hình nền",
				Description: "Tắt ghi hình nền Xbox Game DVR/AppCapture để giảm overhead GPU và ổ đĩa khi chơi game.",
				Category: "Gaming", Risk: "medium", Recommended: true, Order: 1},
			Apply: func() ActionResult {
				a := regAddValues(regGameConfig, []RegValue{{"GameDVR_Enabled", "REG_DWORD", "0"}}, "")
				if !a.Success {
					return a
				}
				b := regAddValues(regGameDVR, []RegValue{{"AppCaptureEnabled", "REG_DWORD", "0"}}, "")
				if !b.Success {
					return b
				}
				return ActionResult{true, "Đã tắt Game DVR (GameDVR_Enabled=0 + AppCaptureEnabled=0)"}
			},
			Revert: func() ActionResult {
				a := regAddValues(regGameConfig, []RegValue{{"GameDVR_Enabled", "REG_DWORD", "1"}}, "")
				if !a.Success {
					return a
				}
				b := regAddValues(regGameDVR, []RegValue{{"AppCaptureEnabled", "REG_DWORD", "1"}}, "")
				if !b.Success {
					return b
				}
				return ActionResult{true, "Đã bật lại Game DVR (GameDVR_Enabled=1 + AppCaptureEnabled=1)"}
			},
		},
		{
			Def: TweakDef{ID: "win-gamemode-on", Name: "Bật Windows Game Mode",
				Description: "Bật Game Mode để Windows ưu tiên tài nguyên cho game và hoãn các tác vụ nền/cập nhật khi chơi.",
				Category: "Gaming", Risk: "low", Recommended: true, Order: 2},
			Apply: func() ActionResult {
				return regAddValues(regGameBar, []RegValue{
					{"AutoGameModeEnabled", "REG_DWORD", "1"}, {"AllowAutoGameMode", "REG_DWORD", "1"},
				}, "Đã bật Windows Game Mode (AutoGameModeEnabled + AllowAutoGameMode=1)")
			},
			Revert: func() ActionResult {
				return regDeleteValues(regGameBar, []string{"AutoGameModeEnabled", "AllowAutoGameMode"},
					"Đã xóa giá trị Game Mode — Windows trở về mặc định")
			},
		},
		{
			Def: TweakDef{ID: "win-fse-off", Name: "Tắt fullscreen optimizations",
				Description: "Tắt fullscreen optimizations để game chiếm exclusive fullscreen thật, giảm độ trễ hiển thị và stutter.",
				Category: "Gaming", Risk: "medium", Recommended: true, Order: 3},
			Apply: func() ActionResult {
				return regAddValues(regGameConfig, []RegValue{
					{"GameDVR_FSEBehaviorMode", "REG_DWORD", "2"},
					{"GameDVR_HonorUserFSEBehaviorMode", "REG_DWORD", "1"},
					{"GameDVR_DXGIHonorFSEWindowsCompatible", "REG_DWORD", "1"},
					{"GameDVR_EFSEFeatureFlags", "REG_DWORD", "0"},
				}, "Đã tắt fullscreen optimizations (GameDVR_FSEBehaviorMode=2)")
			},
			Revert: func() ActionResult {
				return regDeleteValues(regGameConfig, []string{
					"GameDVR_FSEBehaviorMode", "GameDVR_HonorUserFSEBehaviorMode",
					"GameDVR_DXGIHonorFSEWindowsCompatible", "GameDVR_EFSEFeatureFlags",
				}, "Đã xóa 4 giá trị FSE — trả về mặc định của Windows")
			},
		},
		{
			Def: TweakDef{ID: "win-power-high", Name: "Chuyển kế hoạch nguồn Hiệu năng cao",
				Description: "powercfg /setactive sang High performance; nếu máy chưa có kế hoạch này sẽ tự nhân bản từ mẫu ẩn rồi bật.",
				Category: "Hiệu năng", Risk: "medium", RequiresRoot: true, Recommended: true, Order: 4},
			Apply: func() ActionResult {
				if m, ok := adminGate(); !ok {
					return ActionResult{false, m}
				}
				direct := runSysExe("powercfg.exe", []string{"/setactive", "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"}, 30*time.Second)
				if direct.OK {
					return ActionResult{true, "Đã bật kế hoạch nguồn Hiệu năng cao (High performance)"}
				}
				dup := runSysExe("powercfg.exe", []string{"-duplicatescheme", "e9a42b02-d5df-448d-aa00-03f14749eb61"}, 30*time.Second)
				guid := guidRe.FindString(dup.Stdout)
				if !dup.OK || guid == "" {
					return ActionResult{false, truncateShort(fmt.Sprintf("Không bật được kế hoạch Hiệu năng cao (exit %d): %s",
						direct.Code, orDefault(direct.Stderr, direct.Stdout, "không rõ lý do")))}
				}
				act := runSysExe("powercfg.exe", []string{"/setactive", guid}, 30*time.Second)
				if !act.OK {
					return ActionResult{false, truncateShort(fmt.Sprintf("Không kích hoạt được kế hoạch mới %s: %s", guid, orDefault(act.Stderr, "", "không rõ lý do")))}
				}
				return ActionResult{true, fmt.Sprintf("Đã tạo mới và bật kế hoạch nguồn Hiệu năng cao (%s)", guid)}
			},
			Revert: func() ActionResult {
				if m, ok := adminGate(); !ok {
					return ActionResult{false, m}
				}
				r := runSysExe("powercfg.exe", []string{"/setactive", "381b4222-f694-41f0-9685-ff5bb260df2e"}, 30*time.Second)
				if !r.OK {
					return ActionResult{false, truncateShort(fmt.Sprintf("Không hoàn tác được kế hoạch nguồn (exit %d): %s",
						r.Code, orDefault(r.Stderr, r.Stdout, "không rõ lý do")))}
				}
				return ActionResult{true, "Đã hoàn tác kế hoạch nguồn về Balanced (mặc định)"}
			},
		},
		{
			Def: TweakDef{ID: "win-sysresp", Name: "SystemResponsiveness = 0 (ưu tiên app foreground)",
				Description: "Đặt SystemResponsiveness=0 để MMCSS ưu tiên CPU cho ứng dụng foreground thay vì dịch vụ nền.",
				Category: "Hiệu năng", Risk: "medium", RequiresRoot: true, Recommended: true, Order: 5},
			Apply: gateWrap(func() ActionResult {
				return regAddValues(regSysMulti, []RegValue{{"SystemResponsiveness", "REG_DWORD", "0"}},
					"Đã đặt SystemResponsiveness=0 — ưu tiên ứng dụng foreground")
			}),
			Revert: gateWrap(func() ActionResult {
				return regAddValues(regSysMulti, []RegValue{{"SystemResponsiveness", "REG_DWORD", "20"}},
					"Đã hoàn tác SystemResponsiveness về 20 (mặc định)")
			}),
		},
		{
			Def: TweakDef{ID: "win-netthrottle", Name: "Tắt Network Throttling",
				Description: "Đặt NetworkThrottlingIndex=0xFFFFFFFF để tắt giới hạn băng thông nền khi có multimedia đang phát.",
				Category: "Mạng", Risk: "medium", RequiresRoot: true, Recommended: true, Order: 6},
			Apply: gateWrap(func() ActionResult {
				return regAddValues(regSysMulti, []RegValue{{"NetworkThrottlingIndex", "REG_DWORD", "4294967295"}},
					"Đã tắt Network Throttling (NetworkThrottlingIndex=0xFFFFFFFF)")
			}),
			Revert: gateWrap(func() ActionResult {
				return regAddValues(regSysMulti, []RegValue{{"NetworkThrottlingIndex", "REG_DWORD", "10"}},
					"Đã hoàn tác NetworkThrottlingIndex về 10 (mặc định)")
			}),
		},
		{
			Def: TweakDef{ID: "win-nagle", Name: "Tắt Nagle (giảm ping game online)",
				Description: "Đặt TcpAckFrequency=1 + TCPNoDelay=1 trên mọi interface TCP/IP để tắt thuật toán Nagle, giảm độ trễ mạng.",
				Category: "Mạng", Risk: "medium", RequiresRoot: true, Recommended: false, Order: 7},
			Apply: gateWrap(nagleSet(true)),
			Revert: gateWrap(nagleSet(false)),
		},
		{
			Def: TweakDef{ID: "win-mouse-accurate", Name: "Tắt gia tốc chuột (aim chính xác)",
				Description: "MouseSpeed=0 và hai ngưỡng =0 để tắt hoàn toàn gia tốc con trỏ — chuyển động chuột 1:1 trong game FPS.",
				Category: "Gaming", Risk: "low", Recommended: true, Order: 8},
			Apply: func() ActionResult {
				return regAddValues(regMouse, []RegValue{
					{"MouseSpeed", "REG_SZ", "0"}, {"MouseThreshold1", "REG_SZ", "0"}, {"MouseThreshold2", "REG_SZ", "0"},
				}, "Đã tắt gia tốc chuột (MouseSpeed=0, Threshold 0/0)")
			},
			Revert: func() ActionResult {
				return regAddValues(regMouse, []RegValue{
					{"MouseSpeed", "REG_SZ", "1"}, {"MouseThreshold1", "REG_SZ", "6"}, {"MouseThreshold2", "REG_SZ", "10"},
				}, "Đã hoàn tác gia tốc chuột về mặc định (1/6/10)")
			},
		},
		{
			Def: TweakDef{ID: "win-visualfx", Name: "Hiệu ứng trực quan: hiệu năng tốt nhất",
				Description: "Đặt VisualFXSetting=2 để Windows tắt các hiệu ứng trực quan nặng, dành tài nguyên cho hiệu năng.",
				Category: "Hiệu năng", Risk: "low", Recommended: false, Order: 9},
			Apply: func() ActionResult {
				return regAddValues(regVisualFX, []RegValue{{"VisualFXSetting", "REG_DWORD", "2"}},
					"Đã đặt hiệu ứng trực quan = hiệu năng tốt nhất (VisualFXSetting=2)")
			},
			Revert: func() ActionResult {
				return regAddValues(regVisualFX, []RegValue{{"VisualFXSetting", "REG_DWORD", "0"}},
					"Đã hoàn tác VisualFXSetting về 0 (để Windows tự chọn)")
			},
		},
		{
			Def: TweakDef{ID: "win-transparency-off", Name: "Tắt hiệu ứng trong suốt",
				Description: "Tắt hiệu ứng acrylic/transparent của Windows để giảm tải GPU và tăng độ mượt của giao diện.",
				Category: "Hiệu năng", Risk: "low", Recommended: false, Order: 10},
			Apply: func() ActionResult {
				return regAddValues(regPersonalize, []RegValue{{"EnableTransparency", "REG_DWORD", "0"}},
					"Đã tắt hiệu ứng trong suốt (EnableTransparency=0)")
			},
			Revert: func() ActionResult {
				return regAddValues(regPersonalize, []RegValue{{"EnableTransparency", "REG_DWORD", "1"}},
					"Đã bật lại hiệu ứng trong suốt (mặc định)")
			},
		},
		{
			Def: TweakDef{ID: "win-startup-delay", Name: "Xóa delay khởi động app",
				Description: "Đặt StartupDelayInMSec=0 (tự tạo key Serialize nếu thiếu) để Windows không trì hoãn khởi chạy app sau đăng nhập.",
				Category: "Hiệu năng", Risk: "low", Recommended: true, Order: 11},
			Apply: func() ActionResult {
				return regAddValues(regSerialize, []RegValue{{"StartupDelayInMSec", "REG_DWORD", "0"}},
					"Đã đặt StartupDelayInMSec=0 — app khởi động không bị trì hoãn")
			},
			Revert: func() ActionResult {
				return regDeleteValues(regSerialize, []string{"StartupDelayInMSec"},
					"Đã xóa StartupDelayInMSec — Windows dùng delay mặc định")
			},
		},
		{
			Def: TweakDef{ID: "win-ram-clean", Name: "Xả RAM tiến trình (EmptyWorkingSet)",
				Description: "Gọi EmptyWorkingSet (psapi.dll) cho mọi tiến trình dùng >50MB RAM (trừ chính app) để ép Windows xả working set.",
				Category: "Bộ nhớ", Risk: "low", Recommended: true, Order: 12},
			Apply: func() ActionResult { return ramEmptyWorkingSet() },
			Revert: func() ActionResult {
				return ActionResult{true, "Hành động tức thời — không cần hoàn tác"}
			},
		},
		{
			Def: TweakDef{ID: "win-flush-dns", Name: "Xả cache DNS (ipconfig /flushdns)",
				Description: "ipconfig /flushdns xóa cache DNS resolver của Windows, giúp phân giải tên miền theo bản ghi mới nhất.",
				Category: "Mạng", Risk: "low", Recommended: true, Order: 13},
			Apply: func() ActionResult {
				r := runSysExe("ipconfig.exe", []string{"/flushdns"}, 30*time.Second)
				if !r.OK {
					return ActionResult{false, truncateShort(fmt.Sprintf("ipconfig /flushdns thất bại (exit %d): %s",
						r.Code, orDefault(r.Stderr, r.Stdout, "không rõ lý do")))}
				}
				return ActionResult{true, "Đã xả cache DNS của Windows (ipconfig /flushdns)"}
			},
			Revert: func() ActionResult {
				return ActionResult{true, "Hành động tức thời — không cần hoàn tác"}
			},
		},
		{
			Def: TweakDef{ID: "win-sysmain-off", Name: "Tắt SysMain (Superfetch) — chỉ nên dùng khi ổ SSD",
				Description: "sc.exe stop + start=disabled cho SysMain; giảm tải nền nhưng làm HDD chậm hơn khi mở app — chỉ dùng khi ổ SSD.",
				Category: "Hiệu năng", Risk: "high", RequiresRoot: true, Recommended: false, Order: 14},
			Apply: gateWrap(func() ActionResult {
				stop := runSysExe("sc.exe", []string{"stop", "SysMain"}, 20*time.Second)
				if !stop.OK && stop.Code != 1062 {
					return ActionResult{false, truncateShort(fmt.Sprintf("sc.exe stop SysMain thất bại (exit %d): %s",
						stop.Code, orDefault(stop.Stderr, stop.Stdout, "không rõ lý do")))}
				}
				cfg := runSysExe("sc.exe", []string{"config", "SysMain", "start=", "disabled"}, 20*time.Second)
				if !cfg.OK {
					return ActionResult{false, truncateShort(fmt.Sprintf("sc.exe config SysMain start=disabled thất bại (exit %d): %s",
						cfg.Code, orDefault(cfg.Stderr, cfg.Stdout, "không rõ lý do")))}
				}
				return ActionResult{true, "Đã tắt dịch vụ SysMain (Superfetch) — start=disabled"}
			}),
			Revert: gateWrap(func() ActionResult {
				cfg := runSysExe("sc.exe", []string{"config", "SysMain", "start=", "auto"}, 20*time.Second)
				if !cfg.OK {
					return ActionResult{false, truncateShort(fmt.Sprintf("sc.exe config SysMain start=auto thất bại (exit %d): %s",
						cfg.Code, orDefault(cfg.Stderr, cfg.Stdout, "không rõ lý do")))}
				}
				_ = runSysExe("sc.exe", []string{"start", "SysMain"}, 20*time.Second) // lỗi start bỏ qua (đã chạy sẵn)
				return ActionResult{true, "Đã hoàn tác SysMain về start=auto (+ thử start — lỗi start được bỏ qua)"}
			}),
		},
		{
			Def: TweakDef{ID: "win-diagtrack-off", Name: "Tắt telemetry (DiagTrack + dmwappushservice)",
				Description: "Disable + stop dịch vụ DiagTrack (Connected User Experiences) và dmwappushservice để dừng gửi dữ liệu chẩn đoán.",
				Category: "Bảo mật & riêng tư", Risk: "medium", RequiresRoot: true, Recommended: false, Order: 15},
			Apply: gateWrap(func() ActionResult {
				cfg1 := runSysExe("sc.exe", []string{"config", "DiagTrack", "start=", "disabled"}, 20*time.Second)
				if !cfg1.OK {
					return ActionResult{false, truncateShort(fmt.Sprintf("sc.exe config DiagTrack thất bại (exit %d): %s",
						cfg1.Code, orDefault(cfg1.Stderr, cfg1.Stdout, "không rõ lý do")))}
				}
				cfg2 := runSysExe("sc.exe", []string{"config", "dmwappushservice", "start=", "disabled"}, 20*time.Second)
				if !cfg2.OK && cfg2.Code != 1060 {
					return ActionResult{false, truncateShort(fmt.Sprintf("sc.exe config dmwappushservice thất bại (exit %d): %s",
						cfg2.Code, orDefault(cfg2.Stderr, cfg2.Stdout, "không rõ lý do")))}
				}
				stop1 := runSysExe("sc.exe", []string{"stop", "DiagTrack"}, 20*time.Second)
				if !stop1.OK && stop1.Code != 1062 && stop1.Code != 1060 {
					return ActionResult{false, truncateShort(fmt.Sprintf("sc.exe stop DiagTrack thất bại (exit %d): %s",
						stop1.Code, orDefault(stop1.Stderr, stop1.Stdout, "không rõ lý do")))}
				}
				_ = runSysExe("sc.exe", []string{"stop", "dmwappushservice"}, 20*time.Second)
				return ActionResult{true, "Đã tắt telemetry: DiagTrack + dmwappushservice (start=disabled)"}
			}),
			Revert: gateWrap(func() ActionResult {
				cfg1 := runSysExe("sc.exe", []string{"config", "DiagTrack", "start=", "auto"}, 20*time.Second)
				if !cfg1.OK {
					return ActionResult{false, truncateShort(fmt.Sprintf("sc.exe config DiagTrack start=auto thất bại (exit %d): %s",
						cfg1.Code, orDefault(cfg1.Stderr, cfg1.Stdout, "không rõ lý do")))}
				}
				cfg2 := runSysExe("sc.exe", []string{"config", "dmwappushservice", "start=", "demand"}, 20*time.Second)
				if !cfg2.OK && cfg2.Code != 1060 {
					return ActionResult{false, truncateShort(fmt.Sprintf("sc.exe config dmwappushservice start=demand thất bại (exit %d): %s",
						cfg2.Code, orDefault(cfg2.Stderr, cfg2.Stdout, "không rõ lý do")))}
				}
				return ActionResult{true, "Đã hoàn tác telemetry: DiagTrack start=auto, dmwappushservice start=demand"}
			}),
		},
		{
			Def: TweakDef{ID: "win-tips-off", Name: "Tắt gợi ý/quảng cáo Windows",
				Description: "Tắt SystemPaneSuggestions + SubscribedContent 338388/338389/338393 để loại bỏ gợi ý và quảng cáo trong Start.",
				Category: "Bảo mật & riêng tư", Risk: "low", Recommended: false, Order: 16},
			Apply: func() ActionResult {
				return regAddValues(regCDM, []RegValue{
					{"SystemPaneSuggestionsEnabled", "REG_DWORD", "0"},
					{"SubscribedContent-338388Enabled", "REG_DWORD", "0"},
					{"SubscribedContent-338389Enabled", "REG_DWORD", "0"},
					{"SubscribedContent-338393Enabled", "REG_DWORD", "0"},
				}, "Đã tắt gợi ý/quảng cáo Windows (ContentDeliveryManager)")
			},
			Revert: func() ActionResult {
				return regAddValues(regCDM, []RegValue{
					{"SystemPaneSuggestionsEnabled", "REG_DWORD", "1"},
					{"SubscribedContent-338388Enabled", "REG_DWORD", "1"},
					{"SubscribedContent-338389Enabled", "REG_DWORD", "1"},
					{"SubscribedContent-338393Enabled", "REG_DWORD", "1"},
				}, "Đã bật lại gợi ý/quảng cáo Windows (mặc định)")
			},
		},
		{
			Def: TweakDef{ID: "win-cpu-priority-separation", Name: "Win32PrioritySeparation=38 (ưu tiên foreground)",
				Description: "Đặt Win32PrioritySeparation=0x26 (38) — quantum ngắn + tăng ưu tiên ứng dụng foreground mạnh, CPU dành trước cho game/app đang mở.",
				Category: "Hiệu năng", Risk: "medium", RequiresRoot: true, Recommended: false, Order: 17},
			Apply: gateWrap(func() ActionResult {
				return regAddValues(regPriority, []RegValue{{"Win32PrioritySeparation", "REG_DWORD", "38"}},
					"Đã đặt Win32PrioritySeparation=38 (0x26) — ưu tiên ứng dụng foreground")
			}),
			Revert: gateWrap(func() ActionResult {
				return regAddValues(regPriority, []RegValue{{"Win32PrioritySeparation", "REG_DWORD", "2"}},
					"Đã hoàn tác Win32PrioritySeparation về 2 (mặc định)")
			}),
		},
		{
			Def: TweakDef{ID: "win-cpu-core-parking-off", Name: "Tắt core parking CPU",
				Description: "powercfg đặt CPMINCORES=100 cho kế hoạch hiện hành: Windows không \"giam giữ\" lõi CPU ở trạng thái park, giảm micro-stutter. Áp cho nguồn cắm điện (AC); nên dùng kèm kế hoạch Hiệu năng cao.",
				Category: "Hiệu năng", Risk: "medium", RequiresRoot: true, Recommended: false, Order: 18},
			Apply: gateWrap(func() ActionResult {
				set := runSysExe("powercfg.exe", []string{"-setacvalueindex", powercfgGuidCurrent, "sub_processor", "CPMINCORES", "100"}, 30*time.Second)
				if !set.OK {
					return ActionResult{false, truncateShort(fmt.Sprintf("powercfg setacvalueindex CPMINCORES thất bại (exit %d): %s",
						set.Code, orDefault(set.Stderr, "", "không rõ lý do")))}
				}
				act := runSysExe("powercfg.exe", []string{"/setactive", powercfgGuidCurrent}, 30*time.Second)
				if !act.OK {
					return ActionResult{false, truncateShort(fmt.Sprintf("powercfg setactive scheme_current thất bại (exit %d): %s",
						act.Code, orDefault(act.Stderr, "", "không rõ lý do")))}
				}
				return ActionResult{true, "Đã tắt core parking (CPMINCORES=100, AC) và kích hoạt lại kế hoạch hiện hành"}
			}),
			Revert: gateWrap(func() ActionResult {
				set := runSysExe("powercfg.exe", []string{"-setacvalueindex", powercfgGuidCurrent, "sub_processor", "CPMINCORES", "5"}, 30*time.Second)
				if !set.OK {
					return ActionResult{false, truncateShort("powercfg hoàn tác CPMINCORES thất bại: " + orDefault(set.Stderr, "", "không rõ lý do"))}
				}
				_ = runSysExe("powercfg.exe", []string{"/setactive", powercfgGuidCurrent}, 30*time.Second)
				return ActionResult{true, "Đã hoàn tác core parking về CPMINCORES=5 (mặc định)"}
			}),
		},
		{
			Def: TweakDef{ID: "win-cpu-dynamic-tick-off", Name: "Tắt dynamic tick (bcdedit) — cần khởi động lại",
				Description: "bcdedit /set disabledynamictick yes — buộc bộ định thời dùng tick liên tục, giảm jitter độ trễ DPC cho game. Cần khởi động lại Windows để có hiệu lực; một số máy main cũ có thể không tương thích.",
				Category: "Hiệu năng", Risk: "high", RequiresRoot: true, Recommended: false, Order: 19},
			Apply: gateWrap(func() ActionResult {
				r := runSysExe("bcdedit.exe", []string{"/set", bcdTickName, "yes"}, 30*time.Second)
				if !r.OK {
					return ActionResult{false, truncateShort(fmt.Sprintf("bcdedit /set disabledynamictick yes thất bại (exit %d): %s",
						r.Code, orDefault(r.Stderr, r.Stdout, "không rõ lý do")))}
				}
				return ActionResult{true, "Đã đặt disabledynamictick=yes — hãy khởi động lại Windows để có hiệu lực"}
			}),
			Revert: gateWrap(func() ActionResult {
				r := runSysExe("bcdedit.exe", []string{"/deletevalue", bcdTickName}, 30*time.Second)
				if r.OK {
					return ActionResult{true, "Đã xóa disabledynamictick khỏi BCD — quay về tick động mặc định (khởi động lại để có hiệu lực)"}
				}
				// v4.3.0 (P1-08): phân biệt "value không còn" (hợp lệ) với lỗi thật
				// (access denied/BCD hỏng) — KHÔNG báo success mù như trước
				if bcdValueAbsentOutput(r.Stdout + r.Stderr) {
					return ActionResult{true, "Đã ở trạng thái mặc định (disabledynamictick không còn trong BCD — exit " + fmt.Sprint(r.Code) + "); khởi động lại để có hiệu lực"}
				}
				return ActionResult{false, truncateShort("bcdedit /deletevalue thất bại và KHÔNG xác nhận được value đã vắng — BCD vẫn có thể còn disabledynamictick (exit " + fmt.Sprint(r.Code) + "): " + orDefault(r.Stderr, r.Stdout, "không rõ lý do"))}
			}),
		},
		{
			Def: TweakDef{ID: "win-gpu-hwsch-on", Name: "Bật GPU Hardware Scheduling (HAGS)",
				Description: "Đặt HwSchMode=2 (Hardware-Accelerated GPU Scheduling) giảm overhead CPU khi render, cần GPU + driver hỗ trợ và khởi động lại. Driver/OS cũ không hỗ trợ sẽ bỏ qua giá trị này.",
				Category: "Gaming", Risk: "medium", RequiresRoot: true, Recommended: false, Order: 20},
			Apply: gateWrap(func() ActionResult {
				return regAddValues(regGraphics, []RegValue{{"HwSchMode", "REG_DWORD", "2"}},
					"Đã đặt HwSchMode=2 (HAGS bật) — khởi động lại Windows để áp dụng")
			}),
			Revert: gateWrap(func() ActionResult {
				return regDeleteValues(regGraphics, []string{"HwSchMode"},
					"Đã xóa HwSchMode — GPU scheduling trở về mặc định của driver")
			}),
		},
		{
			Def: TweakDef{ID: "win-gpu-tdr-delay", Name: "Gia hạn thời gian chờ TDR của GPU",
				Description: "Đặt TdrDelay=10 + TdrDdiDelay=10 giây — giảm nguy cơ driver GPU bị reset (\"Display driver stopped responding\") khi overclock/đẩy nặng. Chỉ dùng khi thực sự cần; mặc định là 2 giây.",
				Category: "Hiệu năng", Risk: "high", RequiresRoot: true, Recommended: false, Order: 21},
			Apply: gateWrap(func() ActionResult {
				return regAddValues(regGraphics, []RegValue{
					{"TdrDelay", "REG_DWORD", "10"}, {"TdrDdiDelay", "REG_DWORD", "10"},
				}, "Đã đặt TdrDelay=10 + TdrDdiDelay=10 — khởi động lại để áp dụng")
			}),
			Revert: gateWrap(func() ActionResult {
				return regDeleteValues(regGraphics, []string{"TdrDelay", "TdrDdiDelay"},
					"Đã xóa TdrDelay/TdrDdiDelay — trở về mặc định 2 giây")
			}),
		},
		{
			Def: TweakDef{ID: "win-ram-standby-clear", Name: "Xả standby list RAM (NtSetSystemInformation)",
				Description: "Gọi MemoryPurgeStandbyList qua ntdll để ép Windows xả toàn bộ trang RAM standby (kỹ thuật của EmptyStandbyList/ISLC), trả RAM trống về available ngay. Cần Administrator và PowerShell.",
				Category: "Bộ nhớ", Risk: "medium", RequiresRoot: true, Recommended: false, Order: 22},
			Apply: gateWrap(func() ActionResult { return ramStandbyPurge() }),
			Revert: func() ActionResult {
				return ActionResult{true, "Hành động tức thời — không cần hoàn tác"}
			},
		},
		{
			Def: TweakDef{ID: "win-ram-compression-off", Name: "Tắt Memory Compression (nén RAM)",
				Description: "Disable-MMAgent -MemoryCompression: tắt tiến trình nén bộ nhớ để tiết kiệm CPU, đổi lại dùng nhiều pagefile hơn khi RAM đầy. Chỉ nên dùng khi RAM dư nhiều; cần PowerShell.",
				Category: "Bộ nhớ", Risk: "high", RequiresRoot: true, Recommended: false, Order: 23},
			Apply: gateWrap(func() ActionResult {
				r := psRun("Disable-MMAgent -MemoryCompression\nif ($?) { exit 0 } else { exit 1 }", 30*time.Second)
				if !r.OK {
					return ActionResult{false, truncateShort("Disable-MMAgent -MemoryCompression thất bại: " +
						orDefault(r.Stderr, r.Stdout, "không rõ lý do") + " (cần PowerShell)")}
				}
				return ActionResult{true, "Đã tắt Memory Compression — khởi động lại để áp dụng hoàn toàn"}
			}),
			Revert: gateWrap(func() ActionResult {
				r := psRun("Enable-MMAgent -MemoryCompression\nif ($?) { exit 0 } else { exit 1 }", 30*time.Second)
				if !r.OK {
					return ActionResult{false, truncateShort("Enable-MMAgent -MemoryCompression thất bại: " + orDefault(r.Stderr, r.Stdout, "không rõ lý do"))}
				}
				return ActionResult{true, "Đã bật lại Memory Compression (mặc định)"}
			}),
		},
		{
			Def: TweakDef{ID: "win-keyboard-fast", Name: "Bàn phím phản hồi cực nhanh",
				Description: "KeyboardDelay=0 (delay ngắn nhất) + KeyboardSpeed=31 (lặp nhanh nhất) — phím lặp tức thì khi giữ, lợi cho game nhấn nhá nhanh.",
				Category: "Gaming", Risk: "low", Recommended: true, Order: 24},
			Apply: func() ActionResult {
				return regAddValues(regKeyboard, []RegValue{
					{"KeyboardDelay", "REG_SZ", "0"}, {"KeyboardSpeed", "REG_SZ", "31"},
				}, "Đã đặt bàn phím delay=0, tốc độ lặp 31 (nhanh nhất)")
			},
			Revert: func() ActionResult {
				return regAddValues(regKeyboard, []RegValue{
					{"KeyboardDelay", "REG_SZ", "1"}, {"KeyboardSpeed", "REG_SZ", "31"},
				}, "Đã hoàn tác bàn phím về mặc định (delay=1)")
			},
		},
		{
			Def: TweakDef{ID: "win-keyboard-accessibility-off", Name: "Tắt Sticky/Filter/Toggle Keys",
				Description: "Tắt StickyKeys, FilterKeys, ToggleKeys và hộp thoại \"bạn có muốn bật...\" hiện ra khi giữ Shift/Num Lock lâu — hết phiền phức khi chơi game FPS.",
				Category: "Gaming", Risk: "low", Recommended: false, Order: 25},
			Apply: func() ActionResult {
				return regAddValues(regAccess, []RegValue{
					{"StickyKeys", "REG_SZ", "506"}, {"ToggleKeys", "REG_SZ", "58"}, {"FilterKeys", "REG_SZ", "26"},
				}, "Đã tắt StickyKeys/ToggleKeys/FilterKeys (flags=506/58/26)")
			},
			Revert: func() ActionResult {
				return regAddValues(regAccess, []RegValue{
					{"StickyKeys", "REG_SZ", "510"}, {"ToggleKeys", "REG_SZ", "58"}, {"FilterKeys", "REG_SZ", "126"},
				}, "Đã hoàn tác StickyKeys/ToggleKeys/FilterKeys về mặc định (510/58/126)")
			},
		},
		{
			Def: TweakDef{ID: "win-net-llmnr-off", Name: "Tắt LLMNR (giảm nhiễu mạng LAN)",
				Description: "Tắt multicast name resolution (LLMNR) qua policy DNSClient — giảm traffic phát sóng trong LAN, tránh truy vấn tên máy rác; an toàn cho mạng gia đình/văn phòng chuẩn.",
				Category: "Mạng", Risk: "low", RequiresRoot: true, Recommended: false, Order: 26},
			Apply: gateWrap(func() ActionResult {
				return regAddValues(regDNSPolicy, []RegValue{{"EnableMulticast", "REG_DWORD", "0"}},
					"Đã tắt LLMNR (EnableMulticast=0)")
			}),
			Revert: gateWrap(func() ActionResult {
				return regDeleteValues(regDNSPolicy, []string{"EnableMulticast"},
					"Đã xóa policy LLMNR — trở về mặc định")
			}),
		},
		{
			Def: TweakDef{ID: "win-net-netbios-off", Name: "Tắt NetBIOS over TCP/IP",
				Description: "Đặt NetbiosOptions=2 trên mọi interface Tcpip_* — tắt NetBIOS khỏi mạng TCP/IP, giảm packet broadcast rác và lỗ hổng NetBIOS; có thể ảnh hưởng chia sẻ file kiểu máy cũ trong LAN.",
				Category: "Mạng", Risk: "medium", RequiresRoot: true, Recommended: false, Order: 27},
			Apply: gateWrap(netbiosSet(true)),
			Revert: gateWrap(netbiosSet(false)),
		},
		{
			Def: TweakDef{ID: "win-smb1-off", Name: "Tắt SMBv1 (bảo mật)",
				Description: "Đặt SMB1=0 cho LanmanServer — tắt phiên bản SMB 1.0 lỗi thời (EternalBlue/Ransomware hay lợi dụng); thiết bị NAS/tự in ấn rất cũ dùng SMB1 có thể ngắt kết nối.",
				Category: "Bảo mật & riêng tư", Risk: "medium", RequiresRoot: true, Recommended: false, Order: 28},
			Apply: gateWrap(func() ActionResult {
				return regAddValues(regLanmanSrv, []RegValue{{"SMB1", "REG_DWORD", "0"}},
					"Đã tắt SMBv1 (LanmanServer SMB1=0)")
			}),
			Revert: gateWrap(func() ActionResult {
				return regDeleteValues(regLanmanSrv, []string{"SMB1"},
					"Đã xóa SMB1=0 — máy chủ SMB trở về cấu hình mặc định")
			}),
		},
		{
			Def: TweakDef{ID: "win-menu-delay", Name: "Menu hiện tức thời (MenuShowDelay=0)",
				Description: "Đặt MenuShowDelay=0 để menu Start/menu chuột phải hiện ngay không trễ 400ms.",
				Category: "Hiệu năng", Risk: "low", Recommended: false, Order: 29},
			Apply: func() ActionResult {
				return regAddValues(regDesktop, []RegValue{{"MenuShowDelay", "REG_SZ", "0"}}, "Đã đặt MenuShowDelay=0")
			},
			Revert: func() ActionResult {
				return regAddValues(regDesktop, []RegValue{{"MenuShowDelay", "REG_SZ", "400"}},
					"Đã hoàn tác MenuShowDelay về 400ms (mặc định)")
			},
		},
		{
			Def: TweakDef{ID: "win-widgets-off", Name: "Tắt Widgets/News trên taskbar",
				Description: "Đặt TaskbarDa=0 để tắt widget thời tiết/tin tức trên taskbar (Win11) — bớt process nền + RSS đọc tin.",
				Category: "Hiệu năng", Risk: "low", Recommended: false, Order: 30},
			Apply: func() ActionResult {
				return regAddValues(regAdvanced, []RegValue{{"TaskbarDa", "REG_DWORD", "0"}}, "Đã tắt Widgets trên taskbar")
			},
			Revert: func() ActionResult {
				return regDeleteValues(regAdvanced, []string{"TaskbarDa"},
					"Đã xóa TaskbarDa — Widgets về trạng thái mặc định của Windows")
			},
		},
		{
			Def: TweakDef{ID: "win-copilot-off", Name: "Tắt Copilot (khỏi chạy nền AI)",
				Description: "Đặt TurnOffWindowsCopilot=1 (policy) + ShowCopilotButton=0 để tắt Copilot khỏi taskbar — bớt tiến trình AI nền và traffic mạng.",
				Category: "Bảo mật & riêng tư", Risk: "low", Recommended: false, Order: 31},
			Apply: func() ActionResult {
				a := regAddValues(regCopilot, []RegValue{{"TurnOffWindowsCopilot", "REG_DWORD", "1"}}, "")
				if !a.Success {
					return a
				}
				b := regAddValues(regAdvanced, []RegValue{{"ShowCopilotButton", "REG_DWORD", "0"}}, "")
				if !b.Success {
					return b
				}
				return ActionResult{true, "Đã tắt Copilot (policy TurnOff + ẩn nút taskbar)"}
			},
			Revert: func() ActionResult {
				a := regDeleteValues(regCopilot, []string{"TurnOffWindowsCopilot"}, "")
				b := regDeleteValues(regAdvanced, []string{"ShowCopilotButton"}, "")
				if !a.Success || !b.Success {
					var errs []string
					if !a.Success {
						errs = append(errs, a.Message)
					}
					if !b.Success {
						errs = append(errs, b.Message)
					}
					msg := strings.Join(errs, " | ")
					if msg == "" {
						msg = "Xóa giá trị Copilot thất bại"
					}
					return ActionResult{false, truncateShort(msg)}
				}
				return ActionResult{true, "Đã xóa policy Copilot — Windows trở về mặc định"}
			},
		},
		{
			Def: TweakDef{ID: "win-background-apps-off", Name: "Tắt app chạy nền (UWP)",
				Description: "Đặt GlobalUserDisabled=1 — chặn các app Microsoft Store chạy nền (lấy vị trí, thông báo, làm mới tile) để bớt ăn RAM/CPU.",
				Category: "Hiệu năng", Risk: "low", Recommended: false, Order: 32},
			Apply: func() ActionResult {
				return regAddValues(regBGApps, []RegValue{{"GlobalUserDisabled", "REG_DWORD", "1"}},
					"Đã tắt app UWP chạy nền (GlobalUserDisabled=1)")
			},
			Revert: func() ActionResult {
				return regAddValues(regBGApps, []RegValue{{"GlobalUserDisabled", "REG_DWORD", "0"}},
					"Đã bật lại app chạy nền (mặc định)")
			},
		},
		{
			Def: TweakDef{ID: "win-hibernation-off", Name: "Tắt hibernation (giải phóng hiberfil.sys)",
				Description: "powercfg /hibernate off — xóa file hiberfil.sys lớn gần bằng RAM, giải phóng ổ đĩa đáng kể; đổi lại mất tính năng Hibernate/Windows Fast Startup.",
				Category: "Bộ nhớ", Risk: "medium", RequiresRoot: true, Recommended: false, Order: 33},
			Apply: gateWrap(func() ActionResult {
				r := runSysExe("powercfg.exe", []string{"/hibernate", "off"}, 30*time.Second)
				if !r.OK {
					return ActionResult{false, truncateShort(fmt.Sprintf("powercfg /hibernate off thất bại (exit %d): %s",
						r.Code, orDefault(r.Stderr, r.Stdout, "không rõ lý do")))}
				}
				return ActionResult{true, "Đã tắt hibernation — hiberfil.sys sẽ được giải phóng"}
			}),
			Revert: gateWrap(func() ActionResult {
				r := runSysExe("powercfg.exe", []string{"/hibernate", "on"}, 30*time.Second)
				if !r.OK {
					return ActionResult{false, truncateShort(fmt.Sprintf("powercfg /hibernate on thất bại (exit %d)", r.Code))}
				}
				return ActionResult{true, "Đã bật lại hibernation (mặc định)"}
			}),
		},
		{
			Def: TweakDef{ID: "win-xbox-services-off", Name: "Tắt dịch vụ Xbox (không chơi Xbox/Game Bar)",
				Description: "Disable + stop XblAuthManager, XblGameSave, XboxNetApiSvc, XboxGipSvc — bớt dịch vụ nền. CHỈ dùng khi không đăng nhập Xbox/Game Bar; muốn chơi game Xbox Store phải hoàn tác.",
				Category: "Gaming", Risk: "high", RequiresRoot: true, Recommended: false, Order: 34},
			Apply: gateWrap(func() ActionResult { return xboxServices("disabled") }),
			Revert: gateWrap(func() ActionResult { return xboxServices("demand") }),
		},
		{
			Def: TweakDef{ID: "win-mmcss-gaming", Name: "MMCSS: ưu tiên đa nhiệm cho Gaming",
				Description: "Đặt task \"Gaming\" trong MMCSS: Priority=6, Scheduling Category=High, SFIO Priority=High — CPU/disk/network scheduler ưu tiên luồng audio/render của game hơn các dịch vụ nền.",
				Category: "Gaming", Risk: "medium", RequiresRoot: true, Recommended: false, Order: 35},
			Apply: gateWrap(func() ActionResult {
				return regAddValues(regMMCSSGaming, []RegValue{
					{"Priority", "REG_DWORD", "6"},
					{"Scheduling Category", "REG_SZ", "High"},
					{"SFIO Priority", "REG_SZ", "High"},
				}, "Đã đặt MMCSS Gaming task: Priority=6, Scheduling=High, SFIO=High")
			}),
			Revert: gateWrap(func() ActionResult {
				return regAddValues(regMMCSSGaming, []RegValue{
					{"Priority", "REG_DWORD", "2"},
					{"Scheduling Category", "REG_SZ", "Medium"},
					{"SFIO Priority", "REG_SZ", "Normal"},
				}, "Đã hoàn tác MMCSS Gaming task về mặc định (2/Medium/Normal)")
			}),
		},
	}
}

func gateWrap(f func() ActionResult) func() ActionResult {
	return func() ActionResult {
		if m, ok := adminGate(); !ok {
			return ActionResult{false, m}
		}
		return f()
	}
}

/** Tắt Nagle: set TcpAckFrequency/TCPNoDelay=1 trên mọi interface Tcpip_{GUID} (hoặc hoàn tác) */
func nagleSet(set bool) func() ActionResult {
	return func() ActionResult {
		reg := findSysExe("reg.exe")
		if reg == "" {
			return ActionResult{false, noRegExeMsg}
		}
		base := `HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces`
		keys, q := regListSubkeys(reg, base, 15*time.Second)
		if q.OK == false {
			return ActionResult{false, truncateShort(fmt.Sprintf("Không liệt kê được interface mạng (reg.exe query exit %d): %s",
				q.Code, orDefault(q.Stderr, q.Stdout, "không rõ lý do")))}
		}
		var match []string
		for _, k := range keys {
			if tcpipGUIDRe.MatchString(k) {
				match = append(match, k)
			}
		}
		if !set {
			var failed []string
			for _, k := range match {
				for _, v := range []string{"TcpAckFrequency", "TCPNoDelay"} {
					has := runExe(reg, []string{"query", k, "/v", v}, 10*time.Second)
					if !has.OK {
						continue
					}
					d := runExe(reg, []string{"delete", k, "/v", v, "/f"}, 10*time.Second)
					if !d.OK {
						failed = append(failed, k+"\\"+v)
					}
				}
			}
			if len(failed) > 0 {
				return ActionResult{false, truncateShort("Không xóa được giá trị Nagle tại: " + strings.Join(failed, "; "))}
			}
			return ActionResult{true, "Đã xóa TcpAckFrequency/TCPNoDelay khỏi mọi interface mạng"}
		}
		if len(match) == 0 {
			return ActionResult{false, "Không tìm thấy interface TCP/IP nào trong registry"}
		}
		n := 0
		var failed []string
		for _, k := range match {
			a := runExe(reg, []string{"add", k, "/v", "TcpAckFrequency", "/t", "REG_DWORD", "/d", "1", "/f"}, 10*time.Second)
			b := runExe(reg, []string{"add", k, "/v", "TCPNoDelay", "/t", "REG_DWORD", "/d", "1", "/f"}, 10*time.Second)
			if a.OK && b.OK {
				n++
			} else {
				failed = append(failed, k)
			}
		}
		if n == 0 {
			return ActionResult{false, truncateShort("Không đặt được TcpAckFrequency/TCPNoDelay trên interface nào: " + strings.Join(failed, "; "))}
		}
		extra := ""
		if len(failed) > 0 {
			extra = fmt.Sprintf(" (%d interface lỗi: bỏ qua)", len(failed))
		}
		return ActionResult{true, fmt.Sprintf("Đã tắt Nagle trên %d interface mạng (TcpAckFrequency=1 + TCPNoDelay=1)%s", n, extra)}
	}
}

/** NetBIOS over TCP/IP: NetbiosOptions=2 mọi interface Tcpip_* (hoặc hoàn tác) */
func netbiosSet(set bool) func() ActionResult {
	return func() ActionResult {
		reg := findSysExe("reg.exe")
		if reg == "" {
			return ActionResult{false, noRegExeMsg}
		}
		keys, q := regListSubkeys(reg, regNetBTIf, 15*time.Second)
		if !q.OK {
			return ActionResult{false, truncateShort(fmt.Sprintf("Không liệt kê được interface NetBT (exit %d): %s",
				q.Code, orDefault(q.Stderr, q.Stdout, "không rõ lý do")))}
		}
		var match []string
		for _, k := range keys {
			if strings.Contains(strings.ToLower(k), `\tcpip_`) {
				match = append(match, k)
			}
		}
		if !set {
			var failed []string
			for _, k := range match {
				has := runExe(reg, []string{"query", k, "/v", "NetbiosOptions"}, 10*time.Second)
				if !has.OK {
					continue
				}
				d := runExe(reg, []string{"delete", k, "/v", "NetbiosOptions", "/f"}, 10*time.Second)
				if !d.OK {
					failed = append(failed, k)
				}
			}
			if len(failed) > 0 {
				return ActionResult{false, truncateShort("Không xóa được NetbiosOptions tại: " + strings.Join(failed, "; "))}
			}
			return ActionResult{true, "Đã xóa NetbiosOptions khỏi mọi interface — NetBIOS về mặc định (DHCP)"}
		}
		if len(match) == 0 {
			return ActionResult{false, "Không tìm thấy interface Tcpip_* trong NetBT\\Parameters\\Interfaces"}
		}
		n := 0
		var failed []string
		for _, k := range match {
			a := runExe(reg, []string{"add", k, "/v", "NetbiosOptions", "/t", "REG_DWORD", "/d", "2", "/f"}, 10*time.Second)
			if a.OK {
				n++
			} else {
				failed = append(failed, k)
			}
		}
		if n == 0 {
			return ActionResult{false, truncateShort("Không đặt được NetbiosOptions trên interface nào: " + strings.Join(failed, "; "))}
		}
		extra := ""
		if len(failed) > 0 {
			extra = fmt.Sprintf(" (%d interface lỗi)", len(failed))
		}
		return ActionResult{true, fmt.Sprintf("Đã tắt NetBIOS over TCP/IP trên %d interface%s", n, extra)}
	}
}

var xboxServicesList = []string{"XblAuthManager", "XblGameSave", "XboxNetApiSvc", "XboxGipSvc"}

func xboxServices(startMode string) ActionResult {
	var failed []string
	for _, s := range xboxServicesList {
		cfg := runSysExe("sc.exe", []string{"config", s, "start=", startMode}, 20*time.Second)
		if !cfg.OK && cfg.Code != 1060 {
			failed = append(failed, fmt.Sprintf("%s (exit %d)", s, cfg.Code))
		}
		if startMode == "disabled" {
			_ = runSysExe("sc.exe", []string{"stop", s}, 20*time.Second) // lỗi stop bỏ qua (1060/1062)
		}
	}
	if startMode == "disabled" {
		if len(failed) == len(xboxServicesList) {
			return ActionResult{false, truncateShort("Không tắt được dịch vụ Xbox nào: " + strings.Join(failed, "; "))}
		}
		if len(failed) > 0 {
			return ActionResult{true, "Đã tắt dịch vụ Xbox (một số mục lỗi: " + strings.Join(failed, "; ") + " — có thể dịch vụ không tồn tại)"}
		}
		return ActionResult{true, fmt.Sprintf("Đã tắt + disable %d dịch vụ Xbox", len(xboxServicesList))}
	}
	if len(failed) > 0 {
		return ActionResult{false, truncateShort("Hoàn tác dịch vụ Xbox lỗi tại: " + strings.Join(failed, "; "))}
	}
	return ActionResult{true, "Đã hoàn tác dịch vụ Xbox về start=demand (mặc định)"}
}

// ---------- Áp dụng / hoàn tác / danh sách ----------

func findTweak(id string) *TweakAction {
	for i := range tweakActions() {
		if tweakActions()[i].Def.ID == id {
			return &tweakActions()[i]
		}
	}
	return nil
}

// catalogCache giữ 1 instance duy nhất — các closure trong catalog không giữ state.
// Catalog tổng = tweak closure gốc + bảng Go + file data/*.tsv (granular), remap nhóm chi tiết rồi đánh số 1..N.
var categoryOrder = []string{
	"CPU", "GPU", "RAM", "Ổ đĩa & File system", "Chuột", "Bàn phím", "Âm thanh", "Màn hình",
	"Mạng", "Wi-Fi & Bluetooth", "Nguồn & Điện", "Boot & Khởi động", "Kernel & Hệ thống",
	"Cập nhật Windows", "Defender & Bảo mật", "Telemetry & Riêng tư", "Bloatware (UWP)",
	"Dịch vụ", "Task định kỳ", "Giao diện & Taskbar", "Explorer & File", "Edge & Trình duyệt",
	"OneDrive & Cloud", "Gaming & Xbox", "Remote & Chia sẻ", "In ấn & Thiết bị", "Hạ tầng",
}

// remapCategory: gán lại nhóm chi tiết cho từng tweak (thay nhóm chung cũ)
func remapCategory(id string) string {
	switch id {
	case "win-sysresp", "win-cpu-priority", "win-cpu-core-parking-off", "perf-cpu-min-100", "pwr-cpmin-100":
		return "CPU"
	case "win-gpu-hwsch", "win-gpu-tdr-off":
		return "GPU"
	case "win-ram-clean", "win-ram-standby-clear", "win-ram-compression-off", "win-sysmain-off", "perf-svchost-split":
		return "RAM"
	case "perf-ntfs-memory-2", "perf-8dot3-off", "perf-lastaccess-off", "perf-compact-os", "perf-reserved-storage-off":
		return "Ổ đĩa & File system"
	case "win-mouse-accurate", "ui-hover-time":
		return "Chuột"
	case "win-keyboard-fast", "win-keyboard-access", "ui-numlock-boot":
		return "Bàn phím"
	case "win-visualfx", "win-transparency":
		return "Màn hình"
	case "svc-bluetooth-off", "tel-wifi-sense-off", "game-wlan-max-perf":
		return "Wi-Fi & Bluetooth"
	case "win-power-high", "win-hibernation-off", "perf-usb-suspend-off", "perf-ultimate-power":
		return "Nguồn & Điện"
	case "win-startup-delay", "perf-fast-startup-off", "perf-boot-menu-3s":
		return "Boot & Khởi động"
	case "win-cpu-dynamic-tick-off", "perf-timer-resolution", "perf-foreground-lock",
		"perf-kill-timeouts", "perf-crashdump-off", "perf-autoreboot-off":
		return "Kernel & Hệ thống"
	case "upd-no-reboot", "upd-driver-off", "upd-store-auto-off":
		return "Cập nhật Windows"
	case "win-smb1-off", "sec-autorun-off", "sec-lsa-ppl-on", "sec-remote-assistance-off",
		"sec-spectre-mitigations-off", "sec-smb-guest-auth-off", "sec-smb1-client-off", "svc-remote-registry-off":
		return "Defender & Bảo mật"
	case "win-diagtrack-off", "win-tips-off", "win-copilot-off":
		return "Telemetry & Riêng tư"
	case "win-background-apps":
		return "Bloatware (UWP)"
	case "svc-spooler-off", "svc-fax-off", "svc-wia-off", "svc-tablet-off", "tel-device-metadata-off":
		return "In ấn & Thiết bị"
	case "svc-server-off", "svc-remote-access-off", "svc-winrm-off":
		return "Remote & Chia sẻ"
	case "win-widgets-off", "win-menu-delay":
		return "Giao diện & Taskbar"
	case "win-game-dvr", "win-gamemode", "win-fse", "win-mmcss", "win-xbox-services-off":
		return "Gaming & Xbox"
	case "net-mdns-off":
		return "Mạng"
	}
	switch {
	case strings.HasPrefix(id, "tel-"), strings.HasPrefix(id, "sec-"):
		return "Telemetry & Riêng tư"
	case strings.HasPrefix(id, "appx-"):
		return "Bloatware (UWP)"
	case strings.HasPrefix(id, "svc-"):
		return "Dịch vụ"
	case strings.HasPrefix(id, "net-"):
		return "Mạng"
	case strings.HasPrefix(id, "game-"):
		return "Gaming & Xbox"
	case strings.HasPrefix(id, "ui-"):
		return "Giao diện & Taskbar"
	}
	return ""
}

// tableMap: id -> tableTweak (dùng để suy ra công cụ cần cho selftest)
var tableMap = map[string]*tableTweak{}

var catalogOnce sync.Once
var catalogVal []TweakAction
var dataLoadReport = "chưa nạp"

func tweakActions() []TweakAction {
	catalogOnce.Do(func() {
		base := tweakCatalog()
		var tables []TweakAction
		for _, ts0 := range [][]tableTweak{
			privacyTweaks(), bloatTweaks(), servicesTweaks(),
			perfTweaks(), gamingNetTweaks(), uiTweaks(),
		} {
			ts := splitCompound(ts0)
			for i := range ts {
				tableMap[ts[i].Def.ID] = &ts[i]
				tables = append(tables, tableAction(ts[i]))
			}
		}
		rows, n, skipped := dataTweaks()
		dataLoadReport = fmt.Sprintf("nạp %d dòng TSV, bỏ qua %d dòng lỗi", n, len(skipped))
		rows = splitCompound(rows)
		for i := range rows {
			tableMap[rows[i].Def.ID] = &rows[i]
			tables = append(tables, tableAction(rows[i]))
		}
		for i := range base {
			if nc := remapCategory(base[i].Def.ID); nc != "" {
				base[i].Def.Category = nc
			}
		}
		for i := range tables {
			if nc := remapCategory(tables[i].Def.ID); nc != "" {
				tables[i].Def.Category = nc
			}
		}
		pos := 1
		for _, cat := range categoryOrder {
			for i := range base {
				if base[i].Def.Category == cat {
					base[i].Def.Order = pos
					pos++
				}
			}
			for i := range tables {
				if tables[i].Def.Category == cat {
					tables[i].Def.Order = pos
					pos++
				}
			}
		}
		catalogVal = append(catalogVal, base...)
		catalogVal = append(catalogVal, tables...)
		// đánh số phẳng cuối cùng 1..N — đảm bảo unique
		for i := range catalogVal {
			catalogVal[i].Def.Order = i + 1
		}
	})
	return catalogVal
}

func applyTweakById(id string) TweakRunResult {
	a := findTweak(id)
	if a == nil {
		return TweakRunResult{ID: id, Success: false, Message: fmt.Sprintf("Không tìm thấy tinh chỉnh %q", id)}
	}
	r := a.Apply()
	// v4.1.0 (phát hiện 08-E): multi-step fail dọc đường vẫn đã thay đổi một phần máy —
	// boolean Applied=false không diễn tả được; lưu Partial=true + message cờ
	partial := !r.Success && strings.Contains(r.Message, "MỘT PHẦN ĐÃ ÁP DỤNG")
	saveTweakStateExt(id, r.Success, partial, r.Message)
	return TweakRunResult{ID: id, Success: r.Success, Message: truncateShort(r.Message)}
}

func revertTweakById(id string) TweakRunResult {
	a := findTweak(id)
	if a == nil {
		return TweakRunResult{ID: id, Success: false, Message: fmt.Sprintf("Không tìm thấy tinh chỉnh %q", id)}
	}
	r := a.Revert()
	// v4.1.0 (TEST TWEAK-07): revert thất bại KHÔNG được ghi applied=false như thể đã trả xong —
	// máy còn sót cấu hình → giữ Applied=true + Partial=true để UI hiện rõ
	if r.Success {
		saveTweakStateExt(id, false, false, r.Message)
	} else {
		saveTweakStateExt(id, true, true, "Hoàn tác thất bại — trạng thái vẫn còn sót một phần: "+r.Message)
	}
	return TweakRunResult{ID: id, Success: r.Success, Message: truncateShort(r.Message)}
}

func saveTweakStateExt(id string, applied, partial bool, msg string) {
	st := TweakState{Applied: applied, Partial: partial, LastResult: truncateShort(msg)}
	if applied {
		now := time.Now()
		st.AppliedAt = &now
	}
	appState.PutTweakState(id, st)
}

func getTweaks() []Tweak {
	out := make([]Tweak, 0, len(tweakActions()))
	for _, a := range tweakActions() {
		st := appState.GetTweakState(a.Def.ID)
		t := Tweak{TweakDef: a.Def, Applied: st.Applied, Partial: st.Partial, LastResult: st.LastResult}
		if st.AppliedAt != nil {
			t.AppliedAt = st.AppliedAt.Format(time.RFC3339)
		}
		out = append(out, t)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Order < out[j-1].Order; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
