// selftest.go — tự kiểm tra môi trường + catalog (mode check) và apply→revert từng tweak (mode full),
// báo cáo Discord webhook (port từ selftest.ts, giữ nguyên format embed).
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const webhookSettingNote = "Chưa cấu hình webhook Discord (dán URL webhook trong tab Tự kiểm tra)"

var discordWebhookRe = regexp.MustCompile(`^https://([a-z0-9-]+\.)?discord(?:app)?\.com/api/webhooks/\d+/[\w-]+$`)

func isValidWebhook(url string) bool { return discordWebhookRe.MatchString(url) }

/** Che URL webhook khi hiển thị — không lộ token */
func maskWebhook(url string) string {
	if url == "" {
		return ""
	}
	m := regexp.MustCompile(`^(https://[^/]+/api/webhooks/)(\d+)/(.+)$`).FindStringSubmatch(url)
	if m == nil {
		return "***"
	}
	id := m[2]
	idHead := id
	if len(idHead) > 4 {
		idHead = idHead[:4]
	}
	idTail := id
	if len(idTail) > 4 {
		idTail = idTail[len(idTail)-4:]
	}
	tokTail := m[3]
	if len(tokTail) > 4 {
		tokTail = tokTail[len(tokTail)-4:]
	}
	return fmt.Sprintf("%s%s…%s/***%s", m[1], idHead, idTail, tokTail)
}

type SelftestItem struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Group   string `json:"group"`
	OK      bool   `json:"ok"`
	Skipped bool   `json:"skipped"`
	Detail  string `json:"detail"`
}

type SelftestFullEntry struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	ApplyOK   bool   `json:"applyOk"`
	ApplyMsg  string `json:"applyMsg"`
	RevertOK  bool   `json:"revertOk"`
	RevertMsg string `json:"revertMsg"`
	Skipped   bool   `json:"skipped"`
}

type SelftestReport struct {
	Mode       string              `json:"mode"`
	StartedAt  string              `json:"startedAt"`
	FinishedAt string              `json:"finishedAt"`
	DurationMs int64               `json:"durationMs"`
	Hostname   string              `json:"hostname"`
	Platform   string              `json:"platform"`
	OsRelease  string              `json:"osRelease"`
	Arch       string              `json:"arch"`
	Runtime    map[string]any      `json:"runtime"`
	Catalog    map[string]any      `json:"catalog"`
	Items      []SelftestItem      `json:"items"`
	Full       []SelftestFullEntry `json:"full,omitempty"`
	Counts     map[string]int      `json:"counts"`
	Webhook    map[string]any      `json:"webhook"`
	OK         bool                `json:"ok"`
}

func shortDetail(msg string) string {
	clean := strings.TrimSpace(wsRe.ReplaceAllString(msg, " "))
	if len(clean) > 160 {
		return runeCut(clean, 159) + "…"
	}
	return clean
}

/** Công cụ mà từng tweak cần (dùng ở chế độ check) — giữ nguyên mapping từ bản TS */
func tweakDeps(id string) (tools []string, needsPs bool) {
	switch id {
	case "win-power-high", "win-cpu-core-parking-off", "win-hibernation-off":
		return []string{"powercfg.exe"}, false
	case "win-sysmain-off", "win-diagtrack-off", "win-xbox-services-off":
		return []string{"sc.exe"}, false
	case "win-flush-dns":
		return []string{"ipconfig.exe"}, false
	case "win-cpu-dynamic-tick-off":
		return []string{"bcdedit.exe"}, false
	case "win-ram-clean", "win-ram-standby-clear", "win-ram-compression-off":
		return nil, true
	default:
		// Tweak dạng bảng (tel-/sec-/appx-/svc-/perf-/upd-/game-/net-/ui-) —
		// suy ra công cụ cần từ các step trong tableMap
		if tt, ok := tableMap[id]; ok {
			return deriveTableDeps(tt)
		}
		return []string{"reg.exe"}, false
	}
}

/** Suy ra công cụ/tính năng cần thiết từ danh sách step của một tweak bảng */
func deriveTableDeps(tt *tableTweak) (tools []string, needsPs bool) {
	seen := map[string]bool{}
	add := func(t string) {
		if !seen[t] {
			seen[t] = true
			tools = append(tools, t)
		}
	}
	check := func(steps []step) {
		for _, s := range steps {
			switch s.Kind {
			case stepRegAdd, stepRegDel, stepRegAddVe, stepRegDelKey, stepRegAddKey:
				add("reg.exe")
			case stepSc:
				add("sc.exe")
			case stepPc:
				add("powercfg.exe")
			case stepTask:
				add("schtasks.exe")
			case stepAppx, stepPS:
				needsPs = true
			case stepExe:
				add(s.Name) // v3.4.0 fix: Name mới là tên exe (Args[0] là cờ — gây selftest sai dep)
			}
		}
	}
	check(tt.ApplySteps)
	check(tt.RevertSteps)
	return tools, needsPs
}

var toolLabels = map[string]string{
	"reg.exe": "reg.exe (registry)", "powercfg.exe": "powercfg.exe (nguồn/điện)",
	"sc.exe": "sc.exe (dịch vụ)", "ipconfig.exe": "ipconfig.exe (mạng)",
	"bcdedit.exe": "bcdedit.exe (boot config)", "schtasks.exe": "schtasks.exe (task định kỳ)",
	"netsh.exe": "netsh.exe (mạng)", "fsutil.exe": "fsutil.exe (NTFS)",
	"Compact.exe": "Compact.exe (nén hệ thống)", "Dism.exe": "DISM (bảo trì hệ thống)",
}

func runCheck() []SelftestItem {
	items := []SelftestItem{}
	add := func(id, name, group string, ok bool, detail string, skipped bool) {
		items = append(items, SelftestItem{ID: id, Name: name, Group: group, OK: ok, Skipped: skipped, Detail: shortDetail(detail)})
	}
	// 1) Store (thay thế DB)
	if _, err := os.Stat(appState.file()); err == nil {
		add("db", "Lưu trữ (config.json nguyên tử)", "Hạ tầng", true, "File config đọc được — store hoạt động", false)
	} else {
		add("db", "Lưu trữ (config.json nguyên tử)", "Hạ tầng", true, "Lần đầu chạy — store sẽ tạo file khi ghi", false)
	}
	// 2) Catalog
	tw := tweakActions()
	ids := map[string]bool{}
	orders := map[int]bool{}
	uniqIDs, uniqOrders := true, true
	recommended := 0
	for _, a := range tw {
		if ids[a.Def.ID] {
			uniqIDs = false
		}
		ids[a.Def.ID] = true
		if orders[a.Def.Order] {
			uniqOrders = false
		}
		orders[a.Def.Order] = true
		if a.Def.Recommended {
			recommended++
		}
	}
	add("catalog", "Catalog tinh chỉnh", "Hạ tầng", uniqIDs && uniqOrders && len(tw) > 0,
		fmt.Sprintf("%d tinh chỉnh (unique id: %v, unique order: %v)", len(tw), uniqIDs, uniqOrders), false)
	// 3) Runtime
	if !runtimeIsWindows {
		add("runtime", "Môi trường Windows", "Runtime", false,
			fmt.Sprintf("Đang chạy trên %s — các tinh chỉnh Windows cần chạy trong app .exe trên Windows", runtime.GOOS), true)
	} else {
		st := getWinStatus()
		if st.PsFound {
			add("runtime-powershell", "PowerShell", "Runtime", true, fmt.Sprintf("%s (%s)", st.PsPath, st.PsDetail), false)
		} else {
			add("runtime-powershell", "PowerShell", "Runtime", false, "Không tìm thấy PowerShell — "+st.PsDetail, false)
		}
		if st.Admin {
			add("runtime-admin", "Quyền Administrator", "Runtime", true,
				"Có quyền Admin (kiểm tra qua "+map[string]string{"hklm-write": "ghi thử HKLM bằng reg.exe", "ps-isinrole": "PowerShell IsInRole"}[st.AdminMethod]+")", false)
		} else {
			add("runtime-admin", "Quyền Administrator", "Runtime", false,
				"Không có quyền Admin — các mục HKLM/dịch vụ/powercfg sẽ báo cần Admin (trung thực)", false)
		}
		if st.RegOk {
			add("runtime-reg", "reg.exe (registry)", "Runtime", true,
				"reg.exe sẵn sàng trong System32 — registry tweaks chạy không cần PowerShell", false)
		} else {
			add("runtime-reg", "reg.exe (registry)", "Runtime", false, "Thiếu reg.exe — registry không thao tác được", false)
		}
	}
	// 4) Capability từng tinh chỉnh
	for _, a := range tw {
		if !runtimeIsWindows {
			add(a.Def.ID, a.Def.Name, a.Def.Category, false, "Chỉ kiểm tra được trên Windows (bỏ qua)", true)
			continue
		}
		tools, needsPs := tweakDeps(a.Def.ID)
		var missing []string
		for _, t := range tools {
			if findSysExe(t) == "" {
				lbl := toolLabels[t]
				if lbl == "" {
					lbl = t
				}
				missing = append(missing, lbl)
			}
		}
		if len(missing) > 0 {
			add(a.Def.ID, a.Def.Name, a.Def.Category, false, "Thiếu công cụ: "+strings.Join(missing, ", "), false)
			continue
		}
		if needsPs {
			ps := resolvePowerShellExe()
			if ps.Exe != "" && ps.Exe != "powershell.exe" {
				add(a.Def.ID, a.Def.Name, a.Def.Category, true, "Cần PowerShell — OK ("+ps.Exe+")", false)
			} else {
				add(a.Def.ID, a.Def.Name, a.Def.Category, false, "Cần PowerShell nhưng máy không có — "+ps.Detail, false)
			}
			continue
		}
		lbls := []string{}
		for _, t := range tools {
			lbl := toolLabels[t]
			if lbl == "" {
				lbl = t
			}
			lbls = append(lbls, lbl)
		}
		extra := ""
		if a.Def.RequiresRoot {
			extra = " + cần Administrator"
		}
		add(a.Def.ID, a.Def.Name, a.Def.Category, true, "Sẵn sàng: "+strings.Join(lbls, " + ")+extra, false)
	}
	return items
}

/** Chế độ full: apply → revert từng tweak, đúng thứ tự, có deadline 120s */
// v4.1.1 (P1-03): tweak chứa thao tác Appx removal là KHÓ ĐẢO NGƯỢC (revert phụ thuộc
// package còn được tìm thấy + InstallLocation) — self-test FULL không tự chạy, báo skip
// trung thực kèm lý do. Tweak one-shot (chạy-lần-một) vẫn giữ vì vô hại tự phục hồi.
func tweakHasAppx(id string) bool {
	tt := tableMap[id]
	if tt == nil {
		return false
	}
	for _, st := range tt.ApplySteps {
		if st.Kind == stepAppx {
			return true
		}
	}
	for _, st := range tt.RevertSteps {
		if st.Kind == stepAppx {
			return true
		}
	}
	return false
}

/** v4.3.0 (P1-02): revert chỉ chạy khi apply THÀNH CÔNG hoặc PARTIAL (đã ghi được
 * một phần) — apply fail hoàn toàn thì KHÔNG revert, tránh ghi giá trị mặc định đoán
 * lên cấu hình thật. Partial được đánh dấu qua message marker của runSteps. */
func shouldRevertAfterApply(applyOK bool, applyMsg string) bool {
	return applyOK || strings.Contains(applyMsg, "MỘT PHẦN ĐÃ ÁP DỤNG")
}

func runFull(deadline time.Duration) []SelftestFullEntry {
	var entries []SelftestFullEntry
	t0 := time.Now()
	for _, a := range tweakActions() {
		if time.Since(t0) > deadline {
			entries = append(entries, SelftestFullEntry{
				ID: a.Def.ID, Name: a.Def.Name, ApplyOK: false, ApplyMsg: "Bỏ qua do vượt thời gian kiểm tra",
				RevertOK: false, RevertMsg: "Bỏ qua do vượt thời gian kiểm tra", Skipped: true,
			})
			continue
		}
		if tweakHasAppx(a.Def.ID) {
			entries = append(entries, SelftestFullEntry{
				ID: a.Def.ID, Name: a.Def.Name, ApplyOK: false,
				ApplyMsg: "BỎ QUA tự động: gỡ app Windows (Appx) khó đảo ngược chắc chắn — không chạy trong self-test, bấm thủ công trong tab Tinh chỉnh nếu muốn",
				RevertOK: false, RevertMsg: "không chạy cùng apply-bỏ-qua", Skipped: true,
			})
			continue
		}
		ap := applyTweakById(a.Def.ID)
		// v4.3.0 (P1-02): apply thất bại → KHÔNG revert (không ghi đè config hiện tại bằng
		// giá trị mặc định đoán); apply partial → vẫn revert để trả phần đã áp dụng
		var rv TweakRunResult
		revertRan := false
		if shouldRevertAfterApply(ap.Success, ap.Message) {
			rv = revertTweakById(a.Def.ID)
			revertRan = true
		}
		e := SelftestFullEntry{
			ID: a.Def.ID, Name: a.Def.Name, ApplyOK: ap.Success, ApplyMsg: shortDetail(ap.Message),
			RevertOK: rv.Success, RevertMsg: shortDetail(rv.Message), Skipped: false,
		}
		if !revertRan {
			e.RevertMsg = "Apply thất bại — KHÔNG revert (tránh ghi giá trị mặc định đoán lên cấu hình thật của máy)"
		}
		entries = append(entries, e)
	}
	return entries
}

type webhookEmbed struct {
	Username string `json:"username"`
	Embeds   []struct {
		Title       string         `json:"title"`
		Color       int            `json:"color"`
		Description string         `json:"description"`
		Fields      []webhookField `json:"fields"`
		Timestamp   string         `json:"timestamp"`
		Footer      struct {
			Text string `json:"text"`
		} `json:"footer"`
	} `json:"embeds"`
}

type webhookField struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Inline bool   `json:"inline"`
}

/** Gửi báo cáo Discord — trả {ok, detail} KHÔNG chứa URL webhook */
func sendWebhookReport(report *SelftestReport) (bool, string) {
	url := appState.GetWebhookURL()
	if url == "" {
		return false, webhookSettingNote
	}
	var lines []string
	var fails, skipped []SelftestItem
	for _, i := range report.Items {
		if !i.OK && !i.Skipped {
			fails = append(fails, i)
		}
		if i.Skipped {
			skipped = append(skipped, i)
		}
	}
	if len(fails) > 0 {
		lines = append(lines, "**Lỗi:**")
		for i, f := range fails {
			if i >= 12 {
				lines = append(lines, fmt.Sprintf("• …và %d mục lỗi khác", len(fails)-12))
				break
			}
			lines = append(lines, fmt.Sprintf("• %s: %s", f.Name, f.Detail))
		}
	}
	if len(skipped) > 0 {
		lines = append(lines, fmt.Sprintf("*Bỏ qua (không áp dụng được trên môi trường này): %d mục*", len(skipped)))
	}
	if report.Full != nil {
		var fullFails []SelftestFullEntry
		for _, f := range report.Full {
			if !f.Skipped && (!f.ApplyOK || !f.RevertOK) {
				fullFails = append(fullFails, f)
			}
		}
		if len(fullFails) > 0 {
			lines = append(lines, "**Chế độ full (áp dụng → hoàn tác):**")
			for i, f := range fullFails {
				if i >= 12 {
					lines = append(lines, fmt.Sprintf("• …và %d mục khác", len(fullFails)-12))
					break
				}
				applyMark, revertMark := "❌", "❌"
				if f.ApplyOK {
					applyMark = "✅"
				}
				if f.RevertOK {
					revertMark = "✅"
				}
				detail := f.ApplyMsg
				if detail == "" {
					detail = f.RevertMsg
				}
				if len(detail) > 80 {
					detail = runeCut(detail, 79) + "…"
				}
				lines = append(lines, fmt.Sprintf("• %s: apply %s / revert %s — %s", f.Name, applyMark, revertMark, detail))
			}
		}
	}
	desc := strings.Join(lines, "\n")
	desc = strings.TrimPrefix(desc, "\n")
	if len(desc) > 1800 {
		desc = runeCut(desc, 1800)
	}
	if desc == "" {
		desc = "Tất cả mục đã kiểm tra đều đạt ✅"
	}
	okMark := "CÓ LỖI"
	color := 15158332
	if report.OK {
		okMark = "ĐẠT"
		color = 3066993
	}
	var payload webhookEmbed
	payload.Username = "NEXUS Optimizer"
	mode := "CHECK"
	if report.Mode == "full" {
		mode = "FULL"
	}
	payload.Embeds = append(payload.Embeds, struct {
		Title       string         `json:"title"`
		Color       int            `json:"color"`
		Description string         `json:"description"`
		Fields      []webhookField `json:"fields"`
		Timestamp   string         `json:"timestamp"`
		Footer      struct {
			Text string `json:"text"`
		} `json:"footer"`
	}{
		Title:       fmt.Sprintf("🧪 NEXUS Self-test — chế độ %s — %s", mode, okMark),
		Color:       color,
		Description: desc,
		Fields: []webhookField{
			{Name: "Máy", Value: fmt.Sprintf("%s — %s %s (%s)", report.Hostname, report.Platform, report.OsRelease, report.Arch)},
			{Name: "Runtime", Value: fmt.Sprintf("PowerShell: %s | Admin: %s | reg.exe: %s",
				boolMark(report.Runtime["powershellFound"]), boolMark(report.Runtime["admin"]), boolMark(report.Runtime["regOk"]))},
			{Name: "Kết quả", Value: fmt.Sprintf("✅ %d | ❌ %d | ⏭ %d (trên %d tweak)",
				report.Counts["pass"], report.Counts["fail"], report.Counts["skipped"], report.Catalog["total"]), Inline: true},
			{Name: "Thời lượng", Value: fmt.Sprintf("%dms", report.DurationMs), Inline: true},
			{Name: "Webhook", Value: "✅ đã gửi báo cáo này"},
		},
		Timestamp: report.FinishedAt,
	})
	payload.Embeds[0].Footer.Text = "NEXUS Optimizer — tự kiểm tra tự động"

	b, _ := json.Marshal(payload)
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		return false, "Không gửi được webhook: " + err.Error()
	}
	defer resp.Body.Close()
	if resp.StatusCode == 204 || resp.StatusCode < 300 {
		return true, fmt.Sprintf("Đã gửi báo cáo lên Discord (HTTP %d)", resp.StatusCode)
	}
	return false, fmt.Sprintf("Discord trả về HTTP %d", resp.StatusCode)
}

func boolMark(v any) string {
	if b, ok := v.(bool); ok && b {
		return "✅"
	}
	return "❌"
}

/** Chạy self-test đầy đủ (giữ cấu trúc report từ bản TS) */
func runSelftest(mode string, useWebhook bool) *SelftestReport {
	started := time.Now()
	items := runCheck()
	var full []SelftestFullEntry
	if mode == "full" {
		if !runtimeIsWindows {
			for _, a := range tweakActions() {
				full = append(full, SelftestFullEntry{
					ID: a.Def.ID, Name: a.Def.Name, ApplyOK: false,
					ApplyMsg: "Chỉ chạy được trên Windows (app .exe)", RevertOK: false,
					RevertMsg: "Chỉ chạy được trên Windows (app .exe)", Skipped: true,
				})
			}
		} else {
			full = runFull(120 * time.Second)
		}
	}
	finished := time.Now()
	var runtimeMap map[string]any
	if runtimeIsWindows {
		st := getWinStatus()
		runtimeMap = map[string]any{
			"isWin": true, "powershellFound": st.PsFound, "powershellPath": st.PsPath,
			"powershellDetail": st.PsDetail, "admin": st.Admin, "adminMethod": st.AdminMethod, "regOk": st.RegOk,
		}
	} else {
		runtimeMap = map[string]any{
			"isWin": false, "platform": runtime.GOOS,
			"note": "App đang chạy ngoài Windows — các tinh chỉnh Windows chỉ chạy được trong bản .exe",
		}
	}
	pass, fail, skipped := 0, 0, 0
	for _, i := range items {
		if i.OK {
			pass++
		} else if !i.Skipped {
			fail++
		}
		if i.Skipped {
			skipped++
		}
	}
	fullSkipped := 0
	for _, f := range full {
		if f.Skipped {
			fullSkipped++
		}
	}
	tw := tweakActions()
	rec := 0
	uniqIDs := map[string]bool{}
	uniq := true
	for _, a := range tw {
		if a.Def.Recommended {
			rec++
		}
		if uniqIDs[a.Def.ID] {
			uniq = false
		}
		uniqIDs[a.Def.ID] = true
	}
	report := &SelftestReport{
		Mode: mode, StartedAt: started.Format(time.RFC3339), FinishedAt: finished.Format(time.RFC3339),
		DurationMs: finished.Sub(started).Milliseconds(),
		Hostname:   hostName(), Platform: runtime.GOOS, OsRelease: osRelease(), Arch: runtime.GOARCH,
		Runtime: runtimeMap,
		Catalog: map[string]any{
			"total": len(tw), "recommended": rec, "uniqueIds": uniq,
			"uniqueOrders": len(tw) > 0,
		},
		Items:   items,
		Full:    full,
		Counts:  map[string]int{"pass": pass, "fail": fail, "skipped": skipped + fullSkipped},
		Webhook: map[string]any{"requested": useWebhook, "ok": false, "detail": "Không yêu cầu gửi"},
		OK:      fail == 0 && uniq,
	}
	if useWebhook {
		ok, detail := sendWebhookReport(report)
		report.Webhook = map[string]any{"requested": true, "ok": ok, "detail": detail}
	}
	return report
}

func hostName() string { h, _ := os.Hostname(); return h }

func osRelease() string {
	if runtimeIsWindows {
		return "Windows"
	}
	return runtime.GOOS
}
