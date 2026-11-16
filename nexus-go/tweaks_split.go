// tweaks_split.go — tách tableTweak compound (≥2 bước reg add + revert delete đối xứng)
// thành từng tinh chỉnh độc lập theo value registry. Mỗi value = 1 row THẬT riêng để
// người dùng áp/diagnostic từng giá trị, không bị buộc chọn cả cụm. An toàn với selftest:
// tableMap tra cứu theo ID của catalog (ID split có hậu tố -pN).
package main

import (
	"fmt"
	"strings"
)

func splitCompound(ts []tableTweak) []tableTweak {
	out := make([]tableTweak, 0, len(ts)+64)
	for _, t := range ts {
		n := len(t.ApplySteps)
		if n < 2 || len(t.RevertSteps) != n {
			out = append(out, t)
			continue
		}
		ok := true
		seen := map[string]bool{}
		for i := range t.ApplySteps {
			a, d := t.ApplySteps[i], t.RevertSteps[i]
			if a.Kind != stepRegAdd || d.Kind != stepRegDel || a.Key != d.Key || a.Name != d.Name {
				ok = false
				break
			}
			k := strings.ToLower(a.Key + "\\" + a.Name)
			if seen[k] {
				ok = false
				break
			}
			seen[k] = true
		}
		if !ok {
			out = append(out, t)
			continue
		}
		for i := range t.ApplySteps {
			nt := tableTweak{
				Def:         t.Def,
				ApplySteps:  []step{t.ApplySteps[i]},
				ApplyMsg:    t.ApplyMsg,
				RevertSteps: []step{t.RevertSteps[i]},
				RevertMsg:   t.RevertMsg,
			}
			nt.Def.ID = fmt.Sprintf("%s-p%d", t.Def.ID, i+1)
			nt.Def.Name = fmt.Sprintf("%s — %s", t.Def.Name, t.ApplySteps[i].Name)
			nt.Def.Description = fmt.Sprintf("%s (mục %d/%d: %s\\%s)", t.Def.Description, i+1, n, t.ApplySteps[i].Key, t.ApplySteps[i].Name)
			out = append(out, nt)
		}
	}
	return out
}
