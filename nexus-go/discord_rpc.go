// discord_rpc.go — TRẠNG THÁI presence cho beacon của extension (đã BỎ HẲN đường IPC
// Discord desktop theo yêu cầu user: "sao cần discord app???").
// Discord status giờ CHỈ do extension Cat Status đảm nhiệm: đăng nhập OAuth 1 lần +
// POST /users/@me/headless-sessions — không cần app Discord desktop chạy ngầm.
// presenceSet() vẫn được gọi khi user đổi mục trong UI / chạy hành động — beacon trả
// section/note cho extension (extension v2.4.0 hiển thị text quảng cáo cố định).
package main

import (
	"sync"
	"time"
)

const presenceDefaultAppID = "1563917712227442731" // app Discord của user (dùng trong Cat Status extension)

// presence: trạng thái toàn cục cho beacon
var presenceMtx sync.Mutex
var presenceSt = struct {
	appID   string
	section string
	note    string
	start   time.Time
}{appID: presenceDefaultAppID, start: time.Now()}

/** Cập nhật section/note hiện tại — gọi từ handler API */
func presenceSet(section, note string) {
	presenceMtx.Lock()
	defer presenceMtx.Unlock()
	presenceSt.section = trunc(section, 128)
	if note != "" {
		presenceSt.note = trunc(note, 128)
	}
}

/** enabled/connected luôn false — đường IPC đã bị loại bỏ, chỉ extension báo Discord */
func presenceStatus() (bool, bool, string, string, string) {
	presenceMtx.Lock()
	defer presenceMtx.Unlock()
	return false, false, presenceSt.appID, presenceSt.section, presenceSt.note
}

func presenceStarted() int64 {
	presenceMtx.Lock()
	defer presenceMtx.Unlock()
	return presenceSt.start.Unix()
}

func trunc(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
