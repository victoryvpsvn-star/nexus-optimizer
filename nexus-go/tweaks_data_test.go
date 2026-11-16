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
