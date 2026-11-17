// gaming.go — Gaming Mode preset (port từ gaming.ts): tái sử dụng apply/revert của catalog tweaks.
package main

import (
	"time"
)

var gamingPresetApplyWin = []string{
	"win-game-dvr-off", "win-gamemode-on", "win-fse-off", "win-mouse-accurate",
	"win-keyboard-fast", "win-keyboard-accessibility-off", "win-menu-delay", "win-startup-delay",
	"win-ram-clean", "win-flush-dns", "win-power-high", "win-cpu-priority-separation",
	"win-cpu-core-parking-off", "win-gpu-hwsch-on", "win-mmcss-gaming", "win-netthrottle",
	"win-background-apps-off",
}

var gamingPresetRevertWin = []string{
	"win-game-dvr-off", "win-gamemode-on", "win-fse-off", "win-mouse-accurate",
	"win-keyboard-fast", "win-keyboard-accessibility-off", "win-menu-delay", "win-startup-delay",
	"win-power-high", "win-sysresp", "win-cpu-priority-separation", "win-cpu-core-parking-off",
	"win-gpu-hwsch-on", "win-mmcss-gaming", "win-netthrottle", "win-background-apps-off",
} // v3.4.0 fix: bỏ 3 id không có trong apply (tránh bật lại SysMain/DiagTrack user chưa tắt)

const gamingNoteWin = "Các tinh chỉnh HKCU áp dụng ngay cho user hiện tại; các mục HKLM/service cần quyền Administrator — nếu thiếu quyền sẽ báo lỗi trung thực."
const gamingNoteOther = "Gaming Mode chỉ áp dụng được trên Windows (bản .exe) — các mục sẽ được báo lỗi trung thực."

type GamingStatus struct {
	Enabled   bool           `json:"enabled"`
	EnabledAt string         `json:"enabledAt,omitempty"`
	Effects   []GamingEffect `json:"effects"`
	Note      string         `json:"note"`
}

func getGamingStatus() GamingStatus {
	enabled, at, effects := appState.GetGaming()
	st := GamingStatus{Enabled: enabled, Effects: effects}
	if runtimeIsWindows {
		st.Note = gamingNoteWin
	} else {
		st.Note = gamingNoteOther
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
