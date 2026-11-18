package main

import "testing"

func TestParseSpecReg(t *testing.T) {
	steps := parseSpec("RA:HKCU\\Foo|Bar|REG_DWORD|0; RD:HKCU\\Foo|Bar", false)
	if len(steps) != 2 || steps[0].Kind != stepRegAdd || steps[1].Kind != stepRegDel {
		t.Fatalf("parseSpec RA/RD sai: %+v", steps)
	}
}

func TestParseSpecDirections(t *testing.T) {
	a := parseSpec("PC:sub|set|10|20", false)
	r := parseSpec("PC:sub|set|10|20", true)
	if len(a) != 1 || len(r) != 1 || a[0].Data != "10" || r[0].Data != "20" {
		t.Fatalf("PC apply/revert sai: %+v %+v", a, r)
	}
	ex := parseSpec("EX:netsh.exe|int|tcp", false)
	if len(ex) != 1 || ex[0].Name != "netsh.exe" || len(ex[0].Args) != 2 {
		t.Fatalf("EX sai: %+v", ex)
	}
}

func TestCatalogIntegrity(t *testing.T) {
	tw := tweakActions()
	if len(tw) < 300 {
		t.Fatalf("catalog quá ít: %d", len(tw))
	}
	seen := map[string]int{}
	for _, a := range tw {
		seen[a.Def.ID]++
		if seen[a.Def.ID] > 1 {
			t.Fatalf("trùng id: %s", a.Def.ID)
		}
		if a.Def.Order <= 0 {
			t.Fatalf("order 0 (nhóm lạ?): %s [%s]", a.Def.ID, a.Def.Category)
		}
		if a.Apply == nil || a.Revert == nil {
			t.Fatalf("tweak thiếu Apply/Revert — sẽ lỗi khi bấm trên máy thật: %s", a.Def.ID)
		}
		switch a.Def.Risk {
		case "low", "medium", "high":
		default:
			t.Fatalf("risk lạ: %s [%s]", a.Def.Risk, a.Def.ID)
		}
		if a.Def.Name == "" || a.Def.Category == "" || a.Def.Description == "" {
			t.Fatalf("tweak thiếu tên/category/mô tả: %s", a.Def.ID)
		}
	}
}

// v3.6.0: preset Gaming phải chỉ tới id có thật trong catalog — nếu thiếu thì bấm
// Gaming Mode trên máy thật sẽ áp dụng "id ẩn danh" không ai nhận ra
func TestGamingPresetIdsExist(t *testing.T) {
	tw := tweakActions()
	have := map[string]bool{}
	for _, a := range tw {
		have[a.Def.ID] = true
	}
	for _, list := range [][]string{gamingPresetApplyWin, gamingPresetRevertWin} {
		for _, id := range list {
			if !have[id] {
				t.Fatalf("preset Gaming dùng id không có trong catalog: %s", id)
			}
		}
	}
	if len(gamingPresetApplyWin) < 19 {
		t.Fatalf("preset Gaming v3.6.0 phải ≥19 mục (nagle/tdr/dynamic tick mới thêm): %d", len(gamingPresetApplyWin))
	}
	// mọi id apply phải có revert tương ứng — trừ hành động chạy-lần-một (dọn RAM, flush DNS:
	// là thao tác làm sạch tức thời, không có trạng thái nào để hoàn tác)
	oneShot := map[string]bool{"win-ram-clean": true, "win-flush-dns": true, "win-ram-standby-clear": true}
	// v4.1.0 (phát hiện 07, TEST GAMING-01): chiều ngược lại cũng phải kiểm —
	// id chỉ có trong Revert mà không có trong Apply nghĩa là Tắt Gaming sẽ đụng
	// tweak mà Bật Gaming chưa từng chạm (trường hợp thật: win-sysresp ghi đè
	// SystemResponsiveness=20 ngoài phạm vi preset)
	applySet := map[string]bool{}
	for _, id := range gamingPresetApplyWin {
		applySet[id] = true
	}
	for _, id := range gamingPresetRevertWin {
		if !applySet[id] && !oneShot[id] {
			t.Fatalf("Gaming Revert có id không nằm trong Apply (revert quá phạm vi): %s", id)
		}
	}
	haveRevert := map[string]bool{}
	for _, id := range gamingPresetRevertWin {
		haveRevert[id] = true
	}
	for _, id := range gamingPresetApplyWin {
		if !haveRevert[id] && !oneShot[id] {
			t.Fatalf("preset Gaming bật %s nhưng revert không có %s — bật xong không gỡ được", id, id)
		}
	}
}

func TestDataLoad(t *testing.T) {
	rows, n, skipped := dataTweaks()
	if n < 100 {
		t.Fatalf("TSV nạp quá ít: %d (skipped=%v)", n, skipped)
	}
	if len(rows) != n {
		t.Fatalf("rows != n")
	}
	for _, r := range rows {
		if r.Def.ID == "" || r.Def.Name == "" || r.Def.Category == "" || len(r.ApplySteps) == 0 {
			t.Fatalf("row hỏng: %+v", r.Def)
		}
	}
}
