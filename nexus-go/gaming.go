// gaming.go — Gaming Mode preset (port từ gaming.ts): tái sử dụng apply/revert của catalog tweaks.
package main

import (
	"fmt"
	"time"
)

// v3.6.0: thêm Nagle (độ trễ mạng), TDR delay (chống reset driver GPU) và dynamic tick off
// vào preset Gaming — cả apply lẫn revert phải có id trong catalog (go test enforce)
var gamingPresetApplyWin = []string{
	"win-game-dvr-off", "win-gamemode-on", "win-fse-off", "win-mouse-accurate",
	"win-keyboard-fast", "win-keyboard-accessibility-off", "win-menu-delay", "win-startup-delay",
	"win-ram-clean", "win-flush-dns", "win-power-high", "win-cpu-priority-separation",
	"win-cpu-core-parking-off", "win-gpu-hwsch-on", "win-mmcss-gaming", "win-netthrottle",
	"win-background-apps-off", "win-nagle", "win-gpu-tdr-delay", "win-cpu-dynamic-tick-off",
}

var gamingPresetRevertWin = []string{
	"win-game-dvr-off", "win-gamemode-on", "win-fse-off", "win-mouse-accurate",
	"win-keyboard-fast", "win-keyboard-accessibility-off", "win-menu-delay", "win-startup-delay",
	"win-power-high", "win-cpu-priority-separation", "win-cpu-core-parking-off",
	"win-gpu-hwsch-on", "win-mmcss-gaming", "win-netthrottle", "win-background-apps-off",
	"win-nagle", "win-gpu-tdr-delay", "win-cpu-dynamic-tick-off",
} // v3.4.0 fix: bỏ 3 id không có trong apply (tránh bật lại SysMain/DiagTrack user chưa tắt)
// v4.1.0 (phát hiện 07): bỏ win-sysresp khỏi Revert — nó không nằm trong Apply, Gaming
// Mode tắt đã ghi đè SystemResponsiveness=20 ngoài phạm vi preset (audit TEST GAMING-01/02)

const gamingNoteWin = "Các tinh chỉnh HKCU áp dụng ngay cho user hiện tại; các mục HKLM/service cần quyền Administrator — nếu thiếu quyền sẽ báo lỗi trung thực."
const gamingNoteOther = "Gaming Mode chỉ áp dụng được trên Windows (bản .exe) — các mục sẽ được báo lỗi trung thực."

type GamingStatus struct {
	Enabled   bool           `json:"enabled"`
	EnabledAt string         `json:"enabledAt,omitempty"`
	Effects   []GamingEffect `json:"effects"`
	Note      string         `json:"note"`
	Partial   bool           `json:"partial,omitempty"` // v3.9.0 (audit P2-15): bật nhưng có hiệu ứng lỗi
	Failed    int            `json:"failed,omitempty"`
}

func getGamingStatus() GamingStatus {
	enabled, at, effects := appState.GetGaming()
	st := GamingStatus{Enabled: enabled, Effects: effects}
	if runtimeIsWindows {
		st.Note = gamingNoteWin
	} else {
		st.Note = gamingNoteOther
	}
	// v3.9.0 (theo audit P2-15): không giả "enabled" là đủ — đếm hiệu ứng lỗi thật,
	// UI hiển thị rõ "bật nhưng một phần lỗi" thay vì giả vờ mọi thứ OK
	if enabled {
		for _, e := range effects {
			if !e.Success {
				st.Failed++
			}
		}
		if st.Failed > 0 {
			st.Partial = true
			st.Note = fmt.Sprintf("⚠️ Gaming Mode đang BẬT nhưng %d/%d hiệu ứng lỗi (thường do thiếu quyền admin) — xem chi tiết từng mục bên dưới. %s", st.Failed, len(effects), st.Note)
		}
	} else {
		// v4.1.0 (phát hiện 07.5): "đã tắt toggle" ≠ mọi tweak đã trả về gốc — đếm cả chiều revert
		for _, e := range effects {
			if !e.Success {
				st.Failed++
			}
		}
		if st.Failed > 0 {
			st.Partial = true
			st.Note = fmt.Sprintf("⚠️ Gaming Mode đã TẮT nhưng %d/%d mục hoàn tác thất bại — cấu hình còn sót một phần (thử tắt lại, cần admin đủ). %s", st.Failed, len(effects), st.Note)
		}
	}
	if at != nil {
		st.EnabledAt = at.Format(time.RFC3339)
	}
	if st.Effects == nil {
		st.Effects = []GamingEffect{}
	}
	return st
}

func nameOfTweak(id string) string {
	for _, a := range tweakActions() {
		if a.Def.ID == id {
			return a.Def.Name
		}
	}
	return id
}

func setGaming(enabled bool) []GamingEffect {
	ids := gamingPresetRevertWin
	if enabled {
		ids = gamingPresetApplyWin
	}
	effects := make([]GamingEffect, 0, len(ids))
	for _, id := range ids {
		var r TweakRunResult
		if enabled {
			r = applyTweakById(id)
		} else {
			r = revertTweakById(id)
		}
		effects = append(effects, GamingEffect{ID: id, Name: nameOfTweak(id), Success: r.Success, Message: r.Message})
	}
	appState.PutGaming(enabled, effects)
	return effects
}
