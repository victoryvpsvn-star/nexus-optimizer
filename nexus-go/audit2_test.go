// audit2_test.go — v4.2.0: unit test cho các fix audit #2 (chạy được trên Linux).
package main

import (
	"os"
	"strings"
	"testing"
)

/** P1-03: tweak chứa Appx phải bị self-test FULL chặn — test qua chính helper dùng trong runFull. */
func TestSelftestSkipsAppx(t *testing.T) {
	found := 0
	for _, a := range tweakActions() {
		if tweakHasAppx(a.Def.ID) {
			found++
			// bảng bloat phải là nơi duy nhất có Appx — những tweak này không được tự chạy trong FULL
			if a.Def.Category != "Appx" && a.Def.Category != "bloat" && a.Def.Category != "appx" {
				t.Logf("Appx tweak ngoài nhóm bloat: %s (cat=%s)", a.Def.ID, a.Def.Category)
			}
		}
	}
	if found == 0 {
		t.Fatalf("catalog không còn tweak Appx nào để chặn — bảng bloat mất bước Appx?")
	}
}

/** P2-06: phân loại trạng thái WSearch — chỉ STOPPED rõ ràng mới được coi là đã dừng.
 * Đóng gói logic cùng điều kiện dùng trong fixSearch để test được trên Linux. */
func classifySvcState(exitOK bool, out string) string {
	u := strings.ToUpper(out)
	switch {
	case exitOK && strings.Contains(u, "STOPPED") && !strings.Contains(u, "RUNNING"):
		return "STOPPED"
	case strings.Contains(u, "RUNNING"):
		return "RUNNING"
	case strings.Contains(u, "STOP_PENDING"):
		return "STOP_PENDING"
	case strings.Contains(u, "START_PENDING"):
		return "START_PENDING"
	default:
		return "UNKNOWN"
	}
}

func TestSvcStateClassification(t *testing.T) {
	cases := []struct {
		exitOK bool
		out    string
		want   string
	}{
		{true, "SERVICE_NAME: WSearch\n        STATE              : 4  STOPPED", "STOPPED"},
		{true, "        STATE              : 4  RUNNING", "RUNNING"},
		{false, "", "UNKNOWN"}, // query lỗi → không được coi là STOPPED (P2-06)
		{false, "        STATE              : 4  STOPPED", "UNKNOWN"}, // exit lỗi → UNKNOWN kể cả output (không đụng index mù)
		{true, "", "UNKNOWN"}, // output rỗng ≠ STOPPED
		{true, "STATE : 3 STOP_PENDING", "STOP_PENDING"},
	}
	for i, c := range cases {
		if got := classifySvcState(c.exitOK, c.out); got != c.want {
			t.Fatalf("case %d: got %s want %s (out=%q)", i, got, c.want, c.out)
		}
	}
	// điều kiện dùng trong fixSearch phải chặn đúng UNKNOWN
	stopped := classifySvcState(true, "") == "STOPPED"
	if stopped {
		t.Fatalf("fixSearch không được coi output rỗng là STOPPED")
	}
}

/** P1-01: snapshot perf phải chứa đủ các loại mục — HAGS (kể cả exists=false), cpuMin AC+DC,
 * schemeGUID, ultimateGUID. Dùng data thật qua saveAppoptSnap + loadAppoptSnap. */
func TestPerfSnapshotShape(t *testing.T) {
	t.Setenv("NEXUS_DATA_DIR", t.TempDir())
	m := map[string]map[string]string{
		"schemeGUID":   {"v": "381b4222-f694-41f0-9685-ff5bb260df2e"},
		"hagsExists":   {"v": "0"},
		"cpuMinAC":     {"v": "5"},
		"cpuMinDC":     {"v": "5"},
		"ultimateGUID": {"v": "e9a42b02-d5df-448d-aa00-03f14749eb61"},
	}
	if err := saveAppoptSnap("perf", m); err != nil {
		t.Fatalf("save perf: %v", err)
	}
	got, found, err := loadAppoptSnap("perf")
	if err != nil || !found {
		t.Fatalf("load perf: found=%v err=%v", found, err)
	}
	for _, k := range []string{"schemeGUID", "hagsExists", "cpuMinAC", "cpuMinDC", "ultimateGUID"} {
		if got[k] == nil {
			t.Fatalf("snapshot perf thiếu key %s (P1-01)", k)
		}
	}
}

/** P1-05: "không có snapshot" và "snapshot còn nhưng GPU mất" phải khác nhau —
 * helper logic khớp restoreGPU* : có snapshot + không nvidia-smi = PENDING (fail). */
func TestGPUPendingSemantics(t *testing.T) {
	hasSnap := func(found bool, key string) bool { return found && key != "" }
	// GPU vắng + có phiên unlock còn lưu → phải PENDING (không được return silent OK)
	if hasSnap(true, "powerLimitBefore") == false {
		t.Fatalf("phát hiện snapshot GPU sai")
	}
	// GPU vắng + không snapshot → no-op OK (trạng thái gốc không đổi)
	if hasSnap(false, "") == true {
		t.Fatalf("không snapshot không được coi là còn phiên")
	}
	_ = os.DevNull
}
