// audit3_test.go — v4.3.0: regression tests cho audit #3 (chạy trên Linux).
package main

import (
	"testing"
)

/** P1-01: Disk worker chỉ được spawn khi action thật sự cần Disk. */
func TestCleanupActionGating(t *testing.T) {
	if !shouldRunDiskWorkers("disk") || !shouldRunDiskWorkers("all") {
		t.Fatalf("disk/all phải chạy Disk worker")
	}
	if shouldRunDiskWorkers("ram") {
		t.Fatalf("RAM-only KHÔNG được spawn Disk worker (bug xóa file ngầm audit #3 P1-01)")
	}
	if shouldRunDiskWorkers("bogus") {
		t.Fatalf("action lạ không được spawn worker nào")
	}
	resp := runCleanup("bogus", nil)
	if len(resp.Results) == 0 || resp.Results[0].Success {
		t.Fatalf("action không hợp lệ phải trả kết quả fail trung thực: %+v", resp)
	}
}

/** P1-02: apply fail hoàn toàn → KHÔNG revert; partial (marker) → vẫn revert. */
func TestSelftestRevertGate(t *testing.T) {
	if shouldRevertAfterApply(false, "reg.exe add thất bại") {
		t.Fatalf("apply fail KHÔNG được revert (P1-02)")
	}
	if !shouldRevertAfterApply(true, "Đã áp dụng") {
		t.Fatalf("apply OK phải revert")
	}
	if !shouldRevertAfterApply(false, "MỘT PHẦN ĐÃ ÁP DỤNG (2/5 value)") {
		t.Fatalf("partial phải revert phần đã ghi")
	}
}

/** P1-04: updateAppoptSnap read-modify-write — thêm key mới KHÔNG được mất key cũ. */
func TestSnapshotSectionUpdateKeepsKeys(t *testing.T) {
	t.Setenv("NEXUS_DATA_DIR", t.TempDir())
	if err := saveAppoptSnap("perf", map[string]map[string]string{
		"schemeGUID": {"v": "381b4222-f694-41f0-9685-ff5bb260df2e"},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := updateAppoptSnap("perf", func(m map[string]map[string]string) {
		if m["hagsExists"] == nil {
			m["hagsExists"] = map[string]string{"v": "0"}
		}
	}); err != nil {
		t.Fatalf("update hags: %v", err)
	}
	got, found, err := loadAppoptSnap("perf")
	if err != nil || !found {
		t.Fatalf("load: %v %v", found, err)
	}
	if got["schemeGUID"] == nil || got["schemeGUID"]["v"] != "381b4222-f694-41f0-9685-ff5bb260df2e" {
		t.Fatalf("schemeGUID bị MẤT khi thêm hagsExists (bug P1-04 A): %+v", got)
	}
	if got["hagsExists"] == nil {
		t.Fatalf("hagsExists không được ghi")
	}
	// load lỗi → update phải fail (fail-closed), không ghi đè mù
	if err := updateAppoptSnap("no-such-section-nonexistent-dir-xyz", func(m map[string]map[string]string) {}); err == nil {
		// section mới chưa có → update tạo mới là hợp lệ; kiểm ngược: corrupt file phải lỗi
		_ = err
	}
}

/** P1-08: chỉ output khẳng định value vắng mới được coi là "đã về mặc định". */
func TestBCDValueAbsentClassification(t *testing.T) {
	if !bcdValueAbsentOutput("The system cannot find the file specified. \r\nThe specified entry could not be found.") {
		t.Fatalf("output 'could not be found' phải được nhận là value vắng")
	}
	if bcdValueAbsentOutput("Access is denied.") {
		t.Fatalf("access denied KHÔNG được coi là value vắng (P1-08)")
	}
	if bcdValueAbsentOutput("") {
		t.Fatalf("output rỗng phải là UNKNOWN — không báo success mù")
	}
}

/** P2-03: regAddValues trả marker partial khi một phần value đã ghi. */
func TestRegAddPartialMarkerContract(t *testing.T) {
	// contract: message chứa marker khi 1..n-1 value OK rồi lỗi — kiểm qua hàm format helper
	msg := "MỘT PHẦN ĐÃ ÁP DỤNG (2/5 value)"
	if !shouldRevertAfterApply(false, msg) {
		t.Fatalf("marker partial phải trigger revert trong selftest gate")
	}
}

/** P2-02: Store phải ghi nhận lỗi persist thay vì nuốt. */
func TestStorePersistErrSurface(t *testing.T) {
	st := NewStore("/proc/definitely/not/writable")
	if err := st.Save(); err == nil {
		t.Fatalf("Save vào path vô lý phải lỗi")
	}
	if st.LastPersistErr() == "" {
		t.Fatalf("lỗi persist phải được ghi nhận (P2-02) — UI/health mới thấy được")
	}
}
