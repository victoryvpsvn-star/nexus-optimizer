// discord_rpc.go — Discord Rich Presence cho Sakura Tool qua IPC nội bộ Discord desktop.
// Windows: named pipe \\.\pipe\discord-ipc-N; Linux/macOS: unix socket discord-ipc-N.
// Không cần đăng nhập/token — Discord desktop đang chạy là status hiện.
// "Chuyển status liên tục": presenceSet() được gọi khi user đổi mục trong UI + khi chạy
// apply/revert/cleanup/gaming/selftest; elapsed time tự chạy từ timestamps.start.
package main

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"
)

const presenceDefaultAppID = "1563917712227442731" // app Discord của user (thấy trong Cat Status extension)

type discordConn struct {
	c io.ReadWriteCloser
}

// presence: trạng thái toàn cục (1 goroutine quản conn)
var presenceMtx sync.Mutex
var presenceSt = struct {
	enabled bool
	conn    io.ReadWriteCloser
	appID   string
	section string
	note    string
	start   time.Time
	lastOK  time.Time
}{appID: presenceDefaultAppID, start: time.Now()}

/** Cập nhật section/note hiện tại — gọi từ handler API */
func presenceSet(section, note string) {
	presenceMtx.Lock()
	presenceSt.section = section
	if note != "" {
		presenceSt.note = note
	}
	on := presenceSt.enabled
	presenceMtx.Unlock()
	if on {
		presenceEnsure(false)
	}
}

func presenceEnabled() bool {
	presenceMtx.Lock()
	defer presenceMtx.Unlock()
	return presenceSt.enabled
}

func presenceSetEnabled(on bool, appID string) string {
	presenceMtx.Lock()
	presenceSt.enabled = on
	if appID != "" {
		presenceSt.appID = appID
	}
	presenceMtx.Unlock()
	if on {
		return presenceEnsure(true)
	}
	presenceMtx.Lock()
	if presenceSt.conn != nil {
		_ = presenceSt.conn.Close() // đóng pipe → Discord xóa status ngay
		presenceSt.conn = nil
	}
	presenceMtx.Unlock()
	return "Đã tắt Discord status"
}

func presenceStatus() (bool, bool, string, string, string) {
	presenceMtx.Lock()
	defer presenceMtx.Unlock()
	connected := presenceSt.conn != nil && time.Since(presenceSt.lastOK) < 2*time.Minute
	return presenceSt.enabled, connected, presenceSt.appID, presenceSt.section, presenceSt.note
}

/** Bảo đảm conn sống + đẩy activity; trả về message trung thực */
func presenceEnsure(force bool) string {
	presenceMtx.Lock()
	defer presenceMtx.Unlock()
	if !presenceSt.enabled {
		return "Đang tắt"
	}
	if presenceSt.conn == nil {
		c, err := dialDiscord()
		if err != nil {
			return "Chưa kết nối Discord: " + err.Error()
		}
		dc := &discordConn{c: c}
		if err := dc.handshake(presenceSt.appID); err != nil {
			_ = c.Close()
			return "Bắt tay Discord lỗi: " + err.Error()
		}
		presenceSt.conn = c
	}
	msg := presencePushLocked()
	if msg == "" {
		presenceSt.lastOK = time.Now()
	}
	return msg
}

func (d *discordConn) handshake(appID string) error {
	if err := writeFrame(d.c, 0, map[string]any{"v": 1, "client_id": appID}); err != nil {
		return err
	}
	_, _, err := readFrame(d.c) // reply OP0 — bỏ qua nội dung
	return err
}

func presencePushLocked() string {
	if presenceSt.conn == nil {
		return "chưa kết nối"
	}
	sec := presenceSt.section
	if sec == "" {
		sec = "Tweaks"
	}
	details := "🌸 " + sec
	if presenceSt.note != "" {
		details = "🌸 " + sec + " — " + presenceSt.note
	}
	elapsed := time.Since(presenceSt.start).Round(time.Second)
	act := map[string]any{
		"name":    "Sakura Tool",
		"type":    0,
		"details": trunc(details, 128),
		"state":   trunc(fmt.Sprintf("⏱ đã dùng %d phút", int(elapsed.Minutes())), 128),
		"timestamps": map[string]int64{
			"start": presenceSt.start.Unix(),
		},
		"assets": map[string]string{
			"large_image": "sakura",
			"large_text":  "Sakura Tool",
		},
	}
	frame := map[string]any{
		"cmd":   "SET_ACTIVITY",
		"args":  map[string]any{"pid": os.Getpid(), "activity": act},
		"nonce": nonceHex(),
	}
	if err := writeFrame(presenceSt.conn, 1, frame); err != nil {
		_ = presenceSt.conn.Close()
		presenceSt.conn = nil
		return "Mất kết nối Discord (sẽ thử lại): " + err.Error()
	}
	return ""
}

/** Vòng nền: thử kết nối lại khi Discord mở muộn + giữ presence tươi */
func presenceLoop() {
	for {
		time.Sleep(20 * time.Second)
		presenceMtx.Lock()
		on := presenceSt.enabled
		need := presenceSt.conn == nil
		presenceMtx.Unlock()
		if on && need {
			presenceEnsure(false)
		}
	}
}

// ---------- IPC căn bản ----------

func dialDiscord() (io.ReadWriteCloser, error) {
	if runtime.GOOS == "windows" {
		for i := 0; i < 10; i++ {
			p := fmt.Sprintf(`\\.\pipe\discord-ipc-%d`, i)
			if f, err := os.OpenFile(p, os.O_RDWR, 0); err == nil {
				return f, nil
			}
		}
		return nil, errors.New("không thấy pipe discord-ipc — Discord desktop chưa chạy?")
	}
	base := os.Getenv("XDG_RUNTIME_DIR")
	if base == "" {
		base = "/run/user/" + strconv.Itoa(os.Getuid())
	}
	for i := 0; i < 10; i++ {
		p := filepath.Join(base, fmt.Sprintf("discord-ipc-%d", i))
		if c, err := net.Dial("unix", p); err == nil {
			return c, nil
		}
	}
	return nil, errors.New("không thấy socket discord-ipc — Discord desktop chưa chạy?")
}

func writeFrame(c io.WriteCloser, op int, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	hdr := make([]byte, 8)
	binary.LittleEndian.PutUint32(hdr[0:], uint32(op))
	binary.LittleEndian.PutUint32(hdr[4:], uint32(len(b)))
	_, err = c.Write(append(hdr, b...))
	return err
}

func readFrame(c io.Reader) (int, []byte, error) {
	hdr := make([]byte, 8)
	if _, err := io.ReadFull(c, hdr); err != nil {
		return 0, nil, err
	}
	op := binary.LittleEndian.Uint32(hdr[0:])
	n := binary.LittleEndian.Uint32(hdr[4:])
	if n > 1<<20 {
		return int(op), nil, errors.New("frame quá lớn")
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(c, b); err != nil {
		return int(op), nil, err
	}
	return int(op), b, nil
}

func nonceHex() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func trunc(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
