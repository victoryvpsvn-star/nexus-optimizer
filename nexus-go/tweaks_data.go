// tweaks_data.go — nạp danh mục tinh chỉnh từ file data/*.tsv (embed).
// Mỗi dòng: id~~category~~name~~description~~risk~~admin(0/1)~~recommended(0/1)~~apply~~revert
// Spec DSL (step cách nhau bằng ';'):
//   RA:key|name|type|data   reg add          RD:key|name  reg delete value (missing = OK)
//   RV:key                  reg add /ve      RK:key       reg add key /f (revert của DK)
//   DK:key                  reg delete key   SC:svc|revertMode  sc config disable + stop
//   PC:sub|setting|val|revertVal  powercfg setac+setdc (revert = set về revertVal)
//   TK:\path\task           schtasks disable/enable (missing = OK)
//   AX:Package.Name         Get-AppxPackage remove/re-register
//   EX:exe|arg|arg          chạy exe (EXR: chỉ là alias dùng ở cột revert)
//   PX:script               PowerShell 1 dòng (PXR: alias cho cột revert)
package main

import (
	"embed"
	"fmt"
	"strings"
)

//go:embed data/*.tsv
var tweakDataFS embed.FS

/** Cắt 1 dòng spec thành các step theo chiều apply/revert.
Cú pháp step: KIND:arg1|arg2|... — tách KIND bằng ':' đầu tiên, args bằng '|'. */
func parseSpec(spec string, revert bool) []step {
	var out []step
	for _, part := range strings.Split(spec, ";") {
		p := strings.TrimSpace(part)
		if p == "" {
			continue
		}
		idx := strings.Index(p, ":")
		if idx <= 0 {
			continue
		}
		kind := p[:idx]
		f := strings.Split(p[idx+1:], "|")
		for i := range f {
			f[i] = strings.TrimSpace(f[i])
		}
		switch kind {
		case "RA":
			if len(f) >= 4 {
				out = append(out, ra(f[0], f[1], f[2], f[3]))
			}
		case "RD":
			if len(f) >= 2 {
				out = append(out, rd(f[0], f[1]))
			}
		case "RV":
			if len(f) >= 1 {
				out = append(out, rave(f[0]))
			}
		case "RK":
			if len(f) >= 1 {
				out = append(out, rak(f[0]))
			}
		case "DK":
			if len(f) >= 1 {
				out = append(out, rdk(f[0]))
			}
		case "SC":
			if len(f) >= 2 {
				out = append(out, svc(f[0], f[1]))
			}
		case "PC":
			if len(f) >= 4 {
				val := f[2]
				if revert {
					val = f[3]
				}
				out = append(out, pcfg(f[0], f[1], val))
			}
		case "TK":
			if len(f) >= 1 {
				out = append(out, task(f[0]))
			}
		case "AX":
			if len(f) >= 1 {
				out = append(out, appx(f[0]))
			}
		case "EX", "EXR":
			if len(f) >= 1 {
				out = append(out, exe(f[0], f[1:]...))
			}
		case "PX", "PXR":
			if strings.TrimSpace(p[idx+1:]) != "" {
				out = append(out, pss(p[idx+1:]))
			}
		}
	}
	return out
}

/** Nạp toàn bộ data/*.tsv → []tableTweak; dòng lỗi bị bỏ qua + đếm (không làm chết app) */
func dataTweaks() ([]tableTweak, int, []string) {
	out := []tableTweak{}
	skipped := []string{}
	loaded := 0
	entries, err := tweakDataFS.ReadDir("data")
	if err != nil {
		return out, 0, []string{"không đọc được thư mục data: " + err.Error()}
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".tsv") {
			continue
		}
		b, err := tweakDataFS.ReadFile("data/" + e.Name())
		if err != nil {
			skipped = append(skipped, e.Name()+": đọc lỗi")
			continue
		}
		for ln, line := range strings.Split(string(b), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			f := strings.Split(line, "~~")
			if len(f) < 9 {
				skipped = append(skipped, fmt.Sprintf("%s:%d thiếu cột", e.Name(), ln+1))
				continue
			}
			id := strings.TrimSpace(f[0])
			name := strings.TrimSpace(f[1])
			cat := strings.TrimSpace(f[2])
			desc := strings.TrimSpace(f[3])
			risk := strings.TrimSpace(f[4])
			admin := strings.TrimSpace(f[5]) == "1"
			rec := strings.TrimSpace(f[6]) == "1"
			applySpec := strings.TrimSpace(f[7])
			revertSpec := strings.TrimSpace(f[8])
			applySteps := parseSpec(applySpec, false)
			if id == "" || name == "" || cat == "" || len(applySteps) == 0 {
				skipped = append(skipped, fmt.Sprintf("%s:%d dòng không hợp lệ", e.Name(), ln+1))
				continue
			}
			if risk != "low" && risk != "medium" && risk != "high" {
				risk = "medium"
			}
			tt := tableTweak{
				Def: TweakDef{
					ID: id, Name: name, Description: desc,
					Category: cat, Risk: risk,
					RequiresRoot: admin, Recommended: rec,
				},
				ApplySteps: applySteps,
				ApplyMsg:   "Đã áp dụng: " + name,
			}
			if revertSpec == "" {
				tt.ApplyOnly = true
				tt.RevertMsg = "Hành động tức thời — không cần hoàn tác"
			} else {
				tt.RevertSteps = parseSpec(revertSpec, true)
				// v4.3.0 (P3-01): revertSpec có nội dung mà parse ra 0 steps = dữ liệu lỗi —
				// không nạp (revert rỗng sẽ bị coi là "hoàn tác thành công" oan)
				if len(tt.RevertSteps) == 0 {
					skipped = append(skipped, fmt.Sprintf("%s:%d revertSpec không parse được step nào (spec=%q)", e.Name(), ln+1, revertSpec))
					continue
				}
				tt.RevertMsg = "Đã hoàn tác về mặc định: " + name
			}
			out = append(out, tt)
			loaded++
		}
	}
	return out, loaded, skipped
}
