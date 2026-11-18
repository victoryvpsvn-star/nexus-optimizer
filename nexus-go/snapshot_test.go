// snapshot_test.go — v4.1.0: unit test lớp snapshot theo audit v4.0.0 (phát hiện 06).
// Chạy được trên Linux (chỉ là file JSON + mutex — không đụng registry).
package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withTempDataDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("NEXUS_DATA_DIR", dir)
	return dir
}

/** TEST APP-05 (audit): hai section khác nhau phải sống chung — save 1 section không được
 * làm mất section khác (lỗi cũ: đọc JSON nuốt lỗi → map nil → ghi đè mất toàn bộ). */
func TestSnapshotSectionsPreserved(t *testing.T) {
	withTempDataDir(t)
	if err := saveAppoptSnap("policy:edge", map[string]map[string]string{
		"StartupBoostEnabled": {"type": "REG_DWORD", "data": "0x1"},
	}); err != nil {
		t.Fatalf("save section 1: %v", err)
	}
	if err := saveAppoptSnap("run:steam", map[string]map[string]string{
		"existed": {"v": "1"},
		"Steam":   {"type": "REG_SZ", "data": `"C:\Steam\steam.exe" -silent`},
	}); err != nil {
		t.Fatalf("save section 2: %v", err)
	}
	s2, found, err := loadAppoptSnap("policy:edge")
	if err != nil || !found || s2["StartupBoostEnabled"] == nil {
		t.Fatalf("section policy:edge mất sau khi save run:steam (phát hiện 06.2): found=%v err=%v", found, err)
	}
}

/** TEST APP-04: JSON corrupt → phải BÁO LỖI + cách ly file, KHÔNG âm thầm tạo file mới
 * làm người dùng mất dữ liệu snapshot gốc của các section còn lại. */
func TestSnapshotCorruptQuarantined(t *testing.T) {
	dir := withTempDataDir(t)
	p := filepath.Join(dir, "appopt-snap.json")
	if err := os.WriteFile(p, []byte("{corrupt json!"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, found, err := loadAppoptSnap("anything")
	if err == nil {
		t.Fatalf("JSON hỏng phải trả error, không được nuốt thành 'không có snapshot' (found=%v)", found)
	}
	ents, _ := os.ReadDir(dir)
	quarantined := false
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), "appopt-snap.json.corrupt-") {
			quarantined = true
		}
	}
	if !quarantined {
		t.Fatalf("file corrupt phải được cách ly (.corrupt-<ts>) để giữ bằng chứng")
	}
}

/** Phát hiện 06.5: sentinel existed=false — app vốn không có Run entry thì load ra
 * existed=0 (khôi phục = no-op thành công), không phải "mất snapshot". */
func TestSnapshotRunEntrySentinel(t *testing.T) {
	withTempDataDir(t)
	if err := saveAppoptSnap("run:steam", map[string]map[string]string{
		"existed": {"v": "0"},
	}); err != nil {
		t.Fatal(err)
	}
	s, found, err := loadAppoptSnap("run:steam")
	if err != nil || !found {
		t.Fatalf("snapshot có sentinel phải load được: found=%v err=%v", found, err)
	}
	if s["existed"] == nil || s["existed"]["v"] != "0" {
		t.Fatalf("sentinel existed=0 mất: %v", s)
	}
}

/** TEST APP-01 nửa "không mất dữ liệu": clear section KHÔNG được đụng section khác. */
func TestSnapshotClearOnlyTargetSection(t *testing.T) {
	withTempDataDir(t)
	_ = saveAppoptSnap("unlocks-cpu", map[string]map[string]string{"minAC": {"v": "5"}})
	_ = saveAppoptSnap("unlocks-gpu", map[string]map[string]string{"powerLimitBefore": {"v": "95"}})
	if err := clearAppoptSnap("unlocks-cpu"); err != nil {
		t.Fatalf("clear: %v", err)
	}
	_, foundCPU, _ := loadAppoptSnap("unlocks-cpu")
	gpu, foundGPU, _ := loadAppoptSnap("unlocks-gpu")
	if foundCPU {
		t.Fatalf("unlocks-cpu phải được xóa")
	}
	if !foundGPU || gpu["powerLimitBefore"] == nil {
		t.Fatalf("unlocks-gpu không được đụng khi clear unlocks-cpu (phát hiện 06.2)")
	}
}

/** Phát hiện 10.4: parse digest GitHub assets[].digest */
func TestParseAssetDigest(t *testing.T) {
	ok := "sha256:ccf70c5fd3114954597b74401e392830f1447f122cd4248baa9498a944a5536b"
	got, has := parseAssetDigest(ok)
	if !has || got != "ccf70c5fd3114954597b74401e392830f1447f122cd4248baa9498a944a5536b" {
		t.Fatalf("digest hợp lệ bị từ chối: %q %v", got, has)
	}
	for _, bad := range []string{"", "md5:abc", "sha256:xyz", "sha256:ccf70c", "abc"} {
		if _, has := parseAssetDigest(bad); has {
			t.Fatalf("digest lạ không được chấp nhận: %q", bad)
		}
	}
}
