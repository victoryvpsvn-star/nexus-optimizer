// Sakura Tool — bản Go (single-file exe, không Electron, không server con)
// Kiến trúc: 1 tiến trình duy nhất — HTTP server lắng nghe 127.0.0.1:<cổng ngẫu nhiên trống>,
// UI nhúng trong exe, mở cửa sổ WebView2 (Windows) hoặc trình duyệt mặc định (fallback).
// Không còn cổng cố định 32123 → không còn lỗi kẹt cổng / tiến trình zombie giữ cổng.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

const AppVersion = "4.4.0"

// buildNumber: số run CI ghim qua -ldflags "-X main.buildNumber=..." (0 = build tay)
var buildNumber = "0"

var appState *Store

// apiToken — v3.9.0 (theo audit P1-07): token phiên 128-bit sinh mỗi lần mở app, inject vào
// index.html; mọi route POST/PUT/DELETE /api/* bắt buộc kèm header X-Nexus-Token → chặn
// CSRF/local-web từ tiến trình khác trên máy (server vẫn bind 127.0.0.1).
var apiToken = genAPIToken()

// v4.1.1 (P2-08): System Operation Coordinator — chặn hai thao tác sửa hệ thống chạy
// song song (Registry/Power Plan/Service/GPU đụng nhau). Non-blocking: bận → trả lỗi
// trung thực thay vì xếp hàng âm thầm (UI biết ngay là đang có thao tác khác).
var sysOpMu sync.Mutex
var sysOpName string

func trySysOp(op string) bool {
	if sysOpMu.TryLock() {
		sysOpName = op
		return true
	}
	return false
}

func doneSysOp() {
	sysOpName = ""
	sysOpMu.Unlock()
}

func sysOpBusyErr() string {
	return "Đang có thao tác hệ thống khác chạy (" + sysOpName + ") — đợi xong rồi thử lại, không chạy chồng để tránh ghi đè trạng thái"
}

func genAPIToken() string {
	b := make([]byte, 16)
	// v4.1.0 (13.12): fail-closed — crypto/rand lỗi thì THOÁT thay vì fallback timestamp
	// (token yếu = API mutation mở cửa cho process khác trên máy). Hiếm gặp nhưng
	// nguyên tắc là không mở API không bảo vệ.
	if _, err := rand.Read(b); err != nil {
		log.Fatalf("không tạo được token bảo mật từ crypto/rand (%v) — thoát để tránh mở API không bảo vệ", err)
	}
	return hex.EncodeToString(b)
}

// filePerm/dirPerm — v3.9.0 (theo audit P2-09/21): Unix 0600/0700; Windows bỏ qua permission
func filePerm() os.FileMode {
	if runtime.GOOS == "windows" {
		return 0o666
	}
	return 0o600
}

func dirPerm() os.FileMode {
	if runtime.GOOS == "windows" {
		return 0o777
	}
	return 0o700
}

func main() {
	web := flag.Bool("web", false, "Chạy chế độ web (mở trình duyệt, không mở cửa sổ app)")
	port := flag.Int("port", 0, "Cổng HTTP cụ thể (mặc định: 32199 — bận thì thử +1…+10 rồi mới cổng trống bất kỳ)")
	flag.Parse()

	if p, e := os.Executable(); e == nil {
		// v3.9.0 (theo audit P1-11): không xóa .old ngay lúc start — chỉ xóa sau 2 phút ổn định,
		// để còn đường hồi phục nếu bản mới lỗi ngay lần chạy đầu.
		old := p + ".old"
		time.AfterFunc(2*time.Minute, func() { _ = os.Remove(old) })
	}
	appState = NewStore(dataDir())
	if err := appState.Load(); err != nil {
		log.Printf("[store] đọc config lỗi (file hỏng đã được giữ lại, dùng mặc định): %v", err)
	}
	appState.StartAutosave(3 * time.Second)

	// HTTP server — v3.4.1 fix: mặc định CỔNG CỐ ĐỊNH 32199. Trước đây mỗi lần mở chọn cổng
	// ngẫu nhiên → origin 127.0.0.1:PORT đổi liên tục → localStorage của UI (welcome seen,
	// ngôn ngữ, tinh chỉnh wallpaper) bị "mất" giữa các lần mở tool.
	mux := buildMux()
	var ln net.Listener
	var err error
	if *port > 0 {
		// v4.4.0 (Rescue ISO): NEXUS_BIND=0.0.0.0 chỉ dùng trong môi trường rescue ISO
		// (boot USB, dashboard truy cập từ máy khác qua LAN); mặc định vẫn 127.0.0.1 an toàn
		bindHost := os.Getenv("NEXUS_BIND")
		if bindHost == "" {
			bindHost = "127.0.0.1"
		}
		ln, err = net.Listen("tcp", net.JoinHostPort(bindHost, fmt.Sprint(*port)))
		if err != nil {
			log.Fatalf("Không mở được cổng HTTP %d: %v", *port, err)
		}
	} else {
		ln, err = net.Listen("tcp", "127.0.0.1:32199")
		if err != nil {
			for p := 32200; p <= 32210; p++ {
				ln, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(p)))
				if err == nil {
					break
				}
			}
		}
		if err != nil { // hết cổng dự phòng — giao OS chọn cổng trống bất kỳ
			ln, err = net.Listen("tcp", "127.0.0.1:0")
		}
		if err != nil {
			log.Fatalf("Không mở được cổng HTTP: %v", err)
		}
	}
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", ln.Addr().(*net.TCPAddr).Port)

	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server dừng: %v", err)
		}
	}()
	log.Printf("Sakura Tool %s (%s/%s) — %s — dữ liệu: %s", AppVersion, runtime.GOOS, runtime.GOARCH, baseURL, dataDir())

	// Mở UI: cửa sổ WebView2 trên Windows (không có runtime WebView2 → tự fallback trình duyệt);
	// --web hoặc không phải Windows → mở trình duyệt mặc định.
	if *web || runtime.GOOS != "windows" {
		openBrowser(baseURL)
		fmt.Println("Chế độ web đang chạy — mở", baseURL, "(Ctrl+C để thoát)")
		select {} // giữ tiến trình sống
	}
	if !runWebView(baseURL) {
		log.Printf("WebView2 không khả dụng — mở trình duyệt mặc định")
		openBrowser(baseURL)
		select {}
	}
}

/** Thư mục dữ liệu: %APPDATA%/Sakura Tool (Windows) hoặc NEXUS_DATA_DIR/XDG (khác)
 * v3.9.0: perms 0700 trên Unix (audit P2-21) */
func dataDir() string {
	if v := os.Getenv("NEXUS_DATA_DIR"); v != "" {
		_ = os.MkdirAll(v, dirPerm())
		return v
	}
	if runtime.GOOS == "windows" {
		if ad := os.Getenv("APPDATA"); ad != "" {
			p := filepath.Join(ad, "Sakura Tool")
			_ = os.MkdirAll(p, dirPerm())
			return p
		}
	}
	if x := os.Getenv("XDG_DATA_HOME"); x != "" {
		p := filepath.Join(x, "nexus-optimizer")
		_ = os.MkdirAll(p, dirPerm())
		return p
	}
	home, _ := os.UserHomeDir()
	p := filepath.Join(home, ".local", "share", "nexus-optimizer")
	_ = os.MkdirAll(p, dirPerm())
	return p
}
